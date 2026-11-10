// Roadside world: farmsteads, cabins, gas station / diner, water towers, wind pumps, billboards, telephone poles with sagging wires,
// mailboxes, hay bales, rest areas, overpasses, a town skyline, road-works cones, spectators and flags at the start, tyre marks, readable road signs and grazing animals.
// Everything is code-built low-poly geometry textured from ONE baked atlas (assets/env/props/props_atlas_*.webp), merged into ~400 m chunks
// by position along the track, so the whole prop world costs 1 draw call per visible chunk (2-3 calls) regardless of how many kinds exist.
// Nothing is placed on the paved width + shoulder + 1 m (checked with track.toTrack).
import * as THREE from '../../public/vendor/three.module.min.js';
import { mergeGeometries } from '../../public/vendor/BufferGeometryUtils.js';
import { rng, vnoise } from './util.js';
import { patchMaterial } from './Look.js';
import { propsAtlas } from './EnvTex.js';

// ---- atlas layout (matches assets/env/src/gen_props.py): 2048^2; materials 4x2 cells of 512; squares 256 at y=1024; wide signs 512x256 from y=1280
const rectPx = (x, y, w, h) => [(x + 1.5) / 2048, 1 - (y + h - 1.5) / 2048, (x + w - 1.5) / 2048, 1 - (y + 1.5) / 2048];   // u0, vBottom, u1, vTop
export const MAT = {}; ['clap', 'barn', 'tin', 'stucco', 'shingle', 'plank', 'concrete', 'glass'].forEach((k, i) => { MAT[k] = rectPx((i % 4) * 512, Math.floor(i / 4) * 512, 512, 512); });
export const SIGN = {};
['curve', 'speed45', 'speed65', 'rock', 'deer', 'rest', 'stop', 'white'].forEach((k, i) => { SIGN[k] = rectPx(i * 256, 1024, 256, 256); });
['pelican', 'dry', 'fern', 'alder', 'cola', 'motors', 'bbq', 'farm', 'inn', 'gas', 'diner', 'resort'].forEach((k, i) => { SIGN[k] = rectPx((i % 4) * 512, 1280 + Math.floor(i / 4) * 256, 512, 256); });
const WHITE = SIGN.white;

/** Merged-geometry builder with a local frame (origin + yaw) and atlas rect UVs. */
export class PB {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; this.set(0, 0, 0, 0); }
  set(x, y, z, th) { this.ox = x; this.oy = y; this.oz = z; this.cs = Math.cos(th); this.sn = Math.sin(th); return this; }
  _v(lx, ly, lz) { return [this.ox + lx * this.cs + lz * this.sn, this.oy + ly, this.oz - lx * this.sn + lz * this.cs]; }
  _n(nx, ny, nz) { return [nx * this.cs + nz * this.sn, ny, -nx * this.sn + nz * this.cs]; }
  /** quad a(bl) b(br) c(tr) d(tl) in local coords; uv rect [u0,v0,u1,v1]; optional flipU */
  quad(a, b, c, d, rect, tint = [1, 1, 1], flip = false, ur = 1, vr = 1) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const base = this.p.length / 3, wn = this._n(nx, ny, nz);
    const u0 = flip ? rect[2] : rect[0], u1 = flip ? rect[0] : rect[2];
    const uv = [[u0, rect[1]], [u1, rect[1]], [u1, rect[3]], [u0, rect[3]]];
    [a, b, c, d].forEach((q, k) => { this.p.push(...this._v(q[0], q[1], q[2])); this.n.push(...wn); this.u.push(uv[k][0], uv[k][1]); this.c.push(tint[0], tint[1], tint[2]); });
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a, b, c, rect, tint = [1, 1, 1]) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1; const wn = this._n(nx / l, ny / l, nz / l), base = this.p.length / 3;
    const mu = (rect[0] + rect[2]) / 2, uv = [[rect[0], rect[1]], [rect[2], rect[1]], [mu, rect[3]]];
    [a, b, c].forEach((q, k) => { this.p.push(...this._v(q[0], q[1], q[2])); this.n.push(...wn); this.u.push(uv[k][0], uv[k][1]); this.c.push(tint[0], tint[1], tint[2]); });
    this.i.push(base, base + 1, base + 2);
  }
  /** axis-aligned box centred at (cx, cy, cz): side rect(s) [front(+z), right(+x), back(-z), left(-x)] or one, top rect */
  box(sx, sy, sz, cx, cy, cz, side, top = side, tint = [1, 1, 1], bottom = false) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const S = Array.isArray(side[0]) ? side : [side, side, side, side];
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], S[0], tint);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], S[1], tint);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], S[2], tint);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], S[3], tint);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top, tint);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], top, tint);
  }
  /** gable roof: eave height cy, ridge along z, width w (x), depth d (z), rise h */
  gable(w, d, h, cx, cy, cz, roof, gableRect, tint = [1, 1, 1], over = 0.35) {
    const x0 = cx - w / 2 - over, x1 = cx + w / 2 + over, z0 = cz - d / 2 - over, z1 = cz + d / 2 + over, ry = cy + h;
    this.quad([x0, cy, z1], [cx, ry, z1], [cx, ry, z0], [x0, cy, z0], roof, tint);
    this.quad([cx, ry, z1], [x1, cy, z1], [x1, cy, z0], [cx, ry, z0], roof, tint);
    this.tri([x0 + over, cy, z1 - over + 0.01], [x1 - over, cy, z1 - over + 0.01], [cx, ry, z1 - over + 0.01], gableRect, tint);
    this.tri([x1 - over, cy, z0 + over - 0.01], [x0 + over, cy, z0 + over - 0.01], [cx, ry, z0 + over - 0.01], gableRect, tint);
  }
  cyl(r, h, cx, cy, cz, sides, rect, tint = [1, 1, 1], rTop = r, cap = true) {
    for (let k = 0; k < sides; k++) {
      const a0 = k / sides * Math.PI * 2, a1 = (k + 1) / sides * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r];
      const q1 = [cx + Math.cos(a1) * rTop, cy + h, cz + Math.sin(a1) * rTop], q0 = [cx + Math.cos(a0) * rTop, cy + h, cz + Math.sin(a0) * rTop];
      // outward winding: p1 -> p0 seen from outside
      const u0 = rect[0] + (rect[2] - rect[0]) * k / sides, u1 = rect[0] + (rect[2] - rect[0]) * (k + 1) / sides;
      this.quad(p1, p0, q0, q1, [u1, rect[1], u0, rect[3]], tint);
    }
    if (cap && rTop > 0.01) for (let k = 0; k < sides; k++) {
      const a0 = k / sides * Math.PI * 2, a1 = (k + 1) / sides * Math.PI * 2;
      this.tri([cx, cy + h, cz], [cx + Math.cos(a1) * rTop, cy + h, cz + Math.sin(a1) * rTop], [cx + Math.cos(a0) * rTop, cy + h, cz + Math.sin(a0) * rTop], rect, tint);
    }
  }
  /** ribbon (two crossed quads) between two local points, for wires */
  wire(a, b, w, tint) {
    for (const ax of [[0, w, 0], [w, 0, 0]]) {
      this.quad([a[0] - ax[0], a[1] - ax[1], a[2] - ax[2]], [b[0] - ax[0], b[1] - ax[1], b[2] - ax[2]], [b[0] + ax[0], b[1] + ax[1], b[2] + ax[2]], [a[0] + ax[0], a[1] + ax[1], a[2] + ax[2]], WHITE, tint);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
  get tris() { return this.i.length / 3; }
}

// ---- guard rail / fence geometry with real (rusty, scratched) textures, for the instanced layers in Scenery.js
export function railGeometry() {
  const b = new PB(), k = [1, 1, 1];
  for (const z of [-1.9, 0, 1.9]) b.box(0.1, 0.78, 0.1, 0, 0.39, z, MAT.plank, MAT.plank, [0.8, 0.8, 0.8]);
  b.box(0.05, 0.3, 4.05, 0, 0.62, 0, MAT.tin, MAT.tin, [1, 1, 1]);
  b.box(0.09, 0.07, 4.05, 0, 0.62, 0, MAT.tin, MAT.tin, [0.85, 0.85, 0.85]);
  b.box(0.02, 0.12, 0.12, -0.04, 0.62, 0, SIGN.white, SIGN.white, [0.85, 0.2, 0.15]);
  return b.build();
}
export function fenceGeometry() {
  const b = new PB();
  for (const z of [-2, 0, 2]) b.box(0.13, 1.15, 0.13, 0, 0.57, z, MAT.plank, MAT.plank, [0.9, 0.85, 0.8]);
  b.box(0.05, 0.1, 4.05, 0, 0.55, 0, MAT.plank, MAT.plank, [1, 0.95, 0.9]);
  b.box(0.05, 0.1, 4.05, 0, 0.92, 0, MAT.plank, MAT.plank, [1, 0.95, 0.9]);
  return b.build();
}

// ---- prop recipes (local frame: +z faces the road). Each returns the footprint radius (m).
const COL = { white: [1, 1, 1], red: [0.8, 0.25, 0.2], blue: [0.25, 0.4, 0.75], green: [0.3, 0.5, 0.3], yellow: [0.95, 0.8, 0.25], black: [0.06, 0.06, 0.07], dark: [0.25, 0.25, 0.27] };
function car(b, x, z, yaw, col) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rot = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  // body and cabin as yawed boxes (via 4 quads each) - small, so use axis boxes when yaw ~ 0 / pi/2
  const sw = Math.abs(Math.sin(yaw)) > 0.7;
  const L = sw ? [1.9, 4.4] : [4.4, 1.9];
  b.box(sw ? 1.8 : 4.3, 0.7, sw ? 4.3 : 1.8, x, 0.62, z, WHITE, WHITE, col);
  b.box(sw ? 1.6 : 2.2, 0.55, sw ? 2.2 : 1.6, x, 1.2, z, MAT.glass, WHITE, [0.55, 0.62, 0.7]);
  b.box(sw ? 1.9 : 0.5, 0.3, sw ? 0.5 : 1.9, x + (sw ? 0 : 1.9), 0.3, z + (sw ? 1.9 : 0), WHITE, WHITE, COL.dark);
  b.box(sw ? 1.9 : 0.5, 0.3, sw ? 0.5 : 1.9, x - (sw ? 0 : 1.9), 0.3, z - (sw ? 1.9 : 0), WHITE, WHITE, COL.dark);
}
const R = {
  farm(b, r) {   // farmhouse + barn + silo + hay
    b.box(9, 4.2, 6.5, 0, 2.1, 0, MAT.clap, MAT.shingle, [1, 0.97, 0.93]); b.gable(9, 6.5, 2.8, 0, 4.2, 0, MAT.shingle, MAT.clap, [0.8, 0.5, 0.45]);
    b.box(1.2, 2.2, 0.15, -2, 1.1, 3.3, MAT.plank, MAT.plank, [0.6, 0.35, 0.25]); b.box(1.5, 1.2, 0.12, 1.6, 2.2, 3.3, MAT.glass, MAT.glass); b.box(1.5, 1.2, 0.12, 3.6, 2.2, 3.3, MAT.glass, MAT.glass);
    b.box(1, 1.3, 1, -3.4, 5.3, -1, MAT.clap, MAT.concrete, [0.8, 0.65, 0.6]);
    b.box(12, 6.5, 9, 17, 3.25, 3, MAT.barn, MAT.tin, [1, 1, 1]); b.gable(12, 9, 3.2, 17, 6.5, 3, MAT.tin, MAT.barn, [0.85, 0.85, 0.9]);
    b.box(4, 4.2, 0.12, 17, 2.1, 7.55, MAT.plank, MAT.plank, [0.9, 0.9, 0.9]);
    b.cyl(2.2, 11, 28, 0, 2, 12, MAT.tin, [1, 1, 1], 2.2); b.cyl(2.2, 1.2, 28, 11, 2, 12, MAT.tin, [0.85, 0.9, 0.95], 0.2);
    for (let i = 0; i < 3; i++) b.cyl(0.85, 1.4, 3 + i * 2.1, 0, 12, 10, MAT.plank, [1.0, 0.9, 0.6]);
    car(b, -6, 6, 0, COL.blue); return 30;
  },
  cabin(b) {
    b.box(6, 3, 5, 0, 1.5, 0, MAT.plank, MAT.shingle, [0.9, 0.78, 0.65]); b.gable(6, 5, 1.8, 0, 3, 0, MAT.shingle, MAT.plank, [0.6, 0.5, 0.45], 0.5);
    b.box(0.9, 2.0, 0.12, 0, 1.0, 2.55, MAT.plank, MAT.plank, [0.5, 0.33, 0.22]); b.box(1.2, 1.0, 0.12, -1.8, 1.7, 2.55, MAT.glass, MAT.glass, [0.7, 0.7, 0.7]); b.box(1.2, 1.0, 0.12, 1.8, 1.7, 2.55, MAT.glass, MAT.glass, [0.7, 0.7, 0.7]);
    b.box(0.7, 2, 0.7, 2, 4, -1, MAT.concrete, MAT.concrete, [0.55, 0.5, 0.48]);
    for (let i = 0; i < 6; i++) b.cyl(0.18, 2.6, -4.2 + (i % 3) * 0.4, 0.2 + Math.floor(i / 3) * 0.36, 1.5, 6, MAT.plank, [0.9, 0.75, 0.55], 0.18);
    return 8;
  },
  gas(b) {
    b.box(22, 0.15, 16, 0, 0.07, 3, MAT.concrete, MAT.concrete, [0.9, 0.9, 0.9], true);
    b.box(11, 4, 6.5, 0, 2.1, -4, MAT.stucco, MAT.concrete, [1, 0.96, 0.9]); b.box(8, 2, 0.15, 0, 2.0, -0.7, MAT.glass, MAT.glass, [0.8, 0.85, 0.9]);
    b.box(14, 0.5, 8, 0, 5.3, 5, SIGN.white, MAT.tin, [0.92, 0.92, 0.9]); b.box(14.1, 0.55, 0.3, 0, 5.3, 9.05, SIGN.gas, SIGN.gas, [1, 1, 1]);
    for (const x of [-6, 6]) for (const z of [1.5, 8.5]) b.box(0.35, 5.0, 0.35, x, 2.6, z, MAT.concrete, MAT.concrete, [0.85, 0.85, 0.85]);
    for (const x of [-3, 3]) { b.box(0.7, 1.4, 0.5, x, 0.85, 5, SIGN.white, SIGN.white, COL.red); b.box(0.5, 0.3, 0.52, x, 1.35, 5, MAT.glass, MAT.glass); }
    b.box(0.3, 9, 0.3, 11, 4.5, 8, MAT.tin, MAT.tin); b.box(3.6, 1.8, 0.25, 11, 8.7, 8, SIGN.gas, SIGN.gas);
    car(b, -9, 9, Math.PI / 2, COL.red); car(b, 8.5, -6, 0, COL.yellow); return 16;
  },
  diner(b) {
    b.box(14, 3.6, 7, 0, 1.8, 0, [MAT.glass, MAT.stucco, MAT.stucco, MAT.stucco], MAT.tin, [1, 1, 1]); b.box(14.4, 0.5, 7.4, 0, 3.7, 0, SIGN.white, MAT.tin, [0.85, 0.2, 0.2]);
    b.box(2.5, 0.2, 7, 0, 4.2, 0, MAT.tin, MAT.tin); b.box(0.3, 7, 0.3, -9, 3.5, 5, MAT.tin, MAT.tin); b.box(5.2, 2.6, 0.25, -9, 7.4, 5, SIGN.diner, SIGN.diner);
    b.box(16, 0.12, 8, 0, 0.06, 8, MAT.concrete, MAT.concrete, [0.8, 0.8, 0.8], true);
    car(b, 4, 8, Math.PI / 2, COL.blue); car(b, -2, 9, Math.PI / 2, COL.white); return 13;
  },
  tower(b) {   // water tower
    for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) b.box(0.25, 10, 0.25, x, 5, z, MAT.plank, MAT.plank, [0.7, 0.55, 0.45]);
    b.box(4, 0.2, 4, 0, 5.5, 0, MAT.plank, MAT.plank, [0.6, 0.5, 0.4]);
    b.cyl(2.6, 4.2, 0, 10, 0, 14, MAT.plank, [0.8, 0.7, 0.6], 2.6); b.cyl(2.8, 1.8, 0, 14.2, 0, 14, MAT.tin, [0.85, 0.5, 0.4], 0.1); return 5;
  },
  windpump(b) {
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { b.box(0.14, 9, 0.14, x * 0.45, 4.5, z * 0.45, MAT.tin, MAT.tin, [0.7, 0.7, 0.7]); }
    b.box(1.8, 0.1, 1.8, 0, 2.5, 0, MAT.tin, MAT.tin); b.box(1.4, 0.1, 1.4, 0, 5.5, 0, MAT.tin, MAT.tin);
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; b.box(0.25, 1.9, 0.06, Math.cos(a) * 1.0 * 0, 9.4 + Math.sin(a) * 1.0, 0.7 + Math.cos(a) * 1.0, MAT.tin, MAT.tin, [0.8, 0.8, 0.85]); }
    b.box(0.2, 0.2, 2.4, 0, 9.4, 0.2, MAT.tin, MAT.tin); b.box(0.06, 1.3, 1.8, 0, 9.5, -1.6, MAT.tin, MAT.tin, [0.6, 0.25, 0.2]);
    b.cyl(1.8, 1.4, 4, 0, 0, 10, MAT.tin, [0.7, 0.75, 0.8]); return 6;
  },
  billboard(b, kind) {
    b.box(0.5, 6.5, 0.5, -3.6, 3.25, -0.3, MAT.plank, MAT.plank, [0.6, 0.5, 0.4]); b.box(0.5, 6.5, 0.5, 3.6, 3.25, -0.3, MAT.plank, MAT.plank, [0.6, 0.5, 0.4]);
    b.box(10.4, 5.4, 0.35, 0, 6.2, -0.2, MAT.tin, MAT.tin, [0.5, 0.5, 0.52]);
    b.quad([-5, 3.6, 0.01], [5, 3.6, 0.01], [5, 8.6, 0.01], [-5, 8.6, 0.01], SIGN[kind] || SIGN.cola); b.box(10, 0.3, 0.7, 0, 9.0, 0.1, MAT.tin, MAT.tin, [0.4, 0.4, 0.42]); return 6;
  },
  rest(b) {
    b.box(18, 0.12, 12, 0, 0.06, 0, MAT.concrete, MAT.concrete, [0.8, 0.8, 0.8], true);
    b.box(7, 0.2, 4, -4, 2.8, -2, MAT.shingle, MAT.shingle, [0.8, 0.7, 0.6]); for (const [x, z] of [[-7, -3.6], [-1, -3.6], [-7, -0.4], [-1, -0.4]]) b.box(0.2, 2.8, 0.2, x, 1.4, z, MAT.plank, MAT.plank, [0.7, 0.55, 0.4]);
    b.box(2.2, 0.1, 1, -4, 0.9, -2, MAT.plank, MAT.plank); b.box(0.15, 0.9, 0.9, -4.8, 0.45, -2, MAT.plank, MAT.plank); b.box(0.15, 0.9, 0.9, -3.2, 0.45, -2, MAT.plank, MAT.plank);
    b.box(0.2, 3, 0.2, 7, 1.5, 4, MAT.tin, MAT.tin); b.box(1.1, 1.1, 0.06, 7, 3.2, 4.12, SIGN.rest, SIGN.rest);
    car(b, 3, 3, Math.PI / 2, COL.green); car(b, 0, 3.5, Math.PI / 2, COL.white); return 11;
  },
};
function mailbox(b) { b.box(0.14, 1.1, 0.14, 0, 0.55, 0, MAT.plank, MAT.plank); b.box(0.28, 0.26, 0.5, 0, 1.2, 0, SIGN.white, SIGN.white, COL.blue); }
function bale(b, x, z, rot) { b.cyl(0.8, 1.3, x, 0, z, 10, MAT.plank, [1.1, 0.95, 0.55]); }
function cow(b, x, z, ya, col, horse = false, deer = false) {
  const s = deer ? 0.8 : horse ? 1.15 : 1, c = Math.cos(ya), sn = Math.sin(ya);
  const P = (lx, ly, lz) => [x + lx * c + lz * sn, ly, z - lx * sn + lz * c];
  const body = col, dark = col.map((v) => v * 0.55);
  const L = deer ? [1.2, 0.5, 0.45] : horse ? [1.8, 0.7, 0.55] : [1.7, 0.75, 0.65];
  const legH = deer ? 0.95 : horse ? 1.05 : 0.6;
  // local axis-aligned boxes using PB frame: temporarily move origin
  const ox = b.ox, oz = b.oz, cs0 = b.cs, sn0 = b.sn;
  const w = (lx, lz) => [lx * cs0 + lz * sn0, -lx * sn0 + lz * cs0];
  const [wx, wz] = w(x, z);
  const rot = Math.atan2(sn0, cs0) + ya;
  const save = [b.ox, b.oy, b.oz, Math.atan2(b.sn, b.cs)];
  b.set(ox + wx, save[1], oz + wz, save[3] + ya);
  b.box(L[0], L[2], L[1], 0, legH + L[1] / 2 * 0.9, 0, WHITE, WHITE, body);
  b.box(0.5, 0.5, 0.45, L[0] / 2 + 0.25, legH + (horse || deer ? 0.55 : 0.25), 0, WHITE, WHITE, deer ? col : dark.map((v) => v * 1.3));
  if (horse || deer) b.box(0.3, 0.7, 0.28, L[0] / 2 - 0.1, legH + 0.5, 0, WHITE, WHITE, body);
  for (const [lx, lz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) b.box(0.14, legH, 0.14, lx * L[0] * 0.38, legH / 2, lz * L[1] * 0.32, WHITE, WHITE, dark);
  if (!horse && !deer && ((x * 13 + z * 7) | 0) % 2) b.box(0.6, 0.02 + 0.76, 0.5, -0.2, legH + 0.42, 0.1, WHITE, WHITE, [0.95, 0.95, 0.92]);
  if (deer) { b.box(0.05, 0.4, 0.05, L[0] / 2 + 0.3, legH + 1.05, 0.1, WHITE, WHITE, [0.4, 0.3, 0.2]); b.box(0.05, 0.4, 0.05, L[0] / 2 + 0.3, legH + 1.05, -0.1, WHITE, WHITE, [0.4, 0.3, 0.2]); }
  b.set(save[0], save[1], save[2], save[3]);
}

/** Generator: places and merges all props. Returns {group, update(camS), dispose, counts()}. */
export function* propsGen(track, theme, terrain, quality, sl) {
  const seed = (track.seed | 0) * 31 + 5, Rn = rng(seed), rr = (a, b) => a + (b - a) * Rn();
  const edge = terrain.edge, L = track.length, ground = terrain.ground;
  const P = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 }, tt = { s: 0, d: 0, yaw: 0 };
  const lowQ = quality === 'low', hi = quality === 'high';
  const K = theme.roadside;
  const BUCKET = 400;
  const buckets = new Map();
  const B = (s) => { const k = Math.max(0, Math.floor(s / BUCKET)); let b = buckets.get(k); if (!b) { b = new PB(); buckets.set(k, b); } return b; };
  const farB = new PB();   // skyline etc, always drawn within a wider window
  const sd = (d) => (d > 0 ? 1 : -1);
  const at = (s, d) => { track.sampleAt(s, P); const x = P.x + P.hz * d, z = P.z - P.hx * d; return [x, z, P.yaw]; };
  const clear = (s, d, rad) => {      // not on the pavement or in a bend's inner side
    const [x, z] = at(s, d);
    track.toTrack(x, z, s, tt);
    if (Math.abs(tt.d) < edge + 1 + rad) return false;
    const k = P.curve; if (k !== 0) { const dm = 0.6 / Math.abs(k); if ((k > 0 && d > dm) || (k < 0 && -d > dm)) return false; }
    return true;
  };
  const flatY = (x, z, s, d, rad) => {   // lowest ground in the footprint, and the relief
    let lo = 1e9, hi2 = -1e9;
    for (const [dx, dz] of [[0, 0], [rad, 0], [-rad, 0], [0, rad], [0, -rad]]) { track.toTrack(x + dx, z + dz, s, tt); const y = ground(tt.s, tt.d, x + dx, z + dz); lo = Math.min(lo, y); hi2 = Math.max(hi2, y); }
    return [lo, hi2 - lo];
  };
  const seaSide = (d) => terrain.T.sea && d > 0;
  let count = 0; const kinds = {}; const placed = [];
  /** try to place a prop recipe near s on side with offset d0 .. d1; returns true when placed */
  const place = function* (name, fn, rad, sMin, sMax, dMin, dMax, side = 0, maxRelief = 2.2) {
    for (let tries = 0; tries < 24; tries++) {
      if (sl && sl()) yield;
      const s = rr(sMin, sMax), sdd = side || (Rn() < 0.5 ? 1 : -1), d = sdd * (edge + rr(dMin, dMax));
      if (seaSide(d) && name !== 'billboard') continue;
      if (!clear(s, d, rad * 0.45)) continue;
      const [x, z, yaw] = at(s, d);
      if (seaSide(d)) { track.toTrack(x, z, s, tt); if (ground(tt.s, tt.d, x, z) < terrain.seaY + 1.5) continue; }
      const [y, relief] = flatY(x, z, s, d, rad * 0.5);
      if (relief > maxRelief) continue;
      const b = B(s);
      b.set(x, y + 0.02, z, yaw + (d > 0 ? Math.PI / 2 : -Math.PI / 2));
      // foundation skirt so slopes never show a gap
      b.box(Math.min(rad, 14), relief + 1.1, Math.min(rad * 0.8, 12), 0, (0.1 - relief - 1) / 2, 0, MAT.concrete, MAT.concrete, [0.55, 0.52, 0.48]);
      fn(b, name);
      count++; kinds[name] = (kinds[name] || 0) + 1; placed.push({ name, s });
      return true;
    }
    return false;
  };
  const along = function* (n, sMin, sMax, f) { for (let i = 0; i < n; i++) yield* f(sMin + (sMax - sMin) * (i + Rn() * 0.8) / n); };
  const rg = [60, L - 80];

  // ---- per-theme landmarks
  const bb = (kind) => (b) => R.billboard(b, kind);
  if (K === 'oaks') {
    yield* along(3, rg[0] + 200, rg[1], (s) => place('farm', R.farm, 34, s - 120, s + 120, 22, 60, 0, 3));
    yield* along(2, rg[0], rg[1], (s) => place('billboard', bb(Rn() < 0.5 ? 'cola' : 'farm'), 12, s - 150, s + 150, 12, 26));
    yield* along(7, rg[0], rg[1], (s) => place('hay', (b) => { for (let i = 0; i < 6; i++) bale(b, (i % 3) * 2.1 - 2, Math.floor(i / 3) * 2.1); }, 6, s - 80, s + 80, 8, 26));
    yield* along(2, rg[0] + 300, rg[1], (s) => place('rest', R.rest, 16, s - 200, s + 200, 14, 30, 0, 1.2));
  } else if (K === 'pines') {
    yield* along(3, rg[0] + 200, rg[1], (s) => place('cabin', R.cabin, 10, s - 140, s + 140, 14, 55, 0, 3));
    yield* along(2, rg[0] + 400, rg[1], (s) => place('rest', R.rest, 16, s - 200, s + 200, 14, 32, 0, 1.4));
    yield* along(1, rg[0] + 400, rg[1], (s) => place('billboard', bb('motors'), 12, s - 200, s + 200, 12, 24));
  } else if (K === 'redwoods') {
    yield* along(2, rg[0] + 200, rg[1], (s) => place('cabin', R.cabin, 10, s - 140, s + 140, 12, 40, 0, 3));
    yield* along(1, rg[0] + 500, rg[1], (s) => place('rest', R.rest, 16, s - 200, s + 200, 14, 28, 0, 1.4));
    yield* along(5, rg[0], rg[1], (s) => place('logs', (b) => { for (let i = 0; i < 8; i++) b.cyl(0.35, 3.2, (i % 4) * 0.7 - 1, 0.35 + Math.floor(i / 4) * 0.62, 0, 8, MAT.plank, [0.85, 0.6, 0.45]); }, 4, s - 80, s + 80, 7, 20));
  } else if (K === 'palms') {
    yield* along(1, rg[0] + 400, rg[1] - 300, (s) => place('gas', R.gas, 24, s - 100, s + 100, 16, 40, -1, 1.5));
    yield* along(1, rg[0] + 900, rg[1], (s) => place('diner', R.diner, 20, s - 100, s + 100, 16, 40, -1, 1.5));
    yield* along(3, rg[0], rg[1], (s) => place('billboard', bb(Rn() < 0.5 ? 'inn' : 'resort'), 12, s - 150, s + 150, 12, 28, -1));
    yield* along(2, rg[0], rg[1], (s) => place('hay', (b) => { b.box(1.8, 1, 1.8, 0, 0.5, 0, MAT.stucco, MAT.stucco); b.box(2.2, 0.4, 2.2, 0, 1.2, 0, MAT.tin, MAT.tin, [0.4, 0.55, 0.7]); }, 3, s - 100, s + 100, 7, 20, -1));
  } else {   // cactus / desert
    yield* along(1, rg[0] + 300, rg[1] - 400, function* (s) { yield* place('gas', R.gas, 24, s - 100, s + 100, 16, 40, 0, 1.6); yield* place('diner', R.diner, 20, s + 40, s + 110, 16, 44, 0, 1.6); });
    yield* along(2, rg[0], rg[1], (s) => place('tower', R.tower, 6, s - 150, s + 150, 14, 50, 0, 2.5));
    yield* along(4, rg[0], rg[1], (s) => place('windpump', R.windpump, 5, s - 150, s + 150, 12, 55, 0, 2.5));
    yield* along(3, rg[0], rg[1], (s) => place('billboard', bb(['resort', 'bbq', 'cola'][Math.floor(Rn() * 3)]), 12, s - 150, s + 150, 12, 28));
  }
  yield;
  if (sl && sl()) yield;
  // mailboxes beside farms / cabins: a few along any road
  yield* along(5, rg[0], rg[1], (s) => place('mailbox', mailbox, 1, s - 60, s + 60, 2.6, 4.5, 0, 0.6));

  // ---- readable road signs: curve warnings before sharp bends, speed limits, distance boards, deer / rock warnings
  const E = track.edges;
  const signAt = (s, d, rect, w, h, mount = 2.3, flip = false) => {
    if (s < 30 || s > L - 30) return;
    const [x, z, yaw] = at(s, d); track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z);
    if (Math.abs(tt.d) < edge + 0.5) return;
    const b = B(s); b.set(x, y, z, yaw);   // local +z along -heading? face the oncoming rider: local +z = backwards along the road
    b.cyl(0.04, mount + h / 2, 0, 0, 0, 5, MAT.tin, [0.8, 0.8, 0.8]);
    if (w > 1.6) { b.cyl(0.04, mount + h / 2, w * 0.4, 0, 0, 5, MAT.tin, [0.8, 0.8, 0.8]); }
    const cy = mount + h / 2;
    b.quad([-w / 2, cy - h / 2, 0.06], [w / 2, cy - h / 2, 0.06], [w / 2, cy + h / 2, 0.06], [-w / 2, cy + h / 2, 0.06], rect, [1, 1, 1], flip);
    b.box(w * 0.98, h * 0.98, 0.04, 0, cy, 0.02, MAT.tin, MAT.tin, [0.55, 0.55, 0.55]);
  };
  {
    let i = 0, nsig = 0;
    while (i < E.n) {
      if (Math.abs(E.curve[i]) > 1 / 260) {
        const k = E.curve[i]; let j = i; while (j < E.n && Math.abs(E.curve[j]) > 1 / 260) j++;
        const s = Math.max(20, i * E.step - 70);
        // curve sign on the side the bend turns away from, mirrored for right-hand bends (k>0 = left)
        signAt(s, -(edge + 1.7), SIGN.curve, 1.0, 1.0, 2.0, k < 0);
        if (nsig % 3 === 0) signAt(s - 60, -(edge + 1.7), Rn() < 0.5 ? SIGN.speed45 : SIGN.speed65, 0.8, 0.8, 1.9);
        nsig++; i = j + 30;
      } else i++;
    }
  }
  const boards = K === 'palms' ? ['pelican', 'inn'] : K === 'cactus' ? ['dry', 'resort'] : K === 'redwoods' ? ['fern', 'alder'] : K === 'pines' ? ['alder', 'fern'] : ['alder', 'dry'];
  for (let k = 0; k < 4; k++) signAt(rg[0] + 300 + k * (L - 500) / 4 + rr(-60, 60), -(edge + 3.2), SIGN[boards[k % 2]], 3.6, 1.8, 2.6);
  signAt(120, edge + 1.8, SIGN.speed65, 0.8, 0.8, 1.9); signAt(L * 0.55, -(edge + 1.8), SIGN.speed45, 0.8, 0.8, 1.9);
  if (K === 'redwoods' || K === 'pines' || K === 'oaks') { signAt(L * 0.3, -(edge + 1.8), SIGN.deer, 0.9, 0.9, 1.9); }
  if (K === 'pines' || K === 'cactus') signAt(L * 0.62, edge + 1.8, SIGN.rock, 0.9, 0.9, 1.9);
  yield;

  // ---- tyre marks before sharp bends (dark ribbons on the outer part of the lane)
  {
    const nb = 0;
    let i = 0, marks = 0;
    while (i < E.n && marks < 12) {
      if (Math.abs(E.curve[i]) > 1 / 200) {
        const k = E.curve[i]; let j = i; while (j < E.n && Math.abs(E.curve[j]) > 1 / 200) j++;
        const s0 = i * E.step - 26;
        for (const d0 of [-2.5, -1.6]) {
          const b = B(s0); b.set(0, 0, 0, 0);
          let prev = null;
          for (let q = 0; q <= 12; q++) {
            const s = s0 + q * 1.8, d = d0 + (k > 0 ? 1 : -1) * q * 0.045 + Math.sin(q * 0.9 + d0) * 0.04;
            track.sampleAt(s, P);
            const lx = P.hz, lz = -P.hx, w = 0.11;
            const y = terrain.edgeY(s, d) + 0.035;
            const a = [P.x + lx * (d - w), y, P.z + lz * (d - w)], c = [P.x + lx * (d + w), y, P.z + lz * (d + w)];
            if (prev) b.quad(prev[0], prev[1], c, a, WHITE, [0.03, 0.03, 0.035]);
            prev = [a, c];
          }
        }
        marks++; i = j + 60;
      } else i++;
    }
  }
  // ---- telephone poles with sagging wires on one side
  {
    const side = K === 'palms' ? -1 : 1, d = side * (edge + 3.4), span = 42;
    let prevTop = null;
    for (let s = 20; s < L - 20; s += span) {
      if (K === 'redwoods' && vnoise(s / 300, 5, seed) > 0.4) { prevTop = null; continue; }
      const [x, z, yaw] = at(s, d);
      if (!clear(s, d, 0.6)) { prevTop = null; continue; }
      track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z);
      const b = B(s); b.set(x, y - 0.1, z, yaw);
      b.cyl(0.14, 8.8, 0, 0, 0, 6, MAT.plank, [0.75, 0.6, 0.5], 0.11, false);
      b.box(2.0, 0.12, 0.12, 0, 8.4, 0, MAT.plank, MAT.plank, [0.6, 0.5, 0.4]); b.box(1.3, 0.1, 0.1, 0, 7.6, 0, MAT.plank, MAT.plank, [0.6, 0.5, 0.4]);
      for (const ix of [-0.9, 0, 0.9]) b.box(0.1, 0.16, 0.1, ix, 8.52, 0, SIGN.white, SIGN.white, [0.3, 0.5, 0.45]);
      const tops = [[-0.9, 8.55], [0, 8.55], [0.9, 8.55]].map(([lx, ly]) => [x + lx * Math.cos(yaw), y + ly - 0.1, z - lx * Math.sin(yaw)]);
      if (prevTop && Math.hypot(tops[0][0] - prevTop[0][0], tops[0][2] - prevTop[0][2]) < span * 1.5) {
        const bw = B(s);
        for (let w = 0; w < 3; w++) {
          const a = prevTop[w], c = tops[w]; bw.set(0, 0, 0, 0); let pv = a;
          for (let q = 1; q <= 5; q++) { const t = q / 5, sag = 4 * 0.9 * t * (1 - t); const pt = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t - sag, a[2] + (c[2] - a[2]) * t]; bw.wire(pv, pt, 0.025, [0.05, 0.05, 0.05]); pv = pt; }
        }
      }
      prevTop = tops;
      if (sl && sl()) yield;
    }
  }
  yield;
  // ---- overpass (visual only; piers outside paved width + shoulder + 6 m) where the road is straight and flat
  {
    let placed = 0;
    for (let s = L * 0.25; s < L * 0.9 && placed < (K === 'cactus' || K === 'pines' || K === 'oaks' ? 1 : 0); s += 20) {
      const i = Math.round(s / E.step); let ok = true;
      for (let k = -8; k <= 8; k++) { const j = i + k; if (j < 0 || j >= E.n || Math.abs(E.curve[j]) > 1 / 900 || Math.abs(E.cy[j] - E.cy[i]) > 1.2) ok = false; }
      if (!ok || seaSide(1)) continue;
      track.sampleAt(s, P); const px = P.x, pz = P.z, py = P.y, yaw = P.yaw;
      const half = edge + 7, ddk = half;
      const b = B(s); const lx = P.hz, lz = -P.hx;
      b.set(px, py, pz, yaw);
      const deckY = 7.2;
      b.box(2 * half + 4, 1.1, 9, 0, deckY, 0, MAT.concrete, MAT.concrete, [0.85, 0.85, 0.85]);
      b.box(2 * half + 4, 0.9, 0.3, 0, deckY + 1.0, 4.4, MAT.concrete, MAT.concrete, [0.95, 0.95, 0.95]); b.box(2 * half + 4, 0.9, 0.3, 0, deckY + 1.0, -4.4, MAT.concrete, MAT.concrete, [0.95, 0.95, 0.95]);
      for (const sg of [-1, 1]) {
        const x = sg * ddk, gx = px + lx * x, gz = pz + lz * x; track.toTrack(gx, gz, s, tt);
        const gy = ground(tt.s, tt.d, gx, gz) - py; const ph = deckY - gy;
        b.box(2.2, ph + 0.4, 8, x, gy + (ph + 0.4) / 2 - 0.2, 0, MAT.concrete, MAT.concrete, [0.7, 0.68, 0.65]);
      }
      placed++; count++; kinds.overpass = (kinds.overpass || 0) + 1;
    }
  }
  // ---- cones on the shoulder (road works)
  if (K === 'palms' || K === 'oaks' || K === 'cactus') {
    const s0 = L * rr(0.35, 0.7);
    for (let q = 0; q < 7; q++) {
      const s = s0 + q * 3.5, d = (edge - 0.9) * (K === 'palms' ? -1 : 1) - 0.0;
      const [x, z, yaw] = at(s, d); const y = terrain.edgeY(s, d);
      const b = B(s); b.set(x, y, z, yaw); b.cyl(0.18, 0.7, 0, 0, 0, 8, SIGN.white, [1, 0.45, 0.1], 0.04); b.cyl(0.19, 0.12, 0, 0.34, 0, 8, SIGN.white, [1, 1, 1], 0.17, false);
      b.box(0.4, 0.04, 0.4, 0, 0.02, 0, WHITE, WHITE, [1, 0.45, 0.1]);
    }
    kinds.cones = 7;
  }
  // ---- animals behind fences / at the forest edge
  const herd = (kind, n, sMin, sMax, dMin, dMax, tone) => {
    for (let h = 0; h < n; h++) {
      const s = rr(sMin, sMax), sgn = Rn() < 0.5 ? 1 : -1, d0 = sgn * (edge + rr(dMin, dMax));
      if (!clear(s, d0, 10) || seaSide(d0)) continue;
      const cnt = 3 + Math.floor(Rn() * 3);
      for (let a = 0; a < cnt; a++) {
        const s2 = s + rr(-10, 10), d = d0 + rr(-6, 6) * sgn;
        if (!clear(s2, d, 2)) continue;
        const [x, z, yaw] = at(s2, d); track.toTrack(x, z, s2, tt); const y = ground(tt.s, tt.d, x, z);
        const b = B(s2); b.set(x, y, z, yaw);
        const col = tone[Math.floor(Rn() * tone.length)];
        cow(b, 0, 0, rr(0, 6.28), col, kind === 'horse', kind === 'deer');
      }
      kinds[kind] = (kinds[kind] || 0) + cnt;
    }
  };
  if (K === 'oaks') { herd('cow', 7, rg[0], rg[1], 6, 18, [[0.2, 0.15, 0.12], [0.9, 0.88, 0.82], [0.45, 0.28, 0.16]]); herd('horse', 3, rg[0], rg[1], 6, 18, [[0.4, 0.26, 0.14], [0.15, 0.12, 0.1], [0.7, 0.55, 0.35]]); }
  if (K === 'redwoods' || K === 'pines') herd('deer', 6, rg[0], rg[1], 6, 20, [[0.55, 0.38, 0.22], [0.5, 0.35, 0.25]]);
  yield;
  // ---- start / finish: crowd behind barriers, flags, hay-bale chicane
  {
    const crowd = (s0, s1) => {
      for (const sgn of [1, -1]) {
        for (let s = s0; s < s1; s += 1.1) {
          const d = sgn * (edge + 5.2 + Rn() * 1.6); const [x, z, yaw] = at(s + Rn() * 0.5, d); track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z);
          const b = B(s); b.set(x, y, z, yaw); const hue = [[0.8, 0.2, 0.2], [0.2, 0.4, 0.8], [0.9, 0.8, 0.2], [0.2, 0.6, 0.35], [0.85, 0.85, 0.85], [0.6, 0.3, 0.6]][Math.floor(Rn() * 6)];
          const h = 1.55 + Rn() * 0.3;
          b.cyl(0.22, h - 0.45, 0, 0, 0, 6, WHITE, hue, 0.2, false); b.box(0.22, 0.22, 0.22, 0, h - 0.16, 0, WHITE, WHITE, [0.85, 0.65, 0.5]);
          if (Rn() < 0.12) { b.box(0.05, 0.6, 0.05, 0.3, h + 0.2, 0, WHITE, WHITE, [0.3, 0.3, 0.3]); }
        }
        // barrier + flags
        for (let s = s0; s < s1; s += 3) {
          const d = sgn * (edge + 3.8); const [x, z, yaw] = at(s, d); track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z);
          const b = B(s); b.set(x, y, z, yaw); b.box(0.3, 0.8, 3, 0, 0.4, 0, MAT.concrete, MAT.concrete, [0.95, 0.95, 0.95]);
          if (((s - s0) / 3 | 0) % 3 === 0) { b.cyl(0.03, 4, 0, 0.8, 0, 4, MAT.tin, [0.7, 0.7, 0.7]); b.quad([0, 4.2, 0], [0, 4.2, 1.1], [0, 4.8, 1.1], [0, 4.8, 0], WHITE, [[0.85, 0.12, 0.12], [0.95, 0.95, 0.95], [0.1, 0.1, 0.1]][((s - s0) / 9 | 0) % 3]); }
        }
        for (let s = s0 + 20; s < s0 + 44; s += 4) {
          const d = sgn * (edge - 0.2); const [x, z, yaw] = at(s, d); const y = terrain.edgeY(s, d);
          const b = B(s); b.set(x, y, z, yaw); bale(b, 0, 0); bale(b, 0, 1.7);
        }
      }
    };
    crowd(8, 60); crowd(track.finishS - 40, track.finishS + 18);
  }
  // ---- coast: town skyline across the land side in the distance
  if (K === 'palms') {
    const s = L * 0.72, d0 = -(edge + 170); const [x, z, yaw] = at(s, d0);
    track.toTrack(x, z, s, tt); const y = ground(tt.s, tt.d, x, z);
    const b = farB; b.set(x, y, z, yaw);
    for (let i = 0; i < 22; i++) {
      const bx = (i - 11) * 11 + rr(-3, 3), bz = rr(-18, 18), w = rr(8, 14), h = rr(9, 34) * (1 - Math.abs(i - 11) / 16), dd = rr(8, 14);
      track.toTrack(x + bx * Math.cos(yaw), z - bx * Math.sin(yaw), s, tt);
      const tone = [[1, 0.95, 0.88], [0.95, 0.9, 0.82], [0.85, 0.9, 0.95], [1, 0.85, 0.75]][i % 4];
      b.box(w, h + 3, dd, bx, h / 2 - 1, bz, [MAT.glass, MAT.stucco, MAT.glass, MAT.stucco], MAT.concrete, tone);
    }
    kinds.skyline = 22;
  }

  // ---- assemble: one merged mesh per bucket
  const atlas = propsAtlas(quality);
  const mat = patchMaterial(lowQ ? new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true }) : new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.78, metalness: 0.05, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 'props' + (lowQ ? 'L' : ''), null);
  if (lowQ) { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; }
  const group = new THREE.Group(); const chunks = []; let tris = 0;
  for (const [k, b] of buckets) {
    if (!b.i.length) continue;
    const m = new THREE.Mesh(b.build(), mat); m.frustumCulled = true; tris += b.tris;
    group.add(m); chunks.push({ m, s0: k * BUCKET - 60, s1: (k + 1) * BUCKET + 60 });
    if (sl && sl()) yield;
  }
  let farMesh = null;
  if (farB.i.length) { farMesh = new THREE.Mesh(farB.build(), mat); farMesh.frustumCulled = false; group.add(farMesh); tris += farB.tris; }
  function update(camS, ahead, back) { for (const c of chunks) c.m.visible = c.s1 > camS - back && c.s0 < camS + ahead; }
  function dispose() { for (const c of chunks) c.m.geometry.dispose(); if (farMesh) farMesh.geometry.dispose(); mat.dispose(); }
  return { group, update, dispose, counts: () => ({ props: count, kinds, tris, chunks: chunks.length }), list: placed, material: mat, textures: [atlas] };
}
