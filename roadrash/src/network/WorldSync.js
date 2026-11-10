/**
 * WorldSync: host-authoritative AI and world replication on top of NetworkManager.
 *
 * The host simulates every AI rider and all traffic and broadcasts a compact snapshot at
 * ~20 Hz on the unreliable channel (tagged WORLD_TAG so it can never be mistaken for a 33-byte
 * player state packet). Guests never simulate AI: they buffer the snapshots and write
 * interpolated values (SnapshotBuffer interpolation, capped dead reckoning, smooth error
 * correction, as for remote players) into each AI rider's `bike`.
 *
 * Pure logic, no DOM, no import of the Race module: `race` is the plain shape
 * {riders:[{slot, kind, remote, bike, input?}], traffic:[{id, hit}], phase, t}.
 * @module network/WorldSync
 */
import { SnapshotBuffer, seqNewer, predictSample, WORLD_TAG, MAX_PREDICT_MS } from './NetworkManager.js';

const PI = Math.PI;
const Q_ANGLE = 32767 / PI;
const Q_VEL = 50;
const Q_RATE = 1000;

/** Total riders on the grid (humans + AI). */
export const GRID_SIZE = 15;
/** Fixed header size of a world packet in bytes. */
export const WORLD_HEADER_BYTES = 16;
/** Bytes per AI rider record. */
export const WORLD_RIDER_BYTES = 27;
/** Maximum hit-car ids carried per packet (2 bytes each). */
export const MAX_HIT_CARS = 64;

/** Rider flag bits in the world packet. bits 4-5: weapon (0 none, 1 punch, 2 baton, 3 chain). */
export const FLAG = { DRIFTING: 1, CRASHED: 2, ATTACKING: 4, SIDE_RIGHT: 8 };
const WEAPONS = [null, 'punch', 'baton', 'chain'];
const PHASES = ['grid', 'countdown', 'racing', 'finished'];

function wrapPi(a) {
  a = (a + PI) % (2 * PI);
  if (a <= 0) a += 2 * PI;
  return a - PI;
}
const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Pack a rider's drifting/crashed/attacking/side/weapon state into the flags byte.
 * @param {object} rider {bike, input?}
 * @returns {number}
 */
function riderFlags(rider) {
  const b = rider.bike;
  const inp = rider.input || {};
  let f = 0;
  if (b.drifting) f |= FLAG.DRIFTING;
  if (b.crashed) f |= FLAG.CRASHED;
  const w = WEAPONS.indexOf(inp.attack || null);
  if (w > 0) {
    f |= FLAG.ATTACKING | (w << 4);
    if (inp.attackSide > 0) f |= FLAG.SIDE_RIGHT;
  }
  return f;
}

/**
 * Encode the host's world snapshot: every AI rider, race phase/time and hit traffic car ids.
 * Layout (little endian): tag u8, seq u16, time u32 ms, phase u8, raceT f32, count u8, hitCount u8, epoch u8, authority small id u8,
 * then per rider slot u8, pos f32 x3, vel i16 x3 (0.02 m/s), yaw i16, lean i16, yawRate i16, flags u8, health u8,
 * then hitCount x u16 car ids.
 * @param {{riders:object[], traffic?:object[], phase?:string, t?:number}} race
 * @param {number} seq sequence number (wrapped to u16)
 * @param {number} tMs sender clock in ms (wrapped to u32)
 * @param {number} [epoch=0] authority epoch (u8); packets of an older epoch are dropped by receivers
 * @param {number} [authorityId=0] small id of the sending authority (u8)
 * @returns {ArrayBuffer}
 */
export function encodeWorld(race, seq, tMs, epoch = 0, authorityId = 0) {
  const ai = race.riders.filter((r) => r.kind === 'ai');
  const hits = [];
  if (race.traffic) for (const c of race.traffic) if (c.hit && hits.length < MAX_HIT_CARS) hits.push(c.id & 0xffff);
  const buf = new ArrayBuffer(WORLD_HEADER_BYTES + ai.length * WORLD_RIDER_BYTES + hits.length * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, WORLD_TAG);
  dv.setUint16(1, seq & 0xffff, true);
  dv.setUint32(3, Math.round(tMs) >>> 0, true);
  dv.setUint8(7, Math.max(0, PHASES.indexOf(race.phase)));
  dv.setFloat32(8, race.t || 0, true);
  dv.setUint8(12, ai.length);
  dv.setUint8(13, hits.length);
  dv.setUint8(14, epoch & 0xff);
  dv.setUint8(15, authorityId & 0xff);
  let o = WORLD_HEADER_BYTES;
  for (const r of ai) {
    const b = r.bike;
    dv.setUint8(o, r.slot & 0xff);
    dv.setFloat32(o + 1, b.pos.x, true);
    dv.setFloat32(o + 5, b.pos.y, true);
    dv.setFloat32(o + 9, b.pos.z, true);
    dv.setInt16(o + 13, clamp16(Math.round(b.vel.x * Q_VEL)), true);
    dv.setInt16(o + 15, clamp16(Math.round(b.vel.y * Q_VEL)), true);
    dv.setInt16(o + 17, clamp16(Math.round(b.vel.z * Q_VEL)), true);
    dv.setInt16(o + 19, clamp16(Math.round(wrapPi(b.yaw) * Q_ANGLE)), true);
    dv.setInt16(o + 21, clamp16(Math.round(wrapPi(b.lean || 0) * Q_ANGLE)), true);
    dv.setInt16(o + 23, clamp16(Math.round((b.yawRate || 0) * Q_RATE)), true);
    dv.setUint8(o + 25, riderFlags(r));
    dv.setUint8(o + 26, Math.max(0, Math.min(255, Math.round(b.health ?? 100))));
    o += WORLD_RIDER_BYTES;
  }
  for (const id of hits) { dv.setUint16(o, id, true); o += 2; }
  // Invariant: a world packet length is 16 + 27n + 2h; 27n+2h=17 has no solution, so it can never equal the 33-byte state packet.
  return buf;
}

/**
 * Decode a world packet produced by {@link encodeWorld}.
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {{seq:number, t:number, epoch:number, authorityId:number, phase:string, raceT:number, riders:{slot:number,x:number,y:number,z:number,vx:number,vy:number,vz:number,yaw:number,yawRate:number,lean:number,flags:number,health:number}[], hitCars:number[]}}
 */
export function decodeWorld(buf) {
  let ab = buf;
  if (ArrayBuffer.isView(buf)) ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (ab.byteLength < WORLD_HEADER_BYTES) throw new RangeError('world packet too short');
  const dv = new DataView(ab);
  if (dv.getUint8(0) !== WORLD_TAG) throw new TypeError('not a world packet');
  const count = dv.getUint8(12);
  const nh = dv.getUint8(13);
  if (ab.byteLength < WORLD_HEADER_BYTES + count * WORLD_RIDER_BYTES + nh * 2) throw new RangeError('world packet truncated');
  const riders = [];
  let o = WORLD_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    riders.push({
      slot: dv.getUint8(o),
      x: dv.getFloat32(o + 1, true), y: dv.getFloat32(o + 5, true), z: dv.getFloat32(o + 9, true),
      vx: dv.getInt16(o + 13, true) / Q_VEL, vy: dv.getInt16(o + 15, true) / Q_VEL, vz: dv.getInt16(o + 17, true) / Q_VEL,
      yaw: dv.getInt16(o + 19, true) / Q_ANGLE, lean: dv.getInt16(o + 21, true) / Q_ANGLE,
      yawRate: dv.getInt16(o + 23, true) / Q_RATE,
      flags: dv.getUint8(o + 25), health: dv.getUint8(o + 26),
    });
    o += WORLD_RIDER_BYTES;
  }
  const hitCars = [];
  for (let i = 0; i < nh; i++) { hitCars.push(dv.getUint16(o, true)); o += 2; }
  return {
    seq: dv.getUint16(1, true),
    t: dv.getUint32(3, true),
    epoch: dv.getUint8(14),
    authorityId: dv.getUint8(15),
    phase: PHASES[dv.getUint8(7)] || 'grid',
    raceT: dv.getFloat32(8, true),
    riders,
    hitCars,
  };
}

/**
 * Decode a rider flags byte.
 * @param {number} f flags byte
 * @returns {{drifting:boolean, crashed:boolean, attacking:boolean, side:number, weapon:string|null}}
 */
export function decodeFlags(f) {
  const attacking = !!(f & FLAG.ATTACKING);
  return {
    drifting: !!(f & FLAG.DRIFTING),
    crashed: !!(f & FLAG.CRASHED),
    attacking,
    side: f & FLAG.SIDE_RIGHT ? 1 : -1,
    weapon: attacking ? WEAPONS[(f >> 4) & 3] : null,
  };
}

/**
 * Deterministic slot assignment shared by every device: the host (first id) is slot 0, joining
 * humans take the highest slots downward (first guest 14, second 13, ...), AI fill the rest.
 * @param {number[]} peerIds peer ids, host first
 * @param {number} [total=15] grid size
 * @returns {{humans:{peerId:number, slot:number}[], aiSlots:number[], aiCount:number}}
 */
export function assignSlots(peerIds, total = GRID_SIZE) {
  if (peerIds.length > total) throw new RangeError('more humans than grid slots');
  const humans = [];
  const used = new Set();
  peerIds.forEach((peerId, i) => {
    const slot = i === 0 ? 0 : total - i;
    humans.push({ peerId, slot });
    used.add(slot);
  });
  const aiSlots = [];
  for (let s = 0; s < total; s++) if (!used.has(s)) aiSlots.push(s);
  return { humans, aiSlots, aiCount: aiSlots.length };
}

/**
 * Build the payload of the reliable 'roster' event.
 * @param {number[]} peerIds peer ids, host first
 * @param {number} seed race seed
 * @param {string} trackId track id
 * @returns {{humans:{peerId:number, slot:number}[], seed:number, trackId:string}}
 */
export function makeRoster(peerIds, seed, trackId) {
  return { humans: assignSlots(peerIds).humans, seed, trackId };
}

function newTrack() {
  return {
    buf: new SnapshotBuffer(32), raw: {}, tmpB: {}, prev: { x: 0, y: 0, z: 0, yaw: 0, lean: 0 }, prevT: 0,
    hasPrev: false, lastNow: null, ex: 0, ey: 0, ez: 0, eyaw: 0, elean: 0, carry: null,
  };
}

const epochNewer = (a, b) => { const d = (a - b) & 255; return d !== 0 && d < 128; };

/**
 * Authority-run world replication (see module comment). The authority is the host in the manual star topology and the
 * elected device in the room-code mesh; it can migrate (see onAuthorityChange).
 */
export class WorldSync {
  /**
   * @param {object} nm NetworkManager (or a fake with isHost, broadcastUnreliable, onUnreliable, sendEvent, localId)
   * @param {object} [opts]
   * @param {number} [opts.hz=20] authority snapshot rate
   * @param {'predict'|'interp'} [opts.mode='predict'] 'predict' dead-reckons the newest snapshots forward to the present
   *   (error-blended, never snapping); 'interp' shows the delayed interpolation as before
   * @param {number} [opts.maxPredictMs=280] look-ahead cap in predict mode
   * @param {number} [opts.interpDelayMs=150] render delay behind the freshest data (interp mode)
   * @param {number} [opts.errorTauMs=120] time constant of the smooth correction
   * @param {number} [opts.authorityTimeoutMs=1500] silence after which the authority is considered gone (mesh only)
   */
  constructor(nm, opts = {}) {
    this.nm = nm;
    this.hz = opts.hz ?? 20;
    this.mode = opts.mode === 'interp' ? 'interp' : 'predict';
    this.maxPredictMs = opts.maxPredictMs ?? MAX_PREDICT_MS;
    this.interpDelayMs = opts.interpDelayMs ?? 150;
    this.errorTauMs = opts.errorTauMs ?? 120;
    this.authorityTimeoutMs = opts.authorityTimeoutMs ?? 1500;
    this._seq = 0;
    this._nextSend = null;
    this._tracks = new Map(); // slot -> track
    this._phases = []; // {t, phase, raceT}
    this._hitCars = new Set();
    this._lastSeq = null;
    this._window = [];
    this._est = null; // authority clock minus local clock, ms
    this._via = null;
    this._lastPktAt = null;
    this._race = null;
    this._lastRaceT = null;
    this._lastPhase = null;
    this._cbs = [];
    this.roster = null;
    this._seenHits = new Set();
    this.packetsIn = 0;
    /** World packets dropped because they came from an older authority epoch. */
    this.staleDropped = 0;
    this._unsub = nm.onUnreliable ? nm.onUnreliable((buf, from, at) => this._onPacket(buf, from, at)) : null;
    this._unsubAuth = nm.onAuthorityChange ? nm.onAuthorityChange((ev) => this._onAuthority(ev)) : null;
    if (nm.mesh !== undefined) {
      nm.authorityInfo = () => ({ seq: this._lastSeq, raceT: this._currentRaceT(), phase: this._race ? this._race.phase : this._lastPhase });
    }
  }

  /** @returns {number} small id of the current authority (0 = the host in the star topology) */
  get authorityId() { return this.nm.authorityId !== undefined ? this.nm.authorityId : 0; }
  /** @returns {boolean} true when this device runs the AI, traffic and race clock */
  get isAuthority() { return this.nm.isAuthority !== undefined ? this.nm.isAuthority : !!this.nm.isHost; }

  /**
   * Subscribe to authority changes. `info` = {authorityId, isAuthority, previous, epoch, reason, seq, raceT, phase}:
   * when `isAuthority` turns true the app flips `race.authority` to 'host' and continues the race from `raceT`
   * (the AI bikes are already in the race object); when it turns false it flips back to 'guest'.
   * @param {(info:object)=>void} cb
   * @returns {()=>void} unsubscribe
   */
  onAuthorityChange(cb) {
    this._cbs.push(cb);
    return () => { const i = this._cbs.indexOf(cb); if (i >= 0) this._cbs.splice(i, 1); };
  }

  /** Stop listening for world packets and authority changes. @returns {void} */
  dispose() {
    if (this._unsub) this._unsub();
    if (this._unsubAuth) this._unsubAuth();
    this._unsub = null; this._unsubAuth = null;
  }

  _currentRaceT() {
    if (this._race && Number.isFinite(this._race.t)) return this._race.t;
    return this._lastRaceT;
  }

  _resetStreams() {
    this._lastRaceT = this._currentRaceT();
    if (this._race) this._lastPhase = this._race.phase;
    for (const t of this._tracks.values()) {
      t.carry = t.hasPrev ? { x: t.prev.x + t.ex, y: t.prev.y + t.ey, z: t.prev.z + t.ez, yaw: t.prev.yaw + t.eyaw, lean: t.prev.lean + t.elean } : t.carry;
      t.buf = new SnapshotBuffer(32);
      t.hasPrev = false; t.lastNow = null;
      t.ex = t.ey = t.ez = t.eyaw = t.elean = 0;
    }
    this._phases = [];
    this._window = [];
    this._est = null;
    this._lastSeq = null;
  }

  _onAuthority(ev) {
    const out = { ...ev };
    this._resetStreams();
    this._lastPktAt = null;
    if (ev.isAuthority) {
      // continue the sequence numbering and the race clock of the authority that vanished
      if (ev.seq != null) this._seq = (ev.seq + 1) & 0xffff;
      this._nextSend = null;
      out.raceT = out.raceT != null ? out.raceT : this._currentRaceT();
      out.seq = ev.seq;
    }
    for (const cb of this._cbs.slice()) cb(out);
  }

  /**
   * Authority: broadcast a world snapshot if 1/hz has elapsed. No-op on non-authority devices.
   * @param {object} race
   * @param {number} nowMs manager clock
   * @returns {boolean} true when a packet was sent
   */
  hostTick(race, nowMs) {
    if (!this.isAuthority) return false;
    const interval = 1000 / this.hz;
    if (this._nextSend == null) this._nextSend = nowMs;
    if (nowMs < this._nextSend) return false;
    this._nextSend += interval;
    if (this._nextSend < nowMs) this._nextSend = nowMs + interval;
    this.nm.broadcastUnreliable(encodeWorld(race, this._seq++, nowMs, this.nm.epoch || 0, this.nm.mesh ? this.nm.localId : 0));
    return true;
  }

  _onPacket(buf, from, arrival) {
    const nm = this.nm;
    if (this.isAuthority && !nm.mesh) return; // only non-authority devices consume the world
    let pkt;
    try { pkt = decodeWorld(buf); } catch { return; }
    if (nm.mesh) {
      const cur = nm.epoch;
      if (epochNewer(cur, pkt.epoch)) { this.staleDropped++; return; }
      if (epochNewer(pkt.epoch, cur) || (pkt.epoch === cur && pkt.authorityId < nm.authorityId)) {
        nm.setAuthority(pkt.authorityId, pkt.epoch, 'packet');
      } else if (pkt.authorityId !== nm.authorityId) { this.staleDropped++; return; }
      if (this.isAuthority) return;
    }
    this._via = from;
    this._lastPktAt = arrival;
    if (this._lastSeq == null || seqNewer(pkt.seq, this._lastSeq)) this._lastSeq = pkt.seq;
    this.packetsIn++;
    // authority-minus-local time at arrival = offset - latency; the window max follows the fastest packets
    const sample = pkt.t - arrival;
    this._window.push(sample);
    if (this._window.length > 90) this._window.shift();
    let target = -Infinity;
    for (const v of this._window) if (v > target) target = v;
    this._est = this._est == null ? sample : this._est + (target - this._est) * 0.05;
    for (const r of pkt.riders) {
      let tr = this._tracks.get(r.slot);
      if (!tr) { tr = newTrack(); this._tracks.set(r.slot, tr); }
      r.t = pkt.t;
      tr.buf.push(r);
    }
    this._phases.push({ t: pkt.t, phase: pkt.phase, raceT: pkt.raceT });
    this._phases.sort((a, b) => a.t - b.t);
    if (this._phases.length > 24) this._phases.shift();
    for (const id of pkt.hitCars) this._hitCars.add(id);
  }

  /** Authority-clock time to show at local time nowMs. */
  _target(nowMs) {
    if (this.mode === 'interp') return nowMs - this.interpDelayMs + this._est;
    const nm = this.nm;
    const off = nm.senderOffsetMs ? nm.senderOffsetMs(this.authorityId, this._via) : null;
    if (off != null) return nowMs + off;
    return nowMs + this._est + (nm.oneWayMs ? nm.oneWayMs(this._via) : 50);
  }

  _sample(buf, T, out) {
    return this.mode === 'interp' ? buf.sample(T, out) : predictSample(buf, T, out, this.maxPredictMs);
  }

  _checkTimeout(nowMs) {
    const nm = this.nm;
    if (!nm.mesh || this._lastPktAt == null || nowMs - this._lastPktAt <= this.authorityTimeoutMs) return;
    this._lastPktAt = nowMs; // re-arm: a second silence elects the next candidate
    let others = 0;
    for (const id of nm.peers) if (id !== nm.authorityId && nm.linkState(id) !== 'none') others++;
    if (others > 0) nm.suspectAuthority();
  }

  /**
   * Non-authority: write the AI riders' state into the race. In 'predict' mode (default) the newest snapshots are
   * dead-reckoned to the present (the sender clock comes from ping/pong), with every correction blended out
   * exponentially; in 'interp' mode they are interpolated 150 ms behind. race.phase / race.t follow the authority.
   * Also detects a silent authority (no world packets for authorityTimeoutMs while other peers are connected).
   * @param {object} race
   * @param {number} nowMs manager clock
   * @returns {boolean} true when data was applied
   */
  guestApply(race, nowMs) {
    if (this.isAuthority) return false;
    this._race = race;
    this._checkTimeout(nowMs);
    if (this._est == null) {
      // between authorities (or before the first packet): keep the race clock running
      if (this._lastRaceT != null && this.nm.mesh) {
        if (this._clockStamp != null) this._lastRaceT += (nowMs - this._clockStamp) / 1000;
        race.t = this._lastRaceT;
      }
      this._clockStamp = nowMs;
      return false;
    }
    const tr = this._target(nowMs);
    for (const rider of race.riders) {
      if (rider.kind !== 'ai') continue;
      const t = this._tracks.get(rider.slot);
      if (!t || !t.buf.length) continue;
      this._applyRider(rider, t, tr, nowMs);
    }
    // phase and race time
    const ph = this._phases;
    if (ph.length) {
      let cur = ph[0];
      for (const p of ph) if (p.t <= tr) cur = p;
      race.phase = cur.phase;
      const last = ph[ph.length - 1];
      race.t = last.raceT + (tr - last.t) / 1000;
      this._lastRaceT = race.t;
      this._lastPhase = race.phase;
      this._clockStamp = nowMs;
    }
    if (race.traffic && this._hitCars.size) for (const c of race.traffic) if (this._hitCars.has(c.id)) c.hit = true;
    return true;
  }

  _applyRider(rider, t, tr, nowMs) {
    if (t.hasPrev) {
      const p = this._sample(t.buf, t.prevT, t.tmpB);
      t.ex += t.prev.x - p.x; t.ey += t.prev.y - p.y; t.ez += t.prev.z - p.z;
      t.eyaw += wrapPi(t.prev.yaw - p.yaw); t.elean += t.prev.lean - p.lean;
    }
    const dtS = t.lastNow == null ? 0 : Math.max(0, Math.min(0.25, (nowMs - t.lastNow) / 1000));
    const f = Math.exp(-dtS * 1000 / this.errorTauMs);
    t.ex *= f; t.ey *= f; t.ez *= f; t.eyaw *= f; t.elean *= f;
    if (t.ex * t.ex + t.ey * t.ey + t.ez * t.ez > 400) { t.ex = t.ey = t.ez = t.eyaw = t.elean = 0; } // teleport (remount): snap
    const raw = this._sample(t.buf, tr, t.raw);
    if (!t.hasPrev && !t.carry) {
      // first data for this slot (race start, or a human slot that just became AI): continue from where the bike is
      const bb = rider.bike;
      t.carry = { x: bb.pos.x, y: bb.pos.y, z: bb.pos.z, yaw: bb.yaw, lean: bb.lean };
    }
    if (t.carry) {
      // first frame after an authority switch: start from what was on screen and blend into the new stream
      const c = t.carry;
      t.carry = null;
      const dx = c.x - raw.x, dy = c.y - raw.y, dz = c.z - raw.z;
      if (dx * dx + dy * dy + dz * dz <= 400) {
        t.ex = dx; t.ey = dy; t.ez = dz;
        t.eyaw = wrapPi(c.yaw - raw.yaw); t.elean = c.lean - raw.lean;
      }
    }
    t.prev.x = raw.x; t.prev.y = raw.y; t.prev.z = raw.z; t.prev.yaw = raw.yaw; t.prev.lean = raw.lean;
    t.prevT = tr;
    t.hasPrev = true;
    t.lastNow = nowMs;
    const b = rider.bike;
    b.pos.x = raw.x + t.ex; b.pos.y = raw.y + t.ey; b.pos.z = raw.z + t.ez;
    b.vel.x = raw.vx; b.vel.y = raw.vy; b.vel.z = raw.vz;
    b.yaw = raw.yaw + t.eyaw;
    b.yawRate = raw.yawRate;
    b.lean = raw.lean + t.elean;
    b.speed = -raw.vx * Math.sin(b.yaw) - raw.vz * Math.cos(b.yaw);
    const fl = decodeFlags(raw.flags);
    b.drifting = fl.drifting;
    b.crashed = fl.crashed;
    b.health = raw.health;
    rider.netInfo = { attacking: fl.attacking, side: fl.side, weapon: fl.weapon };
    if (rider.input) {
      rider.input.attack = fl.attacking ? fl.weapon : null;
      rider.input.attackSide = fl.side;
    }
  }

  _humanList() {
    if (this.nm.mesh) return this.nm.humans();
    return this.roster ? this.roster.humans : [];
  }

  /**
   * Decide where a hit must be applied.
   * @param {object} race
   * @param {{from:number,to:number,hit:any}} evt
   * @returns {{where:'local'|'remote'|'invalid', peerId?:number}} 'local': victim simulated on this device; 'remote': owner is peerId (the authority for AI slots)
   */
  routeHit(race, evt) {
    const v = race.riders && race.riders[evt && evt.to];
    if (!v) return { where: 'invalid' };
    if (!v.remote) return { where: 'local' };
    if (v.kind === 'ai') return { where: 'remote', peerId: this.authorityId };
    const h = this._humanList().find((x) => x.slot === v.slot);
    return h ? { where: 'remote', peerId: h.peerId } : { where: 'invalid' };
  }

  /**
   * Caller entry point for a hit this device resolved against a rider (a race 'hit' event). If the victim is
   * simulated here the caller should apply it; otherwise it is sent reliably (every device receives it, only the
   * simulating device acts, see handleEvent).
   * @param {object} race
   * @param {{from:number,to:number,hit:any,id?:number}} evt
   * @returns {{where:string, peerId?:number}} the route taken
   */
  sendHit(race, evt) {
    const route = this.routeHit(race, evt);
    if (route.where === 'remote') this.nm.sendEvent('hit', evt);
    return route;
  }

  /**
   * Handle a reliable event received through nm.onEvent.
   * @param {object} race
   * @param {string} type
   * @param {any} payload
   * @param {number} fromPeer
   * @returns {{action:'roster', humans:object[], seed:number, trackId:string, localSlot:number|null, remoteSlots:number[], aiSlots:number[]}
   *   |{action:'start', raceT0:number}|{action:'applyHit', from:number, to:number, hit:any}|{action:'ignore'}}
   */
  handleEvent(race, type, payload, fromPeer) {
    switch (type) {
      case 'roster': {
        if (!payload || !Array.isArray(payload.humans)) return { action: 'ignore' };
        this.roster = payload;
        const me = payload.humans.find((h) => h.peerId === this.nm.localId);
        const slots = new Set(payload.humans.map((h) => h.slot));
        const aiSlots = [];
        for (let s = 0; s < GRID_SIZE; s++) if (!slots.has(s)) aiSlots.push(s);
        return {
          action: 'roster', humans: payload.humans, seed: payload.seed, trackId: payload.trackId,
          localSlot: me ? me.slot : null,
          remoteSlots: payload.humans.filter((h) => h !== me).map((h) => h.slot),
          aiSlots,
        };
      }
      case 'start':
        return { action: 'start', raceT0: payload ? payload.raceT0 : 0 };
      case 'hit': {
        if (!payload) return { action: 'ignore' };
        if (payload.id != null) {
          if (this._seenHits.has(payload.id)) return { action: 'ignore' };
          this._seenHits.add(payload.id);
        }
        if (this.routeHit(race, payload).where !== 'local') return { action: 'ignore' };
        return { action: 'applyHit', from: payload.from, to: payload.to, hit: payload.hit };
      }
      default:
        return { action: 'ignore' };
    }
  }
}
