import {
  balanceSheet,
  BOARD_SIZE,
  classicLoanStanding,
  configOf,
  crisisCheckpointClock,
  developmentRent,
  economyOf,
  gameClock,
  getDeed,
  incomeTaxDue,
  INTERMEDIATE_RULES as IR,
  isEnforceableLoan,
  isPledged,
  loansOf,
  mandatoryPaymentsOwed,
  objectiveView,
  outstandingDebt,
  ownedBy,
  policyCovers,
  PROPERTY_KEYS,
  unpaidInstallments,
  wealthTaxDue,
  yearLength,
  type GameState,
  type PlayerState,
  type PropertyKey,
} from '../engine/index.ts';
import { BOT_POLICY, DIFFICULTY_TUNING, PERSONALITY_TUNING, personalityMultipliers, type DifficultyTuning, type PersonalityTuning } from './config.ts';
import { EXPECTED_ROLL } from './dice.ts';
import { gameHorizon, type Horizon } from './horizon.ts';
import { expectedRentFor, landingModel, nextRollOutflows, outflowPercentile, type LandingModel } from './movement.ts';
import { fixedJitter, mixSeed } from './random.ts';
import { DIMENSIONS, zeroComponents, type BotDecisionContext, type BotObservation, type BotProfile, type Components, type Dimension } from './types.ts';

/**
 * The shared valuation model. Every decision — buying, bidding, building, trading, borrowing, insuring,
 * raising money, voting — is scored the same way: the value of the position the action leads to, minus
 * the value of the position now. The position after an action is produced by the ENGINE (a dry run of the
 * action, engineAccess.ts), so every price, rent, fee and rule in the comparison is the game's own.
 *
 * The value of a position (assess), in rupees of expected value, split into the seven dimensions so a
 * personality can weigh them (each part counted once; the parts add up to the whole):
 *
 *   wealth      cash − liabilities + terminal value of property and buildings + standalone rent over the
 *               horizon − rent expected to be paid to others − future loan interest − taxes − expected
 *               crisis bills (Capital)
 *   group       the extra rent the owner's sets earn (colour multiplier, paired transport) — the part of
 *               income that exists only because properties are held together
 *   market      expected market drift of owned property to the end of the plan (Capital only; the
 *               market's real average change, not the projection label) + bargains (action level)
 *   liquidity   −penalty for cash below the reserve target R = R_base + O_known + B_risk
 *   risk        −debt aversion on loan principal, −downside of uninsured crisis bills, −payments in arrears
 *   objectives  secret-objective bonus × the chance of completing it (Capital, own objective only)
 *   negotiation (action level only: the part of a deal's gain attributed to negotiating it)
 *
 * Terminal value is NOT discounted: the standings count property and buildings at full value when the game
 * ends, exactly as they count cash. Income is discounted per turn (and for a possible early end).
 */
export interface ValuationContext {
  obs: BotObservation;
  profile: BotProfile;
  tuning: DifficultyTuning;
  personality: PersonalityTuning;
  multipliers: Record<Dimension, number>;
  horizon: Horizon;
  landing: LandingModel;
  seed: number;
  /** Reserve pieces held fixed for every candidate of one decision (they describe the board, not the action). */
  reserveBase: number;
  /** B_risk: the near-term outflow buffer for the bot itself. */
  riskBuffer: number;
  terminalWeight: number;
  /** Mean annual market change of the game's volatility profile (Capital), as a fraction. */
  marketDrift: number;
}

export function buildValuationContext(obs: BotObservation, ctx: BotDecisionContext): ValuationContext {
  const tuning = DIFFICULTY_TUNING[ctx.profile.difficulty];
  const horizon = gameHorizon(obs.state, tuning);
  const active = obs.state.players.filter((p) => p.status === 'ACTIVE');
  // Seeded by seat and turn, not by state version: within one turn the same board always gives the same
  // model, so a sequence of management actions is judged on one consistent picture (no churn).
  const seed = mixSeed(ctx.seed, obs.state.turn.number);
  const landing = landingModel(active, {
    weights: horizon.turnWeights.length ? horizon.turnWeights : [0],
    model: tuning.movement,
    simulations: tuning.simulations,
    seed,
  });
  const startingCash = configOf(obs.state).startingCash;
  const reserveBase = Math.max(BOT_POLICY.reserve.baseMinimum, BOT_POLICY.reserve.baseShareOfStartingCash * startingCash);
  const riskBuffer = nearTermBuffer(obs.state, obs.me, tuning, seed, PERSONALITY_TUNING[ctx.profile.personality].reservePercentile);
  return {
    obs,
    profile: ctx.profile,
    tuning,
    personality: PERSONALITY_TUNING[ctx.profile.personality],
    multipliers: personalityMultipliers(ctx.profile.personality),
    horizon,
    landing,
    seed: ctx.seed,
    reserveBase,
    riskBuffer,
    terminalWeight: horizon.hosted ? BOT_POLICY.value.terminalWeightHosted : BOT_POLICY.value.terminalWeightMatchmade,
    marketDrift: marketMeanChange(obs.state),
  };
}

/**
 * B_risk: what the next few turns could plausibly cost beyond what is already owed. Normal/Hard: a high (75th by default)
 * percentile of seeded simulations of the bot's own next turns on the real board. Easy: the documented
 * fallback — a multiple of the exact expected cost of the next roll, with a floor.
 */
export function nearTermBuffer(state: GameState, me: PlayerState, tuning: DifficultyTuning, seed: number, percentile = 0.75): number {
  const r = BOT_POLICY.reserve;
  if (!tuning.riskPercentile) {
    const expected = nextRollOutflows(state, me).reduce((s, o) => s + o.amount * o.probability, 0);
    return Math.max(r.fallbackFloor, r.fallbackMultiple * expected * (percentile / 0.75));
  }
  return outflowPercentile(state, me, r.nearTermTurns, Math.max(256, tuning.simulations), percentile, seed);
}

/** The expected yearly change of a property's market value under the game's volatility profile (0 in Classic). */
function marketMeanChange(state: GameState): number {
  if (!economyOf(state)) return 0;
  const profile = IR.market.profiles[configOf(state).marketVolatility];
  const total = profile.reduce((s, c) => s + c.weight, 0);
  return profile.reduce((s, c) => s + (c.percent / 100) * c.weight, 0) / Math.max(1, total);
}

/**
 * O_known: money that must leave before more reliably comes in — the payment the turn waits on and any
 * crisis bill (mandatoryPaymentsOwed), loan principal that has fallen due, Classic interest due at the
 * coming Start, and Capital installments due now or within the next quarter year. Each obligation once.
 */
export function knownOutflows(state: GameState, playerId: string): number {
  let owed = mandatoryPaymentsOwed(state, playerId);
  const player = state.players.find((p) => p.id === playerId);
  const eco = economyOf(state);
  if (eco) {
    const soon = gameClock(eco) + yearLength(eco) / 4;
    for (const loan of loansOf(eco, playerId)) {
      if (loan.status !== 'ACTIVE') continue;
      for (const i of unpaidInstallments(loan)) owed += i.principal + i.interest;
      const next = loan.installments.find((i) => i.status === 'SCHEDULED');
      if (next && next.dueAt <= soon) owed += next.principal + next.interest;
    }
  } else if (player) {
    const pending = state.turn.playerId === playerId && state.turn.pending?.kind === 'PAYMENT' && state.turn.pending.reason === 'LOAN_INTEREST';
    for (const loan of state.loans) {
      if (loan.playerId !== playerId || !isEnforceableLoan(loan)) continue;
      const standing = classicLoanStanding(loan, player.circuits);
      if (standing === 'DUE' || standing === 'OVERDUE') owed += loan.outstanding;
      // Interest is charged at the next Start; close to Start it is about to be owed (and not yet the pending payment).
      if (!pending && loan.status === 'ACTIVE' && loan.interestCharges === 0 && player.position >= BOARD_SIZE - 2 * EXPECTED_ROLL) owed += loan.interestAmount;
    }
  }
  return owed;
}

/** Rent a property would earn on its own: its development rent with no colour multiplier, a transport/utility unpaired. */
function standaloneRentAt(state: GameState, key: PropertyKey, diceTotal: number): number {
  const prop = state.properties[key];
  if (!prop || prop.ownerId === null || prop.mortgaged) return 0;
  const deed = getDeed(key);
  if (deed.kind === 'CITY') return developmentRent(prop);
  return deed.rent.type === 'FIXED' ? deed.rent.base : deed.rent.multiplier * diceTotal;
}

function standaloneIncome(state: GameState, key: PropertyKey, payers: readonly string[], model: LandingModel): number {
  let rent = 0;
  for (const id of payers) {
    const landings = model.landings[id]?.[key] ?? 0;
    if (landings <= 0) continue;
    const diceSum = model.diceSums[id]?.[key] ?? landings * EXPECTED_ROLL;
    const atOne = standaloneRentAt(state, key, 1);
    rent += standaloneRentAt(state, key, 2) === atOne ? atOne * landings : atOne * diceSum;
  }
  return rent;
}

/** Interest a player's loans will still charge (Classic: interest due at the next Start; Capital: scheduled interest within the plan). */
function futureInterest(vc: ValuationContext, state: GameState, playerId: string): number {
  const eco = economyOf(state);
  if (!eco) {
    return state.loans.filter((l) => l.playerId === playerId && l.status === 'ACTIVE' && l.interestCharges === 0).reduce((s, l) => s + l.interestAmount, 0);
  }
  const until = gameClock(eco) + vc.horizon.planningYears * yearLength(eco);
  let interest = 0;
  for (const loan of loansOf(eco, playerId)) {
    if (loan.status !== 'ACTIVE') continue;
    for (const i of loan.installments) if (i.status === 'SCHEDULED' && i.dueAt <= until) interest += i.interest;
  }
  return interest;
}

/**
 * Crisis bills a player can expect on their uninsured property over the plan (Capital with insurance): one
 * crisis per scheduled checkpoint, striking one owned property of an active player at random (the engine's
 * own rule), so each of theirs is hit with chance 1 / (properties owned at the table). A property covered by
 * one of THEIR policies at that checkpoint costs nothing. Only the bot's own policies are visible to it, so
 * for anyone else every property counts as uninsured.
 */
function expectedCrisisBills(vc: ValuationContext, state: GameState, playerId: string): number {
  const eco = economyOf(state);
  const ins = eco?.insurance;
  if (!eco || !ins) return 0;
  const mine = ownedBy(state, playerId);
  if (mine.length === 0) return 0;
  const activeIds = new Set(state.players.filter((p) => p.status === 'ACTIVE').map((p) => p.id));
  const tableOwned = PROPERTY_KEYS.filter((k) => {
    const owner = state.properties[k]?.ownerId;
    return owner !== null && owner !== undefined && activeIds.has(owner);
  }).length;
  if (tableOwned === 0) return 0;
  // Early on most of the board is still for sale and will be bought before most crises strike: the share of
  // a crisis a property carries is judged against the ownership the table is heading for. But that takes
  // time, and a crisis soon strikes among the few properties owned by then: the projected ownership closes
  // half of the remaining gap by each checkpoint (UNVALIDATED). Judging the NEXT checkpoint against the
  // final ownership made an early-game policy look worthless when it is the best value insurance has.
  const unowned = PROPERTY_KEYS.filter((k) => state.properties[k]?.ownerId === null).length;
  const target = Math.max(tableOwned, (tableOwned + unowned) * BOT_POLICY.value.crisisOwnershipTarget);
  const clock = gameClock(eco);
  const until = clock + vc.horizon.planningYears * yearLength(eco);
  let total = 0;
  for (let k = 0; k < 12; k += 1) {
    const n = ins.nextCheckpoint + k;
    const at = crisisCheckpointClock(eco, n);
    if (at > until) break;
    const sharedBy = Math.max(1, target - (target - tableOwned) * 0.5 ** (k + 1));
    const exposed = mine.filter((key) => !ins.policies.some((p) => p.ownerId === playerId && policyCovers(state, p, key, at))).length;
    total += (IR.insurance.crisisBill * exposed) / sharedBy;
  }
  return total;
}

/** Secret objective: its bonus times the chance of completing it, judged from the owner's own progress. 0 without one. */
function objectiveValue(state: GameState, playerId: string): number {
  const view = objectiveView(state, playerId);
  if (!view) return 0;
  const reward = view.terms.reward;
  if (view.check.completed) return reward * 0.85;
  const owned = ownedBy(state, playerId);
  const player = state.players.find((p) => p.id === playerId);
  const target = view.terms.cashTarget ?? 1;
  let progress = 0;
  switch (view.definition.id) {
    case 'PROPERTY_MOGUL': {
      const value = owned.reduce((s, k) => s + getDeed(k).price, 0);
      progress = Math.min(1, owned.length / 3) * Math.min(1, value / target);
      break;
    }
    case 'BUILDER':
      progress = Math.min(1, owned.reduce((s, k) => s + (state.properties[k]?.hotel ? 0 : (state.properties[k]?.houses ?? 0)), 0) / 3);
      break;
    case 'CASH_GUARDIAN':
      progress = Math.min(1, (player?.balance ?? 0) / target) ** 2;
      break;
    case 'DEAL_MAKER':
      progress = Math.min(1, (state.objectives?.trades.filter((t) => t.playerIds.includes(playerId)).length ?? 0) / 2);
      break;
  }
  return reward * 0.8 * progress;
}

/** Liquidity penalty for being `shortfall` below a reserve target of `target`: grows faster the deeper the shortfall. */
export function shortfallPenalty(shortfall: number, target: number): number {
  if (shortfall <= 0) return 0;
  const r = BOT_POLICY.reserve;
  return shortfall * (r.shortfallLinear + (r.shortfallQuadratic * shortfall) / Math.max(1, target));
}

/** The reserve target R for a player in a state: R_base + O_known(state) + B_risk. */
export function reserveTarget(vc: ValuationContext, state: GameState, playerId: string, buffer = vc.riskBuffer): number {
  return vc.reserveBase + knownOutflows(state, playerId) + buffer;
}

/** Easy's fixed estimation error for one property (0 for Normal and Hard). */
function noise(vc: ValuationContext, key: PropertyKey): number {
  return vc.tuning.valuationNoise ? 1 + vc.tuning.valuationNoise * fixedJitter(vc.seed, key) : 1;
}

export interface Assessment {
  components: Components;
  /** Expected rent income over the plan (for explanations). */
  income: number;
  cash: number;
  reserve: number;
}

/**
 * The value of `playerId`'s position in `state`, by dimension. `state` is the bot's own view (or a dry-run
 * of an action on it); for anyone but the bot, cash is whatever that view says (an estimate when hidden).
 */
export function assess(vc: ValuationContext, state: GameState, playerId: string = vc.obs.botId): Assessment {
  const c = zeroComponents();
  const self = playerId === vc.obs.botId;
  const active = state.players.filter((p) => p.status === 'ACTIVE');
  const payers = active.filter((p) => p.id !== playerId).map((p) => p.id);
  const sheet = balanceSheet(state, playerId);
  const owned = ownedBy(state, playerId);

  let income = 0;
  let standalone = 0;
  for (const key of owned) {
    const n = self ? noise(vc, key) : 1;
    income += expectedRentFor(state, key, payers, vc.landing) * n;
    standalone += standaloneIncome(state, key, payers, vc.landing) * n;
  }
  let rentPaid = 0;
  for (const key of PROPERTY_KEYS) {
    const owner = state.properties[key]?.ownerId;
    if (owner && owner !== playerId && active.some((p) => p.id === owner)) rentPaid += expectedRentFor(state, key, [playerId], vc.landing);
  }
  const taxes = (vc.horizon.weightedTurns / BOARD_SIZE) * (incomeTaxDue(state, playerId).amount + wealthTaxDue(state, playerId).amount);
  const crisis = expectedCrisisBills(vc, state, playerId);
  const tw = vc.terminalWeight;

  c.wealth = sheet.cash - sheet.liabilities + tw * (sheet.propertyValue + sheet.buildingValue) + standalone - rentPaid - futureInterest(vc, state, playerId) - taxes - crisis;
  c.group = income - standalone;
  c.market = economyOf(state) ? tw * sheet.propertyValue * ((1 + vc.marketDrift) ** vc.horizon.yearsLeft - 1) : 0;

  const buffer = self ? vc.riskBuffer : Math.max(BOT_POLICY.reserve.fallbackFloor, BOT_POLICY.reserve.fallbackMultiple * expectedNextRollCost(state, playerId));
  const reserve = reserveTarget(vc, state, playerId, buffer);
  // Liquidity is cash plus part of what mortgaging could raise at once: a mortgage is the cheapest way to
  // find money (and the first the bot reaches for), so a property that could be mortgaged is a reserve too.
  // Counting cash alone made cautious bots sit on idle cash and starve their own income (docs/bots).
  c.liquidity = -shortfallPenalty(reserve - (sheet.cash + BOT_POLICY.reserve.mortgageableShare * mortgageable(state, playerId)), reserve);

  const eco = economyOf(state);
  const principal = eco ? sheet.loans : outstandingDebt(state.loans, playerId);
  let arrears = 0;
  if (eco) {
    for (const loan of loansOf(eco, playerId)) {
      if (loan.status === 'DEFAULTED') arrears += loan.defaultBalance;
      else if (loan.status === 'ACTIVE') arrears += loan.installments.filter((i) => i.status === 'OVERDUE').reduce((s, i) => s + i.principal + i.interest, 0);
    }
  }
  // A crisis bill the cash on hand could not pay is settled by selling or mortgaging (buildings fetch half
  // their cost): its downside counts double then.
  const downside = BOT_POLICY.value.crisisDownside * (sheet.cash < IR.insurance.crisisBill ? 2 : 1);
  c.risk = -(BOT_POLICY.value.leverageRisk * principal + downside * crisis + arrears);
  c.objectives = objectiveValue(state, playerId);
  return { components: c, income, cash: sheet.cash, reserve };
}

/** Cash mortgaging could raise right now: every owned, unmortgaged, unbuilt property that is not pledged to a loan. */
export function mortgageable(state: GameState, playerId: string): number {
  let total = 0;
  for (const key of ownedBy(state, playerId)) {
    const prop = state.properties[key];
    if (!prop || prop.mortgaged || prop.houses > 0 || prop.hotel || isPledged(state, key)) continue;
    total += getDeed(key).mortgageValue;
  }
  return total;
}

function expectedNextRollCost(state: GameState, playerId: string): number {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 0;
  return nextRollOutflows(state, player).reduce((s, o) => s + o.amount * o.probability, 0);
}

/** Personality-weighted total of a set of components. */
export function weigh(vc: ValuationContext, c: Components): number {
  let total = 0;
  for (const d of DIMENSIONS) total += vc.multipliers[d] * c[d];
  return total;
}

/** after − before, by dimension. */
export function delta(after: Components, before: Components): Components {
  const out = zeroComponents();
  for (const d of DIMENSIONS) out[d] = after[d] - before[d];
  return out;
}

/** Moves `amount` of a delta from one dimension to another (so a bargain or a deal's gain is counted once, where it belongs). */
export function attribute(c: Components, from: Dimension, to: Dimension, amount: number): Components {
  const out = { ...c };
  out[from] -= amount;
  out[to] += amount;
  return out;
}

/**
 * What a property is worth on the books when the plan ends (the standings' value): the deed price in
 * Classic, today's market value in Capital, plus its buildings at cost.
 */
export function bookValue(state: GameState, key: PropertyKey): number {
  const eco = economyOf(state);
  return eco?.market[key]?.value ?? getDeed(key).price;
}
