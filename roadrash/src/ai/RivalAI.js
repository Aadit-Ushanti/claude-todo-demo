// AI rival riders: pure logic, no DOM or three.js. One brain per rival; rivalInput fills the same input object stepBike expects.
// The AI rides in track coordinates: it steers toward a target lateral offset d (keeping right of the centre line),
// feeds forward the lean for the curve ahead, brakes for corners with v^2 <= a_lat/|curve| looked up along the road,
// overtakes slower bikes/cars when the oncoming lane is clear, and swings at neighbours.
import { meleeHit, leanScaleAt, standUpFactor, maxCornerSpeed, SPEED_SCALE, LATERAL_G } from '../physics/BikePhysics.js';
import { personality } from '../game/Roster.js';
import { difficultyParams, normalizeDifficulty } from '../game/Difficulty.js';

// Every absolute speed / acceleration below is the old number times K (SPEED_SCALE): the AI behaves the same at the same share of top speed.
const K = SPEED_SCALE;
const G = 9.81 * K; // longitudinal (braking) acceleration scale; the lateral one is LATERAL_G
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sm01 = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rival's brain: the slot's fixed personality (pace, aggression, weapon, bike spec) plus state.
 * @param {number} slot grid slot 0..14
 * @param {number} [seed] race seed (only perturbs the small lane wobble phase, attack dice and mistakes)
 * @param {string} [difficulty] 'easy' | 'medium' | 'hard': scales pace, corner and braking confidence, overtaking, precision,
 *   swinging, weapon, defending, rubber band and mistakes (see game/Difficulty.js)
 * @returns {object} brain
 */
export function createBrain(slot, seed = 0, difficulty = 'medium') {
  const level = normalizeDifficulty(difficulty);
  const diff = difficultyParams(level);
  const p = personality(slot, level);
  const r = mulberry32((seed | 0) * 7727 + slot * 131 + 17);
  const mr = mulberry32((seed | 0) * 6971 + slot * 313 + 91);
  const weaponAI = personality(slot, 'medium').weapon; // AI-vs-AI scraps do not depend on the level (only swings at humans do)
  p.cruise *= diff.pace; p.cornerG *= diff.corner; p.brakeG *= diff.brake; p.wobble *= diff.wobble;
  return {
    ...p, weaponAI, id: slot, rand: r, diff, level, mrand: mr,
    mT: diff.mistakeEvery > 0 ? diff.mistakeEvery * (0.4 + 0.8 * mr()) : 1e9, mLeft: 0, mKind: 0,
    wobPhase: r() * 6.28, tgtD: p.laneD, side: 1, attackT: 1 + 2 * r(), commitT: 0, stuckT: 0, done: false,
    vErr: 0, cap: 0, matchT: 0, farT: 9,
  };
}


// module scratch (single threaded, reused every call)
let _v = 0, _d = 0, _s = 0, _pref = 0, _brain = null, _ctx = null, _aBf = 5 * K;
const MAXT = 40;
const PACK_RANGE = 50; // m: a human closer than this (along the road) is matched in speed
const MATCH_T = 20; // s of speed matching per encounter
const T_GAP = new Float64Array(MAXT), T_DS = new Float64Array(MAXT), T_OD = new Float64Array(MAXT), T_VO = new Float64Array(MAXT);
const T_CLR = new Float64Array(MAXT), T_HALF = new Float64Array(MAXT), T_PULL = new Float64Array(MAXT);
let _nT = 0;

/** Is the oncoming lane free for a pass that starts now? */
function laneClear(gap, closing, olen) {
  const cars = _ctx.cars;
  if (!cars) return true;
  const g = Math.min(gap, 14 + closing * 1.0);
  const tn = clamp((g + olen + 14) / Math.max(3 * K, closing), 1.2, 8); // the pass takes longer when the field is slower relative to the traffic (was capped at 4 s)
  const W = Math.min(400, ((_v + 22 * K) * tn + 25) * _brain.diff.clearK);
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active || c.vs >= 0 || c.hit) continue;
    const dc = c.s - _s;
    if (dc > -14 && dc < W) return false;
  }
  return true;
}

/** Highest speed from which we can still stop behind an object ahead (never below a crawl, so we can steer round). */
function followCap(vo, gap, margin, half) {
  let c = Math.sqrt(Math.max(0, vo * vo + 2 * _aBf * Math.max(0, gap - margin)));
  if (gap > 2 && c < 4.5 * K) c = 4.5 * K; // creep: a bike needs some speed to steer round, and a shove at this speed never crashes
  return c;
}

/** Record a possible obstacle (bike or car) for this tick. */
function consider(ds, od, vo, clr, half) {
  const closing = _v - vo;
  const gap = ds - half - 1.0;
  if (ds < 0) {
    const alongside = ds > -2.2;
    const passing = closing > 2 * K && ds > -(7 + half) && _brain.commitT > 0 && Math.abs(od - _d) < clr + 0.6;
    if (!alongside && !passing) return;
  } else {
    let thr = 14 + (closing > 0 ? closing * 2.5 + closing * closing / (2 * _aBf) : 0);
    if (thr > 480) thr = 480;
    if (gap > thr) return;
    if (closing < -4 * K && gap > 10) return;
  }
  if (_nT >= MAXT) return;
  const i = _nT++;
  T_GAP[i] = ds < 0 ? 0 : gap; T_DS[i] = ds; T_OD[i] = od; T_VO[i] = vo; T_CLR[i] = clr; T_HALF[i] = half;
  T_PULL[i] = ds < 0 ? 1e9 : (16 + Math.max(0, closing) * 1.2) * _brain.diff.pullK;
}

/**
 * Decide a rival's controls for this tick.
 * @param {object} brain from createBrain (mutated: timers/state)
 * @param {object} bike the rival's BikeState
 * @param {object[]} others every rider ({bike, s, d, kind}); the entry whose bike is `bike` is skipped
 * @param {number} dt seconds
 * @param {{throttle:number,brake:number,steer:number,attack:null|string,attackSide:number}} out filled in place
 * @param {{track:object, s:number, d:number, yaw:number, cars?:object[], racing?:boolean, raceT?:number, leaderS?:number}} ctx
 *   s/d/yaw: the rider's track coordinates now; leaderS: s of the best human (NaN/undefined: none)
 * @returns {object} out
 */
export function rivalInput(brain, bike, others, dt, out, ctx) {
  out.throttle = 0; out.brake = 0; out.steer = 0; out.attack = null; out.attackSide = brain.side;
  if (bike.crashed) return out;
  if (!ctx.racing) { out.brake = 1; return out; }
  const track = ctx.track, spec = bike.spec;
  const v = bike.speed, s = ctx.s, d = ctx.d;
  const hw = track.halfWidth;
  const mu = spec.grip;
  _v = v; _d = d; _s = s; _brain = brain; _ctx = ctx;
  const aBrake = Math.min(spec.brake, G * mu) * brain.brakeG; // brakeG <= ~0.5: stay under the physics' hard-braking drift threshold
  _aBf = Math.max(2.5 * K, aBrake);
  brain.commitT -= dt;
  const minD = -(hw - 0.9), maxD = hw - 0.9;
  const diff = brain.diff;
  _pref = brain.laneD + brain.wobble * Math.sin((ctx.raceT || 0) * 0.35 + brain.wobPhase);
  // mistakes (easy): now and then brake too early for a moment, or run wide to the right-hand edge
  let mistakeBrake = false;
  if (diff.mistakeEvery > 0 && ctx.racing) {
    brain.mT -= dt;
    if (brain.mT <= 0) { brain.mKind = brain.mrand() < 0.5 ? 0 : 1; brain.mLeft = 1 + 1.2 * brain.mrand(); brain.mT = diff.mistakeEvery * (0.6 + 0.8 * brain.mrand()); }
    if (brain.mLeft > 0) { brain.mLeft -= dt; if (brain.mKind === 0) mistakeBrake = true; else _pref = -(hw - 1.1); }
  }
  // defending (medium a little, hard a lot): a rider right behind us that is human, in our line: move to block it (never into the oncoming lane)
  if (diff.defend > 0 && !brain.done) {
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o.kind !== 'human' || o.bike.crashed) continue;
      const ds = o.s - s;
      if (ds < -3 && ds > -26 && Math.abs(o.d - d) < 3.2) { _pref += (clamp(o.d, minD, -0.7) - _pref) * diff.defend; break; }
    }
  }
  _pref = clamp(_pref, minD, Math.min(maxD, -0.45));

  // ---------- obstacles: bikes and cars around us ----------
  _nT = 0;
  for (let i = 0; i < others.length; i++) {
    const o = others[i], ob = o.bike;
    if (ob === bike) continue;
    const ds = o.s - s;
    if (ds < -9 || ds > 480) continue;
    consider(ds, o.d, ob.speed, 1.25, 1.0);
  }
  const cars = ctx.cars;
  if (cars) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;
      const ds = c.s - s;
      if (ds < -14 || ds > 480) continue;
      consider(ds, c.d, c.vs, c.wid * 0.5 + 0.9, c.len * 0.5);
    }
  }
  let tgt = _pref, cap = Infinity;
  if (_nT > 0) {
    // nearest object ahead, for the lane-window test and emergency rule
    let nearest = 0;
    for (let i = 1; i < _nT; i++) if (T_GAP[i] < T_GAP[nearest] && T_DS[i] > 0) nearest = i;
    if (T_DS[nearest] <= 0) nearest = -1;
    let laneOk = true, emergency = false;
    if (nearest >= 0) {
      const cl = v - T_VO[nearest];
      emergency = T_GAP[nearest] < Math.max(0, cl) * 1.15 + 6;
      laneOk = brain.commitT > 0 || emergency || laneClear(T_GAP[nearest], cl, T_HALF[nearest] * 2);
    }
    let best = NaN, bestCost = 1e18, freeFar = false;
    for (let c = minD; c <= maxD + 1e-6; c += 0.35) {
      let near = false, far = false;
      for (let i = 0; i < _nT; i++) {
        const dd = T_OD[i] - c;
        if ((dd < 0 ? -dd : dd) < T_CLR[i]) { far = true; if (T_GAP[i] <= T_PULL[i]) near = true; }
      }
      const lane = c > -0.6;
      if (!far && (!lane || laneOk)) freeFar = true;
      if (near) continue;
      if (lane && !laneOk) continue;
      const cost = (c - _pref) * (c - _pref) + 0.12 * (c - brain.tgtD) * (c - brain.tgtD) + (lane ? 0.8 * brain.diff.laneCost : 0);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (best === best) {
      tgt = best;
      if (tgt > -0.6 && _nT > 0 && brain.commitT <= 0.2) brain.commitT = 1.4;
    }
    // nothing clear to pass through: do not run into what blocks our line
    let ci = -1, cg = 1e9;
    for (let i = 0; i < _nT; i++) {
      if (T_DS[i] <= 0) continue;
      const dd = T_OD[i] - tgt, de = T_OD[i] - d;
      const blocks = (dd < 0 ? -dd : dd) < T_CLR[i] || ((de < 0 ? -de : de) < T_CLR[i] && T_GAP[i] < 30 + Math.max(0, v - T_VO[i]) * 0.7);
      if (blocks && T_GAP[i] < cg) { cg = T_GAP[i]; ci = i; }
    }
    // hard safety: something overlapping where we actually are, and we would not stop in time
    for (let i = 0; i < _nT; i++) {
      if (T_DS[i] <= 0) continue;
      const de = T_OD[i] - d;
      if ((de < 0 ? -de : de) >= T_CLR[i] + 0.1) continue;
      const cl = v - T_VO[i];
      const aH = 0.45 * Math.min(spec.brake, G * mu); // what a leaning bike can really shed (brake <= 0.5 in a bend)
      if (cl <= 0 || T_GAP[i] > cl * cl / (2 * aH) * 1.15 + cl * 0.6 + 10) continue;
      const hc = Math.sqrt(Math.max(0, T_VO[i] * T_VO[i] + 2 * aH * Math.max(0, T_GAP[i] - 3)));
      if (hc < cap) cap = hc;
    }
    if (ci >= 0 && (!freeFar || T_GAP[ci] < 30 + Math.max(0, v - T_VO[ci]) * 0.7)) cap = Math.min(cap, followCap(T_VO[ci], T_GAP[ci], 6, T_HALF[ci]));
  }
  tgt = clamp(tgt, minD, maxD);
  const rate = diff.laneRate * dt;
  brain.tgtD += clamp(tgt - brain.tgtD, -rate, rate);
  const dT = brain.tgtD;

  // ---------- corners: look along the road ----------
  const cv = track.edges.curve, nE = track.edges.n;
  const gripA = LATERAL_G * mu * 0.9;
  const cornerG = brain.cornerG;
  let vCorner = Infinity;
  const X = Math.min(420, v * v / (2 * aBrake) + 80);
  for (let x = 0; x <= X; x += 10) {
    let idx = ((s + x) * 0.5) | 0; if (idx > nE - 1) idx = nE - 1;
    const k = cv[idx];
    const ak = k < 0 ? -k : k;
    if (ak < 2e-4) continue;
    const kp = ak / Math.max(0.3, 1 - k * dT);
    const vA = maxCornerSpeed(spec, kp, cornerG, gripA); // the speed at which this bend asks exactly what the bike can give there (the lean ceiling falls with speed)
    const vc = Math.sqrt(vA * vA + 2 * aBrake * x);
    if (vc < vCorner) vCorner = vc;
  }

  // ---------- speed ----------
  let vT = brain.cruise; // the rival's own pace, the same on every bike type (the difficulty scales it equally)
  if (vT > spec.topSpeed * 0.95) vT = spec.topSpeed * 0.95;
  const lead = ctx.leaderS;
  if (lead === lead && lead !== undefined) {
    const x = clamp((lead - s) / (diff.rbAhead > 0.1 ? 350 : 300), -1, 1);
    vT *= 1 + (x > 0 ? diff.rbBehind : diff.rbAhead) * x;
  }
  // pack behaviour: near a human (within 50 m ahead or behind) the rival eases toward the human's speed, so the two can ride side by side and
  // fight: a rival behind a faster human pushes up to its speed (never above 97 % of its own top), a rival level with or ahead of a slower
  // human lifts to it; a human that is faster than the rival simply pulls away. The matching lasts MATCH_T seconds per encounter (it fades over
  // the last two), then the rival rides its own pace until the human has been out of range for a few seconds. Pure function of the state, same on every device.
  {
    let near = null, nearA = 1e9;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o.kind !== 'human' || o.bike === bike || o.bike.crashed || o.bike.speed < 0.4 * spec.topSpeed) continue; // (a parked or crawling human is not matched: it is passed)
      const a = Math.abs(o.s - s);
      if (a < nearA && Math.abs(o.d - d) < 12) { nearA = a; near = o; }
    }
    if (near && nearA < PACK_RANGE) {
      brain.farT = 0; brain.matchT += dt;
      const w = diff.match * sm01((PACK_RANGE - nearA) / (PACK_RANGE - 8)) * clamp((MATCH_T - brain.matchT) / 2, 0, 1);
      const vh = clamp(near.bike.speed, 0, spec.topSpeed * 0.97);
      if (w > 0 && (near.s > s - 2 || vT > vh)) vT += w * (vh - vT);
    } else { brain.farT += dt; if (brain.farT > 3) brain.matchT = 0; }
  }
  if (mistakeBrake) vT *= 0.55;
  if (brain.done) vT = 0;
  if (vCorner < vT) vT = vCorner;
  if (cap < vT) vT = cap;
  const psiRel = wrapPi(bike.yaw - ctx.yaw);
  const Lk = Math.max(10, v * 0.8);
  const psiDes = clamp((dT - d) / Lk, -0.3, 0.3);
  // knocked off line (heading far from what we want, or staggering): shed speed so the lean can win it back
  const lost = Math.abs(psiRel - psiDes) > 0.12 || bike.stagger > 0.2; // (a sideswipe's 0.1 s wobble does not count: two rivals touching side by side at the same speed used to crawl together at the 'lost' speed for the rest of the race)
  if (lost && vT > 10 * K) vT = Math.max(10 * K, Math.min(vT, v * 0.75));
  // wedged (stopped for seconds without having crashed): roll on through whatever is in the way, slowly
  if (v < 1.5 * K) brain.stuckT += dt; else brain.stuckT = Math.max(0, brain.stuckT - dt);
  if (brain.stuckT > 2 && vT < 6 * K) vT = 6 * K;
  brain.vT = vT; brain.cap = cap; brain.vCorner = vCorner; brain.nT = _nT;
  const err = vT - v;
  const ratio = v / spec.topSpeed;
  if (err > 0) out.throttle = clamp(ratio * ratio * ratio + 0.05 + err * 0.35 / K, 0, 1);
  else if (err < -0.8 * K) {
    // brake <= 0.5 never starts a rear-wheel slide; harder only upright
    const bmax = Math.abs(bike.lean) < 0.08 ? 1 : 0.5;
    out.brake = clamp((-err - 0.8 * K) * 0.3 / K, 0, bmax);
  }

  // ---------- steering ----------
  let idx0 = ((s + Math.max(0, v) * 0.12) * 0.5) | 0; if (idx0 > nE - 1) idx0 = nE - 1;
  const k0 = cv[idx0];
  const kPath = k0 / Math.max(0.3, 1 - k0 * d);
  const omega = v * kPath + 2.5 * (psiDes - psiRel);
  const vv = Math.max(v, K);
  let st;
  const lscNow = leanScaleAt(spec, v);
  const stBar = Math.atan(omega * spec.wheelbase / vv) / 0.5;
  if (lscNow > 0.05) {
    const stLean = Math.atan(omega * vv / LATERAL_G) / (spec.maxLean * lscNow);
    const w = sm01((v - 3 * K) / (6 * K));
    st = w * stLean + (1 - w) * stBar;
  } else st = stBar;
  out.steer = clamp(st / standUpFactor(out.brake), -1, 1); // braking stands the bike up a little: ask for that much more lean

  // ---------- attack ----------
  brain.attackT -= dt;
  if ((ctx.raceT || 0) >= diff.swingStart && brain.attackT <= 0 && bike.stagger <= 0) {
    let best = null, bestScore = 1e9, bside = 1, bHuman = false;
    for (let i = 0; i < others.length; i++) {
      const o = others[i], ob = o.bike;
      if (ob === bike || ob.crashed) continue;
      const ds = o.s - s;
      if (ds > 2.2 || ds < -2.2) continue;
      const lat = o.d - d;
      const al = lat < 0 ? -lat : lat;
      if (al < 0.35 || al > 2.6) continue;
      const hu = o.kind === 'human';
      const sc = al + (hu ? -0.5 : 0);
      if (sc < bestScore) { bestScore = sc; best = ob; bside = lat > 0 ? 1 : -1; bHuman = hu; }
    }
    if (best) {
      const h = meleeHit(bike, best, brain.weapon, bside, false); // the rivals judge a swing by the old, tighter reach: their attack rate is unchanged
      if (h) {
        brain.attackT = (0.5 + (1 - brain.aggression) * 2.2) * (bHuman ? diff.swingCd : 1);
        const p = bHuman ? Math.min(1, brain.aggression * diff.swingP) : brain.aggression * 0.2;
        if (brain.rand() < p) { brain.side = bside; out.attackSide = bside; out.attack = bHuman ? brain.weapon : brain.weaponAI; }
      } else brain.attackT = 0.08;
    } else brain.attackT = 0.1;
  }
  return out;
}
