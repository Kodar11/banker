import type { GameAction } from './actions.ts';
import { getDeed, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { INTERMEDIATE_RULES as IR } from './intermediateConfig.ts';
import { pickFrom } from './intermediateFinance.ts';
import { loanOffers } from './intermediateSelectors.ts';
import { economyOf, gameClock, insuranceOf, pendingCrises, yearAt, type IntermediateState } from './intermediateState.ts';
import type { CrisisRecord, InsurancePolicy, InsuranceState } from './insuranceState.ts';
import { ownedBy, propertyActionBlocker } from './selectors.ts';
import type { GameState, PlayerState } from './types.ts';

/**
 * Property insurance and global crises: the read-only views the screens show and the engine
 * validates against, and the state transitions. Like the rest of Intermediate Mode, every
 * transition works on the action's Draft, so the premium, the policy, the crisis record, the bill
 * and the events of one action commit together or not at all.
 *
 * A Classic game — and an Intermediate game that started before insurance existed — has no
 * insurance state, and nothing in this file does anything for it.
 */

const INS = IR.insurance;

type Clocked = Pick<IntermediateState, 'playerCount'>;
type InsuranceView = Pick<GameState, 'properties' | 'players' | 'status' | 'mode' | 'intermediate'>;

// ---------------------------------------------------------------------------
// Prices and the schedule
// ---------------------------------------------------------------------------

/** The premium for one property bought in `year`: ₹500 in Year 1, +₹100 a year, never above ₹900. */
export function premiumForYear(year: number): number {
  return Math.min(INS.premiumMax, INS.premiumYear1 + Math.max(0, year - 1) * INS.premiumStepPerYear);
}

/** Game-clock length of a policy: every starting player moving 36 spaces on average. */
export function coverageLength(eco: Clocked): number {
  return Math.max(1, eco.playerCount) * INS.coverageSpaces;
}

/** Game clock of crisis checkpoint `n` (1-based): 18 spaces of average movement, then every 36. */
export function crisisCheckpointClock(eco: Clocked, checkpoint: number): number {
  return Math.max(1, eco.playerCount) * (INS.firstCrisisSpaces + (checkpoint - 1) * INS.crisisIntervalSpaces);
}

/** A game-clock point as average spaces moved per player — the counter players read (one decimal at most). */
export function averageSpaces(eco: Clocked, clock: number): number {
  return Math.round((clock * 10) / Math.max(1, eco.playerCount)) / 10;
}

/** The clock point of the next crisis, or null when this game has no insurance. */
export function nextCrisisClock(eco: IntermediateState): number | null {
  return eco.insurance ? crisisCheckpointClock(eco, eco.insurance.nextCheckpoint) : null;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * Whether a policy covers its property at clock point `at`: unused, bought by then, not yet expired
 * (cover ends AT the expiry point), and the buyer still owns the property.
 */
export function policyInForce(state: Pick<GameState, 'properties'>, policy: InsurancePolicy, at: number): boolean {
  return policy.status === 'ACTIVE' && at >= policy.startClock && at < policy.expiryClock && state.properties[policy.propertyKey]?.ownerId === policy.ownerId;
}

/** The policy protecting a property for its current owner right now, or null. */
export function activePolicyFor(state: InsuranceView, key: PropertyKey): InsurancePolicy | null {
  const eco = economyOf(state);
  if (!eco?.insurance) return null;
  const clock = gameClock(eco);
  return eco.insurance.policies.find((p) => p.propertyKey === key && policyInForce(state, p, clock)) ?? null;
}

/**
 * How a policy stands today. IN_FORCE and NOT_OWNED are both a stored ACTIVE policy: a policy
 * does not travel with the property, so it protects nothing while its buyer does not own it.
 */
export type PolicyStanding = 'IN_FORCE' | 'NOT_OWNED' | 'CLAIMED' | 'EXPIRED';

export function policyStanding(state: InsuranceView, policy: InsurancePolicy): PolicyStanding {
  if (policy.status === 'CLAIMED') return 'CLAIMED';
  const eco = economyOf(state);
  if (policy.status === 'EXPIRED' || !eco || gameClock(eco) >= policy.expiryClock) return 'EXPIRED';
  return state.properties[policy.propertyKey]?.ownerId === policy.ownerId ? 'IN_FORCE' : 'NOT_OWNED';
}

/** Spaces of average movement a policy has left, rounded up (0 once it has ended). */
export function policySpacesLeft(eco: IntermediateState, policy: InsurancePolicy): number {
  return Math.max(0, Math.ceil((policy.expiryClock - gameClock(eco)) / Math.max(1, eco.playerCount)));
}

export interface PropertyInsurance {
  /** The policy in force for the current owner, if any. */
  active: InsurancePolicy | null;
  /** The current owner's most recent policy on this property, whatever became of it. */
  latest: InsurancePolicy | null;
  /** What a policy bought now would cost. */
  premium: number;
  year: number;
}

/** A property's insurance as the deed shows it. Null when this game has no insurance. */
export function propertyInsurance(state: InsuranceView, key: PropertyKey): PropertyInsurance | null {
  const eco = economyOf(state);
  if (!eco?.insurance) return null;
  const ownerId = state.properties[key]?.ownerId ?? null;
  const own = eco.insurance.policies.filter((p) => p.propertyKey === key && p.ownerId === ownerId);
  return { active: activePolicyFor(state, key), latest: own[own.length - 1] ?? null, premium: premiumForYear(eco.year), year: eco.year };
}

/** Why this player can't insure this property right now, or null. The engine runs it; the screens show the same answer. */
export function insureBlocker(state: InsuranceView, playerId: string, key: PropertyKey): string | null {
  const eco = economyOf(state);
  if (!eco) return 'Property insurance is only available in Intermediate Mode.';
  if (!eco.insurance) return 'This game started before property insurance existed.';
  if (state.status !== 'ACTIVE') return state.status === 'PAUSED' ? 'Game is paused.' : 'Game is not running.';
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'ACTIVE') return 'You are out of the game.';
  if (state.properties[key]?.ownerId !== playerId) return "You don't own this property.";
  const crisis = pendingCrises(state)[0];
  if (crisis) return crisis.ownerId === playerId ? 'Settle your crisis bill first.' : 'A crisis bill must be settled before play continues.';
  const active = activePolicyFor(state, key);
  if (active) return `Already insured — ${policySpacesLeft(eco, active)} spaces of cover left.`;
  const premium = premiumForYear(eco.year);
  if (player.balance < premium) return `Not enough money — the premium is ${formatINR(premium)}.`;
  return null;
}

/**
 * Buys one policy for one property. The price is the server's (this financial year's premium);
 * `expectedPremium` only proves the player confirmed that same price. Cash and policy change
 * together: a refusal leaves both untouched.
 */
export function buyInsurance(d: Draft, actor: PlayerState, key: PropertyKey, expectedPremium: number): void {
  const eco = economyOf(d.state);
  const why = insureBlocker(d.state, actor.id, key);
  if (why || !eco?.insurance) {
    const reason = why ?? 'Property insurance is not available in this game.';
    fail(reason.startsWith('Not enough') ? 'INSUFFICIENT_FUNDS' : reason.startsWith("You don't own") ? 'NOT_OWNER' : 'INSURANCE_NOT_ALLOWED', reason);
  }
  const premium = premiumForYear(eco.year);
  // The price the player confirmed must be the price they pay.
  if (premium !== expectedPremium) {
    fail('STALE_STATE', `The premium is now ${formatINR(premium)} (Year ${eco.year}). Review it and confirm again.`);
  }
  const deed = getDeed(key);
  const clock = gameClock(eco);
  d.transfer({ type: 'INSURANCE_PREMIUM', from: actor.id, to: null, amount: premium, propertyKey: key, memo: `Insurance premium (${deed.name})` });
  const policy: InsurancePolicy = {
    id: d.ctx.newId(),
    propertyKey: key,
    ownerId: actor.id,
    purchaseYear: eco.year,
    premiumPaid: premium,
    startClock: clock,
    expiryClock: clock + coverageLength(eco),
    status: 'ACTIVE',
    claimedCrisisId: null,
    createdAt: d.ctx.now,
    closedAt: null,
  };
  eco.insurance.policies.push(policy);
  forgetUndoFor(d, key);
  d.event('INSURANCE_PURCHASED', actor.id, `${actor.name} insured ${deed.name} for ${formatINR(premium)}`, {
    policyId: policy.id,
    propertyKey: key,
    premium,
    year: eco.year,
    startClock: policy.startClock,
    expiryClock: policy.expiryClock,
  });
}

/** The properties this player owns that no policy of theirs is protecting right now, in board-data order. */
export function uninsuredProperties(state: InsuranceView, playerId: string): PropertyKey[] {
  if (!insuranceOf(state)) return [];
  return ownedBy(state, playerId).filter((key) => !activePolicyFor(state, key));
}

/** Why this player can't insure all of `keys` in one step right now, or null. */
export function insureAllBlocker(state: InsuranceView, playerId: string, keys: readonly PropertyKey[]): string | null {
  const eco = economyOf(state);
  if (keys.length === 0) return 'Every property you own is already insured.';
  if (new Set(keys).size !== keys.length) return 'A property can only be insured once.';
  const player = state.players.find((p) => p.id === playerId);
  const total = keys.length * premiumForYear(eco?.year ?? 1);
  // Everything except the price is judged per property; the price is judged for the lot.
  for (const key of keys) {
    const why = insureBlocker(state, playerId, key);
    if (why && !why.startsWith('Not enough')) return keys.length > 1 && why.startsWith('Already insured') ? `${getDeed(key).name} is already insured.` : why;
  }
  if (!player || player.balance < total) return `Not enough money — insuring ${keys.length} ${keys.length === 1 ? 'property' : 'properties'} costs ${formatINR(total)}.`;
  return null;
}

/** Insures every property in `keys`, each with its own policy and its own premium entry — all of them, or nothing at all. */
export function buyInsuranceForAll(d: Draft, actor: PlayerState, keys: readonly PropertyKey[], expectedPremium: number): void {
  const why = insureAllBlocker(d.state, actor.id, keys);
  if (why) fail(why.startsWith('Not enough') ? 'INSUFFICIENT_FUNDS' : why.startsWith("You don't own") ? 'NOT_OWNER' : 'INSURANCE_NOT_ALLOWED', why);
  for (const key of keys) buyInsurance(d, actor, key, expectedPremium);
}

/** A premium or a crisis bill is never reversed, so earlier actions on that property can no longer be undone around it. */
function forgetUndoFor(d: Draft, key: PropertyKey): void {
  const touches = (r: GameState['undoStack'][number]) => r.propertyKey === key || r.propertiesAfter.some((p) => p.key === key);
  if (!d.state.undoStack.some(touches)) return;
  d.state.undoStack = d.state.undoStack.filter((r) => !touches(r));
  d.state.undoRequest = null;
}

// ---------------------------------------------------------------------------
// The crisis schedule
// ---------------------------------------------------------------------------

/**
 * Brings the crisis schedule up to date with the clock, inside the dice roll that moved it:
 * every checkpoint the clock has reached is resolved, oldest first, exactly once
 * (`nextCheckpoint` only grows); then policies whose cover has run out are closed.
 * Runs after the year and loan checkpoints, so those draw from the RNG in the order they always did.
 */
export function processCrisisCheckpoints(d: Draft, eco: IntermediateState): void {
  const ins = eco.insurance;
  if (!ins) return;
  const clock = gameClock(eco);
  while (crisisCheckpointClock(eco, ins.nextCheckpoint) <= clock) {
    const checkpoint = ins.nextCheckpoint;
    ins.nextCheckpoint += 1;
    if (!ins.crises.some((c) => c.checkpoint === checkpoint)) resolveCrisis(d, eco, ins, checkpoint);
  }
  for (const policy of ins.policies) {
    if (policy.status !== 'ACTIVE' || clock < policy.expiryClock) continue;
    policy.status = 'EXPIRED';
    policy.closedAt = d.ctx.now;
    d.event('INSURANCE_EXPIRED', policy.ownerId, `${d.name(policy.ownerId)}'s insurance on ${getDeed(policy.propertyKey).name} expired`, {
      policyId: policy.id,
      propertyKey: policy.propertyKey,
    });
  }
}

/**
 * One crisis: the server picks one property among everything the players still in the game own
 * (mortgaged or not), and its owner either has a policy in force at the checkpoint — which is
 * spent and waives the bill — or owes the bill at once. Nothing else about the property changes:
 * not its owner, its buildings or its mortgage.
 */
function resolveCrisis(d: Draft, eco: IntermediateState, ins: InsuranceState, checkpoint: number): void {
  const at = crisisCheckpointClock(eco, checkpoint);
  const playing = new Set(d.activePlayers().map((p) => p.id));
  const eligible = PROPERTY_KEYS.filter((k) => {
    const ownerId = d.state.properties[k].ownerId;
    return ownerId !== null && playing.has(ownerId);
  });
  const crisis: CrisisRecord = {
    id: d.ctx.newId(),
    checkpoint,
    checkpointClock: at,
    year: yearAt(eco, at),
    propertyKey: null,
    ownerId: null,
    mortgaged: false,
    amount: 0,
    paid: 0,
    policyId: null,
    status: 'SKIPPED',
    createdAt: d.ctx.now,
    settledAt: d.ctx.now,
  };
  ins.crises.push(crisis);
  // Nobody owns anything: the checkpoint is used up and the schedule carries on unchanged.
  if (eligible.length === 0) return;

  // A single candidate needs no draw; otherwise the server's RNG decides, and never a client.
  const key = eligible.length === 1 ? eligible[0]! : pickFrom(eligible, d.ctx.random);
  const prop = d.state.properties[key];
  const ownerId = prop.ownerId!;
  const deed = getDeed(key);
  crisis.propertyKey = key;
  crisis.ownerId = ownerId;
  crisis.mortgaged = prop.mortgaged;
  crisis.amount = INS.crisisBill;
  forgetUndoFor(d, key);

  const policy = ins.policies.find((p) => p.propertyKey === key && policyInForce(d.state, p, at));
  const payload = { crisisId: crisis.id, checkpoint, propertyKey: key, ownerId, amount: crisis.amount, mortgaged: prop.mortgaged };
  if (policy) {
    policy.status = 'CLAIMED';
    policy.claimedCrisisId = crisis.id;
    policy.closedAt = d.ctx.now;
    crisis.policyId = policy.id;
    crisis.status = 'COVERED';
    d.event('CRISIS_COVERED', ownerId, `Crisis at ${deed.name}! ${d.name(ownerId)}'s insurance covered the ${formatINR(crisis.amount)} bill`, { ...payload, policyId: policy.id });
    return;
  }
  crisis.status = 'PENDING';
  crisis.settledAt = null;
  d.event('CRISIS_STRUCK', ownerId, `Crisis at ${deed.name}! ${d.name(ownerId)} has no insurance and owes ${formatINR(crisis.amount)}`, payload);
}

// ---------------------------------------------------------------------------
// Settling a crisis bill
// ---------------------------------------------------------------------------

/** The pending bill this player must settle first (their oldest), or null. */
export function pendingCrisisOf(state: InsuranceView, playerId: string): CrisisRecord | null {
  return pendingCrises(state).find((c) => c.ownerId === playerId) ?? null;
}

/**
 * Why an action is refused while a crisis bill is unsettled, or null when it may go ahead.
 *
 * Everyone may still pause, resume, leave, end the game (host), decline an offer or request, and
 * send money to the player who owes. The player who owes may also pay, and raise money the usual
 * ways: sell a building, sell a property to the bank, mortgage, or take a loan the bank offers.
 * Everything else — rolling, ending a turn, buying, building, trading, insuring — waits.
 */
export function crisisGate(state: InsuranceView, actorId: string, action: GameAction): string | null {
  const pending = pendingCrises(state);
  const first = pending[0];
  if (!first) return null;
  const mine = pending.find((c) => c.ownerId === actorId);
  switch (action.type) {
    case 'PAUSE_GAME':
    case 'RESUME_GAME':
    case 'END_GAME':
    case 'LEAVE_GAME':
    case 'REJECT_TRADE':
    case 'CANCEL_TRADE':
    case 'REJECT_UNDO':
      return null;
    case 'TRANSFER_MONEY':
      if (!mine && pending.some((c) => c.ownerId === action.toPlayerId)) return null;
      break;
    case 'PAY_CRISIS_BILL':
    case 'DECLARE_CRISIS_BANKRUPTCY':
    case 'SELL_BUILDING':
    case 'SELL_PROPERTY':
    case 'MORTGAGE_PROPERTY':
    case 'TAKE_INTERMEDIATE_LOAN':
      if (mine) return null;
      break;
    default:
      break;
  }
  if (mine) return `Settle your ${formatINR(mine.amount - mine.paid)} crisis bill first.`;
  const owner = state.players.find((p) => p.id === first.ownerId)?.name ?? 'A player';
  return `Waiting for ${owner} to settle a ${formatINR(first.amount - first.paid)} crisis bill.`;
}

function ownPendingCrisis(d: Draft, actor: PlayerState, crisisId: string): CrisisRecord {
  const crisis = insuranceOf(d.state)?.crises.find((c) => c.id === crisisId);
  if (!crisis || crisis.ownerId !== actor.id) fail('NOT_FOUND', 'Crisis bill not found.');
  // A retry that arrives after the bill was settled finds nothing to pay: no second deduction.
  if (crisis.status !== 'PENDING') fail('INVALID_PHASE', 'This crisis bill is already settled.');
  return crisis;
}

/** Pays a pending crisis bill in full. Payment and settlement are one step of one action. */
export function payCrisisBill(d: Draft, actor: PlayerState, crisisId: string): void {
  const crisis = ownPendingCrisis(d, actor, crisisId);
  const due = crisis.amount - crisis.paid;
  if (actor.balance < due) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — you need ${formatINR(due)}. Mortgage, sell or take a loan.`);
  }
  const name = crisis.propertyKey ? getDeed(crisis.propertyKey).name : 'a property';
  d.transfer({ type: 'CRISIS_PAYMENT', from: actor.id, to: null, amount: due, propertyKey: crisis.propertyKey, memo: `Crisis bill (${name})` });
  crisis.paid = crisis.amount;
  crisis.status = 'PAID';
  crisis.settledAt = d.ctx.now;
  d.event('CRISIS_SETTLED', actor.id, `${actor.name} paid the ${formatINR(crisis.amount)} crisis bill for ${name}`, {
    crisisId: crisis.id,
    checkpoint: crisis.checkpoint,
    propertyKey: crisis.propertyKey,
    amount: crisis.amount,
  });
}

/** The ways this player could still raise money for a crisis bill, in words. Empty = every option is used up. */
export function crisisRecoveryOptions(state: GameState, playerId: string): string[] {
  const owned = ownedBy(state, playerId);
  const can = (kind: 'SELL_BUILDING' | 'MORTGAGE_PROPERTY' | 'SELL_PROPERTY') => owned.some((k) => propertyActionBlocker(state, playerId, k, kind) === null);
  const options: string[] = [];
  if (can('SELL_BUILDING')) options.push('sell a building');
  if (can('MORTGAGE_PROPERTY')) options.push('mortgage a property');
  if (can('SELL_PROPERTY')) options.push('sell a property to the bank');
  if (loanOffers(state, playerId).some((o) => !o.blocked && o.maxAmount >= IR.loans.minAmount)) options.push('take a loan');
  return options;
}

/** Why this player may not go bankrupt over a crisis bill right now, or null. Lacking the cash is not enough. */
export function crisisBankruptcyBlocker(state: GameState, playerId: string, crisis: CrisisRecord): string | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 'You are not in this game.';
  if (player.balance >= crisis.amount - crisis.paid) return 'You can afford this bill.';
  const options = crisisRecoveryOptions(state, playerId);
  if (options.length) return `You can still raise money: ${options.join(', ')}. Bankruptcy is only possible once nothing is left to try.`;
  return null;
}

/** Validates a bankruptcy over `crisisId` and returns the bill. The reducer then runs the game's own bankruptcy. */
export function assertCrisisBankruptcy(d: Draft, actor: PlayerState, crisisId: string): CrisisRecord {
  const crisis = ownPendingCrisis(d, actor, crisisId);
  const why = crisisBankruptcyBlocker(d.state, actor.id, crisis);
  if (why) fail('INVALID_PHASE', why);
  return crisis;
}

/** After the bankruptcy took the player's cash (`cash`, already paid to the bank): their bills are closed against it, oldest first. */
export function closeCrisesInBankruptcy(d: Draft, playerId: string, cash: number): void {
  let left = cash;
  for (const crisis of pendingCrises(d.state)) {
    if (crisis.ownerId !== playerId) continue;
    const part = Math.min(left, crisis.amount - crisis.paid);
    left -= part;
    crisis.paid += part;
    crisis.status = 'BANKRUPT';
    crisis.settledAt = d.ctx.now;
  }
}

/**
 * Closes pending bills of a player who is leaving (`playerId`), or of everyone when the game is
 * ending (`null`): the bank takes what cash there is towards each bill. Anything it could not
 * collect stays on record as UNPAID and counts against that player's net worth, so the game is
 * never left waiting on someone who is gone and no bill is skipped before the winner is decided.
 */
export function closePendingCrises(d: Draft, playerId: string | null): void {
  for (const crisis of pendingCrises(d.state)) {
    if (playerId !== null && crisis.ownerId !== playerId) continue;
    const owner = d.state.players.find((p) => p.id === crisis.ownerId);
    const name = crisis.propertyKey ? getDeed(crisis.propertyKey).name : 'a property';
    const part = Math.min(crisis.amount - crisis.paid, owner?.balance ?? 0);
    if (owner && part > 0) {
      d.transfer({ type: 'CRISIS_PAYMENT', from: owner.id, to: null, amount: part, propertyKey: crisis.propertyKey, memo: `Crisis bill (${name})` });
    }
    crisis.paid += part;
    crisis.status = crisis.paid === crisis.amount ? 'PAID' : 'UNPAID';
    crisis.settledAt = d.ctx.now;
    const who = d.name(crisis.ownerId);
    d.event(
      crisis.status === 'PAID' ? 'CRISIS_SETTLED' : 'CRISIS_UNPAID',
      crisis.ownerId,
      crisis.status === 'PAID'
        ? `${who} paid the ${formatINR(crisis.amount)} crisis bill for ${name}`
        : `${who} left ${formatINR(crisis.amount - crisis.paid)} of the crisis bill for ${name} unpaid`,
      { crisisId: crisis.id, checkpoint: crisis.checkpoint, propertyKey: crisis.propertyKey, amount: crisis.amount, paid: crisis.paid },
    );
  }
}
