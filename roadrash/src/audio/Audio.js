// Procedural game audio: Web Audio only, every sound is synthesized (oscillators, noise buffers, filters, waveshapers).
// No audio files, no downloads, works offline. Everything is safe when the AudioContext is missing or still locked:
// the calls become no-ops and the game runs silent. Pure pitch/loudness maths lives in engineModel.js.
//
// Graph (one shared context):
//   own engine / wind / tyres / gravel / ambient / rival pool / one-shots -> buses -> compressor -> limiter -> master gain -> out
import { gearAndRpm, engineDef, engineLoudness, engineBrightness, windGain, distanceGain, dopplerFactor, clamp } from './engineModel.js';

const MAX_ONESHOTS = 14;
const RIVALS = 4;
const DEFAULT_VOLUME = 0.7;

/** Per bike type timbre: waveforms, detune (cents), third oscillator ratio/wave/level, amplitude wobble (V-twin unevenness), noise level. */
const TIMBRE = {
  sport:   { w1: 'sawtooth', w2: 'sawtooth', det: 14, r3: 2,   w3: 'triangle', g3: 0.45, lfo: 0.05, lfoR: 1,   noise: 0.30, drive: 3.2 },
  street:  { w1: 'sawtooth', w2: 'square',   det: 9,  r3: 0.5, w3: 'square',   g3: 0.50, lfo: 0.16, lfoR: 0.5, noise: 0.22, drive: 2.6 },
  chopper: { w1: 'sawtooth', w2: 'sawtooth', det: 38, r3: 0.5, w3: 'sawtooth', g3: 0.70, lfo: 0.40, lfoR: 0.5, noise: 0.14, drive: 2.2 },
};
const AMBIENT = {
  valley:  { birds: 1.0, sea: 0, dry: 0, leaf: 0.5, pitch: 1.0 },
  sierra:  { birds: 0.7, sea: 0, dry: 0.15, leaf: 0.5, pitch: 1.1 },
  redwood: { birds: 0.8, sea: 0, dry: 0, leaf: 0.8, pitch: 0.85 },
  coast:   { birds: 0.15, sea: 1, dry: 0, leaf: 0.1, pitch: 1.2 },
  desert:  { birds: 0, sea: 0, dry: 1, leaf: 0, pitch: 1 },
};

/**
 * Create the audio engine. Nothing touches the AudioContext until unlock() is called from a user gesture.
 * @returns {object} audio API: unlock, setTrack, update, event, setVolume, getVolume, setMuted, isMuted, suspend, resume, dispose, debug
 */
export function createAudio() {
  let ctx = null;
  let unavailable = typeof globalThis === 'undefined' || !(globalThis.AudioContext || globalThis.webkitAudioContext);
  let volume = DEFAULT_VOLUME, muted = false;
  let suspendedFlag = false, suspendTimer = 0, errors = 0, lastResumeTry = 0;
  let themeId = 'valley', bikeType = '';
  let master = null, limiter = null, comp = null;
  let busEngine = null, busRival = null, busFx = null, busAmb = null;
  let white = null, brown = null, shaper = null, shaperSoft = null;
  const E = {}; // own engine nodes
  const W = {}; // wind, tyres, gravel nodes
  const A = {}; // ambient nodes
  const rivals = [];
  const sh = { gear: 0, rpm: 0 }; // scratch for gearAndRpm
  let oneShots = 0;
  let engineHz = 0, lastGear = 0, shiftT = 0, rnd = 0x9e3779b9, jitter = 1, jitterT = 0;
  let wasAir = false, airT = 0, birdT = 2, nextBump = 0, burbleT = 0;
  const bumpPrev = new Uint8Array(32); // nearby contact flags per nearby index (bike-bike bumps)
  let clock = 0;
  const chosen = new Int16Array(RIVALS);
  let activeRivals = 0;
  let engineOn = false;

  const rand = () => { rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5; return (rnd >>> 0) / 4294967296; };
  const guard = (fn, fallback) => (...a) => {
    try { return fn(...a); } catch (e) { if (++errors > 40) unavailable = true; return fallback; }
  };

  function ramp(p, v, tc) { p.setTargetAtTime(v, ctx.currentTime, tc); }

  function makeNoise(brownian) {
    const n = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (brownian) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    // crossfade the loop seam so the loop does not tick
    const f = 256;
    for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * k + d[n - f + i] * (1 - k); }
    return buf;
  }
  function curve(k) {
    const c = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i / 255.5) - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }
  const node = (type, v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  function filt(type, f, q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function osc(type, f) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; }
  function loopNoise(buf) { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, rand() * 1.5); return s; }
  function panner() { return ctx.createStereoPanner ? ctx.createStereoPanner() : null; }

  function build() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = node('g', 0);
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 4; comp.attack.value = 0.006; comp.release.value = 0.22;
    comp.connect(limiter); limiter.connect(master); master.connect(ctx.destination);
    busEngine = node('g', 0.55); busRival = node('g', 0.4); busFx = node('g', 0.75); busAmb = node('g', 0.6);
    for (const b of [busEngine, busRival, busFx, busAmb]) b.connect(comp);
    white = makeNoise(false); brown = makeNoise(true);
    shaper = ctx.createWaveShaper(); shaper.curve = curve(3); shaper.oversample = '2x';
    shaperSoft = ctx.createWaveShaper(); shaperSoft.curve = curve(1.6);

    // ---- own engine: 3 detuned oscillators -> waveshaper; shaped noise joins after it; lowpass follows throttle
    E.o1 = osc('sawtooth', 50); E.o2 = osc('sawtooth', 50); E.o3 = osc('triangle', 25);
    E.g3 = node('g', 0.5); E.mix = node('g', 0.3);
    E.o1.connect(E.mix); E.o2.connect(E.mix); E.o3.connect(E.g3); E.g3.connect(E.mix);
    E.mix.connect(shaper);
    E.lp = filt('lowpass', 800, 0.9); E.hp = filt('highpass', 32, 0.7);
    E.body = filt('peaking', 140, 0.8); E.body.gain.value = 5; // chest thump
    shaper.connect(E.body); E.body.connect(E.lp);
    E.nz = loopNoise(white); E.nzf = filt('bandpass', 400, 1.1); E.nzg = node('g', 0.05);
    E.nz.connect(E.nzf); E.nzf.connect(E.nzg); E.nzg.connect(E.lp);
    E.bz = loopNoise(white); E.bzf = filt('bandpass', 170, 2.2); E.bzAM = node('g', 0.5); E.bzg = node('g', 0);
    E.bz.connect(E.bzf); E.bzf.connect(E.bzAM); E.bzAM.connect(E.bzg); E.bzg.connect(E.lp);
    E.bzLfo = osc('sine', 9); E.bzLfoG = node('g', 0.5); E.bzLfo.connect(E.bzLfoG); E.bzLfoG.connect(E.bzAM.gain); // popcorn burble
    E.lp.connect(E.hp);
    E.gain = node('g', 0); E.am = node('g', 1);
    E.hp.connect(E.gain); E.gain.connect(E.am); E.am.connect(busEngine);
    E.lfo = osc('sine', 20); E.lfoG = node('g', 0.1); E.lfo.connect(E.lfoG); E.lfoG.connect(E.am.gain);
    for (const o of [E.o1, E.o2, E.o3, E.bzLfo, E.lfo]) o.start();

    // ---- wind
    W.wn = loopNoise(white); W.wf = filt('bandpass', 700, 0.5); W.wg = node('g', 0);
    W.wn.connect(W.wf); W.wf.connect(W.wg); W.wg.connect(busFx);
    // ---- tyre squeal: narrow band noise + a faint wobbling triangle
    W.sn = loopNoise(white); W.sf = filt('bandpass', 1700, 14); W.sg = node('g', 0);
    W.so = osc('triangle', 1050); W.sog = node('g', 0.25); W.so.start();
    W.sn.connect(W.sf); W.sf.connect(W.sg); W.so.connect(W.sog); W.sog.connect(W.sg); W.sg.connect(busFx);
    // ---- gravel / scrape: crackly band noise + low rumble
    W.gn = loopNoise(white); W.gf = filt('bandpass', 900, 0.7); W.gs = shaperSoft; W.gg = node('g', 0);
    W.rn = loopNoise(brown); W.rf = filt('lowpass', 220, 0.7); W.rg = node('g', 0);
    W.gn.connect(W.gf); W.gf.connect(W.gg); W.gg.connect(busFx);
    W.rn.connect(W.rf); W.rf.connect(W.rg); W.rg.connect(busFx);

    // ---- ambient: sea wash (brown noise, slow swell), dry wind (band noise, slow gusts), leaf rustle; birds are scheduled chirps
    A.sn = loopNoise(brown); A.sf = filt('lowpass', 650, 0.5); A.sg = node('g', 0); A.sw = node('g', 0.5);
    A.sl = osc('sine', 0.11); A.slg = node('g', 0.45); A.sl.connect(A.slg); A.slg.connect(A.sw.gain);
    A.sn.connect(A.sf); A.sf.connect(A.sw); A.sw.connect(A.sg); A.sg.connect(busAmb);
    A.dn = loopNoise(white); A.df = filt('bandpass', 620, 0.9); A.dg = node('g', 0); A.dw = node('g', 0.6);
    A.dl = osc('sine', 0.17); A.dlg = node('g', 0.4); A.dl.connect(A.dlg); A.dlg.connect(A.dw.gain);
    A.dlf = osc('sine', 0.09); A.dlfg = node('g', 220); A.dlf.connect(A.dlfg); A.dlfg.connect(A.df.frequency);
    A.dn.connect(A.df); A.df.connect(A.dw); A.dw.connect(A.dg); A.dg.connect(busAmb);
    A.ln = loopNoise(white); A.lf = filt('bandpass', 2600, 0.6); A.lg = node('g', 0);
    A.ln.connect(A.lf); A.lf.connect(A.lg); A.lg.connect(busAmb);
    A.birds = node('g', 0); A.birds.connect(busAmb);
    for (const o of [A.sl, A.dl, A.dlf]) o.start();

    // ---- pooled rival / traffic voices
    for (let i = 0; i < RIVALS; i++) {
      const v = { id: -1, a: osc('sawtooth', 60), b: osc('square', 60), lp: filt('lowpass', 500, 0.8), g: node('g', 0), p: panner(), gain: 0 };
      v.b.detune.value = 12;
      const bg = node('g', 0.5);
      v.a.connect(v.lp); v.b.connect(bg); bg.connect(v.lp); v.lp.connect(v.g);
      if (v.p) { v.g.connect(v.p); v.p.connect(busRival); } else v.g.connect(busRival);
      v.a.start(); v.b.start();
      rivals.push(v);
    }
    applyTheme();
    applyMaster(0.05);
  }

  function applyMaster(tc) { if (master) ramp(master.gain, muted || suspendedFlag ? 0 : volume, tc); }

  function applyTheme() {
    if (!ctx) return;
    const a = AMBIENT[themeId] || AMBIENT.valley;
    ramp(A.sg.gain, 0.5 * a.sea, 0.8);
    ramp(A.dg.gain, 0.2 * a.dry, 0.8);
    ramp(A.lg.gain, 0.025 * a.leaf, 0.8);
    ramp(A.birds.gain, a.birds > 0 ? 1 : 0, 0.5);
  }

  function setBike(type) {
    const t = TIMBRE[type] || TIMBRE.street;
    bikeType = type;
    E.o1.type = t.w1; E.o2.type = t.w2; E.o3.type = t.w3;
    E.o2.detune.value = t.det; E.g3.gain.value = t.g3;
    E.lfoG.gain.value = t.lfo;
    shaper.curve = curve(t.drive);
  }

  // ------------------------------------------------------------ one-shot synthesis helpers (allocate per event, never per frame)
  function envGain(t0, peak, dur, attack = 0.004) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }
  function track(src, g, stopAt) {
    oneShots++;
    src.onended = () => { oneShots--; try { src.disconnect(); g.disconnect(); } catch (e) { /* gone */ } };
    src.stop(stopAt + 0.02);
  }
  function tone(type, f0, f1, t0, dur, peak, dest, attack) {
    if (oneShots >= MAX_ONESHOTS) return;
    const o = osc(type, f0);
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = envGain(t0, peak, dur, attack);
    o.connect(g); g.connect(dest || busFx);
    o.start(t0); track(o, g, t0 + dur);
  }
  function burst(ftype, f0, f1, q, t0, dur, peak, buf, dest) {
    if (oneShots >= MAX_ONESHOTS) return;
    const s = ctx.createBufferSource(); s.buffer = buf || white;
    const f = filt(ftype, f0, q);
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = envGain(t0, peak, dur, 0.003);
    s.connect(f); f.connect(g); g.connect(dest || busFx);
    s.start(t0, rand() * 1.5); track(s, g, t0 + dur);
  }

  function sfx(type, d) {
    const t = ctx.currentTime + 0.005;
    const taken = !!(d && d.taken);
    const k = taken ? 0.72 : 1;
    switch (type) {
      case 'punch':
        burst('lowpass', 1100 * k, 260, 0.8, t, 0.1, 0.8, white);
        tone('sine', 170 * k, 55, t, 0.13, 0.9);
        break;
      case 'baton':
        burst('bandpass', 2200 * k, 900, 1.2, t, 0.06, 0.7);
        tone('triangle', 240 * k, 110, t, 0.14, 0.7);
        tone('sine', 120 * k, 60, t, 0.16, 0.7);
        break;
      case 'chain':
        for (let i = 0; i < 4; i++) burst('bandpass', 4200 * k - i * 400, 2400, 3, t + i * 0.028, 0.05, 0.4);
        tone('sine', 140 * k, 50, t, 0.2, 0.8);
        burst('lowpass', 700, 200, 0.7, t, 0.12, 0.5);
        break;
      case 'hit': sfx(d && d.weapon === 'chain' ? 'chain' : d && d.weapon === 'baton' ? 'baton' : 'punch', d); break;
      case 'bump':
        burst('lowpass', 700, 250, 0.7, t, 0.12, 0.5);
        tone('square', 120, 70, t, 0.12, 0.25);
        break;
      case 'wall':
        burst('bandpass', 420, 150, 0.8, t, 0.28, 0.9);
        tone('sawtooth', 90, 38, t, 0.32, 0.5);
        burst('highpass', 2500, 1500, 1, t + 0.02, 0.1, 0.25);
        break;
      case 'carhit':
        burst('bandpass', 380, 120, 0.7, t, 0.35, 1.0);
        tone('sawtooth', 70, 32, t, 0.4, 0.7);
        tone('square', 300, 180, t + 0.01, 0.2, 0.2);
        break;
      case 'crash': {
        burst('bandpass', 600, 180, 0.8, t, 0.25, 0.9);
        tone('sine', 130, 34, t, 0.45, 1.0);
        const ratios = [1, 1.47, 2.09, 2.56];
        for (let i = 0; i < ratios.length; i++) tone(i & 1 ? 'square' : 'triangle', 430 * ratios[i], 400 * ratios[i], t + 0.01 * i, 0.55 - 0.06 * i, 0.16, busFx);
        burst('bandpass', 1300, 260, 1.4, t + 0.1, 1.3, 0.45); // metal scrape sliding out
        burst('highpass', 3000, 2000, 1, t + 0.15, 0.35, 0.18);
        break;
      }
      case 'beep': tone('square', 660, 660, t, 0.13, 0.28, busFx, 0.006); break;
      case 'go': tone('square', 1100, 1100, t, 0.55, 0.32, busFx, 0.006); tone('triangle', 550, 550, t, 0.55, 0.25, busFx, 0.006); break;
      case 'finish': {
        const fast = !d || !(d.place > 3);
        const notes = fast ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [440, 523.25];
        for (let i = 0; i < notes.length; i++) {
          const last = i === notes.length - 1;
          tone('triangle', notes[i], notes[i], t + i * 0.13, last ? 0.8 : 0.2, 0.3, busFx, 0.01);
          tone('square', notes[i] * 2, notes[i] * 2, t + i * 0.13, last ? 0.6 : 0.14, 0.08, busFx, 0.01);
        }
        break;
      }
      case 'click':
        tone('sine', 1000, 650, t, 0.045, 0.35, busFx, 0.002);
        burst('highpass', 3000, 3000, 0.7, t, 0.015, 0.12);
        break;
      case 'thump':
        tone('sine', 95, 38, t, 0.28, d && d.gain ? d.gain : 0.7);
        burst('lowpass', 500, 150, 0.7, t, 0.15, 0.4 * (d && d.gain ? d.gain : 0.7), brown);
        break;
      default: break;
    }
  }

  function chirp() {
    const a = AMBIENT[themeId] || AMBIENT.valley;
    if (a.birds <= 0 || oneShots >= MAX_ONESHOTS - 4) return;
    const t = ctx.currentTime + 0.02;
    const base = (2200 + rand() * 1800) * a.pitch;
    const n = 1 + ((rand() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const f = base * (1 + (rand() - 0.5) * 0.25);
      const s = t + i * (0.09 + rand() * 0.05);
      tone('sine', f, f * (1.1 + rand() * 0.35), s, 0.07, 0.5, A.birds, 0.008);
    }
  }

  // ------------------------------------------------------------ per-frame update (no allocation)
  function doUpdate(dt, s) {
    if (!ctx || ctx.state !== 'running' || suspendedFlag) { maybeResume(); return; }
    clock += dt;
    const t = ctx.currentTime;
    const speed = Math.abs(s.speed || 0);
    const throttle = clamp(s.throttle || 0, 0, 1);
    const type = s.type || 'street';
    if (type !== bikeType) setBike(type);
    const crashed = !!s.crashed;

    // engine
    gearAndRpm(type, speed, s.topSpeed, sh);
    if (sh.gear > lastGear && speed > 2) shiftT = 0.12;
    lastGear = sh.gear;
    if (shiftT > 0) shiftT -= dt;
    const d = engineDef(type);
    const tm = TIMBRE[type] || TIMBRE.street;
    jitterT -= dt;
    if (jitterT <= 0) { jitter = 1 + (rand() - 0.5) * 0.014; jitterT = 0.045; }
    let rpm = sh.rpm;
    let hz = (d.idleHz + (d.redHz - d.idleHz) * rpm);
    if (s.airborne && throttle > 0.3) hz *= 1.12; // wheel spin up in the air
    engineHz = hz;
    const f = hz * jitter;
    E.o1.frequency.setTargetAtTime(f, t, 0.045);
    E.o2.frequency.setTargetAtTime(f, t, 0.045);
    E.o3.frequency.setTargetAtTime(f * tm.r3, t, 0.045);
    E.lfo.frequency.setTargetAtTime(f * tm.lfoR, t, 0.06);
    E.lp.frequency.setTargetAtTime(engineBrightness(throttle, rpm), t, 0.06);
    E.nzf.frequency.setTargetAtTime(clamp(f * 3.2, 150, 1400), t, 0.06);
    E.nzg.gain.setTargetAtTime(tm.noise * (0.12 + 0.88 * throttle) * (0.4 + 0.6 * rpm), t, 0.05);
    const lvl = crashed ? 0 : engineLoudness(throttle, rpm) * (shiftT > 0 ? 0.45 : 1);
    E.gain.gain.setTargetAtTime(lvl, t, crashed ? 0.12 : shiftT > 0 ? 0.015 : 0.05);
    engineOn = lvl > 0.02;
    // engine-braking burble: popping noise when off the throttle at revs
    const burble = !crashed && throttle < 0.1 && rpm > 0.35 && speed > 8 ? 0.2 * rpm : 0;
    E.bzg.gain.setTargetAtTime(burble, t, 0.08);
    burbleT -= dt;
    if (burbleT <= 0) { E.bzLfo.frequency.setTargetAtTime(6 + rand() * 9, t, 0.05); burbleT = 0.15 + rand() * 0.2; }

    // wind
    const wg = windGain(speed);
    W.wg.gain.setTargetAtTime(wg, t, 0.15);
    W.wf.frequency.setTargetAtTime(350 + speed * 28, t, 0.2);

    // tyres: squeal when drifting, gravel off the tarmac, scrape while sliding crashed
    const slipAmt = clamp(Math.abs(s.slip || 0) * 3, 0, 1);
    const squeal = s.drifting && !s.airborne && !crashed && speed > 6 ? (0.35 + 0.65 * slipAmt) * 0.22 * clamp(speed / 22, 0.3, 1) : 0;
    W.sg.gain.setTargetAtTime(squeal, t, squeal > 0 ? 0.04 : 0.12);
    W.sf.frequency.setTargetAtTime(1500 + slipAmt * 900, t, 0.1);
    W.so.frequency.setTargetAtTime(950 + slipAmt * 450 + Math.sin(clock * 31) * 25, t, 0.05);
    const grip = s.grip == null ? 1 : s.grip;
    let rough = grip < 0.97 && !s.airborne ? clamp((1 - grip) / 0.3, 0, 1) * clamp(speed / 18, 0, 1) : 0;
    if (crashed) rough = clamp(speed / 14, 0, 1);
    W.gg.gain.setTargetAtTime(rough * (crashed ? 0.5 : 0.38), t, 0.08);
    W.rg.gain.setTargetAtTime(rough * 0.7, t, 0.1);
    W.gf.frequency.setTargetAtTime(500 + speed * 18, t, 0.2);

    // landing thump
    if (s.airborne) { airT += dt; wasAir = true; } else {
      if (wasAir && airT > 0.22) sfx('thump', { gain: clamp(0.35 + airT * 0.7, 0.35, 1) });
      wasAir = false; airT = 0;
    }

    // ambient bed: ducks as speed rises so it stays under the engine
    const duck = 1 - 0.7 * clamp(speed / 40, 0, 1);
    ramp(busAmb.gain, 0.6 * duck, 0.3);
    birdT -= dt;
    if (birdT <= 0) { chirp(); birdT = 1.2 + rand() * 4.5; }

    updateRivals(dt, s, t);
  }

  function updateRivals(dt, s, t) {
    const list = s.nearby;
    const n = list ? Math.min(s.nearbyCount != null ? s.nearbyCount : list.length, 32) : 0;
    // nearest first: pick up to RIVALS by distance, no allocation
    let m = 0;
    for (let k = 0; k < RIVALS; k++) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < n; i++) {
        let taken = false;
        for (let j = 0; j < m; j++) if (chosen[j] === i) { taken = true; break; }
        if (taken) continue;
        const e = list[i];
        const dd = e.rx * e.rx + e.rz * e.rz;
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best < 0 || bd > 90 * 90) break;
      chosen[m++] = best;
    }
    // bike-bike bump: a rider newly within contact range
    for (let i = 0; i < n; i++) {
      const e = list[i];
      const near = e.rx * e.rx + e.rz * e.rz < 1.5 * 1.5 ? 1 : 0;
      if (near && !bumpPrev[i] && clock > nextBump && e.type !== 'car') { sfx('bump'); nextBump = clock + 0.35; }
      bumpPrev[i] = near;
    }
    for (let i = n; i < 32; i++) bumpPrev[i] = 0;
    // voice assignment: keep a voice on the same rider when possible
    let active = 0;
    for (let v = 0; v < RIVALS; v++) {
      const rv = rivals[v];
      let idx = -1;
      for (let j = 0; j < m; j++) if (chosen[j] >= 0 && rv.id >= 0 && list[chosen[j]].id === rv.id) { idx = j; break; }
      rv.cur = idx;
      if (idx >= 0) { rv.pick = chosen[idx]; chosen[idx] = -1; }
    }
    for (let v = 0; v < RIVALS; v++) {
      const rv = rivals[v];
      if (rv.cur >= 0) continue;
      rv.pick = -1;
      for (let j = 0; j < m; j++) if (chosen[j] >= 0) { rv.pick = chosen[j]; chosen[j] = -1; break; }
    }
    for (let v = 0; v < RIVALS; v++) {
      const rv = rivals[v];
      if (rv.pick < 0) {
        if (rv.gain > 0.001) { rv.gain = 0; rv.g.gain.setTargetAtTime(0, t, 0.08); }
        rv.id = -1;
        continue;
      }
      const e = list[rv.pick];
      const dist = Math.sqrt(e.rx * e.rx + e.rz * e.rz);
      const typ = e.type || 'street';
      const dd = engineDef(typ);
      const r = gearAndRpm(typ, e.speed, e.topSpeed, sh).rpm;
      const hz = (dd.idleHz + (dd.redHz - dd.idleHz) * r) * dopplerFactor(e.closing || 0);
      const gain = distanceGain(dist) * (typ === 'car' ? 0.7 : 1);
      if (rv.id !== e.id) { rv.id = e.id; rv.a.frequency.setValueAtTime(hz, t); rv.b.frequency.setValueAtTime(hz, t); }
      rv.a.frequency.setTargetAtTime(hz, t, 0.06);
      rv.b.frequency.setTargetAtTime(hz * 0.998, t, 0.06);
      rv.lp.frequency.setTargetAtTime(clamp(hz * 4.5, 260, 1100), t, 0.1);
      rv.g.gain.setTargetAtTime(gain * 0.8, t, 0.07);
      rv.gain = gain;
      if (rv.p) rv.p.pan.setTargetAtTime(clamp(e.rx / (Math.abs(e.rx) + 7), -0.9, 0.9), t, 0.05);
      active++;
    }
    activeRivals = active;
  }

  function maybeResume() {
    if (!ctx || suspendedFlag || ctx.state === 'running' || ctx.state === 'closed') return;
    const now = Date.now();
    if (now - lastResumeTry < 1000) return;
    lastResumeTry = now;
    ctx.resume().catch(() => {});
  }

  // ------------------------------------------------------------ public API
  const api = {
    /** Create / resume the AudioContext. Call from inside a user gesture (iOS needs this in a tap). Safe to call repeatedly. */
    unlock: guard(() => {
      if (unavailable) return;
      if (!ctx) {
        build();
        // iOS: a started silent buffer inside the gesture fully unlocks output
        const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
      }
      if (!suspendedFlag && ctx.state !== 'running') ctx.resume().catch(() => {});
    }),
    /** Choose the ambient bed for a track/theme id (valley, sierra, redwood, coast, desert). */
    setTrack: guard((id) => { themeId = AMBIENT[id] ? id : 'valley'; applyTheme(); }),
    /**
     * Once per rendered frame. state: { paused, type ('sport'|'street'|'chopper'), speed (m/s), topSpeed?, throttle, brake, drifting, slip,
     * airborne, crashed, grip (0..1), nearby: [{id, rx (m, + = listener's right), rz (m, + = ahead), speed (m/s), closing (m/s, + = approaching), type}], nearbyCount }.
     */
    update: guard((dt, state) => { if (!state || state.paused) return; doUpdate(dt > 0.25 ? 0.25 : dt, state); }),
    /** One-shot: punch|baton|chain|hit {weapon, taken}|bump|wall|carhit|crash|beep|go|finish {place}|click. */
    event: guard((type, data) => {
      if (!ctx || ctx.state !== 'running' || suspendedFlag) return;
      sfx(type, data);
    }),
    /** Fade the race sounds (engine, wind, tyres, rivals) to silence, e.g. when leaving a race. Ambient stays. */
    hush: guard(() => {
      if (!ctx) return;
      const t = ctx.currentTime;
      for (const p of [E.gain.gain, E.bzg.gain, W.wg.gain, W.sg.gain, W.gg.gain, W.rg.gain]) p.setTargetAtTime(0, t, 0.1);
      for (const v of rivals) { v.g.gain.setTargetAtTime(0, t, 0.1); v.gain = 0; v.id = -1; }
      activeRivals = 0; engineOn = false; wasAir = false; airT = 0; engineHz = 0;
    }),
    /** Master volume 0..1 (remembered by the caller). */
    setVolume: guard((v) => { volume = clamp(+v || 0, 0, 1); applyMaster(0.03); }),
    getVolume: () => volume,
    /** Mute everything (ramped, no click). */
    setMuted: guard((m) => { muted = !!m; applyMaster(0.03); }),
    isMuted: () => muted,
    /** Freeze audio (pause menu, hidden tab). */
    suspend: guard(() => {
      suspendedFlag = true;
      if (!ctx) return;
      applyMaster(0.015);
      clearTimeout(suspendTimer);
      suspendTimer = setTimeout(() => { if (suspendedFlag && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 80);
    }),
    /** Undo suspend(). */
    resume: guard(() => {
      suspendedFlag = false;
      clearTimeout(suspendTimer);
      if (!ctx) return;
      ctx.resume().catch(() => {});
      applyMaster(0.04);
    }),
    /** Tear the graph down. */
    dispose: guard(() => {
      clearTimeout(suspendTimer);
      if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
      ctx = null;
    }),
    /** Small snapshot for tests: { state, engineHz, masterGain, masterTarget, voices, muted, volume, theme }. */
    debug: () => ({
      state: unavailable && !ctx ? 'unavailable' : ctx ? ctx.state : 'locked',
      engineHz,
      masterGain: master ? master.gain.value : 0,
      masterTarget: muted || suspendedFlag ? 0 : volume,
      voices: oneShots + activeRivals + (engineOn ? 1 : 0),
      muted, volume, theme: themeId,
    }),
  };
  return api;
}
