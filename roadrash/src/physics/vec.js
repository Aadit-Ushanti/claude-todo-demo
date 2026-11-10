// Small vector / scalar helpers. Vectors are plain objects {x, y, z}.
// Pure logic: no DOM, no three.js.

/**
 * Create a vector.
 * @param {number} [x=0]
 * @param {number} [y=0]
 * @param {number} [z=0]
 * @returns {{x:number,y:number,z:number}}
 */
export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/**
 * Component-wise sum a + b (new vector).
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {{x:number,y:number,z:number}}
 */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Component-wise difference a - b (new vector).
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {{x:number,y:number,z:number}}
 */
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Scale a vector by a scalar (new vector).
 * @param {{x:number,y:number,z:number}} a
 * @param {number} s
 * @returns {{x:number,y:number,z:number}}
 */
export function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/**
 * Dot product.
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {number}
 */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Cross product a x b (new vector).
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {{x:number,y:number,z:number}}
 */
export function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Euclidean length.
 * @param {{x:number,y:number,z:number}} a
 * @returns {number}
 */
export function len(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/**
 * Normalised copy; the zero vector maps to the zero vector.
 * @param {{x:number,y:number,z:number}} a
 * @returns {{x:number,y:number,z:number}}
 */
export function norm(a) {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

/**
 * Linear interpolation. Works on numbers (lerp(a,b,t)) and on vectors.
 * @template T
 * @param {T} a start (number or vector)
 * @param {T} b end (number or vector)
 * @param {number} t blend factor, 0 -> a, 1 -> b
 * @returns {T}
 */
export function lerp(a, b, t) {
  if (typeof a === 'number') return a + (b - a) * t;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Clamp x into [a, b].
 * @param {number} x
 * @param {number} a lower bound
 * @param {number} b upper bound
 * @returns {number}
 */
export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

/**
 * Wrap an angle into (-PI, PI].
 * @param {number} a angle in radians
 * @returns {number}
 */
export function wrapAngle(a) {
  const TAU = Math.PI * 2;
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}
