// The five courses. Each is a compact segment list produced by a deterministic seeded generator
// at module load (same segments every run). Headings are bounded to well under 90 degrees from
// -Z, so z strictly decreases along every course and none can ever cross itself.
//
// Segment: { len (m), curve (1/m, + = left), grade (rise/run), bank (rad, + into a left turn) }.

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const even = (v) => Math.max(4, Math.round(v / 2) * 2);

/**
 * Expand a character description into a segment list.
 * cfg: { target, limit (rad, max |heading|), alt (prob. of flipping direction), bankK, bankMax,
 *        gradeAt(s, rng) -> grade, next(ctx) pushes one piece }
 */
function generate(seed, cfg) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const segs = [];
  let total = 0, heading = 0, lastSign = rng() < 0.5 ? 1 : -1;
  const push = (len, curve, grade) => {
    len = even(len);
    const bank = curve ? Math.max(-cfg.bankMax, Math.min(cfg.bankMax, curve * cfg.bankK)) : 0;
    segs.push({ len, curve: r6(curve), grade: r6(grade), bank: r6(bank) });
    total += len;
    return len;
  };
  const ctx = {
    rng, R,
    get total() { return total; },
    grade: (len) => cfg.gradeAt(total + len / 2, rng),
    straight(len, grade) { push(len, 0, grade === undefined ? cfg.gradeAt(total + len / 2, rng) : grade); },
    raw: push,
    /** A constant-radius arc; direction alternates with probability cfg.alt, limited by heading bounds. */
    arc(radius, len, grade) {
      let sign = rng() < cfg.alt ? -lastSign : lastSign;
      const room = (sg) => (sg > 0 ? cfg.limit - heading : cfg.limit + heading);
      if (room(sign) < 0.25) sign = -sign;
      len = even(Math.min(len, room(sign) * radius));
      if (len < 12) len = 12;
      heading += sign * len / radius;
      lastSign = sign;
      push(len, sign / radius, grade === undefined ? cfg.gradeAt(total + len / 2, rng) : grade);
    },
  };
  push(cfg.startLen || 90, 0, 0); // flat grid straight
  while (total < cfg.target - 100) cfg.next(ctx);
  push(100, 0, 0); // flat run-out past the finish line
  return segs;
}

const sum = (segs) => segs.reduce((a, s) => a + s.len, 0);

function course(def, cfg) {
  const segments = generate(def.seed, cfg);
  return {
    lanes: 2, halfWidth: 5.0, shoulder: 2.5,
    ...def,
    lengthM: sum(segments),
    segments,
  };
}

// Sierra Nevada: long mountain sweepers, a few tighter bends, a big net climb.
const sierra = course({
  id: 'sierra', name: 'Sierra Nevada', seed: 1101, blend: 36, gblend: 40,
  theme: { sky: '#8fb8e6', fog: '#c5d6ea', ground: '#7c7a6c', roadside: 'pines', timeOfDay: 'noon' },
}, {
  target: 6400, limit: 1.25, alt: 0.7, bankK: 5, bankMax: 0.06,
  gradeAt: (s, rng) => 0.045 + 0.04 * Math.sin(s / 520) + (rng() - 0.5) * 0.03,
  next(c) {
    const t = c.rng();
    if (t < 0.18) c.arc(c.R(70, 110), c.R(110, 190));       // tighter mountain bend
    else if (t < 0.85) c.arc(c.R(120, 320), c.R(150, 340)); // sweeper
    else c.straight(c.R(60, 160));
    if (c.rng() < 0.35) c.straight(c.R(30, 90));
  },
});

// Pacific Coast: flowing, medium-radius coastal curves, gentle rolling grade.
const coast = course({
  id: 'coast', name: 'Pacific Coast', seed: 2202, blend: 40, gblend: 36,
  theme: { sky: '#9fd0f0', fog: '#dcecf5', ground: '#c9b98a', roadside: 'palms', timeOfDay: 'afternoon' },
}, {
  target: 6000, limit: 1.0, alt: 0.88, bankK: 4, bankMax: 0.045,
  gradeAt: (s) => 0.022 * Math.sin(s / 150 + 0.7) + 0.008 * Math.sin(s / 61),
  next(c) {
    c.arc(c.R(150, 400), c.R(120, 280));
    if (c.rng() < 0.3) c.straight(c.R(40, 120));
  },
});

// Redwood Forest: tight and twisty, short alternating bends, damp rolling grade.
const redwood = course({
  id: 'redwood', name: 'Redwood Forest', seed: 3303, blend: 24, gblend: 28,
  theme: { sky: '#7f9e8a', fog: '#6f8a78', ground: '#4a3b2a', roadside: 'redwoods', timeOfDay: 'dawn' },
}, {
  target: 4600, limit: 1.3, alt: 0.9, bankK: 6, bankMax: 0.07,
  gradeAt: (s, rng) => 0.03 * Math.sin(s / 80 + 1.1) + (rng() - 0.5) * 0.015,
  next(c) {
    c.arc(c.R(56, 105), c.R(40, 115)); // was R(28, 85): the tightest bends could not be taken above ~45 km/h
    if (c.rng() < 0.4) c.straight(c.R(14, 50));
  },
});

// Palm Desert: long fast straights, wide gentle sweeps, sharp crests that launch bikes.
// (BikePhysics only leaves the ground when the surface falls away within about one 60 Hz step; gblend 2, was 4, after the bikes lost 22 % of their speed,
// so the crest apex is deliberately abrupt: slope flips from +g to -g over ~4 m.)
const desert = course({
  id: 'desert', name: 'Palm Desert', seed: 4404, blend: 40, gblend: 2,
  theme: { sky: '#f0c987', fog: '#f1dcb0', ground: '#d7a85f', roadside: 'cactus', timeOfDay: 'sunset' },
}, {
  target: 6800, limit: 0.7, alt: 0.8, bankK: 3, bankMax: 0.03,
  gradeAt: () => 0.004,
  next(c) {
    c.straight(c.R(220, 520), 0.003);
    const t = c.rng();
    if (t < 0.55) { // crest: steep rise then fall with a near-sharp apex that launches a fast bike
      const g = c.R(0.08, 0.1);
      c.raw(c.R(50, 70), 0, g);
      c.raw(c.R(50, 70), 0, -g);
    } else if (t < 0.8) { // dip then a rise
      const g = c.R(0.03, 0.045);
      c.raw(c.R(50, 70), 0, -g);
      c.raw(c.R(50, 70), 0, g);
    } else c.arc(c.R(700, 1500), c.R(300, 560), 0.002);
    if (c.rng() < 0.5) c.arc(c.R(600, 1200), c.R(260, 520), 0.002);
  },
});

// Grass Valley: rolling hills, medium curves.
const valley = course({
  id: 'valley', name: 'Grass Valley', seed: 5505, blend: 34, gblend: 40,
  theme: { sky: '#a8d4f2', fog: '#d5e5d0', ground: '#6f8f3c', roadside: 'oaks', timeOfDay: 'morning' },
}, {
  target: 5200, limit: 1.1, alt: 0.8, bankK: 4, bankMax: 0.05,
  gradeAt: (s, rng) => 0.045 * Math.sin(s / 70) + (rng() - 0.5) * 0.012,
  next(c) {
    c.arc(c.R(110, 330), c.R(110, 240));
    if (c.rng() < 0.4) c.straight(c.R(40, 110));
  },
});

/** The five courses by id. */
export const TRACKS = { sierra, coast, redwood, desert, valley };
