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
 *  pace        the level's pace: the share of its OWN bike's top speed a rival holds on a clear straight (the same share on every bike type)
 *  paceSpread  half-width of the band of shares inside a level (slot dependent): narrow, so the field bunches
 *  corner      multiplier on the share of the ideal (lean-limited) corner speed it carries
 *  brake       multiplier on its braking confidence (planned deceleration into corners; lower = brakes earlier)
 *  clearK      overtaking: size of the oncoming-lane window it wants clear before pulling out (higher = more timid)
 *  pullK       overtaking: how far behind a slower rider it pulls out (higher = earlier, more timid)
 *  laneCost    overtaking: cost of using the centre / oncoming lane (higher = stays behind longer)
 *  wobble      multiplier on lane-keeping wobble (precision: lower = a straighter, tidier line)
 *  laneRate    lateral target slew rate, m/s (reaction speed of lane changes)
 *  swingStart  race seconds before the AI may start swinging
 *  swingCd     multiplier on the pause between swings
 *  swingP      (legacy knob, ordered easy < hard) see `take`
 *  react       seconds an opening must last before the rival takes it, and before it blocks a rider behind (about halves per level)
 *  take        share of the openings (rider in reach, swing ready) it takes, times 0.55..1.45 of its aggression (clamped to 1)
 *  sight       0..1 how well it weighs the surroundings: 0 picks a plain option, 1 prefers a wheel kick that shoves the rider off the tarmac or into a car
 *  backOut     health share under which a rival stops fighting (holds fire)
 *  defend      0..1 how strongly a rider blocks the line of a human right behind it
 *  match       share (0..1) of the speed difference to a human within 50 m that a rival closes (see RivalAI, pack behaviour)
 *  rbRange     rubber band: distance (m) ahead of / behind the best human at which the band is at full strength
 *  rbAhead     rubber band: slow-down at rbRange (or more) ahead of the best human, as a share of speed
 *  rbBehind    rubber band: speed-up at rbRange (or more) behind the best human
 *  aiBoost     catch-up boost (extra acceleration and top speed, like the humans' place boost) of a rival 30..180 m behind the best human
 *  strag       catch-up boost of a rival 150..450 m behind the race leader (whoever it is): stragglers rejoin the field
 *  clearM      overtaking: safety margin (m) it keeps between itself and an oncoming car it has passed through the oncoming lane before
 *  mistakeEvery  mean seconds between mistakes (brake too early / run wide); 0 = never
 *  weapon      cut-offs of a rival's fixed random draw: below the second value the rival punches, above it kicks
 */
export const DIFFICULTY = {
  easy: {
    id: 'easy', label: 'Easy', pace: 0.8, paceSpread: 0.02, corner: 0.74, brake: 0.82, clearK: 1.3, clearM: 30, pullK: 1.25, laneCost: 1.4, wobble: 1.8, laneRate: 2.4,
    swingStart: 12, swingCd: 2, swingP: 0.4, react: 0.7, take: 0.25, sight: 0, backOut: 0.5, defend: 0, match: 0.97, rbRange: 120, rbAhead: 0.32, rbBehind: 0.1, aiBoost: 0.03, strag: 0.05, mistakeEvery: 24, weapon: [0.78, 0.96],
  },
  medium: {
    id: 'medium', label: 'Medium', pace: 0.905, paceSpread: 0.02, corner: 0.87, brake: 0.92, clearK: 1, clearM: 16, pullK: 0.95, laneCost: 1, wobble: 0.6, laneRate: 3.7,
    swingStart: 6, swingCd: 1, swingP: 1, react: 0.3, take: 0.6, sight: 0.6, backOut: 0.3, defend: 0.25, match: 0.97, rbRange: 60, rbAhead: 0.28, rbBehind: 0.24, aiBoost: 0.13, strag: 0.08, mistakeEvery: 0, weapon: [0.45, 0.78],
  },
  hard: {
    id: 'hard', label: 'Hard', pace: 0.955, paceSpread: 0.015, corner: 1.05, brake: 1.03, clearK: 0.9, clearM: 10, pullK: 0.9, laneCost: 0.6, wobble: 0.4, laneRate: 3.8,
    swingStart: 3, swingCd: 0.5, swingP: 1.7, react: 0.05, take: 1, sight: 1, backOut: 0.12, defend: 0.8, match: 0.95, rbRange: 60, rbAhead: 0.2, rbBehind: 0.28, aiBoost: 0.16, strag: 0.1, mistakeEvery: 0, weapon: [0.2, 0.55],
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
