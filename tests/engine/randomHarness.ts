import {
  applyAction,
  auctionAcceptUntil,
  auctionOpensAt,
  endVoteDeadline,
  createGame,
  economyOf,
  isGameError,
  joinGame,
  loanOffers,
  minimumNextBid,
  openEndVote,
  ownedBy,
  pendingCrises,
  premiumForYear,
  BUSINESS_MVP_RULES as RULES,
  INTERMEDIATE_RULES as IR,
  topUndoable,
  type EngineContext,
  type EngineResult,
  type GameAction,
  type GameMode,
  type GameState,
  type PropertyKey,
  type TransactionRecord,
} from '@/engine/index.ts';
import { stateViolations, stepViolations } from './invariantChecks.ts';

/**
 * A seeded, fully deterministic random player for the real engine (applyAction — nothing is mocked).
 *
 * Every step: candidate actions are derived from the current state (the things a screen would
 * offer: the turn's own action, bids while an auction runs, property and money management, trades,
 * undo, loans, insurance, leaving, pausing), tried in a seeded order, and the first one the engine
 * accepts is applied. A candidate the engine refuses changes nothing (the engine is pure) and is
 * not counted: only LEGAL actions make up a sequence. After each applied action every invariant
 * in invariantChecks.ts is asserted.
 *
 * A failure reports the seed and the exact sequence of applied steps; `replay` runs such a
 * sequence again without the generator, so it can be kept as a permanent regression test.
 */

/** mulberry32: small, fast, good enough, and the same on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Step {
  /** Index into the game's players in joining order. */
  actor: number;
  action: GameAction;
  /** Server clock at this action, ms since the start of the run. */
  atMs: number;
  /** Seed of the engine's own RNG for this action (dice, shuffles, market). */
  rng: number;
}

export interface Scenario {
  mode: GameMode;
  players: number;
  seed: number;
  config?: unknown;
}

export interface RunOutcome {
  scenario: Scenario;
  steps: Step[];
  state: GameState;
  ledger: TransactionRecord[];
  /** Applied actions by type. */
  counts: Record<string, number>;
}

const START_MS = Date.parse('2026-01-01T10:00:00.000Z');
const NAMES = ['Asha', 'Bilal', 'Chitra', 'Dev', 'Esha', 'Farid', 'Gita', 'Hari'];

export class InvariantFailure extends Error {
  constructor(
    message: string,
    readonly scenario: Scenario,
    readonly steps: Step[],
  ) {
    super(`${message}\n  scenario: ${JSON.stringify(scenario)}\n  steps (${steps.length}) to replay:\n${JSON.stringify(steps)}`);
    this.name = 'InvariantFailure';
  }
}

class Table {
  state: GameState;
  ledger: TransactionRecord[] = [];
  readonly ids: string[] = [];
  private counter = 0;

  constructor(readonly scenario: Scenario) {
    const newId = this.newId;
    const ctx = (): EngineContext => ({ actionId: newId(), now: new Date(START_MS).toISOString(), random: () => 0.5, newId });
    this.ids.push(newId());
    const created = createGame({ gameId: newId(), code: '123456', hostPlayerId: this.ids[0]!, hostName: NAMES[0]!, mode: scenario.mode, config: scenario.config }, ctx());
    this.state = created.state;
    this.ledger.push(...created.transactions);
    for (let i = 1; i < scenario.players; i += 1) {
      this.ids.push(newId());
      const joined = joinGame(this.state, { playerId: this.ids[i]!, name: NAMES[i]! }, ctx());
      this.state = joined.state;
      this.ledger.push(...joined.transactions);
    }
  }

  newId = (): string => {
    this.counter += 1;
    return `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  };

  /** Applies one step through the real engine and checks every invariant. Throws GameError when the action is not legal. */
  apply(step: Step, history: Step[]): EngineResult {
    // A refused action leaves no trace at all, not even a used id: a recording replays to the same ids.
    const idsBefore = this.counter;
    const actionId = this.newId();
    const ctx: EngineContext = { actionId, now: new Date(START_MS + step.atMs).toISOString(), random: prng(step.rng), newId: this.newId };
    const before = this.state;
    const untouched = JSON.stringify(before);
    let result: EngineResult;
    try {
      result = applyAction(before, this.ids[step.actor]!, step.action, ctx);
    } catch (error) {
      if (isGameError(error)) {
        this.counter = idsBefore;
        throw error;
      }
      throw new InvariantFailure(`the engine crashed on ${step.action.type}: ${String((error as Error)?.stack ?? error)}`, this.scenario, [...history, step]);
    }
    // Purity: an action never touches the state it was given.
    if (JSON.stringify(before) !== untouched) throw new InvariantFailure(`${step.action.type} changed the state it was given`, this.scenario, [...history, step]);
    const ledger = [...this.ledger, ...result.transactions];
    const problems = [...stepViolations(before, result, actionId), ...stateViolations(result.state, ledger)];
    if (problems.length) {
      throw new InvariantFailure(`after ${step.action.type} by ${NAMES[step.actor]} (step ${history.length + 1}):\n  - ${problems.join('\n  - ')}`, this.scenario, [...history, step]);
    }
    this.state = result.state;
    this.ledger = ledger;
    return result;
  }
}

const pick = <T>(items: readonly T[], random: () => number): T | undefined => items[Math.floor(random() * items.length)];

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

interface Candidate {
  actor: number;
  action: GameAction;
  /** Tried before the rest: the action that moves the game on. */
  main: boolean;
}

/** What the screens of the players would offer in this state. Legality is the engine's call, not this function's. */
function candidates(table: Table, nowMs: number, random: () => number, tempo: { leave: number; side: number; exhaustive?: boolean }): Candidate[] {
  const s = table.state;
  const out: Candidate[] = [];
  const add = (actor: number, action: GameAction, main = false) => out.push({ actor, action, main });
  const index = (id: string | null) => table.ids.indexOf(id ?? '');
  const active = s.players.filter((p) => p.status === 'ACTIVE');

  if (s.status === 'PAUSED') {
    for (const p of active) add(index(p.id), { type: 'RESUME_GAME' }, true);
    return out;
  }
  if (s.status !== 'ACTIVE') return out;

  // ---- a vote on ending the game: until it is settled the table offers nothing else ----
  const vote = openEndVote(s);
  if (vote) {
    for (const id of vote.electorate) {
      const voter = s.players.find((p) => p.id === id);
      if (!voter || voter.status !== 'ACTIVE' || id in vote.ballots) continue;
      // Some players let the time run out: a missing ballot is part of the game.
      if (tempo.exhaustive || random() < 0.7) add(index(id), { type: 'CAST_END_VOTE', voteId: vote.id, choice: random() < 0.4 ? 'END' : 'CONTINUE' }, true);
    }
    const closer = active[0];
    if (closer) add(index(closer.id), { type: 'CLOSE_END_VOTE', voteId: vote.id }, START_MS + nowMs >= endVoteDeadline(vote));
    if (random() < tempo.leave) {
      const leaver = pick(active, random);
      if (leaver) add(index(leaver.id), { type: 'LEAVE_GAME' }, true);
    }
    return out;
  }

  const turn = s.turn;
  const me = index(turn.playerId);
  const current = s.players.find((p) => p.id === turn.playerId);
  const eco = economyOf(s);
  const crises = pendingCrises(s);

  // ---- a crisis bill stops the table until it is settled ----
  for (const c of crises) {
    const owner = index(c.ownerId);
    if (owner < 0) continue;
    add(owner, { type: 'PAY_CRISIS_BILL', crisisId: c.id }, true);
    add(owner, { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: c.id }, random() < 0.5);
  }

  // ---- the turn ----
  if (current && current.status === 'ACTIVE') {
    switch (turn.phase) {
      case 'AWAITING_ROLL':
        if (current.inJail) {
          add(me, random() < 0.5 ? { type: 'PAY_JAIL_FINE' } : { type: 'STAY_IN_JAIL' }, true);
          add(me, { type: 'STAY_IN_JAIL' }, true);
        } else add(me, { type: 'ROLL_DICE' }, true);
        break;
      case 'AWAITING_DECISION': {
        const r = random();
        if (r < 0.55) add(me, { type: 'BUY_PROPERTY' }, true);
        else if (r < 0.7 && eco) add(me, { type: 'BUY_PROPERTY', insurePremium: premiumForYear(eco.year) }, true);
        else add(me, { type: random() < 0.5 ? 'DECLINE_PROPERTY' : 'START_AUCTION' }, true);
        add(me, { type: 'DECLINE_PROPERTY' }, true);
        break;
      }
      case 'AWAITING_PAYMENT': {
        const pending = turn.pending;
        if (pending?.kind === 'PAYMENT') {
          const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', LOAN_INTEREST: 'PAY_INTEREST', CLUB: 'PAY_CLUB' } as const;
          add(me, { type: pay[pending.reason] }, true);
          add(me, { type: 'DECLARE_BANKRUPTCY' }, random() < 0.35);
        }
        break;
      }
      case 'AWAITING_CARD': {
        add(me, { type: 'RESOLVE_CARD' }, true);
        break;
      }
      case 'TURN_COMPLETE':
        add(me, { type: 'END_TURN' }, true);
        break;
      default:
        break;
    }
  }

  // ---- the auction ----
  const auction = s.auction;
  if (auction && auction.status === 'OPEN' && turn.phase === 'AUCTION') {
    const open = nowMs >= auctionOpensAt(auction) - START_MS;
    for (const id of auction.participantIds) {
      const bidder = s.players.find((p) => p.id === id);
      if (!bidder || bidder.status !== 'ACTIVE' || auction.passedIds.includes(id)) continue;
      const min = minimumNextBid(auction);
      if (open && bidder.balance >= min && auction.highBidderId !== id && random() < 0.6) {
        const amount = min + auction.minimumIncrement * Math.floor(random() * 4);
        add(index(id), { type: 'PLACE_BID', auctionId: auction.id, amount: Math.min(amount, bidder.balance) }, true);
      }
      if (auction.highBidderId !== id && random() < 0.45) add(index(id), { type: 'PASS_AUCTION', auctionId: auction.id }, true);
    }
    if (auction.resale && auction.highBid === null && random() < 0.15) add(index(auction.resale.sellerId), { type: 'CANCEL_AUCTION', auctionId: auction.id }, true);
    // Anyone still at the table may ask for the close once the deadline has passed.
    const closer = pick(active, random);
    if (closer) add(index(closer.id), { type: 'CLOSE_AUCTION', auctionId: auction.id }, START_MS + nowMs >= auctionAcceptUntil(auction));
  }

  // ---- everything a player can do besides the turn (tried only now and then, so games still move on) ----
  if (random() < tempo.side) {
    for (const p of active) {
      const who = index(p.id);
      const mine = ownedBy(s, p.id);
      const key = pick(mine, random);
      if (key) {
        const kind = pick(['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_BUILDING', 'SELL_PROPERTY', 'MORTGAGE_PROPERTY', 'UNMORTGAGE_PROPERTY'] as const, random)!;
        add(who, { type: kind, propertyKey: key });
        // Building needs the whole colour: when a player has one, build on it.
        const built = mine.filter((k) => s.properties[k].houses > 0 || s.properties[k].hotel);
        const site = pick(built, random);
        if (site) add(who, { type: pick(['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_BUILDING'] as const, random)!, propertyKey: site });
        for (const k of mine) if (random() < 0.3) add(who, { type: random() < 0.8 ? 'BUILD_HOUSE' : 'BUILD_HOTEL', propertyKey: k });
      }
      const other = pick(active.filter((x) => x.id !== p.id), random);
      if (other && p.balance > 0 && random() < 0.3) add(who, { type: 'TRANSFER_MONEY', toPlayerId: other.id, amount: 1 + Math.floor(random() * Math.min(p.balance, 3000)) });
      if (!eco && random() < 0.3) add(who, { type: 'REQUEST_LOAN', amount: RULES.loans.minAmount + RULES.loans.step * Math.floor(random() * 6) });
      const loan = pick(s.loans.filter((l) => l.playerId === p.id && l.status === 'ACTIVE'), random);
      if (loan) add(who, { type: 'REPAY_LOAN', loanId: loan.id, amount: random() < 0.5 ? loan.outstanding : Math.max(1, Math.floor(loan.outstanding * random())) });

      if (other && random() < 0.35) {
        const theirs = ownedBy(s, other.id);
        const offered = mine.filter(() => random() < 0.3).slice(0, 2);
        const requested = theirs.filter(() => random() < 0.3).slice(0, 2);
        add(who, {
          type: 'CREATE_TRADE',
          toPlayerId: other.id,
          offeredPropertyKeys: offered,
          requestedPropertyKeys: requested,
          offeredMoney: random() < 0.5 ? Math.floor(random() * Math.min(p.balance, 2000)) : 0,
          requestedMoney: random() < 0.5 ? Math.floor(random() * Math.min(other.balance, 2000)) : 0,
        });
      }
      for (const t of s.trades.filter((x) => x.status === 'PENDING')) {
        if (t.toPlayerId === p.id) add(who, random() < 0.6 ? { type: 'ACCEPT_TRADE', tradeId: t.id } : { type: 'REJECT_TRADE', tradeId: t.id });
        if (t.fromPlayerId === p.id && random() < 0.2) add(who, { type: 'CANCEL_TRADE', tradeId: t.id });
      }
      const top = topUndoable(s);
      if (top && !s.undoRequest && random() < 0.3) add(who, { type: 'REQUEST_UNDO', targetActionId: top.actionId });
      if (s.undoRequest) add(who, random() < 0.7 ? { type: 'APPROVE_UNDO', requestId: s.undoRequest.id } : { type: 'REJECT_UNDO', requestId: s.undoRequest.id });

      if (eco) {
        const offer = pick(loanOffers(s, p.id).filter((o) => !o.blocked && o.maxAmount >= IR.loans.minAmount), random);
        if (offer && random() < 0.4) {
          const pledge = offer.secured ? pick(offer.collateral, random) : undefined;
          const cap = Math.min(offer.maxAmount, pledge ? pledge.limit : offer.maxAmount);
          const steps = Math.max(0, Math.floor((cap - IR.loans.minAmount) / IR.loans.step));
          add(who, {
            type: 'TAKE_INTERMEDIATE_LOAN',
            product: offer.product,
            amount: IR.loans.minAmount + IR.loans.step * Math.floor(random() * (steps + 1)),
            ...(pledge ? { collateralKey: pledge.key } : {}),
            expectedRatePercent: offer.ratePercent,
          });
        }
        for (const l of eco.loans.filter((x) => x.playerId === p.id)) {
          if (l.status === 'ACTIVE') {
            add(who, { type: 'PAY_LOAN_INSTALLMENT', loanId: l.id });
            if (random() < 0.3) add(who, { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: l.id, amount: IR.loans.step * (1 + Math.floor(random() * 4)) });
          } else if (l.status === 'DEFAULTED' && l.defaultBalance > 0) {
            add(who, { type: 'PAY_DEFAULTED_LOAN', loanId: l.id, amount: random() < 0.5 ? l.defaultBalance : Math.max(1, Math.floor(l.defaultBalance * random())) });
          }
        }
        if (key && random() < 0.5) add(who, { type: 'INSURE_PROPERTY', propertyKey: key, expectedPremium: premiumForYear(eco.year) });
        if (mine.length > 1 && random() < 0.2) add(who, { type: 'INSURE_PROPERTIES', propertyKeys: mine.slice(0, 4) as PropertyKey[], expectedPremium: premiumForYear(eco.year) });
        if (key && p.id === turn.playerId && random() < 0.35) {
          const value = eco.market[key]?.value ?? 1000;
          add(who, { type: 'START_RESALE_AUCTION', propertyKey: key, reservePrice: Math.max(100, Math.round((value * (0.3 + random())) / 100) * 100) });
        }
      }
    }
  }

  // ---- every way of raising money, for every player: asked for when nothing else was accepted ----
  if (tempo.exhaustive) {
    for (const p of active) {
      const who = index(p.id);
      for (const key of ownedBy(s, p.id)) {
        for (const kind of ['SELL_BUILDING', 'MORTGAGE_PROPERTY', 'SELL_PROPERTY'] as const) add(who, { type: kind, propertyKey: key });
      }
      for (const offer of loanOffers(s, p.id)) {
        if (offer.blocked) continue;
        for (const pledge of offer.secured ? offer.collateral : [undefined]) {
          add(who, { type: 'TAKE_INTERMEDIATE_LOAN', product: offer.product, amount: IR.loans.minAmount, ...(pledge ? { collateralKey: pledge.key } : {}), expectedRatePercent: offer.ratePercent });
        }
      }
      if (!eco) add(who, { type: 'REQUEST_LOAN', amount: RULES.loans.minAmount });
    }
  }

  // ---- walking away, pausing, ending ----
  if (random() < tempo.leave) {
    const leaver = pick(active, random);
    if (leaver) add(index(leaver.id), { type: 'LEAVE_GAME' }, true);
  }
  if (random() < 0.01) {
    const pauser = pick(active, random);
    if (pauser) add(index(pauser.id), { type: 'PAUSE_GAME' }, true);
  }
  // Anyone may ask for a vote on ending early; the engine decides whether this is a moment for one.
  if (random() < 0.01) {
    const asker = pick(active, random);
    if (asker) add(index(asker.id), { type: 'REQUEST_END_VOTE' }, true);
  }
  return out;
}

/** Actions that only stop or leave the game: they do not count as "the game can go on". */
const NOT_PROGRESS = new Set<GameAction['type']>(['LEAVE_GAME', 'PAUSE_GAME', 'REQUEST_END_VOTE']);

export function runScenario(scenario: Scenario, maxSteps: number): RunOutcome {
  const random = prng(scenario.seed);
  const table = new Table(scenario);
  const steps: Step[] = [];
  const counts: Record<string, number> = {};
  // Each seed plays a little differently: some tables are busy with side deals, some lose players early.
  const tempo = { leave: random() < 0.3 ? 0.01 : 0.001, side: 0.15 + random() * 0.5 };
  let nowMs = 0;
  let rngSeed = (scenario.seed * 2654435761) >>> 0;

  const tryApply = (actor: number, action: GameAction): boolean => {
    rngSeed = (rngSeed + 0x9e3779b9) >>> 0;
    const step: Step = { actor, action, atMs: nowMs, rng: rngSeed };
    try {
      table.apply(step, steps);
    } catch (error) {
      if (isGameError(error)) return false;
      throw error;
    }
    steps.push(step);
    counts[action.type] = (counts[action.type] ?? 0) + 1;
    return true;
  };

  // The lobby: the host starts as soon as the table is seated.
  if (!tryApply(0, { type: 'START_GAME' })) throw new InvariantFailure('START_GAME was refused for a full lobby', scenario, steps);

  while (steps.length < maxSteps && table.state.status !== 'FINISHED') {
    nowMs += 200 + Math.floor(random() * 2500);
    const offered = candidates(table, nowMs, random, tempo);
    const ordered = [...shuffle(offered.filter((c) => c.main), random), ...shuffle(offered.filter((c) => !c.main), random)];
    // Mostly the action that moves the game on; sometimes a side action first.
    if (random() < 0.4) ordered.reverse();
    let applied = ordered.some((c) => c.actor >= 0 && tryApply(c.actor, c.action));
    if (!applied && table.state.auction?.status === 'OPEN' && table.state.status === 'ACTIVE') {
      // Nobody bids or passes: time runs out and the auction is closed.
      nowMs = Math.max(nowMs, auctionAcceptUntil(table.state.auction) - START_MS);
      const closer = table.state.players.findIndex((p) => p.status === 'ACTIVE');
      applied = tryApply(table.ids.indexOf(table.state.players[closer]!.id), { type: 'CLOSE_AUCTION', auctionId: table.state.auction.id });
    }
    const voting = openEndVote(table.state);
    if (!applied && voting && table.state.status === 'ACTIVE') {
      // Nobody else votes: time runs out and the vote is closed on what was cast.
      nowMs = Math.max(nowMs, endVoteDeadline(voting) - START_MS);
      const closer = table.state.players.findIndex((p) => p.status === 'ACTIVE');
      applied = tryApply(table.ids.indexOf(table.state.players[closer]!.id), { type: 'CLOSE_END_VOTE', voteId: voting.id });
    }
    if (!applied) {
      // Liveness: a running game always has something a player can do to move it on.
      const state = table.state;
      const anything = candidates(table, nowMs, prng(rngSeed ^ 0x5bd1e995), { leave: 0, side: 1, exhaustive: true }).filter((c) => !NOT_PROGRESS.has(c.action.type));
      const moved = anything.some((c) => c.actor >= 0 && tryApply(c.actor, c.action));
      if (!moved) {
        throw new InvariantFailure(
          `the game is stuck: status ${state.status}, phase ${state.turn.phase}, pending ${JSON.stringify(state.turn.pending)}, auction ${state.auction?.status ?? 'none'}`,
          scenario,
          steps,
        );
      }
    }
  }
  return { scenario, steps, state: table.state, ledger: table.ledger, counts };
}

/** Runs a recorded sequence again, exactly: no generator, the same engine RNG per step, every invariant checked. */
export function replay(scenario: Scenario, steps: readonly Step[]): RunOutcome {
  const table = new Table(scenario);
  const done: Step[] = [];
  const counts: Record<string, number> = {};
  for (const step of steps) {
    table.apply(step, done);
    done.push(step);
    counts[step.action.type] = (counts[step.action.type] ?? 0) + 1;
  }
  return { scenario, steps: done, state: table.state, ledger: table.ledger, counts };
}
