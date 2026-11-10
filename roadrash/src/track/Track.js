// Track geometry: builds a point-to-point road from a compact segment description.
// Pure logic: no DOM, no three.js. SI units. World: +Y up; yaw 0 faces -Z, +yaw turns left;
// forward = (-sin yaw, 0, -cos yaw), left = (-cos yaw, 0, sin yaw). +d is LEFT of the centre line.
//
// Segment fields: len (m of horizontal run), curve (1/m, + = left), grade (rise/run),
// bank (rad, optional; + = road tilts into a left turn, i.e. the left edge is lower).
// Values are eased between segments with a smoothstep (blend width min(def.blend, half the
// shorter neighbour)), so heading is C1 and height is continuous.

const STEP = 2; // sample spacing along s (m)
const SUB = 8; // integration substeps per sample

function ss(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

function wrap(a) {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Deterministic hash of an integer lattice point to [0,1). */
function hash(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1), deterministic in (x, z, seed). */
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Build an eased piecewise-constant profile evaluator (stateful pointer; fast for monotone s). */
function makeProfile(starts, vals, blends) {
  const m = vals.length;
  let idx = 0;
  return function profile(s) {
    while (idx < m - 1 && s >= starts[idx + 1]) idx++;
    while (idx > 0 && s < starts[idx]) idx--;
    if (idx > 0) {
      const w = blends[idx];
      const ds = s - starts[idx];
      if (ds < w * 0.5) return vals[idx - 1] + (vals[idx] - vals[idx - 1]) * ss((ds + w * 0.5) / w);
    }
    if (idx < m - 1) {
      const w = blends[idx + 1];
      const de = starts[idx + 1] - s;
      if (de < w * 0.5) return vals[idx] + (vals[idx + 1] - vals[idx]) * ss((w * 0.5 - de) / w);
    }
    return vals[idx];
  };
}

/** A built, immutable track. Use {@link buildTrack}. */
class Track {
  constructor(def) {
    const segs = def.segments;
    if (!segs || !segs.length) throw new Error('track def has no segments');
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.halfWidth = def.halfWidth ?? 5.0;
    this.shoulder = def.shoulder ?? 2.5;
    this.seed = def.seed | 0;
    this._edge = this.halfWidth + this.shoulder;

    const m = segs.length;
    const starts = new Float64Array(m);
    const curveV = new Float64Array(m), gradeV = new Float64Array(m), bankV = new Float64Array(m);
    const cBl = new Float64Array(m), gBl = new Float64Array(m);
    let total = 0;
    const cb = def.blend ?? 30, gb = def.gblend ?? 30;
    for (let k = 0; k < m; k++) {
      const sg = segs[k];
      starts[k] = total;
      total += sg.len;
      curveV[k] = sg.curve || 0;
      gradeV[k] = sg.grade || 0;
      bankV[k] = sg.bank || 0;
      if (k > 0) {
        const lim = 0.5 * Math.min(segs[k - 1].len, sg.len);
        cBl[k] = Math.max(0.5, Math.min(cb, lim));
        gBl[k] = Math.max(0.5, Math.min(gb, lim));
      }
    }
    /** Total length (m), the sum of the segment lengths. */
    this.length = total;
    /** Finish line s. */
    this.finishS = total - 30;
    const curveF = makeProfile(starts, curveV, cBl);
    const gradeF = makeProfile(starts, gradeV, gBl);
    const bankF = makeProfile(starts, bankV, cBl);

    const n = Math.ceil(total / STEP) + 1;
    this.n = n;
    const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    const YAW = new Float64Array(n), K = new Float64Array(n), GR = new Float64Array(n), BK = new Float64Array(n);
    const HX = new Float64Array(n), HZ = new Float64Array(n);
    let x = 0, y = 0, z = 0, yaw = 0;
    const h = STEP / SUB;
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      X[i] = x; Y[i] = y; Z[i] = z; YAW[i] = yaw;
      K[i] = curveF(s); GR[i] = gradeF(s); BK[i] = bankF(s);
      HX[i] = -Math.sin(yaw); HZ[i] = -Math.cos(yaw);
      for (let j = 0; j < SUB; j++) {
        const s0 = s + j * h;
        const k0 = curveF(s0);
        const ym = yaw + k0 * h * 0.5;
        x += -Math.sin(ym) * h;
        z += -Math.cos(ym) * h;
        yaw += curveF(s0 + h * 0.5) * h;
        y += gradeF(s0 + h * 0.5) * h;
      }
    }
    this._X = X; this._Y = Y; this._Z = Z; this._YAW = YAW; this._K = K; this._GR = GR; this._BK = BK;
    this._HX = HX; this._HZ = HZ;
    this._maxS = (n - 1) * STEP;

    const f32 = (a) => Float32Array.from(a);
    const lx = new Float32Array(n), lz = new Float32Array(n), ywr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = wrap(YAW[i]);
      ywr[i] = w;
      lx[i] = -Math.cos(w);
      lz[i] = Math.sin(w);
    }
    /** Sampled centre line for meshing (every 2 m). */
    this.edges = {
      n, step: STEP, cx: f32(X), cy: f32(Y), cz: f32(Z), lx, lz, yaw: ywr,
      curve: f32(K), grade: f32(GR), bank: f32(BK),
    };

    // scratch state (module-internal, no per-call allocation)
    this._x = 0; this._y = 0; this._z = 0; this._yw = 0; this._k = 0; this._g = 0; this._b = 0;
    this._s = 0; this._d = 0;
    this._hint = 0;
    this._nrm = { x: 0, y: 1, z: 0 };
    // physics and AI call these detached (const f = track.gripAt), so bind them
    for (const k of ['sampleAt', 'toTrack', 'heightAt', 'normalAt', 'gripAt', 'startGrid']) this[k] = this[k].bind(this);
  }

  /** Evaluate the centre line at s (clamped) into scratch fields. */
  _eval(s) {
    if (s < 0) s = 0; else if (s > this._maxS) s = this._maxS;
    const f = s / STEP;
    let i = Math.floor(f);
    if (i > this.n - 2) i = this.n - 2;
    if (i < 0) i = 0;
    const t = f - i, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const X = this._X, Z = this._Z, Y = this._Y, HX = this._HX, HZ = this._HZ, GR = this._GR;
    const j = i + 1;
    this._x = h00 * X[i] + h10 * STEP * HX[i] + h01 * X[j] + h11 * STEP * HX[j];
    this._z = h00 * Z[i] + h10 * STEP * HZ[i] + h01 * Z[j] + h11 * STEP * HZ[j];
    this._y = h00 * Y[i] + h10 * STEP * GR[i] + h01 * Y[j] + h11 * STEP * GR[j];
    this._yw = this._YAW[i] + (this._YAW[j] - this._YAW[i]) * t;
    this._k = this._K[i] + (this._K[j] - this._K[i]) * t;
    this._g = GR[i] + (GR[j] - GR[i]) * t;
    this._b = this._BK[i] + (this._BK[j] - this._BK[i]) * t;
  }

  /** Nearest sample index by hill-climbing on squared distance. Returns the index; sets this._bd2. */
  _climb(px, pz, i, maxIter) {
    const X = this._X, Z = this._Z, n = this.n;
    let dx = X[i] - px, dz = Z[i] - pz;
    let best = dx * dx + dz * dz;
    for (let it = 0; it < maxIter; it++) {
      let dm = Infinity, dp = Infinity;
      if (i > 0) { dx = X[i - 1] - px; dz = Z[i - 1] - pz; dm = dx * dx + dz * dz; }
      if (i < n - 1) { dx = X[i + 1] - px; dz = Z[i + 1] - pz; dp = dx * dx + dz * dz; }
      if (dm < best && dm <= dp) { i--; best = dm; }
      else if (dp < best) { i++; best = dp; }
      else break;
    }
    this._bd2 = best;
    return i;
  }

  /** Locate (px,pz) relative to the road; sets this._s, this._d, this._yw (track yaw at s). */
  _locate(px, pz, hintS) {
    const n = this.n;
    let i = -1;
    if (hintS !== undefined && hintS === hintS) {
      let hi = Math.round(hintS / STEP);
      if (hi < 0) hi = 0; else if (hi > n - 1) hi = n - 1;
      i = this._climb(px, pz, hi, 40);
      if (this._bd2 > 400) i = -1; // hint was wrong: fall back to the global search
    }
    if (i < 0) {
      const X = this._X, Z = this._Z;
      let bi = 0, bd = Infinity;
      for (let k = 0; k < n; k += 4) {
        const dx = X[k] - px, dz = Z[k] - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; bi = k; }
      }
      i = this._climb(px, pz, bi, 40);
    }
    // Newton refinement of the foot point on the continuous centre line
    let s = i * STEP;
    for (let it = 0; it < 3; it++) {
      this._eval(s);
      const yw = this._yw;
      const hx = -Math.sin(yw), hz = -Math.cos(yw), lx = -Math.cos(yw), lz = Math.sin(yw);
      const ex = px - this._x, ez = pz - this._z;
      const f = ex * hx + ez * hz;
      const dd = ex * lx + ez * lz;
      let den = 1 - this._k * dd;
      if (den < 0.2) den = 0.2;
      s += f / den;
      if (s < 0) s = 0; else if (s > this.length) s = this.length;
    }
    this._eval(s);
    const yw = this._yw;
    this._d = (px - this._x) * -Math.cos(yw) + (pz - this._z) * Math.sin(yw);
    this._s = s;
  }

  /**
   * Centre-line sample at arc length s (clamped to 0..length).
   * @param {number} s metres along the track
   * @param {object} [out] reused if given
   * @returns {{x:number,y:number,z:number,hx:number,hz:number,yaw:number,curve:number,grade:number,bank:number}}
   */
  sampleAt(s, out) {
    const o = out || { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
    this._eval(s < 0 ? 0 : s > this.length ? this.length : s);
    o.x = this._x; o.y = this._y; o.z = this._z;
    o.hx = -Math.sin(this._yw); o.hz = -Math.cos(this._yw);
    o.yaw = wrap(this._yw);
    o.curve = this._k; o.grade = this._g; o.bank = this._b;
    return o;
  }

  /**
   * Project a world position onto the track.
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} [hintS] previous s for a fast local search; absent/invalid = global coarse search
   * @param {object} [out] reused if given
   * @returns {{s:number,d:number,yaw:number}} s clamped to 0..length, d lateral (+ = left), yaw track heading
   */
  toTrack(x, z, hintS, out) {
    const o = out || { s: 0, d: 0, yaw: 0 };
    this._locate(x, z, hintS);
    o.s = this._s; o.d = this._d; o.yaw = wrap(this._yw);
    return o;
  }

  /** Roughness (m) of the ground outside the shoulder: deterministic in position. */
  _rough(x, z) {
    return (vnoise(x / 6, z / 6, this.seed) - 0.5) * 0.3 + (vnoise(x / 2.3 + 17.1, z / 2.3 - 9.3, this.seed + 7) - 0.5) * 0.12;
  }

  /**
   * Ground height at (x,z): road height at the nearest s plus bank across d; outside the
   * paved width + shoulder the edge height continues with gentle deterministic roughness.
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} y
   */
  heightAt(x, z) {
    this._locate(x, z, this._hint);
    this._hint = this._s;
    const d = this._d, edge = this._edge;
    const ad = d < 0 ? -d : d;
    const dc = d < -edge ? -edge : d > edge ? edge : d;
    let y = this._y - dc * Math.tan(this._b);
    if (ad > edge) y += this._rough(x, z) * ss((ad - edge) / 2.5);
    return y;
  }

  /**
   * Ground normal at (x,z) (finite differences of heightAt).
   * @param {number} x world x
   * @param {number} z world z
   * @param {{x:number,y:number,z:number}} [out] reused if given
   * @returns {{x:number,y:number,z:number}} unit normal
   */
  normalAt(x, z, out) {
    const o = out || this._nrm;
    const e = 0.5;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const il = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
    o.x = -dx * il; o.y = il; o.z = -dz * il;
    return out ? o : { x: o.x, y: o.y, z: o.z };
  }

  /**
   * Surface grip multiplier: 1 on tarmac, 0.9 on the shoulder, 0.7 off-road (the physics turns the missing grip into drag and a little wobble, not into a slide).
   * @param {number} x world x
   * @param {number} z world z
   * @returns {number} 0..1
   */
  gripAt(x, z) {
    this._locate(x, z, this._hint);
    this._hint = this._s;
    const ad = this._d < 0 ? -this._d : this._d;
    return ad <= this.halfWidth ? 1 : ad <= this._edge ? 0.9 : 0.7;
  }

  /**
   * Starting grid slot: 2 columns on the right lane, rows 7 m apart, pole at s=20 (rows behind it).
   * @param {number} i slot 0..14
   * @returns {{pos:{x:number,y:number,z:number}, yaw:number}}
   */
  startGrid(i) {
    const row = i >> 1, col = i & 1;
    const s = 20 - row * 7;
    const d = col === 0 ? -1.1 : -3.0;
    // s may be negative: the first segment is a flat straight along -Z from the origin
    this._eval(Math.max(s, 0));
    const hx = -Math.sin(this._yw), hz = -Math.cos(this._yw);
    const lx = -Math.cos(this._yw), lz = Math.sin(this._yw);
    const back = Math.min(s, 0);
    return {
      pos: { x: this._x + hx * back + lx * d, y: this._y, z: this._z + hz * back + lz * d },
      yaw: wrap(this._yw),
    };
  }
}

/**
 * Build a track from a definition (see tracks.js). Deterministic.
 * @param {object} def course definition ({segments, halfWidth, shoulder, seed, ...})
 * @returns {Track} immutable track
 */
export function buildTrack(def) {
  return new Track(def);
}
