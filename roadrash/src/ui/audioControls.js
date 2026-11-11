// Shared mute toggle + volume slider (pause menu and main menu). Preferences live in localStorage (try/catch everywhere).
const KEY_VOL = 'rr.vol';
const KEY_MUTE = 'rr.mute';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const controls = new Set();

/**
 * Apply the remembered volume / mute to an audio object (call once at start-up).
 * @param {{setVolume:(v:number)=>void, setMuted:(m:boolean)=>void}} audio audio engine
 * @returns {void}
 */
export function loadAudioPrefs(audio) {
  const v = parseFloat(lsGet(KEY_VOL));
  if (Number.isFinite(v)) audio.setVolume(Math.min(1, Math.max(0, v)));
  audio.setMuted(lsGet(KEY_MUTE) === '1');
}

/**
 * Build the audio controls row. All instances stay in sync with each other and persist their changes.
 * @param {Document} doc document
 * @param {{setVolume:(v:number)=>void, getVolume:()=>number, setMuted:(m:boolean)=>void, isMuted:()=>boolean, event?:(t:string)=>void}} audio audio engine
 * @returns {HTMLElement} the controls element
 */
export function createAudioControls(doc, audio) {
  const row = doc.createElement('div');
  row.className = 'rr-audio';
  const mute = doc.createElement('button');
  mute.type = 'button'; mute.className = 'rr-audio-mute';
  const slider = doc.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
  slider.className = 'rr-audio-vol'; slider.setAttribute('aria-label', 'Volume');
  const sync = () => {
    const m = audio.isMuted();
    mute.textContent = m ? 'Sound: off' : 'Sound: on';
    mute.setAttribute('aria-pressed', m ? 'true' : 'false');
    mute.classList.toggle('off', m);
    slider.value = String(Math.round(audio.getVolume() * 100));
    slider.disabled = m;
  };
  mute.addEventListener('click', () => { audio.setMuted(!audio.isMuted()); lsSet(KEY_MUTE, audio.isMuted() ? '1' : '0'); for (const c of controls) c(); });
  slider.addEventListener('input', () => { audio.setVolume(slider.value / 100); lsSet(KEY_VOL, String(audio.getVolume())); for (const c of controls) c(); });
  slider.addEventListener('change', () => { if (audio.event) audio.event('click'); });
  row.append(mute, slider);
  controls.add(sync);
  sync();
  return row;
}
