// Championship (Grand Prix) logic: a tournament of several tracks, points per finishing place, running totals.
// Pure data and logic, no DOM, no Math.random / Date. State is plain JSON so it can be saved (localStorage) and synced
// (the multiplayer authority sends the full serialised state after every race, so any device can take over).

import { DEFAULT_DIFFICULTY, normalizeDifficulty } from './Difficulty.js';

/** The tracks of a championship in racing order, easy to hard. Data-driven: pass `tracks` to createChampionship to change it. */
export const DEFAULT_TRACK_ORDER = ['valley', 'coast', 'sierra', 'desert', 'redwood'];

/** Points by finishing place (index 0 = 1st). 15 riders, everyone from 1st to 15th scores. */
export const POINTS = [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/**
 * Points for a finishing place.
 * @param {number} place 1-based place
 * @returns {number} 0 beyond the table
 */
export function pointsForPlace(place) { return POINTS[place - 1] || 0; }

const mix = (a, b) => (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 1;

/**
 * Seed of race `index` of a championship (a pure function of the championship seed, so every device agrees).
 * @param {number} seed championship seed
 * @param {number} index 0-based race index
 * @returns {number} non-negative 31-bit seed
 */
export function raceSeed(seed, index) { return mix(mix(seed, 0x5eed + index), index + 1) | 0; }

/**
 * The one standings comparator (table and grid): more points; then countback over all races so far (more 1st places, then
 * more 2nd places, and so on down to 15th); then the better (lower) place in the most recent race; then the lower slot id,
 * so the order is the same on every device.
 * @param {{id:number,points:number,counts:number[],lastPlace:number}} a row
 * @param {{id:number,points:number,counts:number[],lastPlace:number}} b row
 * @returns {number} negative when a ranks ahead of b
 */
export function compareStandings(a, b) {
  if (a.points !== b.points) return b.points - a.points;
  for (let k = 0; k < a.counts.length; k++) if (a.counts[k] !== b.counts[k]) return b.counts[k] - a.counts[k];
  if (a.lastPlace !== b.lastPlace) return a.lastPlace - b.lastPlace;
  return a.id - b.id;
}

/**
 * Starting grid for the next race from the standings: slot ids, front to back. Leader on pole, last place at the back.
 * Flip with `{reverse: true}` (leader starts last) should the rule change; this is the only place that decides it.
 * @param {{id:number}[]} standings sorted standings (best first), as returned by Championship.standings()
 * @param {{reverse?:boolean}} [opts]
 * @returns {number[]} rider ids front to back (feed to Roster.computeGrid({order}))
 */
export function gridFromStandings(standings, { reverse = false } = {}) {
  const ids = standings.slice().sort(compareStandings).map((r) => r.id);
  return reverse ? ids.reverse() : ids;
}

/**
 * One championship. Riders are identified by `id` (the rider's grid slot 0..14, fixed for the whole championship).
 * A rider's `bike` ('sport' | 'street' | 'chopper', or null when unknown) is fixed for the whole championship too.
 */
export class Championship {
  /**
   * @param {object} data plain state (see serialise)
   */
  constructor(data) {
    this.tracks = data.tracks.slice();
    this.difficulty = normalizeDifficulty(data.difficulty);
    this.seed = data.seed | 0;
    this.riders = data.riders.map((r) => ({ id: r.id, name: r.name, human: !!r.human, peerId: r.peerId == null ? null : r.peerId, wasHuman: !!r.wasHuman, bike: r.bike || null }));
    /** Recorded races: {trackId, results:[{id, place, points, timeS, togo}]} in racing order. */
    this.races = (data.races || []).map((x) => ({ trackId: x.trackId, results: x.results.map((r) => ({ ...r })) }));
    /** 0-based index of the race to run next (== races.length until recorded; advanced by next()). */
    this.index = data.index | 0;
  }

  /** @returns {boolean} true once every track has been raced and recorded */
  get isOver() { return this.races.length >= this.tracks.length; }
  /** @returns {number} number of races in the championship */
  get total() { return this.tracks.length; }
  /** @returns {string|null} track of the race to run now (null when over) */
  get trackId() { return this.index < this.tracks.length ? this.tracks[this.index] : null; }
  /** @returns {number} seed of the race to run now */
  get raceSeed() { return raceSeed(this.seed, this.index); }
  /** @returns {boolean} the race at `index` has been recorded (its results are on screen) */
  get raceRecorded() { return this.races.length > this.index; }

  /**
   * Standings after the races recorded so far, best first. Rows: {rank, id, name, human, points, wins, lastPlace, gained, delta}.
   * `gained` = points of the last recorded race; `delta` = places gained(+)/lost(-) by that race (rank before it minus rank now).
   * @param {number} [upTo] count only the first `upTo` recorded races (default all)
   * @returns {object[]}
   */
  standings(upTo = this.races.length) {
    const n = Math.min(upTo, this.races.length);
    const rows = this._table(n);
    rows.sort(compareStandings);
    if (n >= 2) {
      const rank0 = new Map(this._table(n - 1).sort(compareStandings).map((r, i) => [r.id, i]));
      rows.forEach((r, i) => { r.delta = rank0.get(r.id) - i; });
    }
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /** Unsorted rows after the first n recorded races. */
  _table(n) {
    const rows = this.riders.map((r) => ({
      id: r.id, name: this.displayName(r), human: r.human, bike: r.bike, points: 0, wins: 0, counts: new Array(this.riders.length).fill(0), lastPlace: 99, gained: 0, delta: 0,
    }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (let i = 0; i < n; i++) {
      for (const res of this.races[i].results) {
        const row = byId.get(res.id);
        if (!row) continue;
        row.points += res.points;
        if (res.place >= 1 && res.place <= row.counts.length) row.counts[res.place - 1]++;
        if (res.place === 1) row.wins++;
        row.lastPlace = res.place;
        row.gained = i === n - 1 ? res.points : row.gained;
      }
    }
    return rows;
  }

  /**
   * Name shown for a rider: the name, plus " (AI)" once a human's entry has been taken over by the AI.
   * @param {{name:string,human:boolean,wasHuman:boolean}} r
   * @returns {string}
   */
  displayName(r) { return r.wasHuman && !r.human ? `${r.name} (AI)` : r.name; }

  /**
   * Record the race at the current index. Idempotent: recording again for an already recorded race changes nothing.
   * @param {{id:number, place:number, timeS?:number|null, togo?:number}[]} results one row per rider (id = slot), places 1..n distinct.
   *   A rider that had not finished is placed by track progress by the caller and may carry `togo` (metres left); it still scores.
   * @returns {object[]} the standings after this race
   */
  recordRace(results) {
    if (this.raceRecorded || this.isOver) return this.standings();
    const known = new Set(this.riders.map((r) => r.id));
    const rows = results.filter((r) => known.has(r.id)).map((r) => ({
      id: r.id, place: r.place | 0, points: pointsForPlace(r.place | 0), timeS: r.timeS == null ? null : r.timeS, togo: r.togo == null ? 0 : r.togo,
    })).sort((a, b) => a.place - b.place);
    this.races.push({ trackId: this.tracks[this.index], results: rows });
    return this.standings();
  }

  /**
   * Move on to the next race (only after the current one was recorded).
   * @returns {string|null} the next track id, or null when the championship is over
   */
  next() {
    if (!this.raceRecorded) return this.trackId;
    if (this.index < this.tracks.length) this.index++;
    return this.trackId;
  }

  /**
   * Grid for the race to run now, slot ids front to back, or null for race 1 (the game puts humans at the back there).
   * @param {{reverse?:boolean}} [opts] see gridFromStandings
   * @returns {number[]|null}
   */
  gridOrder(opts) { return this.races.length === 0 ? null : gridFromStandings(this.standings(), opts); }

  /**
   * A human's entry is taken over by the AI (the player dropped): the entry keeps its points; the name shows "(AI)".
   * @param {number} id rider id (slot)
   * @returns {boolean} true when something changed
   */
  setAI(id) {
    const r = this.riders.find((x) => x.id === id);
    if (!r || !r.human) return false;
    r.human = false; r.wasHuman = true; r.peerId = null;
    return true;
  }

  /**
   * The rider ended up with the given name (e.g. a lobby name arrived late).
   * @param {number} id rider id
   * @param {string} name display name
   * @returns {void}
   */
  rename(id, name) { const r = this.riders.find((x) => x.id === id); if (r && name) r.name = name; }

  /** @returns {object} plain JSON state; restoreChampionship(serialise()) gives an equal championship */
  serialise() {
    return {
      v: 1, tracks: this.tracks.slice(), difficulty: this.difficulty, seed: this.seed, index: this.index,
      riders: this.riders.map((r) => ({ ...r })),
      races: this.races.map((x) => ({ trackId: x.trackId, results: x.results.map((r) => ({ ...r })) })),
    };
  }
}

/**
 * Create a championship.
 * @param {{tracks?:string[], riders:{id:number,name:string,human?:boolean,peerId?:number|null,bike?:string|null}[], difficulty?:string, seed?:number}} opts
 *   tracks: racing order (default DEFAULT_TRACK_ORDER); riders: all 15 entries (id = grid slot), at least one
 * @returns {Championship}
 */
export function createChampionship({ tracks = DEFAULT_TRACK_ORDER, riders, difficulty = DEFAULT_DIFFICULTY, seed = 1 }) {
  if (!Array.isArray(riders) || riders.length === 0) throw new Error('a championship needs riders');
  return new Championship({ tracks, riders, difficulty, seed, races: [], index: 0 });
}

/**
 * Rebuild a championship from `serialise()` output (e.g. localStorage or a network update).
 * @param {object|string} data state or its JSON text
 * @returns {Championship|null} null when the data is not a valid state
 */
export function restoreChampionship(data) {
  try {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    if (!d || !Array.isArray(d.tracks) || !Array.isArray(d.riders) || !Array.isArray(d.races)) return null;
    return new Championship(d);
  } catch { return null; }
}
