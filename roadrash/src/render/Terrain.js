// Road ribbon (asphalt shader), terrain skirt, sea and banner arches built from track.edges.
import * as THREE from '../../public/vendor/three.module.min.js';
import { Mesher, ss, lerp, fbm, vnoise, SLICE, slicer } from './util.js';
import { makeShared as _makeShared, patchMaterial, fogify, sharedNoise, CLOUD_SH_GLSL } from './Look.js';
import { TERRAIN } from './themes.js';
import { LAYERS, MEAN, groundMat, macroTex, roadSet, themeReady, tintFor } from './EnvTex.js';

const PAD = 24;          // extra rows before s=0 and after the end
const CHUNK = 80;        // rows per chunk (160 m)
const OFFS = [0, 1.2, 3, 6, 11, 18, 30, 48, 75, 115, 170, 250, 360, 520, 750];
const NO = OFFS.length;

export const makeShared = _makeShared;

const ROAD_PARS_V = `varying vec2 vRoadUV;`;
const GROUND_VS_PARS = `attribute vec4 aW; varying vec4 vW; varying vec2 vGP;`;

/** Downloads + decodes this theme's WebP texture sets at the tier (preloading). */
export async function prewarmTerrainTextures(track, theme, quality, wait) { await themeReady(theme.roadside, quality); if (wait) await wait(); }

function drain(g) { let r = g.next(); while (!r.done) r = g.next(); return r.value; }
/** Async build that yields to `wait()` between ~10 ms slices. */
export async function createTerrainAsync(track, theme, shared, quality, scene, wait) {
  const g = terrainGen(track, theme, shared, quality, scene);
  let r = g.next(); while (!r.done) { await wait(); SLICE.t = performance.now(); r = g.next(); }
  return r.value;
}
export function createTerrain(track, theme, shared, quality, scene) { return drain(terrainGen(track, theme, shared, quality, scene)); }

/**
 * Builds road + terrain + sea + arches for a track.
 * @returns {{group:THREE.Group, rows:object, ground:Function, edgeY:Function, update:Function, seaY:number, dispose:Function}}
 */
function* terrainGen(track, theme, shared, quality, scene) {
  const sl = slicer();
  const T = TERRAIN[theme.roadside] || TERRAIN.pines;
  const E = track.edges;
  const step = E.step, n = E.n, N = n + 2 * PAD;
  const hw = track.halfWidth, edge = hw + track.shoulder;
  const seed = track.seed | 0;
  const group = new THREE.Group();

  // --- padded row arrays ---
  const cx = new Float32Array(N), cy = new Float32Array(N), cz = new Float32Array(N);
  const lx = new Float32Array(N), lz = new Float32Array(N), tb = new Float32Array(N), cv = new Float32Array(N);
  const yaw = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    const j = i + PAD;
    cx[j] = E.cx[i]; cy[j] = E.cy[i]; cz[j] = E.cz[i]; lx[j] = E.lx[i]; lz[j] = E.lz[i];
    tb[j] = Math.tan(E.bank[i]); cv[j] = E.curve[i]; yaw[j] = E.yaw[i];
  }
  for (let k = 1; k <= PAD; k++) {
    const a = PAD - k, b = PAD + n - 1 + k;
    const hx0 = -Math.sin(yaw[PAD]), hz0 = -Math.cos(yaw[PAD]);
    cx[a] = cx[PAD] - hx0 * k * step; cz[a] = cz[PAD] - hz0 * k * step; cy[a] = cy[PAD];
    lx[a] = lx[PAD]; lz[a] = lz[PAD]; tb[a] = tb[PAD]; yaw[a] = yaw[PAD];
    const e = PAD + n - 1;
    const hx1 = -Math.sin(yaw[e]), hz1 = -Math.cos(yaw[e]);
    cx[b] = cx[e] + hx1 * k * step; cz[b] = cz[e] + hz1 * k * step; cy[b] = cy[e];
    lx[b] = lx[e]; lz[b] = lz[e]; tb[b] = tb[e]; yaw[b] = yaw[e];
  }
  const sOf = (j) => (j - PAD) * step;

  // --- height model ---
  let minY = 1e9;
  for (let i = 0; i < n; i++) minY = Math.min(minY, E.cy[i]);
  const seaY = T.sea ? minY - 11 : -1e9;
  const seaSide = 1; // sea on the left (+d)

  function rowAt(s) {
    let f = s / step + PAD;
    if (f < 0) f = 0; else if (f > N - 1.001) f = N - 1.001;
    const i = Math.floor(f);
    return [i, f - i];
  }
  /** Road-edge-following height at (s, d): what the physics uses (flat beyond the shoulder). */
  function edgeY(s, d) {
    const [i, t] = rowAt(s);
    const dc = d < -edge ? -edge : d > edge ? edge : d;
    return lerp(cy[i], cy[i + 1], t) - dc * lerp(tb[i], tb[i + 1], t);
  }
  function hill(x, z) {
    let h = fbm(x * T.freq, z * T.freq, seed, T.oct);
    if (T.terrace) {
      const q = h * 5;
      const fl = Math.floor(q);
      h = (fl + ss((q - fl - 0.35) / 0.3)) / 5;
    }
    return h - 0.3;
  }
  /** Visual terrain height at (s,d) with world xz. */
  function ground(s, d, x, z) {
    const base = edgeY(s, d);
    const ad = d < 0 ? -d : d;
    const k = ss((ad - edge - T.rampStart) / T.rampLen);
    if (k <= 0 && !(T.sea && d > 0)) return base;
    let y = base + hill(x, z) * T.amp * k;
    if (T.sea && d > 0) {
      const kc = ss((ad - edge - 3) / 46);
      y = lerp(base, seaY - 3.5, kc) + hill(x, z) * 2.5 * k;
    }
    return y;
  }

  // --- road chunks: baked WebP tarmac (macro albedo / normal+roughness, aggregate detail, grime + puddle map), per-tier sizes ---
  const rs = roadSet(quality);
  const ROAD_LEN = 54;
  rs.map.repeat.set(1 / (2 * edge), 1 / ROAD_LEN); rs.map.offset.set(0.5, 0);
  rs.normal.repeat.set(1 / (2 * edge), 1 / ROAD_LEN); rs.normal.offset.set(0.5, 0);
  const tarTint = new THREE.Color(T.tarmac); { const b0 = new THREE.Color(0x46464b); tarTint.set(tarTint.r / b0.r, tarTint.g / b0.g, tarTint.b / b0.b); }
  const edgeTint = new THREE.Color(theme.ground).lerp(new THREE.Color(T.gnd2), 0.2).multiplyScalar(0.7);
  const wetK = theme.timeOfDay === 'dawn' ? 0.9 : 0;
  const lowQ = quality === 'low';
  const roadMat = new THREE.MeshStandardMaterial({ map: rs.map, normalMap: lowQ ? null : rs.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1.0, metalness: 0, envMapIntensity: 0.55 + 0.7 * wetK });
  const roadU = { uHW: { value: hw }, uEdge: { value: edge }, uStartS: { value: 24 }, uFinishS: { value: track.finishS }, uEdgeTint: { value: edgeTint }, uTint: { value: tarTint }, uWet: { value: wetK }, uHeat: { value: theme.roadside === 'cactus' ? 1 : 0 }, tDetail: { value: rs.detail }, tGrime: { value: rs.grime }, tNoise: { value: sharedNoise() }, uCloudK: shared.uCloudK, uTime: shared.uTime, uWind: shared.uWind };
  rs.detail.repeat.set(1, 1); rs.grime.repeat.set(1, 1);
  patchMaterial(roadMat, 'road' + (lowQ ? 'L' : ''), (sh) => {
    Object.assign(sh.uniforms, roadU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRoadUV;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvRoadUV = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vRoadUV; uniform float uHW; uniform float uEdge; uniform float uStartS; uniform float uFinishS; uniform vec3 uEdgeTint; uniform vec3 uTint;
      uniform float uWet; uniform float uHeat; uniform sampler2D tDetail; uniform sampler2D tGrime;
      ${CLOUD_SH_GLSL}
      float gWet; vec4 gRn; vec4 gDn;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float ad = abs(vRoadUV.x), s = vRoadUV.y;
          float aas = max(fwidth(s) * 1.2, 1e-3);
          vec3 gr = texture2D(tGrime, vec2(vRoadUV.x / 9.3, s / 37.0)).rgb;
          gWet = uWet * smoothstep(0.56, 0.7, gr.g) * (1.0 - smoothstep(uHW - 0.3, uHW + 0.9, ad));
          diffuseColor.rgb *= uTint * (0.9 + 0.2 * gr.r) * (1.0 - 0.45 * gWet);
          #ifndef ROAD_LOW
          gRn = texture2D(normalMap, vNormalMapUv); gDn = texture2D(tDetail, vRoadUV * 0.33333);
          #endif
          if (ad < uHW - 0.2) {
            float sl = clamp((0.5 - abs(s - (uStartS + 0.5))) / aas + 0.5, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62), sl * 0.85);
            float fs = s - uFinishS;
            if (fs > 0.0 && fs < 1.6) {
              float chk = mod(floor((vRoadUV.x + 20.0) / 0.8) + floor(fs / 0.8), 2.0);
              diffuseColor.rgb = mix(vec3(0.015), vec3(0.8), chk);
            }
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, uEdgeTint, smoothstep(uEdge - 1.1, uEdge, ad) * 0.85);
          float cs = cloudShade(vRoadWP);
          diffuseColor.rgb *= 1.0 - 0.2 * cs;
          float mir = uHeat * smoothstep(70.0, 320.0, vFogDepth);
          diffuseColor.rgb = mix(diffuseColor.rgb, uFogColor * 1.1, mir * 0.3 * (0.55 + 0.45 * sin(s * 0.7 - uTime * 1.4 + ad * 2.0)));
        }`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
        #ifndef ROAD_LOW
        roughnessFactor = clamp(gRn.a * (0.55 + 0.6 * gDn.a), 0.1, 1.0);
        #endif
        roughnessFactor = mix(roughnessFactor, 0.045, gWet);`)
      .replace('texture2D( normalMap, vNormalMapUv ).xyz', 'vec3(((gRn.xy * 2.0 - 1.0) + (gDn.xy * 2.0 - 1.0) * (1.0 - smoothstep(25.0, 95.0, vFogDepth)) * 0.9) * (1.0 - 0.88 * gWet) * 0.5 + 0.5, gRn.z)');
    if (lowQ) { sh.fragmentShader = '#define ROAD_LOW\n' + sh.fragmentShader; }
    sh.vertexShader = sh.vertexShader.replace('varying vec2 vRoadUV;', 'varying vec2 vRoadUV; varying vec2 vRoadWP;').replace('vRoadUV = uv;', 'vRoadUV = uv; vRoadWP = (modelMatrix * vec4(position, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('varying vec2 vRoadUV;', 'varying vec2 vRoadUV; varying vec2 vRoadWP;');
  });
  const chunks = [];
  const roadIdx = new Uint32Array(CHUNK * 18);
  for (let r = 0; r < CHUNK; r++) for (let q = 0; q < 3; q++) {
    const a = r * 4 + q, b = a + 1, c = a + 4, d = c + 1;
    const o = (r * 3 + q) * 6;
    roadIdx[o] = a; roadIdx[o + 1] = b; roadIdx[o + 2] = c; roadIdx[o + 3] = b; roadIdx[o + 4] = d; roadIdx[o + 5] = c;
  }
  const rd = [-edge, -hw, hw, edge].map((v) => -v); // left (+d) -> right (-d)
  for (let r0 = 0; r0 < N - 1; r0 += CHUNK) {
    if (sl()) yield;
    const r1 = Math.min(r0 + CHUNK, N - 1);
    const rows = r1 - r0 + 1;
    const pos = new Float32Array(rows * 12), uv = new Float32Array(rows * 8), nor = new Float32Array(rows * 12);
    for (let r = 0; r < rows; r++) {
      const j = r0 + r;
      for (let q = 0; q < 4; q++) {
        const d = rd[q];
        const o = (r * 4 + q) * 3;
        pos[o] = cx[j] + lx[j] * d; pos[o + 1] = cy[j] - d * tb[j]; pos[o + 2] = cz[j] + lz[j] * d;
        uv[(r * 4 + q) * 2] = d; uv[(r * 4 + q) * 2 + 1] = sOf(j);
        const gr = (cy[Math.min(j + 1, N - 1)] - cy[Math.max(j - 1, 0)]) / (2 * step), hx = -Math.sin(yaw[j]), hz = -Math.cos(yaw[j]);
        let nx = tb[j] * lx[j] - gr * hx, nz = tb[j] * lz[j] - gr * hz; const nl = Math.hypot(nx, 1, nz);
        nor[o] = nx / nl; nor[o + 1] = 1 / nl; nor[o + 2] = nz / nl;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute((rows - 1) === CHUNK ? roadIdx : roadIdx.slice(0, (rows - 1) * 18), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, roadMat);
    group.add(m);
    chunks.push({ mesh: m, s0: sOf(r0), s1: sOf(r1), kind: 0 });
  }

  // --- terrain ---
  const COLS = NO * 2;
  const tpos = new Float32Array(N * COLS * 3);
  const tcol = new Float32Array(N * COLS * 3);
  const dOff = new Float32Array(COLS);
  for (let c = 0; c < NO; c++) { dOff[c] = edge + OFFS[NO - 1 - c]; dOff[NO + c] = -(edge + OFFS[c]); }
  // inside-of-bend caps (smoothed along s) so the skirt never folds over itself
  const capL = new Float32Array(N).fill(2000), capR = new Float32Array(N).fill(2000);
  for (let j = 0; j < N; j++) {
    const k = cv[j];
    if (k > 0) capL[j] = Math.max(0.8 / k - edge, 4);
    else if (k < 0) capR[j] = Math.max(0.8 / -k - edge, 4);
  }
  const smoothCap = (a) => {
    const o = new Float32Array(N), t = new Float32Array(N);
    for (let j = 0; j < N; j++) { let m = 1e9; for (let i = Math.max(0, j - 20); i <= Math.min(N - 1, j + 20); i++) m = Math.min(m, a[i]); o[j] = m; }
    for (let j = 0; j < N; j++) { let sum = 0, c = 0; for (let i = Math.max(0, j - 12); i <= Math.min(N - 1, j + 12); i++) { sum += o[i]; c++; } t[j] = sum / c; }
    return t;
  };
  const capLs = smoothCap(capL), capRs = smoothCap(capR);
  const softOff = (off, cap) => (off <= 0.5 * cap ? off : 0.5 * cap + 0.5 * cap * Math.tanh((off - 0.5 * cap) / (0.5 * cap)));
  for (let j = 0; j < N; j++) {
    if (sl()) yield;
    const s = sOf(j);
    for (let c = 0; c < COLS; c++) {
      const left = c < NO;
      const off = softOff(OFFS[left ? NO - 1 - c : c - NO], left ? capLs[j] : capRs[j]);
      const d = left ? edge + off : -(edge + off);
      const x = cx[j] + lx[j] * d, z = cz[j] + lz[j] * d;
      const o = (j * COLS + c) * 3;
      tpos[o] = x; tpos[o + 1] = ground(s, d, x, z); tpos[o + 2] = z;
    }
  }
  // normals from central differences of the height grid (sliced; one-sided across the road gap)
  const tnor = new Float32Array(N * COLS * 3);
  for (let j = 0; j < N; j++) {
    if (sl()) yield;
    const j0 = j > 0 ? j - 1 : 0, j1 = j < N - 1 ? j + 1 : N - 1;
    for (let c = 0; c < COLS; c++) {
      const c0 = (c > 0 && c !== NO) ? c - 1 : c, c1 = (c < COLS - 1 && c !== NO - 1) ? c + 1 : c;
      const pa = (j1 * COLS + c) * 3, pb = (j0 * COLS + c) * 3, pc = (j * COLS + c1) * 3, pd = (j * COLS + c0) * 3;
      const ax = tpos[pa] - tpos[pb], ay = tpos[pa + 1] - tpos[pb + 1], az = tpos[pa + 2] - tpos[pb + 2];
      const bx = tpos[pc] - tpos[pd], by = tpos[pc + 1] - tpos[pd + 1], bz = tpos[pc + 2] - tpos[pd + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1, o = (j * COLS + c) * 3;
      tnor[o] = nx / l; tnor[o + 1] = ny / l; tnor[o + 2] = nz / l;
    }
  }
  // vertex data: macro brightness (colour attr), material weights A grass / B alt / C dirt-gravel / D rock, world uv for the normal detail
  const base = new THREE.Color(theme.ground), alt = new THREE.Color(T.gnd2), rockC = new THREE.Color(T.rock);
  const dirtC = base.clone().lerp(new THREE.Color(T.dirt || 0x7a6246), 0.6).multiplyScalar(0.8);
  const tw = new Float32Array(N * COLS * 4), tuv = new Float32Array(N * COLS * 2);
  for (let j = 0; j < N; j++) for (let c = 0; c < COLS; c++) {
    if (c === 0 && sl()) yield;
    const o = (j * COLS + c) * 3, o4 = (j * COLS + c) * 4;
    const x = tpos[o], z = tpos[o + 2], ny = tnor[o + 1];
    const off = c < NO ? OFFS[NO - 1 - c] : OFFS[c - NO];
    const n1 = vnoise(x / 17, z / 17, seed + 5), n2 = vnoise(x / 3.7, z / 3.7, seed + 9), n3 = fbm(x / 70, z / 70, seed + 13, 2), n4 = vnoise(x / 9, z / 9, seed + 21);
    let wD = ss((T.rockSlope + 0.07 - ny) / 0.16) * 0.95;
    let wC = Math.max(1 - ss((off - 0.4) / 3.2), ss((n4 - 0.76) / 0.12) * 0.7);
    const wB = ss((n3 - 0.42) / 0.3) * 0.9;
    let a_ = (1 - wB) * (1 - wC) * (1 - wD), b_ = wB * (1 - wC) * (1 - wD), c_ = wC * (1 - wD), d_ = wD;
    const sum = a_ + b_ + c_ + d_ || 1;
    tw[o4] = a_ / sum; tw[o4 + 1] = b_ / sum; tw[o4 + 2] = c_ / sum; tw[o4 + 3] = d_ / sum;
    let v = 1 - T.tint * 0.6 + T.tint * 1.2 * n1;
    v *= 0.9 + 0.2 * n2;
    v *= (T.lift || 1);
    tcol[o] = v; tcol[o + 1] = v * (0.98 + 0.04 * n1); tcol[o + 2] = v * (0.96 + 0.06 * n3);
    tuv[(j * COLS + c) * 2] = x * 0.24; tuv[(j * COLS + c) * 2 + 1] = z * 0.24;
  }
  const L4 = LAYERS[theme.roadside] || LAYERS.pines;
  const gm = L4.map((n) => groundMat(n, quality));
  const targets = [theme.ground, T.gnd2, dirtC.getHex(), T.rock];
  const tints = L4.map((n, i) => { const t = tintFor(n, targets[i], i === 3 ? 0.55 : 0.75); return new THREE.Vector3(t[0], t[1], t[2]); });
  const lin = (c) => Math.pow(Math.max(c, 1e-3), 2.2);
  const fars = L4.map((n, i) => { const m = MEAN[n], t = tints[i]; return new THREE.Vector3(lin(m[0]) * t.x, lin(m[1]) * t.y, lin(m[2]) * t.z); });
  const gset = { a: gm[0].a, b: gm[1].a, c: gm[2].a, d: gm[3].a, nA: gm[0].n, nD: gm[3].n, rockN: gm[3].n, tint: tints, far: fars };
  const sea0 = T.sea ? seaY : -1e5;
  const hiQ = quality === 'high', lowT = quality === 'low';
  const terrMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.5, normalMap: lowT ? null : gset.nA, normalScale: new THREE.Vector2(0.9, 0.9) });
  const terrU = { tA: { value: gset.a }, tB: { value: gset.b }, tC: { value: gset.c }, tD: { value: gset.d }, nA: { value: gset.nA }, nD: { value: gset.nD }, tMacro: { value: lowT ? sharedNoise() : macroTex(quality) },
    uTA: { value: tints[0] }, uTB: { value: tints[1] }, uTC: { value: tints[2] }, uTD: { value: tints[3] }, uFA: { value: fars[0] }, uFB: { value: fars[1] }, uFC: { value: fars[2] }, uFD: { value: fars[3] },
    uSeaY: { value: sea0 }, tNoise: { value: sharedNoise() }, uCloudK: shared.uCloudK, uTime: shared.uTime, uWind: shared.uWind };
  patchMaterial(terrMat, 'terrain' + quality, (sh) => {
    Object.assign(sh.uniforms, terrU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aW; varying vec4 vW; varying vec2 vGP; varying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = aW; vGP = position.xz; vWP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec4 vW; varying vec2 vGP; varying vec3 vWP; uniform sampler2D tA; uniform sampler2D tB; uniform sampler2D tC; uniform sampler2D tD; uniform sampler2D nA; uniform sampler2D nD; uniform sampler2D tMacro;
      uniform vec3 uTA; uniform vec3 uTB; uniform vec3 uTC; uniform vec3 uTD; uniform vec3 uFA; uniform vec3 uFB; uniform vec3 uFC; uniform vec3 uFD; uniform float uSeaY;
      ${CLOUD_SH_GLSL}
      vec4 gNs;`)
      .replace('#include <map_fragment>', `
        vec2 gp = vGP * 0.24;
        float gd = vFogDepth;
        float far = smoothstep(90.0, 280.0, gd);
        ${lowT ? `vec3 gt = texture2D(tA, gp).rgb * uTA * (vW.x + vW.y + vW.z) + texture2D(tD, gp * 0.7).rgb * uTD * vW.w;
        vec3 farc = uFA * (vW.x + vW.y + vW.z) + uFD * vW.w; gt = mix(gt, farc, far * 0.8);` : `
        vec3 mc = texture2D(tMacro, vGP * 0.0031).rgb; vec3 mc2 = texture2D(tMacro, vGP * 0.0113 + 0.37).rgb;
        vec3 gA = texture2D(tA, gp).rgb;
        ${hiQ ? 'gA = mix(gA, texture2D(tA, gp * 0.31 + 0.17).rgb, smoothstep(0.35, 0.65, mc.r) * 0.6);' : ''}
        vec3 gt = gA * uTA * vW.x + texture2D(tB, gp * 0.93 + 0.31).rgb * uTB * vW.y + texture2D(tC, gp * 1.1 + 0.17).rgb * uTC * vW.z + texture2D(tD, gp * 0.7).rgb * uTD * vW.w;
        vec3 farc = (uFA * vW.x + uFB * vW.y + uFC * vW.z + uFD * vW.w) * (0.82 + 0.36 * mc2.g);
        gt = mix(gt, farc, far * 0.85);
        float pat = texture2D(tMacro, vGP * 0.0287 + 0.13).r, pat2 = texture2D(tMacro, vGP * 0.081 + 0.61).b;
        gt *= 0.84 * (0.5 + 1.0 * pat) * (0.8 + 0.4 * pat2) * (0.8 + 0.4 * mc.g);
        gt *= mix(vec3(1.05, 1.0, 0.93), vec3(0.95, 1.0, 1.06), mc2.b);
        vec4 nAs = texture2D(nA, gp); vec4 nDs = ${hiQ ? 'texture2D(nD, gp * 0.7)' : 'nAs'};
        gNs = mix(nAs, nDs, vW.w); gNs.xyz = mix(gNs.xyz, vec3(0.5, 0.5, 1.0), far);`}
        float cs = cloudShade(vGP);
        gt *= 1.0 - 0.22 * cs;
        {
          float ys = vWP.y - uSeaY;
          float wv = 0.28 * sin(uTime * 0.9 + vWP.x * 0.07 + vWP.z * 0.05) + 0.16 * sin(uTime * 1.7 + vWP.z * 0.13);
          float sh0 = ys - wv * 0.6;
          float foam = (1.0 - smoothstep(0.15, 0.95, abs(sh0 + 0.25))) * (0.55 + 0.45 * sin(vWP.x * 0.9 + vWP.z * 0.7 - uTime * 2.0));
          gt *= mix(1.0, 0.6, (1.0 - smoothstep(-0.3, 0.9, sh0)) * step(-1e4, uSeaY));
          gt = mix(gt, vec3(0.92), clamp(foam, 0.0, 1.0) * 0.75 * step(-1e4, uSeaY));
        }
        diffuseColor.rgb *= gt;`);
    if (!lowT) sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gNs.a;').replace('texture2D( normalMap, vNormalMapUv ).xyz', 'gNs.xyz');
  });
  const tIdxFull = new Uint32Array((CHUNK) * (COLS - 1) * 6);
  const mkIdx = (rows) => {
    const idx = new Uint32Array((rows - 1) * (COLS - 1) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) for (let c = 0; c < COLS - 1; c++) {
      if (c === NO - 1) continue;
      const a = j * COLS + c, b = a + 1, cc = a + COLS, d = cc + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = cc; idx[o++] = b; idx[o++] = d; idx[o++] = cc;
    }
    return idx.subarray(0, o);
  };
  const idxCache = new Map();
  for (let r0 = 0; r0 < N - 1; r0 += CHUNK) {
    if (sl()) yield;
    const r1 = Math.min(r0 + CHUNK, N - 1);
    const rows = r1 - r0 + 1;
    const a0 = r0 * COLS * 3, a1 = (r1 + 1) * COLS * 3, j0 = r0 * COLS, j1 = (r1 + 1) * COLS;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tpos.subarray(a0, a1), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(tnor.subarray(a0, a1), 3));
    g.setAttribute('color', new THREE.BufferAttribute(tcol.subarray(a0, a1), 3));
    g.setAttribute('aW', new THREE.BufferAttribute(tw.subarray(j0 * 4, j1 * 4), 4));
    g.setAttribute('uv', new THREE.BufferAttribute(tuv.subarray(j0 * 2, j1 * 2), 2));
    if (!idxCache.has(rows)) idxCache.set(rows, mkIdx(rows));
    g.setIndex(new THREE.BufferAttribute(idxCache.get(rows), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, terrMat);
    group.add(m);
    chunks.push({ mesh: m, s0: sOf(r0), s1: sOf(r1), kind: 1 });
  }

  // --- sea ---
  let sea = null;
  if (T.sea) {
    const seaMat = new THREE.MeshStandardMaterial({ color: 0x1b6c8e, roughness: 0.1, metalness: 0.05, envMapIntensity: 1.1 });
    patchMaterial(seaMat, 'sea' + quality, (sh) => {
      sh.uniforms.uTime = shared.uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vSeaP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaP = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vSeaP; uniform float uTime;')
        .replace('#include <normal_fragment_maps>', `
          vec2 sp = vSeaP; float st = uTime;
          vec2 g = vec2(0.0); float hh = 0.0;
          { float k = dot(sp, vec2(0.074, 0.032)) + st * 1.1; g += vec2(0.074, 0.032) * cos(k) * 0.55; hh += sin(k) * 0.5; }
          { float k = dot(sp, vec2(-0.05, 0.11)) + st * 1.4; g += vec2(-0.05, 0.11) * cos(k) * 0.45; hh += sin(k) * 0.4; }
          { float k = dot(sp, vec2(0.21, -0.13)) + st * 2.1; g += vec2(0.21, -0.13) * cos(k) * 0.22; hh += sin(k) * 0.2; }
          ${quality === 'low' ? '' : '{ float k = dot(sp, vec2(0.62, 0.41)) + st * 3.3; g += vec2(0.62, 0.41) * cos(k) * 0.07 * (0.05 + 0.95 * (1.0 - smoothstep(20.0, 120.0, length(vViewPosition)))); } { float k = dot(sp, vec2(-0.47, 0.77)) + st * 3.9; g += vec2(-0.47, 0.77) * cos(k) * 0.06 * (0.05 + 0.95 * (1.0 - smoothstep(20.0, 120.0, length(vViewPosition)))); }'}
          float kd = 1.0 / (1.0 + length(vViewPosition) * 0.02); g *= kd;
          vec3 wn = normalize(vec3(-g.x, 1.0, -g.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          diffuseColor.rgb += vec3(smoothstep(0.62, 1.05, hh)) * 0.35;`);
    });
    sea = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000).rotateX(-Math.PI / 2), seaMat);
    sea.position.y = seaY;
    group.add(sea);
  }

  // --- arches ---
  const arches = [];
  const tmpS = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
  function banner(text, bg, fg, chequer) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 192;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 1024, 192);
    if (chequer) {
      for (let i = 0; i < 64; i++) for (let j = 0; j < 12; j++) if ((i + j) & 1) { g.fillStyle = '#fff'; if (j < 2 || j >= 10) g.fillRect(i * 16, j * 16, 16, 16); }
    }
    g.font = 'bold 120px Impact, Arial Black, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#000'; g.strokeText(text, 512, 98);
    g.fillStyle = fg; g.fillText(text, 512, 98);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  function makeArch(s, text, bg, fg, chequer) {
    track.sampleAt(s, tmpS);
    const g = new THREE.Group();
    g.position.set(tmpS.x, tmpS.y, tmpS.z);
    g.rotation.y = tmpS.yaw;
    const hwA = edge + 1.0;
    const m = new Mesher();
    m.box(0.55, 7.4, 0.55, [-hwA, 3.3, 0], 0x6b6e75).box(0.55, 7.4, 0.55, [hwA, 3.3, 0], 0x6b6e75);
    m.box(0.9, 0.5, 0.9, [-hwA, -0.2, 0], 0x35373c).box(0.9, 0.5, 0.9, [hwA, -0.2, 0], 0x35373c);
    m.box(2 * hwA + 1.2, 0.7, 0.7, [0, 7.2, 0], 0x5a5d64);
    m.box(2 * hwA, 0.12, 0.12, [0, 4.55, 0], 0x35373c);
    for (let i = 0; i < 4; i++) m.box(0.16, 0.16, 0.16, [-hwA + 1.2 + i * (hwA * 2 - 2.4) / 3, 7.65, 0], 0xffe08a, 4);
    const mesh = new THREE.Mesh(m.build(), fogify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4, envMapIntensity: 0.6 }), 'arch'));
    g.add(mesh);
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(2 * hwA, 2 * hwA * 192 / 1024 * 1.0), fogify(new THREE.MeshBasicMaterial({ map: banner(text, bg, fg, chequer), side: THREE.DoubleSide }), 'banner'));
    ban.position.set(0, 5.75, 0);
    g.add(ban);
    group.add(g);
    arches.push(g);
  }
  makeArch(24, 'ROAD  RASH', '#c8102e', '#ffffff', false);
  makeArch(track.finishS, 'FINISH', '#101010', '#ffffff', true);

  const tR = { s: 0, d: 0, yaw: 0 };
  /** Updates chunk visibility around camera s. */
  function update(camS, ahead, back) {
    for (const c of chunks) c.mesh.visible = c.s1 > camS - back && c.s0 < camS + ahead;
    for (const a of arches) a.visible = true;
  }

  function dispose() {
    for (const c of chunks) c.mesh.geometry.dispose();
    roadMat.dispose(); terrMat.dispose();
    if (sea) { sea.geometry.dispose(); sea.material.dispose(); }
    for (const a of arches) a.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }

  const textures = [rs.map, rs.normal, rs.detail, rs.grime, ...gm.map((g) => g.a), gm[0].n, gm[3].n];
  return { group, T, gset, textures, ground, edgeY, update, seaY, sea, edge, hw, dispose, rows: { N, PAD, cx, cy, cz, lx, lz, tb, cv, step }, tR };
}
