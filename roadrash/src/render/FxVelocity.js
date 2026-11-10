// "Faked" velocity for visual effects: a perceived speed 0..1+ that drives FOV, shake, lag, blur, speed lines,
// chromatic fringe, wheel blur and road streaking, instead of the raw physics speed.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {{attack?:number, release?:number, scale?:number, max?:number}} [opts]
 *   attack/release: smoothing time constants (s); scale: global effect scale (reduced motion / low quality); max: clamp.
 * @returns {{update:(bike:object, dtReal:number, hints?:{nearPass?:number, airborne?:boolean, crashed?:boolean})=>number, value:number, reset:()=>void, setScale:(s:number)=>void, smoothSpeed:(prev:number, target:number, dt:number)=>number}}
 */
export function createFxVelocity(opts = {}) {
  const attack = opts.attack ?? 0.15, release = opts.release ?? 0.6, max = opts.max ?? 1.3;
  let scale = opts.scale ?? 1;
  let smooth = 0, prevSpeed = 0, accel = 0, crashEase = 1, boost = 0, init = false;
  const api = {
    value: 0,
    /** Updates and returns the perceived speed. No allocation. */
    update(bike, dtReal, hints) {
      const dt = clamp(dtReal || 0, 0.001, 0.1);
      const top = bike.spec && bike.spec.topSpeed ? bike.spec.topSpeed : 60;
      const speed = bike.speed || 0;
      if (!init) { prevSpeed = speed; smooth = clamp(Math.abs(speed) / top, 0, 1.2); init = true; }
      const raw = clamp(Math.abs(speed) / top, 0, 1.2);
      // forward acceleration, low-passed (a collision spike is rejected by the clamp)
      const a = clamp((speed - prevSpeed) / dt, -30, 30);
      prevSpeed = speed;
      accel += (a - accel) * (1 - Math.exp(-dt / 0.25));
      const accBoost = clamp((accel - 3) / 12, 0, 1) * 0.12;
      const h = hints || null;
      const near = h && h.nearPass ? clamp(h.nearPass, 0, 1) * 0.16 : 0;
      const air = h && h.airborne ? 0.08 : 0;
      const target = raw + accBoost + near + air;
      const tau = target > smooth ? attack : release;
      smooth += (target - smooth) * (1 - Math.exp(-dt / tau));
      // crashed: ease the effects down; recover quickly after remount
      const ce = h && h.crashed ? 0.25 : 1;
      crashEase += (ce - crashEase) * (1 - Math.exp(-dt / (ce < crashEase ? 0.4 : 0.8)));
      // exaggerating curve: 0.65 -> ~0.88, 1 -> 1, keeps growing above
      const t = smooth;
      const f = t <= 1 ? 1 - (1 - t) * (1 - t) : 1 + (t - 1) * 1.2;
      api.value = clamp(f * crashEase, 0, max) * scale;
      return api.value;
    },
    reset() { smooth = 0; prevSpeed = 0; accel = 0; crashEase = 1; boost = 0; init = false; api.value = 0; },
    setScale(s) { scale = clamp(s, 0, 1); },
    /** Smoothed display value for riders we do not own (AI / remote): never the raw networked value. */
    smoothSpeed(prev, target, dt) { return prev + (target - prev) * (1 - Math.exp(-dt / 0.15)); },
  };
  return api;
}
