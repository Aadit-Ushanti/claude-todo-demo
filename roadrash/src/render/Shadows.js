// One instanced mesh of soft blob shadows for every bike and car (no shadow maps).
import * as THREE from '../../public/vendor/three.module.min.js';

/** Creates the blob-shadow layer; capacity = max simultaneous blobs. */
export function createShadows(scene, capacity = 96) {
  const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `varying vec2 vP; void main(){ vP = position.xz * 2.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vP; void main(){ float r = length(vP); float a = exp(-r * r * 3.2) * 0.78 + exp(-r * r * 0.9) * 0.18; a *= 1.0 - smoothstep(0.85, 1.0, r); gl_FragColor = vec4(0.015, 0.012, 0.02, a); }`,
  });
  const mesh = new THREE.InstancedMesh(g, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, zero);
  let used = 0;
  /** Sets blob i (visible when vis>0). */
  function set(i, x, y, z, yaw, vis, w = 1.0, l = 2.3) {
    if (i >= capacity) return;
    if (vis > 0) {
      q.setFromEuler(e.set(0, yaw, 0));
      m.compose(p.set(x, y + 0.04, z), q, s.set(w, 1, l));
      mesh.setMatrixAt(i, m);
    } else mesh.setMatrixAt(i, zero);
    if (i + 1 > used) used = i + 1;
  }
  /** Marks slots >= from as hidden and uploads. */
  function flush(from) {
    for (let i = from; i < used; i++) mesh.setMatrixAt(i, zero);
    mesh.count = Math.max(used, 1);
    mesh.instanceMatrix.needsUpdate = true;
  }
  return { set, flush, mesh };
}
