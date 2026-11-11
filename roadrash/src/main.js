// Game shell: menu (Lobby) -> countdown -> race -> results, fixed-step loop, rendering, network wiring.
import { TRACKS } from './track/tracks.js';
import { buildTrack } from './track/Track.js';
import * as RaceMod from './game/Race.js';
import { ragdolls, debris } from './physics/DestructionSystem.js';
import { NetworkManager } from './network/NetworkManager.js';
import { WorldSync, decodeFlags } from './network/WorldSync.js';
import { BroadcastSignaller } from './network/Signal.js';
import { createRenderer } from './render/Renderer.js';
import { maxCornerSpeed, leanScaleAt, DISPLAY_SPEED_SCALE, SPEED_SCALE } from './physics/BikePhysics.js';
import { createInput } from './input/Input.js';
import { createHud } from './ui/Hud.js';
import { createLobby } from './ui/Lobby.js';
import { computeGrid, AI_NAMES, joinOrder, assignBikes, normalizeBike, BIKE_INFO } from './game/Roster.js';
import { DIFFICULTY, normalizeDifficulty } from './game/Difficulty.js';
import { createChampionship, restoreChampionship } from './game/Championship.js';
import { createAudio } from './audio/Audio.js';
import { loadAudioPrefs } from './ui/audioControls.js';

const { createRace, stepRace, setHumans, applyRemoteHit } = RaceMod;
const SIM_DT = RaceMod.SIM_DT || 1 / 60;
const COUNTDOWN = RaceMod.COUNTDOWN || 3;
const MAX_SUBSTEPS = 5;
const TOTAL = 15;
const BREAK_MIN_S = 5.5;   // championship break between races: at least this long (standings + loading the next track)
const BREAK_CAP_S = 15;    // multiplayer: the authority starts the next race after this long even if a device is not ready
const BREAK_HINT_S = 6;    // "loading next race..." hint if loading is still going on after this
const SAVE_KEY = 'rr.champ.v1';

const params = new URLSearchParams(location.search);
const E2E = params.get('e2e') === '1';
const RT = !E2E || params.get('rt') === '1'; // realtime loop (always, except plain e2e where tests step by hand)
const NORENDER = params.get('norender') === '1';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const input = createInput(canvas);
const audio = createAudio();
loadAudioPrefs(audio);
// iOS / Chrome only allow audio after a user gesture: unlock on the first tap or key press (kept until it has taken effect)
{
  const unlock = () => { audio.unlock(); if (audio.debug().state === 'running') { window.removeEventListener('pointerup', unlock); window.removeEventListener('keydown', unlock); } };
  window.addEventListener('pointerup', unlock);
  window.addEventListener('keydown', unlock);
  // UI click sounds for menu / pause buttons
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.lobby button, .hud-modal button, #quality button')) audio.event('click'); }, true);
}
const nm = new NetworkManager({});
const trackCache = new Map();
const getTrack = (id) => { let t = trackCache.get(id); if (!t) { t = buildTrack(TRACKS[id]); trackCache.set(id, t); } return t; };

const state = { screen: 'menu', paused: false, mode: 'solo', trackId: null, quality: 'high', e2e: E2E, mySlot: 0, notice: '', difficulty: 'medium', game: 'single' };
// session: what is being played (single race or championship) and its AI level; champ = the Championship (null for a single race)
const session = { mode: 'single', difficulty: 'medium', champ: null, names: {}, bikes: {}, humans: [], solo: true };
let brk = null;          // championship break between races (standings on screen, next track loading)
let renderedTrack = null;
let race = null, ws = null, roster = null, curHumans = [], mySlot = 0, lobby = null;
let doneAt = -1, firstAt = -1;
let acc = 0, last = null, renderAlpha = 1, lastWeapon = null, resultsAt = -1, goShownAt = -1, resultsTick = 0;
let pilotOn = false;
const log = [];
const hits = { sent: 0, applied: 0 };

// ---------------------------------------------------------------- quality
const QUALITIES = ['low', 'medium', 'high'];
function setQuality(q) {
  if (!QUALITIES.includes(q)) return;
  state.quality = q;
  renderer.setQuality(q);
  lsSet('rr.quality', q);
  qbar.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.q === q));
}
const qbar = document.getElementById('quality');
qbar.innerHTML = '<span>Quality</span>' + QUALITIES.map((q) => `<button data-q="${q}">${q[0].toUpperCase() + q.slice(1)}</button>`).join('');
qbar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setQuality(b.dataset.q); });
{
  const stored = lsGet('rr.quality');
  setQuality(E2E ? (params.get('q') || 'low') : (QUALITIES.includes(stored) ? stored : renderer.getQuality()));
}

// ---------------------------------------------------------------- HUD
const hud = createHud(document.getElementById('hud'), {
  onResume: () => setPaused(false),
  onPause: () => togglePause(),
  onMenu: () => toMenu(),
  onAgain: () => again(),
  onNext: () => {},
  onContinue: () => continueFinal(),
  audio,
});
input.onPause = () => togglePause();

// Phones: the game is landscape only. An installed app follows the manifest; in a browser tab the first tap asks for
// fullscreen and a landscape lock (not every browser grants either), and a phone held upright sees a "rotate" notice.
if (input.touch) {
  const rot = document.createElement('div');
  rot.className = 'rr-rotate';
  rot.innerHTML = '<div>Turn your phone sideways<small>Road Rash plays in landscape</small></div>';
  document.body.appendChild(rot);
  const goLandscape = async () => {
    try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (e) { /* not allowed here */ }
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) { /* not allowed here */ }
  };
  window.addEventListener('pointerup', goLandscape, { once: true });
}

function setPaused(p) {
  const okScreen = state.screen === 'race' ? !!race : state.screen === 'break';
  if (!okScreen || state.mode !== 'solo') return;
  state.paused = p;
  if (p) audio.suspend(); else audio.resume();
  hud.showPause(p, state.screen !== 'break');
  last = null;
}
function togglePause() { if (!hud.resultsOpen || state.screen === 'break') setPaused(!state.paused); }

// ---------------------------------------------------------------- humans / network wiring
function humanList() {
  if (!roster || roster.solo) return [{ peerId: 0, slot: 0 }];
  if (nm.mesh) return nm.humans();
  return curHumans;
}

/** Re-derive which slots are humans (after a peer joined/left or the authority changed) and hand departed slots to the AI. */
function syncHumans(reason) {
  if (!race || !roster || roster.solo) return;
  const now = performance.now();
  applyRemotes(now); // refresh remote bikes to the predicted present before any hand-over
  const before = race.humanSlots.slice();
  const list = humanList();
  const slots = list.map((h) => h.slot);
  if (!slots.includes(mySlot)) slots.unshift(mySlot);
  const remote = slots.filter((s) => s !== mySlot);
  setHumans(race, slots, remote);
  curHumans = list.length ? list : curHumans;
  for (const s of before) {
    if (slots.includes(s)) continue;
    const r = race.riders[s];
    const msg = `Rider ${s === 0 ? 1 : 16 - s} disconnected: AI took over`;
    hud.toast(msg, 4000);
    if (session.champ && session.champ.setAI(s)) logEv({ type: 'champ-ai', slot: s });
    logEv({ type: 'ai-takeover', slot: s, s: r.s, reason, authority: race.authority });
  }
  updateRiderCounts();
}

function authorityChanged(info) {
  if (!race) return;
  race.authority = info.isAuthority ? 'host' : 'guest';
  if (info.isAuthority && Number.isFinite(info.raceT)) race.t = info.raceT;
  logEv({ type: 'authority', isAuthority: !!info.isAuthority, reason: info.reason });
  syncHumans('authority');
}

nm.onEvent = (type, payload, from) => {
  if (netEvent(type, payload, from)) return;
  if (!race || !ws) return;
  let a;
  try { a = ws.handleEvent(race, type, payload, from); } catch (e) { console.warn('event', e); return; }
  if (a.action === 'applyHit') { if (applyRemoteHit(race, a.to, a.hit, payload && payload.id)) hits.applied++; }
  else if (a.action === 'roster') {
    if (!nm.mesh) curHumans = a.humans;
    syncHumans('roster');
  }
};
nm.onPeer = (id, joined) => {
  if (!joined && brk) { brk.ready.delete(id); if (!race || !roster || roster.solo) { dropHumanFromChamp(id); return; } }
  if (!race || !roster || roster.solo) return;
  if (!nm.mesh) {
    if (!joined) {
      if (id === 0 && !nm.isHost) { endMultiplayer('The host left the game.'); return; }
      curHumans = curHumans.filter((h) => h.peerId !== id);
    }
  }
  syncHumans(joined ? 'joined' : 'left');
};
nm.onStatus = () => {};

function updateRiderCounts() {
  const n = race ? race.humanSlots.length : 1;
  state.humans = n;
}
function logEv(e) { log.push(e); if (log.length > 300) log.shift(); }

const remoteInfo = [];
function netInfoFor(slot) { return remoteInfo[slot] || (remoteInfo[slot] = { attacking: false, side: 1, weapon: null }); }

/** Write the interpolated remote humans' network state into their riders' bikes. */
function applyRemotes(now) {
  if (!race || !roster || roster.solo) return;
  const pl = nm.remotePlayers(now);
  for (let i = 0; i < curHumans.length; i++) {
    const h = curHumans[i];
    if (h.slot === mySlot) continue;
    const r = race.riders[h.slot];
    if (!r || r.kind !== 'human' || !r.remote) continue;
    const st = pl.get(h.peerId);
    if (!st) continue;
    const b = r.bike;
    b.pos.x = st.x; b.pos.y = st.y; b.pos.z = st.z;
    b.vel.x = st.vx; b.vel.y = st.vy; b.vel.z = st.vz;
    b.yaw = st.yaw; b.yawRate = st.yawRate; b.lean = st.lean; b.health = st.health;
    b.speed = -st.vx * Math.sin(st.yaw) - st.vz * Math.cos(st.yaw);
    const f = decodeFlags(st.flags | 0);
    b.drifting = f.drifting; b.crashed = f.crashed;
    const ni = netInfoFor(h.slot);
    ni.attacking = f.attacking; ni.side = f.side; ni.weapon = f.weapon;
    r.netInfo = ni;
  }
}

const netState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, yawRate: 0, lean: 0, flags: 0, health: 100 };
const WEAPON_BITS = { punch: 1, kick: 2 };
function pushLocalState() {
  const r = race.riders[mySlot], b = r.bike, a = r.input.attack;
  netState.x = b.pos.x; netState.y = b.pos.y; netState.z = b.pos.z;
  netState.vx = b.vel.x; netState.vy = b.vel.y; netState.vz = b.vel.z;
  netState.yaw = b.yaw; netState.yawRate = b.yawRate; netState.lean = b.lean; netState.health = b.health;
  netState.flags = (b.drifting ? 1 : 0) | (b.crashed ? 2 : 0) | (a ? 4 | ((r.input.attackSide > 0 ? 0 : 8)) | ((WEAPON_BITS[a] || 1) << 4) : 0);
  nm.setLocalState(netState);
}

// ---------------------------------------------------------------- bikes
/** The bike type of every slot for a race: a championship keeps each rider's bike for all races; otherwise humans ride what they picked and the AI are spread evenly. */
function fieldSpecs(ros, humans) {
  const hb = {};
  for (const h of humans) hb[h.slot] = normalizeBike(ros.bikes && ros.bikes[h.peerId]);
  const c = session.champ;
  if (c) {
    const base = assignBikes({ humanBikes: hb, seed: c.seed });
    return Array.from({ length: TOTAL }, (_, slot) => { const r = c.riders.find((x) => x.id === slot); return normalizeBike(r && r.bike ? r.bike : base[slot]); });
  }
  return assignBikes({ humanBikes: hb, seed: ros.seed | 0 });
}

// ---------------------------------------------------------------- race lifecycle
function startRace(trackId, ros) {
  endRace();
  brk = null;
  applySession(ros);
  if (session.champ && session.champ.trackId) trackId = session.champ.trackId;
  const def = TRACKS[trackId] ? trackId : Object.keys(TRACKS)[0];
  const track = getTrack(def);
  roster = ros;
  state.trackId = def;
  state.mode = ros.solo ? 'solo' : 'multi';
  const humans = ros.humans && ros.humans.length ? ros.humans : [{ peerId: 0, slot: 0 }];
  const me = ros.solo ? humans[0] : (humans.find((h) => h.peerId === nm.localId) || humans[0]);
  mySlot = me.slot;
  state.mySlot = mySlot;
  curHumans = humans.slice();
  const authority = ros.solo || nm.isAuthority ? 'host' : 'guest';
  const specs = fieldSpecs(ros, humans);
  race = createRace({
    track, seed: ros.seed | 0, humans: humans.length, humanSlots: humans.map((h) => h.slot),
    localSlots: [mySlot], authority, humanSpec: specs[mySlot], specs, difficulty: session.difficulty,
    gridPos: computeGrid({ humanSlots: humans.map((h) => h.slot), order: ros.grid || null }),
  });
  if (renderedTrack !== track) { renderer.setTrack(track); renderedTrack = track; }
  if (!ros.solo) {
    ws = new WorldSync(nm, { hz: 20 });
    ws.roster = ros;
    ws.onAuthorityChange(authorityChanged);
  }
  state.screen = 'race'; state.paused = false;
  audio.resume(); audio.setTrack(def); cdBeep = 0;
  doneAt = -1; firstAt = -1; acc = 0; last = null; lastWeapon = null; resultsAt = -1; goShownAt = -1; latch.until = -1;
  prevL.init = false;
  hud.hideResults(); hud.showPause(false); hud.setVisible(true); hud.setPauseButton(state.mode === 'solo');
  input.setTouchVisible(true);
  qbar.classList.remove('on');
  updateRiderCounts();
  hud.toast(`${track.def.name}${session.champ ? ` (race ${session.champ.index + 1}/${session.champ.total})` : ''}: get ready`, 2500);
  logEv({ type: 'start', track: def, authority, difficulty: session.difficulty, grid: race.gridPos.slice(), specs: specs.slice(), index: session.champ ? session.champ.index : 0 });
  return race;
}

function endRace() {
  audio.hush();
  if (ws) { try { ws.dispose(); } catch { /* ignore */ } ws = null; }
  race = null;
}

function endMultiplayer(msg) {
  const multi = state.mode === 'multi';
  endRace();
  if (multi) {
    try { if (lobby && lobby.room) lobby.room.close(); } catch { /* ignore */ }
    if (!nm.mesh) { try { nm.close(); } catch { /* ignore */ } }
  }
  toMenuScreen();
  if (msg && lobby) lobby.setStatus(msg, true);
}

function toMenuScreen() {
  state.screen = 'menu'; state.paused = false; brk = null; renderedTrack = null;
  audio.resume();
  hud.setVisible(false); hud.showPause(false); hud.hideResults();
  input.setTouchVisible(false);
  qbar.classList.add('on');
  renderer.setTrack(null);
  if (lobby) lobby.show();
}

function toMenu() {
  const multi = state.mode === 'multi';
  endRace();
  if (multi) {
    try { if (lobby && lobby.room) lobby.room.close(); } catch { /* ignore */ }
    if (!nm.mesh) { try { nm.close(); } catch { /* ignore */ } }
  }
  toMenuScreen();
}

function again() {
  if (state.screen === 'break') return;
  if (state.mode !== 'solo') {
    if (!nm.isAuthority || !race || session.champ) return;
    const ros = nextRoster(null);
    try { nm.sendEvent('start', { raceT0: 0, roster: ros }); } catch (e) { console.warn('start', e); }
    startRace(ros.trackId, ros);
    return;
  }
  if (session.champ) { // restart the current championship race with the same seed and grid
    const c = session.champ;
    startRace(c.trackId, { ...roster, seed: c.raceSeed, champ: c.serialise(), grid: c.gridOrder() });
    return;
  }
  const id = state.trackId;
  startRace(id, { humans: [{ peerId: 0, slot: 0 }], seed: (Math.random() * 0x7fffffff) | 0, trackId: id, solo: true, mode: 'single', difficulty: session.difficulty, names: session.names, bikes: session.bikes });
}

// ---------------------------------------------------------------- session: single race / championship
/** Adopt the mode, level, names and (when present) the championship state of a roster. */
function applySession(ros) {
  session.difficulty = normalizeDifficulty(ros.difficulty);
  session.mode = ros.mode === 'championship' ? 'championship' : 'single';
  session.names = ros.names || {};
  session.bikes = ros.bikes || {};
  session.solo = !!ros.solo;
  if (session.mode === 'championship' && ros.champ) session.champ = restoreChampionship(ros.champ);
  else if (session.mode !== 'championship') session.champ = null;
  state.difficulty = session.difficulty; state.game = session.mode;
}

/** Authority / solo: add the championship (race 1) to a roster about to be used. */
function prepareRoster(r) {
  r.difficulty = normalizeDifficulty(r.difficulty);
  r.names = r.names || {};
  r.bikes = r.bikes || {};
  if (r.mode !== 'championship') { r.mode = 'single'; return r; }
  const hs = r.humans || [{ peerId: 0, slot: 0 }];
  const order = joinOrder(hs.map((h) => h.slot));
  const cseed = (r.seed | 0) || 1;
  const hb = {};
  for (const h of hs) hb[h.slot] = normalizeBike(r.bikes[h.peerId]);
  const bikes = assignBikes({ humanBikes: hb, seed: cseed }); // fixed for the whole championship
  const riders = [];
  for (let slot = 0; slot < TOTAL; slot++) {
    const h = hs.find((x) => x.slot === slot);
    const nm0 = h ? (r.names[h.peerId] || (r.solo ? 'You' : `Player ${order.indexOf(slot) + 1}`)) : AI_NAMES[slot];
    riders.push({ id: slot, name: nm0, human: !!h, peerId: h ? h.peerId : null, bike: bikes[slot] });
  }
  const c = createChampionship({ riders, difficulty: r.difficulty, seed: cseed });
  r.champ = c.serialise(); r.trackId = c.trackId; r.seed = c.raceSeed; r.grid = null;
  return r;
}

/** Roster of the next race (authority / solo). Championship: advances to the next track. Single race: a new seed, same track. */
function nextRoster(champ) {
  const solo = state.mode === 'solo';
  const hs = solo ? [{ peerId: 0, slot: 0 }] : humanList().map((h) => ({ peerId: h.peerId, slot: h.slot }));
  const base = { humans: hs, solo, mode: session.mode, difficulty: session.difficulty, names: session.names, bikes: session.bikes };
  if (champ) {
    champ.next();
    return { ...base, trackId: champ.trackId, seed: champ.raceSeed, champ: champ.serialise(), grid: champ.gridOrder() };
  }
  return { ...base, trackId: state.trackId, seed: (Math.random() * 0x7fffffff) | 0 };
}

const nameOf = (slot) => {
  if (session.champ) { const r = session.champ.riders.find((x) => x.id === slot); if (r) return session.champ.displayName(r); }
  if (race && race.riders[slot] && race.riders[slot].kind === 'human') {
    const h = curHumans.find((x) => x.slot === slot);
    if (h && session.names[h.peerId]) return session.names[h.peerId];
    return slot === mySlot ? 'You' : `Player ${joinOrder(race.humanSlots).indexOf(slot) + 1}`;
  }
  return AI_NAMES[slot] || `Rider ${slot + 1}`;
};

// ---------------------------------------------------------------- championship: results, standings, break, final
function saveChamp() {
  if (!session.champ || state.mode !== 'solo') return;
  lsSet(SAVE_KEY, JSON.stringify({ champ: session.champ.serialise(), names: session.names }));
}
const clearSaved = () => { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } };
function loadSaved() {
  const raw = lsGet(SAVE_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const c = restoreChampionship(o.champ);
    return c && !c.isOver ? { champ: c, names: o.names || {} } : null;
  } catch { return null; }
}
function savedSummary() {
  const sv = loadSaved();
  if (!sv) return null;
  const c = sv.champ, me = c.standings().find((r) => r.human);
  return { text: `race ${c.races.length + 1}/${c.total}, ${DIFFICULTY[c.difficulty].label}${me ? `, you are ${ord(me.rank)} with ${me.points} pts` : ''}` };
}
function resumeChampionship() {
  const sv = loadSaved();
  if (!sv) return false;
  const me0 = sv.champ.riders.find((x) => x.id === 0);
  const ros = { humans: [{ peerId: 0, slot: 0 }], solo: true, mode: 'championship', difficulty: sv.champ.difficulty, names: sv.names, bikes: { 0: normalizeBike(me0 && me0.bike) }, champ: sv.champ.serialise(), seed: 1, trackId: sv.champ.trackId };
  applySession(ros);
  roster = ros; state.mode = 'solo'; mySlot = 0; state.mySlot = 0; curHumans = ros.humans;
  state.trackId = session.champ.races.length ? session.champ.races[session.champ.races.length - 1].trackId : session.champ.trackId;
  hud.setVisible(true); hud.setPauseButton(true); input.setTouchVisible(true); qbar.classList.remove('on');
  enterBreak();
  return true;
}

/** Authority / solo: the race is over for all humans. Record it, sync, show standings. */
function finalizeChampRace() {
  const c = session.champ;
  if (!c || c.raceRecorded) return;
  const rows = race.riders.slice().sort((a, b) => a.place - b.place).map((r) => ({
    id: r.slot, place: r.place, timeS: r.finished ? r.finishT : null, togo: r.finished ? 0 : Math.max(0, Math.round(race.track.finishS - r.s)),
  }));
  c.recordRace(rows);
  logEv({ type: 'champ-record', index: c.index, order: rows.map((r) => r.id) });
  saveChamp();
  if (state.mode === 'multi') { try { nm.sendEvent('champ', { state: c.serialise(), index: c.index, breakS: BREAK_MIN_S }); } catch (e) { console.warn('champ', e); } }
  enterBreak();
}

function champTable(c, upTo) {
  const now = c.standings(upTo);
  const prev = upTo >= 2 ? c.standings(upTo - 1) : null;
  const prevRank = new Map(prev ? prev.map((r, i) => [r.id, i + 1]) : []);
  const prevPts = new Map(prev ? prev.map((r) => [r.id, r.points]) : []);
  return now.map((r) => ({
    id: r.id, name: r.name, total: r.points, prevTotal: prevPts.has(r.id) ? prevPts.get(r.id) : 0, prevRank: prevRank.get(r.id) || r.rank,
    gained: r.gained, delta: r.delta, me: r.id === mySlot, human: r.human, rank: r.rank, bike: r.bike,
  }));
}

function showChampResults() {
  const c = session.champ, k = c.races.length;
  const last = c.races[k - 1];
  const track = TRACKS[last.trackId];
  const mine = last.results.find((r) => r.id === mySlot);
  const rows = last.results.map((r) => ({
    place: r.place, name: nameOf(r.id), me: r.id === mySlot, kind: c.riders.find((x) => x.id === r.id).human ? 'human' : 'ai', bike: c.riders.find((x) => x.id === r.id).bike,
    time: r.timeS != null ? hud.fmt(r.timeS) : `${r.togo} m to go`, pts: `+${r.points}`,
  }));
  input.setTouchVisible(false); // the touch buttons must not sit on top of the results
  hud.showResults({
    rows, again: false,
    title: mine ? `You finished ${ord(mine.place)} of ${TOTAL} and scored ${mine.points} points` : 'Race over',
    champ: { heading: `Race ${k}/${c.total} complete: ${track.name}`, tableHeading: 'Championship standings', table: champTable(c, k), next: null, animate: true },
  });
}

/** Races are over; the break between races begins (or the final screen when the championship is complete). */
function enterBreak() {
  const c = session.champ;
  if (!c) return;
  state.paused = false; audio.resume(); hud.showPause(false);
  if (c.isOver) { enterFinal(); return; }
  state.screen = 'break';
  brk = { t: 0, stage: 0, isReady: false, startSent: false, ready: new Set(), nextTrack: null };
  showChampResults();
  hud.setBreakNote(`Next: race ${c.index + 2}/${c.total}, ${TRACKS[c.tracks[c.index + 1]].name}`);
  logEv({ type: 'break', index: c.index });
}

function enterFinal() {
  const c = session.champ;
  state.screen = 'final'; brk = null;
  const st = c.standings();
  const table = st.map((r) => ({ id: r.id, name: r.name, total: r.points, prevTotal: r.points, prevRank: r.rank, gained: 0, delta: 0, me: r.id === mySlot, human: r.human, rank: r.rank, bike: r.bike }));
  const humans = st.filter((r) => (state.mode === 'solo' ? r.id === mySlot : r.human || r.id === mySlot));
  const mineTxt = humans.map((r) => `${r.id === mySlot ? 'You' : r.name}: ${ord(r.rank)} with ${r.points} points`).join('   |   ');
  const multi = state.mode === 'multi';
  hud.showFinal({
    champion: `${st[0].name} wins the championship!`,
    podium: st.slice(0, 3).map((r) => ({ rank: r.rank, name: r.name, points: r.points, me: r.id === mySlot, human: r.human })),
    mine: mineTxt, table,
    button: !multi || nm.isAuthority ? 'Continue' : 'Leave', note: multi && !nm.isAuthority ? 'Waiting for the host to continue.' : '',
  });
  clearSaved();
  logEv({ type: 'final', champion: st[0].id, order: st.map((r) => r.id) });
}

function continueFinal() {
  if (state.screen !== 'final') return false;
  if (state.mode === 'multi' && nm.isAuthority) { try { nm.sendEvent('end', {}); } catch { /* ignore */ } }
  toMenu();
  return true;
}

function dropHumanFromChamp(peerId) {
  const c = session.champ;
  if (!c) return;
  const r = c.riders.find((x) => x.peerId === peerId && x.human);
  if (r && c.setAI(r.id)) logEv({ type: 'champ-ai', slot: r.id });
}

/** Advance the break clock; loads the next track in stages and starts the next race when due. */
function breakTick(dt) {
  if (!brk || state.paused) return;
  const c = session.champ;
  brk.t += dt;
  const stage = brk.stage;
  if (stage === 0 && brk.t >= 2.2) { // after the count-up and re-sort: build the next track (one frame of its own)
    brk.nextTrack = getTrack(c.tracks[c.index + 1]); brk.stage = 1;
  } else if (stage === 1) { // next frame: hand it to the renderer
    try { renderer.setTrack(brk.nextTrack); renderedTrack = brk.nextTrack; } catch (e) { logEv({ type: 'setTrack-error', message: String(e) }); renderedTrack = null; }
    brk.stage = 2;
  } else if (stage === 2) { // next frame: draw one frame from the new grid so shaders and bike meshes are warm, then say ready
    try { warmUp(brk.nextTrack); } catch (e) { logEv({ type: 'warm-error', message: String(e) }); }
    brk.stage = 3; brk.isReady = true;
    logEv({ type: 'break-ready', t: brk.t });
    if (state.mode === 'multi') { try { nm.sendEvent('ready', { index: c.index }); } catch { /* ignore */ } }
  }
  if (brk.t >= BREAK_HINT_S && !brk.isReady) hud.setBreakNote('Loading next race...');
  else if (brk.isReady || brk.t < BREAK_HINT_S) hud.setBreakNote(`Next: race ${c.index + 2}/${c.total}, ${TRACKS[c.tracks[c.index + 1]].name}${brk.t >= BREAK_MIN_S ? '' : ` in ${Math.max(1, Math.ceil(BREAK_MIN_S - brk.t))}`}`);
  if (state.mode === 'multi' && !nm.isAuthority) return; // the authority decides the start
  if (!brk.isReady && brk.t < BREAK_CAP_S) return;
  if (brk.t < BREAK_MIN_S) return;
  if (state.mode === 'multi' && brk.t < BREAK_CAP_S) {
    for (const h of humanList()) if (h.peerId !== nm.localId && !brk.ready.has(h.peerId)) return;
  }
  launchNext();
}

const warmRace = { race: null };
function warmUp(track) {
  const wr = createRace({ track, seed: 1, humans: 1 });
  warmRace.race = wr;
  const r = wr.riders[0];
  const inf = { kind: 'human', attacking: false, side: 1, weapon: null, bikeType: r.bike.spec.id };
  renderer.updateRider(0, r.bike, inf);
  if (!NORENDER) renderer.render(r.bike, 0.016);
  warmRace.race = null;
}

function launchNext() {
  if (!brk || brk.startSent) return;
  brk.startSent = true;
  const c = session.champ;
  const ros = nextRoster(c);
  if (state.mode === 'multi') { try { nm.sendEvent('start', { raceT0: 0, roster: ros }); } catch (e) { console.warn('start', e); } }
  startRace(ros.trackId, ros);
}

/** Reliable network events of the championship / next-race protocol. @returns {boolean} true when consumed */
function netEvent(type, payload, from) {
  if (type === 'champ' && payload && payload.state) {
    if (nm.isAuthority) return true;
    const c = restoreChampionship(payload.state);
    if (!c || !state.screen || state.mode !== 'multi') return true;
    session.champ = c; session.mode = 'championship';
    if (state.screen === 'race' || state.screen === 'break') { if (state.screen === 'race') enterBreak(); }
    return true;
  }
  if (type === 'ready') { if (brk) brk.ready.add(from); return true; }
  if (type === 'end') { if (state.mode === 'multi' && (state.screen === 'final' || state.screen === 'break' || state.screen === 'race')) endMultiplayer('The host ended the game.'); return true; }
  if (type === 'start' && payload && payload.roster) {
    if (nm.isAuthority || state.mode !== 'multi' || !(state.screen === 'race' || state.screen === 'break')) return true;
    startRace(payload.roster.trackId, payload.roster);
    return true;
  }
  return false;
}

lobby = createLobby(document.getElementById('lobby'), nm, {
  audio,
  tracks: Object.fromEntries(Object.values(TRACKS).map((t) => [t.id, t.name])),
  roomOptions: params.get('signal') === 'broadcast' ? { signaller: () => new BroadcastSignaller(), stun: false } : {},
  onStart: (trackId, ros) => { if (ros.solo) prepareRoster(ros); startRace(ros.trackId || trackId, ros); },
  prepare: (r) => prepareRoster(r),
  // rotating 3D bike in the bike select (feature-detected; off in the e2e runs unless ?preview=1)
  bikePreview: !NORENDER && (!E2E || params.get('preview') === '1') && typeof renderer.bikeMenuPreview === 'function'
    ? (el, type) => renderer.bikeMenuPreview(el, type, 0, { quality: state.quality === 'high' ? 'medium' : state.quality })
    : null,
  savedChampionship: () => savedSummary(),
  onResume: () => resumeChampionship(),
  onAbandon: () => clearSaved(),
  onRoster: () => {},
});

// ---------------------------------------------------------------- input -> race
const curIn = { throttle: 0, brake: 0, steer: 0, attack: null, attackSide: 1 };
const latch = { weapon: null, side: 1, until: -1 };
const _l = { x: 0, y: 0 };

/** Side of the nearest rider within reach (+1 left, -1 right), or 0 when nobody is close. */
function autoSide(rider) {
  const b = rider.bike, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const lx = -c, lz = s, fx = -s, fz = -c;
  let best = 7 * 7, side = 0;
  for (const o of race.riders) {
    if (o === rider || o.bike.crashed) continue;
    const dx = o.bike.pos.x - b.pos.x, dz = o.bike.pos.z - b.pos.z;
    const f = dx * fx + dz * fz;
    if (f > 4 || f < -3) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; side = (dx * lx + dz * lz) >= 0 ? 1 : -1; }
  }
  return side;
}

const smp = { x: 0, y: 0, z: 0, hx: 0, hz: 0, yaw: 0, curve: 0, grade: 0, bank: 0 };
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Test hook: a simple lane-keeping autopilot (steer by look-ahead heading, brake for corners and slower cars). */
function pilot(out) {
  const r = race.riders[mySlot], b = r.bike, tr = race.track;
  const sp = Math.max(b.speed, 0);
  const look = clampN(sp * 0.6 + 8, 10, 50);
  tr.sampleAt(Math.min(r.s + look, tr.length - 1), smp);
  const yawErr = wrapA(smp.yaw - b.yaw);
  const dErr = -1.8 - r.d;
  out.steer = clampN((1.8 * yawErr + clampN(0.09 * dErr, -0.25, 0.25)) / Math.max(0.2, leanScaleAt(b.spec, sp)), -1, 1);
  let vmax = 80;
  for (let k = 0; k <= 8; k++) {
    const dist = k * 20;
    tr.sampleAt(Math.min(r.s + dist, tr.length - 1), smp);
    const c = Math.abs(smp.curve);
    const vc = c > 1e-4 ? maxCornerSpeed(b.spec, c, 0.75, 8) : 90; // what this bike can really hold there (the lean ceiling falls with speed)
    vmax = Math.min(vmax, Math.sqrt(vc * vc + 2 * 5 * dist));
  }
  const cars = race.traffic;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active) continue;
    const ds = c.s - r.s;
    if (ds > 0 && ds < 32 && Math.abs(c.d - r.d) < 2.6) vmax = Math.min(vmax, c.dir > 0 ? c.speed * 0.9 : 12);
  }
  out.throttle = sp < vmax ? 1 : 0;
  out.brake = sp > vmax + 4 ? clampN((sp - vmax) / 12, 0.2, 1) : 0;
  out.attack = null;
  return out;
}

function readInput() {
  const raw = input.read();
  if (pilotOn) { pilot(curIn); }
  else {
    curIn.throttle = raw.throttle; curIn.brake = raw.brake; curIn.steer = raw.steer;
    if (raw.attack) {
      let side = raw.attackSide;
      if (raw.sideAuto) { const a = autoSide(race.riders[mySlot]); if (a) side = a; }
      latch.weapon = raw.attack; latch.side = side; latch.until = race.t + 0.3;
      lastWeapon = raw.attack;
    }
  }
}

// ---------------------------------------------------------------- simulation
const prevL = { x: 0, y: 0, z: 0, yaw: 0, lean: 0, init: false };

function simStep() {
  const r = race.riders[mySlot], b = r.bike;
  prevL.x = b.pos.x; prevL.y = b.pos.y; prevL.z = b.pos.z; prevL.yaw = b.yaw; prevL.lean = b.lean; prevL.init = true;
  // attack latch: deliver the press until the swing starts
  if (race.t < latch.until && !r.swing.active) { curIn.attack = latch.weapon; curIn.attackSide = latch.side; } else { curIn.attack = null; }
  if (r.finished) { curIn.throttle = 0; curIn.brake = 0.6; curIn.steer = 0; curIn.attack = null; }
  stepRace(race, SIM_DT, { [mySlot]: curIn });
  if (r.swing.active) latch.until = -1;
  const ev = race.events;
  if (ev.length) {
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'hit') { if (e.from === mySlot) audio.event('hit', { weapon: r.swing.weapon || (race.riders[e.from] && race.riders[e.from].swing.weapon) }); if (ws) { ws.sendHit(race, e); hits.sent++; } logEv({ type: 'hit', from: e.from, to: e.to, id: e.id }); }
      else if (e.type === 'crash') { logEv({ type: 'crash', slot: e.slot, cause: e.cause, t: race.t }); if (e.slot === mySlot) { hud.toast('WIPEOUT!', 1800); audio.event(e.cause === 'wall' ? 'wall' : 'crash'); if (e.cause === 'wall') audio.event('crash'); } else if (nearRider(e.slot, 35)) audio.event('bump'); }
      else if (e.type === 'remount') logEv({ type: 'remount', slot: e.slot, t: race.t });
      else if (e.type === 'finish') { logEv({ type: 'finish', slot: e.slot, place: e.place, t: e.t }); if (e.slot === mySlot) audio.event('finish', { place: e.place }); if (e.slot === mySlot && resultsAt < 0) resultsAt = race.t + 2; }
      else if (e.type === 'blow') { logEv({ type: 'blow', from: e.from, to: e.to, damage: e.damage }); if (e.from === mySlot) { hud.toast('HIT!', 700); audio.event('hit', { weapon: race.riders[mySlot].swing.weapon }); } else if (e.to === mySlot) audio.event('hit', { taken: true, weapon: e.from >= 0 && race.riders[e.from] ? race.riders[e.from].swing.weapon : 'punch' }); }
      else if (e.type === 'go') { goShownAt = race.t; audio.event('go'); logEv({ type: 'go' }); }
      else if (e.type === 'carhit') { if (e.slot === mySlot) audio.event('carhit'); logEv({ type: 'carhit', slot: e.slot }); }
    }
    ev.length = 0;
  }
}

function frameNet(now) {
  if (!ws) return;
  applyRemotes(now);
  ws.guestApply(race, now);
}
function frameNetAfter(now) {
  if (!ws) return;
  pushLocalState();
  nm.update(now);
  ws.hostTick(race, now);
}

function checkResults() {
  const r = race.riders[mySlot];
  const c = session.champ;
  if (c && !c.raceRecorded && (state.mode === 'solo' || nm.isAuthority)) {
    // the authority records the race once every human has finished (+2 s), or 120 s after the first human did
    const hs = race.riders.filter((x) => x.kind === 'human');
    if (hs.length && hs.every((x) => x.finished)) { if (doneAt < 0) doneAt = race.t + 2; if (race.t >= doneAt) { finalizeChampRace(); return; } }
    else if (hs.some((x) => x.finished)) { if (firstAt < 0) firstAt = race.t; if (race.t - firstAt > 120) { finalizeChampRace(); return; } }
  }
  if (!hud.resultsOpen) {
    if ((r.finished && resultsAt >= 0 && race.t >= resultsAt) || race.phase === 'finished' && r.finished) openResults();
  } else if (performance.now() - resultsTick > 500) { resultsTick = performance.now(); openResults(); }
}

function openResults() {
  const list = race.riders.slice().sort((a, b) => a.place - b.place);
  const me = race.riders[mySlot];
  const rows = list.map((r) => {
    const mine = r.slot === mySlot;
    return { place: r.place, name: mine ? 'You' : nameOf(r.slot), me: mine, kind: r.kind === 'human' ? 'human' : 'ai', bike: r.bike.spec.id, time: r.finished ? hud.fmt(r.finishT) : `${Math.max(0, Math.round(race.track.finishS - r.s))} m to go` };
  });
  const solo = state.mode === 'solo';
  input.setTouchVisible(false); // the touch buttons must not sit on top of the results
  hud.showResults({
    rows, title: `You finished ${ord(me.place)} of ${TOTAL}${me.finished ? ' in ' + hud.fmt(me.finishT) : ''}`,
    again: !session.champ, againText: solo || nm.isAuthority ? 'Race again' : 'Waiting for host...', againDisabled: !solo && !nm.isAuthority,
  });
}
function ord(n) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }

// ---------------------------------------------------------------- rendering
const scratch = [];
const infoPool = [];
const rbPos = { x: 0, y: 0, z: 0 };
const rb = { pos: rbPos }; // interpolated copy of the local bike
const carsView = [];

function wobble(r) {
  const hf = r.hitFx;
  if (!hf || !(hf.t > 0)) return 0;
  const k = Math.min(1, hf.t / 0.3);
  return clampN(-(hf.side || 1) * (hf.strength || 1) * 0.22 * Math.sin(hf.t * 28) * k, -0.4, 0.4);
}

function renderFrame(dtReal, alpha) {
  const riders = race.riders;
  const me = riders[mySlot];
  for (let i = 0; i < riders.length; i++) {
    const r = riders[i];
    let bike = r.bike;
    if (i === mySlot) {
      Object.assign(rb, bike);
      const p = bike.pos;
      rb.pos = rbPos;
      const ok = prevL.init && Math.abs(p.x - prevL.x) + Math.abs(p.z - prevL.z) < 5;
      const a = ok ? alpha : 1;
      rbPos.x = prevL.x + (p.x - prevL.x) * a; rbPos.y = prevL.y + (p.y - prevL.y) * a; rbPos.z = prevL.z + (p.z - prevL.z) * a;
      if (ok) { rb.yaw = prevL.yaw + wrapA(bike.yaw - prevL.yaw) * a; rb.lean = prevL.lean + (bike.lean - prevL.lean) * a; }
      bike = rb;
    }
    const w = wobble(r);
    if (w !== 0 && bike !== rb) {
      const sc = scratch[i] || (scratch[i] = { pos: { x: 0, y: 0, z: 0 } });
      const pos = sc.pos; Object.assign(sc, bike); sc.pos = pos; pos.x = bike.pos.x; pos.y = bike.pos.y; pos.z = bike.pos.z;
      sc.lean = bike.lean + w; bike = sc;
    } else if (w !== 0) rb.lean += w;
    const inf = infoPool[i] || (infoPool[i] = { kind: 'ai', attacking: false, side: 1, weapon: null, bikeType: 'street' });
    inf.kind = r.kind;
    inf.bikeType = r.bike.spec.id; // every rider's own model (remote humans too: their type came with the roster)
    const ni = r.netInfo;
    if (r.remote && ni) { inf.attacking = ni.attacking; inf.side = ni.side; inf.weapon = ni.weapon; }
    else { inf.attacking = !!r.input.attack; inf.side = r.input.attackSide; inf.weapon = r.input.attack; }
    renderer.updateRider(i, bike, inf);
  }
  carsView.length = 0;
  const cars = race.traffic;
  for (let i = 0; i < cars.length; i++) if (cars[i].active) carsView.push(cars[i]);
  renderer.updateTraffic(carsView);
  renderer.drawRagdolls(ragdolls(race.destruction));
  renderer.drawDebris(debris(race.destruction));
  renderer.render(prevL.init ? rb : me.bike, dtReal);
}

// ---------------------------------------------------------------- audio
const audState = { paused: false, type: 'street', speed: 0, topSpeed: 50, throttle: 0, brake: 0, drifting: false, slip: 0, airborne: false, crashed: false, grip: 1, nearby: [], nearbyCount: 0 };
for (let i = 0; i < 32; i++) audState.nearby.push({ id: 0, rx: 0, rz: 0, speed: 0, topSpeed: 50, closing: 0, type: 'street' });
let cdBeep = 0;
function nearRider(slot, m) {
  const o = race && race.riders[slot], me = race && race.riders[mySlot];
  if (!o || !me) return false;
  return Math.hypot(o.bike.pos.x - me.bike.pos.x, o.bike.pos.z - me.bike.pos.z) < m;
}
function addNear(id, px, pz, vx, vz, speed, topSpeed, type, me, cy, sy, n) {
  const dx = px - me.pos.x, dz = pz - me.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 100 || n >= 32) return n;
  const e = audState.nearby[n];
  e.id = id; e.rx = dx * cy - dz * sy; e.rz = -dx * sy - dz * cy;
  e.speed = speed; e.topSpeed = topSpeed; e.type = type;
  e.closing = dist > 0.01 ? -(((vx - me.vel.x) * dx + (vz - me.vel.z) * dz) / dist) : 0;
  return n + 1;
}
/** Feed the audio engine once per rendered frame: the local bike, the nearest riders / cars, countdown beeps. */
function audioFrame(dt) {
  const riders = race.riders, me = riders[mySlot].bike;
  const cd = race.phase === 'countdown' || race.phase === 'grid' ? Math.max(1, Math.ceil(COUNTDOWN - race.t)) : 0;
  if (cd > 0 && cd !== cdBeep) { cdBeep = cd; audio.event('beep'); } else if (cd === 0) cdBeep = 0;
  const a = audState;
  a.paused = state.paused;
  a.type = me.spec.id; a.speed = Math.abs(me.speed) / SPEED_SCALE; a.topSpeed = me.spec.topSpeed / SPEED_SCALE; /* sound follows the displayed speed, not the lowered real one */
  a.throttle = me.throttle; a.brake = me.brake; a.drifting = me.drifting; a.slip = me.slip;
  a.airborne = me.airborne; a.crashed = me.crashed;
  a.grip = race.track.gripAt(me.pos.x, me.pos.z);
  const cy = Math.cos(me.yaw), sy = Math.sin(me.yaw);
  let n = 0;
  for (let i = 0; i < riders.length; i++) {
    if (i === mySlot) continue;
    const b = riders[i].bike;
    if (b.crashed) continue;
    n = addNear(i, b.pos.x, b.pos.z, b.vel.x, b.vel.z, Math.abs(b.speed) / SPEED_SCALE, b.spec.topSpeed / SPEED_SCALE, b.spec.id, me, cy, sy, n);
  }
  const cars = race.traffic;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active || c.hit) continue;
    n = addNear(100 + c.id, c.pos.x, c.pos.z, c.vel.x, c.vel.z, c.speed, 0, 'car', me, cy, sy, n);
  }
  a.nearbyCount = n;
  audio.update(dt, a);
}

const dotsOut = [];
function updateHud() {
  const r = race.riders[mySlot], b = r.bike, tr = race.track;
  const racing = race.phase === 'racing' || race.phase === 'finished';
  const raceT = race.t - COUNTDOWN;
  let hint = '';
  if (b.crashed) hint = 'WIPEOUT';
  else if (racing && !r.finished) {
    if (Math.abs(b.speed) > 2 && Math.abs(wrapA(b.yaw - r.yaw)) > 1.9) hint = 'WRONG WAY';
    else if (Math.abs(r.d) > tr.halfWidth + tr.shoulder) hint = 'OFF ROAD';
  }
  let count = '';
  if (race.phase === 'countdown' || race.phase === 'grid') count = String(Math.max(1, Math.ceil(COUNTDOWN - race.t)));
  else if (goShownAt >= 0 && race.t - goShownAt < 1) count = 'GO!';
  dotsOut.length = 0;
  for (let i = 0; i < race.riders.length; i++) {
    const o = race.riders[i];
    dotsOut[i] = { p: clampN(o.progress != null ? o.progress : o.s / tr.finishS, 0, 1), kind: i === mySlot ? 'me' : o.kind === 'human' ? 'human' : 'ai' };
  }
  const n = race.humanSlots.length;
  const sideTxt = input.read === undefined ? '' : 'auto-side';
  void sideTxt;
  hud.update({
    speedKmh: Math.abs(b.speed) * 3.6 * DISPLAY_SPEED_SCALE / (b.boost > 0 ? b.boost : 1), /* display scale: real speeds are low for handling; the readout keeps the old numbers at the same share of top speed */ health: b.health / b.spec.health * 100, place: r.place, total: TOTAL,
    timeS: r.finished ? r.finishT : Math.max(0, raceT), count, hint, dots: dotsOut,
    riders: `${n} ${n === 1 ? 'rider' : 'riders'} + ${TOTAL - n} AI`,
    net: state.mode === 'solo' ? 'solo' : (nm.isAuthority ? 'host' : 'guest') + (race.authority === 'host' && !roster.solo ? ' (runs AI)' : ''),
    weapon: lastWeapon, attacking: !!r.input.attack, side: 'AUTO',
    meta: DIFFICULTY[session.difficulty].label + ' | ' + BIKE_INFO[b.spec.id].name + (session.champ ? ` | Race ${session.champ.index + 1}/${session.champ.total}` : ''),
  });
}

// ---------------------------------------------------------------- loop
function tickRace(now, dtReal) {
  if (state.paused) return;
  frameNet(now);
  readInput();
  acc += dtReal;
  let steps = 0;
  while (acc >= SIM_DT && steps < MAX_SUBSTEPS) { simStep(); acc -= SIM_DT; steps++; }
  if (steps >= MAX_SUBSTEPS) acc = 0;
  frameNetAfter(now);
  if (race) checkResults();
}

function frame(now) {
  if (!E2E || params.get('rt') === '1') {
    if (last === null) last = now;
    const dtReal = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (race && state.screen === 'race') {
      tickRace(now, dtReal);
      if (race && !NORENDER) { renderFrame(state.paused ? 0 : dtReal, acc / SIM_DT); updateHud(); } // paused: the picture stands still (no camera shake)
      else if (race) updateHud();
      if (race) audioFrame(dtReal);
    } else if (state.screen === 'break') {
      breakFrame(now, dtReal);
    }
  }
  if (!NORENDER || !E2E) requestAnimationFrame(frame);
}

/** One realtime frame of the championship break: keep the links alive and advance the break clock. */
function breakFrame(now, dtReal) {
  if (state.mode === 'multi') { try { nm.update(now); } catch { /* ignore */ } }
  breakTick(dtReal);
}

// hidden tab: pause solo; keep multiplayer ticking at a low rate without rendering
let bgTimer = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend(); else if (!state.paused) audio.resume();
  if (document.hidden) {
    if (state.mode === 'solo' && race && state.screen === 'race' && !hud.resultsOpen) setPaused(true);
    if (!bgTimer && !(E2E && NORENDER)) {
      bgTimer = setInterval(() => {
        if (!race || state.mode !== 'multi') return;
        const now = performance.now();
        if (last === null) last = now;
        const dt = Math.min((now - last) / 1000, 0.5);
        last = now;
        frameNet(now); readInput();
        acc += dt;
        let steps = 0;
        while (acc >= SIM_DT && steps < 60) { simStep(); acc -= SIM_DT; steps++; }
        frameNetAfter(now);
      }, 100);
    }
  } else {
    if (bgTimer) { clearInterval(bgTimer); bgTimer = 0; }
    last = null;
  }
});

if (E2E && NORENDER) setInterval(() => frame(performance.now()), 16);

// ---------------------------------------------------------------- test hooks
function stepFrames(n, opts = {}) {
  if (state.screen === 'break') { // championship break: the test clock advances it (no real-time waiting)
    let k = 0;
    for (; k < n && state.screen === 'break'; k++) breakTick(SIM_DT);
    return k;
  }
  if (!race) return 0;
  const now = performance.now();
  let i = 0;
  for (; i < n; i++) {
    if (i % 4 === 0 || !prevL.init) readInput();
    simStep();
    if (state.screen !== 'race' || !race) break;
  }
  if (race) { checkResults(); if (opts.render !== false && !NORENDER) { renderFrame(0.1, 1); updateHud(); } else updateHud(); }
  void now;
  return i;
}

window.__game = {
  get race() { return race; },
  get track() { return race ? race.track : null; },
  get me() { return mySlot; },
  get ws() { return ws; },
  get hits() { return hits; },
  renderer, nm, hud, input, state, log, audio,
  get lobby() { return lobby; },
  startSolo(trackId, opts = {}) {
    if (opts.quality) setQuality(opts.quality);
    const id = trackId || Object.keys(TRACKS)[0];
    lobby.hide();
    return startRace(id, { humans: [{ peerId: 0, slot: 0 }], seed: opts.seed != null ? opts.seed : 12345, trackId: id, solo: true, bikes: { 0: normalizeBike(opts.bike) } });
  },
  get session() { return session; },
  get champ() { return session.champ; },
  get brk() { return brk; },
  /** Start a solo championship (test hook). */
  startChampionship(opts = {}) {
    if (opts.quality) setQuality(opts.quality);
    lobby.hide();
    const ros = prepareRoster({ humans: [{ peerId: 0, slot: 0 }], seed: opts.seed != null ? opts.seed : 12345, solo: true, mode: 'championship', difficulty: opts.difficulty, names: opts.name ? { 0: opts.name } : {}, bikes: { 0: normalizeBike(opts.bike) } });
    return startRace(ros.trackId, ros);
  },
  /** Start a solo single race with a difficulty (test hook). */
  startSoloLevel(trackId, difficulty, opts = {}) {
    lobby.hide();
    const ros = prepareRoster({ humans: [{ peerId: 0, slot: 0 }], seed: opts.seed != null ? opts.seed : 12345, trackId, solo: true, mode: 'single', difficulty, bikes: { 0: normalizeBike(opts.bike) } });
    return startRace(trackId, ros);
  },
  resumeChampionship, continueFinal, nameOf,
  stepFrames,
  stepSeconds(s, opts) { return stepFrames(Math.round(s / SIM_DT), opts); },
  renderNow() { if (race) { renderFrame(0.1, 1); updateHud(); } },
  setInput(o) { input.override(o); },
  pilot(on) { pilotOn = on !== false; },
  /** Put a rider at track position s, lateral d, with a forward speed (m/s). */
  placeAt(slot, s, d = 0, speed = 0) {
    const r = race.riders[slot], tr = race.track, b = r.bike;
    tr.sampleAt(s, smp);
    const lx = -smp.hz, lz = smp.hx;
    b.pos.x = smp.x + lx * d; b.pos.z = smp.z + lz * d; b.pos.y = tr.heightAt(b.pos.x, b.pos.z);
    b.yaw = smp.yaw; b.speed = speed; b.vel.x = smp.hx * speed; b.vel.z = smp.hz * speed; b.vel.y = 0;
    r.s = s; r.d = d;
  },
  again, toMenu, setQuality, syncHumans,
  SIM_DT,
  setPaused,
};

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

lobby.show();
qbar.classList.add('on');
requestAnimationFrame(frame);
