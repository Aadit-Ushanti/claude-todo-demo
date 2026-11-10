// Continuous collision detection in the ground plane (x, z). Pure logic: no DOM, no three.js, no allocation per call
// (results are written into a caller-supplied `out`; module scratch holds the working geometry).
//
// A mover is a CAPSULE {x, z, ux, uz, h, r}: centre (x, z), unit axis (ux, uz), half length h of the core segment, radius r
// (a circle is h = 0). Every sweep moves the mover by the displacement (dx, dz) over the normalised step t in [0, 1] and returns
// the EARLIEST time of impact, or null when nothing is touched (or the pair is separating).
//
//   result = { t, nx, nz, px, pz }
//     t        time of impact in [0, 1] (0: already touching/overlapping and still closing)
//     nx, nz   unit contact normal pointing from the obstacle TOWARD the mover (the same convention as crashSeverity)
//     px, pz   contact point on the mover's surface at the time of impact (world coordinates)
//
// Moving obstacles are handled with relative motion: the obstacle is frozen at its START pose and the mover travels the
// relative displacement; the returned t is valid for both bodies (each is at start + t * its own displacement at impact).
// Orientations are held fixed over the step (yaw changes are tiny at the step sizes used).
//
// Method: capsule vs convex shape S  ==  point (the capsule centre) vs the rounded convex polygon hull(S (+) -segment) inflated by r.
// The point ray is tested against every offset edge and every vertex circle, so a thin wall (a segment with a half thickness) or a
// hull corner can never be tunnelled however fast the mover is.

const EPS = 1e-9;
const MAXP = 24;
const PX = new Float64Array(MAXP), PZ = new Float64Array(MAXP); // working points
const HX = new Float64Array(MAXP), HZ = new Float64Array(MAXP); // convex hull (counter-clockwise in the x-z plane)
let hn = 0;

/**
 * Fill a capsule from a position and heading (yaw 0 faces -Z, the axis runs along the heading).
 * @param {number} x centre x
 * @param {number} z centre z
 * @param {number} yaw heading (rad)
 * @param {number} h half length of the core segment (m)
 * @param {number} r radius (m)
 * @param {object} [out] reused if given
 * @returns {{x:number,z:number,ux:number,uz:number,h:number,r:number}}
 */
export function makeCapsule(x, z, yaw, h, r, out) {
  const o = out || { x: 0, z: 0, ux: 0, uz: -1, h: 0, r: 0 };
  o.x = x; o.z = z; o.ux = -Math.sin(yaw); o.uz = -Math.cos(yaw); o.h = h; o.r = r;
  return o;
}

/**
 * Fill a capsule that is a plain circle.
 * @param {number} x centre x
 * @param {number} z centre z
 * @param {number} r radius
 * @param {object} [out] reused if given
 * @returns {{x:number,z:number,ux:number,uz:number,h:number,r:number}}
 */
export function makeCircle(x, z, r, out) {
  const o = out || { x: 0, z: 0, ux: 1, uz: 0, h: 0, r: 0 };
  o.x = x; o.z = z; o.ux = 1; o.uz = 0; o.h = 0; o.r = r;
  return o;
}

/** Convex hull of the n working points into HX/HZ (monotone chain, counter-clockwise, duplicates removed). */
function buildHull(n) {
  // insertion sort by (x, z)
  for (let i = 1; i < n; i++) {
    const x = PX[i], z = PZ[i];
    let j = i - 1;
    // (x values within 1e-9 count as equal: an axis like (-sin pi, -cos pi) must not reorder collinear points)
    while (j >= 0 && (PX[j] > x + 1e-9 || (PX[j] >= x - 1e-9 && PZ[j] > z))) { PX[j + 1] = PX[j]; PZ[j + 1] = PZ[j]; j--; }
    PX[j + 1] = x; PZ[j + 1] = z;
  }
  // drop exact (and near) duplicates
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (m > 0 && Math.abs(PX[i] - PX[m - 1]) < 1e-9 && Math.abs(PZ[i] - PZ[m - 1]) < 1e-9) continue;
    PX[m] = PX[i]; PZ[m] = PZ[i]; m++;
  }
  if (m <= 2) { for (let i = 0; i < m; i++) { HX[i] = PX[i]; HZ[i] = PZ[i]; } hn = m; return; }
  let k = 0;
  for (let i = 0; i < m; i++) { // lower hull
    while (k >= 2 && cross3(HX[k - 2], HZ[k - 2], HX[k - 1], HZ[k - 1], PX[i], PZ[i]) <= 1e-12) k--;
    HX[k] = PX[i]; HZ[k] = PZ[i]; k++;
  }
  const lo = k + 1;
  for (let i = m - 2; i >= 0; i--) { // upper hull
    while (k >= lo && cross3(HX[k - 2], HZ[k - 2], HX[k - 1], HZ[k - 1], PX[i], PZ[i]) <= 1e-12) k--;
    HX[k] = PX[i]; HZ[k] = PZ[i]; k++;
  }
  hn = k - 1;
}
function cross3(ax, az, bx, bz, cx, cz) { return (bx - ax) * (cz - az) - (bz - az) * (cx - ax); }

/**
 * Ray (origin 0,0; displacement dx,dz over t in [0,1]) against the hull inflated by r. Writes t and the normal (from the hull
 * toward the ray point) into out; returns false for no hit.
 */
function rayRounded(dx, dz, r, out) {
  const n = hn;
  const a = dx * dx + dz * dz;
  // ---- already touching or overlapping? nearest point of the hull to the origin ----
  let best = Infinity, bnx = 0, bnz = 0;
  let inside = n >= 3;
  let maxSd = -Infinity, mnx = 0, mnz = 0;
  if (n === 1) {
    const x = -HX[0], z = -HZ[0];
    best = x * x + z * z; bnx = x; bnz = z;
  } else {
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ex = HX[j] - HX[i], ez = HZ[j] - HZ[i];
      const el2 = ex * ex + ez * ez;
      const ox = -HX[i], oz = -HZ[i];
      let u = el2 > EPS ? (ox * ex + oz * ez) / el2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const cx = ox - ex * u, cz = oz - ez * u;
      const d2 = cx * cx + cz * cz;
      if (d2 < best) { best = d2; bnx = cx; bnz = cz; }
      if (n >= 3) {
        const el = Math.sqrt(el2) || 1;
        const sdd = (ox * ez - oz * ex) / el; // signed distance of the origin outside edge i (outward normal (ez, -ex) / el)
        if (sdd > 0) inside = false;
        if (sdd > maxSd) { maxSd = sdd; mnx = ez / el; mnz = -ex / el; }
      }
    }
  }
  if (inside && n >= 3) { // the centre is inside the hull: leaving through the nearest face is a separation, anything else is stuck (t = 0)
    if (a > 0 && mnx * dx + mnz * dz > 0) return false;
    out.t = 0; out.nx = mnx; out.nz = mnz; return true;
  }
  if (best < (r - 1e-9) * (r - 1e-9)) {
    let l = Math.sqrt(best);
    if (l < 1e-9) { // origin on the hull boundary: use the longest-reaching edge normal, else against the motion
      const al = Math.sqrt(a) || 1;
      out.t = 0; out.nx = a > 0 ? -dx / al : 0; out.nz = a > 0 ? -dz / al : 1; return true;
    }
    // (bnx, bnz) points from the hull point to the origin? it was computed as origin - hull point: yes (ox - closest)
    const nx = bnx / l, nz = bnz / l;
    // origin is inside the rounded shape: a hit at t = 0 only when still moving in
    if (nx * dx + nz * dz < 0 || a === 0) { out.t = 0; out.nx = nx; out.nz = nz; return true; }
    return false;
  }
  if (a < 1e-18) return false;
  let bt = 2, bnx2 = 0, bnz2 = 0;
  // ---- vertex circles ----
  for (let i = 0; i < n; i++) {
    const vx = -HX[i], vz = -HZ[i]; // origin - vertex
    const b = vx * dx + vz * dz;
    if (b >= 0) continue; // moving away
    const c = vx * vx + vz * vz - r * r;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0 || t > 1 || t >= bt) continue;
    bt = t;
    const hx = vx + dx * t, hz = vz + dz * t;
    const l = Math.sqrt(hx * hx + hz * hz) || 1;
    bnx2 = hx / l; bnz2 = hz / l;
  }
  // ---- offset edges ----
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ex = HX[j] - HX[i], ez = HZ[j] - HZ[i];
      const el = Math.sqrt(ex * ex + ez * ez);
      if (el < 1e-12) continue;
      const nx = ez / el, nz = -ex / el;
      const den = nx * dx + nz * dz;
      if (den >= -1e-15) continue;
      const sd = -HX[i] * nx - HZ[i] * nz; // origin distance from the edge line along the outward normal
      const t = (r - sd) / den;
      if (t < 0 || t > 1 || t >= bt) continue;
      const hx = -HX[i] + dx * t, hz = -HZ[i] + dz * t; // hit centre minus edge start
      const u = (hx * ex + hz * ez) / el;
      if (u < 0 || u > el) continue;
      bt = t; bnx2 = nx; bnz2 = nz;
    }
  }
  if (bt > 1) return false;
  out.t = bt; out.nx = bnx2; out.nz = bnz2;
  return true;
}

/** Finish a result: contact point on the mover's surface at impact. */
function finish(cap, dx, dz, hit, out) {
  const t = hit.t;
  const cx = cap.x + dx * t, cz = cap.z + dz * t;
  const nx = hit.nx, nz = hit.nz;
  // the axis endpoint most toward the obstacle (-n direction)
  const along = nx * cap.ux + nz * cap.uz;
  let ex = cx, ez = cz;
  if (cap.h > 0 && Math.abs(along) * cap.h > 1e-4) {
    const s = along > 0 ? -1 : 1; // endpoint c + s*h*u has the smaller n . point
    ex = cx + s * cap.h * cap.ux; ez = cz + s * cap.h * cap.uz;
  }
  out.t = t; out.nx = nx; out.nz = nz;
  out.px = ex - nx * cap.r; out.pz = ez - nz * cap.r;
  return out;
}

const _hit = { t: 0, nx: 0, nz: 0 };

/** Load hull of {obstacle points} (+) {-axis endpoints}, relative to the mover centre, from n points in (PX, PZ) already offset. */
function loadMinkowski(cap, nObs, ox, oz) {
  // PX/PZ [0..nObs) hold the obstacle points relative to the mover centre; expand by +/- h u
  const h = cap.h, hx = cap.ux * h, hz = cap.uz * h;
  void ox; void oz;
  if (h <= 0) { buildHull(nObs); return; }
  let m = nObs;
  for (let i = 0; i < nObs; i++) {
    const x = PX[i], z = PZ[i];
    PX[i] = x + hx; PZ[i] = z + hz;
    PX[m] = x - hx; PZ[m] = z - hz; m++;
  }
  buildHull(m);
}

/**
 * Sweep a capsule against an infinite plane (a line in the x-z plane) with its free side along (nx, nz).
 * @param {{x:number,z:number,ux:number,uz:number,h:number,r:number}} cap mover
 * @param {number} dx displacement x over the step
 * @param {number} dz displacement z over the step
 * @param {number} px a point on the plane
 * @param {number} pz a point on the plane
 * @param {number} nx plane normal x (unit, toward the free side)
 * @param {number} nz plane normal z
 * @param {object} out {t,nx,nz,px,pz} written
 * @returns {object|null} out, or null for no hit
 */
export function sweepCapsulePlane(cap, dx, dz, px, pz, nx, nz, out) {
  const ext = cap.r + cap.h * Math.abs(nx * cap.ux + nz * cap.uz);
  const sd0 = (cap.x - px) * nx + (cap.z - pz) * nz - ext;
  const slope = dx * nx + dz * nz;
  let t;
  if (sd0 < 0) { if (slope >= 0) return null; t = 0; }
  else { if (slope >= -1e-15) return null; t = -sd0 / slope; if (t > 1) return null; }
  _hit.t = t; _hit.nx = nx; _hit.nz = nz;
  return finish(cap, dx, dz, _hit, out);
}

/**
 * Sweep a capsule against a static thick wall segment (the segment inflated by halfThickness).
 * @param {{x:number,z:number,ux:number,uz:number,h:number,r:number}} cap mover
 * @param {number} dx displacement x
 * @param {number} dz displacement z
 * @param {number} ax segment start x
 * @param {number} az segment start z
 * @param {number} bx segment end x
 * @param {number} bz segment end z
 * @param {number} halfThickness half the wall thickness (0.1 for a 0.2 m wall)
 * @param {object} out result
 * @returns {object|null}
 */
export function sweepCapsuleSegment(cap, dx, dz, ax, az, bx, bz, halfThickness, out) {
  PX[0] = ax - cap.x; PZ[0] = az - cap.z; PX[1] = bx - cap.x; PZ[1] = bz - cap.z;
  loadMinkowski(cap, 2);
  if (!rayRounded(dx, dz, cap.r + halfThickness, _hit)) return null;
  return finish(cap, dx, dz, _hit, out);
}

/**
 * Sweep a capsule against an oriented box that is itself moving (relative motion).
 * @param {{x:number,z:number,ux:number,uz:number,h:number,r:number}} cap mover (start pose)
 * @param {number} dx mover displacement x over the step
 * @param {number} dz mover displacement z
 * @param {{x:number,z:number,yaw:number,hl:number,hw:number}} box box START pose: centre, heading (yaw 0 faces -Z), half length along the heading, half width
 * @param {number} bdx box displacement x over the step
 * @param {number} bdz box displacement z
 * @param {object} out result
 * @returns {object|null} t is the shared time of impact; the normal points from the box toward the mover
 */
export function sweepCapsuleBox(cap, dx, dz, box, bdx, bdz, out) {
  const fx = -Math.sin(box.yaw), fz = -Math.cos(box.yaw), lx = -fz, lz = fx; // forward, left = (-cos, sin)
  const bx = box.x - cap.x, bz = box.z - cap.z;
  let n = 0;
  for (let i = -1; i <= 1; i += 2) {
    for (let j = -1; j <= 1; j += 2) {
      PX[n] = bx + fx * box.hl * i + lx * box.hw * j; PZ[n] = bz + fz * box.hl * i + lz * box.hw * j; n++;
    }
  }
  loadMinkowski(cap, 4);
  const rdx = dx - bdx, rdz = dz - bdz;
  if (!rayRounded(rdx, rdz, cap.r, _hit)) return null;
  return finish(cap, dx, dz, _hit, out);
}

/**
 * Sweep a capsule against another moving capsule (relative motion), e.g. bike vs bike.
 * @param {{x:number,z:number,ux:number,uz:number,h:number,r:number}} a mover (start pose)
 * @param {number} adx a displacement x over the step
 * @param {number} adz a displacement z
 * @param {{x:number,z:number,ux:number,uz:number,h:number,r:number}} b other capsule (start pose)
 * @param {number} bdx b displacement x
 * @param {number} bdz b displacement z
 * @param {object} out result
 * @returns {object|null} the normal points from b toward a
 */
export function sweepCapsuleCapsule(a, adx, adz, b, bdx, bdz, out) {
  const ox = b.x - a.x, oz = b.z - a.z;
  PX[0] = ox + b.ux * b.h; PZ[0] = oz + b.uz * b.h;
  PX[1] = ox - b.ux * b.h; PZ[1] = oz - b.uz * b.h;
  loadMinkowski(a, 2);
  if (!rayRounded(adx - bdx, adz - bdz, a.r + b.r, _hit)) return null;
  return finish(a, adx, adz, _hit, out);
}

/**
 * The motion left after an impact at time t, with the component into the obstacle removed (slide along it).
 * @param {number} dx full displacement x of the step
 * @param {number} dz full displacement z
 * @param {number} t time of impact
 * @param {number} nx contact normal x (toward the mover)
 * @param {number} nz contact normal z
 * @param {{x:number,z:number}} out written: remaining displacement
 * @returns {{x:number,z:number}} out
 */
export function slideRemainder(dx, dz, t, nx, nz, out) {
  let rx = dx * (1 - t), rz = dz * (1 - t);
  const into = rx * nx + rz * nz;
  if (into < 0) { rx -= into * nx; rz -= into * nz; }
  out.x = rx; out.z = rz;
  return out;
}
