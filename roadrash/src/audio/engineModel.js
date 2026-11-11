// Pure engine / loudness mapping for the audio layer. No DOM, no WebAudio: runs under node (tests/audio.test.js).
// "hz" is the pitch of the synthesized engine's fundamental (a stylised firing frequency, not the real one),
// kept well under 300 Hz so the top end never turns into a squeal; the brightness filter does the rest.

/**
 * Engine character per type. idleHz/redHz: fundamental at idle and at the top of every gear.
 * gears: speed at the top of each gear as a fraction of top speed (the last must be 1).
 * topKmh: fallback top speed when the caller does not pass one.
 */
export const ENGINES = {
  sport:   { idleHz: 56, redHz: 235, gears: [0.17, 0.30, 0.44, 0.59, 0.77, 1], topKmh: 187 },
  street:  { idleHz: 40, redHz: 165, gears: [0.19, 0.34, 0.50, 0.66, 0.83, 1], topKmh: 183 },
  chopper: { idleHz: 27, redHz: 112, gears: [0.24, 0.43, 0.63, 0.82, 1],       topKmh: 179 },
  car:     { idleHz: 32, redHz: 100, gears: [0.22, 0.42, 0.64, 0.84, 1],       topKmh: 130 },
};

/** Speed of sound used for the cheap Doppler (m/s). */
export const SOUND_SPEED = 340;

/**
 * @param {number} x value
 * @param {number} a lower bound
 * @param {number} b upper bound
 * @returns {number} x clamped to [a, b]
 */
export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

/**
 * Look up the engine definition for a bike type (unknown ids fall back to street).
 * @param {string} type 'sport' | 'street' | 'chopper' | 'car'
 * @returns {{idleHz:number, redHz:number, gears:number[], topKmh:number}} engine definition
 */
export function engineDef(type) { return ENGINES[type] || ENGINES.street; }

/**
 * Simulated gearbox: speed -> gear index (0-based) and rpm fraction (0 idle .. 1 redline).
 * Within a gear rpm rises linearly with speed; at an upshift it drops to the ratio of the neighbouring gear tops.
 * @param {string} type bike type
 * @param {number} speedMs forward speed in m/s (sign ignored)
 * @param {number} [topMs] top speed in m/s (default from the engine definition)
 * @param {{gear:number, rpm:number}} [out] result object to fill (avoids allocation)
 * @returns {{gear:number, rpm:number}} gear and normalised rpm
 */
export function gearAndRpm(type, speedMs, topMs, out = { gear: 0, rpm: 0 }) {
  const d = engineDef(type);
  const top = topMs > 0 ? topMs : d.topKmh / 3.6;
  const f = clamp(Math.abs(speedMs) / top, 0, 1);
  let g = 0;
  while (g < d.gears.length - 1 && f >= d.gears[g]) g++;
  out.gear = g;
  out.rpm = clamp(f / d.gears[g], 0, 1);
  return out;
}

/**
 * Fundamental pitch of the engine (Hz): idle at standstill, redHz at the top of a gear. Monotonic within a gear, drops on an upshift.
 * @param {string} type bike type
 * @param {number} speedMs forward speed in m/s
 * @param {number} [topMs] top speed in m/s
 * @returns {number} Hz
 */
export function engineHz(type, speedMs, topMs) {
  const d = engineDef(type);
  const r = gearAndRpm(type, speedMs, topMs, _tmp).rpm;
  return d.idleHz + (d.redHz - d.idleHz) * r;
}
const _tmp = { gear: 0, rpm: 0 };

/**
 * Engine loudness 0..1: a quiet idle that swells with throttle and rpm.
 * @param {number} throttle 0..1
 * @param {number} rpm normalised rpm 0..1
 * @returns {number} gain 0..1
 */
export function engineLoudness(throttle, rpm) {
  const t = clamp(throttle, 0, 1);
  return 0.22 + 0.5 * t * (0.6 + 0.4 * rpm) + 0.18 * rpm;
}

/**
 * Brightness (lowpass cutoff, Hz) of the engine: opens with throttle and rpm, hard-capped so the top end stays rounded.
 * @param {number} throttle 0..1
 * @param {number} rpm normalised rpm 0..1
 * @returns {number} Hz, 380..3600
 */
export function engineBrightness(throttle, rpm) {
  return clamp(380 + 1900 * clamp(throttle, 0, 1) + 1300 * rpm, 380, 3600);
}

/**
 * Wind noise level for a speed.
 * @param {number} speedMs speed in m/s
 * @returns {number} gain 0..0.5
 */
export function windGain(speedMs) {
  const k = clamp(Math.abs(speedMs) / 52, 0, 1);
  return 0.5 * k * k;
}

/**
 * Gain of a distant engine (rival or traffic) by distance.
 * @param {number} dist metres
 * @returns {number} 0..1, 0 beyond 90 m
 */
export function distanceGain(dist) {
  if (dist >= 90) return 0;
  const q = dist / 14;
  return (1 / (1 + q * q)) * (1 - dist / 90);
}

/**
 * Cheap Doppler pitch factor. Positive closing speed (approaching) raises the pitch. The effect is exaggerated 2x for game feel.
 * @param {number} closingMs closing speed in m/s (positive = getting closer)
 * @returns {number} pitch multiplier 0.8..1.25
 */
export function dopplerFactor(closingMs) {
  return clamp(SOUND_SPEED / (SOUND_SPEED - 2 * clamp(closingMs, -60, 60)), 0.8, 1.25);
}
