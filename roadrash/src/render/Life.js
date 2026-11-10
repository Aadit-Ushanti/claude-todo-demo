// Living scenery that moves: bird flocks circling over the road (gulls on the coast, a hawk in the desert), birds startled out of
// roadside trees as bikes pass, sailboats on the sea and an occasional plane with a contrail. Birds, boats and the plane are
// instanced / single meshes updated on the CPU (a few dozen matrices per frame): <= 3 draw calls per theme on medium, 1 on low.
import * as THREE from '../../public/vendor/three.module.min.js';
import { rng } from './util.js';
import { patchMaterial, makeShared } from './Look.js';

const SH = makeShared();

function birdGeometry() {
  // body + two wings (flapping tips), vertex colour: body dark, tips darker. x = span, z = length (nose -z)
  const p = [], c = [], idx = [];
  const add = (a, b, cc, col) => { const n = p.length / 3; p.push(...a, ...b, ...cc); c.push(...col, ...col, ...col); idx.push(n, n + 1, n + 2); };
  const body = [0.92, 0.92, 0.92], tip = [0.18, 0.18, 0.2];
  add([0, 0.02, -0.34], [-0.07, 0, 0.14], [0.07, 0, 0.14], body); add([0, 0.02, -0.34], [0.07, 0, 0.14], [-0.07, 0, 0.14], body);
  // left wing (two triangles inner + tip), right wing mirrored; both faces
  for (const sx of [-1, 1]) {
    const a = [0.05 * sx, 0, -0.18], b = [0.05 * sx, 0, 0.12], m1 = [0.5 * sx, 0.02, -0.08], m2 = [0.46 * sx, 0.02, 0.14], t = [1.0 * sx, 0.0, 0.06], t2 = [0.98 * sx, 0, -0.14];
    add(a, m1, b, body); add(a, b, m1, body); add(b, m1, m2, body); add(b, m2, m1, body);
    add(m1, t2, m2, tip); add(m1, m2, t2, tip); add(m2, t2, t, tip); add(m2, t, t2, tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); g.setIndex(idx);
  return g;
}
function boatGeometry() {
  const p = [], c = [], idx = [];
  const add = (a, b, cc, col) => { const n = p.length / 3; p.push(...a, ...b, ...cc); c.push(...col, ...col, ...col); idx.push(n, n + 1, n + 2); };
  const hull = [0.85, 0.85, 0.82], sail = [0.98, 0.97, 0.94], red = [0.8, 0.2, 0.18];
  const q = (a, b, cc, d, col) => { add(a, b, cc, col); add(a, cc, d, col); };
  q([-0.6, 0.1, -2], [0.6, 0.1, -2], [0.6, 0.6, -1.6], [-0.6, 0.6, -1.6], hull);   // bow/stern simplified hull
  q([-0.6, 0.1, 2], [-0.6, 0.6, 1.6], [0.6, 0.6, 1.6], [0.6, 0.1, 2], hull);
  q([0.6, 0.1, -2], [0.6, 0.1, 2], [0.6, 0.6, 1.6], [0.6, 0.6, -1.6], hull); q([-0.6, 0.1, 2], [-0.6, 0.1, -2], [-0.6, 0.6, -1.6], [-0.6, 0.6, 1.6], hull);
  q([-0.6, 0.6, -1.6], [0.6, 0.6, -1.6], [0.6, 0.6, 1.6], [-0.6, 0.6, 1.6], [0.6, 0.5, 0.4]);
  add([0, 0.6, -1.3], [0, 0.6, 0.9], [0, 6.5, -0.8], sail); add([0, 0.6, 0.9], [0, 0.6, -1.3], [0, 6.5, -0.8], sail);   // main sail (double sided)
  add([0, 0.6, -1.4], [0, 0.6, -2.4], [0, 4.5, -1.6], red); add([0, 0.6, -2.4], [0, 0.6, -1.4], [0, 4.5, -1.6], red);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

const FLAP_PATCH = (sh) => {
  sh.uniforms.uTime = SH.uTime;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      { vec3 ip = vec3(instanceMatrix[3]); float ph = ip.x * 0.37 + ip.z * 0.21 + ip.y * 0.13;
        float spd = 8.0 + 5.0 * fract(ph * 3.1);
        transformed.y += abs(position.x) * (0.55 * sin(uTime * spd + ph * 6.28) + 0.1) * (instanceMatrix[0].x * 0.0 + 1.0);
        transformed.z += abs(position.x) * 0.12 * cos(uTime * spd + ph * 6.28); }`);
};

/**
 * @param {object} track @param {object} theme @param {object} terrain {ground, edge, seaY, T} @param {string} quality
 * @returns {{group, update(camS, camPos, time, dt, bikeS), dispose, counts}}
 */
export function createLife(track, theme, terrain, quality) {
  const seed = (track.seed | 0) * 17 + 3, Rn = rng(seed), rr = (a, b) => a + (b - a) * Rn();
  const edge = terrain.edge, L = track.length, ground = terrain.ground;
  const K = theme.roadside, lowQ = quality === 'low', hi = quality === 'high';
  const group = new THREE.Group();
  const P = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 }, tt = { s: 0, d: 0, yaw: 0 };
  const at = (s, d) => { track.sampleAt(s, P); return [P.x + P.hz * d, P.z - P.hx * d, P.yaw]; };

  // ---- birds
  const CAP = lowQ ? 28 : hi ? 80 : 56;
  const bm = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  patchMaterial(bm, 'bird', FLAP_PATCH);
  const birds = new THREE.InstancedMesh(birdGeometry(), bm, CAP);
  birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage); birds.setColorAt(0, new THREE.Color(1, 1, 1)); birds.instanceColor.setUsage(THREE.DynamicDrawUsage);
  birds.frustumCulled = false; birds.count = 0; group.add(birds);
  // flocks: centre in track space, radius, height, angular speed, size, colour
  const flocks = [];
  const mkFlock = (s, d, n, r, h, w, sz, col) => { const [x, z] = at(s, d); track.toTrack(x, z, s, tt); const g0 = ground(tt.s, tt.d, x, z); flocks.push({ s, x, z, y: Math.max(g0, terrain.T.sea ? terrain.seaY : g0) + h, n, r, w, sz, col: new THREE.Color(col[0], col[1], col[2]), a0: Rn() * 6.28, sgn: Rn() < 0.5 ? 1 : -1 }); };
  const nF = Math.max(2, Math.round(L / 1500));
  for (let i = 0; i < nF; i++) {
    const s = 250 + (L - 500) * (i + Rn() * 0.7) / nF;
    if (K === 'palms') mkFlock(s, rr(30, 90), 7 + Math.floor(Rn() * 5), rr(24, 50), rr(14, 32), rr(0.25, 0.4), 1.5, [0.95, 0.95, 0.95]);   // gulls over the surf
    else if (K === 'cactus') { if (i % 2 === 0) mkFlock(s, rr(-70, 70), 1, rr(55, 90), rr(60, 90), 0.22, 2.3, [0.38, 0.28, 0.2]); }   // hawk
    else mkFlock(s, rr(-60, 60), 6 + Math.floor(Rn() * 5), rr(20, 40), rr(26, 50), rr(0.2, 0.35), 1.0, K === 'redwoods' ? [0.3, 0.3, 0.32] : [0.2, 0.2, 0.23]);
  }
  if (K === 'palms') for (let i = 0; i < 2; i++) mkFlock(180 + (L - 360) * (i + 0.4) / 2, rr(15, 40), 5, rr(12, 22), rr(6, 12), 0.5, 1.4, [0.92, 0.92, 0.9]);
  // perches: roadside trees where birds sit until a bike comes by
  const perches = [];
  if (K !== 'cactus') for (let s = 160; s < L - 60; s += 130 + Rn() * 90) {
    const sg = Rn() < 0.5 ? 1 : -1, d = sg * (edge + rr(8, 26));
    if (K === 'palms' && d > 0) continue;
    const [x, z, yaw] = at(s, d); track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z) + (K === 'palms' ? 11 : K === 'redwoods' ? 30 : 9);
    perches.push({ s, x, y, z, yaw, side: sg, done: false });
  }
  const burst = [];   // startled birds: {x,y,z,vx,vy,vz,age,life,sz}
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const setBird = (i, x, y, z, yaw, bank, sz, col) => {
    q4.setFromEuler(e4.set(0, yaw, bank, 'YXZ')); m4.compose(v3.set(x, y, z), q4, s3.set(sz, sz, sz)); birds.setMatrixAt(i, m4); birds.setColorAt(i, col);
  };
  const white = new THREE.Color(1, 1, 1);

  // ---- boats (coast)
  let boats = null; const boatList = [];
  if (K === 'palms' && !lowQ) {
    const bmat = patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'boat', null);
    boats = new THREE.InstancedMesh(boatGeometry(), bmat, 6); boats.frustumCulled = false; boats.instanceMatrix.setUsage(THREE.DynamicDrawUsage); boats.count = 0; group.add(boats);
    for (let i = 0; i < 6; i++) { const s = 200 + (L - 400) * (i + Rn() * 0.6) / 6, d = rr(140, 520); const [x, z, yaw] = at(s, d); boatList.push({ s, x, z, yaw, drift: rr(0.8, 2.2), ph: Rn() * 6.28, sc: rr(1.2, 2.2) }); }
  }
  // ---- plane + contrail (valley / sierra / redwoods only, every ~70 s)
  let plane = null, pl = null;
  if (!lowQ && (K === 'oaks' || K === 'pines')) {
    const pg = new THREE.PlaneGeometry(1, 1);
    const pmat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide,
      uniforms: { uCol: { value: new THREE.Color(1, 1, 1) }, uFade: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform vec3 uCol; uniform float uFade; void main(){ float x = abs(vUv.y - 0.5) * 2.0; float a = (1.0 - x * x) * smoothstep(0.0, 0.06, vUv.x) * pow(vUv.x, 1.4) * 0.55 * uFade; gl_FragColor = vec4(uCol * a, a); }`,
    });
    plane = new THREE.Mesh(pg, pmat); plane.frustumCulled = false; plane.visible = false; plane.renderOrder = -3; group.add(plane);
    pl = { t: 20 + Rn() * 40, active: false, x: 0, z: 0, dx: 0, dz: 0, y: 600, age: 0, len: 1100 };
  }

  let nBirds = 0;
  /** Per frame. camS: camera position along the track; bikeS: the player's track position (triggers startled birds). */
  function update(camS, cam, time, dt, bikeS) {
    let n = 0;
    const lo = camS - 120, hi2 = camS + 900;
    for (const f of flocks) {
      if (f.s < lo - 60 || f.s > hi2 + 60) continue;
      for (let i = 0; i < f.n && n < CAP - 24; i++) {
        const a = f.a0 + f.sgn * f.w * time + i * (6.283 / f.n) * 0.35 + Math.sin(i * 1.7) * 0.4;
        const r = f.r * (0.75 + 0.25 * Math.sin(i * 2.3 + time * 0.2));
        const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r, y = f.y + Math.sin(time * 0.5 + i) * 2.5 + i % 3 * 1.2;
        const yaw = f.sgn > 0 ? Math.PI - a : -a;
        setBird(n++, x, y, z, yaw, -0.35 * f.sgn, f.sz, f.col);
      }
    }
    // startled birds
    for (const p of perches) {
      if (!p.done && bikeS > p.s - 34 && bikeS < p.s + 8) {
        p.done = true; const cnt = 5 + Math.floor(Rn() * 4);
        for (let k = 0; k < cnt && burst.length < 22; k++) burst.push({ x: p.x + rr(-1.5, 1.5), y: p.y + rr(-1, 1), z: p.z + rr(-1.5, 1.5), vx: Math.sin(p.yaw) * 0, vy: rr(3, 7), vz: 0, age: 0, life: rr(5, 8), sz: rr(0.8, 1.1), side: p.side, yaw: p.yaw, k });
      }
      if (p.done && bikeS < p.s - 200) p.done = false;   // re-arm after a restart
    }
    for (let i = burst.length - 1; i >= 0; i--) {
      const b = burst[i]; b.age += dt;
      if (b.age > b.life) { burst.splice(i, 1); continue; }
      // fly away from the road, climbing, spreading
      const lx = Math.cos(b.yaw) * 0, hx = -Math.sin(b.yaw), hz = -Math.cos(b.yaw), lxv = b.side * hz, lzv = -b.side * hx;
      const sp = 9 + b.k * 0.7; b.x += (hx * sp * 0.6 + lxv * sp * 0.9 * (1 + 0.1 * b.k)) * dt; b.z += (hz * sp * 0.6 + lzv * sp * 0.9) * dt; b.y += (b.vy * Math.max(0.2, 1 - b.age * 0.12)) * dt;
      const yaw = Math.atan2(-(hx * 0.6 + lxv * 0.9), -(hz * 0.6 + lzv * 0.9));
      if (n < CAP) setBird(n++, b.x, b.y, b.z, yaw, 0.1 * Math.sin(b.age * 3), b.sz, white.clone().setRGB(0.15, 0.15, 0.17));
    }
    birds.count = n; nBirds = n; birds.visible = n > 0;
    if (n) { birds.instanceMatrix.needsUpdate = true; birds.instanceColor.needsUpdate = true; }
    // boats
    if (boats) {
      let nb = 0;
      for (const b of boatList) {
        if (b.s < lo - 100 || b.s > hi2 + 100) continue;
        const bob = Math.sin(time * 0.9 + b.ph);
        q4.setFromEuler(e4.set(0.05 * bob, b.yaw + 1.2 + 0.0, 0.07 * Math.sin(time * 0.7 + b.ph), 'YXZ'));
        const dx = Math.sin(time * 0.02 * b.drift + b.ph) * 30;
        m4.compose(v3.set(b.x + dx, terrain.seaY + 0.05 + 0.12 * bob, b.z), q4, s3.set(b.sc, b.sc, b.sc)); boats.setMatrixAt(nb++, m4);
      }
      boats.count = nb; boats.visible = nb > 0; boats.instanceMatrix.needsUpdate = true;
    }
    // plane
    if (plane) {
      pl.t -= dt;
      if (!pl.active && pl.t <= 0) {
        pl.active = true; pl.age = 0; track.sampleAt(camS, P);
        const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), rx = -fz, rz = fx;
        pl.x = cam.x + fx * 1500 + rx * 1100; pl.z = cam.z + fz * 1500 + rz * 1100; pl.dx = -rx * 0.8 + fx * 0.1; pl.dz = -rz * 0.8 + fz * 0.1; pl.y = 520 + Rn() * 140;
        const l = Math.hypot(pl.dx, pl.dz); pl.dx /= l; pl.dz /= l;
      }
      if (pl.active) {
        pl.age += dt; const sp = 140; const hx = pl.x + pl.dx * sp * pl.age, hz = pl.z + pl.dz * sp * pl.age;
        const len = Math.min(pl.len, sp * pl.age);
        // contrail: a quad lying in the vertical plane along the path, facing the camera
        const cx = hx - pl.dx * len / 2, cz = hz - pl.dz * len / 2;
        plane.position.set(cx, pl.y, cz); plane.scale.set(len, 9, 1);
        // orient: x axis along the path (trail runs from tail at u=0 to nose at u=1), y up, z towards the viewer
        const ax = new THREE.Vector3(pl.dx, 0, pl.dz), up = new THREE.Vector3(0, 1, 0), zz = new THREE.Vector3().crossVectors(ax, up);
        plane.quaternion.setFromRotationMatrix(m4.makeBasis(ax, up, zz));
        plane.visible = true; plane.material.uniforms.uFade.value = Math.max(0, 1 - Math.max(0, pl.age - 40) / 8);
        if (pl.age > 48 || Math.hypot(hx - cam.x, hz - cam.z) > 4200) { pl.active = false; plane.visible = false; pl.t = 60 + Rn() * 60; }
      }
    }
  }
  function dispose() { birds.geometry.dispose(); bm.dispose(); if (boats) { boats.geometry.dispose(); boats.material.dispose(); } if (plane) { plane.geometry.dispose(); plane.material.dispose(); } }
  function reset() { for (const p of perches) p.done = false; burst.length = 0; }
  return { group, update, dispose, reset, counts: () => ({ flocks: flocks.length, perches: perches.length, birds: nBirds, boats: boatList.length }) };
}
