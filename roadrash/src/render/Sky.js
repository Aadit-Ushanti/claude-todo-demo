// Sky dome (gradient, sun glow, two lit cloud layers), sky-derived PMREM environment, lights, shadow follow and hazy hill rings.
import * as THREE from '../../public/vendor/three.module.min.js';
import { TOD, TERRAIN, GRADE } from './themes.js';
import { fbm, ss, lerp } from './util.js';
import { sharedNoise } from './Look.js';

const SKY_VS = `
varying vec3 vDir;
void main(){ vDir = normalize(position); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.9999; }`;
const SKY_FS = `
uniform vec3 uHorizon; uniform vec3 uMid; uniform vec3 uZenith; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec4 uGlow;
uniform vec3 uCloud; uniform vec3 uShade; uniform float uClouds; uniform float uTime; uniform sampler2D tNoise;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y, t = clamp(h, 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.2, t));
  col = mix(col, uZenith, smoothstep(0.1, 0.9, pow(t, 0.8)));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uGlow.rgb * (pow(sd, 4.0) * 0.20 + pow(sd, 28.0) * 0.55) * uGlow.a;
  float cover = 0.0;
  if (uClouds > 0.5 && h > 0.0) {
    vec2 p = d.xz / (h + 0.16);
    vec2 q = p * 0.5 + vec2(uTime * 0.004, 0.0);
    vec2 sh = normalize(uSunDir.xz + 1e-4) * 0.035;
    float n  = texture2D(tNoise, q).r * 0.62 + texture2D(tNoise, q * 3.3).g * 0.38;
    float ns = texture2D(tNoise, q + sh).r * 0.62 + texture2D(tNoise, (q + sh) * 3.3).g * 0.38;
    float c = smoothstep(0.5, 0.74, n) * smoothstep(0.0, 0.14, h);
    float lit = clamp(0.62 + (n - ns) * 7.0, 0.0, 1.0);
    vec3 cc = mix(uShade, uCloud, lit);
    cc += uGlow.rgb * uGlow.a * pow(sd, 6.0) * 0.5 * (1.0 - lit);
    col = mix(col, cc, c * 0.92);
    cover = c;
    #ifdef HIGH
    vec2 q2 = vec2(p.x * 0.18 + uTime * 0.002, p.y * 0.55);
    float n2 = texture2D(tNoise, q2).g * 0.6 + texture2D(tNoise, q2 * 2.7).b * 0.4;
    float c2 = smoothstep(0.55, 0.85, n2) * smoothstep(0.02, 0.3, h) * 0.45;
    col = mix(col, mix(uCloud, uGlow.rgb, 0.2 * uGlow.a), c2 * (1.0 - cover));
    cover = max(cover, c2);
    #endif
  }
  col += uSunCol * 4.0 * smoothstep(0.99955, 0.99978, sd) * step(0.0, h + 0.01) * (1.0 - cover);
  if (h < 0.0) col = mix(uHorizon, uGround, smoothstep(0.0, -0.3, h));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const k0 = new THREE.Color();
function setC(arr, o, c) { arr[o] = c.r; arr[o + 1] = c.g; arr[o + 2] = c.b; }

/** Hill ring: layered rows (haze / forest / rock / snow), light from the sun side, noise-rimmed silhouette. */
function ringGeometry(radius, h, seed, p) {
  const SEG = 192, ROWS = 5;
  const pos = new Float32Array(SEG * ROWS * 3), col = new Float32Array(SEG * ROWS * 3);
  const idx = [];
  const hs = new Float32Array(SEG);
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2, nx = Math.cos(a) * 2.2, nz = Math.sin(a) * 2.2;
    const n = fbm(nx + 7, nz + 3, seed, 4), ridge = 1 - Math.abs(fbm(nx * 1.7 + 2, nz * 1.7 + 9, seed + 3, 3) * 2 - 1);
    hs[i] = h * (0.22 + 0.78 * lerp(n, ridge, p.rough));
  }
  const c = new THREE.Color(), L = new THREE.Vector2(p.sun[0], p.sun[1]);
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2, x = Math.sin(a) * radius, z = Math.cos(a) * radius;
    const sl = (hs[(i + 1) % SEG] - hs[(i + SEG - 1) % SEG]) / (2 * radius * Math.PI * 2 / SEG);
    // face normal of the ridge as seen from the centre: radial (-sin,-cos) tilted by the along-ring slope
    const tx = Math.cos(a), tz = -Math.sin(a);
    const nxv = -Math.sin(a) - sl * 2.6 * tx, nzv = -Math.cos(a) - sl * 2.6 * tz, nl = Math.hypot(nxv, nzv);
    const lit = Math.max(0, (nxv * L.x + nzv * L.y) / nl);
    const shade = 0.62 + 0.55 * lit;
    for (let r = 0; r < ROWS; r++) {
      const f = r / (ROWS - 1);
      const y = r === ROWS - 1 ? -500 : hs[i] * (1 - f * 0.9);
      const o = (i * ROWS + r) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      // row colours: rock / snow crest -> forest -> haze base
      const hf = hs[i] / h;
      if (r === 0) { c.copy(p.top); if (p.snow) c.lerp(p.snowCol, ss((hf - 0.55) / 0.2)); }
      else if (r === 1) c.copy(p.top).lerp(p.mid, 0.55);
      else if (r === 2) c.copy(p.mid);
      else c.copy(p.base);
      c.multiplyScalar(r < 3 ? shade : 1);
      if (r > 0 && r < 3) c.multiplyScalar(0.92 + 0.16 * fbm(i * 0.37, r * 3.1, seed, 2));
      c.lerp(p.haze, p.hazeK + (r >= 2 ? 0.14 * (r - 1) : 0));
      setC(col, o, c);
    }
    const j = (i + 1) % SEG;
    for (let r = 0; r < ROWS - 1; r++) {
      const a0 = i * ROWS + r, b0 = j * ROWS + r;
      idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Creates the environment (sky, env map, lights, hills, fog). */
export function createEnv(scene, shared, renderer, q0 = 'high') {
  const noise = sharedNoise();
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uHorizon: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
      uSunDir: shared.uSunDir, uSunCol: shared.uSunCol, uGlow: { value: new THREE.Vector4() },
      uClouds: { value: 1 }, uTime: { value: 0 }, uCloud: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.65, 0.75) }, tNoise: { value: noise },
    },
  });
  skyMat.defines = { HIGH: 1 };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 24, 14), skyMat);
  sky.renderOrder = -10; sky.frustumCulled = false;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x555555, 0.8);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  scene.add(hemi, sun, sun.target, fill);
  scene.fog = new THREE.Fog(0xc5d6ea, 80, 650);
  scene.background = new THREE.Color(0xc5d6ea);
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -44, right: 44, top: 44, bottom: -44, near: 10, far: 260 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06; sun.shadow.radius = 2;

  const rings = [];
  const ringMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  let curTheme = null, curSeed = 1, quality = q0, pm = null, envRT = null;
  const state = { exposure: 0.95, grade: GRADE.pines, hasEnv: false };

  function clearRings() { for (const r of rings) { scene.remove(r); r.geometry.dispose(); } rings.length = 0; }
  const envCache = new Map();
  function disposeEnv() { envRT = null; scene.environment = null; state.hasEnv = false; }
  function clearEnvCache() { for (const r of envCache.values()) r.dispose(); envCache.clear(); disposeEnv(); }

  function buildEnvMap(theme) {
    disposeEnv();
    if (quality === 'low' || !renderer) return;
    const ek = JSON.stringify([theme.sky, theme.fog, theme.ground, theme.timeOfDay, theme.roadside, quality]);
    const hit = envCache.get(ek);
    if (hit) { envRT = hit; scene.environment = hit.texture; state.hasEnv = true; return; }
    if (!pm) { pm = new THREE.PMREMGenerator(renderer); }
    const es = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), skyMat);
    dome.frustumCulled = false; es.add(dome);
    const keep = skyMat.uniforms.uClouds.value; skyMat.uniforms.uClouds.value = 0;
    const prevTM = renderer.toneMapping;
    envRT = pm.fromScene(es, 0.035, 0.1, 100);
    renderer.toneMapping = prevTM; skyMat.uniforms.uClouds.value = keep;
    envCache.set(ek, envRT);
    scene.environment = envRT.texture;
    state.hasEnv = true;
    es.remove(dome); dome.geometry.dispose();
  }

  function lights() {
    const th = curTheme; if (!th) return;
    const T = TERRAIN[th.roadside] || TERRAIN.pines, tod = TOD[th.timeOfDay] || TOD.noon, G = GRADE[th.roadside] || GRADE.pines;
    const skyC = new THREE.Color(th.sky), gC = new THREE.Color(th.ground);
    const withEnv = state.hasEnv;
    const sc = new THREE.Color(tod.col);
    sun.color.copy(sc); sun.intensity = tod.sun * (withEnv ? 2.6 : 2.7);
    hemi.color.copy(skyC).lerp(new THREE.Color(0.7, 0.8, 1.0), 0.35);   // cool sky fill
    hemi.groundColor.copy(gC).multiplyScalar(0.7);
    hemi.intensity = tod.hemi * (withEnv ? 0.85 : 2.1);
    fill.color.copy(skyC).lerp(new THREE.Color(1, 1, 1), 0.3); fill.intensity = tod.fill * (withEnv ? 0.7 : 1.4);
    scene.environmentIntensity = G.env * (quality === 'medium' ? 0.85 : 1);
    shared.uAmb.value.copy(hemi.color).multiplyScalar(tod.hemi * 0.85).add(new THREE.Color(0.06, 0.06, 0.06));
    state.exposure = G.exp; state.grade = G;
  }

  /** Applies a theme: colours, sun, fog, hills, environment map. */
  function apply(theme, seed = 1) {
    curTheme = theme; curSeed = seed;
    const T = TERRAIN[theme.roadside] || TERRAIN.pines;
    const tod = TOD[theme.timeOfDay] || TOD.noon;
    const fogC = new THREE.Color(theme.fog), skyC = new THREE.Color(theme.sky), sunC = new THREE.Color(tod.col);
    const U = skyMat.uniforms;
    U.uHorizon.value.copy(fogC);
    U.uZenith.value.copy(skyC).multiplyScalar(0.8);
    U.uMid.value.copy(fogC).lerp(skyC, 0.62);
    U.uGround.value.set(theme.ground).multiplyScalar(0.55);
    scene.fog.color.copy(fogC); scene.background.copy(fogC);
    scene.fog.near = T.fog[0]; scene.fog.far = T.fog[1];
    shared.uFogColor.value.copy(fogC); shared.uFogNear.value = T.fog[0]; shared.uFogFar.value = T.fog[1];
    shared.uSky.value.copy(skyC);
    shared.uHazeSun.value.copy(sunC).multiplyScalar(0.16 * tod.glow[3] + 0.04);
    const el = tod.elev * Math.PI / 180, az = tod.az * Math.PI / 180;
    // az 0 = straight ahead (-Z); positive = to the right (+X)
    shared.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    shared.uSunCol.value.copy(sunC).multiplyScalar(tod.sun);
    sun.position.copy(shared.uSunDir.value).multiplyScalar(150);
    fill.position.set(-shared.uSunDir.value.x, 0.5, -shared.uSunDir.value.z).multiplyScalar(100);
    U.uGlow.value.set(tod.glow[0], tod.glow[1], tod.glow[2], tod.glow[3]);
    U.uCloud.value.set(1, 1, 1).lerp(sunC, 0.35).multiplyScalar(0.98);
    U.uShade.value.copy(skyC).lerp(fogC, 0.5).multiplyScalar(0.62).lerp(sunC, 0.08);
    buildEnvMap(theme);
    lights();

    clearRings();
    const gC = new THREE.Color(theme.ground), rC = new THREE.Color(T.rock);
    const m1 = T.mount, sun2 = [shared.uSunDir.value.x, shared.uSunDir.value.z];
    const hz = Math.hypot(sun2[0], sun2[1]) || 1; sun2[0] /= hz; sun2[1] /= hz;
    const forest = gC.clone().lerp(new THREE.Color(theme.roadside === 'cactus' ? 0xa4623c : 0x2f4a2c), theme.roadside === 'cactus' ? 0.5 : 0.55).multiplyScalar(0.8);
    const far = {
      top: rC.clone().lerp(skyC, 0.35), mid: forest.clone().lerp(skyC, 0.3), base: fogC.clone(), haze: fogC, hazeK: 0.55, snow: !!m1.snow, snowCol: new THREE.Color(0xf4f7fb), rough: 0.55, sun: sun2,
    };
    const near = {
      top: rC.clone().multiplyScalar(0.8), mid: forest, base: fogC.clone(), haze: fogC, hazeK: 0.26, snow: false, snowCol: new THREE.Color(0xf4f7fb), rough: 0.25, sun: sun2,
    };
    const mid = Object.assign({}, near, { top: rC.clone().lerp(skyC, 0.15), mid: forest.clone().lerp(skyC, 0.12), hazeK: 0.42, rough: 0.4 });
    const specs = [[m1.r + 520, m1.h * 1.35, curSeed + 3, far], [m1.r + 160, m1.h * 0.95, curSeed + 7, mid], [m1.r, m1.h * 0.55, curSeed + 11, near]];
    for (const [r, h, sd, p] of specs) {
      const mesh = new THREE.Mesh(ringGeometry(r, h, sd, p), ringMat);
      mesh.frustumCulled = false; mesh.renderOrder = -5; scene.add(mesh); rings.push(mesh);
    }
  }

  /** Quality tier: clouds, env map, shadows. */
  function setQuality(q) {
    if (q === quality) return;
    const hadEnv = state.hasEnv;
    quality = q;
    skyMat.defines.HIGH = q === 'high' ? 1 : undefined; if (q !== 'high') delete skyMat.defines.HIGH; skyMat.needsUpdate = true;
    sun.castShadow = q === 'high';
    clearEnvCache();
    if (curTheme) { buildEnvMap(curTheme); lights(); }
  }
  sun.castShadow = quality === 'high';
  if (quality !== 'high') delete skyMat.defines.HIGH;

  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  /** Follows a focus point with the shadow frustum (snapped to shadow texels so it does not shimmer). */
  function followShadow(p) {
    if (!sun.castShadow) return;
    const L = shared.uSunDir.value;
    _r.crossVectors(_up, L).normalize(); _u.crossVectors(L, _r).normalize();
    const ts = 88 / sun.shadow.mapSize.x;
    const a = Math.round(p.dot(_r) / ts) * ts, b = Math.round(p.dot(_u) / ts) * ts, c = p.dot(L);
    _f.set(0, 0, 0).addScaledVector(_r, a).addScaledVector(_u, b).addScaledVector(L, c);
    sun.target.position.copy(_f);
    sun.position.copy(_f).addScaledVector(L, 120);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  }

  /** Follows the camera (dome, hills). */
  function update(camPos, t, quality) {
    sky.position.copy(camPos);
    skyMat.uniforms.uTime.value = t;
    skyMat.uniforms.uClouds.value = quality === 'low' ? 0 : 1;
    for (const r of rings) r.position.set(camPos.x, camPos.y - 30, camPos.z);
  }
  return { apply, update, setQuality, followShadow, sky, hemi, sun, fill, state, get theme() { return curTheme; } };
}
