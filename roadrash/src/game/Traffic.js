// Sparse civilian traffic in both directions. Pure logic, deterministic from (seed, track).
// Until a car is hit its state is a pure function of race time, so every device agrees without
// network traffic. Cars are generated as two chains (with the race, oncoming) whose speeds are
// ordered so a car never catches the one ahead of it in its own lane. Speeds are 60-90 km/h times SPEED_SCALE, like the bikes', so the closing
// speeds keep their proportion. Cars outside the track
// have active=false and are parked far below the ground.

import { SPEED_SCALE } from '../physics/BikePhysics.js';

const MIN_V = 60 * SPEED_SCALE / 3.6, MAX_V = 90 * SPEED_SCALE / 3.6;
const LANE_SHARE = 0.5; // cars drive in the middle of their lane: half of the paved half-width from the centre line (2.5 m on the 5 m road; it was a fixed 2.1 m on the 4.2 m one)
const WRECK_T = 8; // seconds a hit car stays on the road before it is cleared
const HORIZON = 360; // seconds of race time the chains cover
const FLOW_START = 400, ONCOMING_START = 650; // first car in each direction: well clear of the start grid and the opening seconds

/** Car models (names match assets/models/traffic_<type>.glb), size in m, spawn weight. */
export const CAR_TYPES = {
  sedan: { len: 4.6, wid: 1.8, w: 20 }, kei: { len: 3.4, wid: 1.48, w: 10 }, hatch: { len: 4.0, wid: 1.75, w: 15 },
  coupe: { len: 4.5, wid: 1.8, w: 8 }, taxi: { len: 4.8, wid: 1.85, w: 7 }, minivan: { len: 4.8, wid: 1.85, w: 10 },
  suv: { len: 4.7, wid: 1.9, w: 10 }, van: { len: 5.2, wid: 1.95, w: 7 }, truck: { len: 7.5, wid: 2.5, w: 8 },
  bus: { len: 11, wid: 2.5, w: 5 },
};
const TYPE_IDS = Object.keys(CAR_TYPES);
let W_SUM = 0; for (const k of TYPE_IDS) W_SUM += CAR_TYPES[k].w;

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickType(r) {
  let x = r() * W_SUM;
  for (const k of TYPE_IDS) { x -= CAR_TYPES[k].w; if (x <= 0) return k; }
  return 'sedan';
}

const _smp = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
const _loc = { s: 0, d: 0, yaw: 0 };

/**
 * Create the traffic for a track and seed. The result is an array of cars with extra properties `track` and `seed`.
 * Car: {id, type, s, d, dir (+1 with the race, -1 oncoming), speed (m/s magnitude), vs (signed m/s along the track),
 * pos, vel, yaw, len, wid, hit, active, s0, v0}. Roughly one car per 250-400 m each way, 60-90 km/h.
 * @param {object} track built Track
 * @param {number} seed integer seed
 * @returns {object[]} cars (positions valid for t = 0)
 */
export function createTraffic(track, seed) {
  const r = mulberry32((seed | 0) * 2654435761 + (track.seed | 0) * 40503 + 0x7a11);
  const L = track.length;
  const cars = [];
  cars.track = track; cars.seed = seed | 0;
  let id = 0;
  const build = (dir) => {
    const pos = [];
    if (dir > 0) {
      // with the race: only ahead of the pack (none behind the grid, so nothing runs a slow starter down)
      let s = L + 60;
      while (s > FLOW_START) { pos.push(s); s -= 250 + 150 * r(); }
    } else {
      let s = ONCOMING_START + 40 * r();
      const hi = L + HORIZON * MAX_V;
      while (s < hi) { pos.push(s); s += 250 + 150 * r(); }
    }
    const sp = pos.map(() => MIN_V + (MAX_V - MIN_V) * r()).sort((a, b) => b - a);
    for (let k = 0; k < pos.length; k++) {
      const type = pickType(r), def = CAR_TYPES[type];
      const d = -dir * (track.halfWidth * LANE_SHARE + (r() - 0.5) * 0.3);
      cars.push({
        id: id++, type, s: pos[k], d, dir, speed: sp[k], vs: dir * sp[k],
        pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, len: def.len, wid: def.wid,
        hit: false, active: false, s0: pos[k], v0: sp[k], hv: false, spin: 0, hitAge: 0,
      });
    }
  };
  build(1);
  build(-1);
  stepTraffic(cars, 0, 0);
  return cars;
}

function place(track, c, s) {
  const L = track.length;
  c.s = s;
  c.active = s > -30 && s < L + 30;
  if (!c.active) { c.pos.y = -1000; c.vel.x = 0; c.vel.z = 0; return; }
  const sc = s < 0 ? 0 : s > L ? L : s;
  const m = track.sampleAt(sc, _smp);
  const ex = s - sc;
  const lx = m.hz, lz = -m.hx; // left
  c.pos.x = m.x + m.hx * ex + lx * c.d;
  c.pos.z = m.z + m.hz * ex + lz * c.d;
  c.pos.y = m.y - c.d * Math.tan(m.bank);
  let yaw = m.yaw;
  if (c.dir < 0) { yaw += Math.PI; if (yaw > Math.PI) yaw -= 2 * Math.PI; }
  c.yaw = yaw;
  c.vel.x = -Math.sin(yaw) * c.speed; c.vel.y = 0; c.vel.z = -Math.cos(yaw) * c.speed;
}

/**
 * Advance the traffic to race time t. Cars that have not been hit are set from their pure position function;
 * hit cars slide on with decaying velocity (their velocity is initialised from their path if the flag was set elsewhere).
 * @param {object[]} cars array from createTraffic
 * @param {number} t race time in seconds (race.t)
 * @param {number} dt step in seconds (used for hit cars only)
 * @returns {void}
 */
export function stepTraffic(cars, t, dt) {
  const track = cars.track;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.hit) { c.speed = c.v0; c.vs = c.dir * c.v0; place(track, c, c.s0 + c.dir * c.v0 * t); continue; }
    if (!c.hv) { c.hv = true; c.hitAge = 0; }
    if (dt <= 0) continue;
    c.hitAge += dt;
    if (c.hitAge > WRECK_T) { c.active = false; c.pos.y = -1000; c.vel.x = 0; c.vel.z = 0; continue; } // the wreck is towed away
    if (!c.active) continue;
    const sp = Math.hypot(c.vel.x, c.vel.z);
    if (sp > 0.05) {
      const k = Math.max(0, sp - 5 * SPEED_SCALE * dt) / sp;
      c.vel.x *= k; c.vel.z *= k;
    } else { c.vel.x = 0; c.vel.z = 0; }
    c.pos.x += c.vel.x * dt; c.pos.z += c.vel.z * dt;
    c.yaw += c.spin * dt; c.spin *= Math.max(0, 1 - 1.5 * dt);
    c.speed = Math.hypot(c.vel.x, c.vel.z);
    track.toTrack(c.pos.x, c.pos.z, c.s, _loc);
    c.s = _loc.s; c.d = _loc.d;
    c.vs = c.vel.x * -Math.sin(_loc.yaw) + c.vel.z * -Math.cos(_loc.yaw);
    const h = track.heightAt(c.pos.x, c.pos.z);
    c.pos.y = h;
  }
}
