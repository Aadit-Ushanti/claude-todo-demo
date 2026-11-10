// Particles and atmosphere, all cheap: a CPU pool of ~200 points for game effects (spawnFx: dust, smoke, sparks, leaves; 1 draw call),
// a shader-driven ambient mote field around the camera (pollen, falling leaves / needles, blowing desert dust; 1 draw call),
// plus high-tier extras: dawn ground mist wisps, forest light shafts (sun rays through the canopy) and a desert dust devil with tumbleweeds.
import * as THREE from '../../public/vendor/three.module.min.js';
import { makeShared } from './Look.js';

const SH = makeShared();
const FOG = `
  uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
  float fogK(float d){ return smoothstep(uFogNear, uFogFar, d); }`;

// ------------------------------------------------------------------ pooled game particles
const POOL_VS = `
attribute vec4 aP;      // x: size (m), y: age01, z: type, w: seed
uniform float uPx;
varying vec4 vP; varying float vD;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float grow = aP.z < 1.5 ? 1.0 + aP.y * 1.8 : 1.0;
  gl_PointSize = clamp(aP.x * grow * uPx / max(-mv.z, 0.5), 0.0, 220.0);
  vP = aP; vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const POOL_FS = `
uniform vec3 uDust; uniform vec3 uSunCol; uniform vec3 uAmb;
varying vec4 vP; varying float vD;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0; float r = length(q);
  float t = vP.z, age = vP.y;
  vec3 col; float a;
  vec3 lit = uAmb * 0.9 + uSunCol * 0.45;
  if (t < 0.5) {            // dust
    a = (1.0 - smoothstep(0.2, 1.0, r)) * (1.0 - age) * 0.55; col = uDust * lit;
  } else if (t < 1.5) {     // smoke
    a = (1.0 - smoothstep(0.1, 1.0, r)) * (1.0 - age) * (1.0 - age) * 0.5; col = mix(vec3(0.85), vec3(0.35), age) * lit;
  } else if (t < 2.5) {     // sparks: additive hot streak
    float g = 1.0 - smoothstep(0.0, 0.7, r); gl_FragColor = vec4(vec3(1.0, 0.62 + 0.3 * (1.0 - age), 0.2) * g * (1.4 - age), 0.0); return;
  } else {                  // leaves: tumbling diamond
    float c = cos(vP.w * 9.0 + age * 12.0), s = sin(vP.w * 9.0 + age * 12.0);
    vec2 p = vec2(c * q.x - s * q.y, s * q.x + c * q.y); float d = abs(p.x) * 1.7 + abs(p.y) * 0.8;
    a = (1.0 - smoothstep(0.7, 0.95, d)) * (1.0 - smoothstep(0.8, 1.0, age)); col = mix(vec3(0.35, 0.28, 0.1), vec3(0.5, 0.2, 0.07), fract(vP.w * 7.0)) * lit;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * a, a);
}`;
const PREMUL = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };

// ------------------------------------------------------------------ ambient motes (fully in the vertex shader)
const AMB_VS = `
attribute vec4 aS;
uniform vec3 uBox; uniform vec3 uDrift; uniform float uTime; uniform vec3 uCam; uniform float uSize; uniform float uWob; uniform float uPx; uniform float uKind;
varying float vA; varying float vSeed; varying float vFog;
void main(){
  vec3 p0 = aS.xyz * uBox;
  vec3 wob = vec3(sin(uTime * 0.7 + aS.w * 40.0), sin(uTime * 0.9 + aS.w * 23.0) * 0.5, cos(uTime * 0.6 + aS.w * 31.0)) * uWob;
  vec3 q = mod(p0 + uDrift * uTime + wob - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 w = uCam + q;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  float edge = 1.0 - smoothstep(0.35, 0.5, max(abs(q.x) / uBox.x, max(abs(q.y) / uBox.y, abs(q.z) / uBox.z)));
  float tw = uKind > 1.5 ? 0.55 + 0.45 * sin(uTime * 3.0 + aS.w * 80.0) : 1.0;
  gl_PointSize = clamp(uSize * (0.6 + 0.8 * fract(aS.w * 7.3)) * uPx / max(-mv.z, 0.5), 1.0, 48.0);
  vA = edge * tw * smoothstep(0.8, 3.0, -mv.z); vSeed = aS.w; vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const AMB_FS = `
uniform vec3 uCol0; uniform vec3 uCol1; uniform float uAlpha; uniform float uKind; uniform float uTime; uniform vec3 uFogColor;
varying float vA; varying float vSeed; varying float vFog;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0; float a;
  if (uKind < 0.5) { a = (1.0 - smoothstep(0.0, 1.0, length(q))); a *= a; }                       // soft mote
  else if (uKind < 1.5) {                                                                           // falling leaf / needle
    float ang = vSeed * 12.0 + uTime * (1.5 + vSeed * 2.0), c = cos(ang), s = sin(ang);
    vec2 p = vec2(c * q.x - s * q.y, s * q.x + c * q.y); float d = abs(p.x) * 2.2 + abs(p.y) * 0.9; a = 1.0 - smoothstep(0.75, 1.0, d);
  } else { a = (1.0 - smoothstep(0.0, 1.0, length(q))); a = a * a * a; }                              // glint
  a *= vA * uAlpha * (1.0 - vFog); if (a < 0.01) discard;
  vec3 col = mix(uCol0, uCol1, fract(vSeed * 13.7));
  gl_FragColor = vec4(col * a, a);
}`;

const CFG = {   // per roadside theme: ambient motes
  oaks:     { kind: 2, n: 160, size: 0.07, box: [70, 14, 70], drift: [0.25, 0.05, 0.1], wob: 1.6, c0: [1.0, 0.95, 0.7], c1: [1.0, 0.85, 0.5], alpha: 1.0, y: 0.5 },
  redwoods: { kind: 1, n: 90, size: 0.26, box: [44, 26, 44], drift: [0.5, -0.85, 0.25], wob: 1.4, c0: [0.55, 0.3, 0.1], c1: [0.4, 0.45, 0.12], alpha: 0.95, y: 4 },
  pines:    { kind: 1, n: 70, size: 0.1, box: [40, 22, 40], drift: [0.6, -0.7, 0.3], wob: 1.0, c0: [0.45, 0.3, 0.12], c1: [0.3, 0.34, 0.1], alpha: 0.9, y: 3 },
  cactus:   { kind: 0, n: 130, size: 0.12, box: [80, 10, 80], drift: [3.4, 0.0, 1.1], wob: 0.8, c0: [0.9, 0.7, 0.45], c1: [0.8, 0.55, 0.3], alpha: 0.35, y: 0.5 },
  palms:    { kind: 2, n: 70, size: 0.05, box: [60, 10, 60], drift: [1.2, 0.0, 0.5], wob: 0.5, c0: [1.0, 1.0, 0.95], c1: [1.0, 0.95, 0.8], alpha: 0.9, y: 1 },
};

/** Creates the FX layer. quality: 'low' | 'medium' | 'high' */
export function createFx(quality, theme) {
  const group = new THREE.Group();
  const roadside = (theme && theme.roadside) || 'pines';
  const hi = quality === 'high', lowQ = quality === 'low';
  const uPx = { value: 600 };
  const common = { uFogColor: SH.uFogColor, uFogNear: SH.uFogNear, uFogFar: SH.uFogFar };

  // ---- pool
  const N = hi ? 220 : lowQ ? 64 : 140;
  const pos = new Float32Array(N * 3), prm = new Float32Array(N * 4);
  const vel = new Float32Array(N * 3), age = new Float32Array(N), life = new Float32Array(N).fill(0), s0 = new Float32Array(N), typ = new Float32Array(N);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aP', new THREE.BufferAttribute(prm, 4).setUsage(THREE.DynamicDrawUsage));
  const poolMat = new THREE.ShaderMaterial({ vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false, ...PREMUL, uniforms: { uPx, uDust: { value: new THREE.Color(0.55, 0.45, 0.32) }, uSunCol: SH.uSunCol, uAmb: SH.uAmb } });
  const pool = new THREE.Points(g, poolMat); pool.frustumCulled = false; pool.renderOrder = 5;
  group.add(pool);
  let head = 0, live = 0;
  const TYPES = { dust: 0, smoke: 1, sparks: 2, leaves: 3 };
  /** Spawns a particle: type 'dust'|'smoke'|'sparks'|'leaves', world position, velocity (m/s). */
  function spawn(type, p, v, opts) {
    const t = TYPES[type]; if (t === undefined) return;
    const i = head; head = (head + 1) % N;
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    const r = () => Math.random() - 0.5;
    vel[i * 3] = (v ? v.x : 0) + r() * (t === 2 ? 3 : 0.8); vel[i * 3 + 1] = (v ? v.y : 0) + (t === 2 ? Math.random() * 2.5 : t === 1 ? 0.6 + Math.random() * 0.6 : t === 3 ? 0.2 : 0.4 + Math.random() * 0.5); vel[i * 3 + 2] = (v ? v.z : 0) + r() * (t === 2 ? 3 : 0.8);
    age[i] = 0; life[i] = t === 2 ? 0.45 + Math.random() * 0.4 : t === 1 ? 1.4 + Math.random() * 0.9 : t === 3 ? 3 + Math.random() * 2 : 0.9 + Math.random() * 0.8;
    s0[i] = (opts && opts.size) || (t === 2 ? 0.07 : t === 1 ? 0.9 : t === 3 ? 0.22 : 0.8) * (0.8 + Math.random() * 0.5); typ[i] = t; prm[i * 4 + 3] = Math.random();
    prm[i * 4 + 2] = t;
  }
  function step(dt) {
    live = 0;
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) { prm[i * 4] = 0; continue; }
      age[i] += dt;
      if (age[i] >= life[i]) { life[i] = 0; prm[i * 4] = 0; pos[i * 3 + 1] = -1e4; continue; }
      const t = typ[i], k = Math.exp(-dt * (t === 2 ? 0.3 : t === 3 ? 1.5 : 1.6));
      vel[i * 3] *= k; vel[i * 3 + 2] *= k;
      if (t === 2) vel[i * 3 + 1] -= 9.8 * dt; else if (t === 3) { vel[i * 3 + 1] = -0.9 + Math.sin(age[i] * 4 + s0[i] * 20) * 0.3; vel[i * 3] += Math.cos(age[i] * 3 + s0[i] * 9) * dt * 2; } else vel[i * 3 + 1] *= k;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      prm[i * 4] = s0[i]; prm[i * 4 + 1] = age[i] / life[i];
      live++;
    }
    g.attributes.position.needsUpdate = true; g.attributes.aP.needsUpdate = true;
  }
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1e4;

  // ---- ambient motes
  const C = CFG[roadside] || CFG.pines;
  let amb = null, ambMat = null;
  if (!lowQ) {
    const n = Math.round(C.n * (hi ? 1.3 : 0.8)), seeds = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) seeds[i] = Math.random();
    const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); ag.setAttribute('aS', new THREE.BufferAttribute(seeds, 4));
    ag.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    ambMat = new THREE.ShaderMaterial({
      vertexShader: FOG + AMB_VS, fragmentShader: AMB_FS, transparent: true, depthWrite: false, ...PREMUL,
      uniforms: { uBox: { value: new THREE.Vector3(...C.box) }, uDrift: { value: new THREE.Vector3(...C.drift) }, uTime: SH.uTime, uCam: SH.uCam, uSize: { value: C.size }, uWob: { value: C.wob }, uPx, uKind: { value: C.kind }, uCol0: { value: new THREE.Color(...C.c0) }, uCol1: { value: new THREE.Color(...C.c1) }, uAlpha: { value: C.alpha }, ...common },
    });
    amb = new THREE.Points(ag, ambMat); amb.frustumCulled = false; amb.renderOrder = 6; group.add(amb);
  }

  // ---- high tier extras: ground mist (dawn), light shafts (forest), dust devil + tumbleweeds (desert)
  const extras = [];
  const dawn = theme && theme.timeOfDay === 'dawn';
  if (hi && dawn && (roadside === 'redwoods')) {
    const n = 42, seeds = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) seeds[i] = Math.random();
    const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); mg.setAttribute('aS', new THREE.BufferAttribute(seeds, 4)); mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mm = new THREE.ShaderMaterial({
      vertexShader: FOG + AMB_VS.replace('float edge =', 'float edge0 =').replace('vA = edge *', 'float edge = edge0 * 0.5; vA = edge *'), fragmentShader: AMB_FS, transparent: true, depthWrite: false, ...PREMUL,
      uniforms: { uBox: { value: new THREE.Vector3(150, 3, 150) }, uDrift: { value: new THREE.Vector3(0.6, 0, 0.2) }, uTime: SH.uTime, uCam: SH.uCam, uSize: { value: 22 }, uWob: { value: 4 }, uPx, uKind: { value: 0 }, uCol0: { value: new THREE.Color(0.72, 0.8, 0.78) }, uCol1: { value: new THREE.Color(0.8, 0.84, 0.8) }, uAlpha: { value: 0.16 }, ...common },
    });
    const m = new THREE.Points(mg, mm); m.frustumCulled = false; m.renderOrder = 4; group.add(m); extras.push(m);
  }
  let shafts = null;
  if (hi && (roadside === 'redwoods')) {
    const sg = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, ...PREMUL,
      uniforms: { uTime: SH.uTime, uSunCol: SH.uSunCol, uSunDir: SH.uSunDir, uCam: SH.uCam },
      vertexShader: `varying vec2 vUv; varying float vSeed; uniform vec3 uSunDir; uniform vec3 uCam; uniform float uTime;
        void main(){ vUv = uv; vec3 ip = instanceMatrix[3].xyz; vSeed = fract(ip.x * 0.113 + ip.z * 0.071);
          vec3 sd = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) * 1.0 - vec3(0.0, 0.62, 0.0));  // beams fall away from the sun
          vec3 up = normalize(-sd); vec3 side = normalize(cross(up, vec3(0.0, 1.0, 0.2)));
          float L = 46.0; float W = 3.2 + 3.0 * vSeed;
          vec3 w = ip + up * (position.y - 0.5) * L + side * position.x * W; gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vSeed; uniform vec3 uSunCol; uniform float uTime;
        void main(){ float x = abs(vUv.x - 0.5) * 2.0; float a = (1.0 - smoothstep(0.0, 1.0, x)); a *= a; a *= smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          a *= 0.55 + 0.45 * sin(uTime * 0.4 + vSeed * 40.0); gl_FragColor = vec4(uSunCol * vec3(1.0, 0.85, 0.6) * a * 0.12, 0.0); }`,
    });
    shafts = new THREE.InstancedMesh(sg, mat, 9); shafts.frustumCulled = false; shafts.renderOrder = 6; group.add(shafts); extras.push(shafts);
  }
  let devil = null, devU = null;
  if (!lowQ && roadside === 'cactus') {
    const n = hi ? 96 : 56, seeds = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) seeds[i] = Math.random();
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); dg.setAttribute('aS', new THREE.BufferAttribute(seeds, 4)); dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    devU = { uCenter: { value: new THREE.Vector3() }, uTime: SH.uTime, uPx, uCol: { value: new THREE.Color(0.85, 0.66, 0.42) }, uWind: SH.uWind, ...common };
    const dm = new THREE.ShaderMaterial({
      vertexShader: FOG + `attribute vec4 aS; uniform vec3 uCenter; uniform float uTime; uniform float uPx; varying float vA; varying float vT; varying float vFog;
        void main(){
          float h = fract(aS.x + uTime * 0.12 * (0.6 + aS.y)) ; float tum = step(0.9, aS.w);   // ~10% of the points are tumbleweeds
          float rad = (0.8 + h * 6.5) * (0.6 + 0.7 * aS.z); float an = aS.y * 6.283 + uTime * (3.2 - h * 1.6);
          vec3 w = uCenter + vec3(cos(an) * rad, h * 24.0, sin(an) * rad);
          float rollT = uTime * 5.0 + aS.x * 50.0; float lane = fract(uTime * 0.045 + aS.z * 3.0);
          vec3 tw = uCenter + vec3(-90.0 + lane * 240.0, 0.45 + abs(sin(rollT)) * 0.35, -40.0 + aS.x * 70.0);
          w = mix(w, tw, tum);
          vec4 mv = viewMatrix * vec4(w, 1.0); vT = tum;
          gl_PointSize = clamp((tum > 0.5 ? 1.0 : (0.9 + h * 3.2)) * uPx / max(-mv.z, 0.5), 1.0, 120.0);
          vA = (tum > 0.5 ? 1.0 : (1.0 - h) * 0.5) * smoothstep(0.5, 3.0, -mv.z); vFog = smoothstep(uFogNear, uFogFar, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uCol; uniform vec3 uFogColor; varying float vA; varying float vT; varying float vFog;
        void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = length(q); float a;
          if (vT > 0.5) { float ring = smoothstep(0.35, 0.55, r) * (1.0 - smoothstep(0.85, 1.0, r)); float cr = abs(sin(atan(q.y, q.x) * 5.0 + r * 8.0)); a = max(ring, (1.0 - r) * 0.4) * (0.6 + 0.4 * cr); a *= 0.9; gl_FragColor = vec4(vec3(0.42, 0.3, 0.16) * a * (1.0 - vFog) + uFogColor * a * vFog, a); if (a < 0.02) discard; return; }
          a = (1.0 - smoothstep(0.0, 1.0, r)); a *= a * vA * 0.5 * (1.0 - vFog); if (a < 0.01) discard; gl_FragColor = vec4(uCol * a, a); }`,
      transparent: true, depthWrite: false, ...PREMUL, uniforms: { ...devU, uFogColor: SH.uFogColor, uFogNear: SH.uFogNear, uFogFar: SH.uFogFar },
    });
    devil = new THREE.Points(dg, dm); devil.frustumCulled = false; devil.renderOrder = 5; group.add(devil); extras.push(devil);
  }

  // ---- subtle lens flare: ghost sprites on the line from the sun through the screen centre (depth-tested far away, so hills and trees occlude it)
  let flare = null, flareMat = null;
  if (!lowQ) {
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3)); fg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array([0, 1, 2, 3, 4, 0.1, 0.4, 0.8, 1.2, 1.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4)); fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    flareMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, ...PREMUL, fog: false,
      uniforms: { uPx, uI: { value: 0 }, uSunCol: SH.uSunCol },
      vertexShader: `attribute vec4 aS; uniform float uPx; varying float vK; void main(){ vK = aS.x; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sz = aS.x < 0.5 ? 700.0 : aS.x < 1.5 ? 90.0 : aS.x < 2.5 ? 160.0 : aS.x < 3.5 ? 60.0 : 220.0; gl_PointSize = clamp(sz * uPx / max(-mv.z, 1.0), 1.0, 700.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uI; uniform vec3 uSunCol; varying float vK; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = length(q); float a;
        if (vK < 0.5) { a = pow(max(1.0 - r, 0.0), 3.0) * 0.5; }                                  // soft bloom around the sun
        else if (vK < 1.5) { a = smoothstep(0.55, 0.7, r) * (1.0 - smoothstep(0.8, 1.0, r)) * 0.5; } // ghost ring
        else if (vK < 2.5) { a = (1.0 - smoothstep(0.0, 1.0, r)) * 0.3; }                          // ghost disc
        else if (vK < 3.5) { float h = max(abs(q.x) * 0.866 + abs(q.y) * 0.5, abs(q.y)); a = (1.0 - smoothstep(0.7, 0.9, h)) * 0.35; } // hex
        else { a = pow(max(1.0 - r, 0.0), 2.0) * 0.25; }
        a *= uI; if (a < 0.003) discard; vec3 tint = vK < 0.5 ? vec3(1.0, 0.92, 0.75) : vK < 1.5 ? vec3(0.6, 0.8, 1.0) : vK < 2.5 ? vec3(1.0, 0.7, 0.45) : vK < 3.5 ? vec3(0.7, 1.0, 0.8) : vec3(1.0, 0.8, 0.6);
        gl_FragColor = vec4(tint * uSunCol * a, 0.0); }`,
    });
    flare = new THREE.Points(fg, flareMat); flare.frustumCulled = false; flare.renderOrder = -2; group.add(flare);
  }
  const _sd = new THREE.Vector3(), _sp = new THREE.Vector3();
  function updateFlare(camera) {
    if (!flare) return;
    _sd.copy(SH.uSunDir.value); const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const d = _sd.dot(fwd), vis = THREE.MathUtils.smoothstep(d, 0.55, 0.93);
    flareMat.uniforms.uI.value = vis * 0.9;
    if (vis <= 0) return;
    const pos = flare.geometry.attributes.position.array;
    _sp.copy(camera.position).addScaledVector(_sd, 1850).project(camera);       // sun in NDC
    const k = [0, -0.5, -1.1, -1.7, 0.4];
    for (let i = 0; i < 5; i++) { const nx = _sp.x * (i === 0 ? 1 : k[i]) * (i === 0 ? 1 : 1), ny = _sp.y * (i === 0 ? 1 : k[i]); _s.set(nx, ny, 0.999).unproject(camera).sub(camera.position).normalize().multiplyScalar(1850).add(camera.position); pos[i * 3] = _s.x; pos[i * 3 + 1] = _s.y; pos[i * 3 + 2] = _s.z; }
    flare.geometry.attributes.position.needsUpdate = true;
  }
  const _s = new THREE.Vector3(), _m = new THREE.Matrix4();
  /** Per frame: step the pool, scale points to the viewport, follow shafts with the camera, place the dust devil. */
  function update(dt, camera, viewH, info) {
    uPx.value = viewH * 0.5 / Math.tan(camera.fov * Math.PI / 360);
    step(dt);
    updateFlare(camera);
    if (poolMat.uniforms.uDust && info && info.dust) poolMat.uniforms.uDust.value.copy(info.dust);
    if (shafts) {
      const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize();
      const r = new THREE.Vector3(-f.z, 0, f.x);
      for (let i = 0; i < 9; i++) {
        const k = i / 9, ahead = 18 + k * 70, lat = (((i * 0.6180339) % 1) - 0.5) * 60 + (i % 2 ? 6 : -6);
        const snap = Math.floor(camera.position.x / 90), snz = Math.floor(camera.position.z / 90);
        _s.set(camera.position.x + f.x * ahead + r.x * lat, camera.position.y + 18, camera.position.z + f.z * ahead + r.z * lat);
        _m.makeTranslation(_s.x, _s.y, _s.z); shafts.setMatrixAt(i, _m);
      }
      shafts.instanceMatrix.needsUpdate = true;
    }
  }
  /** Places the desert dust devil beside the road at track position (x, y, z). */
  function setDevil(x, y, z) { if (devU) devU.uCenter.value.set(x, y, z); }
  function dispose() { for (const o of [pool, amb, flare, ...extras]) if (o) { o.geometry.dispose(); o.material.dispose(); } }
  return { group, spawn, update, setDevil, dispose, get live() { return live; }, hasDevil: !!devU };
}
