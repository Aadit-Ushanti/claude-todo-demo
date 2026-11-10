/**
 * NetworkManager: serverless (manual signalling) WebRTC multiplayer for same-LAN play.
 *
 * Topology: star. Peer id 0 is the host; guests get ids 1..255 from the host.
 * Two data channels per guest: 'state' (unordered, maxRetransmits 0, binary packets)
 * and 'events' (reliable, ordered, JSON strings: events, ping/pong, peer bookkeeping).
 *
 * Pure logic: no DOM. RTCPeerConnection / CompressionStream / btoa are feature-checked.
 * Clock note: opts.now, update(nowMs) and remotePlayers(nowMs) must all use the same clock
 * (e.g. performance.now()). Timestamps travel as u32 milliseconds, so a clock origin must
 * stay below 2^32 ms (49 days), which holds for performance.now().
 * @module network/NetworkManager
 */

/** Size in bytes of one binary state packet. */
export const STATE_PACKET_BYTES = 33;

/**
 * First byte of every non-player ("world") unreliable packet. State packets are exactly
 * STATE_PACKET_BYTES long, so a packet is a state packet iff it has that exact length; world
 * packets must never be exactly that long (WorldSync guarantees it) and start with this tag.
 */
export const WORLD_TAG = 0xa7;

const PI = Math.PI;
const Q_ANGLE = 32767 / PI; // int16 per rad for yaw and lean
const Q_VEL = 50; // int16 per m/s (0.02 m/s steps, +-655 m/s)
const Q_RATE = 1000; // int16 per rad/s (+-32 rad/s)
const MAX_DR_MS = 250;

/** @param {number} a angle in radians @returns {number} the angle wrapped to (-PI, PI] */
function wrapPi(a) {
  a = (a + PI) % (2 * PI);
  if (a <= 0) a += 2 * PI;
  return a - PI;
}
const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Encode a player state into the compact binary wire format (33 bytes).
 * Layout (little endian): seq u16, time u32 ms, pos f32 x3, vel i16 x3 (0.02 m/s),
 * yaw i16, lean i16, yawRate i16, flags u8, health u8, peer id u8.
 * @param {object} s PlayerNetState {x,y,z,vx,vy,vz,yaw,yawRate,lean,flags,health}
 * @param {number} seq sequence number (wrapped to u16)
 * @param {number} tMs sender clock in milliseconds (wrapped to u32)
 * @param {number} [peerId=0] originating peer id
 * @returns {ArrayBuffer}
 */
export function encodeState(s, seq, tMs, peerId = 0) {
  const buf = new ArrayBuffer(STATE_PACKET_BYTES);
  const dv = new DataView(buf);
  dv.setUint16(0, seq & 0xffff, true);
  dv.setUint32(2, Math.round(tMs) >>> 0, true);
  dv.setFloat32(6, s.x || 0, true);
  dv.setFloat32(10, s.y || 0, true);
  dv.setFloat32(14, s.z || 0, true);
  dv.setInt16(18, clamp16(Math.round((s.vx || 0) * Q_VEL)), true);
  dv.setInt16(20, clamp16(Math.round((s.vy || 0) * Q_VEL)), true);
  dv.setInt16(22, clamp16(Math.round((s.vz || 0) * Q_VEL)), true);
  dv.setInt16(24, clamp16(Math.round(wrapPi(s.yaw || 0) * Q_ANGLE)), true);
  dv.setInt16(26, clamp16(Math.round(wrapPi(s.lean || 0) * Q_ANGLE)), true);
  dv.setInt16(28, clamp16(Math.round((s.yawRate || 0) * Q_RATE)), true);
  dv.setUint8(30, (s.flags || 0) & 0xff);
  dv.setUint8(31, Math.max(0, Math.min(255, Math.round(s.health ?? 100))));
  dv.setUint8(32, peerId & 0xff);
  return buf;
}

/**
 * Decode a binary state packet produced by {@link encodeState}.
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {{seq:number, t:number, peer:number, state:object}} state has x,y,z,vx,vy,vz,yaw,yawRate,lean,flags,health
 */
export function decodeState(buf) {
  let ab = buf;
  if (ArrayBuffer.isView(buf)) ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (ab.byteLength < STATE_PACKET_BYTES) throw new RangeError('state packet too short');
  const dv = new DataView(ab);
  return {
    seq: dv.getUint16(0, true),
    t: dv.getUint32(2, true),
    peer: dv.getUint8(32),
    state: {
      x: dv.getFloat32(6, true),
      y: dv.getFloat32(10, true),
      z: dv.getFloat32(14, true),
      vx: dv.getInt16(18, true) / Q_VEL,
      vy: dv.getInt16(20, true) / Q_VEL,
      vz: dv.getInt16(22, true) / Q_VEL,
      yaw: dv.getInt16(24, true) / Q_ANGLE,
      lean: dv.getInt16(26, true) / Q_ANGLE,
      yawRate: dv.getInt16(28, true) / Q_RATE,
      flags: dv.getUint8(30),
      health: dv.getUint8(31),
    },
  };
}

/**
 * True when sequence number `a` is newer than `b` (u16 wraparound aware).
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function seqNewer(a, b) {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/**
 * Time-ordered buffer of remote snapshots with interpolation and dead reckoning.
 * Snapshot shape: {t (ms, remote clock), x,y,z, vx,vy,vz, yaw, yawRate, lean, flags, health}.
 */
export class SnapshotBuffer {
  /** @param {number} [capacity=48] max snapshots kept */
  constructor(capacity = 48) {
    this.capacity = capacity;
    /** @type {object[]} */
    this.snaps = [];
  }

  /**
   * Insert a snapshot keeping time order; duplicates (same t) are ignored.
   * @param {object} snap
   * @returns {void}
   */
  push(snap) {
    const a = this.snaps;
    let i = a.length;
    while (i > 0 && a[i - 1].t > snap.t) i--;
    if (i > 0 && a[i - 1].t === snap.t) return;
    a.splice(i, 0, snap);
    if (a.length > this.capacity) a.shift();
  }

  /** @returns {number} number of snapshots held */
  get length() {
    return this.snaps.length;
  }

  /** @returns {object|null} newest snapshot */
  get last() {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /**
   * Sample the state at remote time `tRender` (ms). Interpolates between the two
   * surrounding snapshots (linear position, shortest-arc yaw, lerp lean); past the newest
   * snapshot it dead-reckons (pos += vel*dt along the yaw-rate arc, yaw += yawRate*dt)
   * for at most 250 ms and then holds.
   * @param {number} tRender remote-clock time in ms
   * @param {object} [out] object to fill (avoids allocation)
   * @returns {object|null} state with extrapolated:boolean and age (ms beyond newest snapshot), or null if empty
   */
  sample(tRender, out = {}) {
    const a = this.snaps;
    const n = a.length;
    if (!n) return null;
    if (tRender <= a[0].t) return copySnap(a[0], out, false, 0);
    const lastS = a[n - 1];
    if (tRender >= lastS.t) {
      const age = tRender - lastS.t;
      if (age === 0) return copySnap(lastS, out, false, 0);
      return deadReckon(lastS, Math.min(age, MAX_DR_MS) / 1000, out, age);
    }
    let i = n - 1;
    while (i > 0 && a[i - 1].t > tRender) i--;
    const p = a[i - 1];
    const q = a[i];
    const f = (tRender - p.t) / (q.t - p.t);
    out.x = p.x + (q.x - p.x) * f;
    out.y = p.y + (q.y - p.y) * f;
    out.z = p.z + (q.z - p.z) * f;
    out.vx = p.vx + (q.vx - p.vx) * f;
    out.vy = p.vy + (q.vy - p.vy) * f;
    out.vz = p.vz + (q.vz - p.vz) * f;
    out.yaw = p.yaw + wrapPi(q.yaw - p.yaw) * f;
    out.yawRate = p.yawRate + (q.yawRate - p.yawRate) * f;
    out.lean = p.lean + (q.lean - p.lean) * f;
    const near = f < 0.5 ? p : q;
    out.flags = near.flags;
    out.health = near.health;
    out.extrapolated = false;
    out.age = 0;
    return out;
  }
}

function copySnap(s, out, extrapolated, age) {
  out.x = s.x; out.y = s.y; out.z = s.z;
  out.vx = s.vx; out.vy = s.vy; out.vz = s.vz;
  out.yaw = s.yaw; out.yawRate = s.yawRate; out.lean = s.lean;
  out.flags = s.flags; out.health = s.health;
  out.extrapolated = extrapolated;
  out.age = age;
  return out;
}

function deadReckon(s, dt, out, age) {
  const th = s.yawRate * dt;
  let k = 1;
  let half = 0;
  if (Math.abs(th) > 1e-4) {
    half = th / 2;
    k = Math.sin(half) / half; // chord length factor for the arc
  }
  const c = Math.cos(half);
  const sn = Math.sin(half);
  out.x = s.x + (s.vx * c + s.vz * sn) * dt * k;
  out.y = s.y + s.vy * dt;
  out.z = s.z + (-s.vx * sn + s.vz * c) * dt * k;
  const c2 = Math.cos(th);
  const s2 = Math.sin(th);
  out.vx = s.vx * c2 + s.vz * s2;
  out.vy = s.vy;
  out.vz = -s.vx * s2 + s.vz * c2;
  out.yaw = s.yaw + th;
  out.yawRate = s.yawRate;
  out.lean = s.lean;
  out.flags = s.flags;
  out.health = s.health;
  out.extrapolated = true;
  out.age = age;
  return out;
}

/** Default look-ahead cap of the predict-to-now display mode, ms. */
export const MAX_PREDICT_MS = 280;
const MAX_ACCEL = 15; // m/s^2 clamp on the finite-difference speed change
const MAX_LEAN_RATE = 4; // rad/s clamp on the lean trend

/**
 * Sample a snapshot buffer at sender time `T` (ms) in "predict" style: inside the buffer it interpolates; past the
 * newest snapshot it extrapolates by dead reckoning (position along the yaw-rate arc using the velocity plus a
 * finite-difference speed acceleration from an earlier snapshot, clamped; yaw += yawRate*dt; lean eased toward its
 * trend) for at most `maxMs`, after which it holds. Speed never reverses through zero (a braking bike stops, it does not
 * reverse). No allocation when `out` is passed.
 * @param {SnapshotBuffer} buf
 * @param {number} T sender-clock time to show, ms
 * @param {object} [out]
 * @param {number} [maxMs=MAX_PREDICT_MS] look-ahead cap
 * @returns {object|null} state {x,y,z,vx,vy,vz,yaw,yawRate,lean,flags,health,extrapolated,age} or null when the buffer is empty
 */
export function predictSample(buf, T, out = {}, maxMs = MAX_PREDICT_MS) {
  const a = buf.snaps;
  const n = a.length;
  if (!n) return null;
  const last = a[n - 1];
  if (T <= last.t) return buf.sample(T, out);
  const age = T - last.t;
  const dt = Math.min(age, maxMs) / 1000;
  let prev = null;
  for (let i = n - 2; i >= 0 && i >= n - 6; i--) {
    const span = last.t - a[i].t;
    if (span > 400) break;
    if (span >= 45) { prev = a[i]; break; }
  }
  const s0 = Math.hypot(last.vx, last.vz);
  let aS = 0;
  let leanRate = 0;
  if (prev) {
    const sp = (last.t - prev.t) / 1000;
    aS = (s0 - Math.hypot(prev.vx, prev.vz)) / sp;
    aS = aS > MAX_ACCEL ? MAX_ACCEL : aS < -MAX_ACCEL ? -MAX_ACCEL : aS;
    leanRate = (last.lean - prev.lean) / sp;
    leanRate = leanRate > MAX_LEAN_RATE ? MAX_LEAN_RATE : leanRate < -MAX_LEAN_RATE ? -MAX_LEAN_RATE : leanRate;
  }
  const w = last.yawRate;
  let x = last.x;
  let z = last.z;
  let vx = last.vx;
  let vz = last.vz;
  if (s0 > 0.01 && dt > 0) {
    const dx = last.vx / s0;
    const dz = last.vz / s0;
    const steps = 4;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const tau = (i + 0.5) * h;
      const sp = Math.max(0, s0 + aS * tau);
      const th = w * tau;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      x += (dx * c + dz * sn) * sp * h;
      z += (-dx * sn + dz * c) * sp * h;
    }
    const sE = Math.max(0, s0 + aS * dt);
    const c = Math.cos(w * dt);
    const sn = Math.sin(w * dt);
    vx = (dx * c + dz * sn) * sE;
    vz = (-dx * sn + dz * c) * sE;
  }
  out.x = x;
  out.y = last.y + last.vy * dt;
  out.z = z;
  out.vx = vx; out.vy = last.vy; out.vz = vz;
  out.yaw = last.yaw + w * dt;
  out.yawRate = w;
  out.lean = last.lean + leanRate * 0.15 * (1 - Math.exp(-dt / 0.15));
  out.flags = last.flags;
  out.health = last.health;
  out.extrapolated = true;
  out.age = age;
  return out;
}

// ---------------------------------------------------------------- signalling codes

const KEEP_SDP = ['v=', 'o=', 's=', 't=', 'm=', 'c=', 'a=ice-ufrag', 'a=ice-pwd', 'a=fingerprint',
  'a=setup', 'a=mid', 'a=sctp-port', 'a=sctpmap', 'a=max-message-size', 'a=candidate', 'a=group'];

/**
 * Strip an SDP down to the lines a data-channel-only connection needs.
 * @param {string} sdp
 * @returns {string}
 */
export function minifySdp(sdp) {
  return sdp.split(/\r?\n/).filter((l) => l && KEEP_SDP.some((p) => l.startsWith(p))).join('\r\n') + '\r\n';
}

function toB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const b = typeof btoa === 'function' ? btoa(s) : globalThis.Buffer.from(s, 'binary').toString('base64');
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(str) {
  let b = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const s = typeof atob === 'function' ? atob(b) : globalThis.Buffer.from(b, 'base64').toString('binary');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function pump(stream, bytes) {
  const w = stream.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const r = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Pack a signalling object into a compact copy-paste/QR-friendly code:
 * 'z' + base64url(deflate-raw(JSON)) when CompressionStream exists, else 'p' + base64url(JSON).
 * @param {object} obj
 * @returns {Promise<string>}
 */
export async function encodeCode(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') {
    try { return 'z' + toB64Url(await pump(new CompressionStream('deflate-raw'), raw)); } catch { /* fall through */ }
  }
  return 'p' + toB64Url(raw);
}

/**
 * Inverse of {@link encodeCode}.
 * @param {string} code
 * @returns {Promise<object>}
 */
export async function decodeCode(code) {
  code = String(code).trim();
  const kind = code[0];
  const bytes = fromB64Url(code.slice(1));
  let raw;
  if (kind === 'z') {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot inflate the code (no DecompressionStream)');
    raw = await pump(new DecompressionStream('deflate-raw'), bytes);
  } else if (kind === 'p') raw = bytes;
  else throw new Error('unrecognised code');
  return JSON.parse(new TextDecoder().decode(raw));
}

/**
 * Resolve when ICE gathering completes (or after timeoutMs). Used by the manual and the room-code paths.
 * @param {RTCPeerConnection} pc
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function waitIce(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let t = null;
    const fin = () => { if (t !== null) clearTimeout(t); t = null; resolve(); };
    t = setTimeout(fin, timeoutMs);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') fin(); };
    pc.onicecandidate = (e) => { if (!e.candidate) fin(); };
  });
}

/**
 * Wrap two RTCDataChannels ('state' unreliable, 'events' reliable) as a transport; buffers inbound messages until a listener exists.
 * @param {object} sc state channel
 * @param {object} ec events channel
 * @returns {{sendUnreliable:Function, sendReliable:Function, onMessage:Function, onClose:Function, close:Function}}
 */
export function channelTransport(sc, ec) {
  const tr = {
    cb: null,
    q: [],
    closeCb: null,
    sendUnreliable(buf) { if (sc.readyState === 'open') sc.send(buf); },
    sendReliable(str) { if (ec.readyState === 'open') ec.send(str); },
    onMessage(cb) { tr.cb = cb; const q = tr.q; tr.q = []; for (const d of q) cb(d); },
    onClose(cb) { tr.closeCb = cb; },
    close() { try { sc.close(); ec.close(); } catch { /* ignore */ } },
  };
  const on = (e) => { if (tr.cb) tr.cb(e.data); else tr.q.push(e.data); };
  sc.binaryType = 'arraybuffer';
  sc.onmessage = on;
  ec.onmessage = on;
  const closed = () => { if (tr.closeCb) tr.closeCb(); };
  sc.onclose = closed;
  ec.onclose = closed;
  return tr;
}

// ---------------------------------------------------------------- manager

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/**
 * Multiplayer session manager (host or guest).
 */
export class NetworkManager {
  /**
   * @param {object} [opts]
   * @param {object|Function} [opts.rtc] {RTCPeerConnection} (or the class itself); default globalThis
   * @param {()=>number} [opts.now] clock in ms (default performance.now)
   * @param {number} [opts.tickHz=30] state send rate
   * @param {number} [opts.interpDelayMs=100] interpolation delay behind the freshest data
   * @param {number} [opts.iceTimeoutMs=3000] max wait for ICE gathering
   * @param {boolean} [opts.minify=true] minify SDP before packing it into a code
   * @param {(peerId:number, joined:boolean)=>void} [opts.onPeer]
   * @param {(type:string, payload:any, from:number)=>void} [opts.onEvent]
   * @param {(status:string, info?:any)=>void} [opts.onStatus] status: idle|hosting|connecting|connected|disconnected|closed|error
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.tickHz = opts.tickHz ?? 30;
    this.interpDelayMs = opts.interpDelayMs ?? 100;
    this.iceTimeoutMs = opts.iceTimeoutMs ?? 3000;
    this._now = opts.now || defaultNow;
    this._rtc = opts.rtc ? (opts.rtc.RTCPeerConnection || opts.rtc) : globalThis.RTCPeerConnection;
    this.onPeer = opts.onPeer || null;
    this.onEvent = opts.onEvent || null;
    this.onStatus = opts.onStatus || null;
    this._status = 'idle';
    this._isHost = false;
    this._localId = null;
    this._links = new Map(); // peerId -> link
    this._pending = new Map(); // host: slot -> {pc, id, tr, open}
    this._guestPc = null;
    this._nextSlot = 1;
    this._known = new Set();
    this._remote = new Map(); // origin peerId -> remote entry
    this._out = new Map();
    this._local = null;
    this._seq = 0;
    this._nextSend = null;
    this.errorTauMs = 120;
    /** Display mode: 'predict' (default; dead-reckon the newest data forward to the present) or 'interp' (delayed interpolation). */
    this.mode = opts.mode === 'interp' ? 'interp' : 'predict';
    this.maxPredictMs = opts.maxPredictMs ?? MAX_PREDICT_MS;
    this._unreliableCbs = [];
    // --- mesh mode (room-code path); everything below is inert in the manual star topology ---
    this._mesh = false;
    this._authId = 0;
    this._epoch = 0;
    this._members = new Map(); // small id -> {id, slot, uid}
    this._peerLinks = new Map(); // small id -> Set of small ids it reports a direct link to
    this._authCbs = [];
    this._meshCb = null;
    this._evN = 0;
    this._seenEv = new Map(); // origin -> {set, order}
    this._dead = new Set(); // small ids declared gone (cleared when the id is reassigned)
    /** Hook set by WorldSync: () => ({seq, raceT, phase}) used when this device becomes the authority. */
    this.authorityInfo = null;
  }

  // ------------------------------------------------------------ mesh / authority API

  /** @returns {boolean} true when running in mesh mode (room-code path) */
  get mesh() { return this._mesh; }
  /** @returns {number} authority epoch (u8, 0 until the first migration; always 0 in the star topology) */
  get epoch() { return this._epoch; }
  /** @returns {number} small id of the device that runs AI + traffic + race clock (0 = the host in the star topology) */
  get authorityId() { return this._mesh ? this._authId : 0; }
  /** @returns {boolean} true when this device runs the AI/world (the host in the star topology) */
  get isAuthority() { return this._mesh ? this._localId === this._authId : this._isHost; }
  /** @returns {{peerId:number, slot:number}[]} mesh roster of humans (self included), sorted by slot; empty in the star topology */
  humans() {
    return [...this._members.values()].map((m) => ({ peerId: m.id, slot: m.slot })).sort((a, b) => a.slot - b.slot);
  }

  /**
   * Switch to mesh mode with an id assigned by the room authority.
   * @param {number} localId own small id (0..14)
   * @param {number} authorityId small id of the current authority
   * @param {number} [epoch=0] authority epoch
   * @returns {void}
   */
  enableMesh(localId, authorityId, epoch = 0) {
    this._mesh = true;
    this._localId = localId;
    this._authId = authorityId;
    this._epoch = epoch & 255;
    this._isHost = localId === authorityId;
    if (this._status === 'idle') this._setStatus(this._isHost ? 'hosting' : 'connecting');
  }

  /**
   * Replace the mesh roster (self included). Fires onPeer for ids that appeared or vanished and drops links of vanished ids.
   * @param {{id:number, slot:number, uid?:string}[]} list
   * @returns {void}
   */
  meshSetMembers(list) {
    const next = new Map();
    for (const m of list) next.set(m.id, { id: m.id, slot: m.slot, uid: m.uid });
    for (const [id, m] of next) {
      const old = this._members.get(id);
      if (old && old.uid !== m.uid) { this._dead.delete(id); if (id !== this._localId) this._removePeerQuiet(id); }
    }
    const prev = this._members;
    this._members = next;
    for (const id of prev.keys()) {
      if (next.has(id) || id === this._localId) continue;
      this._removePeerQuiet(id, true);
    }
    for (const id of next.keys()) if (id !== this._localId) this._addPeer(id);
  }

  _removePeerQuiet(id, notify = true) {
    const l = this._links.get(id);
    if (l) { this._links.delete(id); try { l.tr.close && l.tr.close(); } catch { /* ignore */ } }
    this._peerLinks.delete(id);
    this._seenEv.delete(id);
    if (notify) this._removePeer(id);
    else { this._remote.delete(id); this._known.delete(id); }
    this._announceLinks();
  }

  /**
   * Register an open direct link to a mesh peer (no welcome handshake; ids come from the room roster).
   * @param {number} peerId small id of the remote end
   * @param {object} tr transport {sendUnreliable, sendReliable, onMessage, onClose?, close?}
   * @returns {void}
   */
  meshAttach(peerId, tr) {
    const old = this._links.get(peerId);
    if (old && old.tr !== tr) { try { old.tr.close && old.tr.close(); } catch { /* ignore */ } }
    const link = { id: peerId, tr, rtt: null, clockOffset: null, samples: [], lastPing: -Infinity, pongs: 0 };
    this._links.set(peerId, link);
    tr.onMessage((data) => this._onData(link, data));
    if (tr.onClose) tr.onClose(() => { if (this._links.get(peerId) === link) this.meshDetach(peerId); });
    this._addPeer(peerId);
    this._announceLinks();
    if (this._status !== 'connected') this._setStatus('connected', { peerId });
  }

  /**
   * Drop the direct link to a peer (the peer stays in the roster; traffic is relayed when a neighbour reaches both).
   * @param {number} peerId
   * @returns {void}
   */
  meshDetach(peerId) {
    const l = this._links.get(peerId);
    if (!l) return;
    this._links.delete(peerId);
    try { l.tr.close && l.tr.close(); } catch { /* ignore */ }
    this._announceLinks();
    if (this._linkCloseCb) this._linkCloseCb(peerId);
  }

  /**
   * Leave mesh mode and drop every link/member (used when the lobby goes back or switches to the offline code swap).
   * @returns {void}
   */
  leaveMesh() {
    for (const l of this._links.values()) { try { l.tr.close && l.tr.close(); } catch { /* ignore */ } }
    this._links.clear(); this._known.clear(); this._remote.clear(); this._members.clear(); this._peerLinks.clear(); this._seenEv.clear(); this._dead.clear();
    this._mesh = false; this._isHost = false; this._localId = null; this._authId = 0; this._epoch = 0;
    this._status = 'idle';
  }

  /** Subscribe to link-close notifications (Room). @param {(peerId:number)=>void} cb @returns {void} */
  onLinkClose(cb) { this._linkCloseCb = cb; }

  /** Subscribe to mesh control messages that NetworkManager does not handle itself (roster). @param {(p:any, fromId:number)=>void} cb @returns {void} */
  onMesh(cb) { this._meshCb = cb; }

  /**
   * Send a mesh control message on every reliable link (never reaches onEvent).
   * @param {object} p JSON-safe
   * @returns {void}
   */
  meshSend(p) {
    const msg = JSON.stringify({ k: 'M', p });
    for (const l of this._links.values()) l.tr.sendReliable(msg);
  }

  _announceLinks() {
    if (!this._mesh || !this._links.size) return;
    this.meshSend({ t: 'x', l: [...this._links.keys()] });
  }

  _linked(a, b) {
    if (a === this._localId) return this._links.has(b);
    if (b === this._localId) return this._links.has(a);
    const s = this._peerLinks.get(a);
    return !!(s && s.has(b));
  }

  _knowsLinks(a) { return a === this._localId || this._peerLinks.has(a); }

  /** True when x and y have no direct link although both report their links (traffic must be relayed). */
  _needsRelay(x, y) {
    if (!this._knowsLinks(x) || !this._knowsLinks(y)) return false;
    return !this._linked(x, y) && !this._linked(y, x);
  }

  /** Deterministic relay for the pair: the authority if it reaches both, else the lowest id that does; null if none. */
  _relayFor(x, y) {
    let best = null;
    for (const z of this._members.keys()) {
      if (z === x || z === y) continue;
      if (!this._knowsLinks(z)) continue;
      if (!(this._linked(z, x) || this._linked(x, z)) || !(this._linked(z, y) || this._linked(y, z))) continue;
      if (z === this._authId) return z;
      if (best === null || z < best) best = z;
    }
    return best;
  }

  /**
   * How a peer is currently reachable from here.
   * @param {number} id small id
   * @returns {'self'|'direct'|'relayed'|'none'}
   */
  linkState(id) {
    if (id === this._localId) return 'self';
    if (this._links.has(id)) return 'direct';
    if (this._mesh && this._members.has(id) && this._relayFor(this._localId, id) !== null) return 'relayed';
    return 'none';
  }

  _forward(origin, link, send) {
    if (!this._mesh || link.id !== origin) return;
    for (const y of this._links.keys()) {
      if (y === origin) continue;
      if (this._needsRelay(origin, y) && this._relayFor(origin, y) === this._localId) send(this._links.get(y));
    }
  }

  /**
   * Subscribe to authority changes (migration or adoption of a newer epoch).
   * @param {(info:{authorityId:number, isAuthority:boolean, previous:number, epoch:number, reason:string, seq:number|null, raceT:number|null, phase:string|null})=>void} cb
   * @returns {()=>void} unsubscribe
   */
  onAuthorityChange(cb) {
    this._authCbs.push(cb);
    return () => { const i = this._authCbs.indexOf(cb); if (i >= 0) this._authCbs.splice(i, 1); };
  }

  /**
   * Make `id` the authority at `epoch` (no-op when nothing changes). When this device becomes the authority it announces
   * itself with a reliable mesh message carrying the last world seq / race time known to WorldSync.
   * @param {number} id
   * @param {number} epoch
   * @param {string} [reason]
   * @param {{seq?:number, raceT?:number, phase?:string}} [info]
   * @returns {boolean} true when the authority changed
   */
  setAuthority(id, epoch, reason = 'remote', info = null) {
    epoch &= 255;
    if (id === this._authId && epoch === this._epoch) return false;
    const previous = this._authId;
    const was = this.isAuthority;
    this._authId = id;
    this._epoch = epoch;
    this._isHost = id === this._localId;
    const now = this.isAuthority;
    if (now && !was && !info && this.authorityInfo) info = this.authorityInfo();
    if (now && !was) this.meshSend({ t: 'auth', id, epoch, seq: info ? info.seq : null, raceT: info ? info.raceT : null, phase: info ? info.phase : null });
    const ev = { authorityId: id, isAuthority: now, previous, epoch, reason, seq: info && info.seq != null ? info.seq : null, raceT: info && info.raceT != null ? info.raceT : null, phase: info && info.phase ? info.phase : null };
    for (const cb of this._authCbs.slice()) cb(ev);
    return true;
  }

  /**
   * The authority is gone (left, or silent for too long): elect the lowest small id among the survivors, deterministically.
   * Every device computes the same answer from the same roster; the epoch is bumped so packets of the old authority are dropped.
   * @param {string} [reason]
   * @returns {number} id of the new authority
   */
  electNext(reason = 'lost') {
    if (!this._mesh) return this._authId;
    this._dead.add(this._authId);
    let best = null;
    const consider = (id) => { if (!this._dead.has(id) && (best === null || id < best)) best = id; };
    consider(this._localId);
    for (const id of this._members.keys()) consider(id);
    if (best === null) best = this._localId;
    this.setAuthority(best, this._epoch + 1, reason);
    return best;
  }

  /**
   * Called when the roster lost member `id`; elects a new authority if it was the authority.
   * @param {number} id
   * @returns {boolean} true when an election happened
   */
  authorityGone(id) {
    if (!this._mesh || id !== this._authId || id === this._localId) return false;
    this.electNext('left');
    return true;
  }

  /**
   * WorldSync saw no world packets for the timeout while other peers are still connected.
   * @returns {boolean} true when an election happened
   */
  suspectAuthority() {
    if (!this._mesh || this.isAuthority) return false;
    this.electNext('timeout');
    return true;
  }

  /** @returns {string} current status */
  get status() { return this._status; }
  /** @returns {boolean} true when this manager acts as the host */
  get isHost() { return this._isHost; }
  /** @returns {number|null} own peer id (0 for host, null until a guest has been welcomed) */
  get localId() { return this._localId; }
  /** @returns {number[]} ids of the other peers currently known/connected */
  get peers() { return [...this._known]; }
  /** @returns {number} smoothed round-trip time in ms (to the host for guests, mean over guests for the host); 0 if unknown */
  get rttMs() {
    let sum = 0, n = 0;
    for (const l of this._links.values()) if (l.rtt != null) { sum += l.rtt; n++; }
    return n ? sum / n : 0;
  }
  /**
   * Estimated clock offset (remote minus local, ms) to a directly linked peer, from ping/pong.
   * @param {number} peerId
   * @returns {number|null}
   */
  clockOffsetMs(peerId) {
    const l = this._links.get(peerId);
    return l && l.clockOffset != null ? l.clockOffset : null;
  }

  /**
   * Remote-minus-local clock offset (ms) for the clock a snapshot is stamped in, when it is known from ping/pong.
   * Star: snapshots are stamped in the sender's clock for direct links and in the host's clock when relayed by the host.
   * Mesh: only direct snapshots have a known offset.
   * @param {number} origin sender id
   * @param {number} via id of the link the packet arrived on
   * @returns {number|null}
   */
  senderOffsetMs(origin, via) {
    if (this._mesh && via !== origin) return null;
    return this.clockOffsetMs(via);
  }

  /**
   * One-way latency guess (ms) for a link: half the smoothed rtt, 50 ms before the first pong.
   * @param {number} via link id
   * @returns {number}
   */
  oneWayMs(via) {
    const l = this._links.get(via);
    return l && l.rtt != null ? l.rtt / 2 : 50;
  }

  _setStatus(s, info) {
    this._status = s;
    if (this.onStatus) this.onStatus(s, info);
  }

  _needRtc() {
    if (typeof this._rtc !== 'function') throw new Error('WebRTC (RTCPeerConnection) is not available in this environment');
  }

  _newPc(iceServers = []) {
    this._needRtc();
    return new this._rtc({ iceServers });
  }

  _watchPc(pc, id) {
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this._detach(id);
    };
  }

  async _packSdp(pc, extra) {
    await waitIce(pc, this.iceTimeoutMs);
    const sdp = pc.localDescription ? pc.localDescription.sdp : '';
    return encodeCode({ v: 1, ...extra, s: this.opts.minify === false ? sdp : minifySdp(sdp) });
  }

  /**
   * Host side step 1: create a peer connection for the next guest and return an offer code.
   * Call again for each additional guest.
   * @returns {Promise<string>} offer code to hand to the guest (text or QR)
   */
  async host() {
    this._isHost = true;
    this._localId = 0;
    const id = this._nextSlot++;
    const pc = this._newPc();
    const sc = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    const ec = pc.createDataChannel('events');
    const tr = channelTransport(sc, ec);
    const entry = { id, pc, tr, open: { state: sc.readyState === 'open', events: ec.readyState === 'open' } };
    const check = () => { if (entry.open.state && entry.open.events && this._pending.get(id) === entry) { this._pending.delete(id); this._watchPc(pc, id); attachTransport(this, id, tr); } };
    sc.onopen = () => { entry.open.state = true; check(); };
    ec.onopen = () => { entry.open.events = true; check(); };
    this._pending.set(id, entry);
    if (this._status === 'idle') this._setStatus('hosting', { slot: id });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      return await this._packSdp(pc, { t: 'o', id });
    } catch (e) {
      this._pending.delete(id);
      this._setStatus('error', e);
      throw e;
    }
  }

  /**
   * Guest side: consume an offer code, return the answer code to send back to the host.
   * @param {string} offerCode
   * @returns {Promise<string>} answer code
   */
  async join(offerCode) {
    this._needRtc();
    const offer = await decodeCode(offerCode);
    if (offer.t !== 'o') throw new Error('not an offer code');
    this._isHost = false;
    const pc = this._newPc();
    this._guestPc = pc;
    const chans = {};
    const tryAttach = () => {
      const sc = chans.state, ec = chans.events;
      if (sc && ec && sc.readyState === 'open' && ec.readyState === 'open' && !chans.done) {
        chans.done = true;
        this._watchPc(pc, 0);
        attachTransport(this, 0, chans.tr);
      }
    };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      chans[ch.label] = ch;
      if (chans.state && chans.events && !chans.tr) chans.tr = channelTransport(chans.state, chans.events);
      for (const c of [chans.state, chans.events]) if (c) c.onopen = tryAttach;
      tryAttach();
    };
    this._setStatus('connecting');
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.s });
      await pc.setLocalDescription(await pc.createAnswer());
      return await this._packSdp(pc, { t: 'a', id: offer.id });
    } catch (e) {
      this._setStatus('error', e);
      throw e;
    }
  }

  /**
   * Host side step 2: apply the guest's answer code; the link opens by itself afterwards.
   * @param {string} answerCode
   * @param {number} [peerSlot] guest slot (defaults to the slot stored in the code)
   * @returns {Promise<void>}
   */
  async acceptAnswer(answerCode, peerSlot) {
    const ans = await decodeCode(answerCode);
    if (ans.t !== 'a') throw new Error('not an answer code');
    const slot = peerSlot ?? ans.id;
    const entry = this._pending.get(slot);
    if (!entry) throw new Error('no pending guest in slot ' + slot);
    this._setStatus('connecting', { slot });
    await entry.pc.setRemoteDescription({ type: 'answer', sdp: ans.s });
  }

  /**
   * Set the local player's state, sent on the next tick.
   * @param {object} s PlayerNetState {x,y,z,vx,vy,vz,yaw,yawRate,lean,flags,health}
   * @returns {void}
   */
  setLocalState(s) {
    if (!this._local) this._local = {};
    Object.assign(this._local, s);
  }

  /**
   * Frame update: send state at tickHz, ping peers.
   * @param {number} nowMs
   * @returns {void}
   */
  update(nowMs) {
    for (const l of this._links.values()) {
      const every = l.pongs < 6 ? 400 : 2000;
      if (nowMs - l.lastPing >= every) {
        l.lastPing = nowMs;
        l.tr.sendReliable(JSON.stringify({ k: 'p', t: nowMs }));
      }
    }
    if (!this._local || this._localId == null || !this._links.size) return;
    const interval = 1000 / this.tickHz;
    if (this._nextSend == null) this._nextSend = nowMs;
    if (nowMs < this._nextSend) return;
    this._nextSend += interval;
    if (this._nextSend < nowMs) this._nextSend = nowMs + interval;
    const buf = encodeState(this._local, this._seq++, nowMs, this._localId);
    for (const l of this._links.values()) l.tr.sendUnreliable(buf);
  }

  /**
   * Send a reliable, ordered game event ('hit', 'crash', 'start', 'chat', ...). The payload must be JSON-safe.
   * The host relays guest events to the other guests.
   * @param {string} type
   * @param {any} payload
   * @returns {void}
   */
  sendEvent(type, payload) {
    const msg = JSON.stringify(this._mesh
      ? { k: 'e', t: type, p: payload === undefined ? null : payload, f: this._localId ?? 0, n: ++this._evN }
      : { k: 'e', t: type, p: payload === undefined ? null : payload, f: this._localId ?? 0 });
    for (const l of this._links.values()) l.tr.sendReliable(msg);
  }

  /**
   * Interpolated remote players at `nowMs`. The returned Map and its entries are reused between calls.
   * Each entry: {x,y,z,vx,vy,vz,yaw,yawRate,lean,flags,health, age (ms beyond newest snapshot), extrapolated}.
   * @param {number} nowMs
   * @returns {Map<number, object>}
   */
  remotePlayers(nowMs) {
    const out = this._out;
    out.clear();
    for (const [id, r] of this._remote) {
      if (r.est == null) continue;
      const predict = this.mode === 'predict';
      let tr;
      if (predict) {
        const off = this.senderOffsetMs(id, r.via);
        tr = off != null ? nowMs + off : nowMs + r.est + this.oneWayMs(r.via);
      } else tr = nowMs - this.interpDelayMs + r.est;
      // retroactive correction: how much did newly arrived data change what we showed last frame?
      if (r.hasPrev) {
        const p = predict ? predictSample(r.buf, r.prevT, r.tmpB, this.maxPredictMs) : r.buf.sample(r.prevT, r.tmpB);
        r.ex += r.prev.x - p.x; r.ey += r.prev.y - p.y; r.ez += r.prev.z - p.z;
        r.eyaw += wrapPi(r.prev.yaw - p.yaw); r.elean += r.prev.lean - p.lean;
      }
      const dtS = r.lastNow == null ? 0 : Math.max(0, Math.min(0.25, (nowMs - r.lastNow) / 1000));
      const f = Math.exp(-dtS * 1000 / this.errorTauMs);
      r.ex *= f; r.ey *= f; r.ez *= f; r.eyaw *= f; r.elean *= f;
      if (r.ex * r.ex + r.ey * r.ey + r.ez * r.ez > 400) { r.ex = r.ey = r.ez = r.eyaw = r.elean = 0; } // teleport: do not smear
      const raw = predict ? predictSample(r.buf, tr, r.raw, this.maxPredictMs) : r.buf.sample(tr, r.raw);
      if (!raw) continue;
      r.prev.x = raw.x; r.prev.y = raw.y; r.prev.z = raw.z; r.prev.yaw = raw.yaw; r.prev.lean = raw.lean;
      r.prevT = tr;
      r.hasPrev = true;
      r.lastNow = nowMs;
      const o = r.disp;
      o.x = raw.x + r.ex; o.y = raw.y + r.ey; o.z = raw.z + r.ez;
      o.vx = raw.vx; o.vy = raw.vy; o.vz = raw.vz;
      o.yaw = raw.yaw + r.eyaw; o.yawRate = raw.yawRate; o.lean = raw.lean + r.elean;
      o.flags = raw.flags; o.health = raw.health;
      o.age = raw.age; o.extrapolated = raw.extrapolated;
      out.set(id, o);
    }
    return out;
  }

  /**
   * Send a non-player binary packet on the unreliable channel: host to every guest, guest to the host.
   * The first byte must be a tag other than a state packet (see WORLD_TAG); the length must not be
   * STATE_PACKET_BYTES. Never relayed between guests and never delivered to the sender.
   * @param {ArrayBuffer} buf
   * @returns {void}
   */
  broadcastUnreliable(buf) {
    for (const l of this._links.values()) l.tr.sendUnreliable(buf);
  }

  /**
   * Subscribe to non-player unreliable packets.
   * @param {(buf:ArrayBuffer, fromPeer:number, arrivalMs:number)=>void} cb arrivalMs is read from the manager clock
   * @returns {()=>void} unsubscribe function
   */
  onUnreliable(cb) {
    this._unreliableCbs.push(cb);
    return () => { const i = this._unreliableCbs.indexOf(cb); if (i >= 0) this._unreliableCbs.splice(i, 1); };
  }

  /**
   * Disconnect everything and release peer connections.
   * @returns {void}
   */
  close() {
    for (const l of this._links.values()) { try { l.tr.close && l.tr.close(); } catch { /* ignore */ } }
    for (const e of this._pending.values()) { try { e.pc.close(); } catch { /* ignore */ } }
    if (this._guestPc) { try { this._guestPc.close(); } catch { /* ignore */ } }
    this._links.clear();
    this._pending.clear();
    this._remote.clear();
    this._known.clear();
    this._peerLinks.clear();
    this._members.clear();
    this._setStatus('closed');
  }

  // ------------------------------------------------------------ internals

  _attach(peerId, tr) {
    const old = this._links.get(peerId);
    if (old && old.tr !== tr) { try { old.tr.close && old.tr.close(); } catch { /* ignore */ } }
    const link = { id: peerId, tr, rtt: null, clockOffset: null, samples: [], lastPing: -Infinity, pongs: 0 };
    this._links.set(peerId, link);
    tr.onMessage((data) => this._onData(link, data));
    if (tr.onClose) tr.onClose(() => this._detach(peerId));
    if (peerId === 0) {
      this._isHost = false; // our own id arrives with the host's hello
      this._setStatus('connecting');
    } else {
      this._isHost = true;
      this._localId = 0;
      tr.sendReliable(JSON.stringify({ k: 'h', id: peerId }));
      for (const other of this._known) tr.sendReliable(JSON.stringify({ k: 'j', id: other }));
      for (const [id, l] of this._links) if (id !== peerId) l.tr.sendReliable(JSON.stringify({ k: 'j', id: peerId }));
      this._addPeer(peerId);
      this._setStatus('connected', { peerId });
    }
  }

  _addPeer(id) {
    if (this._known.has(id)) return;
    this._known.add(id);
    if (this.onPeer) this.onPeer(id, true);
  }

  _removePeer(id) {
    this._remote.delete(id);
    if (this._known.delete(id) && this.onPeer) this.onPeer(id, false);
  }

  _detach(peerId) {
    if (this._mesh) return this.meshDetach(peerId);
    const link = this._links.get(peerId);
    if (!link) return;
    this._links.delete(peerId);
    if (this._isHost) {
      this._removePeer(peerId);
      for (const l of this._links.values()) l.tr.sendReliable(JSON.stringify({ k: 'l', id: peerId }));
      if (!this._links.size) this._setStatus('hosting');
    } else {
      for (const id of [...this._known]) this._removePeer(id);
      this._setStatus('disconnected');
    }
  }

  _onData(link, data) {
    if (typeof data === 'string') return this._onReliable(link, data);
    if (!data || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
    if (data.byteLength !== STATE_PACKET_BYTES) {
      const ab = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      if (ab.byteLength > 0 && new Uint8Array(ab)[0] === WORLD_TAG) {
        if (this._mesh && ab.byteLength > 15) {
          const origin = new Uint8Array(ab)[15]; // authority small id in the world header
          this._forward(origin, link, (l) => l.tr.sendUnreliable(ab));
        }
        const at = this._now();
        for (const cb of this._unreliableCbs.slice()) cb(ab, link.id, at);
        return;
      }
    }
    this._onState(link, data);
  }

  _onState(link, data) {
    let pkt;
    try { pkt = decodeState(data); } catch { return; }
    const origin = this._mesh ? pkt.peer : (link.id === 0 ? pkt.peer : link.id);
    if (origin === this._localId) return;
    if (this._mesh && !this._members.has(origin)) return;
    let r = this._remote.get(origin);
    if (!r) {
      r = {
        buf: new SnapshotBuffer(), lastSeq: null, est: null, window: [],
        raw: {}, tmpB: {}, prev: { x: 0, y: 0, z: 0, yaw: 0, lean: 0 }, prevT: 0, hasPrev: false, lastNow: null,
        ex: 0, ey: 0, ez: 0, eyaw: 0, elean: 0, disp: {},
      };
      this._remote.set(origin, r);
    }
    if (r.lastSeq != null && !seqNewer(pkt.seq, r.lastSeq)) return;
    r.lastSeq = pkt.seq;
    r.via = link.id;
    const arrival = this._now();
    // remote-minus-local time seen at arrival = clockOffset - latency; the max over a window
    // corresponds to the lowest-latency packet, so jitter never pushes the render time forward.
    const sample = pkt.t - arrival;
    r.window.push(sample);
    if (r.window.length > 90) r.window.shift();
    let target = -Infinity;
    for (const v of r.window) if (v > target) target = v;
    r.est = r.est == null ? sample : r.est + (target - r.est) * 0.05;
    const s = pkt.state;
    s.t = pkt.t;
    r.buf.push(s);
    if (this._mesh) {
      this._forward(origin, link, (l) => l.tr.sendUnreliable(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      return;
    }
    if (this._isHost && this._links.size > 1) {
      const co = link.clockOffset != null ? link.clockOffset : r.est;
      const copy = new ArrayBuffer(STATE_PACKET_BYTES);
      new Uint8Array(copy).set(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data instanceof ArrayBuffer ? 0 : data.byteOffset, STATE_PACKET_BYTES));
      const dv = new DataView(copy);
      dv.setUint32(2, Math.round(pkt.t - co) >>> 0, true); // translate to the host clock
      dv.setUint8(32, origin);
      for (const l of this._links.values()) if (l.id !== origin) l.tr.sendUnreliable(copy);
    }
  }

  _dupEvent(origin, n) {
    if (n == null) return false;
    let e = this._seenEv.get(origin);
    if (!e) { e = { set: new Set(), order: [] }; this._seenEv.set(origin, e); }
    if (e.set.has(n)) return true;
    e.set.add(n); e.order.push(n);
    if (e.order.length > 256) e.set.delete(e.order.shift());
    return false;
  }

  _onMesh(link, p) {
    if (!p || !this._mesh) return;
    if (p.t === 'x') {
      this._peerLinks.set(link.id, new Set(p.l));
    } else if (p.t === 'auth') {
      const newer = ((p.epoch - this._epoch) & 255) !== 0 && ((p.epoch - this._epoch) & 255) < 128;
      if (newer || (p.epoch === this._epoch && p.id < this._authId)) {
        this.setAuthority(p.id, p.epoch, 'announce', { seq: p.seq, raceT: p.raceT, phase: p.phase });
      }
    } else if (this._meshCb) this._meshCb(p, link.id);
  }

  _onReliable(link, str) {
    let m;
    try { m = JSON.parse(str); } catch { return; }
    switch (m.k) {
      case 'p':
        link.tr.sendReliable(JSON.stringify({ k: 'q', t: m.t, r: this._now() }));
        break;
      case 'q': {
        const T = this._now();
        const rtt = T - m.t;
        if (!(rtt >= 0)) break;
        link.pongs++;
        link.rtt = link.rtt == null ? rtt : link.rtt + (rtt - link.rtt) * 0.2;
        link.samples.push({ rtt, off: m.r - (m.t + rtt / 2) });
        if (link.samples.length > 8) link.samples.shift();
        let best = link.samples[0];
        for (const s of link.samples) if (s.rtt < best.rtt) best = s;
        link.clockOffset = best.off;
        break;
      }
      case 'h':
        this._localId = m.id;
        this._addPeer(0);
        this._setStatus('connected', { peerId: 0 });
        break;
      case 'j': if (!this._isHost) this._addPeer(m.id); break;
      case 'l': if (!this._isHost) this._removePeer(m.id); break;
      case 'M': this._onMesh(link, m.p); break;
      case 'e': {
        if (this._mesh) {
          if (this._dupEvent(m.f, m.n)) break;
          this._forward(m.f, link, (l) => l.tr.sendReliable(str));
          if (this.onEvent) this.onEvent(m.t, m.p, m.f);
          break;
        }
        const from = this._isHost ? link.id : m.f;
        if (this._isHost && this._links.size > 1) {
          const relay = JSON.stringify({ k: 'e', t: m.t, p: m.p, f: from });
          for (const l of this._links.values()) if (l.id !== link.id) l.tr.sendReliable(relay);
        }
        if (this.onEvent) this.onEvent(m.t, m.p, from);
        break;
      }
      default: break;
    }
  }
}

/**
 * Plug a transport (a real data-channel pair, or a fake one in tests) into a manager.
 * Guests attach the host as peerId 0; the host attaches each guest under its id (>= 1) and
 * welcomes it with its id. transport: {sendUnreliable(arrayBuffer), sendReliable(string),
 * onMessage(cb(data: ArrayBuffer|string)), onClose?(cb), close?()}.
 * @param {NetworkManager} nm
 * @param {number} peerId id of the remote end of this transport
 * @param {{sendUnreliable:Function, sendReliable:Function, onMessage:Function, onClose?:Function, close?:Function}} transport
 * @returns {void}
 */
export function attachTransport(nm, peerId, transport) {
  nm._attach(peerId, transport);
}
