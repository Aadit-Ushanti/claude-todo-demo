// Per-theme look: time of day lighting and terrain character.
export const TOD = {
  noon:      { elev: 62, az: 25,  col: 0xfff4e0, sun: 1.25, hemi: 0.80, fill: 0.25, glow: [1.0, 0.9, 0.7, 0.25], clouds: 1 },
  afternoon: { elev: 36, az: 155, col: 0xffe2b8, sun: 1.25, hemi: 0.70, fill: 0.25, glow: [1.0, 0.8, 0.5, 0.35], clouds: 1 },
  dawn:      { elev: 8,  az: -25, col: 0xffc08a, sun: 1.05, hemi: 0.62, fill: 0.35, glow: [1.0, 0.55, 0.28, 0.75], clouds: 1 },
  sunset:    { elev: 6,  az: 22,  col: 0xff9a52, sun: 1.15, hemi: 0.58, fill: 0.35, glow: [1.0, 0.42, 0.16, 0.85], clouds: 1 },
  morning:   { elev: 24, az: -30, col: 0xfff0d0, sun: 1.15, hemi: 0.72, fill: 0.28, glow: [1.0, 0.85, 0.6, 0.4], clouds: 1 },
};

// Terrain character. amp: hill height (m); freq: noise frequency (1/m); rampStart/rampLen (m beyond the road edge).
export const TERRAIN = {
  pines:    { amp: 46, freq: 1 / 170, oct: 4, rampStart: 5, rampLen: 70, terrace: 0, rock: 0x8b877f, rockSlope: 0.80, tint: 0.22, fog: [70, 640], mount: { r: 1150, h: 340, snow: 1 }, tarmac: 0x46464b, gnd2: 0x5f6b44 },
  palms:    { amp: 26, freq: 1 / 210, oct: 3, rampStart: 6, rampLen: 60, terrace: 0, rock: 0xa89d84, rockSlope: 0.70, tint: 0.12, fog: [90, 720], mount: { r: 1200, h: 130, snow: 0 }, tarmac: 0x4a4a4e, gnd2: 0x8a9a5b, sea: true },
  redwoods: { amp: 24, freq: 1 / 140, oct: 3, rampStart: 4, rampLen: 50, terrace: 0, rock: 0x5b5246, rockSlope: 0.72, tint: 0.20, fog: [20, 330], mount: { r: 900, h: 170, snow: 0 }, tarmac: 0x4a4b50, gnd2: 0x4a6638 },
  cactus:   { amp: 30, freq: 1 / 260, oct: 3, rampStart: 8, rampLen: 70, terrace: 1, rock: 0xb4693c, rockSlope: 0.66, tint: 0.14, fog: [110, 760], mount: { r: 1200, h: 230, snow: 0 }, tarmac: 0x55524f, gnd2: 0xbf7f45 },
  oaks:     { amp: 22, freq: 1 / 230, oct: 3, rampStart: 6, rampLen: 70, terrace: 0, rock: 0x8d8a78, rockSlope: 0.78, tint: 0.20, fog: [100, 700], mount: { r: 1200, h: 220, snow: 0 }, tarmac: 0x48484c, gnd2: 0x9aa545 },
};

// Per-theme colour grading (exposure, saturation, warm/cool split toning for the high-tier post pass) and environment strength.
export const GRADE = {
  pines:    { exp: 0.92, sat: 1.08, warm: [1.04, 1.0, 0.94], cool: [0.94, 0.99, 1.07], env: 0.85 },
  palms:    { exp: 0.88, sat: 1.12, warm: [1.07, 1.0, 0.90], cool: [0.92, 1.0, 1.08], env: 0.95 },
  redwoods: { exp: 1.25, sat: 1.05, warm: [1.04, 1.02, 0.92], cool: [0.90, 1.02, 1.04], env: 0.9 },
  cactus:   { exp: 0.9,  sat: 1.14, warm: [1.10, 0.99, 0.86], cool: [0.92, 0.98, 1.10], env: 0.9 },
  oaks:     { exp: 0.92, sat: 1.1,  warm: [1.05, 1.0, 0.92], cool: [0.94, 1.0, 1.06], env: 0.9 },
};
