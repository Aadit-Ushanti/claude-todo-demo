// Environment texture sets shipped as WebP (assets/env/*): ground materials (albedo + normal/roughness), road, props atlas.
// Three size tiers per set, chosen by the renderer's quality tier: high 2k albedo / 1k normal, medium 1k / 512, low 512 / 256.
// Textures are created immediately (1x1 placeholder of the material's mean colour) and swapped for the real image when it has decoded.
import * as THREE from '../../public/vendor/three.module.min.js';

const BASE = new URL('../../assets/env/', import.meta.url).href;
export const TIER = {
  high:   { a: '2k', n: '1k', road: '2k', roadN: '2k', detail: '1k', macro: '1k', grime: '1k', props: '2k' },
  medium: { a: '1k', n: '512', road: '1k', roadN: '1k', detail: '512', macro: '1k', grime: '1k', props: '1k' },
  low:    { a: '512', n: '256', road: '512', roadN: '512', detail: '256', macro: '512', grime: '512', props: '512' },
};
/** Mean sRGB colour of each ground material (tints are computed relative to these). */
export const MEAN = {
  grass: [0.436, 0.544, 0.206], dry_grass: [0.73, 0.657, 0.427], forest_floor: [0.502, 0.435, 0.357], sand: [0.756, 0.671, 0.503],
  coast_scrub: [0.72, 0.652, 0.488], cracked_earth: [0.623, 0.44, 0.279], rock: [0.475, 0.443, 0.396], gravel: [0.486, 0.453, 0.401],
};
/** Four ground layers per theme: A main, B alternate, C verge / gravel, D rock. */
export const LAYERS = {
  pines: ['forest_floor', 'dry_grass', 'gravel', 'rock'],
  palms: ['sand', 'coast_scrub', 'gravel', 'rock'],
  redwoods: ['forest_floor', 'grass', 'gravel', 'rock'],
  cactus: ['sand', 'cracked_earth', 'gravel', 'rock'],
  oaks: ['grass', 'dry_grass', 'gravel', 'rock'],
};

const cache = new Map();
const owned = new Set();
const ph = (rgb) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.fillStyle = `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`; g.fillRect(0, 0, 1, 1); return c; };

/** Texture that loads `file` asynchronously. userData.ready resolves when the image is in. */
function tex(file, { srgb = false, rgb = [0.5, 0.5, 1], aniso = 4, repeat = true } = {}) {
  const key = file + (srgb ? ':s' : '');
  let t = cache.get(key); if (t) return t;
  t = new THREE.Texture(ph(rgb));
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
  t.userData.file = file; t.userData.loaded = false;
  t.userData.ready = new Promise((res) => {
    const im = new Image();
    im.onload = () => { (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => { t.dispose(); t.image = im; t.needsUpdate = true; t.userData.loaded = true; res(t); }); };
    im.onerror = () => { console.warn('env texture failed', file); res(t); };
    im.src = BASE + file;
  });
  cache.set(key, t); owned.add(t);
  return t;
}

/** One ground material at a tier: {a: albedo (sRGB), n: normal xyz + roughness alpha}. */
export function groundMat(name, q) {
  const T = TIER[q];
  return { name, a: tex(`ground/${name}_a_${T.a}.webp`, { srgb: true, rgb: MEAN[name], aniso: 8 }), n: tex(`ground/${name}_n_${T.n}.webp`, { aniso: 8 }) };
}
export const macroTex = (q) => tex(`ground/macro_${TIER[q].macro}.webp`, { rgb: [0.5, 0.5, 0.5], aniso: 1 });
export function roadSet(q) {
  const T = TIER[q];
  return {
    map: tex(`road/road_macro_${T.road}.webp`, { srgb: true, rgb: [0.27, 0.27, 0.29], aniso: 16, repeat: true }),
    normal: tex(`road/road_macro_n_${T.roadN}.webp`, { aniso: 16 }),
    detail: tex(`road/road_detail_${T.detail}.webp`, { aniso: 8 }),
    grime: tex(`road/road_grime_${T.grime}.webp`, { rgb: [0.5, 0.5, 0.5], aniso: 2 }),
  };
}
export const propsAtlas = (q) => tex(`props/props_atlas_${TIER[q].props}.webp`, { srgb: true, rgb: [0.6, 0.6, 0.6], aniso: 8, repeat: false });
let _json = null;
export function propsUV() { return _json || (_json = fetch(BASE + 'props/props_atlas.json').then((r) => r.json())); }

/** All textures a theme needs at this tier (for preloading and GPU upload). */
export function themeTextures(roadside, q) {
  const out = [roadSet(q).map, ...Object.values(roadSet(q)).slice(1), propsAtlas(q)];
  if (q !== 'low') out.push(macroTex(q));
  const L = (LAYERS[roadside] || LAYERS.pines).slice();
  for (let i = 0; i < 4; i++) { const g = groundMat(L[i], q); out.push(g.a); if (q !== 'low' && (i === 0 || (i === 3 && q === 'high'))) out.push(g.n); }
  return [...new Set(out)];
}
export const themeReady = (roadside, q) => Promise.all(themeTextures(roadside, q).map((t) => t.userData.ready));
/** Frees GPU copies of textures that are not in `keep` (they re-upload on next use). */
export function evict(keep) { const k = new Set(keep); for (const t of owned) if (!k.has(t) && t.userData.loaded) t.dispose(); }
/** Drops every cached texture (tier change). */
export function clearEnvTextures() { for (const t of owned) t.dispose(); owned.clear(); cache.clear(); }
/** GPU memory estimate (MB, with mipmaps) for textures that have an image loaded. */
export function memoryMB(textures) { let b = 0; for (const t of textures) { const im = t.image; if (im && im.width > 1) b += im.width * im.height * 4 * 1.34; } return b / 1048576; }

/** Linear tint that maps a material's mean colour to a theme target colour (hex), softened so texture detail survives. */
export function tintFor(name, hex, k = 0.75) {
  const m = MEAN[name], t = new THREE.Color(hex);
  const lin = (c) => Math.pow(Math.max(c, 1e-3), 2.2);
  t.lerp(new THREE.Color(lin(m[0]), lin(m[1]), lin(m[2])), 0.5);   // keep half of the texture's natural colour so a neutral theme colour does not bleach or blue-shift it
  const r = [t.r / lin(m[0]), t.g / lin(m[1]), t.b / lin(m[2])];   // THREE.Color is already linear
  const avg = (r[0] + r[1] + r[2]) / 3;
  return r.map((v) => Math.min(2.4, Math.max(0.3, Math.pow(v / Math.max(avg, 1e-3), 0.9) * Math.pow(avg, k))));
}
