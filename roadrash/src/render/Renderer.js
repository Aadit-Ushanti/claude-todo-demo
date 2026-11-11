// Road Rash renderer: chase camera, track world (road, terrain, scenery, sky), riders, traffic, wrecks, post-processing.
import * as THREE from '../../public/vendor/three.module.min.js';
import { cameraParams } from '../physics/BikePhysics.js';
import { makeShared, createTerrain, createTerrainAsync, prewarmTerrainTextures } from './Terrain.js';
import { createScenery, createSceneryAsync, speciesFor, tuftAtlas } from './Scenery.js';
import { preloadSpecies, speciesTextures, evictSpecies, clearSpecies } from './Nature.js';
import { themeTextures, themeReady, evict as evictEnvTex, clearEnvTextures, memoryMB } from './EnvTex.js';
import { clearTextureCache, cachedTextures } from './Look.js';
import { createEnv } from './Sky.js';
import { createRiders, bikeMenuPreview, preloadBikes, bikeTextures } from './Bikes.js';
import { createShadows } from './Shadows.js';
import { createTraffic } from './Traffic.js';
import { createWrecks } from './Wrecks.js';
import { createPost } from './Post.js';
import { createFxVelocity } from './FxVelocity.js';

const DEFAULT_THEME = { sky: '#8fb8e6', fog: '#c5d6ea', ground: '#6b8f45', roadside: 'oaks', timeOfDay: 'noon' };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function isPhone() {
  try {
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  } catch (e) { return false; }
}

/**
 * Creates the three.js renderer, scene and chase camera.
 * @param {HTMLCanvasElement} canvas
 * @returns {object} { scene, camera, render, resize, addBikeMesh, updateBikeMesh, drawRagdolls, drawDebris, setTrack, preloadTrack, preloadAll, updateRider, updateTraffic, setQuality, getQuality, info }
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 2400);
  const shared = makeShared();
  const env = createEnv(scene, shared, renderer, isPhone() ? 'medium' : 'high');
  const shadows = createShadows(scene, 96);
  const riders = createRiders(scene, shadows);
  let bikeTexQueue = null;
  preloadBikes(undefined, isPhone() ? 'medium' : 'high').then(() => { bikeTexQueue = bikeTextures(); });
  const traffic = createTraffic(scene, shadows, camera);
  const wrecks = createWrecks(scene);
  const post = createPost(renderer, scene);
  const phone = isPhone();
  const fx = createFxVelocity({ scale: (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 0.4 : 1 });

  // ---- fallback world (no track yet): flat ground and a strip ----
  const fallback = new THREE.Group();
  const fGround = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x4d7a3a }));
  const fRoad = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 3000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x35363b }));
  fRoad.position.y = 0.02;
  fallback.add(fGround, fRoad);
  scene.add(fallback);
  env.apply(DEFAULT_THEME, 1);

  let track = null, terrain = null, scenery = null;
  let quality = phone ? ((navigator.deviceMemory || 4) <= 2 ? 'low' : 'medium') : 'high';   // low-memory phones start one tier down
  if (quality === 'low') env.setQuality('low');
  // a lost WebGL context (usually GPU memory pressure) falls back one tier when it is restored
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', () => { const down = quality === 'high' ? 'medium' : 'low'; clearEnvTextures(); clearSpecies(); setQuality(down === quality ? 'low' : down); });
  const tt = { s: 0, d: 0, yaw: 0 };
  const smp = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
  let camS = 0;

  // ---- worlds: terrain + scenery per (track, tier). Kept built (off-screen) on medium/high so switching tracks is a swap. ----
  const worlds = new Map();
  let cur = null;
  const themeOf = (t) => (t && t.def && t.def.theme) || (t && t.theme) || DEFAULT_THEME;
  const keyOf = (t) => `${t.id || (t.def && t.def.id) || 'x'}|${t.seed | 0}|${quality}`;
  const keepWorlds = () => quality !== 'low';
  const frame = () => new Promise((res) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => res()) : setTimeout(res, 16)));
  function disposeWorld(w) {
    scene.remove(w.terrain.group); scene.remove(w.scenery.group);
    w.terrain.dispose(); w.scenery.dispose();
  }
  function disposeWorlds() { const all = new Set(worlds.values()); if (cur) all.add(cur); for (const w of all) disposeWorld(w); worlds.clear(); cur = null; terrain = null; scenery = null; }
  function buildTerrain(t, theme) {
    const tr = createTerrain(t, theme, shared, quality, scene);
    tr.group.traverse((o) => { if (o.isMesh && o.material.isMeshStandardMaterial && o !== tr.sea) o.receiveShadow = true; });
    return tr;
  }
  function buildWorld(t) {
    const theme = themeOf(t), tr = buildTerrain(t, theme);
    const sc = createScenery(t, theme, tr, quality);
    return { key: keyOf(t), terrain: tr, scenery: sc, theme };
  }
  async function buildWorldAsync(t) {
    const theme = themeOf(t);
    const tr = await createTerrainAsync(t, theme, shared, quality, scene, frame);
    tr.group.traverse((o) => { if (o.isMesh && o.material.isMeshStandardMaterial && o !== tr.sea) o.receiveShadow = true; });
    await frame();
    const sc = await createSceneryAsync(t, theme, tr, quality, frame);
    return { key: keyOf(t), terrain: tr, scenery: sc, theme };
  }
  /** Frees the GPU copies of every texture the active theme does not use (they re-upload when needed). */
  function evictUnused(theme) {
    const sp = speciesFor(theme.roadside || 'pines');
    evictEnvTex([...themeTextures(theme.roadside || 'pines', quality), tuftAtlas().tex]); evictSpecies(sp, quality);
  }
  /** Uploads a theme's textures to the GPU, one per frame, so no frame carries more than one big upload. */
  async function uploadTheme(theme) {
    const sp = speciesFor(theme.roadside || 'pines');
    const tex = [...speciesTextures(sp, quality), ...themeTextures(theme.roadside || 'pines', quality), tuftAtlas().tex];
    for (let i = 0; i < tex.length; i++) { if (tex[i].image) { renderer.initTexture(tex[i]); await frame(); } }
  }
  let bulk = false;
  function windowFor() { return quality === 'low' ? [430, 50] : quality === 'medium' ? [560, 70] : [700, 90]; }

  /** Builds the road, terrain, scenery, sky and fog for a track. Replaces the previous track completely; per-track objects of the old one are disposed (or kept built for a fast return on medium/high). */
  function setTrack(t) {
    if (cur) {
      scene.remove(cur.terrain.group); scene.remove(cur.scenery.group);
      if (!worlds.has(cur.key) || !keepWorlds()) { worlds.delete(cur.key); disposeWorld(cur); }
      cur = null; terrain = null; scenery = null;
    }
    track = t;
    camInit = false;
    if (!t) { fallback.visible = true; env.apply(DEFAULT_THEME, 1); return; }
    fallback.visible = false;
    const theme = themeOf(t);
    env.apply(theme, t.seed);
    riders.setLights(/dawn|sunset|dusk|night/.test(String(theme.timeOfDay || '')));
    let w = worlds.get(keyOf(t));
    if (!w) { w = buildWorld(t); if (keepWorlds()) worlds.set(w.key, w); }
    cur = w; terrain = w.terrain; scenery = w.scenery;
    scene.add(terrain.group); scene.add(scenery.group);
    evictUnused(theme);
    fxInfo.dust.set(theme.ground || '#8a7a60').multiplyScalar(0.85);
    const [sp, bk] = windowFor();
    scenery.setWindow(sp, bk);
    scenery.update(0, 0, 0, true);
    camS = 0;
  }

  let preloading = Promise.resolve();
  /**
   * Downloads, decodes and builds everything a track needs without touching the visible scene, spread over frames.
   * @param {object|string} trackOrId a built Track (full prebuild), or a theme / roadside key (assets only)
   * @returns {Promise<void>}
   */
  function preloadTrack(trackOrId) {
    const job = async () => {
      const isTrack = trackOrId && typeof trackOrId === 'object' && trackOrId.edges;
      const theme = typeof trackOrId === 'string' ? { roadside: trackOrId } : themeOf(trackOrId);
      const sp = speciesFor(theme.roadside || 'pines');
      await Promise.all([preloadSpecies(sp, quality), tuftAtlas().ready, themeReady(theme.roadside || 'pines', quality)]);
      await frame();
      if (isTrack && keepWorlds() && !worlds.has(keyOf(trackOrId))) {
        const w = await buildWorldAsync(trackOrId);     // terrain rows, road chunks, scenery placement, props, life: each in ~10 ms slices
        worlds.set(w.key, w);
        await frame();
      }
      if (!bulk) await uploadTheme(theme);
      if (isTrack && worlds.has(keyOf(trackOrId)) && cur) {
        // compile the programs this world uses (shared with the current track, so usually already cached)
        const w = worlds.get(keyOf(trackOrId));
        scene.add(w.terrain.group); scene.add(w.scenery.group);
        try { renderer.compile(scene, camera); } catch (e) { /* ignore */ }
        scene.remove(w.terrain.group); scene.remove(w.scenery.group);
      }
    };
    preloading = preloading.then(job, job);
    return preloading;
  }
  /**
   * Preloads every track (first-launch loading bar). Calls onProgress(fraction 0..1, label).
   * @param {(f:number,label:string)=>void} [onProgress]
   * @param {object[]} [tracks] built Tracks; defaults to all tracks from src/track
   */
  async function preloadAll(onProgress, tracks) {
    let list = tracks;
    if (!list) {
      const [{ TRACKS }, { buildTrack }] = await Promise.all([import('../track/tracks.js'), import('../track/Track.js')]);
      list = Object.values(TRACKS).map((d) => buildTrack(d));
    }
    bulk = true;   // decode + build every track, but only the first one is uploaded to the GPU (the rest upload when it is selected)
    try {
      for (let i = 0; i < list.length; i++) {
        if (onProgress) onProgress(i / list.length, list[i].def ? list[i].def.name || list[i].id : String(i));
        await preloadTrack(list[i]);
      }
    } finally { bulk = false; }
    await preloadTrack(list[0]);
    if (onProgress) onProgress(1, 'done');
    return list;
  }

  // ---- quality ----
  function applyPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const cap = quality === 'low' ? 1 : phone ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(dpr, cap));
  }
  /** @param {'low'|'medium'|'high'} q */
  function setQuality(q) {
    if (q !== 'low' && q !== 'medium' && q !== 'high') return;
    const changed = q !== quality;
    quality = q;
    env.setQuality(q);
    shadows.setQuality && shadows.setQuality(q);
    riders.setQuality && riders.setQuality(q);
    traffic.setQuality && traffic.setQuality(q);
    fx.setScale(q === 'low' ? 0.6 : 1);
    applyPixelRatio();
    post.overlay.visible = q === 'medium';
    if (scenery) scenery.setWindow(q === 'low' ? 430 : q === 'medium' ? 560 : 700, q === 'low' ? 50 : q === 'medium' ? 70 : 90);
    resize();
    if (changed) { const t = track; disposeWorlds(); clearTextureCache(); clearEnvTextures(); clearSpecies(); if (t) setTrack(t); }   // materials, texture sizes and LOD radii depend on the tier
  }

  // Screen fit: the drawing size always follows the canvas's real on-screen box. Phones do not reliably send `resize` when they
  // rotate, hide their toolbars or go fullscreen, so render() also compares the box every frame (two integer reads) and calls this.
  let fitW = 0, fitH = 0, fitDpr = 0;
  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!(w > 0 && h > 0)) return;
    fitW = w; fitH = h; fitDpr = window.devicePixelRatio || 1;
    applyPixelRatio();
    // one UI scale for every screen: HUD and touch buttons keep their proportion against a 390 px reference short side
    try { document.documentElement.style.setProperty('--ui', String(clamp(Math.min(w, h) / 390, 0.8, 1.5).toFixed(3))); } catch (e) { /* no document */ }
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const v = renderer.getDrawingBufferSize(_v2);
    post.setSize(v.x, v.y, quality === 'high' ? 4 : 0);
  }
  const _v2 = new THREE.Vector2();
  const _v3cam = new THREE.Vector3();
  const _focus = new THREE.Vector3();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  applyPixelRatio();
  post.overlay.visible = quality === 'medium';
  resize();

  // ---- riders (public API) ----
  let frameDt = 1 / 60;
  const slotOf = new Map();
  /** Draws/updates one rider (slot 0 = player). info: {kind, attacking, side, weapon} */
  const _camDir = { x: 0, z: -1 };
  /** Draws/updates one rider. info: {kind, attacking, side, weapon, bikeType: 'sport'|'street'|'chopper' (else state.spec.id), number} */
  function updateRider(slot, state, info) { riders.update(slot, state, info, frameDt, camera.position, _camDir); }
  function slotFor(id) {
    if (typeof id === 'number') return id;
    let s = slotOf.get(id);
    if (s === undefined) {
      if (id === 'player') s = 0;
      else { s = 1; const used = new Set(slotOf.values()); while (used.has(s)) s++; }
      slotOf.set(id, s);
    }
    return s;
  }
  function addBikeMesh(id) { return riders.get(slotFor(id)); }
  function updateBikeMesh(id, s) { updateRider(slotFor(id), s, null); }
  /** Updates the pooled traffic meshes for this frame's car list. */
  function updateTraffic(cars) { traffic.update(cars, camera.position); }

  // ---- camera ----
  const cp = { fov: 60, shake: 0, lag: 0.1, dist: 4.2, height: 1.8 };
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  let camYaw = 0, camInit = false, time = 0;
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  function groundAt(x, z) {
    if (!terrain) return 0;
    track.toTrack(x, z, camS, tt);
    return terrain.ground(tt.s, tt.d, x, z);
  }

  // ---- game particles: dust off the pavement, tyre smoke on drifts, sparks on a slide (also exposed as spawnFx) ----
  const fxInfo = { dust: new THREE.Color(0.55, 0.45, 0.32) }, _fp = new THREE.Vector3(), _fv = new THREE.Vector3();
  let emitAcc = 0;
  function spawnFx(type, pos, vel) { if (scenery) scenery.fx.spawn(type, pos, vel); }
  function emitFx(bike, dt, s) {
    if (!bike || !terrain) return;
    const sp = Math.abs(bike.speed || 0);
    if (sp < 3 && !bike.crashed) { emitAcc = 0; return; }
    emitAcc += dt * (quality === 'low' ? 22 : 38);
    const fxx = -Math.sin(bike.yaw), fzz = -Math.cos(bike.yaw);
    while (emitAcc >= 1) {
      emitAcc -= 1;
      _fp.set(bike.pos.x - fxx * 0.9 + (Math.random() - 0.5) * 0.4, bike.pos.y + 0.1, bike.pos.z - fzz * 0.9 + (Math.random() - 0.5) * 0.4);
      _fv.set(-fxx * sp * 0.15, 0.3, -fzz * sp * 0.15);
      if (bike.crashed && sp > 2) spawnFx('sparks', _fp, _fv.set(fxx * sp * 0.2, 0.5, fzz * sp * 0.2));
      else if (Math.abs(tt.d) > terrain.edge - 0.2 && sp > 6) spawnFx('dust', _fp, _fv);
      else if (bike.drifting && sp > 8) spawnFx('smoke', _fp, _fv);
    }
  }
  /** Estimated GPU memory (MB) of the environment, tree and bike textures currently resident, for the active tier. */
  function textureMemory() {
    if (!cur) return { env: 0, trees: 0, total: 0 };
    const th = cur.theme, sp = speciesFor(th.roadside || 'pines');
    const env_ = memoryMB(themeTextures(th.roadside || 'pines', quality)) + memoryMB([tuftAtlas().tex]), trees = memoryMB(speciesTextures(sp, quality));
    return { env: +env_.toFixed(1), trees: +trees.toFixed(1), total: +(env_ + trees).toFixed(1) };
  }

  /** Positions the chase camera behind `bike` and draws the frame. */
  function render(bike, dtReal) {
    const dt = clamp(dtReal || 0, 0, 0.1);
    frameDt = dt > 0 ? dt : 1 / 60;
    if (canvas.clientWidth !== fitW || canvas.clientHeight !== fitH || (window.devicePixelRatio || 1) !== fitDpr) resize();
    if (bikeTexQueue && bikeTexQueue.length) { for (let i = 0; i < 2 && bikeTexQueue.length; i++) { const t = bikeTexQueue.pop(); if (t.image) renderer.initTexture(t); } }
    time += dt;
    renderer.info.reset();
    cameraParams(bike, cp);
    // near passes of traffic / other riders
    let near = 0;
    const nc = traffic.nearest(bike.pos.x, bike.pos.z);
    if (nc < 9) near = 1 - nc / 9;
    for (let i = 0; i < riders.riders.length; i++) {
      const r = riders.riders[i];
      if (!r || !r.root.visible) continue;
      const p = r.root.position, d = Math.hypot(p.x - bike.pos.x, p.z - bike.pos.z);
      if (d > 0.8 && d < 6 && 1 - d / 6 > near) near = 1 - d / 6;
    }
    const v = fx.update(bike, dt, { nearPass: near, airborne: !!bike.airborne, crashed: !!bike.crashed });
    // every speed effect derives from the perceived speed v (not the raw physics speed)
    const vc = Math.min(v, 1.25), mul = (1 + 0.8 * (bike.drifting ? 1 : 0)) * (bike.stagger > 0 ? 2.2 : 1);
    cp.fov = 58 + 37 * vc;
    cp.shake = (0.004 + 0.05 * vc * vc) * mul;
    cp.lag = 0.08 + 0.16 * Math.min(vc, 1) + (bike.drifting ? 0.08 : 0);
    cp.dist = 4.2 + 1.6 * Math.min(vc, 1.1);
    const bx = bike.pos.x, by = bike.pos.y, bz = bike.pos.z;
    if (track) { track.toTrack(bx, bz, camS, tt); camS = tt.s; }
    if (!camInit || Math.abs(camPos.x - bx) + Math.abs(camPos.z - bz) > 60) {
      camYaw = bike.yaw;
      camPos.set(bx + Math.sin(camYaw) * cp.dist, by + cp.height, bz + Math.cos(camYaw) * cp.dist);
      camInit = true;
    }
    const lag = Math.max(cp.lag, 0.02);
    camYaw += wrap(bike.yaw - camYaw) * (1 - Math.exp(-dt / (lag * 1.1)));
    const cfx = -Math.sin(camYaw), cfz = -Math.cos(camYaw);
    const tx = bx - cfx * cp.dist, ty = by + cp.height, tz = bz - cfz * cp.dist;
    const ex = tx - camPos.x, ey = ty - camPos.y, ez = tz - camPos.z;
    const along = ex * cfx + ez * cfz;
    const aA = 1 - Math.exp(-dt / (lag * 0.1)), aL = 1 - Math.exp(-dt / lag), aY = 1 - Math.exp(-dt / (lag * 0.8));
    camPos.x += cfx * along * aA + (ex - cfx * along) * aL;
    camPos.z += cfz * along * aA + (ez - cfz * along) * aL;
    camPos.y += ey * aY;
    const sh = cp.shake;
    let cx = camPos.x + (Math.random() * 2 - 1) * sh, cy = camPos.y + (Math.random() * 2 - 1) * sh, cz = camPos.z + (Math.random() * 2 - 1) * sh;
    if (terrain) {
      const g = groundAt(cx, cz);
      if (cy < g + 0.7) cy = g + 0.7;
    } else if (cy < 0.7) cy = 0.7;
    camera.position.set(cx, cy, cz);
    const bfx = -Math.sin(bike.yaw), bfz = -Math.cos(bike.yaw);
    look.set(bx + bfx * 9, by + 1.1, bz + bfz * 9);
    if (track) {
      track.sampleAt(Math.min(camS + 16, track.length), smp);
      const w = Math.abs(tt.d) < 14 ? 0.3 : 0;
      look.x += (smp.x - look.x) * w; look.z += (smp.z - look.z) * w; look.y += (smp.y + 1.0 - look.y) * w;
    }
    camera.lookAt(look);
    camera.rotateZ((bike.lean || 0) * 0.16);
    if (camera.fov !== cp.fov) { camera.fov = cp.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    camera.getWorldDirection(_v3cam); _camDir.x = _v3cam.x; _camDir.z = _v3cam.z;

    // world follow/update
    if (terrain) {
      terrain.update(camS, quality === 'low' ? 480 : quality === 'medium' ? 600 : 720, quality === 'low' ? 100 : 140);
      if (terrain.sea) terrain.sea.position.set(cx, terrain.seaY, cz);
      scenery.update(camS, cx, cz);
      emitFx(bike, dt, camS);
      scenery.tick(dt, time, camera, renderer.getDrawingBufferSize(_v2).y, camS, camS, fxInfo);
    } else {
      fGround.position.set(bx, -0.02, bz);
      fRoad.position.set(0, 0.02, bz);
    }
    shared.uCam.value.copy(camera.position);
    shared.uTime.value = time;
    shared.uCloudK.value = quality === 'low' ? 0 : 0.8;
    shared.uSunV.value.copy(shared.uSunDir.value).transformDirection(camera.matrixWorldInverse);
    env.update(camera.position, time, quality);
    env.followShadow(_focus.set(bx, by, bz));
    renderer.toneMappingExposure = env.state.exposure * (quality === 'low' ? 1.04 : 1);
    shadows.flush(16 + traffic.activeCount);

    shared.uStreak.value = 0;   // the road no longer smears its grain; speed reads from fov, blur at the edges and lines near top speed
    post.setSpeed(v, time, camera.aspect, quality, env.state.grade);
    if (quality === 'high') post.renderHigh(scene, camera);
    else renderer.render(scene, camera);
  }

  return {
    scene, camera, renderer, render, resize, addBikeMesh, updateBikeMesh,
    /** Rotating bike + rider preview for a bike-select screen: bikeMenuPreview(canvasOrContainer, 'sport'|'street'|'chopper', liveryIndex, opts); see Bikes.js. */
    bikeMenuPreview, preloadBikes,
    drawRagdolls: wrecks.drawRagdolls, drawDebris: wrecks.drawDebris,
    setTrack, preloadTrack, preloadAll, updateRider, updateTraffic, setQuality,
    /** Spawns a particle: type 'dust'|'smoke'|'sparks'|'leaves', world position {x,y,z}, optional velocity {x,y,z}. */
    spawnFx, textureMemory,
    getQuality: () => quality,
    /** Perceived (faked) speed driving the effects, 0..1+. */
    get fxValue() { return fx.value; },
    fx,
    /** Visual terrain height at (x, z) (camera clamp, props). */
    groundAt,
    /** renderer.info totals for the last frame. */
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    get trackWorld() { return terrain; },
    /** The active track's scenery object (props / life / particles), for tools. */
    get trackScenery() { return scenery; },
    /** [terrain.group, scenery.group] of the active track (draw-call accounting in tools). */
    get worldGroups() { return terrain ? [terrain.group, scenery.group] : []; },
    get sceneryCounts() { return scenery ? scenery.counts() : null; },
  };
}
