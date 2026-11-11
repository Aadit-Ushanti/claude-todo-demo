// Pooled traffic car meshes from assets/models/traffic_*.glb, box fallback until loaded, additive light glows.
import * as THREE from '../../public/vendor/three.module.min.js';
import { GLTFLoader } from '../../public/vendor/GLTFLoader.js';
import { mergeGeometries } from '../../public/vendor/BufferGeometryUtils.js';
import { patchMasked, MODEL_SCALE } from './util.js';
import { makeGlowTex } from './Look.js';

const URL_OF = (t) => new URL(`../../assets/models/traffic_${t}.glb`, import.meta.url).href;
const TYPES = ['sedan', 'kei', 'hatch', 'coupe', 'taxi', 'minivan', 'suv', 'van', 'truck', 'bus'];
const PAINTS = [0xc43b32, 0x2e5fa8, 0xdfe3e8, 0x2a2d33, 0x3d8b5a, 0xd6a021, 0x7d8590, 0x8c3b6b, 0xe8e2d2, 0x1f6f78];
const FIXED = { taxi: 0xf2c400, bus: 0x1e5aa8, truck: 0xe6e6e6 };
const LIGHT_Y = { truck: 0.85, bus: 0.8, van: 0.8, minivan: 0.7 };
// fallback box dimensions (w, h, len)
const BOX = { sedan: [1.9, 1.4, 4.7], kei: [1.6, 1.7, 3.4], hatch: [1.85, 1.5, 4.1], coupe: [1.9, 1.3, 4.5], taxi: [1.85, 1.8, 4.4], minivan: [1.95, 1.9, 5.0], suv: [2.0, 1.7, 4.8], van: [1.85, 1.95, 4.7], truck: [2.9, 3.6, 9.6], bus: [3.0, 3.4, 11] };

/** Creates the traffic renderer. */
export function createTraffic(scene, shadow, camera) {
  const assets = {}; // type -> { geo, hw, minZ, maxZ }
  const matsByPaint = new Map();
  function paintMat(hex) {
    let m = matsByPaint.get(hex);
    if (!m) { m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1, envMapIntensity: 1.2 }); patchMasked(m, hex); matsByPaint.set(hex, m); }
    return m;
  }
  const fallbackGeo = {};
  for (const t of TYPES) {
    const [w, h, l] = BOX[t];
    const g = new THREE.BoxGeometry(w, h, l).translate(0, h / 2, 0);
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    g.deleteAttribute('uv');
    fallbackGeo[t] = { geo: g, hw: w / 2, minZ: -l / 2, maxZ: l / 2 };
  }
  let tq = 'high';
  const pools = {}; for (const t of TYPES) pools[t] = [];
  const active = []; // {car mesh entries}
  const byId = new Map();
  let frame = 1;

  function load(t) {
    new GLTFLoader().load(URL_OF(t), (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3), mask = new Float32Array(n);
        const vc = g.attributes.color;
        const nm = mat.name;
        const m = nm === 'paint' ? 1 : nm === 'head' ? 4 : nm === 'tail' ? 5 : nm === 'glass' ? 6 : (nm === 'chrome' || nm === 'rim') ? 7 : 0;
        for (let i = 0; i < n; i++) {
          const r = vc ? vc.getX(i) : 1, gg = vc ? vc.getY(i) : 1, b = vc ? vc.getZ(i) : 1;
          if (m === 1) { col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b; }
          else { col[i * 3] = r * mat.color.r; col[i * 3 + 1] = gg * mat.color.g; col[i * 3 + 2] = b * mat.color.b; }
          mask[i] = m;
        }
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('aMask', new THREE.BufferAttribute(mask, 1));
        parts.push(g.index ? g.toNonIndexed() : g);
      });
      if (!parts.length) return;
      const geo = mergeGeometries(parts);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      assets[t] = { geo, hw: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z };
      for (const e of pools[t]) e.mesh.geometry = geo;
      for (const e of active) if (e.type === t) e.mesh.geometry = geo;
    }, undefined, () => {});
  }
  for (const t of TYPES) load(t);

  // light glows: 4 quads per car
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const GCAP = 160;
  const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), GCAP);
  glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  glow.setColorAt(0, new THREE.Color(1, 1, 1));
  glow.instanceColor.setUsage(THREE.DynamicDrawUsage);
  glow.frustumCulled = false; glow.count = 0; glow.renderOrder = 3;
  scene.add(glow);

  function acquire(car) {
    const t = TYPES.includes(car.type) ? car.type : 'sedan';
    let e = pools[t].pop();
    if (!e) {
      const a = assets[t] || fallbackGeo[t];
      const idHash = (car.id * 2654435761) >>> 0;
      const hex = FIXED[t] || PAINTS[(idHash >> 8) % PAINTS.length];
      const mesh = new THREE.Mesh(a.geo, paintMat(hex));
      mesh.matrixAutoUpdate = true;
      mesh.castShadow = tq === 'high';
      scene.add(mesh);
      e = { mesh, type: t, id: -1, stamp: 0 };
    }
    return e;
  }

  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
  const _lp = new THREE.Vector3(), _cd = new THREE.Vector3();
  /** Updates meshes for the cars list. */
  function update(cars, camPos) {
    frame++;
    camera.getWorldDirection(_cd); const camFx = _cd.x, camFz = _cd.z;
    const n = cars ? cars.length : 0;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      let e = byId.get(car.id);
      if (!e) { e = acquire(car); e.id = car.id; byId.set(car.id, e); active.push(e); }
      e.stamp = frame; e.car = car;
      const m = e.mesh;
      // cars behind the camera are not drawn (and cost no draw call)
      const cdx = camPos ? car.pos.x - camPos.x : 0, cdz = camPos ? car.pos.z - camPos.z : 0;
      m.visible = !(cdx * camFx + cdz * camFz < -6 && cdx * cdx + cdz * cdz > 100);
      m.position.set(car.pos.x, car.pos.y, car.pos.z);
      if (m.scale.x !== MODEL_SCALE) m.scale.setScalar(MODEL_SCALE);
      m.rotation.set(0, car.yaw, 0);
      // crashed/hit cars just stay put; tilt a bit when hit for readability
      if (car.hit) m.rotation.z = 0.12;
    }
    // release unused (swap-remove, no allocation)
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      if (e.stamp !== frame) {
        e.mesh.visible = false; byId.delete(e.id); pools[e.type].push(e);
        active[i] = active[active.length - 1]; active.pop();
        shadow.set(16 + i, 0, 0, 0, 0, 0);
      }
    }
    // shadows + glows
    let gi = 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i], car = e.car, a = assets[e.type] || fallbackGeo[e.type];
      const w = a.hw * 2 + 0.5, l = (a.maxZ - a.minZ) + 0.6;
      shadow.set(16 + i, car.pos.x, car.pos.y, car.pos.z, car.yaw, 1, w, l);
      if (!camPos) continue;
      const dx = camPos.x - car.pos.x, dz = camPos.z - car.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 450) continue;
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      const front = (dx * fx + dz * fz) > 0;
      const fade = 1 - Math.min(Math.max((dist - 200) / 250, 0), 1);
      const ly = LIGHT_Y[e.type] || 0.62;
      const size = 0.45 + dist * 0.006;
      for (let k = -1; k <= 1; k += 2) {
        if (gi >= GCAP) break;
        const zz = front ? a.minZ - 0.06 : a.maxZ + 0.06;
        const xx = k * a.hw * (front ? 0.62 : 0.72);
        const cs = Math.cos(car.yaw), sn = Math.sin(car.yaw);
        _lp.set(car.pos.x + xx * cs + zz * sn, car.pos.y + ly, car.pos.z - xx * sn + zz * cs);
        _m.compose(_lp, camera.quaternion, _s.set(size, size, size));
        glow.setMatrixAt(gi, _m);
        if (front) glow.setColorAt(gi, _c.setRGB(1.0, 0.95, 0.78).multiplyScalar(0.9 * fade));
        else glow.setColorAt(gi, _c.setRGB(1.0, 0.1, 0.05).multiplyScalar(0.8 * fade));
        gi++;
      }
    }
    glow.count = gi; glow.visible = gi > 0;
    glow.instanceMatrix.needsUpdate = true; glow.instanceColor.needsUpdate = true;
  }
  /** Distance (m, xz) from (x,z) to the nearest active car. */
  function nearest(x, z) {
    let best = 1e9;
    for (let i = 0; i < active.length; i++) { const p = active[i].mesh.position; const d = Math.hypot(p.x - x, p.z - z); if (d < best) best = d; }
    return best;
  }
  return { update, nearest, get activeCount() { return active.length; }, assets, setQuality(q) { tq = q; for (const e of active) e.mesh.castShadow = q === 'high'; for (const t of TYPES) for (const e of pools[t]) e.mesh.castShadow = q === 'high'; } };
}
