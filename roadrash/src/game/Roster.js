// Grid roster: who rides which slot, and the deterministic per-slot AI personalities.
// Pure logic, no DOM. Slot rule shared with the network layer: host = slot 0, first guest = slot 14,
// second guest = 13, and so on downwards; AI fill the remaining slots.
// Grid position (where a bike lines up on the start grid, 0 = pole) is a separate thing from the slot: see computeGrid.
import { difficultyParams } from './Difficulty.js';
import { SPEED_SCALE } from '../physics/BikePhysics.js';

/** Total bikes on the road: humans plus AI rivals always add up to this. */
export const GRID_SIZE = 15;

/**
 * How many AI rivals to run for a given number of human players (the local player included).
 * @param {number} humans humans in the lobby, at least 1
 * @param {number} [total] grid size
 * @returns {number} 0..total-1
 */
export function aiCount(humans, total = GRID_SIZE) {
  const h = Math.max(1, Math.floor(humans) || 1);
  return Math.max(0, total - Math.min(h, total));
}

/**
 * The slots humans occupy, in joining order: 0, 14, 13, 12, ...
 * @param {number} n number of humans (1..15)
 * @returns {number[]} slots
 */
export function humanSlotOrder(n) {
  const k = Math.max(1, Math.min(GRID_SIZE, Math.floor(n) || 1));
  const out = [0];
  for (let i = 1; i < k; i++) out.push(GRID_SIZE - i);
  return out;
}

/**
 * Join order of humans: the host (slot 0) first, then 14, 13, ...
 * @param {number[]} slots human slots in any order
 * @returns {number[]} sorted into join order
 */
export function joinOrder(slots) {
  const key = (s) => (s === 0 ? -100 : -s);
  return slots.slice().sort((a, b) => key(a) - key(b));
}

/**
 * Where every slot lines up on the start grid. Deterministic from the roster alone, so every device derives the same grid.
 * Without `order`: AI riders fill the front positions (ascending slot), humans take the last ones in join order, the
 * first to join (the host) furthest back (position 14), the next one 13, and so on.
 * With `order` (championship races 2+): the explicit grid, slot ids front to back.
 * @param {{humanSlots?:number[], order?:number[]|null}} opts
 * @returns {number[]} gridPos indexed by slot (a permutation of 0..14)
 */
export function computeGrid(opts = {}) {
  const out = new Array(GRID_SIZE).fill(0);
  const order = opts.order;
  if (Array.isArray(order) && order.length === GRID_SIZE && new Set(order).size === GRID_SIZE) {
    order.forEach((slot, pos) => { out[slot] = pos; });
    return out;
  }
  const humans = joinOrder((opts.humanSlots && opts.humanSlots.length ? opts.humanSlots : [0]).filter((s) => s >= 0 && s < GRID_SIZE));
  const isHuman = new Set(humans);
  let pos = 0;
  for (let slot = 0; slot < GRID_SIZE; slot++) if (!isHuman.has(slot)) out[slot] = pos++;
  humans.forEach((slot, k) => { out[slot] = GRID_SIZE - 1 - k; });
  return out;
}

/** Fixed biker nicknames of the AI riders, by slot (slot 0 is only ever an AI when the host's bike is taken over). */
export const AI_NAMES = [
  'Rookie', 'Chrome Jackal', 'Sixgun Sally', 'Rattler', 'Hellcat Hank', 'Gravel Gus', 'Nitro Nell', 'Saint Skid',
  'Boneyard Bob', 'Switchblade', 'Moonshine', 'Tin Man Tom', 'Lady Lightning', 'Crowbar', 'Dirty Dozen',
];

/**
 * Legacy flat start grid (two columns, rows 7 m apart, heading -Z). The race uses track.startGrid instead.
 * @param {number} i slot index
 * @param {number} [z0] z of the front row
 * @returns {{x:number,y:number,z:number}}
 */
export function gridSlot(i, z0 = 0) {
  return { x: (i % 2 ? 1.8 : -1.8), y: 0, z: z0 + Math.floor(i / 2) * 7 };
}

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three bike types, in menu order. 'chopper' is the Cruiser. */
export const BIKE_TYPES = ['sport', 'street', 'chopper'];
/** The type a player has before choosing one. */
export const DEFAULT_BIKE = 'street';

/** Menu texts and the short tag of each type (the stat bars come from BikePhysics.statCard). */
export const BIKE_INFO = {
  sport: { id: 'sport', name: 'Sport', tag: 'SP', blurb: 'Fastest on the straights and in fast bends. Light and twitchy: slow off the line, and it takes the biggest kick when hit.' },
  street: { id: 'street', name: 'Street', tag: 'ST', blurb: 'The all-rounder: best acceleration and grip, quickest to change direction. Middling top speed, average toughness.' },
  chopper: { id: 'chopper', name: 'Cruiser', tag: 'CR', blurb: 'Heavy and tough: shrugs off blows and shoves lighter bikes aside. Slow to lean, but strong mid-range torque.' },
};

/**
 * Clamp anything to a valid bike type id.
 * @param {*} id candidate
 * @returns {'sport'|'street'|'chopper'}
 */
export function normalizeBike(id) { return BIKE_TYPES.includes(id) ? id : DEFAULT_BIKE; }

/**
 * Who rides what: every slot's bike type. Humans ride the type they chose; the AI riders are spread evenly over the three types,
 * in slot order, so 14 AI make 5/5/4 and the short type rotates with `seed` (use the championship seed for a championship, so an
 * AI rider keeps its bike for all races). Deterministic: every device derives the same field from the roster.
 * @param {{humanBikes?:Object<number,string>, seed?:number, total?:number}} [opts] humanBikes: slot -> type of the human riders
 * @returns {string[]} type per slot
 */
export function assignBikes(opts = {}) {
  const total = opts.total || GRID_SIZE;
  const hb = opts.humanBikes || {};
  const rot = (((opts.seed | 0) % 3) + 3) % 3;
  const out = new Array(total);
  let k = 0;
  for (let slot = 0; slot < total; slot++) {
    if (Object.prototype.hasOwnProperty.call(hb, slot)) out[slot] = normalizeBike(hb[slot]);
    else out[slot] = BIKE_TYPES[(k++ + rot) % 3];
  }
  return out;
}

const WEAPON_IDS = ['punch', 'kick'];

/** Scale on the rivals' straight-line pace (m/s): SPEED_SCALE, like the bikes' top speeds and the traffic (they ride at most 95 % of their top speed, so a rival holds the same share of its top speed as before and passes the traffic at the same relative speed). */
const CRUISE_SCALE = SPEED_SCALE;

/**
 * A rival's personality: deterministic from the slot only.
 * @param {number} slot grid slot 0..14
 * @param {string} [difficulty] level id; only the weapon mix depends on it (harder = more kickers)
 * @returns {{slot:number, specId:string, cruise:number, pace01:number, aggression:number, weapon:string, laneD:number, cornerG:number, brakeG:number, wobble:number}}
 *   cruise: legacy m/s the rider held on a clear straight (the brain now paces as a share of its bike's top speed, see Difficulty.js / RivalAI.paceOf); pace01: the rider's 0..1 draw inside the level's narrow pace band; aggression 0..1; laneD: preferred lateral offset (negative = right of centre);
 *   cornerG / brakeG: share of the bike's lean-limited cornering / braking capability it uses
 */
export function personality(slot, difficulty = 'medium') {
  const r = mulberry32(slot * 7919 + 104729);
  const specId = BIKE_TYPES[Math.floor(r() * BIKE_TYPES.length)]; // legacy default only: the race assigns bikes with assignBikes
  const pace01 = r();
  const cruise = (37 + 12 * pace01) * CRUISE_SCALE; // the same on every bike type: the pace is the rider's, the bike's strengths are in the physics
  const aggression = 0.15 + 0.8 * r();
  const w = r();
  const cut = difficultyParams(difficulty).weapon;
  const weapon = w < cut[1] ? WEAPON_IDS[0] : WEAPON_IDS[1]; // most rivals punch; the share of kickers grows with the level
  return {
    slot, specId, cruise, pace01, aggression, weapon,
    laneD: -0.9 - 2.5 * r(),
    cornerG: 0.6 + 0.2 * r(),
    brakeG: 0.4 + 0.12 * r(),
    wobble: 0.1 + 0.3 * r(),
  };
}

/**
 * Bike spec id an AI uses in a slot when no field was assigned (see assignBikes for the real assignment).
 * @param {number} slot grid slot
 * @returns {string} 'street' | 'sport' | 'chopper'
 */
export function slotSpec(slot) { return personality(slot).specId; }
