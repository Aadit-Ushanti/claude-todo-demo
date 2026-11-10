// Leafy trees and bushes: alpha-tested card foliage on real trunks and branches (assets/nature/*.glb, built in Blender/Python),
// three LODs per species (near mesh, cheap mid mesh, 8-view impostor with baked normals), distance-dithered cross-fades,
// vertex wind sway, baked ambient occlusion, bent normals, back-light translucency. Instances are windowed by track position.
import * as THREE from '../../public/vendor/three.module.min.js';
import { GLTFLoader } from '../../public/vendor/GLTFLoader.js';
import { patchMaterial, makeShared, GUST_GLSL } from './Look.js';

const SH = makeShared();
const URL_OF = (f) => new URL(`../../assets/nature/${f}`, import.meta.url).href;

// near / mid fade-out distances (m, high tier), whether an impostor exists, sway amplitude (m at the tip of a 20 m tree)
export const SPECIES = {
  pine:    { nv: 4, near: 50, mid: 160, imp: true, sway: 0.5 },
  redwood: { nv: 3, near: 52, mid: 180, imp: true, sway: 0.7 },
  palm:    { nv: 3, near: 62, mid: 150, imp: true, sway: 1.1 },
  oak:     { nv: 4, near: 58, mid: 150, imp: true, sway: 0.35 },
  joshua:  { nv: 3, near: 60, mid: 140, imp: true, sway: 0.1 },
  saguaro: { nv: 3, near: 70, mid: 150, imp: true, sway: 0 },
  scrub:   { nv: 1, near: 50, mid: 0, imp: false, sway: 0.1 },
  fern:    { nv: 1, near: 40, mid: 0, imp: false, sway: 0.15 },
};

// ---------------------------------------------------------------- shared per-species resources (cached across tracks)
const cache = new Map();
function loadImage(url) {
  return new Promise((res) => { const i = new Image(); i.onload = () => { (i.decode ? i.decode().catch(() => {}) : Promise.resolve()).then(() => res(i)); }; i.onerror = () => res(null); i.src = url; });
}
/** Downloads and decodes everything for these species; resolves when all are complete. */
export function preloadSpecies(list, q = 'high') { return Promise.all(list.map((sp) => getSpecies(sp, q).whenFull)); }
/** All textures of these species (for GPU pre-upload). */
export function speciesTextures(list, q = 'high') { const o = []; for (const sp of list) { const r = getSpecies(sp, q); o.push(r.tex); if (r.nTex) o.push(r.nTex); if (r.impTex) o.push(r.impTex, r.impN); } return o; }
/** Frees every species' GPU copies except those of `list` (they re-upload when needed). */
export function evictSpecies(list, q) { const keep = new Set(list.map((sp) => `${sp}|${TIER_OF[q]}`)); for (const [k, r] of cache) if (!keep.has(k)) { r.tex.dispose(); if (r.nTex) r.nTex.dispose(); if (r.impTex) { r.impTex.dispose(); r.impN.dispose(); } } }
/** Drops all cached species (tier change). */
export function clearSpecies() { for (const r of cache.values()) { r.tex.dispose(); if (r.nTex) r.nTex.dispose(); if (r.impTex) { r.impTex.dispose(); r.impN.dispose(); } } cache.clear(); }
const TIER_OF = { high: '2k', medium: '1k', low: '512' };
/** Variants per species used at a tier (fewer variants = fewer draw calls; instances vary by scale, yaw and tint). */
export const variantsFor = (def, q) => Math.min(def.nv, q === 'high' ? def.nv : q === 'medium' ? 2 : 1);
/** Starts loading a species: low-res atlas first (placeholder), then geometry, then the full atlas and impostor images. */
function getSpecies(sp, q = 'high') {
  const tk = TIER_OF[q] || '2k', ck = `${sp}|${tk}`;
  let r = cache.get(ck);
  if (r) return r;
  const def = SPECIES[sp];
  const proms = [];
  r = { sp, def, geos: null, tex: new THREE.Texture(), nTex: null, impTex: null, impN: null, meta: null, ready: false, hi: false, listeners: [], whenFull: null };
  r.tex.flipY = false; r.tex.colorSpace = THREE.SRGBColorSpace; r.tex.wrapS = r.tex.wrapT = THREE.ClampToEdgeWrapping; r.tex.anisotropy = 4;
  r.tex.generateMipmaps = true; r.tex.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(ck, r);
  if (tk !== '512') loadImage(URL_OF(`${sp}_atlas_512.webp`)).then((img) => { if (img && !r.hi) { r.tex.image = img; r.tex.needsUpdate = true; } });
  if (q === 'high') {   // bark relief (flat on foliage)
    r.nTex = new THREE.Texture(); r.nTex.flipY = false; r.nTex.wrapS = r.nTex.wrapT = THREE.ClampToEdgeWrapping; r.nTex.anisotropy = 4; { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 1, 1); r.nTex.image = c; r.nTex.needsUpdate = true; }
    proms.push(loadImage(URL_OF(`${sp}_atlasn_1k.webp`)).then((img) => { if (img) { r.nTex.dispose(); r.nTex.image = img; r.nTex.needsUpdate = true; r.nReady = true; } }));
  }
  proms.push(new Promise((res) => new GLTFLoader().load(URL_OF(`${sp}.glb`), (gltf) => {
    const g = {};
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry;
      geo.setAttribute('aF', geo.getAttribute('color')); geo.deleteAttribute('color');
      g[o.name] = geo;
    });
    r.geos = g; r.ready = true; for (const f of r.listeners) f(); res();
  }, undefined, (e) => { console.warn('nature glb failed', sp, e && e.message); res(); })));
  proms.push(loadImage(URL_OF(`${sp}_atlas_${tk}.webp`)).then((img) => { if (img) { r.hi = true; r.tex.dispose(); r.tex.image = img; r.tex.needsUpdate = true; } }));
  if (def.imp) {
    proms.push(fetch(URL_OF('imp.json')).then((x) => x.json()).then((all) => { r.meta = all[sp]; for (const f of r.listeners) f(); }).catch((e) => { console.warn('imp.json failed', e); }));
    const mk = (srgb) => { const t = new THREE.Texture(); t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 2; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
    r.impTex = mk(true); r.impN = mk(false);
    proms.push(loadImage(URL_OF(`${sp}_imp.webp`)).then((img) => { if (img) { r.impTex.image = img; r.impTex.needsUpdate = true; } }));
    proms.push(loadImage(URL_OF(`${sp}_impn.webp`)).then((img) => { if (img) { r.impN.image = img; r.impN.needsUpdate = true; } }));
  }
  r.whenFull = Promise.all(proms);
  return r;
}

// ---------------------------------------------------------------- materials
const FADE_GLSL = `
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float fv = length(vFogV);
  float fade = (1.0 - smoothstep(uFade.z, uFade.w, fv)) * smoothstep(uFade.x, uFade.y, fv);
`;
function treeMaterial(res, role, fade, swayAmp, lowQ) {
  const mat = lowQ ? new THREE.MeshLambertMaterial({ map: res.tex, side: THREE.DoubleSide, alphaTest: 0.26, alphaToCoverage: true })
    : new THREE.MeshStandardMaterial({ map: res.tex, normalMap: res.nTex || null, normalScale: new THREE.Vector2(1, 1), side: THREE.DoubleSide, alphaTest: 0.28, alphaToCoverage: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.55 });
  const u = { uFade: { value: new THREE.Vector4(fade[0], fade[1], fade[2], fade[3]) }, uSway: { value: swayAmp }, uTime: SH.uTime, uWind: SH.uWind, uSunCol: SH.uSunCol };
  patchMaterial(mat, 'tree' + (lowQ ? 'L' : 'S') + (res.nTex ? 'N' : ''), (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aF; varying vec4 vAF; uniform float uTime; uniform float uSway; uniform vec2 uWind;
        ${GUST_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAF = aF;
        {
          #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3]);
          #else
          vec3 ip = vec3(0.0);
          #endif
          float ph = ip.x * 0.11 + ip.z * 0.13;
          float g = sin(uTime * 1.05 + ph) + 0.55 * sin(uTime * 2.3 + ph * 1.7) + 0.3 * sin(uTime * 4.1 + ph * 2.3);
          float gu = windGust(ip.xz, uTime, uWind);
          float sw = aF.x * uSway * (0.42 + 0.3 * g + 1.15 * gu * gu);
          transformed.xz += uWind * sw;
          float fl = sin(uTime * 5.3 + position.x * 2.1 + position.y * 1.7 + ph) * 0.05 * aF.y * (0.6 + 1.2 * gu);
          transformed.xz += vec2(fl, fl * 0.7) * (0.3 + 0.7 * aF.x);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vAF; uniform vec4 uFade; uniform vec3 uSunCol;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${FADE_GLSL}
        if (ign > fade) discard;
        diffuseColor.rgb *= mix(0.5, 1.08, vAF.z);`)
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * uSunCol * vAF.w * 0.22 * clamp(-dot(normalize(vNormal), uSunV) * 0.8 + 0.1, 0.0, 1.0) * vAF.z;`);
  });
  return mat;
}

const IMP_VS = `
attribute float aYaw;
uniform vec3 uSize;
varying vec2 vUv0; varying vec2 vUv1; varying float vT; varying float vYaw; varying vec3 vCol; varying vec3 vFogV; varying float vDepth;
void main(){
  vec3 ip = instanceMatrix[3].xyz;
  float sc = length(instanceMatrix[0].xyz);
  vec2 dh = normalize(cameraPosition.xz - ip.xz + vec2(1e-5));
  vec3 right = vec3(dh.y, 0.0, -dh.x);
  vec3 wp = ip + right * position.x * uSize.x * sc + vec3(0.0, (position.y * uSize.y + uSize.z) * sc, 0.0);
  float f = (atan(dh.x, dh.y) - aYaw) / 0.78539816;
  f = mod(f + 160.0, 8.0);
  float k0 = floor(f); vT = f - k0; float k1 = mod(k0 + 1.0, 8.0);
  vec2 q = vec2(position.x + 0.5, 1.0 - position.y);
  vUv0 = vec2(mod(k0, 4.0) + q.x, floor(k0 / 4.0) + q.y) * vec2(0.25, 0.5);
  vUv1 = vec2(mod(k1, 4.0) + q.x, floor(k1 / 4.0) + q.y) * vec2(0.25, 0.5);
  vYaw = aYaw;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogV = mv.xyz; vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const IMP_FS = `
uniform sampler2D tA; uniform sampler2D tN; uniform vec4 uFade;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform vec3 uSunV; uniform vec3 uHazeSun;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;
varying vec2 vUv0; varying vec2 vUv1; varying float vT; varying float vYaw; varying vec3 vCol; varying vec3 vFogV; varying float vDepth;
void main(){
  vec4 a0 = texture2D(tA, vUv0), a1 = texture2D(tA, vUv1);
  float t = smoothstep(0.15, 0.85, vT);
  vec4 a = mix(a0, a1, t);
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float fv = length(vFogV);
  float fade = smoothstep(uFade.x, uFade.y, fv);
  if (ign > fade) discard;
  float al = smoothstep(0.42, 0.42 + max(fwidth(a.a), 1e-3), a.a);
  if (al <= 0.0) discard;
  vec3 n = mix(texture2D(tN, vUv0).rgb, texture2D(tN, vUv1).rgb, t) * 2.0 - 1.0;
  float c = cos(vYaw), s = sin(vYaw);
  vec3 nw = normalize(vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z));
  float ndl = dot(nw, uSunDir);
  vec3 lit = uAmb * (0.62 + 0.38 * nw.y) * 1.25 + uSunCol * 0.82 * max(ndl, 0.0) + uSunCol * 0.14 * max(-ndl, 0.0);
  vec3 col = a.rgb * vCol * lit * 1.18;
  float fogF = smoothstep(uFogNear, uFogFar, vDepth);
  float sgl = pow(clamp(dot(normalize(vFogV), uSunV), 0.0, 1.0), 5.0);
  col = mix(col, uFogColor + uHazeSun * sgl, fogF);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function impMaterial(res, fade) {
  return new THREE.ShaderMaterial({
    vertexShader: IMP_VS, fragmentShader: IMP_FS, alphaToCoverage: true, transparent: false, side: THREE.DoubleSide,
    uniforms: {
      tA: { value: res.impTex }, tN: { value: res.impN }, uFade: { value: new THREE.Vector4(fade[0], fade[1], 0, 0) }, uSize: { value: new THREE.Vector3(1, 1, 0) },
      uFogColor: SH.uFogColor, uFogNear: SH.uFogNear, uFogFar: SH.uFogFar, uSunV: SH.uSunV, uHazeSun: SH.uHazeSun, uSunDir: SH.uSunDir, uSunCol: SH.uSunCol, uAmb: SH.uAmb,
    },
  });
}

function lowerBound(a, n, v) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }
const _id = new Float32Array(16);

/**
 * Tree / bush instances. add() during placement, finish() once, update() every frame (cheap early-out).
 * @param {string} quality 'low'|'medium'|'high'
 */
export function createNature(quality, scene) {
  const group = new THREE.Group();
  const lowQ = quality === 'low';
  const rs = quality === 'low' ? 0.62 : quality === 'medium' ? 0.78 : 1;
  const groups = {}; // sp -> {inst arrays, classes}
  let alive = true, last = -1e9, lastX = 1e9, lastZ = 1e9;
  const shadowOn = quality === 'high';

  function spec(sp) {
    let g = groups[sp];
    if (!g) {
      const res = getSpecies(sp, quality), def = SPECIES[sp];
      const heavy = sp === 'redwood' ? 0.6 : sp === 'pine' ? 0.75 : 1;   // tall species carry the most triangles in their near LOD
      const R1 = def.near * (quality === 'low' ? 0.42 : quality === 'medium' ? 0.58 : 1) * (quality === 'high' ? 1 : heavy), R2 = def.mid * rs;   // fewer full-detail trees near the camera on phones
      g = groups[sp] = { sp, def, nvE: variantsFor(def, quality), res, R1, R2, s: [], m: [], c: [], yaw: [], v: [], n: 0, near: [], mid: [], imp: null, built: false };
    }
    return g;
  }
  /** Registers an instance (position, yaw, uniform scale, tint). Variant is picked from a hash. */
  function add(sp, s, x, y, z, yaw, scale, tint, tr = 1, tg = 1, tb = 1) {
    const g = spec(sp);
    g.s.push(s);
    const c = Math.cos(yaw), si = Math.sin(yaw);
    g.m.push(c * scale, 0, -si * scale, 0, 0, scale, 0, 0, si * scale, 0, c * scale, 0, x, y, z, 1);
    g.c.push(tint * tr, tint * tg, tint * tb);
    g.yaw.push(yaw);
    g.v.push(Math.floor(((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1 * g.nvE) % g.nvE);
    g.n++;
  }

  function buildGroup(g) {
    // sort by s
    const n = g.n, order = Array.from({ length: n }, (_, i) => i).sort((a, b) => g.s[a] - g.s[b]);
    g.S = new Float32Array(n); g.M = new Float32Array(n * 16); g.C = new Float32Array(n * 3); g.Y = new Float32Array(n); g.V = new Uint8Array(n);
    order.forEach((o, k) => {
      g.S[k] = g.s[o]; g.Y[k] = g.yaw[o]; g.V[k] = g.v[o];
      for (let i = 0; i < 16; i++) g.M[k * 16 + i] = g.m[o * 16 + i];
      for (let i = 0; i < 3; i++) g.C[k * 3 + i] = g.c[o * 3 + i];
    });
    g.s = g.m = g.c = g.yaw = g.v = null;
    g.cnt = new Array(g.nvE).fill(0);
    for (let i = 0; i < n; i++) g.cnt[g.V[i]]++;
    g.built = true;
    attach(g);
  }

  function mkInst(geo, mat, cap, shadow, imp) {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1)); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0; m.visible = false; m.castShadow = !!shadow;
    if (imp) { m.geometry.setAttribute('aYaw', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap)), 1).setUsage(THREE.DynamicDrawUsage)); }
    group.add(m);
    return m;
  }

  /** Builds the per-LOD instanced meshes once geometry + metadata are available. */
  function attach(g) {
    if (!g.built || !g.res.ready || !alive || g.attached) return;
    const res = g.res, def = g.def;
    if (def.imp && !res.meta) return;
    g.attached = true;
    const sway = def.sway;
    const nearFade = [-2, -1, g.R1 - 6, g.R1 + 6], midFade = [g.R1 - 6, g.R1 + 6, g.R2 - 8, g.R2 + 8];
    const matN = treeMaterial(res, 'near', def.mid ? nearFade : [-2, -1, g.R1 - 8, g.R1 + 8], sway, lowQ);
    const matM = def.mid ? treeMaterial(res, 'mid', midFade, sway, lowQ) : null;
    g.mats = [matN, matM];
    for (let v = 0; v < g.nvE; v++) {
      const cap = Math.min(g.cnt[v], 700);
      const gn = res.geos[`v${v}_near`], gm = res.geos[`v${v}_mid`];
      g.near.push(gn ? mkInst(gn, matN, cap, shadowOn, false) : null);
      g.mid.push(def.mid && gm ? mkInst(gm, matM, cap, false, false) : null);
    }
    if (def.imp && res.meta) {
      const m = res.meta, pg = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
      g.impMat = impMaterial(res, [g.R2 - 8, g.R2 + 8]);
      g.impMat.uniforms.uSize.value.set(2 * m.R, m.y1 - m.y0, m.y0);
      g.imp = mkInst(pg, g.impMat, Math.min(g.n, 1500), false, true);
    }
    last = -1e9;
  }
  const readyHook = (g) => () => { attach(g); };

  /** Sorts instances and creates meshes (call once after all add()). */
  function finish() {
    for (const k in groups) {
      const g = groups[k]; buildGroup(g);
      const h = readyHook(g);
      if (!g.res.ready || (g.def.imp && !g.res.meta)) g.res.listeners.push(h);
    }
  }

  function fill(mesh, g, i, k, imp) {
    const ma = mesh.instanceMatrix.array, ca = mesh.instanceColor.array;
    const o = i * 16, p = k * 16;
    for (let q = 0; q < 16; q++) ma[p + q] = g.M[o + q];
    ca[k * 3] = g.C[i * 3]; ca[k * 3 + 1] = g.C[i * 3 + 1]; ca[k * 3 + 2] = g.C[i * 3 + 2];
    if (imp) mesh.geometry.attributes.aYaw.array[k] = g.Y[i];
  }
  function flush(mesh, n, imp) {
    mesh.count = n; mesh.visible = n > 0;
    mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceColor.clearUpdateRanges();
    if (n > 0) { mesh.instanceMatrix.addUpdateRange(0, n * 16); mesh.instanceColor.addUpdateRange(0, n * 3); }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    if (imp) { const a = mesh.geometry.attributes.aYaw; a.clearUpdateRanges(); if (n > 0) a.addUpdateRange(0, n); a.needsUpdate = true; }
  }

  let span = 700, back = 90;
  /** Re-classifies the window around the camera (every ~6 m of travel, or when assets finish loading). */
  function update(camS, cx, cz, force) {
    if (!force && Math.abs(camS - last) < 6 && Math.abs(cx - lastX) + Math.abs(cz - lastZ) < 6) return;
    last = camS; lastX = cx; lastZ = cz;
    for (const k in groups) {
      const g = groups[k];
      if (!g.attached) continue;
      const lo = lowerBound(g.S, g.n, camS - back), hi = lowerBound(g.S, g.n, camS - back + span);
      const nn = g.near.map(() => 0), nm = g.mid.map(() => 0); let ni = 0;
      const hasMid = !!g.def.mid, R1 = g.R1, R2 = g.R2;
      for (let i = lo; i < hi; i++) {
        const dx = g.M[i * 16 + 12] - cx, dz = g.M[i * 16 + 14] - cz, d = Math.sqrt(dx * dx + dz * dz);
        const v = g.V[i];
        if (d < R1 + 10) { const m = g.near[v]; if (m && nn[v] < m.instanceMatrix.count) { fill(m, g, i, nn[v], false); nn[v]++; } }
        if (!hasMid) continue;
        if (d > R1 - 10 && d < R2 + 12) { const m = g.mid[v]; if (m && nm[v] < m.instanceMatrix.count) { fill(m, g, i, nm[v], false); nm[v]++; } }
        if (g.imp && d > R2 - 10 && ni < g.imp.instanceMatrix.count) { fill(g.imp, g, i, ni, true); ni++; }
      }
      for (let v = 0; v < g.near.length; v++) { if (g.near[v]) flush(g.near[v], nn[v], false); if (g.mid[v]) flush(g.mid[v], nm[v], false); }
      if (g.imp) flush(g.imp, ni, true);
    }
  }
  function setWindow(sp, bk) { span = sp; back = bk; last = -1e9; }
  function dispose() {
    alive = false;
    for (const k in groups) {
      const g = groups[k];
      for (const arr of [g.near, g.mid]) for (const m of arr) if (m) m.dispose();
      if (g.imp) { g.imp.geometry.dispose(); g.imp.dispose(); }
      if (g.mats) for (const m of g.mats) if (m) m.dispose();
      if (g.impMat) g.impMat.dispose();
    }
  }
  const counts = () => Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.built ? g.S.length : g.n]));
  /** Triangles drawn by the nature layers last update (for stats). */
  return { group, add, finish, update, setWindow, dispose, counts, groups, getSpecies };
}
