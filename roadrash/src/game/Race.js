// The deterministic race world: 15 riders (humans + AI), traffic, melee, contacts, crashes, places, finish.
// Pure logic, no DOM, no Math.random / Date (a seeded RNG lives in the race). See CONTRACT-2.md.
//
// Authority: 'host' simulates AI riders and traffic; 'guest' treats AI riders as remote (their bikes are written by
// WorldSync), but still steps traffic from race time (a pure function), steps the local human, resolves the local
// human's swings and contacts, and pushes {type:'hit'} events for remote victims.
//
// Events pushed to race.events (the caller drains it, e.g. `race.events.length = 0`, after reading):
//   {type:'go'}  {type:'crash', slot, cause}  {type:'remount', slot}  {type:'finish', slot, place, t}
//   {type:'hit', from, to, hit, id}   a swing that landed on a REMOTE rider (not applied here; send it to its owner; the victim
//                                     also gets rider.hitFx = {t, side, weapon, strength}, a visual-only predicted stagger)
//   {type:'blow', from, to, damage}   a swing that landed on a rider simulated here (already applied)
//   {type:'carhit', id, slot}         a rider hit a traffic car
import { DT, createBike, stepBike, meleeHit, applyHit, contactShare, swingCooldown, WEAPONS, RIVAL_REACH, SPEED_SCALE, ROAD_ASSIST } from '../physics/BikePhysics.js';
import { crashSeverity, createDestruction, spawnRagdoll, spawnDebris, stepDestruction } from '../physics/DestructionSystem.js';
import { createTraffic, stepTraffic } from './Traffic.js';
import { createBrain, rivalInput } from '../ai/RivalAI.js';
import { GRID_SIZE, humanSlotOrder, assignBikes, normalizeBike, computeGrid } from './Roster.js';
import { normalizeDifficulty } from './Difficulty.js';
import { makeCapsule, sweepCapsuleSegment, sweepCapsuleBox, sweepCapsuleCapsule, slideRemainder } from '../physics/CCD.js';
import { toSpline } from '../track/SplineSpace.js';
import { wrapAngle } from '../physics/vec.js';

/** Simulation tick rate (Hz). The game steps the race at SIM_DT; stepRace and stepBike also accept 1/60 (behaviour is step-rate independent). */
export const SIM_HZ = 120;
/** Simulation step in seconds (1 / SIM_HZ). */
export const SIM_DT = 1 / SIM_HZ;
/** Seconds of countdown before the race starts. */
export const COUNTDOWN = 3;
const AI_THINK_DT = 1 / 60; // the AI decides at most this often (effective 60 Hz whatever the tick rate); its controls are held between decisions
const HITFX_T = 0.35; // seconds of predicted (visual only) stagger on a remote victim
const REMOUNT_T = 3;
const GHOST_T = 1.5;
/** A remounting rider restarts this far (m) inside the right-hand edge of the tarmac. */
const REMOUNT_EDGE = 0.9;
const PLACE_EPS = 0.02; // metres: riders closer than this keep their order (the grid order at the start, stable side by side)
const FINISH_GRACE_T = 20;
/**
 * Slipstream: a bike 2.5-16 m behind another one (centres along the road), within DRAFT_HALF_W m sideways, both moving, rides in its wake:
 * strength 0..1 (best close behind and centred, zero at the edges of the zone and once it pulls out alongside), eased over DRAFT_EASE seconds;
 * the bike's boost (acceleration and top speed) is multiplied by 1 + DRAFT_GAIN * draft. Everybody, humans and rivals, the same rule.
 */
export const DRAFT_GAIN = 0.03, DRAFT_EASE = 0.5, DRAFT_NEAR = 2.5, DRAFT_FAR = 16, DRAFT_HALF_W = 1.3;
/** Humans get no catch-up boost during the first HUMAN_BOOST_FROM seconds of racing, then it fades in over HUMAN_BOOST_FADE seconds. */
const HUMAN_BOOST_FROM = 10, HUMAN_BOOST_FADE = 4;
const CAR_MASS = 1300;
const CAR_MU_REF = 295 * CAR_MASS / (295 + CAR_MASS); // reduced mass of a 295 kg bike against a car
const K = SPEED_SCALE; // every speed threshold below is the old number times K: a crash needs the same share of top speed as before
const MAX_EVENTS = 512;

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _zero = { throttle: 0, brake: 1, steer: 0, attack: null, attackSide: 1 };
const _n = { x: 0, y: 0, z: 0 };
const _imp = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _carLike = { vel: { x: 0, y: 0, z: 0 }, spec: { mass: CAR_MASS } };

function makeRider(race, slot, kind, spec, gridPos) {
  const g = race.track.startGrid(gridPos);
  const bike = createBike(spec, g.pos, g.yaw);
  return {
    slot, gridPos, kind, remote: false, bike, brain: null, s: 0, d: 0, progress: 0, lane: 0, yaw: g.yaw, place: gridPos + 1, finished: false, finishT: 0, finishOrder: -1, wrecks: 0,
    input: { throttle: 0, brake: 0, steer: 0, attack: null, attackSide: 1 },
    netInfo: null,
    // internals
    crashT: 0, stuckT: 0, ghost: 0, wasCrashed: false, lastImpulse: { x: 0, y: 0, z: 0 }, lastEnergy: 3000,
    swing: { active: false, t: 0, weapon: null, side: 1, resolved: false, cd: 0 },
    hitFx: null, aiAcc: -1, sx: g.pos.x, sz: g.pos.z, // sx/sz: where this tick's motion started (for the sweeps)
    stepInput: { throttle: 0, brake: 0, steer: 0, attack: null, attackSide: 1 },
  };
}

/**
 * Create a race.
 * @param {{track:object, seed?:number, gridPos?:number[], difficulty?:string, humans?:number, localSlots?:number[], humanSlots?:number[], authority?:'host'|'guest', humanSpec?:string, humanBikes?:Object<number,string>, bikeSeed?:number, specs?:string[]}} opts
 *   humans: number of human riders (1..15), placed in slots 0, 14, 13, ... unless humanSlots is given;
 *   localSlots: slots simulated on this device (default [0]); other humans are remote;
 *   gridPos: optional array slot -> start grid position (0 = pole); default computeGrid: AI in front, humans at the back (host last);
 *   difficulty: 'easy' | 'medium' | 'hard' (default medium), the AI level;
 *   bikes: humanSpec is the default type of the humans, humanBikes {slot: type} overrides it per human; the AI riders are spread evenly over the
 *   three types by Roster.assignBikes(bikeSeed, default: the race seed); `specs` (15 type ids by slot) overrides all of it.
 * @returns {object} Race {track, t, tick, phase, countdown, riders[15], traffic, destruction, events, authority, rng, stats, ...}
 */
export function createRace(opts) {
  const track = opts.track;
  const seed = opts.seed | 0;
  const humans = Math.max(1, Math.min(GRID_SIZE, Math.floor(opts.humans || 1)));
  const race = {
    track, seed, difficulty: normalizeDifficulty(opts.difficulty), t: 0, tick: 0, phase: 'grid', countdown: COUNTDOWN, goT: COUNTDOWN,
    authority: opts.authority === 'guest' ? 'guest' : 'host',
    rng: mulberry32(seed ^ 0x5eed), humanSpec: opts.humanSpec || 'street', catchUp: opts.catchUp !== false, assist: opts.assist !== false,
    riders: [], traffic: createTraffic(track, seed),
    destruction: createDestruction({ maxDebris: 96, maxRagdolls: 12, seed: seed ^ 0xd35 }),
    events: [], appliedHits: new Set(), _appliedRing: [], localSlots: (opts.localSlots || [0]).slice(), humanSlots: [], leaderS: NaN,
    finishedCount: 0, winnerAbsT: -1, hitSeq: 0,
    stats: { crashes: 0, carCrashesOncoming: 0, carCrashesFlow: 0, riderCrashes: 0, aiCrashes: 0, aiCarCrashesOncoming: 0 },
    _ctx: { track, s: 0, d: 0, yaw: 0, cars: null, racing: false, raceT: 0, leaderS: NaN },
    _order: [], _loc: { s: 0, d: 0, yaw: 0 },
  };
  race._ctx.cars = race.traffic;
  const hs = opts.humanSlots || humanSlotOrder(humans);
  const grid = Array.isArray(opts.gridPos) && opts.gridPos.length === GRID_SIZE ? opts.gridPos.slice() : computeGrid({ humanSlots: hs });
  race.gridPos = grid;
  const hb = {};
  for (const sl of hs) hb[sl] = normalizeBike((opts.humanBikes && opts.humanBikes[sl]) || race.humanSpec);
  const specs = Array.isArray(opts.specs) && opts.specs.length === GRID_SIZE ? opts.specs.map(normalizeBike) : assignBikes({ humanBikes: hb, seed: opts.bikeSeed != null ? opts.bikeSeed : seed });
  race.specs = specs;
  for (let slot = 0; slot < GRID_SIZE; slot++) {
    const human = hs.indexOf(slot) >= 0;
    race.riders.push(makeRider(race, slot, human ? 'human' : 'ai', specs[slot], grid[slot]));
  }
  race._order = race.riders.slice().sort((a, b) => a.gridPos - b.gridPos); // places at the start = grid order
  const remoteSlots = hs.filter((x) => race.localSlots.indexOf(x) < 0);
  setHumans(race, hs, remoteSlots);
  for (const r of race.riders) locate(race, r);
  return race;
}

/**
 * Re-assign which slots are humans. Humans joining take the AI's bikes as they are; slots leaving humanity become AI
 * again (a fresh brain, riding on from the bike's current state).
 * @param {object} race
 * @param {number[]} humanSlots slots of all humans (local and remote)
 * @param {number[]} remoteSlots the humans simulated on other devices
 * @returns {void}
 */
export function setHumans(race, humanSlots, remoteSlots) {
  race.humanSlots = humanSlots.slice();
  const guest = race.authority === 'guest';
  for (const r of race.riders) {
    const human = humanSlots.indexOf(r.slot) >= 0;
    if (human) { r.kind = 'human'; r.brain = null; r.remote = remoteSlots.indexOf(r.slot) >= 0; }
    else {
      r.kind = 'ai'; r.remote = guest;
      if (!r.brain) r.brain = createBrain(r.slot, race.seed, race.difficulty);
      r.brain.done = r.finished;
    }
  }
}

/**
 * Apply a hit received from the network to a rider simulated on this device.
 * @param {object} race
 * @param {number} toSlot victim slot
 * @param {{damage:number,impulse:{x:number,y:number,z:number},stagger:number}} hit meleeHit result
 * @param {number} [id] the hit id of the 'hit' event (hit.id is used when absent). A hit id that was already applied is ignored, so a
 *   packet delivered twice (retransmit, mesh relay) lands once.
 * @returns {boolean} true when applied (false: unknown slot, the victim is remote here, or a duplicate id)
 */
export function applyRemoteHit(race, toSlot, hit, id) {
  const v = race.riders[toSlot];
  if (!v || v.remote || !hit) return false;
  const hid = id !== undefined ? id : hit.id;
  if (hid !== undefined && hid !== null) {
    if (race.appliedHits.has(hid)) return false;
    race.appliedHits.add(hid); race._appliedRing.push(hid);
    if (race._appliedRing.length > 256) race.appliedHits.delete(race._appliedRing.shift());
  }
  v.hitFx = null;
  applyHit(v.bike, hit);
  v.lastImpulse.x = hit.impulse.x; v.lastImpulse.y = hit.impulse.y; v.lastImpulse.z = hit.impulse.z;
  v.lastEnergy = 4000;
  pushEvent(race, { type: 'blow', from: -1, to: toSlot, damage: hit.damage });
  return true;
}

function pushEvent(race, e) {
  const ev = race.events;
  if (ev.length >= MAX_EVENTS) ev.splice(0, MAX_EVENTS >> 1);
  ev.push(e);
}

const _sp = { progress: 0, lane: 0, s: 0, yaw: 0 };
function locate(race, r) {
  const sp = toSpline(race.track, r.bike.pos.x, r.bike.pos.z, r.s / race.track.length, _sp);
  r.s = sp.s; r.d = sp.lane; r.yaw = sp.yaw; r.progress = sp.progress; r.lane = sp.lane;
}

/** Put a crashed rider back on the road at the track centre, standing still, facing along the track. */
function remount(race, r, ahead = 0) {
  const b = r.bike, tr = race.track;
  const m = tr.sampleAt(Math.min(r.s + ahead, tr.length - 5), _sm);
  // back on the bike at the right-hand edge of the road (not the middle), out of the way of the pack and the traffic;
  // the rider is also a ghost for GHOST_T seconds
  const dEdge = -(tr.halfWidth - REMOUNT_EDGE);
  b.pos.x = m.x + m.hz * dEdge; b.pos.z = m.z - m.hx * dEdge; b.pos.y = tr.heightAt(b.pos.x, b.pos.z); b.offBal = 0;
  b.vel.x = 0; b.vel.y = 0; b.vel.z = 0; b.speed = 0; b.yaw = m.yaw; b.yawRate = 0; b.yawKick = 0;
  b.lean = 0; b.leanRate = 0; b.pitch = 0; b.slip = 0; b.drifting = false; b.latVel = 0; b.stagger = 0;
  b.airborne = false; b.crashed = false; b.wInit = false; b.accel = 0; b.rebound = 1; b.reboundV = 0.9 * b.spec.topSpeed;
  b.health = Math.max(b.health, 0.55 * b.spec.health);
  r.crashT = 0; r.wasCrashed = false; r.ghost = GHOST_T; r.swing.active = false; r.swing.cd = 0.5;
  pushEvent(race, { type: 'remount', slot: r.slot });
}
const _sm = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };

/** Crash a rider now: ragdoll + debris + event. Sets bike.crashed. */
function crashRider(race, r, cause) {
  const b = r.bike;
  if (r.wasCrashed) return;
  if (r.finished && !r.remote) { b.crashed = false; return; } // past the line: no more crashes, just shoves
  b.crashed = true; r.wasCrashed = true; r.crashT = 0; r.wrecks++;
  const sp = Math.abs(b.speed);
  const e = Math.max(1500, 0.5 * b.spec.mass * (sp / K) * (sp / K) * 0.3, r.lastEnergy); // debris energy in the old units (sp / K): the same wreck as before
  spawnRagdoll(race.destruction, b, r.lastImpulse);
  _dir.x = b.vel.x + r.lastImpulse.x / b.spec.mass; _dir.y = 0.2; _dir.z = b.vel.z + r.lastImpulse.z / b.spec.mass;
  spawnDebris(race.destruction, b, _dir, e);
  r.lastImpulse.x = 0; r.lastImpulse.y = 0; r.lastImpulse.z = 0; r.lastEnergy = 3000;
  race.stats.crashes++;
  if (r.kind === 'ai') race.stats.aiCrashes++;
  r.swing.active = false;
  pushEvent(race, { type: 'crash', slot: r.slot, cause });
}

function resolveSwing(race, r) {
  const sw = r.swing;
  // a human's swing is forgiving: the wider reach and arc of meleeHit, and if nobody is in reach on the chosen side the other side is tried
  // (auto-side). The AI riders judge by the old geometry on the chosen side only.
  const human = r.kind !== 'ai';
  if (swingAt(race, r, sw.side, human)) return;
  if (human) swingAt(race, r, -sw.side, true);
}

function swingAt(race, r, side, forgiving) {
  const sw = r.swing;
  const att = r.bike;
  for (let i = 0; i < race.riders.length; i++) {
    const v = race.riders[i];
    if (v === r || v.bike.crashed) continue;
    const dx = v.bike.pos.x - att.pos.x, dz = v.bike.pos.z - att.pos.z;
    if (dx * dx + dz * dz > 25) continue;
    const h = meleeHit(att, v.bike, sw.weapon, side, forgiving || (r.brain && v.kind !== 'ai' ? RIVAL_REACH : false)); // (a rival swings at a human with a longer reach, on its own arc: a rider that has moved aside is still within it)
    if (!h) continue;
    if (r.kind === 'ai' && v.kind === 'ai') { // rivals pull their punches against each other so the field does not wreck itself
      h.damage *= 0.5; h.stagger *= 0.5; h.impulse.x *= 0.35; h.impulse.y *= 0.35; h.impulse.z *= 0.35;
      if (h.shove) { h.shove.x *= 0.7; h.shove.z *= 0.7; } // (a wheel kick between rivals keeps most of its shove: it is the way to put a rider onto the shoulder or into traffic; blows and damage stay softened)
    }
    if (v.remote) {
      pushEvent(race, { type: 'hit', from: r.slot, to: v.slot, hit: h, id: ((++race.hitSeq) << 8) | (r.slot << 4) | v.slot });
      // favour the attacker: show the blow at once on the remote victim (visual only; the owner's authoritative state follows)
      const vc = Math.cos(v.bike.yaw), vs = Math.sin(v.bike.yaw);
      const dvL = h.impulse.x * -vc + h.impulse.z * vs; // push along the victim's left
      const J = Math.hypot(h.impulse.x, h.impulse.z);
      v.hitFx = { t: HITFX_T, side: dvL > 0 ? -1 : 1, weapon: sw.weapon, strength: Math.min(1, J / 1000) };
    } else {
      applyHit(v.bike, h);
      v.lastImpulse.x = h.impulse.x; v.lastImpulse.y = h.impulse.y; v.lastImpulse.z = h.impulse.z;
      v.lastEnergy = 2500 + h.damage * 100;
      pushEvent(race, { type: 'blow', from: r.slot, to: v.slot, damage: h.damage });
    }
    return true;
  }
  return false;
}

function stepSwing(race, r, dt) {
  const sw = r.swing, inp = r.input;
  if (sw.cd > 0) sw.cd -= dt;
  if (!sw.active) {
    if (inp.attack && WEAPONS[inp.attack] && sw.cd <= 0 && !r.bike.crashed && race.phase === 'racing') {
      sw.active = true; sw.t = 0; sw.weapon = inp.attack; sw.side = inp.attackSide < 0 ? -1 : 1; sw.resolved = false;
    }
  } else {
    sw.t += dt;
    const w = WEAPONS[sw.weapon];
    const wu = w.windup * r.bike.spec.windupMul;
    if (!sw.resolved && sw.t >= wu) { sw.resolved = true; if (!r.bike.crashed) resolveSwing(race, r); }
    if (sw.t >= wu + 0.2) { sw.active = false; sw.cd = swingCooldown(r.bike.spec, sw.weapon); }
  }
  inp.attack = sw.active ? sw.weapon : null;
  inp.attackSide = sw.side;
}

let _touched = false; // set by bikeContacts / carContacts when the discrete boxes overlapped (a contact was resolved)
let _cnx = 0, _cnz = 0; // the contact normal they used (toward the first rider / the bike)

function pushOut(r, nx, nz, amt) { r.bike.pos.x += nx * amt; r.bike.pos.z += nz * amt; }

function bikeContacts(race, a, b, dt) {
  const A = a.bike, B = b.bike;
  const dx = B.pos.x - A.pos.x, dz = B.pos.z - A.pos.z;
  if (dx * dx + dz * dz > 9) return;
  const cy = Math.cos(A.yaw), sy = Math.sin(A.yaw);
  const fx = -sy, fz = -cy, lx = -cy, lz = sy;
  const f = dx * fx + dz * fz, l = dx * lx + dz * lz;
  const af = f < 0 ? -f : f, al = l < 0 ? -l : l;
  const pf = 1.8 - af, pl = 0.75 - al;
  if (pf <= 0 || pl <= 0) return;
  _touched = true;
  const side = pl / 0.75 < pf / 1.8;
  // normal pointing from B toward A
  let nx, nz, pen;
  if (side) { const sg = l >= 0 ? -1 : 1; nx = lx * sg; nz = lz * sg; pen = pl; }
  else { const sg = f >= 0 ? -1 : 1; nx = fx * sg; nz = fz * sg; pen = pf; }
  _cnx = nx; _cnz = nz;
  const aLoc = !a.remote, bLoc = !b.remote;
  if (aLoc && bLoc) { pushOut(a, nx, nz, pen * 0.5); pushOut(b, -nx, -nz, pen * 0.5); }
  else if (aLoc) pushOut(a, nx, nz, pen);
  else if (bLoc) pushOut(b, -nx, -nz, pen);
  // closing speed along the normal (n points toward A)
  const rvx = A.vel.x - B.vel.x, rvz = A.vel.z - B.vel.z;
  const closing = -(rvx * nx + rvz * nz);
  if (closing <= 0.3 * K) return;
  _n.x = nx; _n.y = 0; _n.z = nz;
  const sevA = crashSeverity(A, B, _n, K);
  if (side) {
    // sideswipe: shove apart sideways
    const k = Math.min(1.5, closing * 0.4 / K); // the sideways shove is geometric: the same for the same share of top speed
    // the lighter bike takes the bigger shove (contactShare), and a bike's stagger resistance applies to the wobble too
    if (aLoc) { A.latVel += k * (nx * lx + nz * lz) * 0.5 * contactShare(A.spec.mass, B.spec.mass); A.stagger = Math.max(A.stagger, 0.1 * A.spec.staggerMul); }
    if (bLoc) { const bl = Math.cos(B.yaw), bs = Math.sin(B.yaw); B.latVel -= k * (nx * -bl + nz * bs) * 0.5 * contactShare(B.spec.mass, A.spec.mass); B.stagger = Math.max(B.stagger, 0.1 * B.spec.staggerMul); }
  }
  // Bike-to-bike contact never wipes a rider out by itself (as in the original game): it costs speed and control.
  // Wipeouts come from cars, the wall and running out of health; a wobbling rider is easy prey for all three.
  const hard = sevA.outcome === 'crash' && closing > 5 * K;
  if (side) {
    if (hard) { // a hard side-swipe: a long wobble for both
      if (aLoc && a.ghost <= 0) A.stagger = Math.max(A.stagger, 0.6 * A.spec.staggerMul);
      if (bLoc && b.ghost <= 0) B.stagger = Math.max(B.stagger, 0.6 * B.spec.staggerMul);
    }
  } else if (sevA.outcome !== 'none' || closing > 2 * K) {
    // rear touch: the faster rider loses most of the speed difference and wobbles, the one in front gets a small push
    const slow = a.bike.speed < b.bike.speed ? a : b;
    const fast = slow === a ? b : a;
    if (!fast.remote) { fast.bike.speed = Math.max(0, fast.bike.speed - closing * (hard ? 0.75 : 0.4)); fast.bike.stagger = Math.max(fast.bike.stagger, hard ? 0.5 : 0.25); }
    if (!slow.remote) { slow.bike.speed += Math.min(closing * 0.15, 3 * K); slow.bike.stagger = Math.max(slow.bike.stagger, hard ? 0.25 : 0.15); }
  }
}

function carContacts(race, r, c) {
  const b = r.bike;
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
  const fx = -sy, fz = -cy, lx = -cy, lz = sy;
  const dx = b.pos.x - c.pos.x, dz = b.pos.z - c.pos.z;
  const f = dx * fx + dz * fz, l = dx * lx + dz * lz;
  const hl = c.len * 0.5 + 1.0, hwid = c.wid * 0.5 + 0.4;
  const af = f < 0 ? -f : f, al = l < 0 ? -l : l;
  const pf = hl - af, pl = hwid - al;
  if (pf <= 0 || pl <= 0) return;
  _touched = true;
  let nx, nz, pen;
  if (pl / hwid < pf / hl) { const sg = l >= 0 ? 1 : -1; nx = lx * sg; nz = lz * sg; pen = pl; }
  else { const sg = f >= 0 ? 1 : -1; nx = fx * sg; nz = fz * sg; pen = pf; }
  b.pos.x += nx * pen; b.pos.z += nz * pen;
  _cnx = nx; _cnz = nz;
  const rvx = b.vel.x - c.vel.x, rvz = b.vel.z - c.vel.z;
  const closing = -(rvx * nx + rvz * nz);
  if (closing <= 0.2 * K) return;
  _n.x = nx; _n.y = 0; _n.z = nz;
  _carLike.vel.x = c.vel.x; _carLike.vel.z = c.vel.z;
  // a crash against a car is judged on the speed alone: the heavier bike carries more energy but is just as sturdy, so the reduced-mass term is divided out
  // (it used to make the cruiser wipe out the most and the sport the least against the same traffic, a difference a player felt as a slower bike)
  const mb0 = b.spec.mass, muB = mb0 * CAR_MASS / (mb0 + CAR_MASS);
  const sev = crashSeverity(b, _carLike, _n, K * Math.sqrt(muB / CAR_MU_REF) * (b.spec.carSturdy || 1));
  const oncoming = c.dir < 0 && !c.hit;
  if (!c.hit) {
    c.hit = true; c.hv = true;
    const mb = b.spec.mass;
    c.vel.x -= nx * closing * mb / (mb + CAR_MASS); c.vel.z -= nz * closing * mb / (mb + CAR_MASS);
    c.spin = (race.rng() - 0.5) * Math.min(3, closing * 0.12) + (nx * lx + nz * lz) * 0.02 * closing;
    pushEvent(race, { type: 'carhit', id: c.id, slot: r.slot });
  }
  if (sev.outcome === 'crash' && r.ghost <= 0) {
    const mb = b.spec.mass;
    r.lastImpulse.x = -nx * mb * closing * 0.12 + b.vel.x * 0; r.lastImpulse.z = -nz * mb * closing * 0.12;
    r.lastImpulse.y = mb * Math.min(closing, 40) * 0.12;
    r.lastEnergy = sev.energy;
    crashRider(race, r, oncoming ? 'oncoming' : 'car');
    if (b.crashed) {
      if (oncoming) { race.stats.carCrashesOncoming++; if (r.kind === 'ai') race.stats.aiCarCrashesOncoming++; } else race.stats.carCrashesFlow++;
      b.speed *= 0.35;
    }
  } else {
    b.speed = Math.max(0, b.speed - closing * (sev.outcome === 'wobble' ? 0.7 : 0.5));
    if (sev.outcome === 'wobble') b.stagger = Math.max(b.stagger, 0.4);
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// Continuous collision detection. stepBike moves a bike a whole tick (up to ~1.4 m at 300 km/h and 60 Hz, 2.3 m closing on an
// oncoming car); the discrete box tests below would let such a step jump over a wall, a car or another bike. So every locally
// simulated bike sweeps its tick motion (sx,sz -> pos) as a capsule against the outer walls, the traffic boxes and the other bikes,
// finds the earliest time of impact, is put back to that moment, the existing shove/crash rules run, and it then moves on for the
// remaining time (sliding along what it hit). The discrete tests still run afterwards as the resting-overlap safety net.
// ---------------------------------------------------------------------------------------------------------------------
const WALL_OFFSET = 6.5; // wall centre line beyond the paved edge + shoulder (its inner face is 0.1 m nearer: where the old clamp sat)
const WALL_HALF = 0.1; // 0.2 m thick
const WALL_CRASH_ANGLE = 0.35; // rad (20 degrees): a wall impact shallower than this never crashes
const WALL_CRASH_VN = 8 * K; // m/s into the wall that a steep impact needs to crash
const WALL_CRASH_VN_MAX = 20 * K; // m/s into the wall that crashes at any angle
const BIKE_H = 0.525, BIKE_R = 0.375; // bike capsule for bike-vs-bike: reaches 0.9 m ahead/behind, 0.375 m aside (the 1.8 x 0.75 contact box pair)
const CAR_H = 0.6, CAR_R = 0.4; // bike capsule for bike-vs-car: 1.0 m ahead/behind, 0.4 m aside (the inflated car box margins)
const SKIN = 0.01;
const _cA = { x: 0, z: 0, ux: 0, uz: -1, h: 0, r: 0 };
const _cB = { x: 0, z: 0, ux: 0, uz: -1, h: 0, r: 0 };
const _box = { x: 0, z: 0, yaw: 0, hl: 0, hw: 0 };
const _hit = { t: 0, nx: 0, nz: 0, px: 0, pz: 0 };
const _best = { t: 0, nx: 0, nz: 0 };
const _slide = { x: 0, z: 0 };
const _bv = { x: 0, z: 0 };

/** Planar velocity of a bike from its speed, yaw, slip and lateral kick (the same relation stepBike uses). */
function bikeVel(b, o) {
  const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw);
  const vlat = -b.speed * Math.tan(b.slip) + b.latVel;
  o.x = -sy * b.speed - cy * vlat; o.z = -cy * b.speed + sy * vlat;
  return o;
}

/** Continue a rider after an impact at time t: keep its pose, move on for the remaining (1 - t) along its (possibly changed) velocity, sliding on the contact. */
function continueRider(r, t, nx, nz, odx, odz, dt) {
  const b = r.bike;
  bikeVel(b, _bv);
  b.vel.x = _bv.x; b.vel.z = _bv.z;
  if (t >= 0.9999) { r.sx = b.pos.x; r.sz = b.pos.z; return; }
  // relative motion for the slide (the obstacle keeps moving with odx, odz over the whole step)
  slideRemainder(_bv.x * dt - odx, _bv.z * dt - odz, t, nx, nz, _slide);
  const rx = _slide.x + odx * (1 - t), rz = _slide.z + odz * (1 - t);
  const ex = b.pos.x + rx, ez = b.pos.z + rz;
  // keep a straight-line description of the whole step: at time t the rider is at its impact pose, at 1 at the end
  const k = t / (1 - t);
  r.sx = b.pos.x - rx * k; r.sz = b.pos.z - rz * k;
  b.pos.x = ex; b.pos.z = ez;
}

/** Wall CCD for one rider: the earliest hit on the outer wall on its side, into _best. Returns the time or 2. */
function ccdWall(race, a, adx, adz) {
  const tr = race.track, e = tr.edges, A = a.bike;
  const edge = tr.halfWidth + tr.shoulder, off = edge + WALL_OFFSET;
  const sg = a.d >= 0 ? 1 : -1;
  const sweep = Math.sqrt(adx * adx + adz * adz);
  if ((a.d < 0 ? -a.d : a.d) + sweep + 2.5 < off) return 2;
  const j = Math.floor(a.s / e.step);
  makeCapsule(a.sx, a.sz, A.yaw, CAR_H, CAR_R, _cA);
  let bt = 2;
  for (let k = j - 1; k <= j + 2; k++) {
    if (k < 0 || k + 1 >= e.n) continue;
    const ax = e.cx[k] + e.lx[k] * sg * off, az = e.cz[k] + e.lz[k] * sg * off;
    const bx = e.cx[k + 1] + e.lx[k + 1] * sg * off, bz = e.cz[k + 1] + e.lz[k + 1] * sg * off;
    if (sweepCapsuleSegment(_cA, adx, adz, ax, az, bx, bz, WALL_HALF, _hit) && _hit.t < bt) { bt = _hit.t; _best.t = bt; _best.nx = _hit.nx; _best.nz = _hit.nz; }
  }
  return bt;
}

/**
 * A rider meets the outer wall: scrub speed and deflect along it. A shallow touch (under ~20 degrees) or a gentle one never crashes; only a
 * steep AND fast impact does (steeper than 20 degrees with more than 8 m/s into the wall), or an extreme one (over 20 m/s into it).
 * The bike is turned part of the way along the wall (yawKick), and loses speed in proportion to what it hit with.
 * nx, nz: the wall normal toward the bike. Returns true if it crashed.
 */
function wallTouch(race, r, nx, nz, dt) {
  const A = r.bike;
  _n.x = nx; _n.y = 0; _n.z = nz;
  const vo = -(A.vel.x * nx + A.vel.z * nz); // speed into the wall
  if (!(vo > 0)) return false;
  const sp = Math.sqrt(A.vel.x * A.vel.x + A.vel.z * A.vel.z) || 1;
  const ang = Math.asin(Math.min(1, vo / sp));
  const sev = crashSeverity(A, null, _n, K);
  const bad = sev.outcome === 'crash' && ((ang > WALL_CRASH_ANGLE && vo > WALL_CRASH_VN) || vo > WALL_CRASH_VN_MAX);
  A.latVel = 0;
  A.speed = Math.max(0, A.speed * (1 - 1.5 * dt) - 0.35 * vo); // the scrape: some speed goes in proportion to what it hit with
  if (bad && r.ghost <= 0 && !A.crashed && !r.remote) { r.lastEnergy = sev.energy; crashRider(race, r, 'wall'); return true; }
  // deflect along the wall: the nose is turned most of the way round (the side is the one that moves it away: left vector . normal), so the
  // next ticks slide along the wall instead of pressing into it again
  const lx = -Math.cos(A.yaw), lz = Math.sin(A.yaw);
  const sg = lx * nx + lz * nz >= 0 ? 1 : -1;
  A.yaw = wrapAngle(A.yaw + sg * 0.85 * ang);
  A.yawRate = 0; A.yawKick = 0;
  A.leanRate -= sg * Math.min(1, 0.5 * ang); // the wobble of a scrape
  return false;
}

function resolveWall(race, a, adx, adz, dt) {
  const A = a.bike, t = _best.t, nx = _best.nx, nz = _best.nz;
  A.pos.x = a.sx + adx * t + nx * SKIN; A.pos.z = a.sz + adz * t + nz * SKIN;
  wallTouch(race, a, nx, nz, dt);
  continueRider(a, t, nx, nz, 0, 0, dt);
}

function ccdCar(race, a, c, adx, adz, dt) {
  const A = a.bike;
  const cdx = c.vel.x * dt, cdz = c.vel.z * dt;
  _box.x = c.pos.x - cdx; _box.z = c.pos.z - cdz; _box.yaw = c.yaw; _box.hl = c.len * 0.5; _box.hw = c.wid * 0.5;
  makeCapsule(a.sx, a.sz, A.yaw, CAR_H, CAR_R, _cA);
  if (!sweepCapsuleBox(_cA, adx, adz, _box, cdx, cdz, _hit)) return 2;
  _best.t = _hit.t; _best.nx = _hit.nx; _best.nz = _hit.nz;
  return _hit.t;
}

function resolveCar(race, a, c, adx, adz, dt) {
  const A = a.bike, t = _best.t, nx = _best.nx, nz = _best.nz;
  const cdx = c.vel.x * dt, cdz = c.vel.z * dt;
  const cex = c.pos.x, cez = c.pos.z;
  A.pos.x = a.sx + adx * t - nx * SKIN; A.pos.z = a.sz + adz * t - nz * SKIN; // a hair into the car so the contact box test sees it
  c.pos.x = cex - cdx * (1 - t); c.pos.z = cez - cdz * (1 - t); // the car at the moment of impact
  _touched = false;
  carContacts(race, a, c);
  c.pos.x = cex; c.pos.z = cez;
  if (!_touched) { A.pos.x = a.sx + adx; A.pos.z = a.sz + adz; return false; } // a graze past a rounded corner: not a contact
  continueRider(a, t, _cnx, _cnz, cdx, cdz, dt); // slide along the face the contact test resolved against
  return true;
}

function ccdBike(race, a, b, adx, adz, bdx, bdz) {
  const A = a.bike, B = b.bike;
  makeCapsule(a.sx, a.sz, A.yaw, BIKE_H, BIKE_R, _cA);
  makeCapsule(b.sx, b.sz, B.yaw, BIKE_H, BIKE_R, _cB);
  if (!sweepCapsuleCapsule(_cA, adx, adz, _cB, bdx, bdz, _hit)) return 2;
  _best.t = _hit.t; _best.nx = _hit.nx; _best.nz = _hit.nz;
  return _hit.t;
}

function resolveBike(race, a, b, adx, adz, bdx, bdz, dt) {
  const A = a.bike, B = b.bike, t = _best.t, nx = _best.nx, nz = _best.nz; // n: from b toward a
  const bex = B.pos.x, bez = B.pos.z;
  A.pos.x = a.sx + adx * t - nx * SKIN; A.pos.z = a.sz + adz * t - nz * SKIN;
  B.pos.x = b.sx + bdx * t + nx * SKIN; B.pos.z = b.sz + bdz * t + nz * SKIN;
  _touched = false;
  bikeContacts(race, a, b, dt);
  if (!_touched) { A.pos.x = a.sx + adx; A.pos.z = a.sz + adz; B.pos.x = bex; B.pos.z = bez; return false; }
  const cx = _cnx, cz = _cnz;
  continueRider(a, t, cx, cz, bdx, bdz, dt);
  if (!b.remote) continueRider(b, t, -cx, -cz, 0, 0, dt);
  else { B.pos.x = bex; B.pos.z = bez; }
  return true;
}

/** Sweep one local rider through the whole tick: walls, cars and bikes, earliest impact first (at most 3 impacts per tick). */
function ccdRider(race, a, dt) {
  const A = a.bike, riders = race.riders, cars = race.traffic;
  for (let it = 0; it < 3; it++) {
    if (A.crashed) return;
    const adx = A.pos.x - a.sx, adz = A.pos.z - a.sz;
    let bt = 2, kind = -1, who = null;
    if (!(a.finished && a.kind === 'ai' && a.s >= race.track.length - 1)) {
      const tw = ccdWall(race, a, adx, adz);
      if (tw < bt) { bt = tw; kind = 0; }
    }
    // keep the wall impact data while the other candidates overwrite _best: store the wall result locally
    const wt = _best.t, wnx = _best.nx, wnz = _best.nz;
    let ct = 2, cnx = 0, cnz = 0, car = null;
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k];
      if (!c.active) continue;
      const ds = c.s - a.s;
      if (ds > 14 || ds < -14) continue;
      const rdx = adx - c.vel.x * dt, rdz = adz - c.vel.z * dt;
      const reach = Math.sqrt(rdx * rdx + rdz * rdz) + Math.sqrt(c.len * c.len + c.wid * c.wid) * 0.5 + 1.2;
      const ex = c.pos.x - c.vel.x * dt - a.sx, ez = c.pos.z - c.vel.z * dt - a.sz;
      if (ex * ex + ez * ez > reach * reach) continue;
      const t = ccdCar(race, a, c, adx, adz, dt);
      if (t < ct) { ct = t; cnx = _best.nx; cnz = _best.nz; car = c; }
    }
    let bkt = 2, bnx = 0, bnz = 0, other = null, odx = 0, odz = 0;
    for (let j = 0; j < riders.length; j++) {
      const o = riders[j];
      if (o === a || o.bike.crashed) continue;
      const ds = o.s - a.s;
      if (ds > 12 || ds < -12) continue;
      const ddx = o.bike.pos.x - o.sx, ddz = o.bike.pos.z - o.sz;
      const rdx = adx - ddx, rdz = adz - ddz;
      const reach = Math.sqrt(rdx * rdx + rdz * rdz) + 2 * (BIKE_H + BIKE_R) + 0.2;
      const ex = o.sx - a.sx, ez = o.sz - a.sz;
      if (ex * ex + ez * ez > reach * reach) continue;
      const t = ccdBike(race, a, o, adx, adz, ddx, ddz);
      if (t < bkt) { bkt = t; bnx = _best.nx; bnz = _best.nz; other = o; odx = ddx; odz = ddz; }
    }
    // earliest of the three
    let tt = 2;
    if (bt < 2 && bt <= ct && bt <= bkt) { tt = bt; kind = 0; _best.t = wt; _best.nx = wnx; _best.nz = wnz; }
    else if (ct < 2 && ct <= bkt) { tt = ct; kind = 1; _best.t = ct; _best.nx = cnx; _best.nz = cnz; who = car; }
    else if (bkt < 2) { tt = bkt; kind = 2; _best.t = bkt; _best.nx = bnx; _best.nz = bnz; who = other; }
    if (tt >= 2) return;
    if (kind === 0) resolveWall(race, a, adx, adz, dt);
    else if (kind === 1) { if (!resolveCar(race, a, who, adx, adz, dt)) return; }
    else if (!resolveBike(race, a, who, adx, adz, odx, odz, dt)) return;
  }
}

function edges(race, r, dt) {
  const tr = race.track, b = r.bike;
  const ad = r.d < 0 ? -r.d : r.d;
  const edge = tr.halfWidth + tr.shoulder;
  if (ad <= edge) return;
  if (!b.crashed && b.speed > 0) { b.speed -= (0.22 * b.speed + 0.2 * K * (ad - edge)) * dt; if (b.speed < 0) b.speed = 0; }
  const wall = edge + 6;
  if (ad > wall) {
    const sg = r.d >= 0 ? 1 : -1;
    const cy = Math.cos(r.yaw), sy = Math.sin(r.yaw);
    const lx = -cy, lz = sy; // track left at this s
    const ex = ad - wall;
    b.pos.x -= lx * sg * ex; b.pos.z -= lz * sg * ex;
    // remove the outward velocity component
    const vo = b.vel.x * lx * sg + b.vel.z * lz * sg;
    if (vo > 0) {
      wallTouch(race, r, -lx * sg, -lz * sg, dt); // reads the velocity into the wall, scrubs and deflects (or crashes)
      b.vel.x -= lx * sg * vo; b.vel.z -= lz * sg * vo; // and the outward velocity component goes
    }
    r.d = sg * wall;
  }
}

/**
 * Catch-up boost by live place (a factor on acceleration and top speed; the speedometer divides it out again).
 * The leader is held back a little, places 2 to the middle of the field are untouched, and from the 9th of 15 down
 * the boost grows with every place to +15 % for the last rider. Scales to smaller fields by share of the field.
 */
export const CATCH_UP = { leader: 0.96, from: 8 / 14, first: 1.05, last: 1.15 };
export function catchUpBoost(place, total) {
  if (!(place > 0) || !(total > 1)) return 1;
  if (place === 1) return CATCH_UP.leader;
  const f = (place - 1) / (total - 1);
  if (f < CATCH_UP.from - 1e-9) return 1;
  return CATCH_UP.first + (CATCH_UP.last - CATCH_UP.first) * (f - CATCH_UP.from) / (1 - CATCH_UP.from);
}
function draftWanted(race, r) {
  const b = r.bike;
  if (b.crashed || b.speed < 0.3 * b.spec.topSpeed) return 0;
  const riders = race.riders;
  let best = 0;
  for (let i = 0; i < riders.length; i++) {
    const o = riders[i];
    if (o === r || o.bike.crashed || o.finished || o.bike.speed < 0.3 * o.bike.spec.topSpeed) continue;
    const gap = o.s - r.s;
    if (gap < DRAFT_NEAR || gap > DRAFT_FAR) continue;
    const lat = o.d - r.d, al = lat < 0 ? -lat : lat;
    if (al >= DRAFT_HALF_W) continue;
    const fl = 1 - (gap - DRAFT_NEAR) / (DRAFT_FAR - DRAFT_NEAR), fw = 1 - al / DRAFT_HALF_W;
    const w = fl * (2 - fl) * fw * (2 - fw); // plateau-ish near the maximum, zero at the edges
    if (w > best) best = w;
  }
  return best;
}
function clampC(x, a, b) { return x < a ? a : x > b ? b : x; }
function updatePlaces(race) {
  const ord = race._order;
  // insertion sort: finished first by finish order, then by s descending
  for (let i = 1; i < ord.length; i++) {
    const x = ord[i];
    let j = i - 1;
    while (j >= 0 && before(x, ord[j])) { ord[j + 1] = ord[j]; j--; }
    ord[j + 1] = x;
  }
  for (let i = 0; i < ord.length; i++) ord[i].place = i + 1;
}
function before(a, b) {
  if (a.finished !== b.finished) return a.finished;
  if (a.finished) return a.finishOrder < b.finishOrder;
  return a.s > b.s + PLACE_EPS;
}

/**
 * Advance the race by dt seconds. Pass SIM_DT (1/120, the game tick) or 1/60: behaviour does not depend on the step rate.
 * Order inside a tick: traffic, AI decisions (<= 60 Hz), swings, stepBike for local riders, CCD sweeps (walls, cars, bikes),
 * discrete contacts and edges, crashes/remount, finish and places, hitFx decay, destruction.
 * @param {object} race from createRace
 * @param {number} dt step in seconds
 * @param {Object<number,{throttle:number,brake:number,steer:number,attack:(string|null),attackSide:number}>} [localInputs] input per slot simulated on this device
 * @returns {void}
 */
export function stepRace(race, dt, localInputs) {
  const track = race.track, riders = race.riders;
  if (race.phase === 'grid') race.phase = 'countdown';
  race.t += dt; race.tick++;
  if (race.phase === 'countdown') {
    race.countdown = Math.max(0, COUNTDOWN - race.t);
    if (race.t >= COUNTDOWN - 1e-9) { race.phase = 'racing'; race.countdown = 0; pushEvent(race, { type: 'go' }); }
  }
  const racing = race.phase === 'racing' || race.phase === 'finished';
  const raceT = race.t - race.goT;
  const hostSim = race.authority === 'host';
  stepTraffic(race.traffic, race.t, dt);

  // best human position (rubber band reference)
  let lead = NaN;
  for (let i = 0; i < riders.length; i++) { const r = riders[i]; if (r.kind === 'human' && !(lead >= r.s)) lead = r.s; }
  race.leaderS = lead;
  let front = -1e9; // the race leader, whoever it is
  for (let i = 0; i < riders.length; i++) if (riders[i].s > front) front = riders[i].s;

  const ctx = race._ctx;
  ctx.racing = racing; ctx.raceT = raceT; ctx.leaderS = lead; ctx.cars = race.traffic;

  // ---- inputs and bike physics for riders simulated here ----
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i], b = r.bike;
    if (r.remote) continue;
    const inp = r.input;
    if (r.kind === 'ai') {
      ctx.s = r.s; ctx.d = r.d; ctx.yaw = r.yaw;
      r.brain.done = r.finished;
      if (raceT < r.brain.diff.swingStart) r.brain.attackT = Math.max(r.brain.attackT, r.brain.diff.swingStart - raceT);
      // the AI thinks at an effective 60 Hz at most (deterministic: every other tick at 120 Hz); controls are held in between
      let adt = dt;
      if (r.aiAcc >= 0) { r.aiAcc += dt; adt = r.aiAcc; }
      if (r.aiAcc < 0 || r.aiAcc >= AI_THINK_DT - 1e-9) { r.aiAcc = 0; rivalInput(r.brain, b, riders, adt, inp, ctx); }
    } else {
      const src = (localInputs && localInputs[r.slot]) || _zero;
      if (racing) {
        inp.throttle = src.throttle || 0; inp.brake = src.brake || 0; inp.steer = src.steer || 0;
        inp.attack = src.attack || null; inp.attackSide = src.attackSide || 1;
      } else { inp.throttle = 0; inp.brake = 1; inp.steer = 0; inp.attack = null; inp.attackSide = 1; }
    }
    if (racing) stepSwing(race, r, dt); else { inp.attack = null; }
    const si = r.stepInput;
    si.throttle = inp.throttle; si.brake = inp.brake; si.steer = inp.steer; si.attack = inp.attack; si.attackSide = inp.attackSide;
    track._hint = r.s; // per-rider hint for the shared Track scratch search
    r.sx = b.pos.x; r.sz = b.pos.z;
    // arcade cornering assist for every rider, the AI too (see ROAD_ASSIST in BikePhysics.js): the road's bend at the rider's position
    if (race.assist !== false) { b.assist = ROAD_ASSIST; b.roadCurve = track.sampleAt(Math.max(0, Math.min(r.s, track.length)), _sm).curve; }
    else { b.assist = 0; b.roadCurve = 0; }
    // catch-up boost (a factor on acceleration and top speed, eased so a place swap never jerks the bike): by live place for the humans, by distance
    // behind the best human / the race leader for the rivals; times the slipstream of the bike ahead (everybody, same rule)
    let pb = r.placeBoost > 0 ? r.placeBoost : 1;
    if (race.catchUp !== false) {
      if (!r.brain) {
        // no boost (and no leader penalty) for the first HUMAN_BOOST_FROM seconds of racing, then it fades in over HUMAN_BOOST_FADE
        const want = racing && raceT > HUMAN_BOOST_FROM ? 1 + (catchUpBoost(r.place, riders.length) - 1) * clampC((raceT - HUMAN_BOOST_FROM) / HUMAN_BOOST_FADE, 0, 1) : 1;
        pb += clampC(want - pb, -0.04 * dt, 0.04 * dt);
      } else {
        const df = r.brain.diff;
        let want = 1;
        if (racing) {
          if (lead === lead) want += df.aiBoost * clampC((lead - r.s - 12) / 90, 0, 1);
          const st = 1 + df.strag * clampC((front - r.s - 150) / 300, 0, 1);
          if (st > want) want = st;
        }
        pb += clampC(want - pb, -0.05 * dt, 0.05 * dt);
      }
    } else pb = 1;
    r.placeBoost = pb;
    const dwant = racing && race.draft !== false ? draftWanted(race, r) : 0;
    const dcur = b.draft > 0 ? b.draft : 0;
    b.draft = dcur + clampC(dwant - dcur, -dt / DRAFT_EASE, dt / DRAFT_EASE);
    b.boost = pb * (1 + DRAFT_GAIN * b.spec.draftMul * b.draft);
    stepBike(b, si, dt, track);
    if (r.ghost > 0) r.ghost -= dt;
    if (b.offBal > 0) b.offBal -= dt;
  }

  // ---- track coordinates for everyone ----
  for (let i = 0; i < riders.length; i++) { track._hint = riders[i].s; locate(race, riders[i]); }

  // ---- continuous collision: nothing tunnels, whatever the speed or the tick rate ----
  for (let i = 0; i < riders.length; i++) { // remote bikes are not stepped here: their tick motion is their velocity
    const r = riders[i];
    if (r.remote) { r.sx = r.bike.pos.x - r.bike.vel.x * dt; r.sz = r.bike.pos.z - r.bike.vel.z * dt; }
  }
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i];
    if (r.remote || r.bike.crashed) continue;
    ccdRider(race, r, dt);
  }
  for (let i = 0; i < riders.length; i++) { track._hint = riders[i].s; locate(race, riders[i]); }

  // ---- contacts (every local rider against everyone / every car), edges ----
  for (let i = 0; i < riders.length; i++) {
    const a = riders[i];
    if (a.bike.crashed) continue;
    for (let j = i + 1; j < riders.length; j++) {
      const b = riders[j];
      if (b.bike.crashed || (a.remote && b.remote)) continue;
      const ds = a.s - b.s;
      if (ds > 4 || ds < -4) continue;
      bikeContacts(race, a, b, dt);
    }
  }
  const cars = race.traffic;
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i];
    if (r.remote || r.bike.crashed) continue;
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k];
      if (!c.active) continue;
      const ds = c.s - r.s;
      if (ds > 14 || ds < -14) continue;
      const dd = c.pos.x - r.bike.pos.x, dz = c.pos.z - r.bike.pos.z;
      if (dd * dd + dz * dz > 100) continue;
      carContacts(race, r, c);
      if (r.bike.crashed) break;
    }
  }
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i];
    if (r.remote || r.finished && r.kind === 'ai' && r.s >= track.length - 1) continue;
    if (r.bike.crashed) continue;
    // off balance from a blow (a kick above all) and off the tarmac: thrown off the bike, as in the original game
    if (r.bike.offBal > 0 && r.ghost <= 0 && racing && Math.abs(r.d) > track.halfWidth + 0.15) { r.lastEnergy = 4000; crashRider(race, r, 'shoved'); continue; }
    edges(race, r, dt);
  }

  // ---- crash edges, remount ----
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i], b = r.bike;
    if (b.crashed && !r.wasCrashed) { crashRider(race, r, 'hit'); }
    else if (!b.crashed && r.wasCrashed) r.wasCrashed = false; // remote rider remounted elsewhere
    if (b.crashed && !r.remote) {
      r.crashT += dt;
      if (r.crashT >= REMOUNT_T) remount(race, r);
    } else if (r.kind === 'ai' && !r.remote && racing && !r.finished) {
      // wedged in a pile-up for seconds: lift the rider out a few metres on
      if (b.speed < K && r.s < track.finishS - 10) { r.stuckT += dt; if (r.stuckT > 5) { r.stuckT = 0; remount(race, r, 8); } } else r.stuckT = 0;
    }
  }

  // ---- finish, places ----
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i];
    if (!r.finished && r.s >= track.finishS && racing) {
      r.finished = true; r.finishT = raceT; r.finishOrder = race.finishedCount++;
      if (race.winnerAbsT < 0) race.winnerAbsT = race.t;
      pushEvent(race, { type: 'finish', slot: r.slot, place: r.finishOrder + 1, t: raceT });
    }
  }
  updatePlaces(race);
  if (race.phase === 'racing') {
    let local = 0, done = 0;
    for (const r of riders) if (r.kind === 'human' && !r.remote) { local++; if (r.finished) done++; }
    if ((local > 0 && done === local) || (race.winnerAbsT >= 0 && race.t - race.winnerAbsT >= FINISH_GRACE_T)) race.phase = 'finished';
  }

  for (let i = 0; i < riders.length; i++) { // predicted stagger on remote victims fades; the real state replaces it if it crashes
    const r = riders[i];
    if (r.hitFx) { r.hitFx.t -= dt; if (r.hitFx.t <= 0 || r.bike.crashed) r.hitFx = null; }
  }
  stepDestruction(race.destruction, dt, track, null);
  void hostSim;
}

export { DT };
