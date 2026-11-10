// Shared look: colour-managed fog/haze patch, shared lighting uniforms and procedural canvas textures
// (asphalt ported from Slipstream Highway, ground, rock, clouds). Everything is generated at load, no asset files.
import * as THREE from '../../public/vendor/three.module.min.js';

// ---------------------------------------------------------------- shared uniforms (singleton)
const SHARED = {
  uFogColor: { value: new THREE.Color(0xc5d6ea) }, uFogNear: { value: 80 }, uFogFar: { value: 650 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
  uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) }, uSky: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uCam: { value: new THREE.Vector3() }, uStreak: { value: 0 },
  uSunV: { value: new THREE.Vector3(0, 0, -1) }, uHazeSun: { value: new THREE.Color(0, 0, 0) },
  uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.3) }, uCloudK: { value: 0.8 },
};
/** GLSL: soft cloud shadows projected on the ground from the shared noise texture (drifting with the wind, no shadow maps). */
export const CLOUD_SH_GLSL = `uniform sampler2D tNoise; uniform float uCloudK; uniform float uTime; uniform vec2 uWind;
float cloudShade(vec2 p){ vec2 q = p * 0.0022 + uWind * uTime * 0.0035; float n = texture2D(tNoise, q).r * 0.62 + texture2D(tNoise, q * 3.3).g * 0.38; return smoothstep(0.5, 0.74, n) * uCloudK; }`;
/** GLSL: wind gust travelling across the scene along uWind (0..1), p = world xz. */
export const GUST_GLSL = `float windGust(vec2 p, float t, vec2 w){ float k = dot(p, normalize(w + 1e-4)); return 0.5 + 0.5 * sin(k * 0.035 - t * 1.6 + sin(k * 0.011 + t * 0.3) * 2.0); }`;
let _noise = null;
/** The shared tiling noise texture (sky clouds, cloud shadows). */
export function sharedNoise() { return _noise || (_noise = makeCloudTex(256, 7)); }
/** Shared lighting/fog uniforms for all custom shaders (a singleton). */
export function makeShared() { return SHARED; }

// ---------------------------------------------------------------- fog patch
// Fog is mixed BEFORE tone mapping, in linear light, with the same colour the sky shader uses at the horizon,
// so fog and sky meet exactly on every tier. A warm in-scatter term brightens haze toward the sun.
const FOG_PARS_V = `#include <fog_pars_vertex>\nvarying vec3 vFogV;`;
const FOG_V = `#include <fog_vertex>\nvFogV = mvPosition.xyz;`;
const FOG_PARS_F = `#include <fog_pars_fragment>\nvarying vec3 vFogV;\nuniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform vec3 uSunV; uniform vec3 uHazeSun;`;
const FOG_F = `#ifdef USE_FOG
  float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
  float sgl = pow(clamp(dot(normalize(vFogV), uSunV), 0.0, 1.0), 5.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor + uHazeSun * sgl, fogF);
#endif
#include <tonemapping_fragment>`;

/** Patches a built-in shader (Standard/Lambert/Basic) for the shared linear fog. */
export function fogPatch(sh) {
  sh.uniforms.uFogColor = SHARED.uFogColor; sh.uniforms.uFogNear = SHARED.uFogNear; sh.uniforms.uFogFar = SHARED.uFogFar;
  sh.uniforms.uSunV = SHARED.uSunV; sh.uniforms.uHazeSun = SHARED.uHazeSun;
  sh.vertexShader = sh.vertexShader.replace('#include <fog_pars_vertex>', FOG_PARS_V).replace('#include <fog_vertex>', FOG_V);
  sh.fragmentShader = sh.fragmentShader.replace('#include <fog_pars_fragment>', FOG_PARS_F)
    .replace('#include <fog_fragment>', '').replace('#include <tonemapping_fragment>', FOG_F);
}

/** Chains `extra(shader)` after the fog patch on a material, with a program cache key. */
export function patchMaterial(mat, key, extra) {
  mat.onBeforeCompile = (sh) => { fogPatch(sh); if (extra) extra(sh); };
  mat.customProgramCacheKey = () => key;
  return mat;
}
/** Plain fog-only patch (materials from other modules). */
export function fogify(mat, key = 'fog') { return patchMaterial(mat, key, null); }

// ---------------------------------------------------------------- noise helpers
function hsh(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Periodic value noise: lattice of `px` x `py` cells over u,v in [0,1). */
export function pnoise(u, v, px, py, seed) {
  const x = u * px, y = v * py;
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((iy % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hsh(x0, y0, seed), b = hsh(x1, y0, seed), c = hsh(x0, y1, seed), d = hsh(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function pfbm(u, v, px, py, seed, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += a * pnoise(u, v, px, py, seed + i * 17); n += a; px *= 2; py *= 2; a *= 0.5; }
  return s / n;
}
const mix = (a, b, t) => a + (b - a) * t;
const cl = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
function rgb(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }
function lerp3(a, b, t) { return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; }

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function finishTex(cv, { srgb = true, repeat = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
/** Fills a canvas per pixel from fn(u, v, i) -> [r,g,b] (0..1 sRGB values). */
function paint(size, fn) {
  const cv = makeCanvas(size, size), g = cv.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = fn(x / size, y / size, x, y), o = (y * size + x) * 4;
    d[o] = cl(c[0]) * 255; d[o + 1] = cl(c[1]) * 255; d[o + 2] = cl(c[2]) * 255; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}
/** Tangent-space normal map canvas from a periodic height function (0..1), strength k. */
function normalFrom(size, hfn, k) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = hfn(x / size, y / size);
  const cv = makeCanvas(size, size), g = cv.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = (x + size - 1) % size, xr = (x + 1) % size, yu = (y + size - 1) % size, yd = (y + 1) % size;
    const dx = (H[y * size + xr] - H[y * size + xl]) * k, dy = (H[yd * size + x] - H[yu * size + x]) * k;
    const l = Math.hypot(dx, dy, 1), o = (y * size + x) * 4;
    d[o] = (-dx / l * 0.5 + 0.5) * 255; d[o + 1] = (dy / l * 0.5 + 0.5) * 255; d[o + 2] = (1 / l * 0.5 + 0.5) * 255; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// ---------------------------------------------------------------- ground / rock textures
/**
 * Ground texture set for a theme: grass A, grass B, dirt C, rock D (tiling, sRGB) and a rock normal map.
 * @param {{a:number,b:number,c:number,d:number,strata?:boolean}} cols hex colours
 */
export function makeGroundSet(cols, size = 256, seed = 1) { return drain(groundSetGen(cols, size, seed)); }
function drain(g) { let r = g.next(); while (!r.done) r = g.next(); return r.value; }
function* groundSetGen(cols, size = 256, seed = 1) {
  const A = rgb(cols.a), B = rgb(cols.b), C = rgb(cols.c), D = rgb(cols.d);
  const blades = (u, v, s, c1, c2, fx, fy, grit) => {
    const m = pfbm(u, v, 4, 4, s, 3);
    const st = pnoise(u, v, fx, fy, s + 5) * 0.65 + pnoise(u, v, fx * 2, fy * 2, s + 9) * 0.35;
    let c = lerp3(c1, c2, cl(m * 1.3 - 0.1));
    const k = 0.62 + 0.75 * st;
    const sp = pnoise(u, v, 96, 96, s + 3) > 0.86 ? 1.25 : 1;
    return [c[0] * k * sp, c[1] * k * sp, c[2] * k * sp];
  };
  const dark = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const grassA = paint(size, (u, v) => blades(u, v, seed, dark(A, 0.78), mix3(A, B, 0.25), 40, 9));
  yield;
  const grassB = paint(size, (u, v) => blades(u, v, seed + 40, dark(B, 0.8), mix3(B, [1, 1, 1], 0.12), 36, 8));
  yield;
  const dirt = paint(size, (u, v) => {
    const m = pfbm(u, v, 5, 5, seed + 80, 4);
    const peb = pnoise(u, v, 38, 38, seed + 83);
    const pb = peb > 0.74 ? 0.5 + (peb - 0.74) * 2.4 : 0;
    let c = lerp3(dark(C, 0.78), mix3(C, [1, 1, 1], 0.08), m);
    const k = 0.82 + 0.3 * pnoise(u, v, 80, 80, seed + 85);
    return [c[0] * k + pb * 0.16, c[1] * k + pb * 0.15, c[2] * k + pb * 0.13];
  });
  const rockH = (u, v) => {
    const w = (pfbm(u, v, 3, 3, seed + 120, 4) - 0.5) * 0.35;
    const n = cols.strata ? pfbm(u, v + w, 2, 14, seed + 121, 4) : pfbm(u + w, v + w, 6, 6, seed + 121, 4);
    const r = 1 - Math.abs(pfbm(u, v, 7, 7, seed + 130, 3) * 2 - 1);
    return cols.strata ? n * 0.8 + r * 0.2 : n * 0.5 + r * r * 0.5;
  };
  yield;
  const rock = paint(size, (u, v) => {
    const h = rockH(u, v), m = pfbm(u, v, 3, 3, seed + 140, 3);
    const c = lerp3(dark(D, 0.8), mix3(D, [1, 1, 1], 0.12), cl(h * 1.2));
    const k = 0.92 + 0.3 * m;
    return [c[0] * k, c[1] * k, c[2] * k];
  });
  yield;
  const rockN = normalFrom(size, rockH, 2.4);
  const tx = (cv, srgb = true) => finishTex(cv, { srgb });
  return { a: tx(grassA), b: tx(grassB), c: tx(dirt), d: tx(rock), rockN: tx(rockN, false) };
}
function mix3(a, b, t) { return lerp3(a, b, t); }

/** Tiling noise texture (R: low freq, G: mid, B: high, A unused) for clouds and macro variation. */
export function makeCloudTex(size = 256, seed = 7) {
  const cv = makeCanvas(size, size), g = cv.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, o = (y * size + x) * 4;
    d[o] = pfbm(u, v, 3, 3, seed, 5) * 255; d[o + 1] = pfbm(u, v, 5, 5, seed + 31, 5) * 255;
    d[o + 2] = pfbm(u, v, 9, 9, seed + 77, 4) * 255; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = finishTex(cv, { srgb: false, aniso: 1 });
  return t;
}

// ---------------------------------------------------------------- asphalt (ported from Slipstream's 04-road.js)
function rnd(seed) { let a = seed | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * Road textures. macro: lane tones, patches, wheel tracks, oil, joints, cracks, shoulder chip-seal and worn paint,
 * mapped across the full width (2*edge) and LEN metres along the road. detail: aggregate normal map + roughness (tiles per 3 m).
 */
export function makeRoadTextures(hw, edge, tarmac, size = 1024, seed = 9) { return drain(roadTexGen(hw, edge, tarmac, size, seed)); }
function* roadTexGen(hw, edge, tarmac, size = 1024, seed = 9) {
  const R = rnd(seed), rand = (a, b) => a + (b - a) * R();
  const LEN = 18, W = size, H = size, RW = edge;
  const cv = makeCanvas(W, H), x = cv.getContext('2d');
  const px = (m) => (m + RW) / (2 * RW) * W, py = (m) => m / LEN * H;
  const base = new THREE.Color(tarmac).getStyle();
  const tc = new THREE.Color(tarmac).convertLinearToSRGB();
  const t0 = Math.round(tc.r * 255 * 0.95), t1 = Math.round(tc.g * 255 * 0.95), t2 = Math.round(tc.b * 255 * 0.95);
  x.fillStyle = `rgb(${t0},${t1},${t2})`; x.fillRect(0, 0, W, H);
  // each lane was laid separately: slight tone shifts
  for (const [a, b] of [[-edge, -hw], [-hw, 0], [0, hw], [hw, edge]]) {
    const t = Math.round(rand(-5, 5));
    x.fillStyle = `rgba(${t > 0 ? 255 : 0},${t > 0 ? 255 : 0},${t > 0 ? 255 : 0},${Math.abs(t) * 0.012})`;
    x.fillRect(px(a), 0, px(b) - px(a), H);
  }
  // aggregate: thousands of light and dark stones
  const stones = Math.round(W * H * 0.09);
  for (let i = 0; i < stones; i++) { const v = R() < 0.5 ? 255 : 0; x.fillStyle = `rgba(${v},${v},${v},${rand(0.03, 0.12)})`; x.fillRect(rand(0, W), rand(0, H), rand(1, 2.2), rand(1, 2.2)); }
  // patched repairs with sealed edges
  for (let i = 0; i < 4; i++) {
    const cxm = rand(-hw * 0.8, hw * 0.8), wm = rand(1.0, 2.4), y0 = rand(0, LEN - 5), hm = rand(0.8, 3.4);
    x.fillStyle = `rgba(0,0,0,${rand(0.08, 0.15)})`; x.fillRect(px(cxm - wm / 2), py(y0), px(cxm + wm / 2) - px(cxm - wm / 2), py(hm));
    x.strokeStyle = 'rgba(10,10,12,0.45)'; x.lineWidth = 1.4; x.strokeRect(px(cxm - wm / 2), py(y0), px(cxm + wm / 2) - px(cxm - wm / 2), py(hm));
  }
  // wheel tracks: polished darker bands, oil line down the middle of each lane
  for (const lc of [-hw / 2, hw / 2]) {
    for (const o of [-0.88, 0.88]) {
      const a = px(lc + o - 0.42), b = px(lc + o + 0.42), g = x.createLinearGradient(a, 0, b, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(a, 0, b - a, H);
    }
    for (let k = 0; k < 18; k++) { x.fillStyle = `rgba(0,0,0,${rand(0.05, 0.13)})`; x.beginPath(); x.ellipse(px(lc + rand(-0.25, 0.25)), rand(0, H), rand(3, 10), rand(10, 38), 0, 0, Math.PI * 2); x.fill(); }
  }
  // sealed cracks wandering across and along
  for (let i = 0; i < 9; i++) {
    x.lineWidth = rand(1.2, 2.6); x.strokeStyle = `rgba(10,10,11,${rand(0.4, 0.75)})`; x.beginPath();
    let cx = rand(0, W), cy = rand(0, H); x.moveTo(cx, cy); const tr = R() < 0.5;
    for (let k = 0; k < 12; k++) { cx += tr ? rand(8, 22) : rand(-6, 6); cy += tr ? rand(-6, 6) : rand(10, 24); x.lineTo(cx, cy); }
    x.stroke();
  }
  // shoulder: paler, older chip-seal with loose gravel, fading into the verge
  for (const sd of [-1, 1]) {
    const a = px(sd * hw), b = px(sd * edge), x0 = Math.min(a, b), w = Math.abs(b - a);
    const g = x.createLinearGradient(sd > 0 ? a : b, 0, sd > 0 ? b : a, 0);
    g.addColorStop(sd > 0 ? 0 : 1, 'rgba(150,146,134,0.30)'); g.addColorStop(sd > 0 ? 1 : 0, 'rgba(150,140,120,0.55)');
    x.fillStyle = g; x.fillRect(x0, 0, w, H);
    for (let i = 0; i < 9000; i++) { const t = rand(110, 230); x.fillStyle = `rgba(${t},${t - 6},${t - 18},${rand(0.15, 0.5)})`; x.fillRect(x0 + rand(0, w), rand(0, H), rand(1, 2.6), rand(1, 2.6)); }
  }
  // markings: centre double-dash yellow, white edge lines (with chips and wear where tyres run)
  const paintRect = (a, b, y0, y1, c) => { x.fillStyle = c; x.fillRect(px(a), py(y0), Math.max(1.5, px(b) - px(a)), py(y1) - py(y0)); };
  for (let k = 0; k < LEN; k += 9) paintRect(-0.09, 0.09, k + 1.0, k + 3.2, '#d9b53f');
  paintRect(-hw + 0.34, -hw + 0.51, 0, LEN, '#e7e5dc'); paintRect(hw - 0.51, hw - 0.34, 0, LEN, '#e7e5dc');
  x.globalCompositeOperation = 'destination-out';
  x.globalCompositeOperation = 'source-over';
  // wear: speckled multiply (paint chips) concentrated near the wheel tracks, then fine grit over everything
  x.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 9000; i++) { const t = rand(150, 240); x.fillStyle = `rgb(${t},${t},${t})`; x.fillRect(rand(0, W), rand(0, H), rand(1, 3), rand(1, 3)); }
  x.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 2600; i++) { const gx = rand(0, W), gy = rand(0, H); x.fillStyle = `rgba(${t0},${t1},${t2},${rand(0.4, 0.9)})`; const wx = px(rand(-hw, hw)); if (R() < 0.5) x.fillRect(wx, gy, rand(1, 3), rand(1, 4)); }
  const map = finishTex(cv, { srgb: true, aniso: 8 });
  map.wrapS = THREE.ClampToEdgeWrapping;
  yield;
  // detail: aggregate normal + roughness tile
  const S = 256;
  const hf = (u, v) => pnoise(u, v, 64, 64, seed + 3) * 0.55 + pnoise(u, v, 128, 128, seed + 4) * 0.3 + pfbm(u, v, 8, 8, seed + 5, 3) * 0.15;
  const normal = finishTex(normalFrom(S, hf, 1.6), { srgb: false, aniso: 8 });
  const rcv = makeCanvas(S, S), rg = rcv.getContext('2d'), ri = rg.createImageData(S, S);
  for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
    const o = (yy * S + xx) * 4, r = 0.6 + 0.35 * pfbm(xx / S, yy / S, 6, 6, seed + 8, 3) - 0.12 * pnoise(xx / S, yy / S, 90, 90, seed + 9);
    ri.data[o] = 255; ri.data[o + 1] = cl(r) * 255; ri.data[o + 2] = 255; ri.data[o + 3] = 255;
  }
  rg.putImageData(ri, 0, 0);
  const rough = finishTex(rcv, { srgb: false, aniso: 4 });
  return { map, normal, rough, W: 2 * edge, LEN };
}

/** Radial gradient soft glow sprite texture. */
export function makeGlowTex() {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- shared texture caches (kept across track switches)
const texCache = new Map();
const keyOf = (o) => JSON.stringify(o);
/** Ground tiling set, shared by every track with the same palette and size. */
export function getGroundSet(cols, size, seed) {
  const k = 'g' + keyOf([cols, size, seed]);
  let v = texCache.get(k); if (!v) { v = makeGroundSet(cols, size, seed); texCache.set(k, v); }
  return v;
}
/** Asphalt textures, shared by every track with the same width / tarmac colour. */
export function getRoadTextures(hw, edge, tarmac, size, seed) {
  const k = 'r' + keyOf([hw, edge, tarmac, size, seed]);
  let v = texCache.get(k); if (!v) { v = makeRoadTextures(hw, edge, tarmac, size, seed); texCache.set(k, v); }
  return v;
}
/** Same as getGroundSet / getRoadTextures but yields to `wait()` between texture passes so the UI stays smooth. */
export async function getGroundSetAsync(cols, size, seed, wait) {
  const k = 'g' + keyOf([cols, size, seed]); let v = texCache.get(k); if (v) return v;
  const g = groundSetGen(cols, size, seed); let r = g.next(); while (!r.done) { await wait(); r = g.next(); }
  v = r.value; texCache.set(k, v); return v;
}
export async function getRoadTexturesAsync(hw, edge, tarmac, size, seed, wait) {
  const k = 'r' + keyOf([hw, edge, tarmac, size, seed]); let v = texCache.get(k); if (v) return v;
  const g = roadTexGen(hw, edge, tarmac, size, seed); let r = g.next(); while (!r.done) { await wait(); r = g.next(); }
  v = r.value; texCache.set(k, v); return v;
}
/** Every cached texture (for GPU pre-upload). */
export function cachedTextures() { const o = []; for (const v of texCache.values()) for (const t of Object.values(v)) if (t && t.isTexture) o.push(t); return o; }
/** Frees all cached procedural textures (quality change). */
export function clearTextureCache() { for (const v of texCache.values()) for (const t of Object.values(v)) if (t && t.isTexture) t.dispose(); texCache.clear(); }
