// AI difficulty: three levels ('easy' | 'medium' | 'hard', default medium) and the knobs each one turns.
// Pure data, no DOM. Hard is the original tuned AI (close to what the physics allow: pushing the corner speed much past it
// piles the field up), medium is a little more relaxed, easy clearly slower and sloppier.
// Every knob is a plain number, so a level is deterministic: the same (seed, level) always gives the same race.

/** The selectable levels, easiest first. */
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
/** The level used when none is chosen. */
export const DEFAULT_DIFFICULTY = 'medium';

/**
 * Knobs per level.
 *  pace        multiplier on each rival's cruise speed (share of its top speed it uses on straights)
 *  corner      multiplier on the share of the ideal (lean-limited) corner speed it carries
 *  brake       multiplier on its braking confidence (planned deceleration into corners; lower = brakes earlier)
 *  clearK      overtaking: size of the oncoming-lane window it wants clear before pulling out (higher = more timid)
 *  pullK       overtaking: how far behind a slower rider it pulls out (higher = earlier, more timid)
 *  laneCost    overtaking: cost of using the centre / oncoming lane (higher = stays behind longer)
 *  wobble      multiplier on lane-keeping wobble (precision: lower = a straighter, tidier line)
 *  laneRate    lateral target slew rate, m/s (reaction speed of lane changes)
 *  swingStart  race seconds before the AI may start swinging
 *  swingCd     multiplier on the pause between swings
 *  swingP      multiplier on the chance a possible swing at a HUMAN is thrown (times the rider's aggression)
 *  defend      0..1 how strongly a rider blocks the line of a human right behind it
 *  match       share (0..1) of the speed difference to a human within 50 m that a rival closes (see RivalAI, pack behaviour)
 *  rbAhead     rubber band: slow-down at 250 m (or more) ahead of the best human, as a share of speed
 *  rbBehind    rubber band: speed-up at 250 m (or more) behind the best human
 *  mistakeEvery  mean seconds between mistakes (brake too early / run wide); 0 = never
 *  weapon      cumulative cut-offs [punch, baton] of a rival's fixed random draw (the rest carry the chain)
 */
export const DIFFICULTY = {
  easy: {
    id: 'easy', label: 'Easy', pace: 0.82, corner: 0.74, brake: 0.82, clearK: 1.3, pullK: 1.25, laneCost: 1.4, wobble: 1.8, laneRate: 2.4,
    swingStart: 12, swingCd: 1.9, swingP: 0.4, defend: 0, match: 0.97, rbAhead: 0.32, rbBehind: 0.12, mistakeEvery: 24, weapon: [0.78, 0.96],
  },
  medium: {
    id: 'medium', label: 'Medium', pace: 0.9, corner: 0.87, brake: 0.92, clearK: 1, pullK: 1, laneCost: 1, wobble: 1, laneRate: 3.5,
    swingStart: 6, swingCd: 1, swingP: 1, defend: 0.25, match: 0.97, rbAhead: 0.24, rbBehind: 0.24, mistakeEvery: 0, weapon: [0.45, 0.78],
  },
  hard: {
    id: 'hard', label: 'Hard', pace: 1.06, corner: 1.05, brake: 1.03, clearK: 0.9, pullK: 0.9, laneCost: 0.6, wobble: 0.4, laneRate: 3.8,
    swingStart: 3, swingCd: 0.55, swingP: 1.7, defend: 0.8, match: 0.95, rbAhead: 0, rbBehind: 0.06, mistakeEvery: 0, weapon: [0.2, 0.55],
  },
};

/**
 * Clamp anything to a valid level id.
 * @param {*} d candidate
 * @returns {'easy'|'medium'|'hard'}
 */
export function normalizeDifficulty(d) { return DIFFICULTY[d] ? d : DEFAULT_DIFFICULTY; }

/**
 * Knob table of a level (unknown ids fall back to medium).
 * @param {string} d level id
 * @returns {object} one entry of DIFFICULTY
 */
export function difficultyParams(d) { return DIFFICULTY[normalizeDifficulty(d)]; }
