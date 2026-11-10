// Shared helpers for the renderer: deterministic noise/RNG and a tiny merged-geometry builder.
import * as THREE from '../../public/vendor/three.module.min.js';
import { mergeGeometries } from '../../public/vendor/BufferGeometryUtils.js';
import { fogPatch } from './Look.js';

/** Time-slice bookkeeping for generator-based builds: async drivers set SLICE.t after every wait so a slice is measured from the resume. */
export const SLICE = { t: 0 };
export function slicer(ms = 7) { let t0 = performance.now(); return () => { const n = performance.now(); if (n - Math.max(t0, SLICE.t) > ms) { t0 = n; return true; } return false; }; }

/** Smoothstep clamp 0..1. */
export const ss = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** mulberry32 seeded RNG. */
export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1). */
export function vnoise(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in [0,1). */
export function fbm(x, z, seed = 0, oct = 3) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, z, seed + i * 31);
    n += a;
    x = x * 2.03 + 11.7; z = z * 2.03 - 5.3; a *= 0.5;
  }
  return s / n;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Builds one merged BufferGeometry from primitives, with vertex colours (linear) and an
 * `aMask` attribute (0 plain, 1 paint, 2 suit, 3 helmet, 4 head-light glow, 5 tail-light glow).
 */
export class Mesher {
  constructor() { this.parts = []; }
  /** Global segment multiplier for curved primitives (higher = smoother silhouettes). */
  static detail = 1;

  /** Adds a unit geometry transformed by `m`, coloured `color` (hex), optional vertical gradient to opt.top between y0..y1. */
  add(geo, m, color, mask = 0, opt = null) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.deleteAttribute('uv');
    g.applyMatrix4(m);
    const pos = g.attributes.position;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    _c.set(color);
    if (opt && opt.top !== undefined) _c2.set(opt.top);
    for (let i = 0; i < n; i++) {
      if (opt && opt.top !== undefined) {
        const t = clamp((pos.getY(i) - opt.y0) / (opt.y1 - opt.y0), 0, 1);
        col[i * 3] = lerp(_c.r, _c2.r, t); col[i * 3 + 1] = lerp(_c.g, _c2.g, t); col[i * 3 + 2] = lerp(_c.b, _c2.b, t);
      } else { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(n).fill(mask), 1));
    this.parts.push(g);
    return this;
  }

  /** Box w,h,d centred at p=[x,y,z], rotated by r=[rx,ry,rz]. */
  box(w, h, d, p, color, mask = 0, r = null, opt = null) {
    _m.compose(_v.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0)), _s.set(1, 1, 1));
    return this.add(new THREE.BoxGeometry(w, h, d), _m, color, mask, opt);
  }

  /** Ellipsoid with radii rx,ry,rz. */
  sph(rx, ry, rz, p, color, mask = 0, r = null, ws = 8, hs = 6, opt = null) {
    _m.compose(_v.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0)), _s.set(rx, ry, rz));
    return this.add(new THREE.SphereGeometry(1, Math.max(5, Math.round(ws * Mesher.detail)), Math.max(4, Math.round(hs * Mesher.detail))), _m, color, mask, opt);
  }

  /** Low-poly icosahedron blob. */
  ico(rx, ry, rz, p, color, detail = 0, r = null, opt = null) {
    _m.compose(_v.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0)), _s.set(rx, ry, rz));
    return this.add(new THREE.IcosahedronGeometry(1, detail), _m, color, 0, opt);
  }

  /** Tapered cylinder from p0 (radius r0) to p1 (radius r1). */
  cyl(r0, r1, p0, p1, color, mask = 0, seg = 6, open = false, opt = null) {
    _v.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const len = _v.length();
    if (len < 1e-6) return this;
    _q.setFromUnitVectors(UP, _v.multiplyScalar(1 / len));
    _v2.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
    _m.compose(_v2, _q, _s.set(1, 1, 1));
    return this.add(new THREE.CylinderGeometry(r1, r0, len, Math.max(4, Math.round(seg * Mesher.detail)), 1, open), _m, color, mask, opt);
  }

  /** Torus with the axis along X. */
  torusX(R, r, p, color, mask = 0, seg = 14, tube = 5) {
    _m.compose(_v.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(0, Math.PI / 2, 0)), _s.set(1, 1, 1));
    return this.add(new THREE.TorusGeometry(R, r, Math.max(3, Math.round(tube * Mesher.detail)), Math.max(6, Math.round(seg * Mesher.detail))), _m, color, mask);
  }

  /** Merges everything. */
  build() {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return g;
  }
}

/**
 * Patches a Standard material so aMask selects a per-material tint, glow and PBR response:
 * 1 paint (candy metallic), 2 suit (leather), 3 helmet (gloss), 4 head-light glow, 5 tail-light glow, 6 glass, 7 chrome,
 * 0 plain (chrome / rubber / dark metal picked from the baked colour). Returns the uniforms ({uPaint,uSuit,uHelm}) so callers can recolour.
 */
export function patchMasked(mat, paint = 0xffffff, suit = 0xffffff, helm = 0xffffff) {
  const u = { uPaint: { value: new THREE.Color(paint) }, uSuit: { value: new THREE.Color(suit) }, uHelm: { value: new THREE.Color(helm) } };
  mat.onBeforeCompile = (sh) => {
    fogPatch(sh);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMask;\nvarying float vMask;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvMask = aMask;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMask;\nuniform vec3 uPaint;\nuniform vec3 uSuit;\nuniform vec3 uHelm;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vMask > 0.5 && vMask < 1.5) diffuseColor.rgb *= uPaint;
        else if (vMask > 1.5 && vMask < 2.5) diffuseColor.rgb *= uSuit;
        else if (vMask > 2.5 && vMask < 3.5) diffuseColor.rgb *= uHelm;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float lumP = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        float chrP = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
        float kChrome = (vMask < 0.5) ? smoothstep(0.30, 0.5, lumP) * (1.0 - smoothstep(0.05, 0.12, chrP)) : 0.0;
        float kRubber = (vMask < 0.5) ? (1.0 - smoothstep(0.012, 0.03, lumP)) : 0.0;
        float kGlass = (vMask > 5.5 && vMask < 6.5) ? 1.0 : 0.0;
        float kChromeM = (vMask > 6.5) ? 1.0 : 0.0;
        if (vMask > 0.5 && vMask < 1.5) roughnessFactor = 0.3;
        else if (vMask > 1.5 && vMask < 2.5) roughnessFactor = 0.52;
        else if (vMask > 2.5 && vMask < 3.5) roughnessFactor = 0.2;
        else if (vMask < 0.5) roughnessFactor = mix(mix(0.5, 0.2, kChrome), 0.85, kRubber);
        roughnessFactor = mix(roughnessFactor, 0.07, kGlass); roughnessFactor = mix(roughnessFactor, 0.18, kChromeM);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (vMask > 0.5 && vMask < 1.5) metalnessFactor = 0.32;
        else if (vMask > 1.5 && vMask < 2.5) metalnessFactor = 0.0;
        else if (vMask > 2.5 && vMask < 3.5) metalnessFactor = 0.12;
        else if (vMask < 0.5) metalnessFactor = mix(mix(0.45, 0.95, kChrome), 0.0, kRubber);
        metalnessFactor = mix(metalnessFactor, 0.9, kGlass); metalnessFactor = mix(metalnessFactor, 0.95, kChromeM);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vMask > 3.5 && vMask < 4.5) totalEmissiveRadiance += vec3(1.0, 0.93, 0.75) * 0.9;
        else if (vMask > 4.5 && vMask < 5.5) totalEmissiveRadiance += vec3(1.0, 0.08, 0.04) * 0.8;`);
  };
  mat.customProgramCacheKey = () => 'masked2';
  return u;
}
