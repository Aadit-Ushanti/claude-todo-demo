// Bikes and riders: three textured, rigged bike models with a rider each (assets/bikes/*.glb, built in Python/Blender).
//
// PUBLIC API
//   LIVERIES                      15 liveries [paint, suit, helmet] (hex); LIVERY_EXTRA[i] = { paint2, suit2, plate } hex colours.
//   bikeTypeOf(state, info)       'sport' | 'street' | 'chopper' from info.bikeType, else state.spec.id / spec.name, else 'street'.
//   createRiders(scene, shadow)   the per-slot rider system used by Renderer.updateRider(slot, bikeState, info).
//                                 info: { kind, attacking, side, weapon: 'punch'|'baton'|'chain', bikeType, number }
//   bikeMenuPreview(el, type, livery, opts)   rotating bike + rider for a bike-select screen (see below).
//   preloadBikes(types?, quality?)            Promise: models + textures (all three types by default).
//   bikeTextures(types)                       the THREE.Textures of the loaded types (for renderer.initTexture).
//
// bikeMenuPreview(canvasOrContainer, bikeType, liveryIndex, opts?) -> controller
//   Pass a <canvas> (rendered into directly) or any container element (a canvas is appended and sized to it).
//   Renders on its own WebGL context, so it can be used on a menu screen while the game is idle. The bike turns slowly
//   (opts.auto = false to stop; opts.speed rad/s), wheels roll, the rider idles. opts: { auto, speed, quality: 'high'|'medium'|'low',
//   background: css colour or null for transparent, yaw, pitch, dist }.
//   controller.set({ type, livery, yaw, pitch, dist, steer, weapon, swing, quality }) changes anything (all optional);
//   controller.render() draws one frame now; controller.resize(); controller.dispose() stops the loop and frees GPU memory.
//   Until the model has loaded the controller draws nothing (menus should show their own placeholder); `controller.ready` resolves.
//
// MODEL CONTRACT (see assets/bikes/README.md): each <type>.glb has lod0 (player), lod1 (rival, <= 60 m), lod2 (far) node trees with
// body > steer > forklow > wheel_f, body > wheel_r, body > torso > head / uarm_*,farm_*,hand_* nodes. At load every LOD is merged into
// ONE skinned mesh (lod0, lod1) or one static mesh (lod2) bound to those nodes as bones, so a rider is exactly one draw call.
// Textures: <type>_albedo / _orm (R emissive code, G roughness, B metal) / _mask (R paint, G paint2, B plate or helmet) / _nrm (high only),
// 2048 (high) / 1024 (medium) / 512 (low) versions plus a 128 placeholder. The mask recolours paint at runtime: no per-livery texture copies.
import * as THREE from '../../public/vendor/three.module.min.js';
import { GLTFLoader } from '../../public/vendor/GLTFLoader.js';
import { mergeGeometries } from '../../public/vendor/BufferGeometryUtils.js';
import { fogPatch } from './Look.js';
import { LIVERIES, createProcRiders } from './BikesProc.js';
import { clamp, ss, MODEL_SCALE } from './util.js';

export { LIVERIES };
const TYPES = ['sport', 'street', 'chopper'];
const SPLIT_V = 752 / 1024;
const PLATE = [424 / 1024, 440 / 1024, 128 / 1024, 64 / 1024];
const SWING_T = 0.3;
const URL_OF = (f) => new URL(`../../assets/bikes/${f}`, import.meta.url).href;

const lum = (c) => { const r = (c >> 16 & 255) / 255, g = (c >> 8 & 255) / 255, b = (c & 255) / 255; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** Secondary colours per livery: stripes contrast with the paint, suit trim picks up the helmet or the bike colour. */
export const LIVERY_EXTRA = LIVERIES.map(([paint, suit, helm], i) => {
  const dark = 0x15161a, light = 0xf1f1ee;
  const paint2 = Math.abs(lum(paint) - lum(suit)) > 0.28 ? suit : lum(paint) > 0.5 ? dark : light;
  const suit2 = Math.abs(lum(suit) - lum(helm)) > 0.28 ? helm : (lum(suit) > 0.5 ? dark : paint);
  return { paint2, suit2, plate: i % 3 === 1 ? 0xf2c21c : 0xf2f2ee };
});

LIVERY_EXTRA[0] = { paint2: 0x15161a, suit2: 0x15161a, plate: 0xf2f2ee };   // default livery: red with black stripes / black suit panels

/** Bike type of a rider: info.bikeType, else bikeState.spec (id or display name), else 'street'. */
export function bikeTypeOf(state, info) {
  let t = info && info.bikeType;
  if (!t && state && state.spec) t = state.spec.id || state.spec.name;
  t = String(t || 'street').toLowerCase();
  if (TYPES.includes(t)) return t;
  if (t.includes('cruis') || t.includes('chop')) return 'chopper';
  if (t.includes('sport') || t.includes('super')) return 'sport';
  return 'street';
}

// ---------------------------------------------------------------- shared uniforms and the plate-number atlas
const U_HEAD = { value: 0 };           // head lamps (dawn / sunset tracks)
let numTex = null;
function numberTexture() {
  if (numTex) return numTex;
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 54px "Arial Black", Impact, Arial, sans-serif';
  for (let n = 0; n < 16; n++) g.fillText(String(n), (n % 4) * 128 + 64, Math.floor(n / 4) * 64 + 34);
  numTex = new THREE.CanvasTexture(c); numTex.colorSpace = THREE.NoColorSpace; numTex.wrapS = numTex.wrapT = THREE.ClampToEdgeWrapping; numTex.anisotropy = 4;
  return numTex;
}

// ---------------------------------------------------------------- assets (per bike type, cached)
const ASSETS = new Map();
let texQuality = 'high';   // textures: high 2048 | medium 1024 | low 512 (128 placeholder first)
function mkTex(srgb) {
  const t = new THREE.Texture(); t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; return t;
}
function loadImage(url) {
  return new Promise((res) => { const i = new Image(); i.onload = () => { (i.decode ? i.decode().catch(() => {}) : Promise.resolve()).then(() => res(i)); }; i.onerror = () => res(null); i.src = url; });
}
function setImg(t, img) { if (!img) return; if (t.image) t.dispose(); t.image = img; t.needsUpdate = true; }

function getAsset(type) {
  let a = ASSETS.get(type);
  if (a) return a;
  a = { type, ready: false, geos: null, names: [], parentOf: {}, pivot: {}, tex: { albedo: mkTex(true), orm: mkTex(false), mask: mkTex(false), nrm: mkTex(false) }, size: 0, hasNrm: false, listeners: [], whenReady: null, whenFull: null };
  ASSETS.set(type, a);
  for (const k of ['albedo', 'orm', 'mask']) loadImage(URL_OF(`${type}_${k}_lo.webp`)).then((img) => { if (!a.size) setImg(a.tex[k], img); });
  a.whenReady = new Promise((res) => new GLTFLoader().load(URL_OF(`${type}.glb`), (gltf) => { try { buildAsset(a, gltf); } catch (e) { console.warn('bike glb failed', type, e); } res(); }, undefined, (e) => { console.warn('bike glb load failed', type, e && e.message); res(); }))
    .then(() => (a.geos ? loadCustom(a) : null))
    .then(() => { if (a.geos) { a.ready = true; for (const f of a.listeners) f(); } });
  a.whenFull = Promise.all([a.whenReady, loadTextures(a)]);
  return a;
}
function loadTextures(a) {
  const want = texQuality === 'high' ? 2048 : texQuality === 'medium' ? 1024 : 512;
  if (a.size === want || a.loading === want) return a.loadingP || Promise.resolve();
  a.loading = want;
  const suf = want === 2048 ? '' : want === 1024 ? '_1024' : '_512';
  const ps = ['albedo', 'orm', 'mask'].map((k) => loadImage(URL_OF(`${a.type}_${k}${suf}.webp`)).then((img) => { if (img) setImg(a.tex[k], img); return !!img; }));
  if (texQuality === 'high' && !a.hasNrm) ps.push(loadImage(URL_OF(`${a.type}_nrm.webp`)).then((img) => { if (img) { setImg(a.tex.nrm, img); a.hasNrm = true; for (const f of a.listeners) f(); } return !!img; }));
  a.loadingP = Promise.all(ps).then((ok) => { if (ok.slice(0, 3).every(Boolean)) a.size = want; a.loading = 0; });
  return a.loadingP;
}
function buildAsset(a, gltf) {
  gltf.scene.updateMatrixWorld(true);
  const roots = [0, 1, 2].map((k) => gltf.scene.getObjectByName('lod' + k));
  roots[0].traverse((o) => {
    if (o === roots[0]) return;
    a.names.push(o.name); a.parentOf[o.name] = o.parent === roots[0] ? null : o.parent.name;
    a.pivot[o.name] = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  });
  const riderNode = (n) => { for (let p = n; p; p = a.parentOf[p]) if (p === 'torso') return true; return false; };
  a.riderGeos = [];
  a.geos = roots.map((root, k) => {
    const parts = [], rparts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
      const nm = o.name.replace(/_\d+$/, '');   // GLTFLoader suffixes repeated node names (body_1)
      const n = g.attributes.position.count, bi = a.names.indexOf(nm), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      if (riderNode(nm)) rparts.push(g);
      if (k === 2) { g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight'); }
      parts.push(g);
    });
    a.riderGeos[k] = rparts.length ? mergeGeometries(rparts.map((g) => floatGeo(g)), false) : null;   // kept for custom (downloaded) bikes
    const geo = mergeGeometries(parts, false);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.75, 0), 1.7);
    return geo;
  });
  deriveRig(a);
}
/** Joint data used by the animation, from the bone pivots. */
function deriveRig(a) {
  const P = a.pivot;
  a.R = { wheelF: P.wheel_f.y, wheelR: P.wheel_r.y };
  a.head = P.steer.clone(); a.fa = P.wheel_f.clone();
  a.forkUp = a.head.clone().sub(a.fa).normalize();
  a.arm = {};
  for (const s of ['R', 'L']) {
    const S = P['uarm_' + s], E = P['farm_' + s], W = P['hand_' + s];
    a.arm[s] = { S, E, W, l1: S.distanceTo(E), l2: E.distanceTo(W), restU: E.clone().sub(S).normalize(), restF: W.clone().sub(E).normalize() };
  }
  a.leg = null;
  if (P.thigh_R) {
    a.leg = {};
    for (const s of ['R', 'L']) {
      const H = P['thigh_' + s], K = P['shin_' + s], Aa = P['foot_' + s];
      const line = Aa.clone().sub(H).normalize(), kd = K.clone().sub(H); const pole = kd.addScaledVector(line, -kd.dot(line)).normalize();
      a.leg[s] = { H, K, A: Aa, l1: H.distanceTo(K), l2: K.distanceTo(Aa), restT: K.clone().sub(H).normalize(), restS: Aa.clone().sub(K).normalize(), pole };
    }
  }
  a.torsoP = P.torso.clone();
}

// ---------------------------------------------------------------- custom (downloaded) bike models: assets/bikes/custom/README.md
// assets/bikes/custom/index.json maps a bike type to `true` (custom/<type>.glb with defaults), a config object, or a json file name.
// The custom model replaces the generated bike; the generated rider (and skeleton) is placed on it.
let customManifest = null;
/** Overrides assets/bikes/custom/index.json (dev harness / tests). Call before the first bike loads. */
export function setCustomBikeManifest(m) { customManifest = Promise.resolve(m || {}); }
function getManifest() {
  if (!customManifest) customManifest = fetch(URL_OF('custom/index.json')).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return customManifest;
}
const TYPE_LEN = { sport: 2.11, street: 2.11, chopper: 2.43 };
/** Float32, non-interleaved copy of a geometry with position/normal/uv/color(4)/skin attributes (so different sources merge). */
function floatGeo(g, keep = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight']) {
  const src = g.index ? g : g;
  const out = new THREE.BufferGeometry(), n = src.attributes.position.count;
  for (const k of keep) {
    const at = src.attributes[k], size = k === 'position' || k === 'normal' ? 3 : k === 'uv' ? 2 : 4;
    const arr = new Float32Array(n * size);
    if (at) for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) arr[i * size + c] = c < at.itemSize ? at.getComponent(i, c) : (k === 'color' ? 1 : 0);
    else if (k === 'color' || k === 'skinWeight') for (let i = 0; i < n; i++) { if (k === 'color') arr.fill(1, i * 4, i * 4 + 4); else arr[i * 4] = 1; }
    out.setAttribute(k, k === 'skinIndex' ? new THREE.Uint16BufferAttribute(Uint16Array.from(arr), 4) : new THREE.Float32BufferAttribute(arr, size));
  }
  if (!src.attributes.normal && keep.includes('normal')) { out.deleteAttribute('normal'); if (src.index) out.setIndex(src.index.clone()); out.computeVertexNormals(); return out; }
  out.setIndex(src.index ? Array.from(src.index.array) : Array.from({ length: n }, (_, i) => i));
  return out;
}
function setBone(g, bi) {
  const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}
/** Vertex-clustering decimation (grid cell `cell` m): positions snap to the mean of their cell, degenerate/duplicate triangles go. */
function clusterGeo(g, cell) {
  const P = g.attributes.position, C = g.attributes.color, idx = g.index.array, map = new Map(), rep = new Int32Array(P.count);
  const acc = [];
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i), key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let r = map.get(key); if (r === undefined) { r = acc.length; map.set(key, r); acc.push([0, 0, 0, 0, 0, 0, 0, 0]); }
    const s = acc[r]; s[0] += x; s[1] += y; s[2] += z; s[3] += C.getX(i); s[4] += C.getY(i); s[5] += C.getZ(i); s[6] = C.getW(i); s[7]++; rep[i] = r;
  }
  const pos = new Float32Array(acc.length * 3), col = new Float32Array(acc.length * 4);
  acc.forEach((s, r) => { pos.set([s[0] / s[7], s[1] / s[7], s[2] / s[7]], r * 3); col.set([s[3] / s[7], s[4] / s[7], s[5] / s[7], s[6]], r * 4); });
  const tri = [], seen = new Set();
  for (let t = 0; t < idx.length; t += 3) {
    const a = rep[idx[t]], b = rep[idx[t + 1]], c = rep[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    const k = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(k)) continue; seen.add(k); tri.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); out.setIndex(tri);
  out.computeVertexNormals();
  return out;
}
function decimateTo(g, maxTris) {
  if (g.index.count / 3 <= maxTris) return clusterGeo(g, 0.002);
  let cell = 0.01, out = clusterGeo(g, cell);
  while (out.index.count / 3 > maxTris && cell < 0.4) { cell *= 1.35; out = clusterGeo(g, cell); }
  return out;
}
const WHITE_UV = [(4 * 64 + 32) / 1024, (560 + 2 * 64 + 32) / 1024];   // 'white' swatch: no paint mask, bike half of the atlas
function avgColor(mat) {
  const c = (mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1));
  const img = mat.map && mat.map.image;
  if (img && typeof document !== 'undefined') {
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 8; const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const t = new THREE.Color().setRGB(r / 64 / 255, gg / 64 / 255, b / 64 / 255, THREE.SRGBColorSpace); c.multiply(t);
    } catch (e) { /* tainted or not decodable: keep the factor colour */ }
  }
  if (mat.emissive && mat.emissive.getHex && mat.emissiveIntensity) c.add(mat.emissive.clone().multiplyScalar(0.3 * mat.emissiveIntensity));
  return c;
}
const V3 = (v, d) => (Array.isArray(v) && v.length === 3 ? new THREE.Vector3(v[0], v[1], v[2]) : d);
const nameIn = (o, list) => { if (!list || !list.length) return false; for (let p = o; p; p = p.parent) { const n = (p.name || '').toLowerCase(); if (list.some((s) => n === String(s).toLowerCase() || n.startsWith(String(s).toLowerCase()))) return true; } return false; };
const matIn = (m, list) => !!(list && m && list.some((s) => (m.name || '').toLowerCase() === String(s).toLowerCase()));

/** Loads assets/bikes/custom/<type>.glb when the manifest lists the type and rebuilds the asset around it. Never throws. */
async function loadCustom(a) {
  let cfg;
  try {
    const man = await getManifest(); cfg = man && man[a.type];
    if (!cfg) return;
    if (typeof cfg === 'string') cfg = await fetch(URL_OF('custom/' + cfg)).then((r) => r.json());
    if (cfg === true) cfg = {};
    if (cfg.enabled === false) return;
    const url = URL_OF('custom/' + (cfg.glb || `${a.type}.glb`));
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
    buildCustom(a, gltf, cfg);
  } catch (e) { console.warn('custom bike ignored', a.type, e && e.message ? e.message : e); a.custom = null; }
}

function buildCustom(a, gltf, cfg) {
  const scene = gltf.scene; scene.updateMatrixWorld(true);
  // 1. collect mesh parts in model space (multi-material meshes split by group)
  const parts = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || o.visible === false) return;
    if (nameIn(o, cfg.hide)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = Array.isArray(o.material) && o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count, materialIndex: 0 }];
    for (const gr of groups) {
      const g = floatGeo(o.geometry, ['position', 'normal', 'uv']);
      const ix = g.index.array.slice(gr.start, gr.start + gr.count); g.setIndex(Array.from(ix));
      g.applyMatrix4(o.matrixWorld);
      parts.push({ o, g, mat: mats[gr.materialIndex] || mats[0], box: null });
    }
  });
  if (!parts.length) throw new Error('no meshes');
  // 2. orientation and scale: long axis -> z, front (narrower tyre) -> -z, ground at y = 0, length from cfg or the type
  const xf = new THREE.Matrix4();
  if (cfg.yaw !== undefined) xf.makeRotationY(cfg.yaw * Math.PI / 180);
  else { const b = new THREE.Box3(); for (const p of parts) { p.g.computeBoundingBox(); b.union(p.g.boundingBox); } const s = b.getSize(new THREE.Vector3()); if (s.x > s.z) xf.makeRotationY(Math.PI / 2); }
  for (const p of parts) p.g.applyMatrix4(xf);
  const box = new THREE.Box3(); for (const p of parts) { p.g.computeBoundingBox(); box.union(p.g.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const scale = cfg.scale || (cfg.length || TYPE_LEN[a.type] || 2.1) / Math.max(size.z, 1e-6);
  const ctr = box.getCenter(new THREE.Vector3());
  const m2 = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -box.min.y, -ctr.z));
  for (const p of parts) { p.g.applyMatrix4(m2); p.g.computeBoundingBox(); p.box = p.g.boundingBox.clone(); }
  // 3. wheels: by name (cfg.wheelFront / wheelRear) or the two largest round, thin, ground-touching parts at either end
  const isWheelish = (b) => { const s = b.getSize(new THREE.Vector3()); return s.y > 0.35 && s.y < 1.0 && Math.abs(s.y - s.z) < 0.25 * s.y && s.x < 0.7 * s.y && b.min.y < 0.08; };
  let wf = parts.filter((p) => nameIn(p.o, cfg.wheelFront)), wr = parts.filter((p) => nameIn(p.o, cfg.wheelRear));
  const axle = (list) => { if (!list.length) return null; const b = new THREE.Box3(); for (const p of list) b.union(p.box); return { c: b.getCenter(new THREE.Vector3()), r: b.getSize(new THREE.Vector3()).y / 2, w: b.getSize(new THREE.Vector3()).x }; };
  let flip = false;
  if (!wf.length || !wr.length) {
    const cand = parts.filter((p) => isWheelish(p.box)).sort((p, q) => q.box.getSize(new THREE.Vector3()).y - p.box.getSize(new THREE.Vector3()).y);
    const A = cand[0], B = cand.find((p) => A && Math.abs(p.box.getCenter(new THREE.Vector3()).z - A.box.getCenter(new THREE.Vector3()).z) > 0.6);
    if (A && B) {
      const ca = A.box.getCenter(new THREE.Vector3()), cb = B.box.getCenter(new THREE.Vector3()), wa = A.box.getSize(new THREE.Vector3()).x, wb = B.box.getSize(new THREE.Vector3()).x;
      let front = ca.z < cb.z ? A : B, rear = front === A ? B : A;
      if (cfg.yaw === undefined && Math.abs(wa - wb) > 0.01) { const narrow = wa < wb ? A : B; if (narrow !== front) { flip = true; front = narrow; rear = narrow === A ? B : A; } }
      wf = [front]; wr = [rear];
    }
  }
  const applyAll = (m) => { for (const p of parts) { p.g.applyMatrix4(m); p.g.computeBoundingBox(); p.box = p.g.boundingBox.clone(); } };
  if (flip) applyAll(new THREE.Matrix4().makeRotationY(Math.PI));
  let F = axle(wf), R = axle(wr);
  // hubs, rims, discs: parts centred on an axle and no bigger than the wheel follow it
  const near = (p, W) => { if (!W) return false; const c = p.box.getCenter(new THREE.Vector3()), s = p.box.getSize(new THREE.Vector3()); return Math.hypot(c.y - W.c.y, c.z - W.c.z) < 0.15 * W.r && s.y <= 2.2 * W.r && s.z <= 2.2 * W.r && Math.abs(c.x - W.c.x) < 0.25; };
  if (F && R && !cfg.wheelFront) wf = parts.filter((p) => wf.includes(p) || (near(p, F) && !nameIn(p.o, cfg.body)));
  if (F && R && !cfg.wheelRear) wr = parts.filter((p) => wr.includes(p) || (near(p, R) && !nameIn(p.o, cfg.body)));
  F = axle(wf); R = axle(wr);
  // re-centre so the axles straddle z = 0 like the generated bikes
  if (F && R) { applyAll(new THREE.Matrix4().makeTranslation(-(F.c.x + R.c.x) / 2, 0, -(F.c.z + R.c.z) / 2)); F = axle(wf); R = axle(wr); F.c.x = R.c.x = 0; }
  const steerParts = parts.filter((p) => nameIn(p.o, cfg.steer));
  // 4. pivots: generated rider moved onto the custom bike (cfg.seat = hip, else scaled by wheelbase)
  const P0 = a.pivot, piv = {};
  for (const n of a.names) piv[n] = P0[n].clone();
  const wb0 = P0.wheel_f.distanceTo(P0.wheel_r), wb = F && R ? F.c.distanceTo(R.c) : wb0;
  const hip = V3(cfg.seat, new THREE.Vector3(0, P0.torso.y * (F ? (F.r + R.r) / (P0.wheel_f.y + P0.wheel_r.y) : 1) + (cfg.seatRaise || 0), P0.torso.z * wb / wb0));
  const shift = hip.clone().sub(P0.torso);
  const riderNames = a.names.filter((n) => { for (let p = n; p; p = a.parentOf[p]) if (p === 'torso') return true; return false; });
  for (const n of riderNames) piv[n].add(shift);
  if (F) { piv.wheel_f.copy(F.c); piv.forklow.copy(F.c); }
  if (R) piv.wheel_r.copy(R.c);
  const head = V3(cfg.head, F ? F.c.clone().add(new THREE.Vector3(0, F.r * 1.85, F.r * 0.75)) : P0.steer.clone());
  piv.steer.copy(head);
  const names = a.names, bi = (n) => names.indexOf(n);
  // 5. LOD 0: the model itself (its own materials) + the generated rider; LOD 1/2: one vertex-coloured decimated mesh in the bike material
  const boneOf = (p) => (wf.includes(p) ? 'wheel_f' : wr.includes(p) ? 'wheel_r' : steerParts.includes(p) ? 'steer' : 'body');
  const mats = [], buckets = [], paintMats = [];
  for (const p of parts) {
    let k = mats.indexOf(p.mat);
    if (k < 0) { k = mats.length; mats.push(p.mat); buckets.push([]); }
    const g = floatGeo(p.g); setBone(g, bi(boneOf(p))); buckets[k].push(g);
  }
  const usePaint = (m) => matIn(m, cfg.paint);
  const lod0Mats = mats.map((m) => {
    const c = m.clone(); c.vertexColors = false;
    c.onBeforeCompile = (sh) => fogPatch(sh); c.customProgramCacheKey = () => 'bikecustom' + (c.map ? 'm' : '');
    if (usePaint(m)) paintMats.push(c);
    return c;
  });
  const bucketGeos = buckets.map((b) => mergeGeometries(b, false));
  const riderAt = (k) => { const r = a.riderGeos[k] && cfg.rider !== false ? floatGeo(a.riderGeos[k]) : null; if (r) r.translate(shift.x, shift.y, shift.z); return r; };
  const rider0 = riderAt(0);
  const lod0 = mergeGeometries(rider0 ? [...bucketGeos, rider0] : bucketGeos, true);
  const low = (maxTris, k) => {
    const out = [];
    for (const bone of ['body', 'steer', 'wheel_f', 'wheel_r']) {
      const gs = [];
      parts.forEach((p) => {
        if (boneOf(p) !== bone) return;
        const g = floatGeo(p.g, ['position', 'normal', 'color']), c = avgColor(p.mat), paint = usePaint(p.mat);
        const col = g.attributes.color; for (let i = 0; i < col.count; i++) col.setXYZW(i, c.r, c.g, c.b, paint ? 0.25 : 0.5);
        g.deleteAttribute('normal'); gs.push(g);
      });
      if (!gs.length) continue;
      const share = bone === 'body' ? 0.55 : bone === 'steer' ? 0.1 : 0.17;
      const d = decimateTo(mergeGeometries(gs, false), Math.max(60, Math.round(maxTris * share)));
      const n = d.attributes.position.count, uv = new Float32Array(n * 2); for (let i = 0; i < n; i++) uv.set(WHITE_UV, i * 2);
      d.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); setBone(d, bi(bone));
      out.push(floatGeo(d));
    }
    const r = riderAt(k); if (r) out.push(r);
    const g = mergeGeometries(out, false);
    if (k === 2) { g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight'); }
    return g;
  };
  const lod1 = low(cfg.rivalTris || 6000, 1), lod2 = low(cfg.farTris || 900, 2);
  const bound = new THREE.Sphere(new THREE.Vector3(0, 0.75, 0), Math.max(1.7, wb * 0.75 + 0.6));
  for (const g of [lod0, lod1, lod2]) g.boundingSphere = bound;
  a.pivot = piv; a.geos = [lod0, lod1, lod2];
  a.custom = { mats: lod0Mats, paintMats, riderGroup: rider0 ? bucketGeos.length : -1, noSteer: !steerParts.length, wheels: !!(F && R), cfg };
  deriveRig(a);
  if (cfg.grip) { const g = V3(cfg.grip); a.arm.R.W = g.clone(); a.arm.L.W = new THREE.Vector3(-g.x, g.y, g.z); a.ikGrip = true; }
  if (cfg.peg && a.leg) { const g = V3(cfg.peg); a.leg.R.A = g.clone(); a.leg.L.A = new THREE.Vector3(-g.x, g.y, g.z); }
}
/** Starts loading the models and textures of these types (default all); resolves when everything is decoded. */
export function preloadBikes(types = TYPES, quality) {
  if (quality) setBikeTextureQuality(quality);
  return Promise.all(types.map((t) => getAsset(t).whenFull)).then(() => {});
}
/** All textures of these types (for renderer.initTexture). */
export function bikeTextures(types = TYPES) { const o = [numberTexture()]; for (const t of types) { const a = getAsset(t); o.push(a.tex.albedo, a.tex.orm, a.tex.mask); if (a.hasNrm) o.push(a.tex.nrm); } return o; }
function setBikeTextureQuality(q) {
  const nq = q === 'high' ? 'high' : q === 'low' ? 'low' : 'medium';
  if (nq === texQuality) return;
  texQuality = nq;
  for (const a of ASSETS.values()) { const want = nq === 'high' ? 2048 : nq === 'medium' ? 1024 : 512; if (a.size !== want) loadTextures(a); }
}

// ---------------------------------------------------------------- material
function makeMaterial(a, withNormal) {
  const prm = { map: a.tex.albedo, roughnessMap: a.tex.orm, metalnessMap: a.tex.orm, roughness: 1, metalness: 1, vertexColors: true, envMapIntensity: 1.15 };
  // high quality: glossy clear-coat over the paint (masked to the paint panels in the shader), standard PBR otherwise
  const mat = withNormal ? new THREE.MeshPhysicalMaterial({ ...prm, clearcoat: 1, clearcoatRoughness: 0.07 }) : new THREE.MeshStandardMaterial(prm);
  if (withNormal && a.hasNrm) mat.normalMap = a.tex.nrm;
  const u = {
    uMask: { value: a.tex.mask }, uSplit: { value: SPLIT_V }, uPaint: { value: new THREE.Color() }, uPaint2: { value: new THREE.Color() },
    uSuit: { value: new THREE.Color() }, uSuit2: { value: new THREE.Color() }, uHelm: { value: new THREE.Color() }, uPlateBg: { value: new THREE.Color() },
    uPlate: { value: new THREE.Vector4(...PLATE) }, uNum: { value: numberTexture() }, uNumCell: { value: new THREE.Vector2() }, uHead: U_HEAD, uTail: { value: 0.3 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    fogPatch(sh);
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMask; uniform sampler2D uNum; uniform float uSplit; uniform vec3 uPaint; uniform vec3 uPaint2; uniform vec3 uSuit; uniform vec3 uSuit2;
        uniform vec3 uHelm; uniform vec3 uPlateBg; uniform vec4 uPlate; uniform vec2 uNumCell; uniform float uHead; uniform float uTail;
        float gPaint = 0.0;`)
      .replace('#include <color_fragment>', `
        {
          vec4 mk = texture2D(uMask, vMapUv);
          bool rid = vMapUv.y > uSplit;
          vec3 base = diffuseColor.rgb, col = base;
#ifdef USE_COLOR_ALPHA
          if (vColor.a < 0.75) { base = vColor.rgb; col = vColor.a < 0.375 ? uPaint * (0.55 + 0.45 * smoothstep(0.0, 0.5, dot(vColor.rgb, vec3(0.3, 0.6, 0.1)))) : base; mk = vec4(0.0); }
#endif
          col = mix(col, base * (rid ? uSuit : uPaint), mk.r);
          col = mix(col, base * (rid ? uSuit2 : uPaint2), mk.g);
          if (rid) col = mix(col, base * uHelm, mk.b);
          else if (mk.b > 0.5) {
            vec2 l = clamp((vMapUv - uPlate.xy) / uPlate.zw, 0.0, 1.0);
            float ink = texture2D(uNum, (l + uNumCell) * 0.25).r;
            col = mix(uPlateBg, vec3(0.03), ink);
          }
          gPaint = clamp(mk.r + mk.g, 0.0, 1.0) * (rid ? 0.4 : 1.0);
          diffuseColor.rgb = col;
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
        material.clearcoat *= gPaint;
#endif`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        { float bao = vColor.r;
#ifdef USE_COLOR_ALPHA
          if (vColor.a < 0.75) bao = 1.0;
#endif
          reflectedLight.indirectDiffuse *= bao; reflectedLight.indirectSpecular *= bao; reflectedLight.directDiffuse *= mix(1.0, bao, 0.55); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float em = texture2D(roughnessMap, vRoughnessMapUv).r;
          float hl = smoothstep(0.75, 0.9, em), tl = smoothstep(0.3, 0.42, em) * (1.0 - hl);
          totalEmissiveRadiance += diffuseColor.rgb * (hl * uHead * 2.4 + tl * uTail * 3.2); }`);
  };
  mat.customProgramCacheKey = () => 'bike5' + (withNormal ? 'c' : '') + (mat.normalMap ? 'n' : '');
  return mat;
}
function applyLivery(mat, idx, number) {
  const u = mat.userData.u, i = ((idx % LIVERIES.length) + LIVERIES.length) % LIVERIES.length, l = LIVERIES[i], x = LIVERY_EXTRA[i];
  u.uPaint.value.set(l[0]); u.uSuit.value.set(l[1]); u.uHelm.value.set(l[2]);
  u.uPaint2.value.set(x.paint2); u.uSuit2.value.set(x.suit2); u.uPlateBg.value.set(x.plate);
  const n = ((number | 0) % 16 + 16) % 16; u.uNumCell.value.set(n % 4, Math.floor(n / 4));
  for (const m of mat.userData.customPaint || []) m.color.set(l[0]);   // custom model: tint its paint materials
}

// ---------------------------------------------------------------- rig: one skinned mesh per LOD sharing a skeleton
function makeRig(a, withNormal, scene) {
  const root = new THREE.Group(); root.rotation.order = 'YXZ';
  // the bones live in an identity-world holder (so bone matrices are expressed in the bike's own space) and the meshes use the detached bind mode: skinned = bone * vertex, then the root's world transform
  const holder = new THREE.Group(); scene.add(holder);
  const bones = a.names.map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
  const byName = {};
  a.names.forEach((n, i) => {
    byName[n] = bones[i]; const p = a.parentOf[n];
    if (p) { byName[p].add(bones[i]); bones[i].position.copy(a.pivot[n]).sub(a.pivot[p]); } else { holder.add(bones[i]); bones[i].position.copy(a.pivot[n]); }
  });
  const inv = a.names.map((n) => new THREE.Matrix4().makeTranslation(-a.pivot[n].x, -a.pivot[n].y, -a.pivot[n].z));
  const skeleton = new THREE.Skeleton(bones, inv);
  const mat = makeMaterial(a, withNormal);
  const cust = a.custom, mats0 = cust ? cust.mats.map((m) => { const c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; return c; }).concat([mat]) : null;
  const mesh0 = new THREE.SkinnedMesh(a.geos[0], mats0 || mat), mesh1 = new THREE.SkinnedMesh(a.geos[1], mat), mesh2 = new THREE.Mesh(a.geos[2], mat);
  for (const m of [mesh0, mesh1]) { m.bindMode = THREE.DetachedBindMode; m.bind(skeleton, new THREE.Matrix4()); m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.75, 0), 1.7); }
  for (const m of [mesh0, mesh1, mesh2]) { root.add(m); m.visible = false; m.frustumCulled = true; }
  if (cust) mat.userData.customPaint = cust.paintMats.map((m) => mats0[cust.mats.indexOf(m)]);
  const rig = { a, root, holder, bones, byName, skeleton, mat, meshes: [mesh0, mesh1, mesh2], lod: -1, spin: 0, dSpeed: 0, dLean: 0, dSteer: 0, dInit: false, swingT: 99, swingSide: 1, wasAtt: false, tOn: false, tShift: new THREE.Vector3(), tInv: new THREE.Quaternion(), weapons: {}, weapon: null, weaponHand: null, tail: 0.3, cast: false, withNormal };
  return rig;
}
function disposeRig(rig) { rig.root.parent && rig.root.parent.remove(rig.root); rig.holder.parent && rig.holder.parent.remove(rig.holder); rig.skeleton.dispose(); rig.mat.dispose(); if (Array.isArray(rig.meshes[0].material)) for (const m of rig.meshes[0].material) m.dispose(); }
function setLod(rig, lod) {
  if (rig.lod === lod) return;
  rig.lod = lod; for (let i = 0; i < 3; i++) rig.meshes[i].visible = i === lod;
}

// ---------------------------------------------------------------- weapons (assets/bikes/weapons.glb: baton, chain, fist; atlas swatch uvs, drawn with the rider's material)
let weaponGeos = null, weaponProm = null;
function loadWeapons() {
  if (weaponProm) return weaponProm;
  weaponProm = new Promise((res) => new GLTFLoader().load(URL_OF('weapons.glb'), (gltf) => {
    weaponGeos = {}; gltf.scene.traverse((o) => { if (o.isMesh) weaponGeos[o.name.replace(/^w_/, '').replace(/_\d+$/, '')] = o.geometry; }); res();
  }, undefined, () => res()));
  return weaponProm;
}

// ---------------------------------------------------------------- animation
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _e = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(), _pole = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const _eu = new THREE.Euler(), _tt = new THREE.Vector3(), _tq = new THREE.Quaternion();
const NEG_Z = new THREE.Vector3(0, 0, -1), _one = new THREE.Vector3(1, 1, 1), _m4 = new THREE.Matrix4();

/** Two-bone IK for one arm: puts the wrist at `target` (body space). */
function solveArm(rig, side, target, outward) {
  const a = rig.a, A = a.arm[side], up = rig.byName['uarm_' + side], fa = rig.byName['farm_' + side];
  if (rig.tOn) { _tt.copy(target).sub(a.torsoP).sub(rig.tShift).applyQuaternion(rig.tInv).add(a.torsoP); target = _tt; }
  _d.copy(target).sub(A.S);
  let dist = _d.length();
  const maxR = (A.l1 + A.l2) * 0.985, minR = Math.abs(A.l1 - A.l2) + 0.03;
  dist = clamp(dist, minR, maxR);
  _d.normalize();
  const x = (A.l1 * A.l1 - A.l2 * A.l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(A.l1 * A.l1 - x * x, 0));
  _pole.set(outward, -1, 0.25); _pole.addScaledVector(_d, -_pole.dot(_d)).normalize();
  _e.copy(A.S).addScaledVector(_d, x).addScaledVector(_pole, h);          // elbow
  _t.copy(A.S).addScaledVector(_d, dist);                                 // wrist (clamped)
  _v.copy(_e).sub(A.S).normalize();
  _q.setFromUnitVectors(A.restU, _v);
  up.quaternion.copy(_q);
  _v.copy(_t).sub(_e).normalize();
  _q2.setFromUnitVectors(A.restF, _v);   // forearm world rotation
  fa.quaternion.copy(_q).invert().multiply(_q2);
}
/** Two-bone IK for one leg (thigh/shin bones): puts the ankle at `target` (body space); the knee swings out by `out` (m of pole x). */
function solveLeg(rig, side, target, out) {
  const a = rig.a, Lg = a.leg[side], th = rig.byName['thigh_' + side], sn = rig.byName['shin_' + side];
  _d.copy(target); if (rig.tOn) _d.sub(a.torsoP).sub(rig.tShift).applyQuaternion(rig.tInv).add(a.torsoP);
  _d.sub(Lg.H);
  let dist = _d.length();
  dist = clamp(dist, Math.abs(Lg.l1 - Lg.l2) + 0.03, (Lg.l1 + Lg.l2) * 0.985);
  _d.normalize();
  const x = (Lg.l1 * Lg.l1 - Lg.l2 * Lg.l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(Lg.l1 * Lg.l1 - x * x, 0));
  _pole.copy(Lg.pole); _pole.x += (side === 'R' ? 1 : -1) * out; _pole.addScaledVector(_d, -_pole.dot(_d)).normalize();
  _e.copy(Lg.H).addScaledVector(_d, x).addScaledVector(_pole, h);        // knee
  _t.copy(Lg.H).addScaledVector(_d, dist);                               // ankle (clamped)
  _v.copy(_e).sub(Lg.H).normalize(); _q.setFromUnitVectors(Lg.restT, _v); th.quaternion.copy(_q);
  _v.copy(_t).sub(_e).normalize(); _q2.setFromUnitVectors(Lg.restS, _v); sn.quaternion.copy(_q).invert().multiply(_q2);
}
function restArm(rig, side) { rig.byName['uarm_' + side].quaternion.identity(); rig.byName['farm_' + side].quaternion.identity(); }

/**
 * Poses one rig from a BikeState. `info`: attacking/side/weapon/number. Returns nothing; root transform is set by the caller.
 */
function poseRig(rig, b, info, dt, lodWant) {
  const a = rig.a, root = rig.root, by = rig.byName;
  if (!rig.dInit) { rig.dSpeed = b.speed; rig.dLean = b.lean || 0; rig.dSteer = b.steer || 0; rig.dInit = true; }
  rig.dSpeed += (b.speed - rig.dSpeed) * (1 - Math.exp(-dt / 0.12));
  rig.dLean += ((b.lean || 0) - rig.dLean) * (1 - Math.exp(-dt / 0.07));
  rig.dSteer += ((b.steer || 0) - rig.dSteer) * (1 - Math.exp(-dt / 0.05));
  root.rotation.set(b.pitch || 0, b.yaw, rig.dLean);
  if (lodWant === 2) return;
  let step = (rig.dSpeed / a.R.wheelR) * dt;
  if (step > 0.9) step = 0.9; else if (step < -0.9) step = -0.9;
  rig.spin -= step; if (rig.spin < -6283) rig.spin += 6283;
  by.wheel_r.rotation.x = rig.spin; by.wheel_f.rotation.x = rig.spin;
  // steering about the fork axis; fork compression along it
  const st = a.custom && a.custom.noSteer ? 0 : clamp(rig.dSteer, -1, 1) * 0.34;
  _qs.setFromAxisAngle(a.forkUp, st);
  by.steer.quaternion.copy(_qs);
  const comp = a.custom && a.custom.noSteer ? 0 : (b.suspF || 0) * 0.12;
  by.forklow.position.set(a.fa.x - a.head.x + a.forkUp.x * comp, a.fa.y - a.head.y + a.forkUp.y * comp, a.fa.z - a.head.z + a.forkUp.z * comp);
  // hang-off: hips slide to the inside of the turn, shoulders drop, inside knee opens, head stays level
  const hang = clamp(rig.dLean / 0.55, -1, 1);                      // + = bike leaned to -x (left)
  const tShiftX = -hang * 0.17, tRoll = hang * 0.20;
  const torso = by.torso;
  if (torso) {
    torso.position.set(a.torsoP.x + tShiftX, a.torsoP.y - Math.abs(hang) * 0.035, a.torsoP.z + Math.abs(hang) * 0.02);
    torso.rotation.set(0, 0, tRoll);
    rig.tShift.set(tShiftX, -Math.abs(hang) * 0.035, Math.abs(hang) * 0.02); rig.tInv.setFromEuler(_eu.set(0, 0, tRoll)).invert(); rig.tOn = true;
  }
  if (a.leg) for (const s of ['R', 'L']) {
    const inside = (s === 'L' ? 1 : -1) * hang;                        // > 0 for the inside leg
    _t.copy(a.leg[s].A);
    solveLeg(rig, s, _t, 0.35 * Math.max(inside, 0) + 0.1);
  }
  // attack
  const att = !!(info && info.attacking);
  if (att && (!rig.wasAtt || rig.swingT > SWING_T + 0.12)) { rig.swingT = 0; rig.swingSide = info.side < 0 ? -1 : 1; }
  rig.wasAtt = att;
  const wk = (info && info.weapon) || 'punch';
  const armSide = rig.swingSide > 0 ? 'L' : 'R';     // side +1 = left of the bike (-X)
  const swinging = rig.swingT < SWING_T;
  const kicking = swinging && wk === 'kick' && !!a.leg; // a kick swings the leg; both hands stay on the bars
  let peak = 0;
  if (swinging) rig.swingT += dt;
  const p = Math.min(rig.swingT / SWING_T, 1);
  for (const s of ['L', 'R']) {
    const A = a.arm[s];
    if (swinging && s === armSide && !kicking) {
      let ang;
      if (p < 0.25) ang = -0.35 * ss(p / 0.25); else if (p < 0.55) ang = -0.35 + 1.75 * ss((p - 0.25) / 0.3); else ang = 1.4 * (1 - ss((p - 0.55) / 0.45));
      peak = Math.sin(Math.PI * clamp((p - 0.15) / 0.7, 0, 1));
      const w = ss(p / 0.16) * (1 - ss((p - 0.82) / 0.18));
      _eu.set(-0.4 * peak - 0.1, rig.swingSide * ang, 0, 'YXZ');
      const reach = (A.l1 + A.l2) * (wk === 'punch' ? 0.98 : 0.9);
      _v.copy(NEG_Z).applyEuler(_eu).multiplyScalar(reach * 0.55 + reach * 0.45 * peak);
      _t.copy(A.S).add(_v);
      // blend from the grip to the strike target
      _v2.copy(A.W);
      _v2.sub(a.head).applyQuaternion(_qs).add(a.head);
      _t.lerp(_v2, 1 - w);
      solveArm(rig, s, _t, s === 'L' ? -0.7 : 0.7);
    } else if (a.ikGrip || Math.abs(st) > 0.012 || Math.abs(hang) > 0.02) {
      _v2.copy(A.W);
      _t.copy(_v2).sub(a.head).applyQuaternion(_qs).add(a.head);
      solveArm(rig, s, _t, s === 'L' ? -0.6 : 0.6);
    } else restArm(rig, s);
  }
  if (kicking) {
    // the leg on the attacking side leaves the peg and stamps out sideways (peak at the moment the kick lands), then returns
    peak = Math.sin(Math.PI * clamp((p - 0.15) / 0.7, 0, 1));
    const Lg = a.leg[armSide], out = armSide === 'L' ? -1 : 1, reach = (Lg.l1 + Lg.l2) * 0.97;
    _t.copy(Lg.A);
    _t.x += out * reach * 0.8 * peak; _t.y += 0.22 * peak; _t.z -= 0.1 * peak;
    solveLeg(rig, armSide, _t, 0.25 * peak + 0.1);
  }
  // head: looks into the corner, turns toward a strike
  by.head.rotation.set(0, clamp(rig.dLean * 0.45, -0.5, 0.5) * 0.8 + (swinging ? rig.swingSide * 0.55 * peak : 0), -(rig.dLean + tRoll) * 0.85);
  // weapon in the swinging hand
  if (swinging && !kicking) {
    const wg = weaponGeos && (weaponGeos[wk] || weaponGeos.fist);
    if (wg) {
      let w = rig.weapons[wk];
      if (!w) { w = rig.weapons[wk] = new THREE.Mesh(wg, rig.mat); w.frustumCulled = false; w.matrixAutoUpdate = true; }
      if (rig.weapon && rig.weapon !== w) rig.weapon.visible = false;
      const hand = by['hand_' + armSide];
      if (w.parent !== rig.root) { rig.root.add(w); w.matrixAutoUpdate = false; }
      const rf = a.arm[armSide].restF;
      _q3.setFromUnitVectors(NEG_Z, rf);
      if (wk === 'chain') { _eu.set(0, -rig.swingSide * 0.5 * (1 - p), 0); _q3.multiply(_q.setFromEuler(_eu)); }
      _v.copy(rf).multiplyScalar(0.09);
      hand.updateWorldMatrix(true, false);            // bones live in the holder (bike space); the weapon sits under the posed root
      _m4.compose(_v, _q3, _one); w.matrix.multiplyMatrices(hand.matrixWorld, _m4); w.matrixWorldNeedsUpdate = true;
      w.visible = true; rig.weapon = w;
    }
  } else if (rig.weapon) { rig.weapon.visible = false; }
}

// ---------------------------------------------------------------- rider system used by the game
/**
 * Creates the rider system. Calls scene.add for every object. Until a bike's models are loaded its riders use the legacy procedural
 * bike (BikesProc.js), so a slot is never empty.
 * @returns {{update:Function, get:Function, riders:Array, setQuality:Function, setLights:Function, preload:Function}}
 */
export function createRiders(scene, shadow) {
  const proc = createProcRiders(scene, shadow);
  const slots = [];
  let quality = 'high';
  const dist2 = (b, c) => { const dx = b.pos.x - c.x, dz = b.pos.z - c.z; return dx * dx + dz * dz; };
  let nearCount = 0, frameId = -1;

  function get(slot) {
    let s = slots[slot];
    if (!s) {
      const root = new THREE.Group(); root.visible = false; scene.add(root);
      s = slots[slot] = { slot, root, rig: null, type: '', livery: -1, number: -1, usingProc: true };
    }
    return s;
  }
  function ensureRig(s, type, b) {
    const a = getAsset(type);
    if (!a.ready) { if (!s.waiting) { s.waiting = true; } return null; }
    const wantNrm = quality === 'high';
    if (s.rig && (s.rig.a !== a || (wantNrm && !s.rig.withNormal && a.hasNrm))) { s.root.remove(s.rig.root); disposeRig(s.rig); s.rig = null; }
    if (!s.rig) {
      s.rig = makeRig(a, wantNrm, scene); s.root.add(s.rig.root); s.livery = -1; s.type = type;
      a.listeners.push(() => {});
    }
    return s.rig;
  }
  /** Updates one rider's meshes and shadow. */
  function update(slot, b, info, dt, camPos, camDir) {
    const s = get(slot);
    const type = bikeTypeOf(b, info);
    const a = getAsset(type);
    if (!weaponGeos) loadWeapons();
    const vis = !b.crashed;
    if (frameId !== slot && slot === 0) nearCount = 0;
    if (!a.ready) {      // legacy fallback until the models are in
      s.root.visible = vis; s.root.position.set(b.pos.x, b.pos.y, b.pos.z);
      proc.update(slot, b, info, dt, camPos);
      s.usingProc = true; return;
    }
    if (s.usingProc) { const pr = proc.get(slot); pr.root.visible = false; s.usingProc = false; }
    const rig = ensureRig(s, type, b);
    s.root.visible = vis;
    const px = b.pos.x, py = b.pos.y, pz = b.pos.z;
    shadow.set(slot, vis ? px : 0, py, pz, b.yaw, vis ? 1 : 0);
    if (!vis) return;
    s.root.position.set(px, py, pz);
    if (s.root.scale.x !== MODEL_SCALE) s.root.scale.setScalar(MODEL_SCALE);
    const dx = px - camPos.x, dz = pz - camPos.z, d2 = dx * dx + dz * dz;
    // behind the camera (and not the player): hidden, no animation work
    if (slot !== 0 && camDir && (dx * camDir.x + dz * camDir.z) < -2.5 && d2 > 36) { rig.root.visible = false; return; }
    rig.root.visible = true;
    // level of detail: player always full; the nearest rivals get the full model when close (quality-capped), the rest the rival mesh, far ones the 400-triangle mesh
    const cap = quality === 'high' ? 3 : quality === 'medium' ? 1 : 0, lodFar = quality === 'high' ? 58 : quality === 'medium' ? 42 : 30;
    let lod = slot === 0 ? 0 : (d2 < 11 * 11 && nearCount < cap && !a.custom) ? 0 : d2 < lodFar * lodFar ? 1 : 2;   // custom models: full mesh for the player only
    if (slot !== 0 && lod === 0) nearCount++;
    if (slot !== 0 && rig.swingT < SWING_T && lod === 2) lod = 1;
    setLod(rig, lod);
    if (rig.livery !== slot || (info && info.number !== undefined && info.number !== rig.number)) {
      const num = info && info.number !== undefined ? info.number : (slot === 0 ? 1 : 16 - slot);
      const liv = info && info.livery !== undefined ? info.livery : slot;
      applyLivery(rig.mat, liv, num); rig.livery = slot; rig.number = info && info.number;
    }
    // shadow map casters: the player and riders within a few metres (blob shadows cover the rest)
    if (quality === 'high') {
      const want = slot === 0 || (d2 < 12 * 12 && lod < 2);
      if (rig.cast !== want) { rig.cast = want; rig.meshes[0].castShadow = rig.meshes[1].castShadow = rig.meshes[2].castShadow = want; }
    }
    // brake light
    const tl = (b.brake || 0) > 0.25 ? 1.0 : 0.3;
    if (rig.tail !== tl) { rig.tail = tl; rig.mat.userData.u.uTail.value = tl; }
    poseRig(rig, b, info, dt, lod);
  }
  function setQuality(q) {
    quality = q;
    proc.setQuality && proc.setQuality(q);
    setBikeTextureQuality(q);
    for (const s of slots) if (s && s.rig) for (const m of s.rig.meshes) m.castShadow = q === 'high' && s.rig.cast;
  }
  return {
    update, get, riders: slots, setQuality,
    /** Head lamps on/off (dawn, sunset and night tracks). */
    setLights(on) { U_HEAD.value = on ? 1 : 0; },
    preload: preloadBikes,
    /** Triangles-per-LOD of a type once loaded (diagnostics). */
    lodTris(type) { const a = ASSETS.get(type); return a && a.ready ? a.geos.map((g) => (g.index ? g.index.count : g.attributes.position.count) / 3) : null; },
  };
}

// ---------------------------------------------------------------- menu preview
/**
 * Rotating preview of a bike with its rider on its own WebGL context. See the header for the options.
 * @param {HTMLCanvasElement|HTMLElement} el
 * @param {'sport'|'street'|'chopper'} bikeType
 * @param {number} liveryIndex 0..14
 * @param {object} [opts]
 */
export function bikeMenuPreview(el, bikeType = 'sport', liveryIndex = 0, opts = {}) {
  const own = el.tagName === 'CANVAS' ? null : document.createElement('canvas');
  const canvas = own || el;
  if (own) { own.style.cssText = 'width:100%;height:100%;display:block'; el.appendChild(own); }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: opts.background == null, preserveDrawingBuffer: !!opts.preserve });
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  if (opts.background) scene.background = new THREE.Color(opts.background); else renderer.setClearColor(0, 0);
  // gradient sky for reflections + a soft key light
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: {}, vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(vec3(0.30,0.28,0.26), vec3(0.62,0.72,0.88), smoothstep(-0.2, 0.7, h)); c += vec3(1.0,0.92,0.8) * smoothstep(0.75, 0.97, h) * 1.4; c += vec3(0.9,0.8,0.7) * pow(max(dot(normalize(vP), normalize(vec3(0.5,0.4,0.7))),0.0), 18.0) * 2.0; gl_FragColor = vec4(c, 1.0); }' })));
  const pmrem = new THREE.PMREMGenerator(renderer); const envRT = pmrem.fromScene(skyScene, 0.02); scene.environment = envRT.texture; pmrem.dispose();
  const key = new THREE.DirectionalLight(0xfff0dd, 2.2); key.position.set(3, 5, 4); scene.add(key);
  scene.add(new THREE.HemisphereLight(0xbcd0ee, 0x504a42, 0.6));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 }));
  scene.add(ground);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
  const st = { type: bikeType, livery: liveryIndex, yaw: opts.yaw !== undefined ? opts.yaw : -0.6, pitch: opts.pitch !== undefined ? opts.pitch : 0.12, dist: opts.dist || 5.4, steer: 0, weapon: 'punch', swing: false, quality: opts.quality || 'high', auto: opts.auto !== false, speed: opts.speed || 0.5 };
  let rig = null, rigType = '', raf = 0, alive = true, last = performance.now(), swingClock = 0;
  const bs = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, lean: 0, pitch: 0, speed: 0, steer: 0, suspF: 0.2, brake: 0, crashed: false };
  function ensure() {
    const a = getAsset(st.type);
    if (!a.ready) return false;
    if (!rig || rigType !== st.type || (st.quality === 'high' && !rig.withNormal && a.hasNrm)) {
      if (rig) disposeRig(rig);
      rig = makeRig(a, st.quality === 'high', scene); scene.add(rig.root); rigType = st.type; rig.root.visible = true; rig.livery = -1; setLod(rig, st.lod | 0);
    }
    setLod(rig, st.lod | 0);
    if (rig.livery !== st.livery) { applyLivery(rig.mat, st.livery, st.livery + 1); rig.livery = st.livery; }
    return true;
  }
  function resize() {
    const w = (own ? el.clientWidth : canvas.clientWidth) || canvas.width || 300, h = (own ? el.clientHeight : canvas.clientHeight) || canvas.height || 200;
    renderer.setSize(w, h, false); cam.aspect = w / h;
    // fit the bike: widen the field of view for narrow containers
    cam.fov = cam.aspect < 1 ? 46 : 32; cam.updateProjectionMatrix();
  }
  let infoSwing = { attacking: false, side: 1, weapon: 'punch' };
  function render(dt = 0.016) {
    if (!alive) return;
    if (!ensure()) return;
    if (st.auto) st.yaw += st.speed * dt;
    swingClock += dt;
    infoSwing.attacking = st.swing && (Math.floor(swingClock / 0.9) % 2 === 0) && (swingClock % 0.9) < 0.05; infoSwing.weapon = st.weapon;
    if (st.swingAt != null) { rig.swingT = st.swingAt - dt; rig.wasAtt = true; infoSwing.attacking = true; infoSwing.side = st.swingSide || 1; }
    bs.speed = 3.0; bs.steer = st.steer; bs.lean = st.lean !== undefined ? st.lean : st.steer * -0.12;
    rig.root.position.set(0, 0, 0);
    poseRig(rig, bs, infoSwing, dt, st.lod | 0);
    if (rig.byName.torso) rig.byName.torso.scale.setScalar(st.rider === false ? 1e-4 : 1);
    rig.root.rotation.set(0, st.yaw, st.rollOnly ? bs.lean : 0);
    // restore a neutral stance for the menu (no lean) but keep the turntable yaw
    const a = rig.a;
    cam.position.set(0, 0.9 + st.dist * Math.sin(st.pitch) * 0.6, st.dist * Math.cos(st.pitch)); cam.lookAt(0, 0.72, 0);
    renderer.render(scene, cam);
  }
  function loop(t) { if (!alive) return; const dt = Math.min((t - last) / 1000, 0.05); last = t; render(dt); raf = requestAnimationFrame(loop); }
  resize();
  if (!opts.manual) raf = requestAnimationFrame(loop);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null; if (ro) ro.observe(own ? el : canvas);
  const ready = Promise.all([getAsset(st.type).whenFull, loadWeapons()]).then(() => {});
  return {
    ready,
    set(o) {
      if (o.type !== undefined) { st.type = bikeTypeOf(null, { bikeType: o.type }); getAsset(st.type); }
      for (const k of ['livery', 'yaw', 'pitch', 'dist', 'steer', 'weapon', 'swing', 'quality', 'auto', 'speed', 'lod', 'swingAt', 'swingSide', 'lean', 'rider', 'rollOnly']) if (o[k] !== undefined) st[k] = o[k];
    },
    render, resize, debug: () => ({ yaw: st.yaw, rot: rig && rig.root.rotation.y, lod: rig && rig.lod }),
    get ready_() { return rig !== null; },
    dispose() { alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); if (rig) disposeRig(rig); envRT.dispose(); renderer.dispose(); if (own && own.parentNode) own.parentNode.removeChild(own); },
  };
}
