// Instanced roadside scenery, windowed by track position: leafy trees (Nature.js), rocks, grass tufts, bushes, rails, signs, lamps.
import * as THREE from '../../public/vendor/three.module.min.js';
import { GLTFLoader } from '../../public/vendor/GLTFLoader.js';
import { mergeGeometries, mergeVertices } from '../../public/vendor/BufferGeometryUtils.js';
import { Mesher, rng, fbm, vnoise, lerp, SLICE, slicer } from './util.js';
import { patchMaterial, makeShared, GUST_GLSL } from './Look.js';
import { createNature } from './Nature.js';
import { propsGen, railGeometry, fenceGeometry } from './Props.js';
import { createLife } from './Life.js';
import { createFx } from './Fx.js';
import { propsAtlas } from './EnvTex.js';

const GLB = (n) => new URL(`../../assets/models/${n}.glb`, import.meta.url).href;
const SH = makeShared();

/** Rock: displaced, welded icosphere with smooth normals and planar UVs per face (textured with the terrain rock set). */
function geoRock() {
  let g = new THREE.IcosahedronGeometry(1, 2);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.7 + 0.55 * vnoise(x * 2.1 + 5, z * 2.6 + y * 2.9, 7) + 0.12 * vnoise(x * 6 + 1, z * 6 + y * 5, 11);
    p.setXYZ(i, x * k, y * k * 0.72 + 0.14, z * k);
  }
  g.computeVertexNormals();
  g = g.toNonIndexed();
  const pos = g.attributes.position, nor = g.attributes.normal, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    const nx = Math.abs(nor.getX(i) + nor.getX(i + 1) + nor.getX(i + 2)), ny = Math.abs(nor.getY(i) + nor.getY(i + 1) + nor.getY(i + 2)), nz = Math.abs(nor.getZ(i) + nor.getZ(i + 1) + nor.getZ(i + 2));
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k), y = pos.getY(i + k), z = pos.getZ(i + k);
      let u, v;
      if (ny >= nx && ny >= nz) { u = x; v = z; } else if (nx >= nz) { u = z; v = y; } else { u = x; v = y; }
      uv[(i + k) * 2] = u * 0.55; uv[(i + k) * 2 + 1] = v * 0.55;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
/** Grass tuft: three crossed quads textured from the ground atlas cell (u0..u1). */
function geoTuft(u0, u1, w = 1.2, h = 0.9) {
  const pos = [], uv = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI / 3, cx = Math.cos(a) * w / 2, cz = Math.sin(a) * w / 2, b = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, h, cz, -cx, h, -cz);
    uv.push(u0, 1, u1, 1, u1, 0, u0, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);   // lit from above, like the ground it sits on
  return g;
}

function geoRail() {
  const m = new Mesher();
  for (const z of [-1.9, 0, 1.9]) m.box(0.1, 0.78, 0.1, [0, 0.39, z], 0x8c9298);
  m.box(0.05, 0.3, 4.05, [0.0, 0.62, 0], 0xb9bfc6);
  m.box(0.09, 0.07, 4.05, [0.0, 0.62, 0], 0xa5abb2);
  m.box(0.02, 0.12, 0.12, [-0.04, 0.62, 0], 0xd8362c);
  return m.build();
}
function geoFence() {
  const m = new Mesher();
  for (const z of [-2, 0, 2]) m.box(0.13, 1.15, 0.13, [0, 0.57, z], 0x6e5237);
  m.box(0.05, 0.09, 4.05, [0, 0.55, 0], 0x92714a);
  m.box(0.05, 0.09, 4.05, [0, 0.92, 0], 0x92714a);
  return m.build();
}
function geoSign() {
  const m = new Mesher();
  m.cyl(0.04, 0.04, [0, 0, 0], [0, 2.3, 0], 0x8c9298, 0, 5);
  m.box(0.92, 0.92, 0.03, [0, 2.75, 0.03], 0x111111, 0, [0, 0, Math.PI / 4]);
  m.box(0.84, 0.84, 0.03, [0, 2.75, 0.045], 0xf2c21a, 0, [0, 0, Math.PI / 4]);
  m.box(0.46, 0.09, 0.03, [0, 2.75, 0.07], 0x111111);
  m.box(0.26, 0.09, 0.03, [-0.17, 2.84, 0.07], 0x111111, 0, [0, 0, -0.75]);
  m.box(0.26, 0.09, 0.03, [-0.17, 2.66, 0.07], 0x111111, 0, [0, 0, 0.75]);
  return m.build();
}
function geoPost() {
  const m = new Mesher();
  m.box(0.12, 1.0, 0.1, [0, 0.5, 0], 0xe6e6dc); m.box(0.08, 0.1, 0.02, [0, 0.82, 0.06], 0xffb020);
  return m.build();
}

/** Loads a glb and returns {name: BufferGeometry (merged, vertex-coloured)}. */
const _glb = new Map();
export function loadGlbGeometries(name) {
  if (_glb.has(name)) return _glb.get(name);
  const p = new Promise((resolve) => {
    new GLTFLoader().load(GLB(name), (gltf) => {
      const out = {};
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        const vc = g.attributes.color;
        for (let i = 0; i < n; i++) {
          const r = vc ? vc.getX(i) : 1, gg = vc ? vc.getY(i) : 1, b = vc ? vc.getZ(i) : 1;
          col[i * 3] = r * mat.color.r + mat.emissive.r * 0.6; col[i * 3 + 1] = gg * mat.color.g + mat.emissive.g * 0.6; col[i * 3 + 2] = b * mat.color.b + mat.emissive.b * 0.6;
        }
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(n), 1));
        const ng = g.index ? g.toNonIndexed() : g;
        (out[o.name] = out[o.name] ? [out[o.name], ng] : ng);
      });
      for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = mergeGeometries(out[k]);
      resolve(out);
    }, undefined, () => resolve({}));
  });
  _glb.set(name, p);
  return p;
}

// ---------- layer ----------
class Layer {
  constructor(geo, mat) { this.geo = geo; this.mat = mat; this.m = []; this.c = []; this.s = []; }
  push(s, mArr, r, g, b) { this.s.push(s); for (let i = 0; i < 16; i++) this.m.push(mArr[i]); this.c.push(r, g, b); }
  /** Sort by s, allocate the InstancedMesh with capacity = the largest window. */
  finish(span, back) {
    const n = this.s.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.s[a] - this.s[b]);
    this.S = new Float32Array(n); this.M = new Float32Array(n * 16); this.C = new Float32Array(n * 3);
    order.forEach((o, k) => {
      this.S[k] = this.s[o];
      for (let i = 0; i < 16; i++) this.M[k * 16 + i] = this.m[o * 16 + i];
      for (let i = 0; i < 3; i++) this.C[k * 3 + i] = this.c[o * 3 + i];
    });
    this.m = this.c = this.s = null;
    let cap = 1, j = 0;
    for (let i = 0; i < n; i++) { while (j < n && this.S[j] <= this.S[i] + span) j++; cap = Math.max(cap, j - i); }
    this.back = back; this.span = span;
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.n = n; this.lastLo = -1; this.lastHi = -1;
    return this.mesh;
  }
  /** Copies the window [camS - back, camS - back + span] into the mesh. */
  update(camS, force) {
    const lo = lowerBound(this.S, camS - this.back), hi = Math.min(lowerBound(this.S, camS - this.back + this.span), lo + this.mesh.instanceMatrix.count);
    if (!force && lo === this.lastLo && hi === this.lastHi) return;
    this.lastLo = lo; this.lastHi = hi;
    const cnt = hi - lo;
    this.mesh.instanceMatrix.array.set(this.M.subarray(lo * 16, hi * 16));
    this.mesh.instanceColor.array.set(this.C.subarray(lo * 3, hi * 3));
    this.mesh.count = cnt;
    this.mesh.visible = cnt > 0;
    this.mesh.instanceMatrix.clearUpdateRanges(); this.mesh.instanceColor.clearUpdateRanges();
    if (cnt > 0) { this.mesh.instanceMatrix.addUpdateRange(0, cnt * 16); this.mesh.instanceColor.addUpdateRange(0, cnt * 3); }
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
  }
}
function lowerBound(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }

const _arr = new Array(16).fill(0);
function yawMat(x, y, z, yaw, sx, sy, sz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  _arr[0] = c * sx; _arr[1] = 0; _arr[2] = -s * sx; _arr[3] = 0;
  _arr[4] = 0; _arr[5] = sy; _arr[6] = 0; _arr[7] = 0;
  _arr[8] = s * sz; _arr[9] = 0; _arr[10] = c * sz; _arr[11] = 0;
  _arr[12] = x; _arr[13] = y; _arr[14] = z; _arr[15] = 1;
  return _arr;
}
/** Frame with local -Z along (fx,fy,fz) (unit) and up ~ +Y. */
function frameMat(x, y, z, fx, fy, fz, sx, sy, sz) {
  const bx = -fx, by = -fy, bz = -fz;
  let Xx = bz, Xz = -bx; const l = Math.hypot(Xx, Xz) || 1; Xx /= l; Xz /= l;
  const Yx = by * Xz, Yy = bz * Xx - bx * Xz, Yz = -by * Xx;
  _arr[0] = Xx * sx; _arr[1] = 0; _arr[2] = Xz * sx; _arr[3] = 0;
  _arr[4] = Yx * sy; _arr[5] = Yy * sy; _arr[6] = Yz * sy; _arr[7] = 0;
  _arr[8] = bx * sz; _arr[9] = by * sz; _arr[10] = bz * sz; _arr[11] = 0;
  _arr[12] = x; _arr[13] = y; _arr[14] = z; _arr[15] = 1;
  return _arr;
}

let _tuftTex = null;
function tuftTexture() {
  if (_tuftTex) return _tuftTex;
  const t = _tuftTex = new THREE.Texture(); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 2;
  t.userData.ready = new Promise((res) => { const im = new Image(); im.onload = () => { (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => { t.image = im; t.needsUpdate = true; res(); }); }; im.onerror = () => res(); im.src = new URL('../../assets/nature/ground.webp', import.meta.url).href; });
  return t;
}
/** Species a theme uses (trees + bushes), for preloading. */
export function speciesFor(roadside) { const C = CFG[roadside] || CFG.pines; return [...new Set([...C.trees.map((x) => x[0]), ...C.bush.map((x) => x[0])])]; }
/** The shared grass-tuft atlas (texture + load promise). */
export function tuftAtlas() { const t = tuftTexture(); return { tex: t, ready: t.userData.ready }; }
const CFG = {
  pines:    { trees: [['pine', 1]], near: [0.55, 5, 26], far: [0.5, 26, 150], sc: [0.75, 1.35], rock: 0.10, bush: [['scrub', 0.2]], bushRate: 0.18, tuft: 0.9, dry: 0.15 },
  palms:    { trees: [['palm', 1]], near: [0.6, 4, 30], far: [0.3, 30, 130], sc: [1.0, 1.5], rock: 0.08, bush: [['scrub', 1]], bushRate: 0.35, tuft: 0.45, dry: 0.7 },
  redwoods: { trees: [['redwood', 1]], near: [0.55, 4.5, 24], far: [0.6, 24, 120], sc: [0.8, 1.35], rock: 0.05, bush: [['fern', 1]], bushRate: 1.1, tuft: 0.5, dry: 0.0 },
  cactus:   { trees: [['saguaro', 0.55], ['joshua', 0.45]], near: [0.30, 4, 40], far: [0.12, 40, 170], sc: [0.8, 1.35], rock: 0.16, bush: [['scrub', 1]], bushRate: 0.6, tuft: 0.25, dry: 1.0 },
  oaks:     { trees: [['oak', 1]], near: [0.30, 6, 30], far: [0.20, 30, 130], sc: [0.8, 1.3], rock: 0.05, bush: [['scrub', 1]], bushRate: 0.3, tuft: 0.9, dry: 0.4 },
};

/**
 * Generates and owns all instanced scenery for a track.
 * @returns {{group:THREE.Group, update:(camS:number, cx?:number, cz?:number)=>void, dispose:()=>void}}
 */
export function createScenery(track, theme, terrain, quality) { const g = sceneryGen(track, theme, terrain, quality); let r = g.next(); while (!r.done) r = g.next(); return r.value; }
/** Builds scenery in ~10 ms slices, awaiting `wait()` between them. */
export async function createSceneryAsync(track, theme, terrain, quality, wait) { const g = sceneryGen(track, theme, terrain, quality); let r = g.next(); while (!r.done) { await wait(); SLICE.t = performance.now(); r = g.next(); } return r.value; }
function* sceneryGen(track, theme, terrain, quality) {
  const sl = slicer();
  const C = CFG[theme.roadside] || CFG.pines;
  const seed = track.seed | 0;
  const R = rng(seed * 7 + 13);
  const rr = (a, b) => a + (b - a) * R();
  const edge = terrain.edge, L = track.length;
  const ground = terrain.ground;
  const P = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
  const tt = { s: 0, d: 0, yaw: 0 };
  const lowQ = quality === 'low';
  const lamProps = (o) => { const c = Object.assign({}, o); delete c.roughness; delete c.metalness; delete c.envMapIntensity; return c; };
  const std = (key, o = {}) => patchMaterial(lowQ ? new THREE.MeshLambertMaterial(lamProps(o)) : new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.7, metalness: 0.1, envMapIntensity: 0.5 }, o)), key + (lowQ ? 'L' : ''), null);
  const lamPropsIf = (low, o) => (low ? lamProps(o) : o);
  const vcol = std('prop', { vertexColors: true });
  const vcolDS = std('propDS', { vertexColors: true, side: THREE.DoubleSide });
  const metal = std('metal', { vertexColors: true, roughness: 0.42, metalness: 0.65 });
  const rockMat = patchMaterial(lowQ ? new THREE.MeshLambertMaterial({ map: terrain.gset.d }) : new THREE.MeshStandardMaterial({ map: terrain.gset.d, normalMap: terrain.gset.rockN, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.92, metalness: 0, envMapIntensity: 0.5 }), 'rock' + (lowQ ? 'L' : ''), null);
  // grass tufts: alpha-tested crossed quads, wind
  const gtex = tuftTexture();
  const tuftMat = patchMaterial(new (lowQ ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial)(lamPropsIf(lowQ, { map: gtex, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 1, envMapIntensity: 0.7 })), 'tuft' + (lowQ ? 'L' : ''), (sh) => {
    sh.uniforms.uTime = SH.uTime; sh.uniforms.uWind = SH.uWind;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\nuniform float uTime; uniform vec2 uWind;\n${GUST_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec3 ip = vec3(instanceMatrix[3]); float ph = ip.x * 0.37 + ip.z * 0.29; float gu = windGust(ip.xz, uTime, uWind); transformed.xz += uWind * (0.35 + 0.35 * sin(uTime * 1.9 + ph) + 1.1 * gu * gu) * 0.16 * position.y * position.y; }`);
  });
  const layers = {};
  const mk = (name, geo, mat = vcol, opt = null) => { const l = (layers[name] = new Layer(geo, mat)); if (opt) { l.optSpan = opt.span; l.optBack = opt.back; } return l; };
  const nature = createNature(quality);
  const rock = mk('rock', geoRock(), rockMat);
  const tuft = mk('tuft', geoTuft(0, 0.5), tuftMat, { span: 130, back: 15 });
  const dry = mk('dry', geoTuft(0.5, 1), tuftMat, { span: 130, back: 15 });
  const propMat = patchMaterial(lowQ ? new THREE.MeshLambertMaterial({ map: propsAtlas(quality), vertexColors: true }) : new THREE.MeshStandardMaterial({ map: propsAtlas(quality), vertexColors: true, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.55 }), 'rail' + (lowQ ? 'L' : ''), null);
  const rail = mk('rail', railGeometry(), propMat);
  const fence = theme.roadside === 'oaks' ? mk('fence', fenceGeometry(), propMat) : null;
  const post = mk('post', geoPost());
  const kmpost = mk('kmpost', geoPost());
  const lamp = mk('lamp', geoPost(), metal);

  const keep = (s, d, margin) => {
    track.sampleAt(s, P);
    const lx = P.hz, lz = -P.hx;
    const x = P.x + lx * d, z = P.z + lz * d;
    const k = P.curve;
    if (k !== 0) { const dm = 0.7 / Math.abs(k); if ((k > 0 && d > dm) || (k < 0 && -d > dm)) return null; }
    track.toTrack(x, z, s, tt);
    if (Math.abs(tt.d) < edge + margin) return null;
    return [x, ground(s, d, x, z), z];
  };
  const seaCliff = (s, d, y) => terrain.T.sea && d > 0 && y < terrain.edgeY(s, d) - 2.2;
  const pickTree = () => { let t = R() * C.trees.reduce((a, b) => a + b[1], 0); for (const [sp, w] of C.trees) { t -= w; if (t <= 0) return sp; } return C.trees[0][0]; };
  const tint = (a = 0.86, b = 1.14) => rr(a, b);

  // trees, bushes, rocks, tufts
  const STEP = 5;
  const dens = quality === 'low' ? 0.62 : quality === 'medium' ? 0.82 : 1;   // fewer trees on phones (triangle and draw budget)
  for (let s = 2; s < L - 4; s += STEP) {
    if (sl()) yield;
    for (const side of [1, -1]) {
      const cl = 0.25 + 1.5 * fbm(s * 0.011 + side * 37, 0.5, seed, 2);
      for (const band of [C.near, C.far]) {
        if (R() < band[0] * cl * dens) {
          const sj = s + R() * STEP, d = side * (edge + rr(band[1], band[2]));
          const q = keep(sj, d, band === C.near ? 3.2 : 3.8);
          if (q && !seaCliff(sj, d, q[1])) {
            const sc = rr(C.sc[0], C.sc[1]);
            const v = tint(0.84, 1.16);
            nature.add(pickTree(), sj, q[0], q[1] - 0.08, q[2], R() * 6.283, sc, v, 1, v * 0 + rr(0.95, 1.05), rr(0.9, 1.0));
          }
        }
      }
      if (R() < C.rock * cl) {
        const sj = s + R() * STEP, d = side * (edge + rr(2.2, 45));
        const q = keep(sj, d, 1.6);
        if (q) { const sc = rr(0.4, 2.4) * (R() < 0.12 ? 2.2 : 1); const v = rr(0.75, 1.15); rock.push(sj, yawMat(q[0], q[1] - 0.12 * sc, q[2], R() * 6.283, sc * rr(0.8, 1.4), sc * rr(0.7, 1.1), sc * rr(0.8, 1.4)), v, v, v); }
      }
      // bushes / ferns near the road
      if (R() < C.bushRate * cl * 0.55) {
        const sj = s + R() * STEP, d = side * (edge + rr(2.4, 22));
        const q = keep(sj, d, 1.8);
        if (q && !seaCliff(sj, d, q[1])) {
          const sp = C.bush[0][0], sc = rr(0.8, 1.7), v = tint(0.8, 1.15);
          nature.add(sp, sj, q[0], q[1] - 0.04, q[2], R() * 6.283, sc, v, 1, rr(0.95, 1.1), rr(0.8, 1));
        }
      }
      // grass tufts along the verge (near the road only)
      for (let k = 0; k < 3; k++) if (R() < C.tuft) {
        const sj = s + R() * STEP, d = side * (edge + rr(0.5, 14));
        const q = keep(sj, d, 0.5);
        if (q && !seaCliff(sj, d, q[1])) {
          const isDry = R() < C.dry, sc = rr(0.6, 1.4), v = rr(0.8, 1.2);
          (isDry ? dry : tuft).push(sj, yawMat(q[0], q[1] - 0.03, q[2], R() * 6.283, sc, sc * rr(0.8, 1.3), sc), v, v, v);
        }
      }
    }
  }

  // curve masks: sharp bends (R < 260 m)
  const E = track.edges;
  const sharp = new Uint8Array(E.n);
  for (let i = 0; i < E.n; i++) if (Math.abs(E.curve[i]) > 1 / 260) sharp[i] = 1;
  const dil = new Uint8Array(E.n);
  for (let i = 0; i < E.n; i++) if (sharp[i]) for (let k = -8; k <= 8; k++) { const j = i + k; if (j >= 0 && j < E.n) dil[j] = 1; }
  // rails on the outside of bends; on a coast also along the sea side
  for (let s = 6; s < L - 10; s += 4) {
    if (sl()) yield;
    const i = Math.round(s / E.step);
    let side = 0;
    if (dil[i]) { let c = 0; for (let k = -6; k <= 6; k++) { const j = i + k; if (j >= 0 && j < E.n) c += E.curve[j]; } side = c > 0 ? -1 : 1; }
    const sides = [];
    if (side) sides.push(side);
    if (terrain.T.sea && vnoise(s / 90, 3.3, seed) > 0.3 && side !== 1) sides.push(1);
    for (const sd of sides) pushLinear(rail, s, sd * (edge + 0.55), 1, 1);
  }
  if (fence) for (let s = 8; s < L - 10; s += 4) for (const sd of [1, -1]) {
    if (sd === 1 && sl()) yield;
    if (vnoise(s / 140 + sd * 20, 1.7, seed) > 0.42) pushLinear(fence, s, sd * (edge + 2.3), 1, 1);
  }
  function pushLinear(layer, s, d, sy, sz) {
    track.sampleAt(s, P);
    const lx = P.hz, lz = -P.hx;
    const x = P.x + lx * d, z = P.z + lz * d;
    const y = ground(s, d, x, z);
    const g = P.grade, il = 1 / Math.sqrt(1 + g * g);
    const side = d > 0 ? 1 : -1;
    const sgn = side < 0 ? 1 : -1;
    layer.push(s, frameMat(x, y, z, P.hx * il * sgn, g * il * sgn, P.hz * il * sgn, 1, sy, sz), 1, 1, 1);
  }

  // delineators / km posts (env_misc.glb when loaded), lamps (env_lamp.glb)
  for (let s = 30; s < L - 10; s += 40) for (const sd of [1, -1]) {
    const d = sd * (edge + 0.45);
    track.sampleAt(s, P);
    const x = P.x + P.hz * d, z = P.z - P.hx * d;
    post.push(s, yawMat(x, ground(s, d, x, z), z, P.yaw, 1, 1, 1), 1, 1, 1);
  }
  for (let s = 500; s < L - 20; s += 500) {
    const d = -(edge + 1.3);
    track.sampleAt(s, P);
    const x = P.x + P.hz * d, z = P.z - P.hx * d;
    kmpost.push(s, yawMat(x, ground(s, d, x, z), z, P.yaw, 1.4, 1.4, 1.4), 1, 1, 1);
  }
  for (const s of [4, 44, track.finishS - 40, track.finishS + 36]) for (const sd of [1, -1]) {
    const d = sd * (edge + 1.6);
    track.sampleAt(s, P);
    const x = P.x + P.hz * d, z = P.z - P.hx * d;
    const yaw = P.yaw + (sd > 0 ? Math.PI : 0);
    lamp.push(s, yawMat(x, ground(s, d, x, z), z, yaw, 1, 1, 1), 1, 1, 1);
  }

  yield;
  const span = 700, back = 90;
  const group = new THREE.Group();
  for (const k of Object.keys(layers)) group.add(layers[k].finish(layers[k].optSpan || span, layers[k].optBack || back));
  nature.finish();
  group.add(nature.group);
  yield;
  const props = yield* propsGen(track, theme, terrain, quality, sl);
  group.add(props.group);
  const life = createLife(track, theme, terrain, quality);
  group.add(life.group);
  const fx = createFx(quality, theme);
  group.add(fx.group);
  if (fx.hasDevil) { const s = track.length * 0.42; track.sampleAt(s, P); const d = -(edge + 70); fx.setDevil(P.x + P.hz * d, ground(s, d, P.x + P.hz * d, P.z - P.hx * d), P.z - P.hx * d); }
  let curSpan = span, curBack = back;
  layers.kmpost.mesh.scale.setScalar(1);
  // swap in the real prop geometry once loaded
  let alive = true;
  loadGlbGeometries('env_misc').then((o) => {
    if (!alive) return;
    if (o.delineator) { layers.post.mesh.geometry = o.delineator; }
    if (o.kmpost) { layers.kmpost.mesh.geometry = o.kmpost; }
  });
  loadGlbGeometries('env_lamp').then((o) => { if (alive && o.lamp) layers.lamp.mesh.geometry = o.lamp; });

  let last = -1e9;
  function update(camS, cx = 0, cz = 0, force) {
    nature.update(camS, cx, cz, force);
    props.update(camS, curSpan, curBack);
    if (!force && Math.abs(camS - last) < 12) return;
    last = camS;
    for (const k in layers) layers[k].update(camS, true);
  }
  /** Narrows the drawn window (low quality). */
  function setWindow(sp, bk) { curSpan = sp; curBack = bk; for (const k in layers) { if (layers[k].optSpan) continue; layers[k].span = sp; layers[k].back = bk; } nature.setWindow(sp, bk); last = -1e9; }
  if (quality === 'low') setWindow(430, 50); else if (quality === 'medium') setWindow(560, 70);
  update(0, 0, 0, true);
  function dispose() {
    alive = false;
    for (const k in layers) { layers[k].mesh.dispose(); if (layers[k].geo && k !== 'rock' && k !== 'tuft' && k !== 'dry') layers[k].geo.dispose(); }
    layers.rock.geo.dispose(); layers.tuft.geo.dispose(); layers.dry.geo.dispose();
    nature.dispose(); props.dispose(); life.dispose(); fx.dispose(); propMat.dispose();
    for (const m of [vcol, vcolDS, metal, rockMat, tuftMat]) m.dispose();
  }
  const counts = () => Object.assign(Object.fromEntries(Object.entries(layers).map(([k, l]) => [k, l.n])), nature.counts());
  /** Per-frame animation: life (birds, boats, plane), particles. */
  function tick(dt, time, camera, viewH, camS, bikeS, info) { life.update(camS, camera.position, time, dt, bikeS); fx.update(dt, camera, viewH, info); }
  return { group, update, tick, setWindow, dispose, counts, nature, props, life, fx };
}
