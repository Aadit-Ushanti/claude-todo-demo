/**
 * DestructionSystem: crash severity, Verlet ragdolls and pooled rigid-body debris.
 * Pure logic (no DOM, no three.js). Units are SI. +Y is up.
 * Uses its own tiny private vector helpers so it has no imports.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed internal sub-step (s). Ragdoll and debris are integrated at this rate. */
const H = 1 / 240;
const MAX_SUBSTEPS = 48;

const WOBBLE_ENERGY = 1500; // J (effective, after lean factor)
const CRASH_ENERGY = 6000; // J

// Ragdoll
const RD_POINTS = 9;
const RD_ITER = 8;
const RD_MU = 0.7;
const RD_REST = 0.15;
const RD_AIR_DAMP = 0.9995;
const RD_RADIUS = 0.1;
const RD_SLEEP_SPEED = 0.25;
const RD_SLEEP_TIME = 0.5;
/** Local pose [forward, left, up] of each point relative to the bike origin. */
const RD_POSE = [
  [0.1, 0.0, 1.62], // 0 head
  [0.05, 0.0, 1.3], // 1 chest
  [-0.1, 0.0, 0.85], // 2 pelvis
  [0.3, 0.3, 1.2], // 3 left elbow/hand
  [0.3, -0.3, 1.2], // 4 right elbow/hand
  [0.35, 0.2, 0.75], // 5 left knee
  [0.35, -0.2, 0.75], // 6 right knee
  [0.2, 0.25, 0.4], // 7 left foot
  [0.2, -0.25, 0.4], // 8 right foot
];
const RD_MASS = [5, 22, 18, 6, 6, 8, 8, 5, 5];
const RD_BONES = [
  [0, 1], [1, 2], [1, 3], [1, 4], [2, 5], [2, 6], [5, 7], [6, 8],
  [0, 2], [3, 4], [5, 6],
];
const RD_REST_LEN = RD_BONES.map(([i, j]) => {
  const a = RD_POSE[i], b = RD_POSE[j];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
});

// Debris
const DB_REST = 0.35;
const DB_MU = 0.6;
const DB_MU_ROLL = 0.05;
const DB_ANG_DAMP = 0.3; // 1/s in air
const DB_GROUND_ANG_DAMP = 3.0; // 1/s on contact
const DB_ROLL_DECEL = 3.0; // m/s^2 wheel rolling resistance
const DB_SLEEP_V = 0.15;
const DB_SLEEP_W = 0.3;
const DB_SLEEP_TIME = 0.5;
const DB_KINDS = [
  // kind, mass, half extents (x along bike-left axis), local [fwd, left, up]
  { kind: 'fairingL', mass: 2.5, size: [0.03, 0.2, 0.25], at: [0.5, 0.25, 0.8], wheel: false },
  { kind: 'fairingR', mass: 2.5, size: [0.03, 0.2, 0.25], at: [0.5, -0.25, 0.8], wheel: false },
  { kind: 'wheelF', mass: 8, size: [0.08, 0.32, 0.32], at: [0.7, 0, 0.32], wheel: true },
  { kind: 'wheelR', mass: 8, size: [0.08, 0.32, 0.32], at: [-0.7, 0, 0.32], wheel: true },
  { kind: 'handlebar', mass: 3, size: [0.35, 0.02, 0.02], at: [0.45, 0, 1.0], wheel: false },
  { kind: 'tank', mass: 12, size: [0.15, 0.12, 0.25], at: [0.1, 0, 0.85], wheel: false },
];

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function vlen(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

/** mulberry32 step on the world object. */
function rnd(world) {
  let t = (world.seed = (world.seed + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// scratch (module level, no per-step allocation)
const R = new Float64Array(9);
const CP = new Float64Array(24);
let nCP = 0;
let maxPen = 0;

function quatToMat(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const xx = x * x, yy = y * y, zz = z * z;
  R[0] = 1 - 2 * (yy + zz); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (xx + zz); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (xx + yy);
}

function bikeForward(yaw, out) {
  out[0] = -Math.sin(yaw); out[1] = 0; out[2] = -Math.cos(yaw);
}

const _pose = new Float64Array(9);
/** Writes world position of local (fwd,left,up) with lean into out {x,y,z}. */
function bikeLocalToWorld(bike, f, l, u, out) {
  const sy = Math.sin(bike.yaw), cy = Math.cos(bike.yaw);
  const lean = bike.lean || 0;
  const sl = Math.sin(lean), cl = Math.cos(lean);
  // lean tilts "up" toward left: rotate (l,u) about the forward axis
  const l2 = l * cl - u * sl;
  const u2 = l * sl + u * cl;
  const fx = -sy, fz = -cy;
  const lx = -cy, lz = sy;
  out.x = bike.pos.x + fx * f + lx * l2;
  out.y = bike.pos.y + u2;
  out.z = bike.pos.z + fz * f + lz * l2;
}

// ---------------------------------------------------------------------------
// Crash severity
// ---------------------------------------------------------------------------

/**
 * Classifies a collision. Uses the closing speed along the contact normal and
 * the kinetic energy of that normal component with the reduced mass; a leaned
 * bike crashes more easily (energy is scaled by 1 + 1.5*|lean|).
 * @param {{vel:{x:number,y:number,z:number}, lean?:number, spec?:{mass:number}}} bike
 * @param {object|null} other other bike, or null for a static wall
 * @param {{x:number,y:number,z:number}} normal contact normal pointing toward `bike`
 * @param {number} [speedScale] the game's speed scale (BikePhysics.SPEED_SCALE): speeds are judged as speed / speedScale, so the thresholds hold at the same share of top speed (default 1: plain joules)
 * @returns {{relSpeed:number, energy:number, outcome:'none'|'wobble'|'crash'}}
 */
export function crashSeverity(bike, other, normal, speedScale = 1) {
  const nl = vlen(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / nl, ny = normal.y / nl, nz = normal.z / nl;
  let rx = bike.vel.x, ry = bike.vel.y, rz = bike.vel.z;
  if (other) { rx -= other.vel.x; ry -= other.vel.y; rz -= other.vel.z; }
  // normal points toward the bike, so approaching means negative dot
  const closing = -(rx * nx + ry * ny + rz * nz);
  const relSpeed = closing > 0 ? closing : 0;
  const m1 = (bike.spec && bike.spec.mass) || 200;
  const mu = other ? (m1 * ((other.spec && other.spec.mass) || 200)) / (m1 + ((other.spec && other.spec.mass) || 200)) : m1;
  const sk = relSpeed / speedScale; // the thresholds are in the old units: a crash needs the same share of top speed as before
  const energy = 0.5 * mu * sk * sk;
  const leanFactor = 1 + 1.5 * Math.abs(bike.lean || 0);
  const eff = energy * leanFactor;
  const outcome = eff >= CRASH_ENERGY ? 'crash' : eff >= WOBBLE_ENERGY ? 'wobble' : 'none';
  return { relSpeed, energy, outcome };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

function makeRagdoll() {
  const pts = [], prev = [];
  for (let i = 0; i < RD_POINTS; i++) { pts.push({ x: 0, y: 0, z: 0 }); prev.push({ x: 0, y: 0, z: 0 }); }
  return {
    id: -1, active: false, asleep: false, seq: 0, sleepT: 0,
    points: pts, prev, masses: RD_MASS, bones: RD_BONES,
  };
}

function makeBody() {
  return {
    id: -1, active: false, asleep: false, seq: 0, sleepT: 0, kind: '', wheel: false,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 }, angVel: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 }, radius: 0, mass: 1, invMass: 1, inertia: 1, touch: false,
  };
}

/**
 * Creates a destruction world (pools for ragdolls and debris, seeded RNG).
 * @param {{maxDebris?:number, maxRagdolls?:number, gravity?:number, seed?:number}} [opts]
 * @returns {object} DestructionWorld
 */
export function createDestruction(opts = {}) {
  const maxDebris = opts.maxDebris ?? 64;
  const maxRagdolls = opts.maxRagdolls ?? 8;
  const world = {
    maxDebris, maxRagdolls,
    gravity: opts.gravity ?? 9.81,
    seed: (opts.seed ?? 12345) | 0,
    nextId: 1, seqCounter: 0, acc: 0,
    ragPool: [], debrisPool: [],
  };
  for (let i = 0; i < maxRagdolls; i++) world.ragPool.push(makeRagdoll());
  for (let i = 0; i < maxDebris; i++) world.debrisPool.push(makeBody());
  return world;
}

function acquire(pool) {
  let free = null, oldestAsleep = null, oldest = null;
  for (let i = 0; i < pool.length; i++) {
    const it = pool[i];
    if (!it.active) { free = it; break; }
    if (it.asleep && (!oldestAsleep || it.seq < oldestAsleep.seq)) oldestAsleep = it;
    if (!oldest || it.seq < oldest.seq) oldest = it;
  }
  return free || oldestAsleep || oldest;
}

// ---------------------------------------------------------------------------
// Ragdoll
// ---------------------------------------------------------------------------

/**
 * Spawns a rider ragdoll at the seat position of `bike`, inheriting the bike
 * velocity plus impulse/mass. Reuses the oldest asleep (else oldest) slot when full.
 * @param {object} world DestructionWorld
 * @param {{pos:object, vel:object, yaw:number, lean?:number, spec?:{mass:number}}} bike
 * @param {{x:number,y:number,z:number}} impulse impulse in N*s
 * @returns {number} ragdoll id
 */
export function spawnRagdoll(world, bike, impulse) {
  const rd = acquire(world.ragPool);
  const mass = (bike.spec && bike.spec.mass) || 200;
  const ix = impulse ? impulse.x / mass : 0;
  const iy = impulse ? impulse.y / mass : 0;
  const iz = impulse ? impulse.z / mass : 0;
  rd.id = world.nextId++;
  rd.seq = ++world.seqCounter;
  rd.active = true; rd.asleep = false; rd.sleepT = 0;
  for (let i = 0; i < RD_POINTS; i++) {
    const p = rd.points[i], q = rd.prev[i], o = RD_POSE[i];
    bikeLocalToWorld(bike, o[0], o[1], o[2], p);
    const vx = bike.vel.x + ix + (rnd(world) - 0.5) * 1.0;
    const vy = bike.vel.y + iy + (rnd(world) - 0.5) * 1.0;
    const vz = bike.vel.z + iz + (rnd(world) - 0.5) * 1.0;
    q.x = p.x - vx * H; q.y = p.y - vy * H; q.z = p.z - vz * H;
  }
  return rd.id;
}

let _track = null;
let _barriers = null;

function groundH(x, z) { return _track ? _track.heightAt(x, z) : 0; }

/** Contact handling for one ragdoll point. `full` applies restitution + friction. */
function ragdollContact(rd, i, full) {
  const p = rd.points[i], q = rd.prev[i];
  const r = i === 0 ? RD_RADIUS + 0.02 : RD_RADIUS;
  const gh = groundH(p.x, p.z) + r;
  if (p.y < gh) {
    const vyb = p.y - q.y;
    p.y = gh;
    if (full) {
      const vn = vyb < 0 ? -vyb : 0;
      const e = vn > 3 * H ? RD_REST : 0;
      q.y = p.y + e * vyb;
      let vx = p.x - q.x, vz = p.z - q.z;
      const vt = Math.sqrt(vx * vx + vz * vz);
      if (vt > 0) {
        const ft = RD_MU * vn;
        if (vt <= ft) { q.x = p.x; q.z = p.z; } else {
          q.x += (vx / vt) * ft; q.z += (vz / vt) * ft;
        }
      }
    } else if (q.y < p.y) {
      q.y = p.y;
    }
  }
  if (_barriers) {
    for (let b = 0; b < _barriers.length; b++) {
      const bp = _barriers[b].point, bn = _barriers[b].normal;
      const d = (p.x - bp.x) * bn.x + (p.y - bp.y) * bn.y + (p.z - bp.z) * bn.z;
      if (d < r) {
        const pen = r - d;
        const vx = p.x - q.x, vy = p.y - q.y, vz = p.z - q.z;
        const vn = vx * bn.x + vy * bn.y + vz * bn.z;
        p.x += bn.x * pen; p.y += bn.y * pen; p.z += bn.z * pen;
        if (vn < 0) {
          const tx = vx - vn * bn.x, ty = vy - vn * bn.y, tz = vz - vn * bn.z;
          const tl = vlen(tx, ty, tz);
          const f = full ? Math.max(0, 1 - (RD_MU * -vn) / (tl + 1e-12)) : 1;
          const rb = full ? -vn * RD_REST : 0;
          q.x = p.x - (tx * f + rb * bn.x);
          q.y = p.y - (ty * f + rb * bn.y);
          q.z = p.z - (tz * f + rb * bn.z);
        }
      }
    }
  }
}

function stepRagdoll(world, rd, h) {
  const g = world.gravity * h * h;
  for (let i = 0; i < RD_POINTS; i++) {
    const p = rd.points[i], q = rd.prev[i];
    const vx = (p.x - q.x) * RD_AIR_DAMP, vy = (p.y - q.y) * RD_AIR_DAMP, vz = (p.z - q.z) * RD_AIR_DAMP;
    q.x = p.x; q.y = p.y; q.z = p.z;
    p.x += vx; p.y += vy - g; p.z += vz;
  }
  for (let i = 0; i < RD_POINTS; i++) ragdollContact(rd, i, true);
  for (let it = 0; it < RD_ITER; it++) {
    for (let b = 0; b < RD_BONES.length; b++) {
      const i = RD_BONES[b][0], j = RD_BONES[b][1];
      const pi = rd.points[i], pj = rd.points[j];
      const dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      const diff = (d - RD_REST_LEN[b]) / d;
      const wi = 1 / RD_MASS[i], wj = 1 / RD_MASS[j];
      const si = wi / (wi + wj), sj = wj / (wi + wj);
      pi.x += dx * diff * si; pi.y += dy * diff * si; pi.z += dz * diff * si;
      pj.x -= dx * diff * sj; pj.y -= dy * diff * sj; pj.z -= dz * diff * sj;
    }
    for (let i = 0; i < RD_POINTS; i++) ragdollContact(rd, i, false);
  }
  // sleep check
  let maxV2 = 0;
  for (let i = 0; i < RD_POINTS; i++) {
    const p = rd.points[i], q = rd.prev[i];
    const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    const v2 = dx * dx + dy * dy + dz * dz;
    if (v2 > maxV2) maxV2 = v2;
  }
  const v = Math.sqrt(maxV2) / h;
  if (v < RD_SLEEP_SPEED) {
    rd.sleepT += h;
    if (rd.sleepT > RD_SLEEP_TIME) {
      rd.asleep = true;
      for (let i = 0; i < RD_POINTS; i++) {
        const p = rd.points[i], q = rd.prev[i];
        q.x = p.x; q.y = p.y; q.z = p.z;
      }
    }
  } else rd.sleepT = 0;
}

// ---------------------------------------------------------------------------
// Debris
// ---------------------------------------------------------------------------

/**
 * Spawns the six debris bodies (2 fairings, 2 wheels, handlebar, tank) at the
 * bike pose. Velocity = bike velocity + a random cone around impactDir scaled by
 * sqrt(energy), plus spin. Uses the world's seeded RNG. Reuses the oldest asleep
 * (else oldest) slot when the pool is full.
 * @param {object} world DestructionWorld
 * @param {{pos:object, vel:object, yaw:number, lean?:number}} bike
 * @param {{x:number,y:number,z:number}} impactDir direction debris are thrown (need not be unit)
 * @param {number} energy impact energy in joules
 * @returns {number[]} ids of the spawned bodies
 */
export function spawnDebris(world, bike, impactDir, energy) {
  const ids = [];
  let dx = impactDir ? impactDir.x : 0, dy = impactDir ? impactDir.y : 0, dz = impactDir ? impactDir.z : 0;
  let dl = vlen(dx, dy, dz);
  if (dl < 1e-6) { dx = -Math.sin(bike.yaw); dy = 0; dz = -Math.cos(bike.yaw); dl = 1; }
  dx /= dl; dy /= dl; dz /= dl;
  // perpendicular basis
  let ax = 0, ay = 1, az = 0;
  if (Math.abs(dy) > 0.9) { ax = 1; ay = 0; }
  let e1x = dy * az - dz * ay, e1y = dz * ax - dx * az, e1z = dx * ay - dy * ax;
  const e1l = vlen(e1x, e1y, e1z); e1x /= e1l; e1y /= e1l; e1z /= e1l;
  const e2x = dy * e1z - dz * e1y, e2y = dz * e1x - dx * e1z, e2z = dx * e1y - dy * e1x;
  const base = Math.sqrt(Math.max(energy, 0));
  const yawQ = bike.yaw * 0.5;
  const qy = Math.sin(yawQ), qw = Math.cos(yawQ);
  const maxCone = 0.6; // rad half angle
  for (let k = 0; k < DB_KINDS.length; k++) {
    const d = DB_KINDS[k];
    const b = acquire(world.debrisPool);
    b.id = world.nextId++;
    b.seq = ++world.seqCounter;
    b.active = true; b.asleep = false; b.sleepT = 0; b.touch = false;
    b.kind = d.kind; b.wheel = d.wheel;
    b.mass = d.mass; b.invMass = 1 / d.mass;
    b.size.x = d.size[0]; b.size.y = d.size[1]; b.size.z = d.size[2];
    b.radius = d.wheel ? d.size[1] : 0;
    b.inertia = d.wheel
      ? 0.5 * d.mass * d.size[1] * d.size[1]
      : (2 / 9) * d.mass * (d.size[0] * d.size[0] + d.size[1] * d.size[1] + d.size[2] * d.size[2]);
    bikeLocalToWorld(bike, d.at[0], d.at[1], d.at[2], b.pos);
    b.quat.x = 0; b.quat.y = qy; b.quat.z = 0; b.quat.w = qw;
    // cone direction
    const ang = rnd(world) * maxCone;
    const phi = rnd(world) * Math.PI * 2;
    const sa = Math.sin(ang), ca = Math.cos(ang);
    const cx = Math.cos(phi) * sa, cz = Math.sin(phi) * sa;
    let vx = dx * ca + e1x * cx + e2x * cz;
    let vy = dy * ca + e1y * cx + e2y * cz;
    let vz = dz * ca + e1z * cx + e2z * cz;
    const sp = base * 0.08 * (0.6 + 0.8 * rnd(world));
    vx = vx * sp + bike.vel.x;
    vy = vy * sp + bike.vel.y + 0.25 * sp;
    vz = vz * sp + bike.vel.z;
    b.vel.x = vx; b.vel.y = vy; b.vel.z = vz;
    const spin = 2 + 0.1 * base * 0.1;
    b.angVel.x = (rnd(world) - 0.5) * 2 * spin;
    b.angVel.y = (rnd(world) - 0.5) * 2 * spin;
    b.angVel.z = (rnd(world) - 0.5) * 2 * spin;
    ids.push(b.id);
  }
  return ids;
}

/** One contact point against a plane with normal n. pen > 0 means penetrating. */
function pointContact(b, px, py, pz, nx, ny, nz, pen) {
  const rx = px - b.pos.x, ry = py - b.pos.y, rz = pz - b.pos.z;
  const w = b.angVel, v = b.vel;
  const vpx = v.x + (w.y * rz - w.z * ry);
  const vpy = v.y + (w.z * rx - w.x * rz);
  const vpz = v.z + (w.x * ry - w.y * rx);
  const vn = vpx * nx + vpy * ny + vpz * nz;
  b.touch = true;
  if (pen > maxPen) maxPen = pen;
  if (vn >= 0) return;
  const invM = b.invMass, invI = 1 / b.inertia;
  // r x n
  const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
  const denom = invM + (cx * cx + cy * cy + cz * cz) * invI;
  const e = -vn > 1.5 ? DB_REST : 0;
  const jn = -(1 + e) * vn / denom;
  applyImpulse(b, rx, ry, rz, nx * jn, ny * jn, nz * jn);
  // friction (recompute relative velocity)
  const vqx = v.x + (w.y * rz - w.z * ry);
  const vqy = v.y + (w.z * rx - w.x * rz);
  const vqz = v.z + (w.x * ry - w.y * rx);
  const vn2 = vqx * nx + vqy * ny + vqz * nz;
  const tx = vqx - vn2 * nx, ty = vqy - vn2 * ny, tz = vqz - vn2 * nz;
  if (b.wheel) {
    // axis = local X
    quatToMat(b.quat);
    const axx = R[0], axy = R[3], axz = R[6];
    // t1 = axis x n (rolling direction)
    let t1x = axy * nz - axz * ny, t1y = axz * nx - axx * nz, t1z = axx * ny - axy * nx;
    const t1l = vlen(t1x, t1y, t1z);
    if (t1l > 1e-6) {
      t1x /= t1l; t1y /= t1l; t1z /= t1l;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      frictionDir(b, rx, ry, rz, t1x, t1y, t1z, tx * t1x + ty * t1y + tz * t1z, DB_MU_ROLL * jn);
      frictionDir(b, rx, ry, rz, t2x, t2y, t2z, tx * t2x + ty * t2y + tz * t2z, DB_MU * jn);
      return;
    }
  }
  const tl = vlen(tx, ty, tz);
  if (tl > 1e-9) frictionDir(b, rx, ry, rz, tx / tl, ty / tl, tz / tl, tl, DB_MU * jn);
}

function frictionDir(b, rx, ry, rz, tx, ty, tz, vt, maxJ) {
  const cx = ry * tz - rz * ty, cy = rz * tx - rx * tz, cz = rx * ty - ry * tx;
  const denom = b.invMass + (cx * cx + cy * cy + cz * cz) / b.inertia;
  let j = -vt / denom;
  if (j > maxJ) j = maxJ; else if (j < -maxJ) j = -maxJ;
  applyImpulse(b, rx, ry, rz, tx * j, ty * j, tz * j);
}

function applyImpulse(b, rx, ry, rz, jx, jy, jz) {
  b.vel.x += jx * b.invMass; b.vel.y += jy * b.invMass; b.vel.z += jz * b.invMass;
  const ii = 1 / b.inertia;
  b.angVel.x += (ry * jz - rz * jy) * ii;
  b.angVel.y += (rz * jx - rx * jz) * ii;
  b.angVel.z += (rx * jy - ry * jx) * ii;
}

/** Fill CP with candidate contact points for body vs plane normal n (points deepest toward -n). */
function gatherPoints(b, nx, ny, nz) {
  quatToMat(b.quat);
  const c = b.pos;
  nCP = 0;
  if (!b.wheel) {
    const sx = b.size.x, sy = b.size.y, sz = b.size.z;
    for (let i = 0; i < 8; i++) {
      const lx = (i & 1 ? sx : -sx), ly = (i & 2 ? sy : -sy), lz = (i & 4 ? sz : -sz);
      CP[nCP++] = c.x + R[0] * lx + R[1] * ly + R[2] * lz;
      CP[nCP++] = c.y + R[3] * lx + R[4] * ly + R[5] * lz;
      CP[nCP++] = c.z + R[6] * lx + R[7] * ly + R[8] * lz;
    }
    return;
  }
  const w = b.size.x, r = b.radius;
  const ax = R[0], ay = R[3], az = R[6];
  const an = ax * nx + ay * ny + az * nz;
  // rim point lowest along -n
  let dx = -nx + an * ax, dy = -ny + an * ay, dz = -nz + an * az;
  const dl = vlen(dx, dy, dz);
  if (dl > 1e-3) {
    dx = dx / dl * r; dy = dy / dl * r; dz = dz / dl * r;
    for (let s = -1; s <= 1; s += 2) {
      CP[nCP++] = c.x + dx + s * w * ax; CP[nCP++] = c.y + dy + s * w * ay; CP[nCP++] = c.z + dz + s * w * az;
    }
  }
  // lowest face rim (4 points)
  const sgn = an > 0 ? -1 : 1;
  const fx = c.x + sgn * w * ax, fy = c.y + sgn * w * ay, fz = c.z + sgn * w * az;
  // e1 = axis x helper
  let hx = 0, hy = 1, hz = 0;
  if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; }
  let e1x = ay * hz - az * hy, e1y = az * hx - ax * hz, e1z = ax * hy - ay * hx;
  const e1l = vlen(e1x, e1y, e1z); e1x = e1x / e1l * r; e1y = e1y / e1l * r; e1z = e1z / e1l * r;
  const e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
  const e2l = vlen(e2x, e2y, e2z) || 1;
  const k2 = r / e2l;
  CP[nCP++] = fx + e1x; CP[nCP++] = fy + e1y; CP[nCP++] = fz + e1z;
  CP[nCP++] = fx - e1x; CP[nCP++] = fy - e1y; CP[nCP++] = fz - e1z;
  CP[nCP++] = fx + e2x * k2; CP[nCP++] = fy + e2y * k2; CP[nCP++] = fz + e2z * k2;
  CP[nCP++] = fx - e2x * k2; CP[nCP++] = fy - e2y * k2; CP[nCP++] = fz - e2z * k2;
}

function stepBody(world, b, h) {
  const v = b.vel, w = b.angVel, p = b.pos, q = b.quat;
  v.y -= world.gravity * h;
  p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
  // orientation
  const hq = 0.5 * h;
  const dx = w.x * q.w + w.y * q.z - w.z * q.y;
  const dy = w.y * q.w + w.z * q.x - w.x * q.z;
  const dz = w.z * q.w + w.x * q.y - w.y * q.x;
  const dw = -w.x * q.x - w.y * q.y - w.z * q.z;
  q.x += hq * dx; q.y += hq * dy; q.z += hq * dz; q.w += hq * dw;
  const ql = 1 / Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  q.x *= ql; q.y *= ql; q.z *= ql; q.w *= ql;
  const ad = 1 - DB_ANG_DAMP * h;
  w.x *= ad; w.y *= ad; w.z *= ad;

  b.touch = false;
  for (let pass = 0; pass < 2; pass++) {
    // ground
    gatherPoints(b, 0, 1, 0);
    maxPen = 0;
    for (let i = 0; i < nCP; i += 3) {
      const px = CP[i], py = CP[i + 1], pz = CP[i + 2];
      const pen = groundH(px, pz) - py;
      if (pen > 0) pointContact(b, px, py, pz, 0, 1, 0, pen);
    }
    if (pass === 0 && maxPen > 0) p.y += maxPen;
    // barriers
    if (_barriers) {
      for (let k = 0; k < _barriers.length; k++) {
        const bp = _barriers[k].point, bn = _barriers[k].normal;
        gatherPoints(b, bn.x, bn.y, bn.z);
        maxPen = 0;
        for (let i = 0; i < nCP; i += 3) {
          const px = CP[i], py = CP[i + 1], pz = CP[i + 2];
          const pen = -((px - bp.x) * bn.x + (py - bp.y) * bn.y + (pz - bp.z) * bn.z);
          if (pen > 0) pointContact(b, px, py, pz, bn.x, bn.y, bn.z, pen);
        }
        if (pass === 0 && maxPen > 0) { p.x += bn.x * maxPen; p.y += bn.y * maxPen; p.z += bn.z * maxPen; }
      }
    }
  }

  if (b.touch) {
    const gd = 1 - DB_GROUND_ANG_DAMP * h;
    w.x *= gd; w.y *= gd; w.z *= gd;
    if (b.wheel) {
      const s = Math.sqrt(v.x * v.x + v.z * v.z);
      if (s > 1e-6) {
        const ns = Math.max(0, s - DB_ROLL_DECEL * h);
        const k = ns / s;
        v.x *= k; v.z *= k;
        const wd = 1 - (1 - k) * 1;
        w.x *= wd; w.y *= wd; w.z *= wd;
      }
    }
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    const w2 = w.x * w.x + w.y * w.y + w.z * w.z;
    if (v2 < DB_SLEEP_V * DB_SLEEP_V && w2 < DB_SLEEP_W * DB_SLEEP_W) {
      b.sleepT += h;
      if (b.sleepT > DB_SLEEP_TIME) {
        b.asleep = true;
        v.x = v.y = v.z = 0; w.x = w.y = w.z = 0;
      }
    } else b.sleepT = 0;
  } else b.sleepT = 0;
}

// ---------------------------------------------------------------------------
// Step & iteration
// ---------------------------------------------------------------------------

/**
 * Advances all ragdolls and debris by `dt` seconds (internally sub-stepped at a
 * fixed 1/240 s). Mutates in place. Handles gravity, ground contact with
 * restitution and friction via `track.heightAt`, barrier planes, and sleeping.
 * @param {object} world DestructionWorld
 * @param {number} dt seconds
 * @param {{heightAt:(x:number,z:number)=>number}|null} track terrain (null = flat y=0)
 * @param {Array<{point:{x:number,y:number,z:number}, normal:{x:number,y:number,z:number}}>} [barriers]
 *   planes; `normal` points toward the allowed (free) side
 * @returns {void}
 */
export function stepDestruction(world, dt, track, barriers) {
  _track = track || null;
  _barriers = barriers && barriers.length ? barriers : null;
  world.acc += dt;
  let n = 0;
  while (world.acc >= H - 1e-9 && n < MAX_SUBSTEPS) {
    world.acc -= H; n++;
    const rp = world.ragPool;
    for (let i = 0; i < rp.length; i++) if (rp[i].active && !rp[i].asleep) stepRagdoll(world, rp[i], H);
    const dp = world.debrisPool;
    for (let i = 0; i < dp.length; i++) if (dp[i].active && !dp[i].asleep) stepBody(world, dp[i], H);
  }
  if (world.acc < 0) world.acc = 0;
  if (n === MAX_SUBSTEPS) world.acc = 0;
  _track = null; _barriers = null;
}

/**
 * Iterates live ragdolls. Items are the persistent internal objects (do not
 * keep them across spawns): { id, points, bones, asleep, prev, masses }.
 * `prev` holds Verlet previous positions (velocity = (points - prev)/(1/240)).
 * @param {object} world DestructionWorld
 * @returns {Iterable<{id:number, points:Array<{x:number,y:number,z:number}>, bones:number[][], asleep:boolean}>}
 */
export function* ragdolls(world) {
  const p = world.ragPool;
  for (let i = 0; i < p.length; i++) if (p[i].active) yield p[i];
}

/**
 * Iterates live debris bodies. Items are the persistent internal objects:
 * { id, kind, pos, quat, size, asleep, radius, vel, angVel, mass, inertia }.
 * @param {object} world DestructionWorld
 * @returns {Iterable<{id:number, kind:string, pos:object, quat:object, size:object, asleep:boolean}>}
 */
export function* debris(world) {
  const p = world.debrisPool;
  for (let i = 0; i < p.length; i++) if (p[i].active) yield p[i];
}
