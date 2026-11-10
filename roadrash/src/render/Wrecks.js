// Ragdoll limbs (instanced capsule-ish shapes) and debris parts drawn by kind.
import * as THREE from '../../public/vendor/three.module.min.js';
import { Mesher, ss } from './util.js';
import { fogify } from './Look.js';
import { LIVERIES } from './Bikes.js';
import { GLTFLoader } from '../../public/vendor/GLTFLoader.js';

const MAX_LIMBS = 16 * 9;
const MAX_JOINTS = 16 * 10;
// radius by bone key i*10+j (bones from DestructionSystem RD_BONES)
const LIMB_R = { 1: 0.045, 12: 0.15, 13: 0.065, 14: 0.065, 25: 0.085, 26: 0.085, 57: 0.065, 68: 0.065 };
const DRAWN = new Set([1, 12, 13, 14, 25, 26, 57, 68]);

/** Creates ragdoll + debris drawing. */
export function createWrecks(scene) {
  const lambert = fogify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25, envMapIntensity: 0.8 }), 'wreck');
  // limbs: unit cylinder along Y from -0.5..0.5, 7 sides
  const limbGeo = new THREE.CylinderGeometry(1, 0.85, 1, 7, 1);
  const limbs = new THREE.InstancedMesh(limbGeo, fogify(new THREE.MeshStandardMaterial({ roughness: 0.6, envMapIntensity: 0.6 }), 'limb'), MAX_LIMBS);
  const joints = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), fogify(new THREE.MeshStandardMaterial({ roughness: 0.6, envMapIntensity: 0.6 }), 'limb'), MAX_JOINTS);
  for (const m of [limbs, joints]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0; m.visible = false;
    scene.add(m);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pa = new THREE.Vector3(), sc = new THREE.Vector3();
  const dir = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), col2 = new THREE.Color();
  const helmetCols = LIVERIES.map((l) => new THREE.Color(l[2]));
  const suitCols = LIVERIES.map((l) => new THREE.Color(l[1]));

  function drawRagdolls(iter) {
    let nl = 0, nj = 0;
    for (const r of iter) {
      const P = r.points;
      const si = (r.id | 0) % LIVERIES.length;
      const suit = suitCols[si], helm = helmetCols[si];
      const B = r.bones;
      for (let k = 0; k < B.length; k++) {
        const i = B[k][0], j = B[k][1], key = i * 10 + j;
        if (!DRAWN.has(key) || nl >= MAX_LIMBS) continue;
        const a = P[i], b = P[j];
        dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
        const len = dir.length();
        if (len < 1e-4) continue;
        dir.multiplyScalar(1 / len);
        q.setFromUnitVectors(up, dir);
        const rad = LIMB_R[key];
        m4.compose(pa.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), q, sc.set(rad, len, rad * (key === 12 ? 0.75 : 1)));
        limbs.setMatrixAt(nl, m4);
        limbs.setColorAt(nl, key === 1 ? col.setRGB(0.8, 0.62, 0.5) : suit);
        nl++;
      }
      for (let i = 0; i < P.length && nj < MAX_JOINTS; i++) {
        const p = P[i];
        const rad = i === 0 ? 0.14 : i === 1 ? 0.16 : i === 2 ? 0.13 : (i === 7 || i === 8) ? 0.085 : 0.07;
        m4.compose(pa.set(p.x, p.y, p.z), q.identity(), sc.set(rad, rad * (i === 0 ? 1.08 : 1), rad));
        joints.setMatrixAt(nj, m4);
        joints.setColorAt(nj, i === 0 ? helm : (i === 7 || i === 8) ? col2.setRGB(0.07, 0.07, 0.08) : (i === 3 || i === 4) ? col.setRGB(0.1, 0.1, 0.11) : suit);
        nj++;
      }
    }
    limbs.count = nl; limbs.visible = nl > 0;
    joints.count = nj; joints.visible = nj > 0;
    limbs.instanceMatrix.needsUpdate = true; limbs.instanceColor.needsUpdate = true;
    joints.instanceMatrix.needsUpdate = true; joints.instanceColor.needsUpdate = true;
  }

  // ---- debris ----
  function wheel() {
    const m = new Mesher();
    m.torusX(0.265, 0.062, [0, 0, 0], 0x141416, 0, 14, 5);
    m.torusX(0.205, 0.016, [0, 0, 0], 0xb8bcc4, 0, 12, 4);
    for (let k = 0; k < 3; k++) m.box(0.025, 0.42, 0.03, [0, 0, 0], 0xc3c7cf, 0, [(k / 3) * Math.PI, 0, 0]);
    m.cyl(0.05, 0.05, [-0.06, 0, 0], [0.06, 0, 0], 0x8a8f99, 0, 8);
    return m.build();
  }
  function fairing(left) {
    const m = new Mesher();
    // curved panel: thin along x, tapered upward; half extents 1 -> scaled by size
    m.box(2, 2, 2, [0, 0, 0], 0xffffff, 0, null);
    const g = m.build();
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setZ(i, p.getZ(i) * (1 - 0.35 * ss((y + 1) / 2)));
      p.setX(i, p.getX(i) * (1 + (left ? 1 : -1) * 0.0) + (y > 0.2 ? (left ? 0.3 : -0.3) : 0));
    }
    g.computeVertexNormals();
    return g;
  }
  const unit = (fn) => { const m = new Mesher(); fn(m); return m.build(); };
  const DG = {
    wheelF: wheel(), wheelR: wheel(),
    fairingL: fairing(true), fairingR: fairing(false),
    handlebar: unit((m) => { m.cyl(0.03, 0.03, [-1, 0, 0], [1, 0, 0], 0x141417, 0, 5); m.cyl(0.045, 0.045, [-1, 0, 0], [-0.7, 0, 0], 0x090909, 0, 5); m.cyl(0.045, 0.045, [1, 0, 0], [0.7, 0, 0], 0x090909, 0, 5); }),
    tank: unit((m) => { m.sph(1, 1, 1, [0, 0, 0], 0xffffff, 0, null, 9, 6); m.box(0.5, 0.2, 1.2, [0, 0.9, 0], 0x1a1a1d); }),
  };
  const dm = fogify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.9 }), 'wreckd');
  const dMesh = {};
  const CAP = 40;
  for (const k of Object.keys(DG)) {
    const im = new THREE.InstancedMesh(DG[k], dm, CAP);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.setColorAt(0, new THREE.Color(1, 1, 1));
    im.frustumCulled = false; im.count = 0; im.visible = false;
    scene.add(im);
    dMesh[k] = im;
  }
  // crash pieces cut from the sport bike model (assets/bikes/sport_wreck.glb, textured with the bike atlas); the procedural pieces above stay as the fallback
  const WU = (f) => new URL(`../../assets/bikes/${f}`, import.meta.url).href;
  const tex = new THREE.Texture(); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 2; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const dmTex = fogify(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.3, envMapIntensity: 1.0, side: THREE.DoubleSide }), 'wreckt');
  new GLTFLoader().load(WU('sport_wreck.glb'), (gltf) => {
    const img = new Image();
    img.onload = () => {
      tex.image = img; tex.needsUpdate = true;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const k = o.name.replace(/^lod0_/, '').replace(/_\d+$/, '');
        if (!dMesh[k]) return;
        const g = o.geometry.clone(); g.deleteAttribute('color');
        dMesh[k].geometry = g; dMesh[k].material = dmTex; dMesh[k].userData.textured = true;
      });
    };
    img.src = WU('sport_albedo_512.webp');
  }, undefined, () => {});
  const cnt = {};
  const paint = new THREE.Color();
  function drawDebris(iter) {
    for (const k in dMesh) cnt[k] = 0;
    for (const d of iter) {
      const k = dMesh[d.kind] ? d.kind : (d.kind === 'wheel' ? 'wheelF' : d.kind === 'fairing' ? 'fairingL' : null);
      if (!k) continue;
      const im = dMesh[k];
      const i = cnt[k];
      if (i >= CAP) continue;
      const sz = typeof d.size === 'number' ? { x: d.size, y: d.size, z: d.size } : d.size;
      if (k === 'wheelF' || k === 'wheelR') {
        const rr = (d.radius || sz.y || 0.32) / 0.33;
        sc.set(rr, rr, rr);
      } else if (k === 'handlebar') sc.set(sz.x, 1, 1);
      else sc.set(sz.x, sz.y, sz.z);
      q.set(d.quat.x, d.quat.y, d.quat.z, d.quat.w);
      m4.compose(pa.set(d.pos.x, d.pos.y, d.pos.z), q, sc);
      im.setMatrixAt(i, m4);
      const L = LIVERIES[((d.id | 0) >> 3) % LIVERIES.length];
      im.setColorAt(i, paint.setHex(k === 'wheelF' || k === 'wheelR' || k === 'handlebar' ? 0xffffff : L[0]));
      if (im.userData.textured && (k === 'tank' || k === 'fairingL' || k === 'fairingR')) im.setColorAt(i, paint.setHex(L[0]));
      cnt[k] = i + 1;
    }
    for (const k in dMesh) {
      const im = dMesh[k];
      im.count = cnt[k]; im.visible = cnt[k] > 0;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
  return { drawRagdolls, drawDebris };
}
