/**
 * Room-code multiplayer: a RoomSession joins a signalling room (see Signal.js), opens a direct RTCPeerConnection to every
 * other device (full mesh) and keeps NetworkManager's mesh roster, small ids (0..14) and authority in sync.
 *
 * Rules (all deterministic, no voting):
 * - Peers are identified on the signaller by a random uid (6 hex chars). The peer with the LOWER uid of a pair is the offerer,
 *   so there is never glare or a duplicate connection.
 * - The room creator is the first authority and assigns the small ids (cycling 0..14, so an id is not reused soon) and the
 *   human slots (creator 0, joiners 14, 13, ...). It announces roster versions over the signaller and over the data channels.
 * - A pair whose direct link does not open within linkTimeoutMs stays unlinked; NetworkManager then relays that pair's
 *   traffic through a common neighbour (the authority when possible).
 * - When the authority leaves, every remaining device elects the lowest small id (NetworkManager.electNext) and bumps the epoch.
 * STUN is used only here (never on the manual path): host candidates still work on the same Wi-Fi.
 * @module network/Mesh
 */
import { encodeCode, decodeCode, minifySdp, waitIce, channelTransport } from './NetworkManager.js';
import { defaultSignaller } from './Signal.js';

/** Public STUN server added to iceServers on the room-code path only. */
export const STUN_URL = 'stun:stun.l.google.com:19302';
/** Grid size: humans + AI. */
export const GRID = 15;

const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'; // no I, O, Q
const DIGITS = '23456789'; // no 0, 1

/**
 * Generate a room code: 4 letters + dash + 4 digits, without ambiguous characters (I O Q 0 1), e.g. 'RASH-4821'.
 * @param {()=>number} [rand=Math.random] uniform [0,1)
 * @returns {string}
 */
export function generateRoomCode(rand = Math.random) {
  let a = '';
  let d = '';
  for (let i = 0; i < 4; i++) a += LETTERS[Math.floor(rand() * LETTERS.length)];
  for (let i = 0; i < 4; i++) d += DIGITS[Math.floor(rand() * DIGITS.length)];
  return a + '-' + d;
}

/**
 * Normalise what a person typed ('rash 4821', 'RASH4821', ' rash-4821 ') to 'RASH-4821'.
 * Lenient: any 4 letters + 4 digits are accepted, although generated codes avoid I O Q 0 1.
 * @param {string} s
 * @returns {string|null} the canonical code, or null when it is not a valid room code
 */
export function normalizeRoomCode(s) {
  const t = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]{4})([0-9]{4})$/.exec(t);
  if (!m) return null;
  return m[1] + '-' + m[2];
}

/** @param {string} s @returns {boolean} true when s is a valid room code (after normalisation) */
export function isRoomCode(s) { return normalizeRoomCode(s) !== null; }

/**
 * Random peer uid used on the signaller (24 bits as 6 hex chars).
 * @param {()=>number} [rand=Math.random]
 * @returns {string}
 */
export function makeUid(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

const epochNewer = (a, b) => { const d = (a - b) & 255; return d !== 0 && d < 128; };

/**
 * One device's membership of a room.
 */
export class RoomSession {
  /**
   * @param {object} nm NetworkManager (put into mesh mode by this session)
   * @param {object} [opts]
   * @param {object|Function} [opts.signaller] a Signaller instance or a factory returning one (default: defaultSignaller())
   * @param {boolean} [opts.stun=true] add the public STUN server to iceServers
   * @param {number} [opts.linkTimeoutMs=8000] a pair's direct link counts as failed (relayed) after this long
   * @param {number} [opts.joinTimeoutMs=6000] guest: give up waiting for the host's answer
   * @param {number} [opts.graceMs=1200] wait before treating a closed link as a departure
   * @param {()=>number} [opts.rand] random source
   * @param {string} [opts.uid]
   */
  constructor(nm, opts = {}) {
    this.nm = nm;
    this.opts = opts;
    this.stun = opts.stun !== false;
    this.linkTimeoutMs = opts.linkTimeoutMs ?? 8000;
    this.joinTimeoutMs = opts.joinTimeoutMs ?? 6000;
    this.graceMs = opts.graceMs ?? 1200;
    this.rand = opts.rand || Math.random;
    this.uid = opts.uid || makeUid(this.rand);
    this.signaller = null;
    this.code = null;
    /** 'idle' | 'connecting' | 'ready' | 'closed' */
    this.state = 'idle';
    this.members = new Map(); // uid -> {uid, id, slot}
    this.ver = 0;
    this.next = 0; // id allocation cursor
    this.authorityUid = null;
    this._rEpoch = 0;
    this._peers = new Map(); // uid -> {uid, pc, tr, state, timer, attached}
    this._cbs = [];
    this._join = null;
    this._unAuth = nm.onAuthorityChange ? nm.onAuthorityChange((ev) => this._onAuthority(ev)) : null;
    nm.onMesh((p, from) => this._onMeshMsg(p, from));
    nm.onLinkClose((id) => this._onLinkClose(id));
  }

  /** @returns {string|null} the signalling endpoint that connected (broker URL or 'broadcast') */
  get endpoint() { return this.signaller ? this.signaller.endpoint : null; }
  /** @returns {number|null} own small id */
  get localId() { const m = this.members.get(this.uid); return m ? m.id : null; }
  /** @returns {boolean} true when this device is the room's authority */
  get isAuthority() { return this.authorityUid === this.uid; }

  /**
   * Roster for the UI: every member with how it is reachable from here.
   * @returns {{uid:string, id:number, slot:number, self:boolean, authority:boolean, link:'self'|'direct'|'relayed'|'connecting'|'none'}[]}
   */
  roster() {
    const out = [];
    for (const m of this.members.values()) {
      let link = this.nm.linkState(m.id);
      if (link === 'none') { const p = this._peers.get(m.uid); if (p && p.state === 'connecting') link = 'connecting'; }
      out.push({ uid: m.uid, id: m.id, slot: m.slot, self: m.uid === this.uid, authority: m.uid === this.authorityUid, link });
    }
    return out.sort((a, b) => a.slot - b.slot);
  }

  /** @param {()=>void} cb called whenever members, links or the authority change @returns {()=>void} unsubscribe */
  onChange(cb) {
    this._cbs.push(cb);
    return () => { const i = this._cbs.indexOf(cb); if (i >= 0) this._cbs.splice(i, 1); };
  }

  _emit() { for (const cb of this._cbs.slice()) { try { cb(); } catch { /* ignore */ } } }

  async _open(code) {
    let sig = this.opts.signaller;
    if (typeof sig === 'function') sig = sig();
    else if (!sig) sig = defaultSignaller();
    if (!sig) throw Object.assign(new Error('No signalling transport (WebSocket / BroadcastChannel) is available'), { code: 'RELAY_UNREACHABLE' });
    this.signaller = sig;
    this.code = code;
    this.state = 'connecting';
    sig.onMessage((from, msg) => this._onSignal(from, msg));
    sig.onPeer((id, kind) => (kind === 'join' ? this._peerJoined(id) : this._peerLeft(id)));
    await sig.join(code, this.uid);
  }

  /**
   * Create a room: generate the code and become its authority.
   * @returns {Promise<string>} the room code, e.g. 'RASH-4821'
   * @throws {Error} with code 'RELAY_UNREACHABLE' when no signalling relay can be reached (offer the offline code swap)
   */
  async host() {
    this.nm._needRtc();
    const code = generateRoomCode(this.rand);
    this.nm.enableMesh(0, 0, 0);
    this.members.set(this.uid, { uid: this.uid, id: 0, slot: 0 });
    this.authorityUid = this.uid;
    this.next = 1;
    this.ver = 1;
    this.nm.meshSetMembers([...this.members.values()]);
    try { await this._open(code); } catch (e) { this.state = 'idle'; throw e; }
    this.state = 'ready';
    this._emit();
    return code;
  }

  /**
   * Join a room by its code. Resolves once the host has assigned this device an id.
   * @param {string} codeStr what the user typed
   * @returns {Promise<void>}
   * @throws {Error} 'Not a valid room code', 'No host found for that code', 'Room is full', or RELAY_UNREACHABLE
   */
  async join(codeStr) {
    this.nm._needRtc();
    const code = normalizeRoomCode(codeStr);
    if (!code) throw new Error('Not a valid room code (4 letters + 4 digits, like RASH-4821)');
    const waiting = new Promise((resolve, reject) => {
      this._join = { resolve, reject, timer: setTimeout(() => reject(Object.assign(new Error('No host found for that code'), { code: 'NO_HOST' })), this.joinTimeoutMs) };
    });
    waiting.catch(() => {});
    try { await this._open(code); } catch (e) { this._clearJoin(); this.state = 'idle'; throw e; }
    try { await waiting; } catch (e) { this._clearJoin(); this.close(); throw e; }
    this._clearJoin();
    this.state = 'ready';
    this._emit();
  }

  _clearJoin() { if (this._join) { clearTimeout(this._join.timer); this._join = null; } }

  /** Leave the room: say goodbye, close every peer connection. @returns {void} */
  close() {
    this.state = 'closed';
    this._clearJoin();
    for (const p of this._peers.values()) this._dropPeer(p);
    this._peers.clear();
    if (this.signaller) this.signaller.close();
    if (this._unAuth) this._unAuth();
    this._unAuth = null;
    this._emit();
  }

  // ------------------------------------------------------------ presence and handshake

  _peerJoined(uid) {
    if (this.state === 'closed') return;
    if (this.isAuthority && !this.members.has(uid)) this._admit(uid);
    this._ensurePeer(uid);
  }

  _peerLeft(uid) {
    const p = this._peers.get(uid);
    if (p) { this._dropPeer(p); this._peers.delete(uid); }
    if (this.members.has(uid)) this._removeMember(uid);
    this._emit();
  }

  _ensurePeer(uid) {
    let p = this._peers.get(uid);
    if (p) return p;
    p = { uid, pc: null, tr: null, state: 'connecting', timer: null, attached: false, chans: {} };
    this._peers.set(uid, p);
    p.timer = setTimeout(() => { if (p.state === 'connecting') { p.state = 'failed'; this._emit(); } }, this.linkTimeoutMs);
    if (p.timer && p.timer.unref) p.timer.unref();
    if (this.uid < uid) this._startOffer(p).catch(() => this._failPeer(p));
    return p;
  }

  _failPeer(p) { if (p.state === 'connecting') { p.state = 'failed'; this._emit(); } }

  _dropPeer(p) {
    clearTimeout(p.timer);
    p.state = 'closed';
    if (p.attached) { const m = this.members.get(p.uid); if (m) this.nm.meshDetach(m.id); }
    try { if (p.tr) p.tr.close(); } catch { /* ignore */ }
    try { if (p.pc) p.pc.close(); } catch { /* ignore */ }
    p.pc = null;
  }

  _newPc(p) {
    const pc = this.nm._newPc(this.stun ? [{ urls: STUN_URL }] : []);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if ((st === 'failed' || st === 'closed') && p.tr) { try { p.tr.close(); } catch { /* ignore */ } if (p.attached) this.nm.meshDetach(this.members.get(p.uid)?.id); }
    };
    return pc;
  }

  _hookChannels(p, sc, ec) {
    const check = () => {
      if (p.state === 'open' || p.state === 'closed') return;
      if (sc.readyState === 'open' && ec.readyState === 'open') {
        p.tr = channelTransport(sc, ec);
        p.state = 'open';
        clearTimeout(p.timer);
        this._tryAttach(p);
        this._emit();
      }
    };
    sc.onopen = check;
    ec.onopen = check;
    check();
  }

  async _startOffer(p) {
    const pc = this._newPc(p);
    p.pc = pc;
    const sc = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    const ec = pc.createDataChannel('events');
    this._hookChannels(p, sc, ec);
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc, this.nm.iceTimeoutMs);
    const sdp = pc.localDescription ? pc.localDescription.sdp : '';
    const c = await encodeCode({ v: 2, s: minifySdp(sdp) });
    if (p.state === 'closed') return;
    this.signaller.send(p.uid, { t: 'offer', c });
  }

  async _onOffer(p, msg) {
    if (this.uid < p.uid || p.pc) return; // we are the offerer for this pair, or already answering
    const pc = this._newPc(p);
    p.pc = pc;
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      p.chans[ch.label] = ch;
      if (p.chans.state && p.chans.events) this._hookChannels(p, p.chans.state, p.chans.events);
    };
    const o = await decodeCode(msg.c);
    await pc.setRemoteDescription({ type: 'offer', sdp: o.s });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc, this.nm.iceTimeoutMs);
    const c = await encodeCode({ v: 2, s: minifySdp(pc.localDescription.sdp) });
    if (p.state === 'closed') return;
    this.signaller.send(p.uid, { t: 'answer', c });
  }

  async _onAnswer(p, msg) {
    if (this.uid > p.uid || !p.pc || p.answered) return;
    p.answered = true;
    const a = await decodeCode(msg.c);
    await p.pc.setRemoteDescription({ type: 'answer', sdp: a.s });
  }

  _onSignal(from, msg) {
    if (!msg || this.state === 'closed') return;
    switch (msg.t) {
      case 'offer': { const p = this._ensurePeer(from); this._onOffer(p, msg).catch(() => this._failPeer(p)); break; }
      case 'answer': { const p = this._peers.get(from); if (p) this._onAnswer(p, msg).catch(() => this._failPeer(p)); break; }
      case 'assign': this._onAssign(from, msg); break;
      case 'roster': this._onRoster(msg); break;
      case 'full': if (this._join) this._join.reject(Object.assign(new Error('Room is full'), { code: 'FULL' })); break;
      default: break;
    }
  }

  // ------------------------------------------------------------ roster (authority assigns, everybody applies)

  _allocId() {
    const used = new Set([...this.members.values()].map((m) => m.id));
    for (let k = 0; k < GRID; k++) {
      const id = (this.next + k) % GRID;
      if (!used.has(id)) { this.next = (id + 1) % GRID; return id; }
    }
    return -1;
  }

  _allocSlot() {
    const used = new Set([...this.members.values()].map((m) => m.slot));
    for (let s = GRID - 1; s >= 1; s--) if (!used.has(s)) return s;
    return used.has(0) ? -1 : 0;
  }

  _rosterMsg() {
    return { t: 'roster', ver: this.ver, epoch: this.nm.epoch, authority: this.authorityUid, next: this.next, members: [...this.members.values()].map((m) => ({ uid: m.uid, id: m.id, slot: m.slot })) };
  }

  _publishRoster() {
    const r = this._rosterMsg();
    this._rEpoch = r.epoch;
    if (this.signaller) this.signaller.send(null, r);
    this.nm.meshSend(r);
  }

  _admit(uid) {
    if (this.members.size >= GRID) { this.signaller.send(uid, { t: 'full' }); return; }
    const id = this._allocId();
    const slot = this._allocSlot();
    if (id < 0 || slot < 0) { this.signaller.send(uid, { t: 'full' }); return; }
    this.members.set(uid, { uid, id, slot });
    this.ver++;
    this.nm.meshSetMembers([...this.members.values()]);
    this.signaller.send(uid, { ...this._rosterMsg(), t: 'assign', you: { id, slot } });
    this._publishRoster();
    this._emit();
  }

  _removeMember(uid) {
    const m = this.members.get(uid);
    if (!m) return;
    this.members.delete(uid);
    this.ver++;
    const wasAuth = m.id === this.nm.authorityId;
    this.nm.meshSetMembers([...this.members.values()]);
    if (wasAuth) this.nm.authorityGone(m.id); // elects; _onAuthority publishes the new roster when we are the winner
    else if (this.isAuthority) this._publishRoster();
  }

  _onAssign(from, msg) {
    if (this.members.has(this.uid) && this.localId != null) return;
    const me = msg.you;
    if (!me) return;
    const auth = (msg.members || []).find((m) => m.uid === msg.authority);
    this.nm.enableMesh(me.id, auth ? auth.id : 0, msg.epoch || 0);
    this._applyRoster(msg);
    for (const p of this._peers.values()) this._tryAttach(p);
    if (this._join) this._join.resolve();
  }

  _onRoster(r) {
    if (!r || !Array.isArray(r.members) || this.state === 'closed') return;
    const fresh = epochNewer(r.epoch, this._rEpoch) || (r.epoch === this._rEpoch && r.ver > this.ver);
    if (!fresh) return;
    const me = r.members.find((m) => m.uid === this.uid);
    if (!me) return; // not (yet) in the roster, wait for our assignment
    if (this.localId == null) {
      const auth = r.members.find((m) => m.uid === r.authority);
      this.nm.enableMesh(me.id, auth ? auth.id : 0, r.epoch || 0);
      if (this._join) this._join.resolve();
    }
    this._applyRoster(r);
    for (const p of this._peers.values()) this._tryAttach(p);
  }

  _applyRoster(r) {
    this.members = new Map(r.members.map((m) => [m.uid, { uid: m.uid, id: m.id, slot: m.slot }]));
    this.ver = r.ver;
    this._rEpoch = r.epoch;
    this.next = r.next ?? this.next;
    this.authorityUid = r.authority;
    this.nm.meshSetMembers([...this.members.values()]);
    const a = this.members.get(r.authority);
    if (a && (epochNewer(r.epoch, this.nm.epoch) || (r.epoch === this.nm.epoch && a.id < this.nm.authorityId))) this.nm.setAuthority(a.id, r.epoch, 'roster');
    for (const [uid, p] of this._peers) if (!this.members.has(uid) && p.state === 'closed') this._peers.delete(uid);
    this._emit();
  }

  _onMeshMsg(p, from) {
    if (p && p.t === 'roster') this._onRoster(p);
  }

  _tryAttach(p) {
    if (p.attached || !p.tr || p.state !== 'open') return;
    const m = this.members.get(p.uid);
    if (!m || this.nm.localId == null || !this.nm.mesh) return;
    p.attached = true;
    this.nm.meshAttach(m.id, p.tr);
    this._emit();
  }

  _onLinkClose(id) {
    // a direct link vanished: it is a departure only when nobody else can still reach that member
    const m = [...this.members.values()].find((x) => x.id === id);
    if (!m) return;
    const p = this._peers.get(m.uid);
    if (p) { p.attached = false; p.state = 'closed'; }
    this._emit();
    const t = setTimeout(() => {
      const cur = this.members.get(m.uid);
      if (!cur || this.state === 'closed') return;
      let seen = this.nm._links.has(id);
      for (const set of this.nm._peerLinks.values()) if (set.has(id)) seen = true;
      if (!seen) { const pp = this._peers.get(m.uid); if (pp) { this._dropPeer(pp); this._peers.delete(m.uid); } this._removeMember(m.uid); this._emit(); }
    }, this.graceMs);
    if (t && t.unref) t.unref();
  }

  _onAuthority(ev) {
    const a = [...this.members.values()].find((m) => m.id === ev.authorityId);
    this.authorityUid = a ? a.uid : this.authorityUid;
    if (ev.isAuthority) {
      // we won the election (or were promoted): adopt unassigned peers, publish a roster for the new epoch
      this.ver++;
      for (const p of this._peers.values()) if (!this.members.has(p.uid) && p.state !== 'closed') this._admit(p.uid);
      this._publishRoster();
    }
    this._emit();
  }
}
