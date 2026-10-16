import {
  BOARD_SIZE,
  BUSINESS_MVP_RULES as RULES,
  buildingCount,
  computeRent,
  findCard,
  incomeTaxDue,
  normalizePosition,
  positionOfSpecial,
  positionOfSquare,
  PROPERTY_KEYS,
  spaceAt,
  wealthTaxDue,
  type GameState,
  type PlayerState,
  type PropertyKey,
} from '../engine/index.ts';
import { DICE_DISTRIBUTION, EXPECTED_ROLL, sampleRoll } from './dice.ts';
import { mixSeed, prng } from './random.ts';

/**
 * Where tokens go. Everything here is read from the engine's own board and card data: the square a roll
 * reaches, the card that dice total draws there (cards are chosen by the dice total, so a roll's whole
 * effect is known in advance), Jail, the Rest House and card moves. Nothing is a second copy of the rules:
 * resolveRoll mirrors the engine's landing only to PREDICT it, and the rent of a landing is always the
 * engine's computeRent.
 */

/** What one roll from one square does to the roller, as far as movement and money owed go. */
export interface RollOutcome {
  /** Final square after any card move. */
  to: number;
  /** Properties whose landing is resolved (rent or a purchase offer), in order. */
  landed: PropertyKey[];
  jailed: boolean;
  /** Turns the roller will miss (Rest House, cards). */
  skip: number;
  passedStart: boolean;
  tax: 'INCOME' | 'WEALTH' | null;
  club: boolean;
  /** A card's charges (to the bank, to each other player, per building). */
  cardPay: number;
  cardPayEach: number;
  cardPerHouse: number;
  cardPerHotel: number;
  /** Money the roll brings in from the bank or the other players (Start, cards). Never assumed for risk. */
  cardReceive: number;
  cardCollectEach: number;
}

function blank(to: number): RollOutcome {
  return { to, landed: [], jailed: false, skip: 0, passedStart: false, tax: null, club: false, cardPay: 0, cardPayEach: 0, cardPerHouse: 0, cardPerHotel: 0, cardReceive: 0, cardCollectEach: 0 };
}

const JAIL = positionOfSpecial('JAIL');
const REST_HOUSE = positionOfSpecial('REST_HOUSE');

/** Predicts the engine's resolution of rolling `total` from square `from` (reducer: rollDice → resolveLanding → resolveCard). */
export function resolveRoll(from: number, total: number): RollOutcome {
  const landing = normalizePosition(from + total);
  const out = blank(landing);
  out.passedStart = from + total >= BOARD_SIZE;
  const space = spaceAt(landing);
  if (space.kind === 'PROPERTY') {
    out.landed.push(space.propertyKey);
    return out;
  }
  switch (space.type) {
    case 'INCOME_TAX':
      out.tax = 'INCOME';
      return out;
    case 'WEALTH_TAX':
      out.tax = 'WEALTH';
      return out;
    case 'CLUB':
      out.club = true;
      return out;
    case 'JAIL':
      out.jailed = true;
      return out;
    case 'REST_HOUSE':
      out.skip += RULES.restHouse.turnsSkippedOnLanding;
      return out;
    case 'START':
      return out;
    case 'CHANCE':
    case 'COMMUNITY_CHEST': {
      const card = findCard(space.type, total);
      let pos = landing;
      for (const effect of card.effects) {
        switch (effect.type) {
          case 'PAY_BANK':
            out.cardPay += effect.amount;
            break;
          case 'PAY_EACH_PLAYER':
            out.cardPayEach += effect.amount;
            break;
          case 'PAY_PER_BUILDING':
            out.cardPerHouse += effect.perHouse;
            out.cardPerHotel += effect.perHotel;
            break;
          case 'RECEIVE_FROM_BANK':
            out.cardReceive += effect.amount;
            break;
          case 'COLLECT_FROM_EACH_PLAYER':
            out.cardCollectEach += effect.amount;
            break;
          case 'GO_TO_JAIL':
            pos = JAIL;
            out.jailed = true;
            break;
          case 'GO_TO_REST_HOUSE':
            pos = REST_HOUSE;
            break;
          case 'SKIP_TURNS':
            out.skip += effect.count;
            break;
          case 'MOVE_TO':
          case 'MOVE_STEPS': {
            const forward = effect.type === 'MOVE_TO' ? effect.direction === 'FORWARD' : effect.steps >= 0;
            const target = effect.type === 'MOVE_TO' ? positionOfSquare(effect.target) : normalizePosition(pos + effect.steps);
            const steps = forward ? normalizePosition(target - pos) : normalizePosition(pos - target);
            if (forward && steps > 0 && pos + steps >= BOARD_SIZE) out.passedStart = true;
            pos = target;
            if (effect.resolveLanding) {
              const dest = spaceAt(pos);
              if (dest.kind === 'PROPERTY') out.landed.push(dest.propertyKey);
            }
            break;
          }
        }
      }
      out.to = pos;
      return out;
    }
  }
}

/** ROLL_TABLE[square][total]: every roll's outcome, worked out once. */
const ROLL_TABLE: readonly (readonly (RollOutcome | null)[])[] = Array.from({ length: BOARD_SIZE }, (_, from) => {
  const row: (RollOutcome | null)[] = [];
  for (const o of DICE_DISTRIBUTION) row[o.total] = resolveRoll(from, o.total);
  return row;
});

export function rollOutcome(from: number, total: number): RollOutcome {
  return ROLL_TABLE[normalizePosition(from)]?.[total] ?? resolveRoll(from, total);
}

// ---------------------------------------------------------------------------
// Expected landings
// ---------------------------------------------------------------------------

/**
 * For each player: the expected number of times they land on each property within the planning horizon,
 * each landing weighted by how far away it is (discount^turn), and the same weighting of the dice total at
 * those landings (rent of a dice-multiplier property depends on it).
 */
export interface LandingModel {
  turns: number;
  landings: Record<string, Partial<Record<PropertyKey, number>>>;
  diceSums: Record<string, Partial<Record<PropertyKey, number>>>;
}

export interface LandingOptions {
  /** Weight of a landing on each future turn (index 0 = the next turn): discounting and early ending (horizon.ts). */
  weights: readonly number[];
  model: 'one-roll' | 'monte-carlo';
  simulations: number;
  seed: number;
}

/** Chance a jailed player stays rather than pays to leave, as the bots assume of everyone. UNVALIDATED. */
const ASSUMED_JAIL_STAY = 0.5;

type Mover = Pick<PlayerState, 'id' | 'position' | 'inJail' | 'jailTurnsLeft' | 'skipTurns'>;

const cache = new Map<string, LandingModel>();
const CACHE_LIMIT = 64;

/**
 * Cached on everything that changes the answer: who is where (with Jail and skipped turns), the horizon,
 * the discount, the model and its sample count, and the seed. Nothing else the game does moves a token.
 */
export function landingModel(movers: readonly Mover[], options: LandingOptions): LandingModel {
  const key = [
    options.model,
    options.simulations,
    options.weights.map((w) => w.toFixed(4)).join(','),
    options.seed,
    ...movers.map((m) => `${m.id}:${m.position}:${m.jailTurnsLeft}:${m.skipTurns}`),
  ].join('|');
  const hit = cache.get(key);
  if (hit) return hit;
  const model: LandingModel = { turns: options.weights.length, landings: {}, diceSums: {} };
  for (const m of movers) {
    const r = options.model === 'one-roll' ? oneRollLandings(m, options) : simulatedLandings(m, options);
    model.landings[m.id] = r.landings;
    model.diceSums[m.id] = r.diceSums;
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, model);
  return model;
}

/** For tests: drop every cached model. */
export function clearLandingCache(): void {
  cache.clear();
}

type Tally = { landings: Partial<Record<PropertyKey, number>>; diceSums: Partial<Record<PropertyKey, number>> };

function add(t: Tally, key: PropertyKey, weight: number, total: number): void {
  t.landings[key] = (t.landings[key] ?? 0) + weight;
  t.diceSums[key] = (t.diceSums[key] ?? 0) + weight * total;
}

/**
 * Easy: the next roll exactly (its 11 totals and their probabilities, cards included), and every later turn
 * as one landing spread evenly over the board's squares at an average roll. A Jailed or resting player is
 * assumed not to move on the next turn.
 */
function oneRollLandings(m: Mover, o: LandingOptions): Tally {
  const t: Tally = { landings: {}, diceSums: {} };
  const first = o.weights[0] ?? 0;
  if (first <= 0) return t;
  if (!m.inJail && m.skipTurns === 0) {
    for (const d of DICE_DISTRIBUTION) {
      for (const key of rollOutcome(m.position, d.total).landed) add(t, key, first * d.probability, d.total);
    }
  }
  const later = o.weights.slice(1).reduce((s, w) => s + w, 0);
  if (later > 0) for (const key of PROPERTY_KEYS) add(t, key, later / BOARD_SIZE, EXPECTED_ROLL);
  return t;
}

/** Normal/Hard: `simulations` seeded futures of this player's own movement under the real board and cards. */
function simulatedLandings(m: Mover, o: LandingOptions): Tally {
  const t: Tally = { landings: {}, diceSums: {} };
  const n = Math.max(1, o.simulations);
  const random = prng(mixSeed(o.seed, 'landings', m.id, m.position, m.jailTurnsLeft, m.skipTurns));
  const w = 1 / n;
  for (let s = 0; s < n; s += 1) {
    let pos = m.position;
    let jail = m.jailTurnsLeft;
    let skip = m.skipTurns;
    for (let turn = 0; turn < o.weights.length; turn += 1) {
      const weight = w * (o.weights[turn] ?? 0);
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      if (jail > 0) {
        if (random() < ASSUMED_JAIL_STAY) {
          jail -= 1;
          continue;
        }
        jail = 0;
      }
      const total = sampleRoll(random);
      const out = rollOutcome(pos, total);
      for (const key of out.landed) add(t, key, weight, total);
      pos = out.to;
      if (out.jailed) jail = RULES.jail.maxTurns;
      skip += out.skip;
    }
  }
  return t;
}

/** Expected rent `ownerId` collects over the horizon on `key` as owned in `state`: the engine's rent for each landing. */
export function expectedRentFor(state: Pick<GameState, 'properties'>, key: PropertyKey, payers: readonly string[], model: LandingModel): number {
  let rent = 0;
  for (const id of payers) {
    const landings = model.landings[id]?.[key] ?? 0;
    if (landings <= 0) continue;
    const diceSum = model.diceSums[id]?.[key] ?? landings * EXPECTED_ROLL;
    // Rent is linear in the dice total for a dice-multiplier property and independent of it otherwise:
    // rent(1) × Σ totals equals Σ rent(total) exactly in both cases, once the fixed case is detected.
    const atOne = computeRent(state, key, 1);
    const atTwo = computeRent(state, key, 2);
    rent += atTwo === atOne ? atOne * landings : atOne * diceSum;
  }
  return rent;
}

// ---------------------------------------------------------------------------
// Near-term outflows (the reserve buffer)
// ---------------------------------------------------------------------------

/** What a roll outcome costs `player` right now: rent to others, taxes, Club and card charges. The engine's own amounts. */
export function outcomeOutflow(state: GameState, playerId: string, out: RollOutcome, total: number): number {
  const others = state.players.filter((p) => p.status === 'ACTIVE' && p.id !== playerId).length;
  let cost = 0;
  for (const key of out.landed) {
    const owner = state.properties[key]?.ownerId;
    if (owner && owner !== playerId) cost += computeRent(state, key, total);
  }
  if (out.tax === 'INCOME') cost += incomeTaxDue(state, playerId).amount;
  if (out.tax === 'WEALTH') cost += wealthTaxDue(state, playerId).amount;
  if (out.club) cost += RULES.club.payEachPlayer * others;
  cost += out.cardPay + out.cardPayEach * others;
  if (out.cardPerHouse || out.cardPerHotel) {
    const b = buildingCount(state, playerId);
    cost += b.houses * out.cardPerHouse + b.hotels * out.cardPerHotel;
  }
  return cost;
}

/** The exact distribution of what the next roll costs this player. */
export function nextRollOutflows(state: GameState, player: Mover): { amount: number; probability: number }[] {
  if (player.inJail || player.skipTurns > 0) return [{ amount: 0, probability: 1 }];
  return DICE_DISTRIBUTION.map((d) => ({ amount: outcomeOutflow(state, player.id, rollOutcome(player.position, d.total), d.total), probability: d.probability }));
}

/**
 * The `percentile` of what this player's next `turns` turns could cost, from seeded simulations of the real
 * board (ownership and buildings as they stand now).
 */
export function outflowPercentile(state: GameState, player: Mover, turns: number, simulations: number, percentile: number, seed: number): number {
  const n = Math.max(32, simulations);
  const random = prng(mixSeed(seed, 'outflow', player.id, player.position));
  const samples: number[] = [];
  for (let s = 0; s < n; s += 1) {
    let pos = player.position;
    let jail = player.jailTurnsLeft;
    let skip = player.skipTurns;
    let cost = 0;
    for (let turn = 0; turn < turns; turn += 1) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      if (jail > 0) {
        jail -= 1;
        continue;
      }
      const total = sampleRoll(random);
      const out = rollOutcome(pos, total);
      cost += outcomeOutflow(state, player.id, out, total);
      pos = out.to;
      if (out.jailed) jail = RULES.jail.maxTurns;
      skip += out.skip;
    }
    samples.push(cost);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.min(samples.length - 1, Math.floor(percentile * samples.length))] ?? 0;
}
