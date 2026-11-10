// Spline space: a compact, track-relative coordinate system. A position is (progress, lane): progress in 0..1 along the
// centre line (arc length s / track.length), lane in metres (+ = left of the centre line, the same sign as Track's d).
// Pure logic, reads the built Track only (no change to Track.js); no allocation when `out` objects are passed.
//
// The centre line is a chain of cubic Hermite spans (one per 2 m of s). bezierSpan() converts a span to its exact cubic
// Bezier control points, e.g. for a renderer, a spline-following camera or a network proposal (docs/SPLINE-PACKING.md).

const TAU_LANE_MAX = 327.67;

/**
 * World position to spline space.
 * @param {object} track built Track
 * @param {number} x world x
 * @param {number} z world z
 * @param {number} [hint] previous progress (0..1) for a fast local search; absent/NaN = global search
 * @param {{progress:number,lane:number,s:number,yaw:number}} [out] reused if given
 * @returns {{progress:number,lane:number,s:number,yaw:number}} progress 0..1, lane in m (+ = left), s in m along the track, yaw = track heading there
 */
export function toSpline(track, x, z, hint, out) {
  const o = out || { progress: 0, lane: 0, s: 0, yaw: 0 };
  const L = track.length;
  track.toTrack(x, z, hint === hint && hint !== undefined && hint !== null ? hint * L : undefined, _tt);
  o.s = _tt.s; o.progress = _tt.s / L; o.lane = _tt.d; o.yaw = _tt.yaw;
  return o;
}
const _tt = { s: 0, d: 0, yaw: 0 };
const _sm = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };

/**
 * Spline space to world: the road-surface point at (progress, lane) and the track heading there.
 * y is the banked road height (as Track.heightAt on the paved width and shoulder; the lane is clamped to it).
 * @param {object} track built Track
 * @param {number} progress 0..1 (clamped)
 * @param {number} lane metres, + = left
 * @param {{x:number,y:number,z:number,yaw:number}} [out] reused if given
 * @returns {{x:number,y:number,z:number,yaw:number}}
 */
export function fromSpline(track, progress, lane, out) {
  const o = out || { x: 0, y: 0, z: 0, yaw: 0 };
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const m = track.sampleAt(p * track.length, _sm);
  const lx = m.hz, lz = -m.hx;
  const e = track.halfWidth + track.shoulder;
  const lc = lane < -e ? -e : lane > e ? e : lane;
  o.x = m.x + lx * lane; o.z = m.z + lz * lane;
  o.y = m.y - lc * Math.tan(m.bank);
  o.yaw = m.yaw;
  return o;
}

/**
 * Number of cubic spans in the centre line (span i covers s in [2i, 2i+2]).
 * @param {object} track built Track
 * @returns {number}
 */
export function spanCount(track) { return track.n - 1; }

/**
 * The 4 cubic Bezier control points of span i, converted exactly from the track's cubic Hermite span
 * (P1 = P0 + T0/3, P2 = P3 - T1/3 with T = step * tangent). B(t), t in [0,1], equals sampleAt(step * (i + t)) in x, y, z.
 * @param {object} track built Track
 * @param {number} i span index, 0 .. spanCount-1
 * @param {{x:number,y:number,z:number}[]} [out] array of 4 points, reused if given
 * @returns {{x:number,y:number,z:number}[]} [P0, P1, P2, P3]
 */
export function bezierSpan(track, i, out) {
  const o = out || [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const j = i + 1, k = track.edges.step / 3;
  const X = track._X, Y = track._Y, Z = track._Z, HX = track._HX, HZ = track._HZ, GR = track._GR;
  o[0].x = X[i]; o[0].y = Y[i]; o[0].z = Z[i];
  o[1].x = X[i] + k * HX[i]; o[1].y = Y[i] + k * GR[i]; o[1].z = Z[i] + k * HZ[i];
  o[2].x = X[j] - k * HX[j]; o[2].y = Y[j] - k * GR[j]; o[2].z = Z[j] - k * HZ[j];
  o[3].x = X[j]; o[3].y = Y[j]; o[3].z = Z[j];
  return o;
}

/**
 * Evaluate a cubic Bezier (from bezierSpan) at t.
 * @param {{x:number,y:number,z:number}[]} p 4 control points
 * @param {number} t 0..1
 * @param {{x:number,y:number,z:number}} [out] reused if given
 * @returns {{x:number,y:number,z:number}}
 */
export function bezierPoint(p, t, out) {
  const o = out || { x: 0, y: 0, z: 0 };
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  o.x = a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x;
  o.y = a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y;
  o.z = a * p[0].z + b * p[1].z + c * p[2].z + d * p[3].z;
  return o;
}

/** Bytes of one encoded spline position. */
export const SPLINE_BYTES = 5;

/**
 * Pack (progress, lane) into 5 bytes: progress u24 (little endian, 1/16777215 of the track: 0.42 mm on a 7 km track),
 * lane int16 at 1 cm (range +-327 m, clamped).
 * @param {number} progress 0..1
 * @param {number} lane metres
 * @param {Uint8Array} [buf] destination; a new 5-byte array when omitted
 * @param {number} [off=0] byte offset
 * @returns {Uint8Array} buf
 */
export function encodeSpline(progress, lane, buf, off = 0) {
  const b = buf || new Uint8Array(SPLINE_BYTES);
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const u = Math.round(p * 16777215);
  const l = Math.round((lane < -TAU_LANE_MAX ? -TAU_LANE_MAX : lane > TAU_LANE_MAX ? TAU_LANE_MAX : lane) * 100);
  b[off] = u & 255; b[off + 1] = (u >> 8) & 255; b[off + 2] = (u >> 16) & 255;
  b[off + 3] = l & 255; b[off + 4] = (l >> 8) & 255;
  return b;
}

/**
 * Unpack 5 bytes written by encodeSpline.
 * @param {Uint8Array} buf source
 * @param {number} [off=0] byte offset
 * @param {{progress:number,lane:number}} [out] reused if given
 * @returns {{progress:number,lane:number}}
 */
export function decodeSpline(buf, off = 0, out) {
  const o = out || { progress: 0, lane: 0 };
  o.progress = (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)) / 16777215;
  let l = buf[off + 3] | (buf[off + 4] << 8);
  if (l & 0x8000) l -= 0x10000;
  o.lane = l / 100;
  return o;
}
