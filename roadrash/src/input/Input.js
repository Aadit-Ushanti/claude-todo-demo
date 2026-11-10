const HOLD = { ArrowUp: 'throttle', KeyW: 'throttle', ArrowDown: 'brake', KeyS: 'brake', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
const ATTACK = { KeyJ: 'punch', KeyK: 'baton', KeyL: 'chain' };
const SIDE = { KeyQ: 1, KeyE: -1 };
const PAD_ATTACK = { 0: 'punch', 2: 'baton', 3: 'chain' };
const MANUAL_SIDE_MS = 1500;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Merges keyboard, touch and gamepad input into the object stepBike expects.
 * Attacks are edge-triggered: each press is returned by exactly one read().
 * Attack side: `sideAuto` is true unless Q/E (or the touch SIDE button) chose a side recently; the game then
 * swings toward the nearest rider. `attackSide` is the manual side (+1 left, -1 right).
 * @param {HTMLElement} target element that receives canvas pointer input
 * @returns {{read: () => object, dispose: () => void, onPause: (null|(() => void)), override: (o: (object|null)) => void, setTouchVisible: (v: boolean) => void, touch: boolean}}
 */
export function createInput(target) {
  const kb = {};
  const tc = {};
  const padPrev = {};
  const out = { throttle: 0, brake: 0, steer: 0, attack: null, attackSide: 1, sideAuto: true };
  let touchSteer = 0;
  let ramp = 0, rampAt = 0; // eased on/off steer (keyboard and touch buttons)
  let side = 1;
  let sideAt = -1e9; // time of the last manual side choice
  let sideMode = 0; // touch SIDE button: 0 auto, 1 left, -1 right
  let pending = null;
  let pendingSide = 0; // side of the touch attack button that queued `pending` (0 = not from a sided button)
  let overlay = null;
  let forced = null;
  const api = { onPause: null, touch: false };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /** True while the keyboard focus is in a text field: the game keys must then type, not ride. */
  const typing = (e) => {
    const t = e && e.target, n = t && t.tagName;
    return !!t && (n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable === true);
  };
  const onKeyDown = (e) => {
    if (typing(e)) { for (const k in kb) kb[k] = false; return; }
    const h = HOLD[e.code];
    if (h) { kb[h] = true; e.preventDefault(); return; }
    const a = ATTACK[e.code];
    if (a) { if (!e.repeat) pending = a; e.preventDefault(); return; }
    if (e.code in SIDE) { side = SIDE[e.code]; sideAt = now(); kb.sideHeld = e.code; return; }
    if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat && api.onPause) { api.onPause(); e.preventDefault(); }
  };
  const onKeyUp = (e) => { if (typing(e)) return; const h = HOLD[e.code]; if (h) kb[h] = false; if (e.code in SIDE) { kb.sideHeld = null; sideAt = now(); } };
  const onBlur = () => {
    for (const k in kb) kb[k] = false;
    for (const k in tc) tc[k] = false;
    held.clear();
    touchSteer = 0; ramp = 0;
  };

  // ---- touch buttons: every finger is tracked by its pointer id, so a finger that slides off a button, or a second
  // finger landing elsewhere, can never leave a button stuck or steal another button's release.
  const held = new Map(); // pointerId -> hold key ('throttle' | 'brake' | 'left' | 'right')
  const syncHeld = () => {
    for (const k of ['throttle', 'brake', 'left', 'right']) tc[k] = false;
    for (const k of held.values()) tc[k] = true;
    if (overlay) for (const b of overlay.querySelectorAll('button[data-h]')) b.classList.toggle('on', !!tc[b.dataset.h]);
  };
  const btnAt = (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button') : null;
    return t && overlay && overlay.contains(t) ? t : null;
  };
  const onBtnDown = (e) => {
    const b = btnAt(e);
    if (!b) return;
    e.preventDefault();
    if (b.dataset.h) { held.set(e.pointerId, b.dataset.h); syncHeld(); }
    else if (b.dataset.a) { pending = b.dataset.a; pendingSide = Number(b.dataset.as) || 0; }
    else if (b.dataset.side) {
      sideMode = sideMode === 0 ? 1 : sideMode === 1 ? -1 : 0;
      b.textContent = sideMode === 0 ? 'SIDE: AUTO' : sideMode === 1 ? 'SIDE: LEFT' : 'SIDE: RIGHT';
    } else if (b.dataset.tilt) toggleTilt();
  };
  // a held finger that slides onto the neighbouring hold button (left <-> right, gas <-> brake) switches to it
  const onBtnMove = (e) => {
    if (!held.has(e.pointerId) || typeof document.elementFromPoint !== 'function') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const b = el && el.closest ? el.closest('button[data-h]') : null;
    if (b && overlay.contains(b) && b.dataset.h !== held.get(e.pointerId)) { held.set(e.pointerId, b.dataset.h); syncHeld(); }
  };
  const onBtnUp = (e) => { if (held.delete(e.pointerId)) syncHeld(); };

  // ---- tilt steering (phone gyroscope). Off until the player turns it on; needs a secure page that allows motion sensors.
  let tiltOn = false, tiltSteer = 0, tiltSeen = false, tiltBtn = null, tiltTimer = 0;
  const TILT_FULL = 22, TILT_DEAD = 2; // degrees of roll for full steer / ignored around level
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  const onTilt = (e) => {
    if (e.beta == null || e.gamma == null) return;
    tiltSeen = true;
    const ang = (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
    // roll of the screen about the viewing axis, positive = right edge down
    const roll = ang === 90 ? e.beta : (ang === 270 || ang === -90) ? -e.beta : e.gamma;
    const m = Math.abs(roll) < TILT_DEAD ? 0 : (Math.abs(roll) - TILT_DEAD) / (TILT_FULL - TILT_DEAD);
    tiltSteer = clamp(-Math.sign(roll) * m, -1, 1); // steer + = left
  };
  const tiltLabel = (t) => { if (tiltBtn) tiltBtn.textContent = t; };
  const stopTilt = (label) => {
    tiltOn = false; tiltSteer = 0;
    window.removeEventListener('deviceorientation', onTilt);
    if (overlay) overlay.classList.remove('tilt');
    tiltLabel(label || 'TILT: OFF');
  };
  const startTilt = async () => {
    const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
    if (!DOE) { stopTilt('TILT: N/A'); return; }
    try {
      if (typeof DOE.requestPermission === 'function' && (await DOE.requestPermission()) !== 'granted') { stopTilt('TILT: BLOCKED'); return; }
    } catch (e) { stopTilt('TILT: BLOCKED'); return; }
    tiltOn = true; tiltSeen = false;
    window.addEventListener('deviceorientation', onTilt);
    if (overlay) overlay.classList.add('tilt');
    tiltLabel('TILT: ON');
    clearTimeout(tiltTimer);
    // some pages (embedded viewers) never deliver sensor events: fall back to the buttons and say so
    tiltTimer = setTimeout(() => { if (tiltOn && !tiltSeen) stopTilt('TILT: N/A'); }, 1500);
  };
  const toggleTilt = () => { if (tiltOn) { stopTilt(); lsSet('rr.tilt', '0'); } else { lsSet('rr.tilt', '1'); startTilt(); } };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointermove', onBtnMove);
  window.addEventListener('pointerup', onBtnUp);
  window.addEventListener('pointercancel', onBtnUp);

  const isTouch = navigator.maxTouchPoints > 0 || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  if (isTouch) {
    api.touch = true;
    overlay = document.createElement('div');
    overlay.className = 'touch-controls';
    overlay.hidden = true;
    // layout: GAS bottom left, BRAKE bottom right, one set of attacks at mid height on each side (same buttons for either thumb; the swing side is automatic),
    // steer arrows inside the pedals (dimmed while tilt steering is on), tilt switch bottom centre
    const atk = (sd, cls) => `<div class="tc-atk ${cls}">` +
      `<button data-a="punch" data-as="${sd}">PUNCH</button>` +
      `<button data-a="baton" data-as="${sd}">BATON</button>` +
      `<button data-a="chain" data-as="${sd}">CHAIN</button></div>`;
    overlay.innerHTML =
      atk(1, 'tc-atk-l') + atk(-1, 'tc-atk-r') +
      '<div class="tc-pedal-l"><button data-h="throttle" class="tc-gas">GAS</button><button data-h="left" class="tc-left" aria-label="Steer left">&#9664;</button></div>' +
      '<div class="tc-pedal-r"><button data-h="right" class="tc-right" aria-label="Steer right">&#9654;</button><button data-h="brake" class="tc-brake">BRAKE</button></div>' +
      '<button data-tilt="1" class="tc-tilt">TILT: OFF</button>';
    overlay.addEventListener('pointerdown', onBtnDown);
    tiltBtn = overlay.querySelector('.tc-tilt');
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    (target.parentElement || document.body).appendChild(overlay);
    if (lsGet('rr.tilt') === '1' && !(typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function')) startTilt();
  }

  Object.assign(api, {
    read() {
      if (forced) {
        out.throttle = forced.throttle || 0; out.brake = forced.brake || 0; out.steer = forced.steer || 0;
        out.attack = forced.attack || null; out.attackSide = forced.attackSide || 1; out.sideAuto = forced.sideAuto !== false && !forced.attackSide;
        return out;
      }
      let padThrottle = 0;
      let padBrake = 0;
      let padSteer = 0;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p) continue;
        padThrottle = Math.max(padThrottle, p.buttons[7]?.value || 0);
        padBrake = Math.max(padBrake, p.buttons[6]?.value || 0);
        const ax = p.axes[0] || 0;
        if (Math.abs(ax) > 0.15) padSteer = -ax;
        for (const idx in PAD_ATTACK) {
          const key = `${p.index}:${idx}`;
          const down = !!p.buttons[idx]?.pressed;
          if (down && !padPrev[key]) pending = PAD_ATTACK[idx];
          padPrev[key] = down;
        }
      }
      // keys and steer buttons are on/off: ease the value in (about 0.25 s to full) and out (about 0.1 s) so a tap is a nudge
      const t = now(), dtS = Math.min(0.1, Math.max(0, (t - rampAt) / 1000));
      rampAt = t;
      const want = ((kb.left || tc.left) ? 1 : 0) - ((kb.right || tc.right) ? 1 : 0);
      const rate = (want === 0 || want * ramp < 0) ? 10 : 4;
      ramp += clamp(want - ramp, -rate * dtS, rate * dtS);
      const kbSteer = ramp;
      touchSteer = tiltOn ? tiltSteer : 0;
      out.steer = [kbSteer, touchSteer, padSteer].reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
      out.throttle = Math.max(kb.throttle ? 1 : 0, tc.throttle ? 1 : 0, padThrottle);
      out.brake = Math.max(kb.brake ? 1 : 0, tc.brake ? 1 : 0, padBrake);
      out.attack = pending;
      if (sideMode !== 0) { out.attackSide = sideMode; out.sideAuto = false; }
      else { out.attackSide = side; out.sideAuto = !(kb.sideHeld || now() - sideAt < MANUAL_SIDE_MS); }
      // touch attack buttons exist on both sides only so either thumb can reach them: the swing side is always automatic
      if (pending && pendingSide) out.sideAuto = true;
      pending = null; pendingSide = 0;
      return out;
    },
    /** Test hook: replace real input with this object (null restores real input). */
    override(o) { forced = o; },
    /** Show or hide the touch overlay (only exists on touch devices). */
    setTouchVisible(v) { if (overlay) overlay.hidden = !v; },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onBtnMove);
      window.removeEventListener('pointerup', onBtnUp);
      window.removeEventListener('pointercancel', onBtnUp);
      window.removeEventListener('deviceorientation', onTilt);
      clearTimeout(tiltTimer);
      if (overlay) overlay.remove();
    },
  });
  return api;
}
