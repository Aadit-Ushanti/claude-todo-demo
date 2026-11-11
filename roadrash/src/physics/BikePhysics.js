// Arcade-but-physical motorbike model. Step-rate independent: it is tuned at 60 Hz (DT) and every per-step blend
// factor, decay and threshold below is expressed per second, so stepBike gives the same behaviour at 60 or 120 Hz.
// Pure logic: no DOM, no three.js. SI units. World: +Y up, yaw 0 faces -Z, +yaw turns left,
// lean > 0 leans left. Forward = (-sin yaw, 0, -cos yaw), left = (-cos yaw, 0, sin yaw).
import { clamp, wrapAngle } from './vec.js';

/** Reference (legacy) simulation step (s). The game ticks at SIM_DT = 1/120 (see Race.js); stepBike accepts any dt. */
export const DT = 1 / 60;

// Per-second rates equivalent to the 60 Hz per-step blend factors the model was tuned with:
// a(dt) = 1 - exp(-K dt) reproduces the 60 Hz factor a60 exactly at dt = 1/60 and scales correctly at any other dt.
const rate60 = (a60) => -60 * Math.log(1 - a60);
const K_ACCEL = rate60(1 / 6); // accel low-pass (was min(1, dt * 10))
const K_YAW = rate60(1 / 3.6); // yaw-rate follow (was dt / 0.06)
const K_PITCH_GND = rate60(14 / 60);
const K_PITCH_AIR = rate60(4 / 60);
const K_YAWKICK = -60 * Math.log(1 - (1 / 60) / 0.5); // yaw kick decay (was 1 - dt / 0.5)
const K_LATVEL = 60 * Math.log(1 + 3 / 60); // lateral kick decay (was / (1 + 3 dt))
/** Internal step (s) of the ground-following / take-off / landing logic; calls with a longer dt sub-step it. */
const VERT_DT = 1 / 120;

const G = 9.81;
/**
 * Real speeds are 30 % below the previous tuning (183.3 / 187.2 / 178.6 km/h became 128.3 / 131.0 / 125.0): the game is the same race at a
 * lower real speed. Every speed in this model (bike tops, the knees of the lean ceiling, drift gates, wobble, crash thresholds, traffic, the
 * AI) is the old number times SPEED_SCALE, so each behaviour happens at the same SHARE of top speed. Time-based things (lean rate and
 * acceleration, the yaw and pitch followers, suspension, remount) are NOT scaled: the bikes react as quickly as before.
 * Accelerations scale with the speed (so 0 to top takes as many seconds as before), lateral accelerations with its square (so a bend is
 * taken at the same share of top speed with the same lean), see LATERAL_G.
 */
export const SPEED_SCALE = 0.7;
/**
 * The HUD reads real km/h times this: the old readout was real x 1.28 (at the old real speeds), so at the same share of top speed the new
 * real speed shows the same number: 1.28 / SPEED_SCALE. Used by src/main.js for the speedKmh field of the HUD state.
 */
export const DISPLAY_SPEED_SCALE = 1.28 / SPEED_SCALE;
const K = SPEED_SCALE;
/** Acceleration (m/s^2) of a "1 g" longitudinal effect (slope, scrub, surface drag): scaled with the speed. */
const G_LONG = G * K;
/** The lateral acceleration scale (m/s^2 per unit of tan(lean)): g times SPEED_SCALE^2, so v^2 k = a_lat is met at SPEED_SCALE times the old speed. Exported for the AI and the tools. */
export const LATERAL_G = G * K * K;
/** Airborne clearance (m) that makes a bike leave the ground at the 60 Hz step; it scales with dt^2 (a constant ground acceleration) and with K^2: a crest launches at the same share of top speed as before. */
const AIR_CLEAR_60 = 0.03 * K * K;
const RHO_UNUSED = 0; // aero is folded into spec.drag (N per (m/s)^2)
const V_MIN = 4 * K; // minimum speed in the yaw = g tan(lean)/v formula
const MAX_SLIP = 0.65;
const SLIP_ON = 0.12;
const SLIP_OFF = 0.05;
/** Share of the lean that a full brake takes away (the bike stands up under braking). */
const STANDUP = 0.3;
void RHO_UNUSED;

/**
 * Build a bike spec from raw numbers (exported for the balance tools). Derived: topSpeed (m/s) and drag.
 * Character fields beyond the base model: hsLeanLoss (share of lean authority lost at very high speed, a stability trade),
 * health (start hit points), staggerMul (multiplier on stagger time from a blow, lower = more stagger resistance) and
 * knock (multiplier on the knock-off threshold of a blow, higher = harder to knock down), tempo (swing cycle length multiplier).
 */
export function makeSpec(id, name, o) {
  const vmax = o.topKmh / 3.6;
  const rr = o.crr * o.mass * G * vmax;
  return {
    id,
    name,
    mass: o.mass, // bike + rider (kg)
    power: o.power, // wheel power (W)
    topKmh: o.topKmh,
    topSpeed: vmax, // m/s, power = drag + rolling resistance at this speed
    drag: (o.power - rr) / (vmax * vmax * vmax), // 0.5*rho*CdA folded: N per (m/s)^2
    crr: o.crr,
    wheelbase: o.wheelbase,
    brake: o.brake, // max braking decel on grip 1 (m/s^2)
    grip: o.grip, // tyre friction coefficient
    maxLean: o.maxLean, // rad
    leanRate: o.leanRate, // max lean rate rad/s
    leanAccel: o.leanAccel, // rad/s^2
    tractionFrac: o.tractionFrac, // share of weight usable for drive (wheelie limit)
    suspFreq: o.suspFreq, // Hz
    suspDamp: o.suspDamp, // damping ratio
    travel: o.travel, // m of suspension travel
    hsLeanLoss: o.hsLeanLoss ?? 0.3, // lean authority lost at high speed, times 1.9 (see leanScaleAt)
    health: o.health ?? 100, // start hit points
    staggerMul: o.staggerMul ?? 1, // stagger time per blow, relative
    knock: o.knock ?? 1, // knock-off threshold per blow, relative
    tempo: o.tempo ?? 1, // length of the whole swing cycle (windup, swing, recovery) relative to the weapon's: > 1 = slower swinging (heavy bikes)
    tag: o.tag || name, // short label for UI
  };
}

/**
 * Real top speeds are 51 % below the first tuning (235 / 240 / 229 km/h): 22 % for the corners, then 30 % more (SPEED_SCALE) so the bikes can be
 * controlled. The HUD shows real x DISPLAY_SPEED_SCALE (the old numbers at the same share of top speed), and the camera and the velocity effects
 * read speed / topSpeed, so the bikes still look and read as fast as before. The literals below are the 22 %-cut tuning times SPEED_SCALE:
 * top speed x K, power x K^2, rolling resistance, traction share and brakes x K (every force scales with the speed, so the speed curve over time is
 * the old one scaled by K: 0 to top takes as many seconds as before, and a share of top speed is reached in the same time).
 * (health / staggerMul / tempo of the three were re-balanced a little when the speeds were cut and the swing reach widened: the duels of
 * tests/balance.test.js are decided by the health shares, so they are sensitive to tenths of a health point.)
 * Bike specifications: three trade-offs of equal overall strength (see tests/balance.test.js and tests/tools/balance-report.mjs).
 *  Sport   : highest top speed and the best high-speed lean authority; weakest launch, lightest (biggest kick when hit), least health and stagger resistance, quickest swing cycle.
 *  Street  : best acceleration, grip and lean rate, quickest direction changes; middling top speed; average toughness.
 *  Cruiser : ('chopper' id) heaviest, most health, stagger resistance and stability when struck, the shoves hardest in body contact;
 *            slowest to lean, lowest cornering speed, slowest swing cycle; lowest top speed; good mid-range torque.
 * Fields: mass, power, topSpeed, drag (N/(m/s)^2), crr, wheelbase, brake (m/s^2), grip (mu), maxLean, leanRate, leanAccel,
 * tractionFrac (launch acceleration = tractionFrac * grip * g, until power takes over), suspFreq, suspDamp, travel,
 * hsLeanLoss, health, staggerMul, knock, tempo.
 */
export const BIKE_SPECS = {
  street: makeSpec('street', 'Street', {
    mass: 295, power: 59260 * K * K, topKmh: 183.3 * K, crr: 0.015 * K, wheelbase: 1.45, brake: 9.5 * K, grip: 1.25,
    maxLean: 0.785, leanRate: 3.8, leanAccel: 36, tractionFrac: 0.5056065239551478 * K,
    suspFreq: 2.2, suspDamp: 0.5, travel: 0.14,
    hsLeanLoss: 0.31, health: 100.6, staggerMul: 1, knock: 1, tempo: 1.06, tag: 'ST',
  }),
  sport: makeSpec('sport', 'Sport', {
    mass: 255.923, power: 72674 * K * K, topKmh: 187.2 * K, crr: 0.014 * K, wheelbase: 1.4, brake: 10.5 * K, grip: 1.22,
    maxLean: 0.795, leanRate: 3.3, leanAccel: 28, tractionFrac: 0.5 * K,
    suspFreq: 2.6, suspDamp: 0.55, travel: 0.12,
    hsLeanLoss: 0.305, health: 99.65, staggerMul: 1.15, knock: 1.149, tempo: 0.924, tag: 'SP',
  }),
  chopper: makeSpec('chopper', 'Cruiser', {
    mass: 379.001, power: 71058 * K * K, topKmh: 178.6 * K, crr: 0.018 * K, wheelbase: 1.95, brake: 9 * K, grip: 1.15,
    maxLean: 0.78, leanRate: 2.6, leanAccel: 22, tractionFrac: 0.5495723086468999 * K,
    suspFreq: 1.7, suspDamp: 0.45, travel: 0.16,
    hsLeanLoss: 0.3, health: 100.8, staggerMul: 0.875, knock: 1.081, tempo: 1.2, tag: 'CR',
  }),
};

/**
 * Melee weapons. reach: m from the shoulder; damage: base health; arc: half-angle (rad) of the
 * swing sector around the lateral axis; windup: s; impulse: base N*s; stagger: base seconds.
 * reach / arc are the forgiving values a human's swing uses (reach +30 %, a wider sector so a rival half a bike length ahead or behind still counts);
 * reach0 / arc0 are the old tighter ones, used by the AI riders (their attack rate and what they land are unchanged).
 */
/** Wheel zones for the kick, along the victim's length from its centre (m): centres at +-at, half-length half. */
export const KICK_WHEEL = { at: 0.7, half: 0.3 };
export const WEAPONS = {
  punch: { reach: 1.1, reach0: 0.85, damage: 5, arc: 1.25, arc0: 0.9, windup: 0.12, impulse: 140, stagger: 0.35 },
  // The kick reaches further and is slower than the punch. Landed on the body it does exactly what a punch does; landed on a
  // wheel (front or rear, see KICK_WHEEL) it also wobbles the bike and shoves it sideways (shove: m/s of sideways speed).
  kick: { reach: 1.75, reach0: 1.4, damage: 5, arc: 1.35, arc0: 1.15, windup: 0.2, impulse: 140, stagger: 0.35, shove: 3.4, wheelStagger: 0.8 },
};

/** Flat ground used when no track is supplied. */
const FLAT_TRACK = {
  heightAt: () => 0,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
  gripAt: () => 1,
};

/**
 * Create a bike at rest.
 * Besides the contract fields the state carries internal extras: latVel (lateral kick velocity,
 * m/s along left), yawKick (rad/s), suspFv/suspRv (compression rates), groundPitch, accel,
 * wInit/hF/hR/wvF/wvR (previous wheel-ground samples), attack/attackSide (last input).
 * @param {string} specId 'street' | 'sport' | 'chopper'
 * @param {{x:number,y:number,z:number}} pos start position (copied)
 * @param {number} [yaw=0] heading
 * @returns {object} BikeState
 */
export function createBike(specId, pos, yaw = 0) {
  const spec = BIKE_SPECS[specId];
  if (!spec) throw new Error('unknown bike spec: ' + specId);
  return {
    spec,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw, yawRate: 0, lean: 0, leanRate: 0, pitch: 0, speed: 0,
    slip: 0, drifting: false,
    throttle: 0, brake: 0, steer: 0,
    suspF: 0.3, suspR: 0.3, airborne: false,
    health: spec.health, stagger: 0, crashed: false,
    latVel: 0, yawKick: 0, suspFv: 0, suspRv: 0, groundPitch: 0, accel: 0,
    wInit: false, hF: 0, hR: 0, wvF: 0, wvR: 0,
    attack: null, attackSide: 1,
  };
}

function smooth01(x) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

/**
 * Share (0.7..1) of the commanded lean that is kept while braking: braking while leaned stands the bike up a little, up to 30 % at a hard brake
 * (so the line holds as the speed drops). A rider (or the AI) that wants a given lean divides its steer by this.
 * @param {number} brk brake input 0..1
 * @returns {number} 0.7..1
 */
export function standUpFactor(brk) { return 1 - STANDUP * smooth01(brk / 0.8); }

/**
 * The highest speed at which a bend of curvature k (1/m) can be taken with `share` of what the bike can give there: the lateral acceleration
 * g tan(maxLean * leanScaleAt(v)), at most gripCap (m/s^2), times share. The ceiling falls with speed, so v^2 k - share a(v) rises with v and
 * the answer is found by bisection (a plain fixed-point iteration swings between two values on a steep ceiling).
 * @param {object} spec a bike spec
 * @param {number} k curvature magnitude (1/m), > 0
 * @param {number} share fraction of the available lateral acceleration to use
 * @param {number} gripCap lateral acceleration the tyres give (m/s^2; use grip * LATERAL_G)
 * @returns {number} speed (m/s)
 */
export function maxCornerSpeed(spec, k, share, gripCap) {
  let lo = 3 * K, hi = 80 * K;
  for (let i = 0; i < 9; i++) {
    const v = 0.5 * (lo + hi);
    if (v * v * k > share * Math.min(LATERAL_G * Math.tan(spec.maxLean * leanScaleAt(spec, v)), gripCap)) hi = v; else lo = v;
  }
  return 0.5 * (lo + hi);
}

/** Speed (m/s) from which the lean ceiling starts to fall, and the speed where it has fallen all the way (see leanScaleAt). */
const LEAN_FALL_V0 = 34 * K;
const LEAN_FALL_V1 = 54 * K;
/** hsLeanLoss is the share of lean authority a bike loses at very high speed; the ceiling falls this many times faster than the raw share. */
const LEAN_FALL_GAIN = 2.1;
/**
 * Arcade cornering for the players' bikes (Race.js sets bike.assist and bike.roadCurve every tick; AI bikes have assist 0):
 *  - ROAD_ASSIST of the road's bend is turned for the rider automatically (yaw rate = assist * curve * speed), so what is
 *    left of the bend is felt as a push toward the outside that grows with curve * speed; the rider steers against it;
 *  - ASSIST_LEAN_KEEP: share of the high-speed steering loss an assisted bike still suffers (the rest is given back);
 *  - OFF_GAS_DECEL: extra slow-down (m/s^2) with the throttle closed, in place of a brake (the players have none).
 */
export const ROAD_ASSIST = 0.85, ASSIST_LEAN_KEEP = 0.45, OFF_GAS_DECEL = 2.2 * K;

/**
 * Share (0..1) of the bike's maxLean that full steer commands at speed v: it rises from 0 at a standstill to 1 by about 12 K m/s (the bars do
 * the turning below that), and then falls with speed, by spec.hsLeanLoss * 2.1 of the way at 54 K m/s (the top speeds are 50-52 K m/s), so that full steer at 200 km/h
 * is a lane change and not a swerve. The AI, the balance tools and bikeStats use the same function.
 * @param {{hsLeanLoss:number}} spec a bike spec
 * @param {number} v speed (m/s)
 * @returns {number} 0..1
 */
export function leanScaleAt(spec, v, assist = 0) {
  // an assisted (player) bike keeps more of its steering at high speed: there is no brake, so the bars must still bite at top speed
  const loss = Math.min(0.92, spec.hsLeanLoss * LEAN_FALL_GAIN) * (assist > 0 ? ASSIST_LEAN_KEEP : 1);
  return smooth01((v - 2 * K) / (10 * K)) * (1 - loss * smooth01((v - LEAN_FALL_V0) / (LEAN_FALL_V1 - LEAN_FALL_V0)));
}

/**
 * Advance one bike by dt seconds (mutates `bike` in place, allocation-free).
 * @param {object} bike BikeState
 * @param {{throttle:number,brake:number,steer:number,attack:(string|null),attackSide:number}} input
 * @param {number} dt step (normally DT)
 * @param {{heightAt:Function,normalAt?:Function,gripAt?:Function}} [track] defaults to flat ground
 * @returns {void}
 */
export function stepBike(bike, input, dt, track) {
  const b = bike;
  const s = b.spec;
  const tr = track || FLAT_TRACK;
  const gripAt = tr.gripAt || FLAT_TRACK.gripAt;
  const m = s.mass;

  // ---- inputs, stagger dulling ----
  let thr = clamp(input.throttle || 0, 0, 1);
  let brk = clamp(input.brake || 0, 0, 1);
  let st = clamp(input.steer || 0, -1, 1);
  b.attack = input.attack || null;
  b.attackSide = input.attackSide || 1;
  let wobble = 0;
  if (b.stagger > 0) {
    const k = Math.min(1, b.stagger * 2);
    wobble = Math.sin(b.stagger * 22) * k;
    thr *= 1 - 0.5 * k;
    brk *= 1 - 0.3 * k;
    st = st * (1 - 0.5 * k) + wobble * 0.5;
    b.stagger = Math.max(0, b.stagger - dt);
  }
  if (b.crashed) { thr = 0; brk = 0; st = 0; }
  b.throttle = thr; b.brake = brk; b.steer = st;

  const air = b.airborne;
  const gripNow = clamp(gripAt(b.pos.x, b.pos.z), 0, 1);
  const mu = Math.max(0.05, s.grip * gripNow);
  let v = b.speed;

  // ---- longitudinal ----
  // catch-up boost (Race.js sets bike.boost from the live place): thrust x boost and drag / boost^2, so both acceleration
  // and top speed scale by about the same factor. 1 = no effect.
  const bst = b.boost > 0 ? b.boost : 1;
  let a = 0;
  if (!air) {
    if (thr > 0) a += bst * thr * Math.min(s.power / Math.max(v, 3 * K), s.tractionFrac * mu * m * G) / m;
    a -= G_LONG * Math.sin(b.groundPitch); // slope
  }
  const av = Math.abs(v);
  a -= (s.drag / (bst * bst) * av * v + s.crr * m * G * clamp(v * 4 / K, -1, 1) * (air ? 0 : 1)) / m;

  const brkUse = air ? 0 : brk * Math.min(s.brake, mu * G_LONG);
  let decel = brkUse;
  if (b.crashed && !air) decel += 0.7 * mu * G_LONG;
  decel += 0.6 * G_LONG * mu * Math.abs(Math.sin(b.slip)) * (air ? 0 : 1); // drift scrub
  // off the tarmac (shoulder 0.1, off-road 0.3): the surface drags the bike down; it never feeds the slide
  const rough = air ? 0 : 1 - gripNow;
  if (rough > 0 && v > 0) decel += rough * (0.9 * K + 0.3 * v);
  if (b.assist > 0 && !air && thr <= 0 && !b.crashed) decel += OFF_GAS_DECEL * (1 - thr); // closing the throttle is the player's brake
  let vNew = v + a * dt;
  if (v > 0) { vNew -= decel * dt; if (vNew < 0) vNew = 0; }
  else if (vNew < 0) vNew = 0;
  b.accel += ((vNew - v) / dt - b.accel) * (1 - Math.exp(-K_ACCEL * dt));
  v = vNew;
  b.speed = v;

  // ---- lean ----
  const leanScale = leanScaleAt(s, v, b.assist || 0);
  // braking while leaned stands the bike up a little (the harder the brake, the more), so the line holds as the speed drops
  const standUp = standUpFactor(brk);
  // a rough surface unsettles the bars a little (deterministic: a function of where the bike is)
  const jig = rough * 0.35 * Math.sin(0.9 * (b.pos.x + b.pos.z)) * Math.min(1, v / (10 * K));
  let target = st * s.maxLean * leanScale * standUp + wobble * 0.12 * Math.min(1, v / (10 * K)) + jig;
  if (b.crashed) target = (b.lean >= 0 ? 1 : -1) * 1.45;
  target = clamp(target, -s.maxLean * (b.crashed ? 2 : 1), s.maxLean * (b.crashed ? 2 : 1));
  const wantRate = clamp((target - b.lean) * 8, -s.leanRate, s.leanRate);
  const dr = clamp(wantRate - b.leanRate, -s.leanAccel * dt, s.leanAccel * dt);
  b.leanRate += dr;
  b.lean += b.leanRate * dt;
  if (!b.crashed) {
    const lim = s.maxLean * 1.15;
    if (b.lean > lim) { b.lean = lim; if (b.leanRate > 0) b.leanRate = 0; }
    else if (b.lean < -lim) { b.lean = -lim; if (b.leanRate < 0) b.leanRate = 0; }
  }

  // ---- grip / drift ----
  // A slide has to be set up on purpose: a deep lean (> ~0.35 rad) AND a hard brake (> ~0.8) at speed. Merely asking for more than the tyres
  // give (overload) only starts a slow slide, and the first response to it is running wide (the yaw cap below), not a spin.
  // The load is measured against the tarmac grip: a low-grip surface limits the turn (cap) and drags (rough), it does not feed the slide.
  // (the lateral load and the tyre budget scale with K^2, the brake with K: the brake enters the combined load times K, the same load as before)
  const latD = LATERAL_G * Math.abs(Math.tan(b.lean));
  const tot = Math.hypot(latD, brkUse * K) / (s.grip * LATERAL_G);
  const over = Math.max(0, tot - 1.0);
  const hardB = smooth01((brk - 0.8) / 0.15);
  const leanF = smooth01((Math.abs(b.lean) - 0.35) / 0.12);
  const spdF = smooth01((v - 8 * K) / (12 * K));
  const drive = air ? 0 : hardB * leanF * spdF * 1.1 + over * 3 * smooth01((v - 3 * K) / (6 * K));
  const dirS = b.lean / (Math.abs(b.lean) + 0.05);
  let rec = 2;
  if (brk < 0.5) rec += 6; // let go of the brake: it straightens up quickly
  if (st * b.slip < 0) rec += 8 * Math.abs(st); // counter-steering
  b.slip = clamp((b.slip + dirS * drive * dt) / Math.exp(60 * Math.log(1 + rec / 60) * dt), -MAX_SLIP, MAX_SLIP);
  if (b.drifting) { if (Math.abs(b.slip) < SLIP_OFF) b.drifting = false; }
  else if (Math.abs(b.slip) > SLIP_ON) b.drifting = true;

  // ---- yaw ----
  const vy = Math.max(v, V_MIN);
  const cap = mu * LATERAL_G * 0.98 / vy; // what the tyres can turn: asking for more runs the bike wide
  let yawL = LATERAL_G * Math.tan(b.lean) / vy;
  yawL *= 1 + 0.9 * Math.abs(b.slip);
  yawL = clamp(yawL, -cap * (1 + 0.9 * Math.abs(b.slip)), cap * (1 + 0.9 * Math.abs(b.slip)));
  const yawDrift = b.slip * K * smooth01((v - 3 * K) / (7 * K));
  const delta = 0.5 * st;
  const yawBar = v * Math.tan(delta) / s.wheelbase;
  const w = smooth01((v - 3 * K) / (6 * K));
  let cmd = w * yawL + (1 - w) * yawBar + yawDrift + b.yawKick;
  if (b.assist > 0 && !air) cmd += b.assist * (b.roadCurve || 0) * v; // the road carries an assisted bike round most of the bend
  if (b.crashed) cmd = b.yawKick;
  if (air) cmd *= 0.3;
  b.yawRate += (cmd - b.yawRate) * (1 - Math.exp(-K_YAW * dt));
  b.yaw = wrapAngle(b.yaw + b.yawRate * dt);
  b.yawKick *= Math.exp(-K_YAWKICK * dt);
  b.latVel *= Math.exp(-K_LATVEL * dt);
  if (Math.abs(b.latVel) < 1e-4) b.latVel = 0;

  // ---- planar motion ----
  const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw);
  const fx = -sy, fz = -cy, lx = -cy, lz = sy;
  const vlat = -v * Math.tan(b.slip) + b.latVel;
  b.vel.x = fx * v + lx * vlat;
  b.vel.z = fz * v + lz * vlat;
  const x0 = b.pos.x, z0 = b.pos.z;
  b.pos.x += b.vel.x * dt;
  b.pos.z += b.vel.z * dt;

  // ---- ground sampling and vertical motion, at a fixed internal rate ----
  // Ground following, the take-off test (the ground falling away faster than a ballistic path) and landing are threshold logic
  // that is sensitive to the step size, so they always run at VERT_DT or finer: a 1/60 call does two vertical sub-steps, the
  // 1/120 game tick one. The planar position is interpolated across the sub-steps.
  const nv = Math.max(1, Math.round(dt / VERT_DT));
  const dtv = dt / nv;
  const hw = s.wheelbase * 0.5;
  let landed = 0, waF = 0, waR = 0, wvF = 0, wvR = 0;
  for (let k = 1; k <= nv; k++) {
    const px = nv === 1 ? b.pos.x : x0 + (b.pos.x - x0) * (k / nv);
    const pz = nv === 1 ? b.pos.z : z0 + (b.pos.z - z0) * (k / nv);
    const hF = tr.heightAt(px + fx * hw, pz + fz * hw);
    const hR = tr.heightAt(px - fx * hw, pz - fz * hw);
    const gy = 0.5 * (hF + hR);
    if (!b.wInit) {
      b.wInit = true;
      b.hF = hF; b.hR = hR; b.wvF = 0; b.wvR = 0;
      b.pos.y = gy; b.vel.y = 0;
    }
    wvF = (hF - b.hF) / dtv;
    wvR = (hR - b.hR) / dtv;
    waF = clamp((wvF - b.wvF) / dtv / (K * K), -60, 60); // wheel accelerations scale with v^2: normalised, the suspension is excited as before
    waR = clamp((wvR - b.wvR) / dtv / (K * K), -60, 60);
    b.hF = hF; b.hR = hR; b.wvF = wvF; b.wvR = wvR;
    b.groundPitch = Math.atan2(hF - hR, s.wheelbase);

    if (!b.airborne) {
      const yPrev = b.pos.y;
      const yBall = yPrev + b.vel.y * dtv - 0.5 * LATERAL_G * dtv * dtv; // the take-off test with the K^2 gravity: see AIR_CLEAR_60
      const dtr = dtv * 60;
      if (yBall > gy + AIR_CLEAR_60 * dtr * dtr) {
        b.airborne = true;
        b.vel.y -= G * dtv;
        b.pos.y = yBall;
      } else {
        const gv = clamp((gy - yPrev) / dtv, -40 * K, 40 * K);
        b.pos.y = gy;
        b.vel.y = gv;
      }
    } else {
      b.vel.y -= G * dtv;
      b.pos.y += b.vel.y * dtv;
      if (b.pos.y <= gy) {
        const gv = clamp(0.5 * (wvF + wvR), -40 * K, 40 * K);
        const l = Math.max(0, gv - b.vel.y);
        if (l > landed) landed = l;
        b.airborne = false;
        b.pos.y = gy;
        b.vel.y = gv;
      }
    }
  }

  // ---- suspension (base-excited spring-damper per wheel) ----
  const wn = Math.PI * 2 * s.suspFreq;
  const zeta = s.suspDamp;
  const axn = clamp(b.accel / (9 * K), -1, 1);
  const cTF = clamp(0.3 - 0.45 * axn, 0, 1);
  const cTR = clamp(0.3 + 0.35 * axn, 0, 1);
  const bump = b.airborne ? 0 : 1 / s.travel;
  const tF = b.airborne ? 0 : cTF;
  const tR = b.airborne ? 0 : cTR;
  if (landed > 0) {
    const add = clamp(landed * 0.1, 0, 1);
    b.suspF = clamp(b.suspF + add, 0, 1);
    b.suspR = clamp(b.suspR + add, 0, 1);
  }
  b.suspFv += (wn * wn * (tF - b.suspF) - 2 * zeta * wn * b.suspFv + waF * bump * 0.5) * dt;
  b.suspRv += (wn * wn * (tR - b.suspR) - 2 * zeta * wn * b.suspRv + waR * bump * 0.5) * dt;
  b.suspF += b.suspFv * dt;
  b.suspR += b.suspRv * dt;
  if (b.suspF < 0) { b.suspF = 0; if (b.suspFv < 0) b.suspFv = 0; }
  else if (b.suspF > 1) { b.suspF = 1; if (b.suspFv > 0) b.suspFv = 0; }
  if (b.suspR < 0) { b.suspR = 0; if (b.suspRv < 0) b.suspRv = 0; }
  else if (b.suspR > 1) { b.suspR = 1; if (b.suspRv > 0) b.suspRv = 0; }

  // ---- pitch ----
  let pT;
  if (b.airborne) pT = Math.atan2(b.vel.y, Math.max(Math.abs(v), K));
  else pT = b.groundPitch - (b.suspF - b.suspR) * 0.15;
  b.pitch += (pT - b.pitch) * (1 - Math.exp(-(b.airborne ? K_PITCH_AIR : K_PITCH_GND) * dt));
}

/** Perceived-speed value (see perceivedSpeed) reached at 100 % of top speed, and the shape of the climb to it. */
const FEEL_TOP = 1.15;
const FEEL_POW = 3.7;
/** Largest perceived speed the chase camera and the post effects use (a short boost of acceleration or a near pass can go above FEEL_TOP). */
export const FEEL_MAX = 1.17;
/** Upper limit of the camera shake amplitude (m): the shake grows with the perceived speed but never past this, so steering stays easy to judge. */
export const SHAKE_CAP = 0.0725; // = 0.004 + 0.05 FEEL_MAX^2, what Renderer.js's own shake law gives at FEEL_MAX

/**
 * The perceived speed (0..FEEL_TOP, a little above 1 for t > 1) the speed effects are driven by, from the share t = |speed| / topSpeed.
 * The real speeds are low, so the effects (FOV, blur, speed lines, vignette, camera pull-back) are driven by the SHARE of top speed and rise
 * early: about 1.06 at half of top speed (above about 0.9 the speed lines and the blur of the post pass begin to show), 1.15 at top speed.
 * @param {number} t share of top speed, >= 0
 * @returns {number}
 */
export function perceivedSpeed(t) {
  if (t <= 0) return 0;
  if (t >= 1) return FEEL_TOP + (t - 1) * 0.6;
  return FEEL_TOP * (1 - Math.pow(1 - t, FEEL_POW));
}

/**
 * Chase-camera parameters for a bike. All of them are driven by the share of top speed through perceivedSpeed (so they read the same at any
 * real top speed): FOV widens 58 -> about 100 deg (95 deg already at half of top speed), shake and lag grow with it (shake capped at SHAKE_CAP,
 * and doubled at most by a drift or a stagger), the camera pulls back and lags. Renderer.js applies the same laws to the smoothed value of
 * FxVelocity (which also carries the acceleration / near-pass boosts); this function is the unsmoothed version of them.
 * @param {object} bike BikeState
 * @param {{fov:number,shake:number,lag:number,dist:number,height:number}} [out] optional reuse target
 * @returns {{fov:number,shake:number,lag:number,dist:number,height:number}}
 */
export function cameraParams(bike, out) {
  const o = out || { fov: 0, shake: 0, lag: 0, dist: 0, height: 0 };
  const t = clamp(Math.abs(bike.speed) / bike.spec.topSpeed, 0, 1);
  const v = Math.min(perceivedSpeed(t), FEEL_MAX);
  const dr = bike.drifting ? 1 : 0;
  const sg = bike.stagger > 0 ? 1 : 0;
  o.fov = 58 + 37 * v;
  o.shake = Math.min(0.004 + 0.05 * v * v, SHAKE_CAP) * (1 + 0.8 * dr + 1.2 * sg);
  o.lag = 0.08 + 0.16 * Math.min(v, 1) + 0.08 * dr + 0.05 * sg;
  o.dist = 4.2 + 1.6 * Math.min(v, 1.1) + 0.4 * dr;
  o.height = 1.8 + 0.3 * Math.min(v, 1);
  return o;
}

// scratch for meleeHit
const _sh = { x: 0, y: 0, z: 0 };
const RIDER_RADIUS = 0.3;
const RIDER_H0 = 0.5;
const RIDER_H1 = 1.8;

/**
 * Test a swing from `attacker` on `side` (-1 right, +1 left) against the victim's rider capsule.
 * The weapon sweeps a horizontal sector (half-angle weapon.arc) about the lateral axis on that
 * side, with radius weapon.reach from the shoulder (which shifts with lean). relSpeed combines the
 * closing speed along the line of centres with the relative speed along the attacker's heading, so
 * an oncoming rider is hit much harder than one moving alongside.
 * @param {object} attacker BikeState
 * @param {object} victim BikeState
 * @param {string} weaponId key of WEAPONS
 * @param {number} side -1 swing right, +1 swing left
 * @param {boolean} [forgiving=true] false: the old reach and arc (reach0 / arc0), as the AI riders judge a swing
 * @returns {null|{damage:number,impulse:{x:number,y:number,z:number},stagger:number,relSpeed:number,point:{x:number,y:number,z:number}}}
 */
export function meleeHit(attacker, victim, weaponId, side, forgiving = true) {
  const w = WEAPONS[weaponId];
  if (!w || attacker.crashed || victim.crashed) return null;
  side = side < 0 ? -1 : 1;
  const ay = attacker.yaw, ac = Math.cos(ay), as = Math.sin(ay);
  const alx = -ac, alz = as; // attacker left
  const afx = -as, afz = -ac; // attacker forward
  const sl = Math.sin(attacker.lean), cl = Math.cos(attacker.lean);
  // shoulder: 1.35 m up the leaned body axis, 0.22 m out to the swing side
  const sh = 1.35;
  _sh.x = attacker.pos.x + alx * (sl * sh + side * 0.22 * cl);
  _sh.y = attacker.pos.y + cl * sh;
  _sh.z = attacker.pos.z + alz * (sl * sh + side * 0.22 * cl);
  const dx = alx * side, dz = alz * side; // swing axis (horizontal, outward)

  const vy = victim.yaw, vc = Math.cos(vy);
  const vlx = -vc, vlz = Math.sin(vy);
  const vsl = Math.sin(victim.lean), vcl = Math.cos(victim.lean);
  const cosArc = Math.cos(forgiving ? w.arc : w.arc0);
  const reach = forgiving ? w.reach : w.reach0;
  let best = Infinity, bpx = 0, bpy = 0, bpz = 0;
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const h = RIDER_H0 + (RIDER_H1 - RIDER_H0) * (i / N);
    const px = victim.pos.x + vlx * vsl * h;
    const py = victim.pos.y + vcl * h;
    const pz = victim.pos.z + vlz * vsl * h;
    const ex = px - _sh.x, ey = py - _sh.y, ez = pz - _sh.z;
    const d3 = Math.sqrt(ex * ex + ey * ey + ez * ez) - RIDER_RADIUS;
    if (d3 > reach) continue;
    const dh = Math.sqrt(ex * ex + ez * ez);
    const along = ex * dx + ez * dz;
    if (along <= 0) continue; // wrong side
    if (dh > 1e-3 && along / dh < cosArc) continue; // outside the arc
    if (d3 < best) { best = d3; bpx = px; bpy = py; bpz = pz; }
  }
  if (best === Infinity) return null;

  // relative velocity
  const rvx = attacker.vel.x - victim.vel.x;
  const rvz = attacker.vel.z - victim.vel.z;
  let nx = bpx - attacker.pos.x, nz = bpz - attacker.pos.z;
  const nl = Math.sqrt(nx * nx + nz * nz) || 1;
  nx /= nl; nz /= nl;
  const closing = Math.max(0, rvx * nx + rvz * nz);
  const passing = Math.abs(rvx * afx + rvz * afz);
  const relSpeed = Math.sqrt(closing * closing + passing * passing);

  // where a kick lands along the victim's bike: the attacker's foot goes straight out sideways, so it is the attacker's own
  // position measured along the victim's length. Within KICK_WHEEL.half of a wheel centre (+-KICK_WHEEL.at) it is a wheel kick.
  let wheel = false;
  if (w.shove) {
    const vfx = -Math.sin(victim.yaw), vfz = -Math.cos(victim.yaw);
    const along = (attacker.pos.x - victim.pos.x) * vfx + (attacker.pos.z - victim.pos.z) * vfz;
    wheel = Math.abs(Math.abs(along) - KICK_WHEEL.at) <= KICK_WHEEL.half;
  }
  const dmg = w.damage * (1 + Math.min(relSpeed / (12 * K), 5)); // relative speeds are judged as a share of the old (1 / K) speeds
  const J = w.impulse * (1 + Math.min(relSpeed / (10 * K), 4));
  let ix = dx * 0.85 + nx * 0.15, iz = dz * 0.85 + nz * 0.15;
  const il = Math.sqrt(ix * ix + iz * iz) || 1;
  ix = ix / il * J; iz = iz / il * J;
  return {
    damage: dmg,
    impulse: { x: ix, y: 0.1 * J, z: iz },
    stagger: (wheel ? w.wheelStagger : w.stagger) * (1 + Math.min(relSpeed / (20 * K), 1.5)),
    // a kick on a wheel: sideways shove away from the attacker (m/s); null for a punch or a kick on the body
    shove: wheel ? { x: dx * w.shove, z: dz * w.shove } : null,
    wheel,
    relSpeed,
    point: { x: bpx, y: bpy, z: bpz },
  };
}

/**
 * Share of a body-contact shove that a bike of mass `m` takes against one of mass `mo` (1 = equal masses): the lighter bike is pushed
 * further, the heavier one less. Half of the full momentum split (2 mo / (m + mo)), so the effect is felt but never decides a fight.
 * @param {number} m this bike's mass (kg)
 * @param {number} mo the other bike's mass (kg)
 * @returns {number}
 */
export function contactShare(m, mo) { return 0.5 + mo / (m + mo); }

/**
 * Apply a melee hit: damage, stagger, lateral velocity and yaw-rate/lean kick. Sets `crashed`
 * when health <= 0 or the velocity kick exceeds a stability threshold that shrinks with lean
 * and speed.
 * @param {object} victim BikeState
 * @param {{damage:number,impulse:{x:number,y:number,z:number},stagger:number}} hit result of meleeHit
 * @returns {void}
 */
/** Seconds a rider stays off balance after a punch / a kick (see Race.js: leaving the tarmac while off balance is a wipeout). */
export const OFF_BALANCE_PUNCH = 1.0, OFF_BALANCE_KICK = 2.2;
/** Yaw-rate kick (rad/s per m/s of shove) a wheel kick adds, turning the nose away from the attacker. */
export const KICK_YAW = 0.035;
export function applyHit(victim, hit) {
  const v = victim;
  const m = v.spec.mass;
  v.health = Math.max(0, v.health - hit.damage);
  v.stagger = Math.max(v.stagger, hit.stagger * v.spec.staggerMul);
  // off balance for a while after any blow (longer after a wheel kick): Race.js wipes out an off-balance rider who leaves the tarmac
  v.offBal = Math.max(v.offBal || 0, hit.shove ? OFF_BALANCE_KICK : OFF_BALANCE_PUNCH);
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  if (hit.shove) {
    // a kick on a wheel: the bike is shoved sideways, away from the attacker, and its nose is turned a little the same way.
    // A steadier bike (staggerMul < 1) is shoved less. The kick never knocks the rider off by itself: the traffic, the
    // wall or the roadside do that.
    const sL = hit.shove.x * -c + hit.shove.z * s; // along left, m/s (the same for every bike: the heavier bikes already wobble for a shorter time)
    v.latVel += sL;
    v.yawKick += sL * KICK_YAW;
    if (v.health <= 0) v.crashed = true;
    return;
  }
  const rL = (hit.impulse.x * -c + hit.impulse.z * s) / m; // along left (m/s of the impulse before the speed scale)
  const rF = (hit.impulse.x * -s + hit.impulse.z * -c) / m; // along forward
  // the sideways shove (latVel, yaw kick, lean kick) is geometric (metres of the same road, quick lean): not scaled; the forward speed change is the same share of the (lower) speeds
  const dvL = rL, dvF = rF * K;
  v.latVel += dvL;
  v.speed = Math.max(0, v.speed + dvF);
  v.yawKick += -dvL * 0.5;
  v.leanRate += rL * 1.5;
  const kick = Math.hypot(rL, rF); // judged in the old units against the old threshold
  const leanFrac = Math.min(1, Math.abs(v.lean) / v.spec.maxLean);
  const speedFrac = Math.min(1, Math.abs(v.speed) / v.spec.topSpeed);
  // pushing against the lean direction is stabilising, with it is destabilising
  const against = rL * v.lean < 0 ? 0.15 : -0.15;
  const threshold = 4.5 * v.spec.knock * (1 - 0.55 * leanFrac + against * leanFrac) / (1 + 0.6 * speedFrac);
  if (v.health <= 0 || kick > threshold) v.crashed = true;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Derived numbers and the 0-10 stat card (used by the bike select menu and the balance report). Pure functions of the spec.
// ---------------------------------------------------------------------------------------------------------------------------

/** Longitudinal acceleration (m/s^2) at speed v, full throttle, flat ground, the same formula as stepBike. */
function accelAt(s, v) {
  const m = s.mass;
  return (Math.min(s.power / Math.max(v, 3 * K), s.tractionFrac * s.grip * m * G) - s.drag * v * v - s.crr * m * G) / m;
}

/**
 * The real numbers behind a spec: top speed (nominal asymptote), the times (s, Infinity when out of reach in 90 s) to what used to be 100 km/h (z100) and 150 km/h (z200),
 * i.e. 100 K and 150 K real km/h (the same shares of top speed, so the same seconds as before),
 * braking distance from 100 km/h (m), steady cornering speed on a 60 m radius (km/h, lean- or grip-limited), and the rest of the stats.
 * @param {object} spec a BIKE_SPECS entry
 * @returns {{topKmh:number, z100:number, z200:number, brake100:number, corner60:number, maxLeanDeg:number, leanRate:number, mass:number, health:number, staggerResist:number, knock:number, tempo:number}}
 */
export function bikeStats(spec) {
  const dt = 1 / 120;
  let v = 0, t = 0, z100 = Infinity, z200 = Infinity; // z200: the time to 150 km/h now (the bikes no longer reach 200)
  while (t < 90 && z200 === Infinity) {
    v += accelAt(spec, v) * dt; t += dt;
    if (z100 === Infinity && v >= 100 * K / 3.6) z100 = t;
    if (v >= 150 * K / 3.6) z200 = t;
  }
  v = 100 * K / 3.6;
  let d = 0;
  const aB = Math.min(spec.brake, spec.grip * G_LONG);
  while (v > 0.01) { const a = aB + (spec.drag * v * v + spec.crr * spec.mass * G) / spec.mass; d += v * dt; v -= a * dt; }
  const vc = maxCornerSpeed(spec, 1 / 60, 1, spec.grip * LATERAL_G * 0.98);
  return {
    topKmh: spec.topKmh, z100, z200, brake100: d, corner60: vc * 3.6, maxLeanDeg: spec.maxLean * 180 / Math.PI, leanRate: spec.leanRate,
    mass: spec.mass, health: spec.health, staggerResist: 1 / spec.staggerMul, knock: spec.knock, tempo: spec.tempo,
  };
}

const n01 = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

/**
 * The stat card of a spec: four 0-10 scores derived from bikeStats (one decimal).
 *  Speed      top speed, 155..195 K km/h (K = SPEED_SCALE: the same scores as at the old real speeds).
 *  Accel      0-100 km/h (3.5..7 s) and 0-150 km/h (z200 field; 7..14 s), half each.
 *  Handling   lean rate (1.5..4.2 rad/s), steady cornering speed on a 60 m radius (82..92 K km/h) and lean acceleration, i.e. how quickly it
 *             changes direction (14..38 rad/s^2): 40 / 30 / 30 %.
 *  Toughness  health x knock-off resistance / stagger (0.7..1.7) and mass (220..400 kg), half each.
 * @param {object} spec a BIKE_SPECS entry
 * @returns {{speed:number, accel:number, handling:number, toughness:number}}
 */
export function statCard(spec) {
  const st = bikeStats(spec);
  const r1 = (x) => Math.round(x * 10) / 10;
  const a100 = 1 - n01(st.z100, 3.5, 7), a200 = 1 - n01(st.z200 === Infinity ? 99 : st.z200, 7, 14);
  const idx = (st.health / 100) * st.knock * st.staggerResist;
  return {
    speed: r1(10 * n01(st.topKmh, 155 * K, 195 * K)),
    accel: r1(10 * (0.5 * a100 + 0.5 * a200)),
    handling: r1(10 * (0.4 * n01(st.leanRate, 1.5, 4.2) + 0.3 * n01(st.corner60, 82 * K, 92 * K) + 0.3 * n01(spec.leanAccel, 14, 38))),
    toughness: r1(10 * (0.5 * n01(idx, 0.7, 1.7) + 0.5 * n01(st.mass, 220, 400))),
  };
}

/**
 * Seconds a rider must wait after a swing of `weaponId` before the next one (the weapon's own 0.25 s, stretched so that the whole cycle
 * windup + swing + recovery is `spec.tempo` times the weapon's).
 * @param {object} spec a BIKE_SPECS entry
 * @param {string} weaponId key of WEAPONS
 * @returns {number} seconds
 */
export function swingCooldown(spec, weaponId) {
  const w = WEAPONS[weaponId] || WEAPONS.punch;
  return Math.max(0, 0.25 + (w.windup + 0.45) * (spec.tempo - 1));
}
