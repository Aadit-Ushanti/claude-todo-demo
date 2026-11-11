/**
 * Lobby: plain-DOM menu. Main screen = Solo Race / Host Game / Join Game.
 * Host Game creates a room code (RoomSession over a public signalling relay; game traffic stays direct WebRTC);
 * Join Game takes that code. If the relay cannot be reached both offer "Offline code swap", the manual copy/paste
 * flow that needs no server at all (same Wi-Fi, star topology).
 * @module ui/Lobby
 */
import { makeRoster } from '../network/WorldSync.js';
import { RoomSession, normalizeRoomCode } from '../network/Mesh.js';
import { DIFFICULTIES, DIFFICULTY, DEFAULT_DIFFICULTY, normalizeDifficulty } from '../game/Difficulty.js';
import { BIKE_TYPES, BIKE_INFO, DEFAULT_BIKE, normalizeBike } from '../game/Roster.js';
import { BIKE_SPECS, statCard } from '../physics/BikePhysics.js';
import { createAudioControls } from './audioControls.js';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
/** Game modes offered in the menu. */
const MODES = [['single', 'Single Race'], ['championship', 'Championship']];

/**
 * Build the lobby UI inside `root`.
 * @param {HTMLElement} root container element (the lobby covers the viewport)
 * @param {object} nm NetworkManager
 * @param {object} opts
 * @param {(trackId:string, roster:{humans:{peerId:number,slot:number}[], seed:number, trackId:string, solo?:boolean})=>void} opts.onStart race should begin
 * @param {(roster:object)=>void} [opts.onRoster] roster changed (authority: player list; guest: received from the host)
 * @param {Object<string,string>} opts.tracks {id: name}
 * @param {object} [opts.roomOptions] passed to RoomSession (signaller, timeouts, stun)
 * @param {()=>object} [opts.createRoom] factory returning a RoomSession-like object (tests)
 * @param {()=>({text:string}|null)} [opts.savedChampionship] summary of a saved solo championship, or null
 * @param {()=>void} [opts.onResume] resume the saved solo championship
 * @param {()=>void} [opts.onAbandon] delete the saved solo championship
 * @param {(roster:object)=>void} [opts.prepare] authority: last chance to add fields (championship state, grid, first track) to the roster before it is sent
 * @param {(container:HTMLElement, type:string)=>({set:Function, dispose:Function}|null)} [opts.bikePreview] makes the rotating bike preview (renderer.bikeMenuPreview); without it the bike cards stay static
 * @returns {{show:()=>void, hide:()=>void, setStatus:(text:string, isError?:boolean)=>void, readonly room:object|null}}
 */
export function createLobby(root, nm, opts = {}) {
  const doc = root.ownerDocument || globalThis.document;
  const tracks = opts.tracks || {};
  const trackIds = Object.keys(tracks);
  let trackId = trackIds[0] || '';
  let mode = lsGet('rr.mode') === 'championship' ? 'championship' : 'single';
  let difficulty = normalizeDifficulty(lsGet('rr.difficulty') || DEFAULT_DIFFICULTY);
  let myName = (lsGet('rr.name') || '').slice(0, 16);
  let myBike = normalizeBike(lsGet('rr.bike') || DEFAULT_BIKE);
  const names = {}; // peerId -> name, collected by the authority
  const bikesSeen = {}; // peerId -> bike type, collected by the authority
  let preview3d = null; // the rotating bike preview controller, while a screen shows one
  let infoEl = null; // guest: read-only line with the host's mode and difficulty
  let screen = 'main';
  let roster = null; // last roster seen (guest) or sent (host)
  let started = false;
  let room = null;
  let unChange = null;
  let lastPreview = '';
  const seed = (Math.random() * 0x7fffffff) | 0;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (label, cls, fn) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  const area = (readonly, ph) => {
    const t = el('textarea');
    t.readOnly = readonly;
    t.spellcheck = false;
    t.autocapitalize = 'off';
    if (ph) t.placeholder = ph;
    return t;
  };

  const wrap = el('div', 'lobby');
  const card = el('div', 'lobby-card');
  wrap.appendChild(card);
  root.appendChild(wrap);
  const status = el('div', 'lobby-status');

  function setStatus(text, isError = false) {
    status.textContent = text || '';
    status.className = 'lobby-status' + (isError ? ' err' : '');
  }

  const rtcOk = () => {
    try { nm._needRtc(); return true; } catch { return false; }
  };
  const copyText = async (text, ta) => {
    try {
      if (globalThis.navigator && navigator.clipboard) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard');
      setStatus('Copied.');
    } catch {
      if (ta) { ta.focus(); ta.select(); }
      try { if (!doc.execCommand('copy')) throw new Error('copy refused'); setStatus('Copied.'); } catch { setStatus('Select the code and copy it by hand.'); }
    }
  };
  const errText = (e) => (e && e.message) || String(e);

  function trackPicker() {
    const sel = el('select');
    for (const id of trackIds) { const o = el('option', null, tracks[id]); o.value = id; sel.appendChild(o); }
    sel.value = trackId;
    sel.addEventListener('change', () => { trackId = sel.value; if (room && room.isAuthority) preview(); });
    return sel;
  }

  /** Segmented choice. readonly: shows the value only. */
  function segmented(options, get, set, extra) {
    const box = el('div', 'lobby-seg' + (extra ? ' ' + extra : ''));
    const bs = options.map(([id, label]) => {
      const b = btn(label, get() === id ? 'sel' : '', () => { set(id); bs.forEach((x, i) => { x.className = options[i][0] === id ? 'sel' : ''; }); });
      b.setAttribute && b.setAttribute('data-v', id);
      box.appendChild(b);
      return b;
    });
    return box;
  }
  // ---------------------------------------------------------------- bike select
  const cards = {};
  const statOf = (id) => cards[id] || (cards[id] = statCard(BIKE_SPECS[id]));
  const STATS = [['speed', 'Speed'], ['accel', 'Accel'], ['handling', 'Handling'], ['toughness', 'Toughness']];
  function disposePreview() { if (preview3d) { try { preview3d.dispose(); } catch { /* ignore */ } preview3d = null; } }
  /** Tell the other devices which bike this player picked (guest: to the host in a pname event; host: in the next roster). */
  function announceBike() {
    if (nm.isAuthority || (room && room.isAuthority) || (screen === 'hostManual' && nm.isHost)) { pushPreview(); return; }
    if ((screen === 'join' || screen === 'joinManual') && nm.localId != null) { try { nm.sendEvent('pname', { name: myName, bike: myBike }); } catch { /* ignore */ } }
  }
  /**
   * The bike selector: three cards (name, one-line character, four 0-10 stat bars), remembered in localStorage; with a rotating
   * 3D preview when the renderer offers one (withPreview).
   */
  function bikePicker(withPreview) {
    const box = el('div', 'lobby-bikes');
    box.appendChild(el('h2', null, 'Bike'));
    let prevBox = null;
    if (withPreview && opts.bikePreview) { prevBox = el('div', 'lobby-bikeprev'); box.appendChild(prevBox); }
    const row = el('div', 'lobby-bikerow');
    const btns = {};
    const pick = (id) => {
      myBike = id; lsSet('rr.bike', id);
      for (const t of BIKE_TYPES) { btns[t].classList.toggle('sel', t === id); btns[t].setAttribute('aria-pressed', t === id ? 'true' : 'false'); }
      if (preview3d) { try { preview3d.set({ type: id }); } catch { /* ignore */ } }
      announceBike();
    };
    for (const id of BIKE_TYPES) {
      const info = BIKE_INFO[id], st = statOf(id);
      const b = el('button', 'lobby-bike' + (id === myBike ? ' sel' : ''));
      b.type = 'button';
      b.setAttribute('data-bike', id);
      b.setAttribute('aria-pressed', id === myBike ? 'true' : 'false');
      b.append(el('b', 'lobby-bikename', info.name), el('span', 'lobby-bikeblurb', info.blurb));
      const bars = el('span', 'lobby-bars');
      for (const [k, label] of STATS) {
        const r = el('span', 'lobby-bar');
        r.setAttribute('data-stat', k);
        const track = el('span', 'lobby-bartrack');
        const fill = el('i');
        fill.style.width = `${Math.round(st[k] * 10)}%`;
        track.appendChild(fill);
        r.append(el('span', 'lobby-barlabel', label), track, el('span', 'lobby-barval', String(Math.round(st[k]))));
        bars.appendChild(r);
      }
      b.appendChild(bars);
      b.addEventListener('click', () => pick(id));
      btns[id] = b;
      row.appendChild(b);
    }
    box.appendChild(row);
    if (prevBox) {
      disposePreview();
      try { preview3d = opts.bikePreview(prevBox, myBike) || null; } catch { preview3d = null; }
      if (!preview3d) prevBox.hidden = true;
    }
    return box;
  }
  const pushPreview = () => {
    if (room && room.isAuthority) preview();
    else if (screen === 'hostManual' && nm.isHost) { try { nm.sendEvent('roster', manualRoster()); } catch { /* ignore */ } }
  };
  /** Mode + difficulty (+ track picker unless championship) selectors. */
  function options(host) {
    const wrapEl = el('div', 'lobby-options');
    const picker = trackIds.length ? trackPicker() : null;
    const syncPicker = () => { if (picker) picker.hidden = mode === 'championship'; };
    wrapEl.appendChild(segmented(MODES, () => mode, (m) => { mode = m; lsSet('rr.mode', m); syncPicker(); startLabel(); if (host) pushPreview(); else renderMainLabels(); }, 'lobby-mode'));
    wrapEl.appendChild(segmented(DIFFICULTIES.map((d) => [d, DIFFICULTY[d].label]), () => difficulty, (d) => { difficulty = d; lsSet('rr.difficulty', d); if (host) pushPreview(); }, 'lobby-diff'));
    if (picker) { wrapEl.appendChild(picker); syncPicker(); }
    return wrapEl;
  }
  let renderMainLabels = () => {};
  let startBtnEl = null;
  const startLabel = () => { if (startBtnEl) startBtnEl.textContent = mode === 'championship' ? 'Start Championship' : 'Start Race'; };
  const modeText = (m, d) => `${m === 'championship' ? 'Championship (5 races)' : 'Single race'}, ${DIFFICULTY[normalizeDifficulty(d)].label} AI`;
  function setGuestInfo(p) { if (infoEl && p) infoEl.textContent = 'Host: ' + modeText(p.mode, p.difficulty); }

  function counts(n) { return `${n} rider${n === 1 ? '' : 's'} + ${15 - n} AI = 15`; }
  const LINK_LABEL = { self: 'you', direct: 'direct', relayed: 'relayed', connecting: 'connecting...', none: 'no link' };

  // ---------------------------------------------------------------- room plumbing
  let previewTimer = 0;
  const stopPreviewTimer = () => { if (previewTimer) { clearInterval(previewTimer); previewTimer = 0; } };
  /** Authority: re-send the roster every 1.5 s while waiting (a link that opened late would otherwise never hear mode, level and names). */
  const startPreviewTimer = () => { stopPreviewTimer(); previewTimer = setInterval(() => { if (started) return stopPreviewTimer(); lastPreview = ''; pushPreview(); }, 1500); if (previewTimer && previewTimer.unref) previewTimer.unref(); };
  function closeRoom() {
    stopPreviewTimer();
    if (unChange) unChange();
    unChange = null;
    if (room) { try { room.close(); } catch { /* ignore */ } }
    room = null;
    if (nm.mesh && nm.leaveMesh) nm.leaveMesh();
  }
  function newRoom() {
    closeRoom();
    room = opts.createRoom ? opts.createRoom() : new RoomSession(nm, opts.roomOptions || {});
    return room;
  }
  function myPeerId() { return nm.localId != null ? nm.localId : 0; }
  function nameMap() { const o = { ...names }; if (myName) o[myPeerId()] = myName; return o; }
  function bikeMap() { return { ...bikesSeen, [myPeerId()]: myBike }; }
  function meshRoster() { return { humans: nm.humans(), seed, trackId, mode, difficulty, names: nameMap(), bikes: bikeMap() }; }
  function preview() {
    // authority: keep the other riders' lobby in step (track, player list) until the race starts
    if (!room || !room.isAuthority || started) return;
    const r = meshRoster();
    const j = JSON.stringify(r);
    if (j === lastPreview) return;
    lastPreview = j;
    roster = r;
    if (opts.onRoster) opts.onRoster(r);
    try { nm.sendEvent('roster', r); } catch { /* ignore */ }
  }
  /** Bike types known for the players of the room: the authority's own map, or the roster a guest last received. */
  const knownBikes = () => ((nm.isAuthority || (room && room.isAuthority)) ? bikeMap() : ((roster && roster.bikes) || { [myPeerId()]: myBike }));
  function playerRows(list) {
    const bikes = knownBikes();
    return list.map((p) => {
      const who = p.self ? 'You' : `Rider ${p.slot === 0 ? 1 : 16 - p.slot}`;
      const bike = p.self ? myBike : bikes[p.id];
      const li = el('li');
      li.append(el('span', null, `${who}${p.authority ? ' (host)' : ''}, slot ${p.slot + 1}`), el('span', 'lobby-bikeof', bike ? BIKE_INFO[normalizeBike(bike)].name : ''), el('span', 'lobby-link ' + p.link, LINK_LABEL[p.link] || p.link));
      if (bike) li.setAttribute('data-bike', normalizeBike(bike));
      return li;
    });
  }
  let rebuildList = null; // re-draws the player list of the host / join screen (a pick or a roster just arrived)

  // ---------------------------------------------------------------- screens
  function renderMain() {
    card.replaceChildren(el('h1', null, 'Road Rash'));
    card.appendChild(el('p', null, 'Pick a mode, then race alone or with friends: one room code, everyone joins.'));
    const nameIn = el('input', 'lobby-input lobby-name');
    nameIn.type = 'text'; nameIn.placeholder = 'Your name (shown in results)'; nameIn.maxLength = 16; nameIn.value = myName;
    nameIn.autocomplete = 'off'; nameIn.spellcheck = false;
    nameIn.addEventListener('input', () => { myName = nameIn.value.trim().slice(0, 16); lsSet('rr.name', myName); });
    const cols = el('div', 'lobby-cols');
    const left = el('div', 'lobby-left');
    left.append(nameIn, options(false));
    cols.append(left, bikePicker(true)); // side by side on a short landscape phone
    card.appendChild(cols);
    const saved = opts.savedChampionship ? opts.savedChampionship() : null;
    if (saved) {
      const sr = el('div', 'lobby-row lobby-saved');
      sr.appendChild(btn('Resume championship: ' + saved.text, 'primary', () => { started = true; hide(); if (opts.onResume) opts.onResume(); }));
      sr.appendChild(btn('Abandon it', '', () => { if (opts.onAbandon) opts.onAbandon(); renderMain(); }));
      card.appendChild(sr);
    }
    const row = el('div', 'lobby-row');
    const solo = btn('', saved ? '' : 'primary', () => {
      started = true;
      const r = { humans: [{ peerId: 0, slot: 0 }], seed: (Math.random() * 0x7fffffff) | 0, trackId, solo: true, mode, difficulty, names: myName ? { 0: myName } : {}, bikes: { 0: myBike } };
      hide();
      if (opts.onStart) opts.onStart(trackId, r);
    });
    renderMainLabels = () => { solo.textContent = mode === 'championship' ? 'Solo Championship' : 'Solo Race'; };
    renderMainLabels();
    row.appendChild(solo);
    row.appendChild(btn('Host Game', '', () => go('host')));
    row.appendChild(btn('Join Game', '', () => go('join')));
    if (opts.audio) row.appendChild(createAudioControls(doc, opts.audio)); // compact: shares the button row
    card.appendChild(row);
    card.appendChild(status);
  }

  function noRtc() {
    card.appendChild(el('p', null, 'WebRTC is not available in this browser, so multiplayer cannot be used. Solo Race still works.'));
    card.appendChild(btn('Back', '', () => go('main')));
  }

  function offlineLink() {
    const b = btn('Offline code swap (no internet needed)', 'link', () => { closeRoom(); go(screen === 'host' ? 'hostManual' : 'joinManual'); });
    return b;
  }

  function renderHost() {
    card.replaceChildren(el('h1', null, 'Host Game'));
    if (!rtcOk()) return noRtc();
    const code = el('div', 'lobby-code', '....-....');
    card.appendChild(el('h2', null, 'Room code: tell everyone this'));
    card.appendChild(code);
    const copyRow = el('div', 'lobby-row');
    const copyBtn = btn('Copy code', '', () => { if (room && room.code) copyText(room.code); });
    copyBtn.disabled = true;
    copyRow.append(copyBtn, el('p', 'lobby-note', 'Everyone types this same code under Join Game. Game traffic goes directly between devices.'));
    card.appendChild(copyRow);
    const count = el('div', 'lobby-count', counts(1));
    const list = el('ol', 'lobby-list');
    const relay = el('div', 'lobby-note');
    card.append(count, list, relay);
    const startBtn = btn('Start Race', 'primary', () => hostStart());
    startBtnEl = startBtn; startLabel();
    startBtn.disabled = true;
    const row = el('div', 'lobby-row');
    row.append(startBtn, btn('Back', '', () => go('main')));
    card.append(options(true), bikePicker(false), row, status);
    const r = newRoom();
    const refresh = () => {
      const rs = r.roster();
      count.textContent = counts(rs.length || 1);
      list.replaceChildren(...playerRows(rs));
      preview();
    };
    unChange = r.onChange(refresh);
    rebuildList = refresh;
    setStatus('Contacting the signalling relay...');
    r.host().then((c) => {
      code.textContent = c;
      copyBtn.disabled = false;
      startBtn.disabled = false;
      startPreviewTimer();
      relay.textContent = r.endpoint ? `Relay: ${r.endpoint === 'broadcast' ? 'this browser only' : r.endpoint.replace(/^wss?:\/\//, '')}` : '';
      setStatus('');
      refresh();
    }).catch((e) => {
      code.textContent = '----';
      closeRoom();
      card.replaceChildren(el('h1', null, 'Host Game'));
      card.appendChild(el('p', null, 'Could not reach the signalling relay, so a room code cannot be created: ' + errText(e)));
      card.appendChild(el('p', null, 'You can still connect with the offline code swap (same Wi-Fi), where you and your friend copy two codes between you.'));
      card.appendChild(btn('Offline code swap', 'primary', () => go('hostManual')));
      card.appendChild(btn('Try again', '', () => go('host')));
      card.appendChild(btn('Back', '', () => go('main')));
    });
  }

  function hostStart() {
    const r = nm.mesh ? meshRoster() : manualRoster();
    if (opts.prepare) opts.prepare(r);
    roster = r;
    started = true;
    stopPreviewTimer();
    try { nm.sendEvent('roster', r); nm.sendEvent('start', { raceT0: 0 }); } catch (e) { setStatus(errText(e), true); }
    hide();
    if (opts.onRoster) opts.onRoster(r);
    if (opts.onStart) opts.onStart(r.trackId || trackId, r);
  }

  function renderJoin() {
    card.replaceChildren(el('h1', null, 'Join Game'));
    if (!rtcOk()) return noRtc();
    card.appendChild(el('h2', null, 'Type the host\'s room code'));
    const input = el('input', 'lobby-input');
    input.type = 'text';
    input.placeholder = 'RASH-4821';
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 12;
    card.appendChild(input);
    const list = el('ol', 'lobby-list');
    const waiting = el('p', 'lobby-note', '');
    const joinBtn = btn('Join', 'primary', async () => {
      const c = normalizeRoomCode(input.value);
      if (!c) return setStatus('That is not a room code. It looks like RASH-4821 (4 letters, 4 digits).', true);
      joinBtn.disabled = true;
      setStatus('Contacting the signalling relay...');
      const r = newRoom();
      rebuildList = () => { list.replaceChildren(...playerRows(r.roster())); };
      unChange = r.onChange(rebuildList);
      try {
        await r.join(c);
        setStatus(`Connected to room ${c}.`);
        announceBike(); // tell the host which bike (and name) this player rides, without waiting for its next roster
        waiting.textContent = 'Waiting for the host to start the race...';
        list.replaceChildren(...playerRows(r.roster()));
      } catch (e) {
        closeRoom();
        joinBtn.disabled = false;
        if (e && e.code === 'RELAY_UNREACHABLE') {
          setStatus('Could not reach the signalling relay. Use the offline code swap instead (same Wi-Fi).', true);
          card.insertBefore(offlineLink(), card.lastChild);
        } else setStatus(errText(e), true);
      }
    });
    card.appendChild(joinBtn);
    const row = el('div', 'lobby-row');
    row.append(offlineLink(), btn('Back', '', () => go('main')));
    infoEl = el('p', 'lobby-note lobby-info', '');
    card.append(infoEl, bikePicker(false), list, waiting, row, status);
  }

  // ---------------------------------------------------------------- offline code swap (manual, serverless)
  function humanPeerIds() { return [0, ...[...nm.peers].filter((p) => p !== 0).sort((a, b) => a - b)]; }
  function manualRoster() { return { ...makeRoster(humanPeerIds(), seed, trackId), mode, difficulty, names: nameMap(), bikes: bikeMap() }; }
  let hostRefresh = null;

  function renderHostManual() {
    card.replaceChildren(el('h1', null, 'Offline code swap: host'));
    if (!rtcOk()) return noRtc();
    card.appendChild(el('p', null, 'No internet or relay needed, same Wi-Fi only. Each friend needs one code from you and sends one back.'));
    card.appendChild(el('h2', null, '1. Send this code to a friend'));
    const offer = area(true, 'Creating the offer code...');
    card.appendChild(offer);
    const copyRow = el('div', 'lobby-row');
    copyRow.appendChild(btn('Copy', '', () => copyText(offer.value, offer)));
    copyRow.appendChild(el('p', 'lobby-note', 'No QR code: paste it into any chat app.'));
    card.appendChild(copyRow);
    card.appendChild(el('h2', null, '2. Paste their answer code'));
    const answer = area(false, 'Answer code from the guest');
    card.appendChild(answer);
    const addBtn = btn('Add Player', 'primary', async () => {
      const c = answer.value.trim();
      if (!c) return setStatus('Paste the guest\'s answer code first.', true);
      addBtn.disabled = true;
      try {
        await nm.acceptAnswer(c);
        answer.value = '';
        setStatus('Connecting...');
        offer.value = '';
        offer.value = await nm.host(); // fresh code for the next guest
      } catch (e) { setStatus(errText(e), true); }
      addBtn.disabled = false;
    });
    card.appendChild(addBtn);
    const count = el('div', 'lobby-count');
    const list = el('ol', 'lobby-list');
    card.append(count, list);
    const startBtn = btn('Start Race', 'primary', () => hostStart());
    startBtnEl = startBtn; startLabel();
    const row = el('div', 'lobby-row');
    row.append(startBtn, btn('Back', '', () => go('main')));
    card.append(options(true), bikePicker(false), row, status);
    hostRefresh = () => {
      const r = manualRoster();
      count.textContent = counts(r.humans.length);
      list.replaceChildren(...r.humans.map((h) => { const li = el('li'); li.append(el('span', null, h.peerId === 0 ? 'You (host), slot 1' : `Player ${h.peerId}, slot ${h.slot + 1}`), el('span', 'lobby-link ' + (h.peerId === 0 ? 'self' : 'relayed'), h.peerId === 0 ? 'you' : 'via host')); return li; }));
    };
    hostRefresh();
    startPreviewTimer();
    nm.host().then((c) => { offer.value = c; setStatus(''); }).catch((e) => setStatus(errText(e), true));
  }

  function renderJoinManual() {
    card.replaceChildren(el('h1', null, 'Offline code swap: join'));
    if (!rtcOk()) return noRtc();
    card.appendChild(el('h2', null, '1. Paste the host\'s code'));
    const offer = area(false, 'Host code');
    card.appendChild(offer);
    const out = area(true, 'Your answer code appears here');
    const waiting = el('p', 'lobby-note', '');
    const joinBtn = btn('Join', 'primary', async () => {
      const c = offer.value.trim();
      if (!c) return setStatus('Paste the host\'s code first.', true);
      joinBtn.disabled = true;
      try {
        out.value = await nm.join(c);
        setStatus('Send the answer code below back to the host.');
        waiting.textContent = 'Waiting for the host to add you and start the race...';
      } catch (e) { setStatus(errText(e), true); joinBtn.disabled = false; }
    });
    card.appendChild(joinBtn);
    card.appendChild(el('h2', null, '2. Send this answer back to the host'));
    card.appendChild(out);
    const row = el('div', 'lobby-row');
    row.append(btn('Copy', '', () => copyText(out.value, out)), btn('Back', '', () => go('main')));
    infoEl = el('p', 'lobby-note lobby-info', '');
    card.append(infoEl, bikePicker(false), row, waiting, status);
  }

  function go(s) {
    disposePreview();
    rebuildList = null;
    if (s === 'main' || s === 'host' || s === 'join') closeRoom();
    if (s === 'hostManual' || s === 'joinManual') { closeRoom(); hostRefresh = null; }
    screen = s;
    infoEl = null;
    lastPreview = '';
    setStatus('');
    if (s === 'host') renderHost();
    else if (s === 'join') renderJoin();
    else if (s === 'hostManual') renderHostManual();
    else if (s === 'joinManual') renderJoinManual();
    else renderMain();
  }

  // ---------------------------------------------------------------- events
  const prevEvent = nm.onEvent;
  nm.onEvent = (type, payload, from) => {
    try {
      if (type === 'roster' && payload && !nm.isAuthority) {
        roster = payload;
        if (payload.trackId) trackId = payload.trackId;
        setGuestInfo(payload);
        if (rebuildList) rebuildList();
        const nameOk = !myName || (payload.names && payload.names[nm.localId] === myName);
        const bikeOk = payload.bikes && payload.bikes[nm.localId] === myBike;
        if (nm.localId != null && !(nameOk && bikeOk)) { try { nm.sendEvent('pname', { name: myName, bike: myBike }); } catch { /* ignore */ } }
        setStatus(counts(payload.humans ? payload.humans.length : 1) + '. Waiting for the host to start...');
        if (opts.onRoster) opts.onRoster(payload);
      } else if (type === 'pname' && payload && typeof payload.name === 'string' && nm.isAuthority) {
        if (payload.name) names[from] = payload.name.slice(0, 16);
        if (payload.bike) bikesSeen[from] = normalizeBike(payload.bike);
        if (rebuildList) rebuildList();
        pushPreview();
      } else if (type === 'start' && !nm.isAuthority && !started) {
        started = true;
        hide();
        if (opts.onStart) opts.onStart(roster ? roster.trackId : trackId, roster || makeRoster([0, nm.localId ?? 1], 0, trackId));
      }
    } catch (e) { setStatus(errText(e), true); }
    if (prevEvent) prevEvent(type, payload, from);
  };
  const prevPeer = nm.onPeer;
  nm.onPeer = (id, joined) => {
    try {
      if (screen === 'hostManual' && nm.isHost && hostRefresh) {
        hostRefresh();
        setStatus(joined ? `Player ${id} connected.` : `Player ${id} left.`);
        const r = manualRoster();
        if (opts.onRoster) opts.onRoster(r);
        nm.sendEvent('roster', r); // preview for guests (seed stays stable until Start)
      } else if (screen === 'joinManual' && !nm.isHost && joined && id === 0) setStatus('Connected to the host. Waiting for the start...');
    } catch { /* ignore UI errors */ }
    if (prevPeer) prevPeer(id, joined);
  };

  function show() { started = false; wrap.classList.add('open'); go('main'); }
  function hide() { disposePreview(); wrap.classList.remove('open'); }

  renderMain();
  return { show, hide, setStatus, get room() { return room; } };
}
