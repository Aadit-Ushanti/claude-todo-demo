// AI rival riders: pure logic, no DOM or three.js. One brain per rival; rivalInput fills the same input object stepBike expects.
// The AI rides in track coordinates: it steers toward a target lateral offset d (keeping right of the centre line),
// feeds forward the lean for the curve ahead, brakes for corners with v^2 <= a_lat/|curve| looked up along the road,
// overtakes slower bikes/cars when the oncoming lane is clear, and swings at neighbours.
// The passing line is a live choice (no held-up timer): a blocked rival scores the oncoming lane (preferred when safe), a gap on the tarmac, the shoulder (its speed penalty plus a risk) and waiting
// (the wait for the oncoming lane to open) on every think tick; the level's `react` is how often it re-decides and its `sight` how well it judges. A rider alongside that moves away is pressed (followed
// across while it is still within reach, the swing comes sooner) and a rival ahead blocks the line a chaser is taking more firmly; neither follows a rider that is clearly gone.
import { meleeHit, RIVAL_REACH, leanScaleAt, standUpFactor, maxCornerSpeed, SPEED_SCALE, LATERAL_G } from '../physics/BikePhysics.js';
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
  const share = diff.pace + diff.paceSpread * (2 * p.pace01 - 1); // the rival's own pace: a share of ITS bike's top speed (same for every type), narrow spread per level so the field bunches
  p.cruise = Infinity; // an absolute cap in m/s (tests and tools may set one); the pace itself is share * top speed (see paceOf)
  p.cornerG *= diff.corner; p.brakeG *= diff.brake; p.wobble *= diff.wobble;
  return {
    ...p, share, weaponAI, id: slot, rand: r, diff, level, mrand: mr,
    mT: diff.mistakeEvery > 0 ? diff.mistakeEvery * (0.4 + 0.8 * mr()) : 1e9, mLeft: 0, mKind: 0,
    wobPhase: r() * 6.28, tgtD: p.laneD, side: 1, attackT: 1 + 2 * r(), commitT: 0, stuckT: 0, done: false,
    vErr: 0, cap: 0, matchT: 0, farT: 9,
    hp: -1, waitT: 0, rollT: 0, retalT: 0, openT: 0, openTake: false, chaseT: 0, backing: false, tracked: null, trackSwung: false,
    level: false, chBike: null, chD: 0, chVd: 0, covering: false, shT: 0,
    decT: diff.react, laneSeen: false, wantSh: false, laneOn: false, laneOffT: 9, // the live choice of the passing line (see the obstacle block)
    mateB: null, mateD: 0, mateVd: 0, mateT: 0, mateEv: 0, pressing: false, pressWas: false, pressOn: false, // the rider alongside and its sideways move (pressing)
    st: { pass: 0, contest: 0, punch: 0, kick: 0, wheel: 0, wheelHazard: 0, block: 0, shoulder: 0, lane: 0, press: 0, backOut: 0, holdFire: 0 }, // counters of the moves chosen (reports)
  };
}


/**
 * The speed (m/s) a rival aims for on a clear straight: its pace share of its own bike's top speed, times the catch-up boost the bike has now,
 * and never above an absolute cap `brain.cruise` when one is set.
 * @param {object} brain from createBrain
 * @param {{topSpeed:number}} spec the rival's bike spec
 * @param {number} [boost] the bike's catch-up boost (1 = none)
 * @returns {number} m/s
 */
export function paceOf(brain, spec, boost = 1) {
  const b = boost > 1 ? boost : 1;
  return Math.min(brain.cruise, brain.share * spec.topSpeed * b);
}

// module scratch (single threaded, reused every call)
let _v = 0, _d = 0, _s = 0, _pref = 0, _brain = null, _ctx = null, _aBf = 5 * K, _relax = 0;
const MAXT = 40;
const PACK_RANGE = 50; // m: a human closer than this (along the road) is matched in speed
const MATCH_T = 20; // s of speed matching per encounter
const T_GAP = new Float64Array(MAXT), T_DS = new Float64Array(MAXT), T_OD = new Float64Array(MAXT), T_VO = new Float64Array(MAXT);
const T_CLR = new Float64Array(MAXT), T_HALF = new Float64Array(MAXT), T_PULL = new Float64Array(MAXT), T_BIKE = new Uint8Array(MAXT);
let _nT = 0;

const LANE_D = -0.3; // lateral offsets right of this are the oncoming lane (the strip between a car and the centre line is not)
const SQUEEZE_M = 0.55; // m of the 1.25 m side clearance beside another bike that a Hard rival gives up (see Difficulty.squeeze)
const COVER_LEAD = 0.5; // s: a rival ahead blocks where the chaser behind will be in this time (its sideways speed carried on), not where it is
const PRESS_AHEAD = 3, PRESS_BACK = 3.2, PRESS_REACH = 2.8; // m: a rider within this box around us (ahead / behind along the road, to either side) is contesting our stretch of road
const PRESS_EVADE = 0.5; // how consistently (-1..1) a rider's sideways moves must be away from us before we press it
const PRESS_GAP = 1.0; // m: the lateral distance a rival closes to on a rider that moved away from it (a punch or a kick reaches)
const PASS_ACC = 3; // m/s^2 a rider may count on while pulling past (it is nearly always more)

/**
 * Is the oncoming lane free for a pass? The pass needs the rider to gain `gap + olen + margin` metres on the slower vehicle: at the closing speed
 * it has now, or, when it is following (closing ~ 0), at the speed it can build up from there. No oncoming car may reach the stretch of road
 * the rider will use before the pass is over (plus the level's safety margin); the cars' own speeds are used, so a slow, far car does not block.
 * @param {number} gap free distance to the vehicle ahead (m)
 * @param {number} closing speed difference to it (m/s, may be <= 0)
 * @param {number} olen its length (m)
 * @param {boolean} out true if the rider is already out in the oncoming lane (no swing-out time to add)
 */
function laneClear(gap, closing, olen, out) {
  const cars = _ctx.cars;
  if (!cars) return true;
  const need = (gap > 0 ? gap : 0) + olen + 9;
  const c0 = closing > 0 ? closing : 0;
  const T = ((-c0 + Math.sqrt(c0 * c0 + 2 * PASS_ACC * need)) / PASS_ACC * 1.3 + (out ? 0.3 : 1.0)) * _brain.diff.clearK; // (x 1.3 + 0.3 s: the real pass is slower than the ideal one: the throttle is held while swinging out, the car may be a van)
  const safe = _brain.diff.clearM;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active || c.vs >= 0 || c.hit) continue;
    const dc = c.s - _s;
    if (dc < -14) continue;
    if (dc - (_v + 0.5 * PASS_ACC * T - c.vs) * T < safe) return false;
  }
  return true;
}

/**
 * The same window test as laneClear for a pass that would start tau seconds from now, while the rider keeps following a blocker at vf m/s
 * (the oncoming cars come on at their own speed, the rider moves at vf). Used to estimate how long the wait for the oncoming lane would be.
 */
function laneClearAt(tau, vf, gap, olen) {
  const cars = _ctx.cars;
  if (!cars) return true;
  const need = (gap > 0 ? gap : 0) + olen + 9;
  const T = (Math.sqrt(2 * PASS_ACC * need) / PASS_ACC * 1.3 + 1.0) * _brain.diff.clearK;
  const safe = _brain.diff.clearM;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active || c.vs >= 0 || c.hit) continue;
    const dc = c.s - _s + (c.vs - vf) * tau;
    if (dc < -14) continue;
    if (dc - (vf + 0.5 * PASS_ACC * T - c.vs) * T < safe) return false;
  }
  return true;
}

const WAIT_HORIZON = 8; // s: the longest wait the rider can imagine for the oncoming lane to open (beyond it, 'not in sight')
const SHOULDER_RISK = 1.6; // s-equivalent: the cost of a pass off the tarmac besides its speed penalty (little room, no way back across the blocker's tail)

/**
 * The live choice between waiting behind a blocker and taking the shoulder (the oncoming lane and a gap on the tarmac have been looked at already and are not free):
 * waiting costs the seconds lost behind it until the oncoming lane opens (its speed deficit times the estimated wait, at most WAIT_HORIZON); the shoulder costs the
 * speed the rough surface takes off during the pass (the surface drag, as the physics applies it) plus a fixed risk. The level judges both with an error that
 * shrinks with its `sight`: a sharp rival sees the real costs, a poor one over-rates the shoulder and misjudges the wait.
 * @returns {boolean} true: take the shoulder
 */
function wantShoulder(bi, pace, rough) {
  const diff = _brain.diff;
  const vb = T_VO[bi] > 0 ? T_VO[bi] : 0;
  const gap = T_GAP[bi] > 0 ? T_GAP[bi] : 0;
  const deficit = clamp(1 - vb / Math.max(pace, 1), 0, 1);
  let W = WAIT_HORIZON;
  for (let tau = 0; tau <= WAIT_HORIZON; tau += 0.5) if (laneClearAt(tau, vb, gap, T_HALF[bi] * 2)) { W = tau; break; }
  const closing = Math.max(2.5 * K, 0.92 * pace - vb);
  const tPass = (gap + T_HALF[bi] * 2 + 9) / closing;
  const decel = rough * (0.9 * K + 0.3 * _v);
  const shoulder = 0.5 * decel * tPass * tPass / Math.max(_v, 4 * K) + SHOULDER_RISK;
  const blind = 1 - diff.sight;
  const e1 = 1 + blind * (0.7 * _brain.rand() - 0.2), e2 = 1 + blind * (1.4 * _brain.rand() - 0.7); // (a poor judge over-rates the shoulder on average and is noisy about the wait)
  return shoulder * e1 < W * deficit * e2;
}

/**
 * Would moving from lateral offset d to the line c run through the band a same-direction car ahead occupies, with a gap that does not last for the sideways move
 * (at the closing speed v now, 1.8 m/s sideways, 8 m to spare)? Cutting across the front of a car we are overtaking is how riders end up on its bonnet.
 */
function cutsLine(c, d, v) {
  for (let i = 0; i < _nT; i++) {
    if (T_DS[i] <= 0 || T_BIKE[i] || T_VO[i] < 0) continue;
    const lo = T_OD[i] - T_CLR[i], hi = T_OD[i] + T_CLR[i];
    if ((d < lo && c > hi) || (d > hi && c < lo)) { const cl = v > T_VO[i] ? v - T_VO[i] : 0; if (T_GAP[i] < cl * (c > d ? c - d : d - c) / 1.8 + 8) return true; }
  }
  return false;
}

/** Highest speed from which we can still stop behind an object ahead (never below a crawl, so we can steer round). */
function followCap(vo, gap, margin, half) {
  let c = Math.sqrt(Math.max(0, vo * vo + 2 * _aBf * Math.max(0, gap - margin)));
  if (gap > 2 && c < 4.5 * K) c = 4.5 * K; // creep: a bike needs some speed to steer round, and a shove at this speed never crashes
  return c;
}

/** Record a possible obstacle (bike or car) for this tick. */
function consider(ds, od, vo, clr, half, bike) {
  const closing = _v - vo;
  const gap = ds - half - 1.0;
  if (ds < 0) {
    const alongside = ds > -2.2;
    const passing = closing > 2 * K && ds > -(_brain.commitT > 0 ? 7 + half : half + 3.5) && Math.abs(od - _d) < clr + 0.6; // (still beside it, or its front within a few metres of our rear wheel: do not swing back in yet)
    if (!alongside && !passing) return;
  } else {
    let thr = 14 + (closing > 0 ? closing * 2.5 + closing * closing / (2 * _aBf) : 0);
    if (thr > 480) thr = 480;
    if (gap > thr) return;
    if (closing < -4 * K && gap > 10) return;
  }
  if (_nT >= MAXT) return;
  const i = _nT++;
  T_GAP[i] = ds < 0 ? 0 : gap; T_DS[i] = ds; T_OD[i] = od; T_VO[i] = vo; T_CLR[i] = clr - (bike ? _relax : 0); T_HALF[i] = half; T_BIKE[i] = bike ? 1 : 0;
  T_PULL[i] = ds < 0 ? 1e9 : (26 + Math.max(0, closing) * 1.2) * _brain.diff.pullK; // (a rider that is following closes slowly: the swing-out must start before the follow gap, 30 m, is reached, or it never starts)
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
  const hw = track.halfWidth, shW = track.shoulder > 0 ? track.shoulder : 0;
  const mu = spec.grip;
  _v = v; _d = d; _s = s; _brain = brain; _ctx = ctx;
  const aBrake = Math.min(spec.brake, G * mu) * brain.brakeG; // brakeG <= ~0.5: stay under the physics' hard-braking drift threshold
  _aBf = Math.max(2.5 * K, aBrake);
  brain.commitT -= dt; brain.shT -= dt;
  const minD = -(hw - 0.9), maxD = hw - 0.9;
  const diff = brain.diff;
  const A = bike.assist > 0 ? bike.assist : 0; // the road assist this bike has (the same one the humans have): the road turns the bike for the rider
  const bst = bike.boost > 1 ? bike.boost : 1;
  const launch = (ctx.raceT || 0) < 6; // the grid launch: the bikes ahead are on their way too, they steer us round but never hold the throttle back (a touch is a shove)
  _pref = brain.laneD + brain.wobble * Math.sin((ctx.raceT || 0) * 0.35 + brain.wobPhase);
  // mistakes (easy): now and then brake too early for a moment, or run wide to the right-hand edge
  let mistakeBrake = false;
  if (diff.mistakeEvery > 0 && ctx.racing) {
    brain.mT -= dt;
    if (brain.mT <= 0) { brain.mKind = brain.mrand() < 0.5 ? 0 : 1; brain.mLeft = 1 + 1.2 * brain.mrand(); brain.mT = diff.mistakeEvery * (0.6 + 0.8 * brain.mrand()); }
    if (brain.mLeft > 0) { brain.mLeft -= dt; if (brain.mKind === 0) mistakeBrake = true; else _pref = -(hw - 1.1); }
  }
  // who contests our position: the rider ahead in our line that we are not faster than by much (foe), a rider coming up behind in our line (chaser)
  let foe = null, foeSc = 1e9, chaser = null, chaseSc = 1e9, mate = null, mateSc = 1e9;
  const fast = (ob) => ob.speed > v - 1.5;
  for (let i = 0; i < others.length; i++) {
    const o = others[i], ob = o.bike;
    if (ob === bike || ob.crashed || o.finished) continue;
    const ds = o.s - s;
    if (ds > 30 || ds < -30) continue;
    const lat = o.d - d, al = lat < 0 ? -lat : lat;
    if (ds < PRESS_AHEAD && ds > -PRESS_BACK && al > 0.3 && al < PRESS_REACH && o.d <= LANE_D && (ob.speed - v < 3 * K && ob.speed - v > -3 * K)) { const sc = al + 0.25 * (ds < 0 ? -ds : ds); if (sc < mateSc) { mateSc = sc; mate = o; } } // (alongside or a bike length or two off, at about our pace: the road is contested)
    if (al > 2.8) continue;
    if (ds > -1.2) { const sc = (ds < 1.2 ? -4 : ds) + 3 * al; if (sc < foeSc) { foeSc = sc; foe = o; } }
    if (ds < -1.2 && ds > -26 && al < 3.2 && fast(ob)) { const sc = -ds + 3 * al; if (sc < chaseSc) { chaseSc = sc; chaser = o; } }
  }
  // covering: a rider coming up behind in our line is blocked, once we have reacted (never into the oncoming lane): we take the line the chaser is taking and
  // follow its sideways move (where it will be in a moment, not where it was), at the level's cover rate; the level scales how much
  brain.covering = false;
  if (chaser && diff.defend > 0 && !brain.done) {
    brain.chaseT += dt;
    if (brain.chBike === chaser.bike) brain.chVd += ((chaser.d - brain.chD) / dt - brain.chVd) * 0.3; else brain.chVd = 0;
    brain.chBike = chaser.bike; brain.chD = chaser.d;
    if (brain.chaseT >= diff.react) {
      const aim = chaser.d + clamp(brain.chVd, -4, 4) * COVER_LEAD;
      _pref += (clamp(aim, minD, -0.7) - _pref) * diff.defend; brain.covering = true;
      if (brain.chaseT - dt < diff.react) brain.st.block++;
    }
  } else { brain.chaseT = 0; brain.chBike = null; brain.chVd = 0; }
  // pressing: the rider alongside moves away while it is still within reach of us: we follow it across (at the level's press share and rate) and swing sooner, so that moving aside
  // does not get it out of the fight. Only while it is within reach (<= 2.8 m, level with us): once it is clearly gone the move stops (no pursuit). It costs the other rider no speed.
  brain.pressing = false;
  if (mate && diff.press > 0 && !brain.done && !(bike.offBal > 0)) {
    const lat = mate.d - d, sg = lat > 0 ? 1 : -1;
    if (brain.mateB === mate.bike) brain.mateVd += ((mate.d - brain.mateD) / dt - brain.mateVd) * 0.3; else { brain.mateVd = 0; brain.mateT = 0; brain.pressOn = false; brain.mateEv = 0; }
    brain.mateB = mate.bike; brain.mateD = mate.d; brain.mateT += dt;
    // it begins when the rider's sideways speed is away from us (a deliberate move, not the wobble of a line) and goes on until the rival has closed to about a bike's reach (1 m),
    // the rider comes back toward us by itself, or it is out of the box (above). The rival then goes back to its own line: nothing here follows a rider that has settled elsewhere
    const al = lat < 0 ? -lat : lat;
    // a rider that keeps getting out of our way (its sideways moves are away from us, move after move) is evading us; one that moves about for its own reasons (a car, its line) is not
    const away = brain.mateVd * sg;
    if (away > 0.3 || away < -0.3) brain.mateEv += ((away > 0 ? 1 : -1) - brain.mateEv) * 0.04;
    if (away > 0.5 && brain.mateEv > PRESS_EVADE) brain.pressOn = true; else if (brain.mateVd * sg < -0.5 || al <= PRESS_GAP + 0.15) brain.pressOn = false;
    if (brain.pressOn && brain.mateT >= diff.react) {
      if (!brain.pressWas) brain.st.press++;
      brain.pressing = true;
      const aim = mate.d - sg * PRESS_GAP + clamp(brain.mateVd, -4, 4) * 0.35;
      _pref += (clamp(aim, minD, -0.7) - _pref) * diff.press;
    }
  } else { brain.mateB = null; brain.mateVd = 0; brain.mateT = 0; brain.pressOn = false; brain.mateEv = 0; }
  brain.pressWas = brain.pressing;
  // an episode of approaching a rider and passing it (clean: no blow thrown meanwhile; contested: there was a fight)
  if (brain.tracked) {
    let tr = null;
    for (let i = 0; i < others.length; i++) if (others[i].bike === brain.tracked) { tr = others[i]; break; }
    if (!tr || tr.bike.crashed || tr.s - s > 40) brain.tracked = null;
    else if (tr.s - s < -2) { brain.st[brain.trackSwung ? 'contest' : 'pass']++; brain.tracked = null; }
  } else if (foe && foe.s - s > 1.5 && foe.s - s < 14 && !foe.bike.crashed) { brain.tracked = foe.bike; brain.trackSwung = false; }
  _pref = clamp(_pref, minD, Math.min(maxD, -0.45));

  // ---------- obstacles: bikes and cars around us ----------
  _nT = 0;
  // patience: held up behind something for a few seconds, a rider takes a tighter gap past another bike (up to 0.2 m less side clearance); past a car it never does (the car's body is 1.3 m
  // from its centre line and the rider's wobble and lag eat the rest): the shoulder is what gets a held-up rider by a car
  _relax = 0.2 * clamp((brain.waitT - 3) / 5, 0, 1);
  for (let i = 0; i < others.length; i++) {
    const o = others[i], ob = o.bike;
    if (ob === bike) continue;
    const ds = o.s - s;
    if (ds < -9 || ds > 480) continue;
    consider(ds, o.d, ob.speed, ds < 2 ? 1.25 - SQUEEZE_M * diff.squeeze : 1.25, 1.0, true); // (level with another rider the road is shared tighter: a rival keeps its own line a lot closer to the rider beside it, the more so the higher the level)
  }
  const cars = ctx.cars;
  if (cars) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;
      const ds = c.s - s;
      if (ds < -14 || ds > 480) continue;
      consider(ds, c.d, c.vs, (c.hit ? Math.max(c.len, c.wid) : c.wid) * 0.5 + 0.9, c.len * 0.5); // (a wreck tumbles: its clearance is its length)
    }
  }
  let tgt = _pref, cap = Infinity;
  if (_nT > 0) {
    // nearest object ahead, for the lane-window test and emergency rule
    let nearest = 0;
    for (let i = 1; i < _nT; i++) if (T_GAP[i] < T_GAP[nearest] && T_DS[i] > 0) nearest = i;
    if (T_DS[nearest] <= 0) nearest = -1;
    // an oncoming car about to meet us in the lane we are in (or about to enter): get back to the right and brake to merge behind whatever is there
    let threat = false;
    for (let i = 0; i < _nT; i++) {
      if (T_VO[i] >= 0 || T_DS[i] <= 0) continue;
      const ttc = T_GAP[i] / (v - T_VO[i] + 1e-3);
      if (ttc < 3.2 && ((T_OD[i] - d) < 0 ? d - T_OD[i] : T_OD[i] - d) < T_CLR[i] + 0.6) { threat = true; break; }
    }
    let laneOk = true, emergency = false;
    // the think tick: a blocked rival re-decides every `react` seconds (Easy slowest, Hard at once): it only notices that the oncoming lane has opened up on such a tick
    // (a lane it has seen as open stays open to it while it is; one that closes is dropped at once)
    let decide = false;
    if (nearest < 0) { brain.decT = diff.react; brain.laneSeen = false; }
    else { brain.decT -= dt; if (brain.decT <= 0) { decide = true; brain.decT += Math.max(diff.react, 1 / 60); if (brain.decT <= 0) brain.decT = diff.react; } }
    if (nearest >= 0) {
      const cl = v - T_VO[nearest];
      emergency = T_GAP[nearest] < Math.max(0, cl) * 1.15 + 6;
      const fresh = emergency || brain.commitT > 0 || laneClear(T_GAP[nearest], cl, T_HALF[nearest] * 2, d > LANE_D);
      if (fresh && (decide || brain.laneSeen || emergency || brain.commitT > 0)) brain.laneSeen = true; else brain.laneSeen = false;
      laneOk = brain.laneSeen;
    }
    // abort the pass (drop in behind) only while still behind what we are passing; level with it or past it, the way on is forward
    if (threat && (nearest < 0 || T_GAP[nearest] > 3)) laneOk = false;
    // the shoulder (see below): a pass that has begun stays on the shoulder side until the blocker is behind (no flicker back across its tail when the oncoming lane opens up)
    let shMode = false, shTrig = false;
    const minS = -(hw + shW - 1.3);
    if (shW > 0.5 && !(bike.offBal > 0) && bike.stagger <= 0.05 && !launch) {
      const cvS = track.edges.curve, nS = track.edges.n;
      let ck = 0;
      for (let x = 0; x <= 70; x += 10) { let ix = ((s + x) * 0.5) | 0; if (ix > nS - 1) ix = nS - 1; const k = cvS[ix] < 0 ? -cvS[ix] : cvS[ix]; if (k > ck) ck = k; }
      if (brain.shT > 0) shMode = true; else if (ck < 1.2e-3) shTrig = true; // (a pass that has begun is finished, a new one never starts in a bend; whether to start one is the live choice below)
    }
    if (!shMode) brain.shT = 0;
    let best = NaN, bestCost = 1e18, freeFar = false;
    for (let c = shMode ? minS : minD; c <= maxD + 1e-6; c += 0.35) {
      let near = false, far = false;
      for (let i = 0; i < _nT; i++) {
        const dd = T_OD[i] - c;
        if ((dd < 0 ? -dd : dd) < T_CLR[i] + (c <= LANE_D && T_BIKE[i] === 0 ? 0.25 : 0)) { far = true; if (T_GAP[i] <= T_PULL[i] * (brain.commitT > 0 ? 2 : 1)) near = true; /* once out, stay out: no flicker back into the blocked line */ }
      }
      const cuts = cutsLine(c, d, v); // (never cut across the front of a car we are still overtaking)
      const lane = c > LANE_D;
      if (c > 0.7) continue; // (the middle strip only: the oncoming cars drive at 2.5 m, further left is their line)
      if (!far && (!lane || laneOk)) freeFar = true;
      if (near || cuts) continue;
      if (lane && (!laneOk || shMode)) continue;
      // the oncoming lane is the preferred way past when it is safe: its cost is the level's fixed price, not the distance from the line the rider keeps (a gap on the tarmac that needs a real sideways move costs more)
      const cost = lane ? 0.8 * brain.diff.laneCost + 0.12 * (c - brain.tgtD) * (c - brain.tgtD) : (c - _pref) * (c - _pref) + 0.12 * (c - brain.tgtD) * (c - brain.tgtD);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    // held up with nothing free on the road (no gap beside the blocker, no safe pass through the oncoming lane): after a few seconds take the shoulder for a short pass,
    // accepting the off-road grip, and come back once the blocker is behind (the normal lines are free again then). Never in a bend, never while off balance
    // (a blow while off the tarmac is a wipeout), and never closer than 1.3 m to the outer edge of the shoulder (the wall and what stands beside the road are further out).
    if (best === best) { brain.wantSh = false; }
    else if (shTrig && nearest >= 0 && decide) {
      // live choice: scored again on every think tick, the answer holds until the next one
      let bi = -1, bg = 1e9;
      for (let i = 0; i < _nT; i++) if (T_DS[i] > 0 && T_VO[i] >= 0 && T_GAP[i] < bg && T_GAP[i] <= T_PULL[i] * 2) { bg = T_GAP[i]; bi = i; }
      brain.wantSh = bi >= 0 && wantShoulder(bi, paceOf(brain, spec, bst), 0.1);
    }
    if (best !== best && shTrig && brain.wantSh) {
      for (let c = minD - 0.35; c >= minS - 1e-6; c -= 0.35) {
        let free = true;
        for (let i = 0; i < _nT; i++) { const dd = T_OD[i] - c; if ((dd < 0 ? -dd : dd) < T_CLR[i] + (T_BIKE[i] === 0 ? 0.25 : 0) && T_GAP[i] <= T_PULL[i] * 2) { free = false; break; } }
        if (free) { best = c; break; }
      }
      if (best === best) { brain.st.shoulder++; brain.shT = 2; brain.wantSh = false; if (brain.commitT < 1.2) brain.commitT = 1.2; }
    } else if (shMode && best === best && best < minD - 0.01) { brain.shT = 2; if (brain.commitT < 0.6) brain.commitT = 0.6; }
    if (best !== best) {
      // nothing is free: take the line that overlaps what is around us the least (a car counts triple, an oncoming one five times, a bike once), close to where we are: never cut back across what we are passing
      let bp = 1e18;
      for (let c = minD; c <= Math.max(0.7, Math.min(maxD, d)) + 1e-6; c += 0.35) {
        let pen = 0.3 * (c > d ? c - d : d - c) + (cutsLine(c, d, v) ? 50 : 0);
        for (let i = 0; i < _nT; i++) {
          if (T_GAP[i] > T_PULL[i] * 2) continue;
          const dd = T_OD[i] - c, ov = T_CLR[i] - (dd < 0 ? -dd : dd);
          if (ov > 0) pen += (ov + 0.4) * (T_BIKE[i] ? 1 : T_VO[i] < 0 ? 5 : 3); // (a bike is a shove, a car a wreck; any overlap costs something, however small)
        }
        if (pen < bp) { bp = pen; best = c; }
      }
    }
    if (best === best) {
      tgt = best;
      if (tgt > LANE_D) { if (!brain.laneOn && nearest >= 0 && brain.laneOffT > 1) brain.st.lane++; brain.laneOffT = 0; } else brain.laneOffT += dt; // (a pass through the oncoming lane, counted once per episode: at least 1 s since the rider was last out there)
      brain.laneOn = tgt > LANE_D;
      if ((tgt > LANE_D || tgt > _pref + 0.9 || tgt < _pref - 0.9) && _nT > 0 && brain.commitT <= 0.2) brain.commitT = 1.4;
    }
    // nothing clear to pass through: do not run into what blocks our line
    let ci = -1, cg = 1e9;
    for (let i = 0; i < _nT; i++) {
      if (T_DS[i] <= 0 || (launch && T_BIKE[i])) continue;
      const dd = T_OD[i] - tgt, de = T_OD[i] - d;
      const clearsIt = (dd < 0 ? -dd : dd) >= T_CLR[i];
      const blocks = !clearsIt || ((de < 0 ? -de : de) < T_CLR[i] - 0.25 && T_GAP[i] < 30 + Math.max(0, v - T_VO[i]) * 0.7 && !(brain.commitT > 0 && T_GAP[i] > 5)); // (swinging out round it: the throttle is free, only the hard safety rule below can still hold us)
      if (blocks && T_GAP[i] < cg) { cg = T_GAP[i]; ci = i; }
    }
    // hard safety: something overlapping where we actually are, and we would not stop in time
    for (let i = 0; i < _nT; i++) {
      if (T_DS[i] <= 0 || (launch && T_BIKE[i])) continue;
      const de = T_OD[i] - d;
      if ((de < 0 ? -de : de) >= T_CLR[i] - 0.15) continue; // (the lines we choose clear it by T_CLR: only a real overlap holds us here, or a rider could never pass a car it follows closely)
      const cl = v - T_VO[i];
      const aH = 0.45 * Math.min(spec.brake, G * mu); // what a leaning bike can really shed (brake <= 0.5 in a bend)
      if (cl <= 0 || T_GAP[i] > cl * cl / (2 * aH) * 1.15 + cl * 0.6 + 10) continue;
      const hc = Math.sqrt(Math.max(0, T_VO[i] * T_VO[i] + 2 * aH * Math.max(0, T_GAP[i] - 3)));
      if (hc < cap) cap = hc;
    }
    // approaching a car while still in its lane (a pass not yet under way, a shoulder or lane pass that starts a few metres back, a rider that pulls in again): the closing speed is kept to
    // what the brakes can still take off before its tail (a bike that arrives faster has no way out if the pass is called off or the sideways move is late)
    for (let i = 0; i < _nT; i++) {
      if (T_DS[i] <= 0 || T_BIKE[i] || T_VO[i] < 0) continue;
      const de = T_OD[i] - d, ade = de < 0 ? -de : de;
      if (ade >= T_CLR[i] - 0.1 || v <= T_VO[i]) continue; // (a line we planned clears the car by T_CLR: only a rider still inside that clearance is limited)
      let lim = T_VO[i] + Math.sqrt(2 * 1.2 * _aBf * Math.max(0, T_GAP[i] - 3));
      // a shoulder pass that starts a few metres behind the car: no faster than the gap lasts for while the line is moved clear at about 1.8 m/s
      if (shMode && T_GAP[i] < 15) { const l2 = T_VO[i] + Math.max(0, T_GAP[i] - 1.5) / ((T_CLR[i] - ade + 0.25) / 1.8 + 0.25); if (l2 < lim) lim = l2; }
      if (lim < cap) cap = lim;
    }
    if (ci >= 0 && (!freeFar || T_GAP[ci] < 30 + Math.max(0, v - T_VO[ci]) * 0.7)) cap = Math.min(cap, followCap(T_VO[ci], T_GAP[ci], T_BIKE[ci] ? 1.5 : 6, T_HALF[ci])); // (a bike is followed close: a touch is a shove, not a wreck, and a pack could not accelerate otherwise)
  }
  tgt = clamp(tgt, -(hw + shW - 1.3), maxD);
  const rate = (brain.pressing ? diff.pressRate : brain.covering ? diff.cover : diff.laneRate) * dt;
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
    const kp = ak / Math.max(0.3, 1 - k * dT) - A * ak; // the road's assist turns the bike through its share of the bend: only the rest has to be leaned
    if (kp < 2e-4) continue;
    const vA = maxCornerSpeed(spec, kp, cornerG, gripA, A); // the speed at which this bend asks exactly what the bike can give there (the lean ceiling falls with speed)
    const vc = Math.sqrt(vA * vA + 2 * aBrake * x);
    if (vc < vCorner) vCorner = vc;
  }

  // ---------- speed ----------
  let vT = paceOf(brain, spec, bst); // the rival's own pace: its level's share of its own bike's top speed (the same share on every type)
  const lead = ctx.leaderS;
  if (lead === lead && lead !== undefined) {
    const x = clamp((lead - s) / diff.rbRange, -1, 1);
    vT *= 1 + (x > 0 ? diff.rbBehind : diff.rbAhead) * x;
  }
  // side by side the speeds are nearly equal: closing on a rider within 12 m ahead (in our line, not crawling) stays under about 2 m/s, so a pass is won
  // beside it (the fight, the other rider lifting or moving aside, the better line, the draft), not by pace. The rubber band above sets who catches whom
  // over tens of seconds; this only keeps the last metres slow enough to fight. A rider that has gone past is not held by it.
  if (!launch) {
    let bd = 12, lvD = 1e9, lvV = NaN;
    const vT0 = vT;
    const capW = 2.4 - 0.8 * diff.squeeze; // (a rider that has moved a lane aside no longer holds the one behind it)
    for (let i = 0; i < others.length; i++) {
      const o = others[i], ob = o.bike;
      if (ob === bike || ob.crashed || o.finished || ob.speed < 0.4 * spec.topSpeed) continue;
      const ds = o.s - s;
      if (ds > 0.5 && ds < bd && Math.abs(o.d - d) < capW) { bd = ds; const lim = ob.speed + 1.5 + 0.15 * ds; if (lim < vT) vT = lim; }
      const da = ds < 0 ? -ds : ds;
      if (da < lvD && da < (brain.level ? 7 : 6) && (o.d > d ? o.d - d : d - o.d) < 3 && ob.speed > 0.85 * vT0) { lvD = da; lvV = ob.speed; }
    }
    // two riders level with each other (within about a bike length and a half, in neighbouring lines, at a real pace) hold level: the one that has drawn level does not pull away
    // by more than the slipstream's edge, and the one that is slightly slower stretches (up to a share of the level's `hold`) to stay there. A slow rider is simply passed.
    brain.level = lvV === lvV && diff.hold > 0;
    if (brain.level) {
      if (vT > lvV + 0.35) vT = lvV + 0.35;
      else if (vT < lvV - 0.2) vT = Math.min(lvV - 0.2, vT + diff.hold * 0.06 * spec.topSpeed);
    }
  }
  if (mistakeBrake) vT *= 0.55;
  if (brain.done) vT = 0;
  if (vCorner < vT) vT = vCorner;
  if (cap < vT) vT = cap;
  const psiRel = wrapPi(bike.yaw - ctx.yaw);
  const Lk = Math.max(10, v * 0.8);
  const psiDes = clamp((dT - d) / Lk, -0.3, 0.3);
  // knocked off line (heading far from what we want, or staggering): shed speed so the lean can win it back
  const lost = Math.abs(psiRel - psiDes) > 0.2 || bike.stagger > 0.2; // (a sideswipe's 0.1 s wobble does not count: two rivals touching side by side at the same speed used to crawl together at the 'lost' speed for the rest of the race)
  if (lost && !launch && vT > 10 * K) vT = Math.max(10 * K, Math.min(vT, v * 0.75));
  // wedged (stopped for seconds without having crashed): roll on through whatever is in the way, slowly
  if (v < 1.5 * K) brain.stuckT += dt; else brain.stuckT = Math.max(0, brain.stuckT - dt);
  if (brain.stuckT > 2 && vT < 6 * K) vT = 6 * K;
  { const stuck = cap < 1e8 && v < 0.8 * paceOf(brain, spec, bst); brain.waitT = stuck ? brain.waitT + dt : Math.max(0, brain.waitT - 2 * dt); }
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
  let idxH = (s * 0.5) | 0; if (idxH > nE - 1) idxH = nE - 1;
  const omega = v * kPath + 2.5 * (psiDes - psiRel) - A * v * cv[idxH]; // (the assist adds A * curve * v of yaw rate by itself: steer only for the rest of the bend)
  const vv = Math.max(v, K);
  let st;
  const lscNow = leanScaleAt(spec, v, A);
  const stBar = Math.atan(omega * spec.wheelbase / vv) / 0.5;
  if (lscNow > 0.05) {
    const stLean = Math.atan(omega * vv / LATERAL_G) / (spec.maxLean * lscNow);
    const w = sm01((v - 3 * K) / (6 * K));
    st = w * stLean + (1 - w) * stBar;
  } else st = stBar;
  out.steer = clamp(st / standUpFactor(out.brake), -1, 1); // braking stands the bike up a little: ask for that much more lean

  // ---------- attack: a small scored choice among punch / kick / wheel kick (and holding fire), against whoever is in reach ----------
  brain.attackT -= dt;
  if (brain.hp < 0) brain.hp = bike.health;
  if (bike.health < brain.hp - 0.05) brain.retalT = 3; // we were hit: hit back, quickly
  brain.hp = bike.health;
  brain.retalT -= dt;
  const hpShare = bike.health / spec.health;
  const backing = hpShare < diff.backOut;
  if (backing && !brain.backing) brain.st.backOut++;
  brain.backing = backing;
  const retal = brain.retalT > 0;
  if ((ctx.raceT || 0) >= diff.swingStart && brain.attackT <= 0 && bike.stagger <= 0 && !brain.done && !backing) {
    let bestSc = -1e9, bside = 1, bweapon = null, bwheel = false, bhz = 0, btarget = null;
    const noisy = diff.sight < 0.3;
    for (let i = 0; i < others.length; i++) {
      const o = others[i], ob = o.bike;
      if (ob === bike || ob.crashed || o.finished) continue;
      const ds = o.s - s;
      if (ds > 2.2 || ds < -2.2) continue;
      const lat = o.d - d, al = lat < 0 ? -lat : lat;
      if (al < 0.35 || al > 2.6) continue;
      if (o.kind === 'ai' && (o.d > LANE_D || o.d < -(hw - 0.9))) continue; // a rival in the oncoming lane (mid-pass), within a metre of the tarmac's edge or on the shoulder (a pass) is not hit by another rival: a blow there is a wreck (off balance and off the tarmac)
      const side = lat > 0 ? 1 : -1;
      const fg = o.kind !== 'ai' ? RIVAL_REACH : false; // (at a human: a longer reach on the rival's own arc, as Race.swingAt resolves it)
      let hP = meleeHit(bike, ob, 'punch', side, fg), hK = meleeHit(bike, ob, 'kick', side, fg);
      // a rival does not shove another rival into a car, the oncoming lane or off the tarmac with a wheel kick (that is for a human it wants to put out of the race: the level's `sight`); it fights its fellow riders for the road, it does not wreck them
      let hzO = 0;
      if (hK && hK.wheel && o.kind === 'ai') { hzO = hazardOf(o, side, ctx); if (hzO >= 0.5) hK = null; }
      if (!hP && !hK) continue;
      const wear = 1 - ob.health / ob.spec.health;
      const base = 0.4 + (o === foe ? 0.6 : 0) + 0.4 * wear + (retal ? 0.5 : 0);
      if (hP) { const sc = base + 0.6 + (brain.weapon === 'punch' ? 0.15 : 0) + (noisy ? 0.5 * brain.rand() : 0); if (sc > bestSc) { bestSc = sc; bside = side; bweapon = 'punch'; bwheel = false; bhz = 0; btarget = o; } }
      if (hK) {
        let hz = 0, sc;
        if (hK.wheel) { hz = o.kind === 'ai' ? hzO : hazardOf(o, side, ctx); sc = base + 0.9 + diff.sight * 1.6 * hz + (brain.weapon === 'kick' ? 0.15 : 0); } else sc = base + 0.5 + (brain.weapon === 'kick' ? 0.15 : 0);
        if (noisy) sc += 0.5 * brain.rand();
        if (sc > bestSc) { bestSc = sc; bside = side; bweapon = 'kick'; bwheel = !!hK.wheel; bhz = hz; btarget = o; }
      }
    }
    // hold fire unless the opening is worth it (more demanding when hurt)
    if (bweapon && bestSc > 0.85 + Math.max(0, 0.5 - hpShare) * 2) {
      // the dice are rolled when an opening starts and again every 1.5 s it lasts (an opening that goes on is a fresh chance; while it presses a rider that moved away, every 0.4 s)
      brain.rollT -= dt;
      if (brain.openT <= 0 || (!brain.openTake && brain.rollT <= 0)) { brain.openTake = retal || brain.rand() < clamp(diff.take * (0.55 + 0.9 * brain.aggression), 0, 1); brain.rollT = brain.pressing ? 0.4 : 1.5; }
      brain.openT += dt;
      const need = diff.react * (0.8 + 0.4 * (1 - brain.aggression)) * (retal ? 0.5 : 1) * (brain.pressing ? 0.4 : 1);
      if (brain.openTake && brain.openT >= need) {
        out.attack = bweapon; out.attackSide = bside; brain.side = bside;
        brain.attackT = diff.swingCd * (0.25 + 0.5 * (1 - brain.aggression)); // recovery: the weapon's own cycle comes on top
        brain.openT = 0;
        if (bweapon === 'punch') brain.st.punch++; else if (bwheel) { brain.st.wheel++; if (bhz > 0.5) brain.st.wheelHazard++; } else brain.st.kick++;
        if (btarget && brain.tracked === btarget.bike) brain.trackSwung = true;
        else brain.trackSwung = brain.trackSwung || (btarget === foe);
      }
    } else { if (bweapon) brain.st.holdFire++; brain.openT = brain.openT > dt * 2 ? brain.openT - dt * 2 : 0; }
  } else if (brain.attackT > 0 || backing) brain.openT = 0;
  return out;
}

/** How dangerous is the place a wheel kick from `side` would shove rider `o` to: off the tarmac while off balance, into a car ahead, into an oncoming car (0..1.6). */
function hazardOf(o, side, ctx) {
  const hw = ctx.track.halfWidth, nd = o.d + side * 1.4;
  let hz = 0;
  if (nd > hw - 0.3 || nd < -(hw - 0.3)) hz += 1;
  const cars = ctx.cars;
  if (cars) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;
      const ahead = c.s - o.s;
      if (ahead < -2 || ahead > (c.vs < 0 ? 45 : 35)) continue;
      const lat = c.d - nd;
      if ((lat < 0 ? -lat : lat) < c.wid * 0.5 + 0.7 && (c.vs < 0 || o.bike.speed - c.vs > 2)) { hz += c.vs < 0 ? 1.2 : 0.9; break; }
    }
  }
  return hz < 1.6 ? hz : 1.6;
}
