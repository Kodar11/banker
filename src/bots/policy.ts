import {
  auctionAcceptUntil,
  balanceSheet,
  BOARD_SIZE,
  BUSINESS_MVP_RULES as RULES,
  crisisDue,
  economyOf,
  endVoteDeadline,
  formatINR,
  getDeed,
  insuranceQuote,
  openEndVote,
  ownedBy,
  pendingCrises,
  raisableFunds,
  topUndoable,
  type GameAction,
} from '../engine/index.ts';
import { auctionMove } from './auction.ts';
import { BOT_POLICY, PERSONALITY_TUNING } from './config.ts';
import { DICE_DISTRIBUTION, EXPECTED_ROLL } from './dice.ts';
import { dryRun } from './engineAccess.ts';
import { hasLoanObligation, loanCandidates, obligationAction, overdueInstallmentAmount, optionalFinanceCandidates, PAY_ACTION, pickRecovery, propertiesLabel, raiseCashCandidates } from './finance.ts';
import { rollOutcome, outcomeOutflow } from './movement.ts';
import { believedState } from './observation.ts';
import { mixSeed, prng } from './random.ts';
import { actionKey, best, evaluate, type Scored } from './scoring.ts';
import { proposeTrade, respondToOffer, staleOwnOffer, tradeTurn } from './trading.ts';
import type { BotCandidateEvaluation, BotDecision, BotDecisionContext, BotObservation } from './types.ts';
import { assess, buildValuationContext, delta, knownOutflows, weigh, type Assessment, type ValuationContext } from './valuation.ts';

/**
 * THE decision function. Given what one bot seat may see (observation.ts) and its configuration, it
 * returns ONE action to send — or none, with the reason it is waiting. The order of the checks below is
 * the order of obligations in the game: what blocks the whole table first (a vote, a crisis bill), then
 * what other players are waiting on from this bot (an undo request, a trade offer, an auction), then the
 * bot's own turn. Within the turn: what is owed, then what is optional, then what moves the game on.
 *
 * Every candidate is checked with the engine before it is chosen (scoring.evaluate → engineAccess.dryRun),
 * so the bot only ever proposes actions the engine accepts for its own view of the game. The server's
 * engine has the final word; if it refuses, the runner asks again with that action excluded.
 *
 * Pure and deterministic: the same observation, profile, seed and exclusions give the same decision.
 */
export function decide(obs: BotObservation, ctx: BotDecisionContext & { exclude?: readonly string[] }): BotDecision {
  const s = obs.state;
  const me = obs.me;
  if (s.status !== 'ACTIVE') return wait('GAME_NOT_RUNNING', s.status === 'PAUSED' ? 'The game is paused.' : 'The game is not running.');
  if (me.status !== 'ACTIVE') return wait('OUT_OF_GAME', 'This seat is out of the game.');
  const exclude = new Set(ctx.exclude ?? []);
  const allowed = (a: GameAction) => !exclude.has(actionKey(a));

  // 1. A vote on ending the game stops everything else.
  const vote = openEndVote(s);
  if (vote) {
    if (obs.nowMs >= endVoteDeadline(vote)) return act({ type: 'CLOSE_END_VOTE', voteId: vote.id }, 'CLOSE_VOTE', 'The end-game vote has run out of time.', allowed) ?? wait('TIMER', 'Waiting for the vote to close.');
    if (vote.electorate.includes(me.id) && !(me.id in vote.ballots)) return ballot(obs, ctx, vote.id, vote.kind, allowed);
    return wait('TIMER', 'Waiting for the end-game vote.');
  }

  // The valuation (board simulations included) is built only once the bot has something to decide.
  let lazy: { vc: ValuationContext; base: Assessment } | null = null;
  const valuation = () => {
    if (!lazy) {
      const vc = buildValuationContext(obs, ctx);
      lazy = { vc, base: assess(vc, s) };
    }
    return lazy;
  };

  // 2. A crisis bill (Capital) stops the table until its owner settles it.
  const crisis = pendingCrises(s)[0];
  if (crisis) {
    const mine = pendingCrises(s).find((c) => c.ownerId === me.id);
    // Trades wait too (the engine refuses them until the bill is settled): offers are answered afterwards.
    if (!mine) return wait('NOT_MY_MOVE', 'Waiting for a crisis bill to be settled.');
    const due = crisisDue(mine);
    const pay = me.balance >= due ? act({ type: 'PAY_CRISIS_BILL', crisisId: mine.id }, 'PAY_CRISIS', `Pays its ${formatINR(due)} crisis bill.`, allowed) : null;
    if (pay) return pay;
    const { vc, base } = valuation();
    return recover(vc, base, due, { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: mine.id }, exclude, true);
  }

  // 3. What others are waiting on from this bot.
  const undo = undoAnswer(obs, allowed);
  if (undo) return undo;
  if (s.trades.some((t) => t.status === 'PENDING' && t.toPlayerId === me.id)) {
    const offer = incomingOffer(valuation().vc, exclude);
    if (offer) return offer;
  }
  const auction = s.auction;
  if (auction && auction.status === 'OPEN') {
    const participating = auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id) && auction.highBidderId !== me.id && auction.resale?.sellerId !== me.id;
    if (!participating && obs.nowMs < auctionAcceptUntil(auction)) return wait('NOT_MY_MOVE', 'Not bidding in this auction.');
    const { vc, base } = valuation();
    const move = auctionMove(vc, base, auction);
    if (move.kind === 'CLOSE') {
      // Anyone may close an auction whose time is up; the server's timer does too, whichever comes first.
      return act({ type: 'CLOSE_AUCTION', auctionId: auction.id }, 'CLOSE_AUCTION', move.reason, allowed) ?? wait('TIMER', 'Waiting for the auction to close.');
    }
    if (move.kind === 'BID') return act({ type: 'PLACE_BID', auctionId: auction.id, amount: move.amount! }, 'BID', move.reason, allowed) ?? act({ type: 'PASS_AUCTION', auctionId: auction.id }, 'PASS', 'Its bid was refused; it passes.', allowed) ?? wait('NOT_MY_MOVE', 'No bid it can make.');
    if (move.kind === 'PASS') return act({ type: 'PASS_AUCTION', auctionId: auction.id }, 'PASS', move.reason, allowed) ?? wait('NOT_MY_MOVE', 'Its pass was refused.');
    return wait('NOT_MY_MOVE', move.reason);
  }

  // 4. Obligations that can be met at any time (loan installments and principal falling due).
  const isMyTurn = s.turn.playerId === me.id;
  if (!isMyTurn && !hasLoanObligation(s, me.id)) return wait('NOT_MY_MOVE', "Another player's turn.");
  const { vc, base } = valuation();
  const obligation = obligationAction(vc, exclude);
  if (obligation) return { action: obligation.action, kind: obligation.kind, reason: obligation.reason };

  if (!isMyTurn) return wait('NOT_MY_MOVE', "Another player's turn.");

  // A Capital installment already overdue (default, collateral seizure and a credit-score hit follow) is
  // raised for like a payment — on the bot's own turn, before anything optional, never by new borrowing.
  const overdue = overdueInstallmentAmount(s, me.id);
  if (overdue > me.balance && (s.turn.phase === 'AWAITING_ROLL' || s.turn.phase === 'TURN_COMPLETE')) {
    const pick = pickRecovery(vc, base, overdue - me.balance, raiseCashCandidates(vc, overdue - me.balance, false), exclude);
    if (pick) return { action: pick.action, kind: 'RECOVER', reason: `Raising money for an overdue loan installment: ${describe(pick.action)} — ${pick.note}.` };
  }

  // 5. The bot's own turn.
  switch (s.turn.phase) {
    case 'AWAITING_ROLL':
      if (me.inJail) return jailChoice(vc, allowed);
      return act({ type: 'ROLL_DICE' }, 'ROLL', 'Rolls the dice.', allowed) ?? stuck('ROLL_DICE was refused.');
    case 'AWAITING_DECISION':
      return purchase(vc, base, exclude, ctx);
    case 'AWAITING_PAYMENT': {
      const pending = s.turn.pending;
      if (pending?.kind !== 'PAYMENT') return stuck('Waiting on a payment that is not there.');
      const action = { type: PAY_ACTION[pending.reason] } as GameAction;
      if (me.balance >= pending.amount) return act(action, 'PAY', `Pays ${formatINR(pending.amount)} (${pending.label}).`, allowed) ?? stuck('Its payment was refused.');
      return recover(vc, base, pending.amount, { type: 'DECLARE_BANKRUPTCY' }, exclude, false);
    }
    case 'AWAITING_CARD':
      return act({ type: 'RESOLVE_CARD' }, 'CARD', 'Resolves its card.', allowed) ?? stuck('RESOLVE_CARD was refused.');
    case 'TURN_COMPLETE':
      return endOfTurn(vc, base, exclude, ctx);
    default:
      return wait('NOT_MY_MOVE', `Waiting (${s.turn.phase}).`);
  }
}

// ---------------------------------------------------------------------------

function wait(waiting: NonNullable<BotDecision['waiting']>, reason: string): BotDecision {
  return { action: null, kind: 'WAIT', reason, waiting };
}

function stuck(reason: string): BotDecision {
  return { action: null, kind: 'NO_LEGAL_ACTION', reason, waiting: 'NOT_MY_MOVE' };
}

function act(action: GameAction, kind: string, reason: string, allowed: (a: GameAction) => boolean): BotDecision | null {
  return allowed(action) ? { action, kind, reason } : null;
}

function fromScored(scored: Scored, kind: string, reason: string, debug: boolean, considered: Scored[] = []): BotDecision {
  const decision: BotDecision = { action: scored.action, kind, reason };
  if (debug) decision.considered = considered.slice(0, 8).map((c): BotCandidateEvaluation => ({ action: c.action, score: Math.round(c.score), components: c.components, note: c.note }));
  return decision;
}

// ---------------------------------------------------------------------------
// Answers others are waiting for
// ---------------------------------------------------------------------------

function incomingOffer(vc: ValuationContext, exclude: ReadonlySet<string>): BotDecision | null {
  const me = vc.obs.botId;
  const offers = vc.obs.state.trades.filter((t) => t.status === 'PENDING' && t.toPlayerId === me).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const offer of offers) {
    const move = respondToOffer(vc, offer);
    if (!exclude.has(actionKey(move.action))) return { action: move.action, kind: move.kind, reason: move.reason };
    // The server refused that answer (something this seat cannot see, such as a pledge): a plain rejection instead.
    const reject: GameAction = { type: 'REJECT_TRADE', tradeId: offer.id };
    if (!exclude.has(actionKey(reject))) return { action: reject, kind: 'TRADE_REJECT', reason: 'Rejects the offer: it could not go through.' };
  }
  return null;
}

/**
 * An undo request this bot is asked to approve: it agrees when reversing the action costs it nothing (no
 * money it received goes back, no property of its own leaves it), and declines otherwise.
 */
function undoAnswer(obs: BotObservation, allowed: (a: GameAction) => boolean): BotDecision | null {
  const req = obs.state.undoRequest;
  if (!req || !req.approverIds.includes(obs.botId)) return null;
  const record = topUndoable(obs.state);
  let cost = 0;
  if (record && record.actionId === req.targetActionId) {
    for (const m of record.moves) {
      if (m.toPlayerId === obs.botId) cost += m.amount;
      if (m.fromPlayerId === obs.botId) cost -= m.amount;
    }
    for (const before of record.propertiesBefore) {
      const now = obs.state.properties[before.key];
      if (now?.ownerId === obs.botId && before.ownerId !== obs.botId) cost += getDeed(before.key).price;
    }
  } else {
    cost = 1;
  }
  return cost <= 0
    ? act({ type: 'APPROVE_UNDO', requestId: req.id }, 'UNDO_APPROVE', 'Approves the undo: it costs it nothing.', allowed)
    : act({ type: 'REJECT_UNDO', requestId: req.id }, 'UNDO_REJECT', 'Declines the undo: reversing it would cost it.', allowed);
}

/**
 * The bot's ballot. It votes to END when, by its own estimate of the standings (net worth, with opponents'
 * hidden cash estimated, never read), it leads the next player by its personality's margin; otherwise to
 * CONTINUE. Easy weighs the same lead with a deterministic coin.
 */
function ballot(obs: BotObservation, ctx: BotDecisionContext, voteId: string, kind: 'EARLY' | 'DURATION', allowed: (a: GameAction) => boolean): BotDecision {
  const believed = believedState(obs);
  const mine = balanceSheet(believed, obs.botId).netWorth;
  const best = Math.max(0, ...believed.players.filter((p) => p.status === 'ACTIVE' && p.id !== obs.botId).map((p) => balanceSheet(believed, p.id).netWorth));
  const lead = (mine - best) / Math.max(1, Math.abs(mine));
  const needed = PERSONALITY_TUNING[ctx.profile.personality].endVoteLead * (kind === 'DURATION' ? 0.5 : 1);
  let end = lead >= needed;
  if (ctx.profile.difficulty === 'easy') {
    const p = Math.min(1, Math.max(0, 0.5 + BOT_POLICY.vote.easyLeadWeight * lead * 2));
    end = prng(mixSeed(ctx.seed, 'vote', voteId))() < p;
  }
  const choice = end ? 'END' : 'CONTINUE';
  return (
    act({ type: 'CAST_END_VOTE', voteId, choice }, 'VOTE', end ? 'Votes to end the game: it believes it is ahead.' : 'Votes to continue: it is not far enough ahead.', allowed) ??
    wait('TIMER', 'Waiting for the vote to close.')
  );
}

// ---------------------------------------------------------------------------
// Money that must be found
// ---------------------------------------------------------------------------

/**
 * A payment (or crisis bill) the bot can't cover from cash. If even selling everything to the bank and every
 * loan on offer could not raise it, the bot declares bankruptcy at once (the estate settles the same way the
 * liquidation would). Otherwise it raises the money one step at a time, least harmful step first.
 */
function recover(vc: ValuationContext, base: Assessment, owed: number, bankruptcy: GameAction, exclude: ReadonlySet<string>, crisis: boolean): BotDecision {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const shortfall = owed - me.balance;
  const loans = loanCandidates(vc, shortfall);
  const loanRoom = Math.max(0, ...loans.map((a) => ('amount' in a ? a.amount : 0)));
  if (raisableFunds(s, me.id) + loanRoom < owed && dryRun(s, me.id, bankruptcy, vc.obs.nowMs) && !exclude.has(actionKey(bankruptcy))) {
    return { action: bankruptcy, kind: 'BANKRUPT', reason: `Declares bankruptcy: it owes ${formatINR(owed)} and could raise at most ${formatINR(raisableFunds(s, me.id) + loanRoom)}.` };
  }
  const pick = pickRecovery(vc, base, shortfall, raiseCashCandidates(vc, shortfall, true), exclude);
  if (pick) return { action: pick.action, kind: 'RECOVER', reason: `${crisis ? 'Raising money for a crisis bill' : 'Raising money for a payment'}: ${describe(pick.action)} — ${pick.note}.` };
  if (dryRun(s, me.id, bankruptcy, vc.obs.nowMs) && !exclude.has(actionKey(bankruptcy))) {
    return { action: bankruptcy, kind: 'BANKRUPT', reason: `Declares bankruptcy: nothing more can be raised towards ${formatINR(owed)}.` };
  }
  return stuck('It owes money it cannot raise, and bankruptcy is not allowed yet.');
}

function describe(action: GameAction): string {
  switch (action.type) {
    case 'SELL_BUILDING':
      return `sells a building on ${getDeed(action.propertyKey).name}`;
    case 'MORTGAGE_PROPERTY':
      return `mortgages ${getDeed(action.propertyKey).name}`;
    case 'SELL_PROPERTY':
      return `sells ${getDeed(action.propertyKey).name} to the bank`;
    case 'REQUEST_LOAN':
    case 'TAKE_INTERMEDIATE_LOAN':
      return `borrows ${formatINR(action.amount)}`;
    case 'BUILD_HOUSE':
      return `builds a house on ${getDeed(action.propertyKey).name}`;
    case 'BUILD_HOTEL':
      return `builds a hotel on ${getDeed(action.propertyKey).name}`;
    case 'UNMORTGAGE_PROPERTY':
      return `unmortgages ${getDeed(action.propertyKey).name}`;
    case 'INSURE_PROPERTY':
      return `insures ${getDeed(action.propertyKey).name}`;
    case 'INSURE_PROPERTIES':
      return `insures ${propertiesLabel(action.propertyKeys)}`;
    case 'RENEW_INSURANCE':
      return 'renews its insurance';
    case 'REPAY_LOAN':
    case 'PREPAY_INTERMEDIATE_LOAN':
      return `repays ${formatINR(action.amount)} of a loan`;
    default:
      return action.type.toLowerCase().replace(/_/g, ' ');
  }
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

/**
 * Buy the property landed on, or decline it (which starts the auction, where the bot bids like everyone else).
 * It buys when owning it is worth more than keeping the money, reserve and all — or, if it can't pay, when
 * mortgaging something quieter or borrowing first is still worth it (Normal/Hard). The cash must still cover
 * what is already owed.
 */
function purchase(vc: ValuationContext, base: Assessment, exclude: ReadonlySet<string>, ctx: BotDecisionContext): BotDecision {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const pending = s.turn.pending;
  if (pending?.kind !== 'BUY') return stuck('No purchase offer is waiting.');
  const name = getDeed(pending.propertyKey).name;
  const options: (Scored | null)[] = [evaluate(vc, base, { type: 'BUY_PROPERTY' }, `buy ${name}`, s, exclude)];
  const eco = economyOf(s);
  if (eco?.insurance) {
    options.push(evaluate(vc, base, { type: 'BUY_PROPERTY', insurePremium: insuranceQuote({ year: eco.year, properties: 1 }).premium }, `buy and insure ${name}`, s, exclude));
  }
  const affordable = options.filter((o): o is Scored => !!o && o.afterAssessment.cash >= knownOutflows(o.after, me.id));
  const top = best(affordable);
  if (top && top.score >= BOT_POLICY.decisions.minimumImprovement) {
    return fromScored(top, 'BUY', `Buys ${name} for ${formatINR(pending.price)}: ${top.action.type === 'BUY_PROPERTY' && 'insurePremium' in top.action && top.action.insurePremium ? 'insured, ' : ''}worth about ${formatINR(top.score)} more than keeping the cash (expected rent ${formatINR(top.afterAssessment.income - base.income)} over the plan).`, !!ctx.debug, affordable);
  }
  // Can't pay for it from cash: is funding it first still worth it?
  if (!top && me.balance < pending.price && vc.profile.difficulty !== 'easy') {
    const funding = fundPurchase(vc, base, pending.price, exclude);
    if (funding) return funding;
  }
  const decline: GameAction = { type: 'DECLINE_PROPERTY' };
  if (exclude.has(actionKey(decline))) return stuck('Declining was refused.');
  const why = top ? `buying ${name} is not worth it now (${formatINR(top.score)}; reserve ${formatINR(base.reserve)})` : me.balance < pending.price ? `it can't pay ${formatINR(pending.price)} for ${name}` : `buying ${name} would leave too little for what it owes`;
  return { action: decline, kind: 'DECLINE', reason: `Declines: ${why}. It may still bid in the auction.` };
}

/** One funding step (a mortgage or a loan) that makes a worthwhile purchase possible, judged on the position after both. */
function fundPurchase(vc: ValuationContext, base: Assessment, price: number, exclude: ReadonlySet<string>): BotDecision | null {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const short = price - me.balance;
  const steps: GameAction[] = [...ownedBy(s, me.id).map((k): GameAction => ({ type: 'MORTGAGE_PROPERTY', propertyKey: k })), ...loanCandidates(vc, short + vc.reserveBase / 2)];
  let top: { step: GameAction; score: number } | null = null;
  for (const step of steps) {
    if (exclude.has(actionKey(step))) continue;
    const funded = dryRun(s, me.id, step, vc.obs.nowMs);
    if (!funded) continue;
    const bought = dryRun(funded.state, me.id, { type: 'BUY_PROPERTY' }, vc.obs.nowMs);
    if (!bought) continue;
    const after = assess(vc, bought.state);
    if (after.cash < knownOutflows(bought.state, me.id)) continue;
    // Both steps together, against the position now (base): funding and buying, each counted once.
    const both = evaluate(vc, base, { type: 'BUY_PROPERTY' }, 'buy', funded.state);
    if (!both) continue;
    // And the purchase must still be worth it once funded, or the next decision would decline what this one paid for.
    const thenBuy = both.score - weigh(vc, delta(assess(vc, funded.state).components, base.components));
    if (thenBuy < BOT_POLICY.decisions.minimumImprovement) continue;
    if (both.score >= BOT_POLICY.decisions.exceptionalScore && (!top || both.score > top.score)) top = { step, score: both.score };
  }
  if (!top) return null;
  const pending = s.turn.pending;
  const name = pending?.kind === 'BUY' ? getDeed(pending.propertyKey).name : 'the property';
  return { action: top.step, kind: 'FUND_PURCHASE', reason: `${capitalise(describe(top.step))} to afford ${name}: together worth about ${formatINR(top.score)}.` };
}

// ---------------------------------------------------------------------------
// Jail
// ---------------------------------------------------------------------------

/**
 * In Jail at the start of its turn: pay the fine and roll, or stay. It pays when the roll is expected to be
 * worth more than the fine — Start rewards, cards, and properties still for sale it could buy, against the
 * rent and charges the roll could cost (the exact distribution of the next roll) — and the fine leaves enough
 * cash for its personality. Late in the game, when the board is full of other players' rent, staying put is
 * often the better move.
 */
function jailChoice(vc: ValuationContext, allowed: (a: GameAction) => boolean): BotDecision {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const fine = RULES.jail.fine;
  const stay = act({ type: 'STAY_IN_JAIL' }, 'JAIL_STAY', 'Stays in Jail this turn.', allowed);
  if (me.balance - fine < vc.personality.jailFineReserveShare * vc.reserveBase) return stay ?? stuck('Neither paying nor staying is possible.');
  let value = 0;
  for (const d of DICE_DISTRIBUTION) {
    const out = rollOutcome(me.position, d.total);
    let v = -outcomeOutflow(s, me.id, out, d.total) + out.cardReceive + (out.passedStart ? RULES.start.passReward : 0);
    // A property still for sale is a chance to buy income (or force an auction): about a third of its price. UNVALIDATED.
    for (const key of out.landed) if (s.properties[key]?.ownerId === null) v += 0.3 * getDeed(key).price;
    value += d.probability * v;
  }
  // Staying also costs tempo: a turn not moved is a turn later to the next Start reward.
  value += (RULES.start.passReward * EXPECTED_ROLL) / BOARD_SIZE;
  if (value > fine) {
    return act({ type: 'PAY_JAIL_FINE' }, 'JAIL_PAY', `Pays the ${formatINR(fine)} fine: the roll is worth about ${formatINR(value)}.`, allowed) ?? stay ?? stuck('Jail options refused.');
  }
  return stay ?? stuck('Staying in Jail was refused.');
}

// ---------------------------------------------------------------------------
// End of the turn: optional moves, then END_TURN
// ---------------------------------------------------------------------------

/**
 * After the turn's business: at most one optional move per decision (the runner asks again), each scored on
 * the position it leads to — building, unmortgaging, repaying, insuring, renewing, withdrawing a stale offer
 * or proposing a trade — and END_TURN once nothing is worth more than the minimum improvement. Building
 * must also clear the personality's construction hurdle. Bounded per turn.
 */
function endOfTurn(vc: ValuationContext, base: Assessment, exclude: ReadonlySet<string>, ctx: BotDecisionContext): BotDecision {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const end: GameAction = { type: 'END_TURN' };
  const finish = (reason: string): BotDecision => (exclude.has(actionKey(end)) ? stuck('END_TURN was refused.') : { action: end, kind: 'END_TURN', reason });
  if ((ctx.actionsThisTurn ?? 0) >= BOT_POLICY.decisions.maxManagementActionsPerTurn) return finish('Ends its turn (management limit reached).');

  const stale = staleOwnOffer(vc);
  if (stale && !exclude.has(actionKey(stale.action))) return { action: stale.action, kind: stale.kind, reason: stale.reason };

  const candidates: GameAction[] = [];
  for (const key of ownedBy(s, me.id)) {
    const prop = s.properties[key];
    if (prop.mortgaged) candidates.push({ type: 'UNMORTGAGE_PROPERTY', propertyKey: key });
    else if (getDeed(key).kind === 'CITY') candidates.push(prop.houses >= RULES.building.maxHouses ? { type: 'BUILD_HOTEL', propertyKey: key } : { type: 'BUILD_HOUSE', propertyKey: key });
  }
  candidates.push(...optionalFinanceCandidates(vc));
  const scored: Scored[] = [];
  for (const action of candidates) {
    const sc = evaluate(vc, base, action, describe(action), s, exclude);
    if (!sc) continue;
    if (sc.afterAssessment.cash < knownOutflows(sc.after, me.id)) continue;
    if (action.type === 'BUILD_HOUSE' || action.type === 'BUILD_HOTEL') {
      // Construction hurdle: income + end value of what is built ≥ hurdle × its cost.
      const cost = base.cash - sc.afterAssessment.cash;
      const benefit = sc.components.wealth + sc.components.group + cost;
      if (benefit < vc.personality.constructionHurdle * cost) continue;
    }
    scored.push(sc);
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top && top.score >= BOT_POLICY.decisions.minimumImprovement) {
    return fromScored(top, top.action.type, `${capitalise(describe(top.action))}: worth about ${formatINR(top.score)} to it.`, !!ctx.debug, scored);
  }
  if (tradeTurn(vc)) {
    const proposal = proposeTrade(vc);
    if (proposal && !exclude.has(actionKey(proposal.action))) return { action: proposal.action, kind: proposal.kind, reason: proposal.reason };
  }
  return finish('Ends its turn.');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

