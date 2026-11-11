// LEGACY procedural low-poly motorbike + rider (shapes built in code, no textures). Kept as the fallback shown until the
// textured models of Bikes.js (assets/bikes/*.glb) have loaded. Also owns the LIVERIES table.
import * as THREE from '../../public/vendor/three.module.min.js';
import { Mesher, patchMasked, ss, clamp, MODEL_SCALE } from './util.js';

const WR = 0.33;
const REAR = [0, WR, 0.70];
const FRONT = [0, WR, -0.72];
const HEAD = [0, 0.97, -0.40];
const AXLE = [FRONT[0] - HEAD[0], FRONT[1] - HEAD[1], FRONT[2] - HEAD[2]]; // front axle relative to the steering head
const FORK_UP = new THREE.Vector3(-AXLE[0], -AXLE[1], -AXLE[2]).normalize();
const SHOULDER = [0.2, 1.28, -0.02];
const SWING_T = 0.3;

/** 15 liveries: [paint, suit, helmet]. Slot 0 (player) is distinctive. */
export const LIVERIES = [
  [0xd7151c, 0xc8121a, 0xf2f2ee], // player: Ducati-red bike, red/black leathers, white helmet
  [0xe63b2e, 0x1b1b1f, 0xe63b2e], [0x1f6fe0, 0xe9edf5, 0x1f6fe0], [0x2bb673, 0x222a2f, 0x2bb673],
  [0xff7a1a, 0x34353b, 0xff7a1a], [0x8e44ad, 0xd7d9de, 0x8e44ad], [0x1abc9c, 0x1d3557, 0xffffff],
  [0xd9d9d9, 0x8a1c1c, 0x111111], [0xc0392b, 0x2a2a2a, 0xf0c419], [0x2d3a8c, 0xf0c419, 0x2d3a8c],
  [0x6b8e23, 0x3b2f2a, 0x6b8e23], [0xe84393, 0x242424, 0xe84393], [0x00a8cc, 0x444a52, 0x00a8cc],
  [0xa04000, 0xd9c8a3, 0xa04000], [0x7f8c8d, 0x10161d, 0xffffff],
];

function wheelGeo() {
  const m = new Mesher();
  m.torusX(0.265, 0.062, [0, 0, 0], 0x141416, 0, 16, 6);
  m.torusX(0.205, 0.016, [0, 0, 0], 0xb8bcc4, 0, 14, 4);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    m.box(0.025, 0.42, 0.03, [0, 0, 0], k % 2 ? 0xd7dae0 : 0xb0b4bc, 0, [a, 0, 0]);
  }
  m.cyl(0.05, 0.05, [-0.06, 0, 0], [0.06, 0, 0], 0x8a8f99, 0, 8);
  m.box(0.1, 0.05, 0.05, [0, 0.19, 0], 0xff3b2a); // valve-ish marker so spin reads
  return m.build();
}

function bodyGeo() {
  const m = new Mesher();
  const metal = 0x30323a, chrome = 0xc9ced6, black = 0x141417;
  // engine, frame, swingarm
  m.box(0.26, 0.28, 0.40, [0, 0.46, 0.12], metal);
  m.box(0.22, 0.2, 0.22, [0, 0.64, -0.06], 0x44474f, 0, [0.35, 0, 0]);
  m.cyl(0.085, 0.085, [0.1, 0.43, 0.2], [0.19, 0.43, 0.2], 0x7b808a, 0, 8);
  m.cyl(0.025, 0.025, [0, 0.97, -0.38], [0, 0.72, 0.36], black);
  m.cyl(0.025, 0.025, [0, 0.95, -0.38], [0, 0.38, -0.05], black);
  m.cyl(0.02, 0.02, [0, 0.72, 0.36], [0, 0.8, 0.85], black);
  for (const sx of [-1, 1]) {
    m.cyl(0.022, 0.022, [sx * 0.1, 0.4, 0.3], [sx * 0.1, WR, 0.70], 0x2a2c33);
    m.cyl(0.02, 0.02, [sx * 0.12, 0.7, 0.55], [sx * 0.1, 0.4, 0.62], 0xd9a400); // shocks
    m.box(0.06, 0.03, 0.14, [sx * 0.24, 0.33, 0.2], black); // pegs
  }
  // tank, seat, tail
  m.sph(0.17, 0.125, 0.30, [0, 0.86, -0.12], 0xffffff, 1, [-0.12, 0, 0], 10, 7);
  m.box(0.2, 0.07, 0.52, [0, 0.8, 0.38], black);
  m.sph(0.14, 0.1, 0.34, [0, 0.9, 0.78], 0xffffff, 1, [0.1, 0, 0], 8, 6);
  m.box(0.14, 0.05, 0.025, [0, 0.9, 1.1], 0xff2a1a, 5);
  m.box(0.05, 0.04, 0.22, [0, 0.74, 1.02], black); // rear fender
  // exhaust
  m.cyl(0.03, 0.03, [0.1, 0.52, -0.1], [0.19, 0.34, 0.05], chrome, 0, 6);
  m.cyl(0.045, 0.05, [0.19, 0.34, 0.05], [0.23, 0.46, 0.9], chrome, 0, 8);
  m.cyl(0.05, 0.06, [0.23, 0.46, 0.88], [0.24, 0.47, 1.04], 0x6e727a, 0, 8);
  // rider: legs + boots
  const suit = 2, boot = 0x15151a;
  for (const sx of [-1, 1]) {
    const hip = [sx * 0.14, 0.9, 0.34], knee = [sx * 0.25, 0.66, 0.02], foot = [sx * 0.2, 0.38, 0.22];
    m.cyl(0.085, 0.07, hip, knee, 0xffffff, suit, 7);
    m.cyl(0.07, 0.055, knee, foot, 0xffffff, suit, 7);
    m.sph(0.075, 0.075, 0.075, knee, 0xffffff, suit, null, 6, 4);
    m.box(0.1, 0.09, 0.26, [foot[0], foot[1] - 0.02, foot[2] - 0.05], boot);
  }
  m.sph(0.18, 0.12, 0.16, [0, 0.9, 0.38], 0xffffff, suit, null, 8, 6); // hips
  // torso (leans forward), racing stripe, pack
  m.sph(0.19, 0.34, 0.15, [0, 1.1, 0.17], 0xffffff, suit, [-0.85, 0, 0], 9, 7);
  m.sph(0.05, 0.33, 0.158, [0, 1.1, 0.17], 0xffffff, 1, [-0.85, 0, 0], 6, 6);
  m.sph(0.1, 0.1, 0.08, [-0.2, 1.3, -0.02], 0xffffff, suit, null, 6, 4);
  m.sph(0.1, 0.1, 0.08, [0.2, 1.3, -0.02], 0xffffff, suit, null, 6, 4);
  // helmet + visor
  m.sph(0.135, 0.145, 0.165, [0, 1.44, -0.2], 0xffffff, 3, null, 10, 8);
  m.box(0.2, 0.075, 0.08, [0, 1.44, -0.345], 0x0a0c12, 0, [0.12, 0, 0]);
  m.box(0.05, 0.05, 0.1, [0, 1.55, -0.2], 0xffffff, 1);
  return m.build();
}

function forkGeo() {
  // origin = steering head
  const m = new Mesher();
  const chrome = 0xc3c8d0, black = 0x141417;
  for (const sx of [-1, 1]) {
    m.cyl(0.032, 0.03, [sx * 0.09, 0.03, 0.01], [sx * 0.09, -0.3, -0.15], 0x888d96, 0, 7);
    m.cyl(0.024, 0.024, [sx * 0.09, -0.3, -0.15], [sx * 0.09, AXLE[1], AXLE[2]], chrome, 0, 7);
    m.cyl(0.015, 0.015, [sx * 0.2, 0.1, 0.02], [sx * 0.42, 0.13, 0.06], black, 0, 5); // bars
    m.cyl(0.021, 0.021, [sx * 0.38, 0.13, 0.055], [sx * 0.52, 0.14, 0.07], 0x0b0b0d, 0, 6); // grips
    m.box(0.05, 0.05, 0.1, [sx * 0.2, 0.18, -0.03], 0x9aa0a8); // mirrors/levers
  }
  m.box(0.3, 0.05, 0.08, [0, 0.0, 0.0], 0x4a4d55);
  m.sph(0.1, 0.1, 0.08, [0, 0.04, -0.12], 0x111114, 0, null, 8, 6);
  m.sph(0.075, 0.075, 0.05, [0, 0.04, -0.2], 0xffffff, 4, null, 8, 5);
  m.box(0.3, 0.22, 0.015, [0, 0.2, -0.1], 0x2a3a4a, 0, [-0.7, 0, 0]);
  // front fender (paint)
  m.box(0.14, 0.03, 0.44, [0, AXLE[1] + 0.39, AXLE[2] - 0.02], 0xffffff, 1, [-0.4, 0, 0]);
  return m.build();
}

function armGeo(sx) {
  // origin = shoulder; sx = -1 left, +1 right
  const m = new Mesher();
  const el = [sx * 0.19, -0.16, -0.14], hand = [sx * 0.16, -0.23, -0.36];
  m.cyl(0.055, 0.048, [0, 0, 0], el, 0xffffff, 2, 7);
  m.sph(0.05, 0.05, 0.05, el, 0xffffff, 2, null, 6, 4);
  m.cyl(0.048, 0.04, el, hand, 0xffffff, 2, 7);
  m.sph(0.058, 0.055, 0.065, [hand[0], hand[1] - 0.005, hand[2] - 0.02], 0x141417, 0, null, 7, 5);
  return m.build();
}

function weaponGeo(kind) {
  const m = new Mesher();
  if (kind === 'baton') {
    m.cyl(0.02, 0.02, [0, 0, 0.12], [0, 0, -0.62], 0x1b1b1f, 0, 6);
    m.cyl(0.026, 0.026, [0, 0, -0.5], [0, 0, -0.62], 0xe9e9ee, 0, 6);
    m.cyl(0.025, 0.025, [0, 0, 0.12], [0, 0, 0.0], 0x6b4a2b, 0, 6);
  } else if (kind === 'chain') {
    for (let i = 0; i < 7; i++) {
      const t = i / 6, a = t * 1.2;
      const p = [Math.sin(a) * 0.55 * t, 0, -0.1 - Math.cos(a) * 0.62 * t];
      m.cyl(0.012, 0.012, [p[0] - 0.015, 0, p[2] - 0.02], [p[0] + 0.015, 0, p[2] + 0.02], 0xb9bec6, 0, 4);
      m.torusX(0.032, 0.008, p, 0xaeb3bb, 0, 6, 3);
    }
    m.sph(0.06, 0.06, 0.06, [0.52, 0, -0.62], 0x2b2b2f, 0, null, 6, 5);
  } else { // punch: a pronounced glove
    m.sph(0.08, 0.075, 0.09, [0, 0, -0.1], 0xd8d8de, 0, null, 7, 5);
  }
  return m.build();
}

/**
 * Creates the rider system. Calls `attach(object3D)` for every object that goes in the scene.
 * @returns {{update:Function, get:Function, hideAll:Function, setHidden:Function, riders:Array}}
 */
export function createProcRiders(scene, shadow) {
  // two detail levels share one geometry system: the player (slot 0) gets smoother curves than the rivals
  const setHi = (d) => { Mesher.detail = d; return { wheelG: wheelGeo(), bodyG: bodyGeo(), forkG: forkGeo(), armG: [armGeo(-1), armGeo(1)] }; };
  const GEO_HI = setHi(2.4), GEO_LO = setHi(1.35);
  Mesher.detail = 1;
  let wheelG, bodyG, forkG, armG;
  const weaponG = { punch: weaponGeo('punch'), baton: weaponGeo('baton'), chain: weaponGeo('chain') };
  const plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, envMapIntensity: 1.0 });
  patchMasked(plain);
  const weaponMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.8 });
  patchMasked(weaponMat);
  const riders = [];
  let shadowQ = 'high';
  const _q = new THREE.Quaternion();
  const _ax = new THREE.Vector3();

  function make(slot) {
    const lv = LIVERIES[slot % LIVERIES.length];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1, envMapIntensity: 1.1 });
    patchMasked(mat, lv[0], lv[1], lv[2]);
    ({ wheelG, bodyG, forkG, armG } = slot === 0 ? GEO_HI : GEO_LO);
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const body = new THREE.Mesh(bodyG, mat);
    const rearW = new THREE.Mesh(wheelG, plain);
    rearW.position.set(REAR[0], REAR[1], REAR[2]);
    const pivot = new THREE.Group();
    pivot.position.set(HEAD[0], HEAD[1], HEAD[2]);
    const fork = new THREE.Mesh(forkG, mat);
    const frontW = new THREE.Mesh(wheelG, plain);
    frontW.position.set(AXLE[0], AXLE[1], AXLE[2]);
    pivot.add(fork, frontW);
    const arms = [0, 1].map((k) => {
      const g = new THREE.Group();
      g.rotation.order = 'YXZ';
      g.position.set(k === 0 ? -SHOULDER[0] : SHOULDER[0], SHOULDER[1], SHOULDER[2]);
      g.add(new THREE.Mesh(armG[k], mat));
      return g;
    });
    root.add(body, rearW, pivot, arms[0], arms[1]);
    root.matrixAutoUpdate = true;
    scene.add(root);
    for (const o of [root, body, rearW, fork, frontW]) o.frustumCulled = true;
    for (const o of [body, rearW, fork, frontW, arms[0].children[0], arms[1].children[0]]) { o.castShadow = true; o.matrixAutoUpdate = true; }
    // the bounding spheres of the shared geometries are computed once
    return { slot, root, body, rearW, fork, frontW, pivot, arms, cast: true, mat, spin: 0, dSpeed: 0, dLean: 0, dInit: false, swingT: 99, swingSide: 1, wasAtt: false, weapon: null, weaponKind: '', weaponMeshes: {}, lastLean: 0, ok: false };
  }

  function get(slot) {
    let r = riders[slot];
    if (!r) { r = riders[slot] = make(slot); r.root.visible = false; }
    return r;
  }

  /** Updates one rider's mesh and shadow. */
  function update(slot, b, info, dt, camPos) {
    const r = get(slot);
    const root = r.root;
    const vis = !b.crashed;
    root.visible = vis;
    shadow.set(slot, vis ? b.pos.x : 0, b.pos.y, b.pos.z, b.yaw, vis ? 1 : 0);
    if (!vis) return;
    root.position.set(b.pos.x, b.pos.y, b.pos.z);
    if (root.scale.x !== MODEL_SCALE) root.scale.setScalar(MODEL_SCALE);
    // real shadows only for the player and riders within a few metres of the camera (blob shadows cover the rest)
    if (shadowQ === 'high') {
      const dx = b.pos.x - camPos.x, dz = b.pos.z - camPos.z, want = slot === 0 || dx * dx + dz * dz < 12 * 12;
      if (r.cast !== want) { r.cast = want; r.body.castShadow = r.rearW.castShadow = r.fork.castShadow = r.frontW.castShadow = want; r.arms[0].children[0].castShadow = r.arms[1].children[0].castShadow = want; }
    }
    { const dx = b.pos.x - camPos.x, dz = b.pos.z - camPos.z, far = dx * dx + dz * dz > 26 * 26; r.arms[0].visible = r.arms[1].visible = !far || r.swingT < SWING_T; }
    if (!r.dInit) { r.dSpeed = b.speed; r.dLean = b.lean || 0; r.dInit = true; }
    const k = 1 - Math.exp(-dt / 0.12);
    r.dSpeed += (b.speed - r.dSpeed) * k;              // smoothed display speed (never the raw networked value)
    r.dLean += ((b.lean || 0) - r.dLean) * (1 - Math.exp(-dt / 0.07));
    root.rotation.set(b.pitch || 0, b.yaw, r.dLean);
    // wheel spin; step capped per frame so fast wheels read as a smooth blur instead of strobing
    let step = (r.dSpeed / WR) * dt;
    if (step > 0.9) step = 0.9; else if (step < -0.9) step = -0.9;
    r.spin -= step;
    if (r.spin < -6283) r.spin += 6283;
    r.rearW.rotation.x = r.spin; r.frontW.rotation.x = r.spin;
    // steering + fork compression along the fork axis
    const st = clamp(b.steer || 0, -1, 1) * 0.34;
    _ax.set(FORK_UP.x, FORK_UP.y, FORK_UP.z);
    r.pivot.quaternion.setFromAxisAngle(_ax, st);
    const comp = (b.suspF || 0) * 0.12;
    r.frontW.position.set(AXLE[0] + FORK_UP.x * comp, AXLE[1] + FORK_UP.y * comp, AXLE[2] + FORK_UP.z * comp);
    // attack animation
    const att = !!(info && info.attacking);
    if (att && (!r.wasAtt || r.swingT > SWING_T + 0.12)) { r.swingT = 0; r.swingSide = info.side < 0 ? -1 : 1; }
    r.wasAtt = att;
    const wk = (info && info.weapon) || 'punch';
    const armIdx = r.swingSide < 0 ? 1 : 0; // arms[0] = left (-X), arms[1] = right
    let swinging = r.swingT < SWING_T;
    for (let k = 0; k < 2; k++) {
      const g = r.arms[k];
      if (!(swinging && k === armIdx)) { g.rotation.set(0, 0, 0); g.scale.set(1, 1, 1); }
    }
    if (swinging) {
      r.swingT += dt;
      const p = Math.min(r.swingT / SWING_T, 1);
      let a;
      if (p < 0.25) a = -0.35 * ss(p / 0.25);
      else if (p < 0.55) a = -0.35 + 1.75 * ss((p - 0.25) / 0.3);
      else a = 1.4 * (1 - ss((p - 0.55) / 0.45));
      const peak = Math.sin(Math.PI * clamp((p - 0.15) / 0.7, 0, 1));
      const g = r.arms[armIdx];
      g.rotation.set(-0.55 * peak, r.swingSide * a, 0);
      g.scale.set(1, 1, 1 + (wk === 'punch' ? 0.55 : 0.2) * peak);
      // weapon mesh (lazily created per kind)
      if (r.weaponKind !== wk) {
        if (r.weapon) r.weapon.visible = false;
        let w = r.weaponMeshes[wk];
        if (!w) { w = r.weaponMeshes[wk] = new THREE.Mesh(weaponG[wk] || weaponG.punch, weaponMat); w.frustumCulled = false; }
        r.weapon = w; r.weaponKind = wk;
      }
      const w = r.weapon;
      if (w.parent !== g) g.add(w);
      w.visible = true;
      w.position.set(-r.swingSide * 0.16, -0.23, -0.36);
      w.scale.set(r.swingSide < 0 ? 1 : -1, 1, 1); // chain geometry curls toward -X
      if (wk === 'chain') w.rotation.set(0, -r.swingSide * 0.3 * (1 - p), 0);
      else w.rotation.set(0.1, 0, 0);
    } else if (r.weapon) r.weapon.visible = false;
  }

  return { update, get, riders, setQuality(q) { for (const r of riders) if (r) for (const o of [r.body, r.rearW, r.fork, r.frontW]) o.castShadow = q === 'high'; shadowQ = q; } };
}
