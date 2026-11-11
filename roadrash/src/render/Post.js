// Post-processing without EffectComposer: radial blur + speed lines + vignette + chromatic fringe in one pass,
// and a cheap alpha-blended overlay (vignette + speed lines) for medium quality.
import * as THREE from '../../public/vendor/three.module.min.js';

const FX_COMMON = `
float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float speedLines(vec2 uv, vec2 c, float amt, float t, float aspect, float near){
  vec2 p = (uv - c) * vec2(aspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  float n = 120.0;
  float id = floor(a * n);
  float hh = h11(id + floor(t * 12.0) * 17.0);
  float f = fract(a * n);
  float w = 0.04 + 0.10 * h11(id * 1.7 + 3.0);
  float line = step(abs(f - 0.5), w * 0.5);
  float start = 0.62 - 0.3 * near + 0.2 * h11(id + 7.0); // slipstream: the streaks reach in towards the bike
  line *= smoothstep(start, start + 0.25, r) * step(hh, amt);
  return line * (0.12 + 0.12 * near);
}`;

const VS = `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FS = `
uniform sampler2D tScene; uniform vec2 uCenter; uniform float uBlur; uniform float uChroma;
uniform float uSpeed; uniform float uTime; uniform float uAspect; uniform float uVig; uniform float uLines; uniform float uDraft;
uniform float uSat; uniform vec3 uWarm; uniform vec3 uCool;
varying vec2 vUv;
${FX_COMMON}
void main(){
  vec2 dir = vUv - uCenter;
  float r = length(dir * vec2(uAspect, 1.0));
  float k = uBlur * smoothstep(0.42, 1.0, r);
  vec3 col;
  if (uBlur < 0.002 && uChroma < 0.0004) {
    col = texture2D(tScene, vUv).rgb;
  } else {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 9; i++) {
      float t = float(i) / 8.0;
      acc.r += texture2D(tScene, vUv - dir * (k + uChroma * r) * t).r;
      acc.g += texture2D(tScene, vUv - dir * k * t).g;
      acc.b += texture2D(tScene, vUv - dir * (k - uChroma * r) * t).b;
    }
    col = acc / 9.0;
  }
  // cheap glow on HDR highlights, then per-theme grade: saturation + warm highlights / cool shadows
  vec3 hi = max(col - 1.0, 0.0);
  col += hi * 0.3;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSat);
  col *= mix(uCool, uWarm, smoothstep(0.05, 0.9, lum));
  float line = speedLines(vUv, uCenter, uLines, uTime, uAspect, uDraft);
  col = mix(col, vec3(1.0), line);
  float v = 1.0 - uVig * smoothstep(0.35, 1.05, r * 1.25);
  col *= v;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const OVERLAY_FS = `
uniform vec2 uCenter; uniform float uTime; uniform float uAspect; uniform float uVig; uniform float uLines; uniform float uDraft;
varying vec2 vUv;
${FX_COMMON}
void main(){
  vec2 dir = vUv - uCenter;
  float r = length(dir * vec2(uAspect, 1.0));
  float dv = uVig * smoothstep(0.35, 1.05, r * 1.25);
  float la = speedLines(vUv, uCenter, uLines, uTime, uAspect, uDraft);
  float a = la + dv * (1.0 - la);
  gl_FragColor = vec4(vec3(la / max(a, 1e-4)), a);
}`;

const tri = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
};

/** Creates the post-processing helpers. */
export function createPost(renderer, scene) {
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 });
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  const u = {
    tScene: { value: rt.texture }, uCenter: { value: new THREE.Vector2(0.5, 0.52) }, uBlur: { value: 0 }, uChroma: { value: 0 },
    uSpeed: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1.7 }, uVig: { value: 0.3 }, uLines: { value: 0 }, uDraft: { value: 0 },
    uSat: { value: 1.08 }, uWarm: { value: new THREE.Vector3(1.04, 1, 0.94) }, uCool: { value: new THREE.Vector3(0.95, 0.99, 1.06) },
  };
  const postMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: POST_FS, uniforms: u, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(tri(), postMat);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const ovMat = new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: OVERLAY_FS, uniforms: u, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const overlay = new THREE.Mesh(tri(), ovMat);
  overlay.frustumCulled = false; overlay.renderOrder = 999; overlay.visible = false;
  scene.add(overlay);

  return {
    rt, uniforms: u, overlay,
    /** Resizes the target to the drawing buffer size. */
    setSize(w, h, samples) { if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); } rt.setSize(w, h); },
    /** Sets per-frame values from speed fraction (0..1). */
    setSpeed(f, t, aspect, mode, grade, draft = 0) {
      u.uTime.value = t; u.uAspect.value = aspect; u.uDraft.value = draft;
      const sf = Math.min(Math.max(f, 0), 1.25);
      const ss = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
      // everything below ~70% of the perceived top speed is clean: blur only at the screen edges and only near the top end
      // slipstream (draft 0..1): streaks rush past and the edges close in a little while tucked in behind another bike
      u.uLines.value = Math.min(0.8, ss((sf - 0.97) / 0.28) * 0.45 + 0.55 * draft);
      u.uVig.value = 0.2 + 0.22 * sf * sf + 0.12 * draft;
      // low quality has no speed effects of its own: its overlay is only drawn while in a slipstream, and fades in with it
      if (mode === 'low') { u.uLines.value = 0.55 * draft; u.uVig.value = 0.3 * draft; }
      u.uBlur.value = mode === 'high' ? 0.05 * ss((sf - 0.86) / 0.4) : 0;
      u.uChroma.value = mode === 'high' ? 0.008 * ss((sf - 0.95) / 0.3) : 0;
      if (grade) { u.uSat.value = grade.sat; u.uWarm.value.set(grade.warm[0], grade.warm[1], grade.warm[2]); u.uCool.value.set(grade.cool[0], grade.cool[1], grade.cool[2]); }
    },
    /** Renders `scene` through the target and the post pass. */
    renderHigh(scene3, camera) {
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene3, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, cam);
    },
  };
}
