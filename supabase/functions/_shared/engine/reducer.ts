import { GameActionSchema, PlayerNameSchema, type GameAction } from './actions.ts';
import {
  BOARD_SIZE,
  getDeed,
  normalizePosition,
  positionOfSpecial,
  positionOfSquare,
  PROPERTY_KEYS,
  RULES_VERSION,
  spaceAt,
  spaceName,
  type PropertyKey,
} from './businessBoard.ts';
import { DECK_LABELS, findCard, type CardDefinition, type Deck, type MoveDirection } from './cards.ts';
import { Draft } from './draft.ts';
import { fail, GameError } from './errors.ts';
import { formatINR } from './format.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import {
  buildingCount,
  computeRent,
  incomeTaxDue,
  loansWithInterestDue,
  loanTerms,
  mortgageResolution,
  netWorth,
  outstandingPrincipal,
  propertyActionBlocker,
  sellBuildingRefund,
  topUndoable,
  tradeBlocker,
  undoBlocker,
  unmortgageCost,
  wealthTaxDue,
  type PropertyActionKind,
} from './selectors.ts';
import type {
  EngineContext,
  EngineResult,
  FollowUp,
  GameState,
  PaymentReason,
  Pending,
  PlayerState,
  PropertyState,
  TradeOffer,
  TransactionRecord,
  TurnState,
} from './types.ts';

// ---------------------------------------------------------------------------
// Creation & lobby
// ---------------------------------------------------------------------------

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function freshTurn(): TurnState {
  return {
    phase: 'AWAITING_ROLL',
    playerId: null,
    number: 0,
    roll: null,
    hasRolled: false,
    fromPosition: null,
    toPosition: null,
    passedStart: false,
    pending: null,
    followUp: null,
    card: null,
    consecutiveDoubles: 0,
  };
}

function newPlayer(id: string, name: string, seat: number, isHost: boolean): PlayerState {
  return { id, name, seat, isHost, ready: isHost, balance: 0, position: 0, status: 'ACTIVE', skipTurns: 0, inJail: false, jailTurnsLeft: 0, circuits: 0 };
}

export function createGame(
  input: { gameId: string; code: string; hostPlayerId: string; hostName: string },
  ctx: EngineContext,
): EngineResult {
  const name = PlayerNameSchema.safeParse(input.hostName);
  if (!name.success) fail('VALIDATION', name.error.issues[0]?.message ?? 'Invalid name.');
  const properties = Object.fromEntries(
    PROPERTY_KEYS.map((key): [PropertyKey, PropertyState] => [key, { key, ownerId: null, houses: 0, hotel: false, mortgaged: false }]),
  ) as Record<PropertyKey, PropertyState>;
  const state: GameState = {
    id: input.gameId,
    code: input.code,
    rulesVersion: RULES_VERSION,
    status: 'WAITING',
    pausedFrom: null,
    pausedAt: null,
    version: 1,
    hostPlayerId: input.hostPlayerId,
    winnerId: null,
    players: [newPlayer(input.hostPlayerId, name.data, 0, true)],
    properties,
    loans: [],
    auction: null,
    turn: freshTurn(),
    undoStack: [],
    undoRequest: null,
    trades: [],
    createdAt: ctx.now,
    expiresAt: addHours(ctx.now, RULES.session.ttlHours),
  };
  const d = new Draft(state, ctx);
  d.event('GAME_CREATED', input.hostPlayerId, `${name.data} created the game`);
  d.event('PLAYER_JOINED', input.hostPlayerId, `${name.data} joined`);
  return d.result();
}

export function joinGame(state: GameState, input: { playerId: string; name: string }, ctx: EngineContext): EngineResult {
  assertLoadable(state, ctx);
  if (state.status !== 'WAITING') fail('GAME_NOT_ACTIVE', 'This game has already started.');
  const name = PlayerNameSchema.safeParse(input.name);
  if (!name.success) fail('VALIDATION', name.error.issues[0]?.message ?? 'Invalid name.');
  if (state.players.length >= RULES.players.max) fail('GAME_FULL', `This game is full (${RULES.players.max} players).`);
  if (state.players.some((p) => p.name.toLowerCase() === name.data.toLowerCase())) {
    fail('NAME_TAKEN', 'Someone in this game already has that name.');
  }
  const d = new Draft(state, ctx);
  const seat = Math.max(-1, ...state.players.map((p) => p.seat)) + 1;
  d.state.players.push(newPlayer(input.playerId, name.data, seat, false));
  d.event('PLAYER_JOINED', input.playerId, `${name.data} joined`);
  bumpVersion(d);
  return d.result();
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

function assertLoadable(state: GameState, ctx: EngineContext): void {
  if (state.rulesVersion !== RULES_VERSION) {
    fail('GAME_EXPIRED', 'This game was created with an older version of the board. Start a new game.');
  }
  if (state.status !== 'FINISHED' && Date.parse(ctx.now) > Date.parse(state.expiresAt)) {
    fail('GAME_EXPIRED', 'This game has expired. Start a new one.');
  }
}

function bumpVersion(d: Draft): void {
  d.state.version += 1;
  d.state.expiresAt = addHours(d.ctx.now, RULES.session.ttlHours);
}

const TURN_ACTIONS = new Set<GameAction['type']>([
  'ROLL_DICE',
  'BUY_PROPERTY',
  'DECLINE_PROPERTY',
  'START_AUCTION',
  'PAY_RENT',
  'PAY_TAX',
  'PAY_CARD',
  'PAY_INTEREST',
  'PAY_CLUB',
  'PAY_JAIL_FINE',
  'STAY_IN_JAIL',
  'RESOLVE_CARD',
  'END_TURN',
  'DECLARE_BANKRUPTCY',
]);

/**
 * Apply one player action to the authoritative state.
 * Pure: returns a new state plus the transactions/events it produced. Throws GameError when invalid,
 * in which case nothing at all changes (the caller discards the draft).
 */
export function applyAction(state: GameState, actorId: string, rawAction: unknown, ctx: EngineContext): EngineResult {
  const parsed = GameActionSchema.safeParse(rawAction);
  if (!parsed.success) fail('VALIDATION', 'That action is not valid.');
  const action = parsed.data;

  if (!state.players.some((p) => p.id === actorId)) fail('FORBIDDEN', 'You are not in this game.');
  if (state.status === 'FINISHED') fail('GAME_FINISHED', 'This game has finished.');
  assertLoadable(state, ctx);

  if (state.status === 'WAITING') {
    if (action.type !== 'SET_READY' && action.type !== 'START_GAME') {
      fail('GAME_NOT_STARTED', 'The game has not started yet.');
    }
  } else if (state.status === 'PAUSED') {
    if (action.type !== 'RESUME_GAME' && action.type !== 'END_GAME') fail('GAME_PAUSED', 'Game is paused.');
  } else if (action.type === 'SET_READY' || action.type === 'START_GAME') {
    fail('INVALID_PHASE', 'The game has already started.');
  }

  const d = new Draft(state, ctx);
  const actor = d.player(actorId);
  if (state.status !== 'WAITING' && actor.status !== 'ACTIVE' && action.type !== 'END_GAME') {
    fail('FORBIDDEN', 'You are out of the game.');
  }
  if (TURN_ACTIONS.has(action.type) && state.turn.playerId !== actorId) {
    fail('NOT_YOUR_TURN', "It's not your turn.");
  }

  switch (action.type) {
    case 'SET_READY':
      actor.ready = action.ready;
      d.event('PLAYER_READY', actorId, `${actor.name} is ${action.ready ? 'ready' : 'not ready'}`, { ready: action.ready });
      break;
    case 'START_GAME':
      startGame(d, actor);
      break;
    case 'ROLL_DICE':
      rollDice(d, actor);
      break;
    case 'BUY_PROPERTY':
      buyProperty(d, actor);
      break;
    case 'DECLINE_PROPERTY':
    case 'START_AUCTION':
      declineProperty(d, actor);
      break;
    case 'PAY_RENT':
      payPending(d, actor, 'RENT');
      break;
    case 'PAY_TAX':
      payPending(d, actor, 'TAX');
      break;
    case 'PAY_CARD':
      payPending(d, actor, 'CARD');
      break;
    case 'PAY_INTEREST':
      payPending(d, actor, 'LOAN_INTEREST');
      break;
    case 'PAY_CLUB':
      payPending(d, actor, 'CLUB');
      break;
    case 'PAY_JAIL_FINE':
      payJailFine(d, actor);
      break;
    case 'STAY_IN_JAIL':
      stayInJail(d, actor);
      break;
    case 'RESOLVE_CARD':
      resolveManualCard(d, actor, action.resolution, action.amount ?? 0);
      break;
    case 'BUILD_HOUSE':
    case 'BUILD_HOTEL':
    case 'SELL_BUILDING':
    case 'SELL_PROPERTY':
    case 'MORTGAGE_PROPERTY':
    case 'UNMORTGAGE_PROPERTY':
      propertyAction(d, actor, action.propertyKey, action.type);
      break;
    case 'TRANSFER_MONEY':
      transferMoney(d, actor, action.toPlayerId, action.amount, action.memo);
      break;
    case 'REQUEST_LOAN':
      requestLoan(d, actor, action.amount);
      break;
    case 'REPAY_LOAN':
      repayLoan(d, actor, action.loanId, action.amount);
      break;
    case 'PLACE_BID':
      placeBid(d, actor, action.auctionId, action.amount);
      break;
    case 'PASS_AUCTION':
      passAuction(d, actor, action.auctionId);
      break;
    case 'CLOSE_AUCTION':
      closeAuction(d, action.auctionId);
      break;
    case 'END_TURN':
      endTurn(d, actor);
      break;
    case 'DECLARE_BANKRUPTCY':
      declareBankruptcy(d, actor);
      break;
    case 'CREATE_TRADE':
      createTrade(d, actor, action);
      break;
    case 'ACCEPT_TRADE':
      acceptTrade(d, actor, action.tradeId);
      break;
    case 'REJECT_TRADE':
    case 'CANCEL_TRADE':
      closeTrade(d, actor, action.tradeId, action.type === 'REJECT_TRADE' ? 'REJECTED' : 'CANCELLED');
      break;
    case 'REQUEST_UNDO':
      requestUndo(d, actor, action.targetActionId);
      break;
    case 'APPROVE_UNDO':
      approveUndo(d, actor, action.requestId);
      break;
    case 'REJECT_UNDO':
      rejectUndo(d, actor, action.requestId);
      break;
    case 'PAUSE_GAME':
      d.setStatus('PAUSED');
      d.state.pausedFrom = 'ACTIVE';
      d.state.pausedAt = ctx.now;
      d.event('GAME_PAUSED', actorId, `${actor.name} paused the game`);
      break;
    case 'RESUME_GAME':
      resumeGame(d, actor);
      break;
    case 'END_GAME':
      if (!actor.isHost || !RULES.endGame.hostMayEnd) fail('FORBIDDEN', 'Only the host can end the game.');
      finishGame(d, 'HOST_ENDED');
      break;
  }

  bumpVersion(d);
  return d.result();
}

// ---------------------------------------------------------------------------
// Start / turns / dice
// ---------------------------------------------------------------------------

function startGame(d: Draft, actor: PlayerState): void {
  if (!actor.isHost) fail('FORBIDDEN', 'Only the host can start the game.');
  if (d.state.players.length < RULES.players.min) {
    fail('NOT_ENOUGH_PLAYERS', `Need at least ${RULES.players.min} players to start.`);
  }
  d.setStatus('ACTIVE');
  const ordered = [...d.state.players].sort((a, b) => a.seat - b.seat);
  for (const p of ordered) {
    d.transfer({ type: 'STARTING_FUNDS', from: null, to: p.id, amount: RULES.startingCash, memo: 'Starting cash' });
  }
  const first = ordered[0];
  if (!first) fail('NOT_ENOUGH_PLAYERS', 'No players.');
  d.state.turn = { ...freshTurn(), playerId: first.id, number: 1 };
  d.event('GAME_STARTED', actor.id, `Game started! ${first.name} goes first`, { firstPlayerId: first.id });
}

export function rollDiceValues(random: () => number): number[] {
  const values: number[] = [];
  for (let i = 0; i < RULES.dice.count; i += 1) {
    const v = Math.floor(random() * RULES.dice.sides) + 1;
    values.push(Math.min(Math.max(v, 1), RULES.dice.sides));
  }
  return values;
}

function rollDice(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  if (turn.phase !== 'AWAITING_ROLL') fail('INVALID_PHASE', 'You have already rolled.');
  if (actor.inJail) fail('INVALID_PHASE', `You're in Jail — pay ${formatINR(RULES.jail.fine)} to leave, or stay this turn.`);
  const dice = rollDiceValues(d.ctx.random);
  const total = dice.reduce((a, b) => a + b, 0);
  const isDouble = dice.length > 1 && dice.every((v) => v === dice[0]);
  turn.roll = { dice, total, isDouble };
  turn.hasRolled = true;
  turn.consecutiveDoubles = isDouble ? turn.consecutiveDoubles + 1 : 0;
  turn.card = null;
  d.setPhase('MOVING');
  const move = movePlayer(d, actor, { steps: total, direction: 'FORWARD', collectStart: true });
  turn.fromPosition = move.from;
  turn.toPosition = move.to;
  d.event('DICE_ROLLED', actor.id, `${actor.name} rolled ${total} → ${spaceName(move.to)}`, {
    dice,
    total,
    from: move.from,
    to: move.to,
    destination: spaceName(move.to),
  });
  d.setPhase('RESOLVING');
  if (!settleDueInterest(d, actor, { kind: 'RESOLVE_LANDING', rollTotal: total, depth: 0 })) return;
  resolveLanding(d, actor, total, 0);
}

interface MoveOutcome {
  from: number;
  to: number;
  passedStart: boolean;
}

/**
 * THE movement function. Every legitimate move (dice, card "move to", card
 * "move n squares", forward or backward) goes through here.
 *
 * Start crossing is decided from the movement itself: a FORWARD move whose path
 * reaches index 0 (passes it or lands exactly on it) completes a circuit and
 * pays the Start reward. BACKWARD moves and direct moves (collectStart=false,
 * e.g. Go to Jail) never do. Merely being at index 0 pays nothing.
 *
 * A completed circuit is also the loan-interest checkpoint: interest that falls
 * due is queued on the draft and settled by settleDueInterest().
 */
function movePlayer(
  d: Draft,
  player: PlayerState,
  move: { steps: number; direction: MoveDirection; collectStart: boolean } | { to: number; direction: MoveDirection; collectStart: boolean },
): MoveOutcome {
  const from = player.position;
  const steps =
    'steps' in move
      ? Math.abs(move.steps)
      : move.direction === 'FORWARD'
        ? normalizePosition(move.to - from)
        : normalizePosition(from - move.to);
  const forward = move.direction === 'FORWARD';
  const to = normalizePosition(forward ? from + steps : from - steps);
  // Direct moves (collectStart = false) jump to the square without "passing" Start.
  const passedStart = move.collectStart && forward && steps > 0 && from + steps >= BOARD_SIZE;
  player.position = to;
  d.state.turn.passedStart = d.state.turn.passedStart || passedStart;
  if (passedStart) completeCircuit(d, player);
  return { from, to, passedStart };
}

function completeCircuit(d: Draft, player: PlayerState): void {
  player.circuits += 1;
  d.transfer({ type: 'START_REWARD', from: null, to: player.id, amount: RULES.start.passReward, memo: 'Passed Start' });
  d.event('PASSED_START', player.id, `${player.name} collected ${formatINR(RULES.start.passReward)} for passing Start`);
  for (const loan of loansWithInterestDue(d.state.loans, player.id, player.circuits)) {
    loan.interestCharges += 1;
    d.dueInterest.push({ loanId: loan.id, amount: loan.interestAmount });
    d.event('LOAN_INTEREST_DUE', player.id, `Loan interest of ${formatINR(loan.interestAmount)} is due`, {
      loanId: loan.id,
      amount: loan.interestAmount,
    });
  }
}

/**
 * Pays loan interest that fell due during this action's movement. If the
 * player can't afford it, the turn rests in AWAITING_PAYMENT (normal
 * insufficient-funds rules: raise money or declare bankruptcy) and `followUp`
 * continues the turn after payment. Returns true when the turn can continue now.
 */
function settleDueInterest(d: Draft, player: PlayerState, followUp: FollowUp | null): boolean {
  const due = d.dueInterest;
  if (due.length === 0) return true;
  d.dueInterest = [];
  const amount = due.reduce((s, x) => s + x.amount, 0);
  const loanIds = due.map((x) => x.loanId);
  if (player.balance >= amount) {
    payLoanInterest(d, player, amount, loanIds);
    return true;
  }
  d.state.turn.pending = {
    kind: 'PAYMENT',
    reason: 'LOAN_INTEREST',
    amount,
    toPlayerId: null,
    propertyKey: null,
    label: 'Loan interest',
    cardId: null,
    loanIds,
  };
  d.state.turn.followUp = followUp;
  d.setPhase('AWAITING_PAYMENT');
  return false;
}

function payLoanInterest(d: Draft, player: PlayerState, amount: number, loanIds: string[]): void {
  d.transfer({ type: 'LOAN_INTEREST', from: player.id, to: null, amount, memo: 'Loan interest (due at Start)' });
  let remaining = amount;
  for (const id of loanIds) {
    const loan = d.state.loans.find((l) => l.id === id);
    if (!loan) continue;
    const part = Math.min(remaining, loan.interestAmount);
    loan.interestPaid += part;
    remaining -= part;
  }
  d.event('LOAN_INTEREST_PAID', player.id, `${player.name} paid ${formatINR(amount)} loan interest`, { amount, loanIds });
}

function sendToJail(d: Draft, player: PlayerState): void {
  movePlayer(d, player, {
    to: positionOfSpecial('JAIL'),
    direction: 'FORWARD',
    collectStart: !RULES.cards.jailAndRestHouseMovesAreDirect,
  });
  player.inJail = true;
  player.jailTurnsLeft = RULES.jail.maxTurns;
  d.state.turn.toPosition = player.position;
  d.event('SENT_TO_JAIL', player.id, `${player.name} goes to Jail (up to ${RULES.jail.maxTurns} turns)`, {
    turnsLeft: player.jailTurnsLeft,
  });
}

/** In Jail, at the start of their turn: pay the fine to the bank and play this turn normally. */
function payJailFine(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  if (!actor.inJail) fail('INVALID_PHASE', "You're not in Jail.");
  if (turn.phase !== 'AWAITING_ROLL') fail('INVALID_PHASE', 'You can only leave Jail at the start of your turn.');
  if (actor.balance < RULES.jail.fine) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — leaving Jail costs ${formatINR(RULES.jail.fine)}.`);
  }
  d.transfer({ type: 'JAIL_FINE', from: actor.id, to: null, amount: RULES.jail.fine, memo: 'Left Jail early' });
  actor.inJail = false;
  actor.jailTurnsLeft = 0;
  d.event('JAIL_FINE_PAID', actor.id, `${actor.name} paid ${formatINR(RULES.jail.fine)} and left Jail`, { amount: RULES.jail.fine });
}

/** In Jail, at the start of their turn: miss this turn. The last missed turn releases them. */
function stayInJail(d: Draft, actor: PlayerState): void {
  if (!actor.inJail) fail('INVALID_PHASE', "You're not in Jail.");
  if (d.state.turn.phase !== 'AWAITING_ROLL') fail('INVALID_PHASE', 'You can only choose at the start of your turn.');
  actor.jailTurnsLeft -= 1;
  if (actor.jailTurnsLeft <= 0) {
    actor.jailTurnsLeft = 0;
    actor.inJail = false;
    d.event('JAIL_RELEASED', actor.id, `${actor.name} served ${RULES.jail.maxTurns} turns and is released from Jail`);
  } else {
    d.event('JAIL_STAYED', actor.id, `${actor.name} stays in Jail (${plural(actor.jailTurnsLeft, 'turn')} left)`, {
      turnsLeft: actor.jailTurnsLeft,
    });
  }
  advanceTurn(d, actor.id);
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * `player` collects `amount` from every other active player in one step. A
 * player who can't afford their share pays what they have (rules.cards
 * .collectFromEachShortfall) — no debt is created.
 */
function collectFromEachPlayer(
  d: Draft,
  player: PlayerState,
  amount: number,
  type: 'CARD_COLLECTION' | 'REST_HOUSE_COLLECTION',
  memo: string,
): TransactionRecord[] {
  const txs: TransactionRecord[] = [];
  for (const other of d.activePlayers()) {
    if (other.id === player.id) continue;
    const paid = Math.min(amount, other.balance);
    if (paid > 0) txs.push(d.transfer({ type, from: other.id, to: player.id, amount: paid, memo }));
    if (paid < amount) {
      const event = type === 'CARD_COLLECTION' ? 'CARD_SHORTFALL' : 'REST_HOUSE_SHORTFALL';
      d.event(event, other.id, `${other.name} could only pay ${formatINR(paid)} of ${formatINR(amount)}`);
    }
  }
  return txs;
}

function sendToRestHouse(d: Draft, player: PlayerState): void {
  movePlayer(d, player, {
    to: positionOfSpecial('REST_HOUSE'),
    direction: 'FORWARD',
    collectStart: !RULES.cards.jailAndRestHouseMovesAreDirect,
  });
  d.state.turn.toPosition = player.position;
  d.event('MOVED', player.id, `${player.name} goes to the Rest House`, { to: player.position });
}

function paymentPending(reason: PaymentReason, amount: number, label: string, extra: Partial<Extract<Pending, { kind: 'PAYMENT' }>> = {}): Pending {
  return { kind: 'PAYMENT', reason, amount, toPlayerId: null, propertyKey: null, label, cardId: null, ...extra };
}

function resolveLanding(d: Draft, player: PlayerState, rollTotal: number, depth: number): void {
  const turn = d.state.turn;
  const space = spaceAt(player.position);

  if (space.kind === 'PROPERTY') {
    const key = space.propertyKey;
    const prop = d.state.properties[key];
    const deed = getDeed(key);
    if (prop.ownerId === null) {
      turn.pending = { kind: 'BUY', propertyKey: key, price: deed.price };
      d.setPhase('AWAITING_DECISION');
      return;
    }
    if (prop.ownerId === player.id) {
      d.event('LANDED_OWN', player.id, `${player.name} landed on their own ${deed.name}`);
      d.setPhase('TURN_COMPLETE');
      return;
    }
    const rent = computeRent(d.state, key, rollTotal);
    if (rent <= 0) {
      d.event('NO_RENT', player.id, `${deed.name} is mortgaged — no rent`);
      d.setPhase('TURN_COMPLETE');
      return;
    }
    turn.pending = paymentPending('RENT', rent, `Rent for ${deed.name}`, { toPlayerId: prop.ownerId, propertyKey: key });
    d.setPhase('AWAITING_PAYMENT');
    return;
  }

  switch (space.type) {
    case 'START':
      d.setPhase('TURN_COMPLETE');
      return;
    case 'INCOME_TAX': {
      const tax = incomeTaxDue(d.state, player.id);
      requestTax(d, player, tax.amount, `${space.label} — ${plural(tax.properties, 'property', 'properties')} × ${formatINR(RULES.incomeTax.perProperty)}`);
      return;
    }
    case 'WEALTH_TAX': {
      const tax = wealthTaxDue(d.state, player.id);
      const parts = [
        ...(tax.houses ? [`${plural(tax.houses, 'house')} × ${formatINR(RULES.wealthTax.perHouse)}`] : []),
        ...(tax.hotels ? [`${plural(tax.hotels, 'hotel')} × ${formatINR(RULES.wealthTax.perHotel)}`] : []),
      ];
      requestTax(d, player, tax.amount, `${space.label} — ${parts.length ? parts.join(' + ') : 'no buildings'}`);
      return;
    }
    case 'CLUB':
      resolveClub(d, player);
      return;
    case 'JAIL':
      sendToJail(d, player);
      d.setPhase('TURN_COMPLETE');
      return;
    case 'REST_HOUSE': {
      const amount = RULES.restHouse.collectFromEachPlayer;
      const txs = collectFromEachPlayer(d, player, amount, 'REST_HOUSE_COLLECTION', 'Rest House');
      const total = txs.reduce((s, t) => s + t.amount, 0);
      player.skipTurns += RULES.restHouse.turnsSkippedOnLanding;
      d.event('REST_HOUSE', player.id, `${player.name} rests at the Rest House: collects ${formatINR(total)} and skips the next turn`, {
        collected: total,
      });
      if (txs.length) {
        recordUndoable(d, {
          actionType: 'REST_HOUSE',
          actorId: player.id,
          description: `${player.name} collected ${formatINR(total)} at the Rest House`,
          transactions: txs,
        });
      }
      d.setPhase('TURN_COMPLETE');
      return;
    }
    case 'CHANCE':
    case 'COMMUNITY_CHEST':
      resolveCard(d, player, space.type, rollTotal, depth);
      return;
  }
}

/** Income Tax / Wealth Taxes: the amount is computed from the authoritative state at landing; nothing to pay → nothing happens. */
function requestTax(d: Draft, player: PlayerState, amount: number, label: string): void {
  if (amount <= 0) {
    d.event('TAX_NONE', player.id, `${label}: nothing to pay`);
    d.setPhase('TURN_COMPLETE');
    return;
  }
  d.state.turn.pending = paymentPending('TAX', amount, label);
  d.setPhase('AWAITING_PAYMENT');
}

/** Club: pay a fixed amount to every other active player (one PAY_CLUB, all transfers atomic). */
function resolveClub(d: Draft, player: PlayerState): void {
  const amount = RULES.club.payEachPlayer;
  const others = d.activePlayers().filter((p) => p.id !== player.id);
  if (others.length === 0) {
    d.setPhase('TURN_COMPLETE');
    return;
  }
  d.state.turn.pending = paymentPending('CLUB', amount * others.length, `Club — ${formatINR(amount)} to each player`, {
    payeeIds: others.map((p) => p.id),
  });
  d.setPhase('AWAITING_PAYMENT');
}

/**
 * Resolves a Chance / Community Chest card as ONE atomic step of the action:
 * the dice total picks the EVEN/ODD table and the entry; every effect is applied
 * in card order (movement through movePlayer, so Start reward + loan interest
 * apply); then loan interest is settled; then any money owed is requested, or
 * the destination square is resolved.
 */
function resolveCard(d: Draft, player: PlayerState, deck: Deck, rollTotal: number, depth: number, override?: CardDefinition): void {
  const turn = d.state.turn;
  const card: CardDefinition = override ?? findCard(deck, rollTotal);
  turn.card = { cardId: card.id, deck, table: card.table, rollTotal, text: card.text, verified: card.verified };
  const cardMessage = card.verified ? card.text : 'check the physical card';
  d.event('CARD_DRAWN', player.id, `${DECK_LABELS[deck]} (${card.table.toLowerCase()} ${rollTotal}): ${cardMessage}`, {
    cardId: card.id,
    deck,
    table: card.table,
    rollTotal,
    verified: card.verified,
  });

  const txStart = d.transactions.length;
  const cardTxIds = new Set<string>();
  const track = (tx: TransactionRecord) => cardTxIds.add(tx.id);
  let payment = 0;
  let payEach = 0;
  let landing = false;
  for (const effect of card.effects) {
    switch (effect.type) {
      case 'MANUAL':
        turn.pending = { kind: 'CARD_MANUAL', cardId: card.id, deck, rollTotal };
        d.setPhase('AWAITING_CARD');
        return;
      case 'PAY_BANK':
        payment += effect.amount;
        break;
      case 'PAY_PER_BUILDING': {
        const { houses, hotels } = buildingCount(d.state, player.id);
        payment += houses * effect.perHouse + hotels * effect.perHotel;
        break;
      }
      case 'RECEIVE_FROM_BANK':
        track(d.transfer({ type: 'CARD_REWARD', from: null, to: player.id, amount: effect.amount, memo: card.text }));
        break;
      case 'COLLECT_FROM_EACH_PLAYER':
        collectFromEachPlayer(d, player, effect.amount, 'CARD_COLLECTION', card.text).forEach(track);
        break;
      case 'PAY_EACH_PLAYER':
        payEach += effect.amount;
        break;
      case 'GO_TO_JAIL':
        d.setPhase('MOVING');
        sendToJail(d, player);
        d.setPhase('RESOLVING');
        break;
      case 'GO_TO_REST_HOUSE':
        d.setPhase('MOVING');
        sendToRestHouse(d, player);
        d.setPhase('RESOLVING');
        break;
      case 'SKIP_TURNS':
        player.skipTurns += effect.count;
        break;
      case 'MOVE_TO':
      case 'MOVE_STEPS': {
        d.setPhase('MOVING');
        const move =
          effect.type === 'MOVE_TO'
            ? movePlayer(d, player, { to: positionOfSquare(effect.target), direction: effect.direction, collectStart: true })
            : movePlayer(d, player, { steps: effect.steps, direction: effect.steps < 0 ? 'BACKWARD' : 'FORWARD', collectStart: true });
        turn.toPosition = move.to;
        d.event('MOVED', player.id, `${player.name} moves to ${spaceName(move.to)}`, {
          from: move.from,
          to: move.to,
          passedStart: move.passedStart,
        });
        d.setPhase('RESOLVING');
        if (effect.resolveLanding) landing = true;
        break;
      }
    }
  }

  // Automatic card money (rewards, birthday) is undoable as one entry.
  const cardTx = d.transactions.slice(txStart).filter((t) => cardTxIds.has(t.id));
  if (cardTx.length) recordUndoable(d, { actionType: 'CARD_EFFECT', actorId: player.id, description: `${DECK_LABELS[deck]}: ${card.text}`, transactions: cardTx });

  const others = d.activePlayers().filter((p) => p.id !== player.id);
  if (payEach > 0 && others.length > 0) {
    if (payment > 0) fail('INVALID_PHASE', 'A card cannot charge both the bank and every player.');
    payment = payEach * others.length;
  }
  if (payment > 0) {
    if (landing) fail('INVALID_PHASE', 'A card cannot both move to a square and charge money.');
    const cardPayment: Pending = paymentPending('CARD', payment, card.text, {
      cardId: card.id,
      ...(payEach > 0 ? { payeeIds: others.map((p) => p.id) } : {}),
    });
    // Loan interest due from this card's movement is settled first; the card payment follows.
    if (!settleDueInterest(d, player, { kind: 'PAYMENT', pending: cardPayment })) return;
    turn.pending = cardPayment;
    d.setPhase('AWAITING_PAYMENT');
    return;
  }
  if (card.effects.some((e) => e.type === 'PAY_PER_BUILDING')) {
    d.event('CARD_NOTHING_TO_PAY', player.id, `${player.name} has no buildings — nothing to pay`);
  }
  if (landing && depth < 2) {
    if (!settleDueInterest(d, player, { kind: 'RESOLVE_LANDING', rollTotal, depth: depth + 1 })) return;
    resolveLanding(d, player, rollTotal, depth + 1);
    return;
  }
  if (!settleDueInterest(d, player, null)) return;
  d.setPhase('TURN_COMPLETE');
}

/**
 * Resolves an arbitrary card definition for the current player as if they had
 * just landed on its deck's square with `rollTotal`. NOT reachable through the
 * action API (GameActionSchema has no such action) — it exists so engine tests
 * can exercise card effects (e.g. backward movement) that no physical card uses.
 */
export function applyCardDefinition(state: GameState, card: CardDefinition, rollTotal: number, ctx: EngineContext): EngineResult {
  const d = new Draft(state, ctx);
  const player = d.player(d.state.turn.playerId ?? '');
  d.state.turn.phase = 'RESOLVING';
  resolveCard(d, player, card.deck, rollTotal, 0, card);
  bumpVersion(d);
  return d.result();
}

function endTurn(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  if (turn.phase !== 'TURN_COMPLETE') {
    fail('INVALID_PHASE', turn.phase === 'AWAITING_ROLL' ? 'Roll the dice first.' : 'Finish your current action first.');
  }
  const extraRoll =
    RULES.dice.doublesGrantExtraRoll &&
    turn.roll?.isDouble === true &&
    !actor.inJail &&
    actor.skipTurns === 0 &&
    turn.consecutiveDoubles < RULES.dice.maxConsecutiveDoubles;
  d.state.auction = null;
  if (extraRoll) {
    d.setPhase('AWAITING_ROLL');
    d.state.turn = { ...freshTurn(), playerId: actor.id, number: turn.number + 1, consecutiveDoubles: turn.consecutiveDoubles };
    d.event('EXTRA_ROLL', actor.id, `Doubles! ${actor.name} rolls again`);
    return;
  }
  advanceTurn(d, actor.id);
}

/** Moves the turn to the next active player, consuming skipped turns. */
function advanceTurn(d: Draft, fromPlayerId: string): void {
  const seats = [...d.state.players].sort((a, b) => a.seat - b.seat);
  const startIndex = Math.max(
    0,
    seats.findIndex((p) => p.id === fromPlayerId),
  );
  const number = d.state.turn.number;
  d.setPhase('AWAITING_ROLL');
  let index = startIndex;
  for (let guard = 0; guard < 1000; guard += 1) {
    index = (index + 1) % seats.length;
    const candidate = seats[index];
    if (!candidate || candidate.status !== 'ACTIVE') continue;
    if (candidate.skipTurns > 0) {
      candidate.skipTurns -= 1;
      d.event('TURN_SKIPPED', candidate.id, `${candidate.name} skips a turn (Rest House)`);
      continue;
    }
    // A jailed player still gets their turn: they choose PAY_JAIL_FINE or STAY_IN_JAIL.
    d.state.turn = { ...freshTurn(), playerId: candidate.id, number: number + 1 };
    const jail = candidate.inJail ? ` — in Jail (${plural(candidate.jailTurnsLeft, 'turn')} left)` : '';
    d.event('TURN_STARTED', candidate.id, `${candidate.name}'s turn${jail}`, { turnNumber: number + 1 });
    return;
  }
  fail('INVALID_PHASE', 'Could not find the next player.');
}

// ---------------------------------------------------------------------------
// Buying, auctions
// ---------------------------------------------------------------------------

function buyProperty(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_DECISION' || pending?.kind !== 'BUY') {
    fail('INVALID_PHASE', 'There is no property to buy right now.');
  }
  const prop = d.state.properties[pending.propertyKey];
  if (prop.ownerId !== null) fail('ALREADY_OWNED', 'That property was already purchased.');
  const deed = getDeed(pending.propertyKey);
  if (actor.balance < deed.price) fail('INSUFFICIENT_FUNDS', 'Not enough money for this purchase.');
  const before = snapshotProps(d, [deed.key]);
  d.setPhase('TRANSACTION');
  d.transfer({
    type: 'PROPERTY_PURCHASE',
    from: actor.id,
    to: null,
    amount: deed.price,
    propertyKey: deed.key,
    memo: `Bought ${deed.name}`,
  });
  prop.ownerId = actor.id;
  turn.pending = null;
  d.event('PROPERTY_PURCHASED', actor.id, `${actor.name} bought ${deed.name} for ${formatINR(deed.price)}`, {
    propertyKey: deed.key,
  });
  recordUndoable(d, { actionType: 'BUY_PROPERTY', actorId: actor.id, description: `${actor.name} bought ${deed.name}`, propertyKey: deed.key, before });
  d.setPhase('TURN_COMPLETE');
}

function declineProperty(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_DECISION' || pending?.kind !== 'BUY') {
    fail('INVALID_PHASE', 'There is no property to decline right now.');
  }
  const deed = getDeed(pending.propertyKey);
  turn.pending = null;
  const participants = d
    .activePlayers()
    .filter((p) => RULES.auction.declinerMayBid || p.id !== actor.id)
    .map((p) => p.id);
  if (!RULES.auction.enabled || participants.length < 2) {
    d.event('PROPERTY_DECLINED', actor.id, `${actor.name} declined ${deed.name}`);
    d.setPhase('TURN_COMPLETE');
    return;
  }
  d.setPhase('AUCTION');
  d.state.auction = {
    id: d.ctx.newId(),
    propertyKey: deed.key,
    status: 'OPEN',
    highBid: null,
    highBidderId: null,
    minimumOpeningBid: RULES.auction.minimumOpeningBid,
    minimumIncrement: RULES.auction.minimumIncrement,
    endsAt: addSeconds(d.ctx.now, RULES.auction.openingTimerSeconds),
    participantIds: participants,
    passedIds: [],
    winnerId: null,
    createdAt: d.ctx.now,
    closedAt: null,
  };
  d.event('AUCTION_STARTED', actor.id, `${actor.name} declined ${deed.name} — auction started!`, {
    propertyKey: deed.key,
    auctionId: d.state.auction.id,
  });
}

function openAuction(d: Draft, auctionId: string) {
  const auction = d.state.auction;
  if (!auction || auction.id !== auctionId || d.state.turn.phase !== 'AUCTION') {
    fail('AUCTION_CLOSED', 'That auction is no longer running.');
  }
  if (auction.status !== 'OPEN') fail('AUCTION_CLOSED', 'That auction has finished.');
  return auction;
}

export function minimumNextBid(auction: { highBid: number | null; minimumOpeningBid: number; minimumIncrement: number }): number {
  return auction.highBid === null ? auction.minimumOpeningBid : auction.highBid + auction.minimumIncrement;
}

function placeBid(d: Draft, actor: PlayerState, auctionId: string, amount: number): void {
  const auction = openAuction(d, auctionId);
  if (!auction.participantIds.includes(actor.id)) fail('FORBIDDEN', "You're not in this auction.");
  if (auction.passedIds.includes(actor.id)) fail('INVALID_BID', 'You already passed on this auction.');
  if (Date.parse(d.ctx.now) > Date.parse(auction.endsAt)) fail('AUCTION_CLOSED', 'Bidding has ended.');
  if (auction.highBidderId === actor.id) fail('INVALID_BID', 'You already have the highest bid.');
  const min = minimumNextBid(auction);
  if (amount < min) fail('INVALID_BID', `Minimum bid is ${formatINR(min)}.`);
  if (amount > actor.balance) fail('INSUFFICIENT_FUNDS', "You can't bid more than your balance.");
  auction.highBid = amount;
  auction.highBidderId = actor.id;
  auction.endsAt = addSeconds(d.ctx.now, RULES.auction.bidTimerSeconds);
  d.bids.push({ id: d.ctx.newId(), auctionId, playerId: actor.id, amount, actionId: d.ctx.actionId, createdAt: d.ctx.now });
  d.event('BID_PLACED', actor.id, `${actor.name} bid ${formatINR(amount)}`, { auctionId, amount });
  const stillIn = auction.participantIds.filter((id) => id !== actor.id && !auction.passedIds.includes(id));
  if (stillIn.length === 0) finalizeAuction(d);
}

function passAuction(d: Draft, actor: PlayerState, auctionId: string): void {
  const auction = openAuction(d, auctionId);
  if (!auction.participantIds.includes(actor.id)) fail('FORBIDDEN', "You're not in this auction.");
  if (auction.passedIds.includes(actor.id)) fail('INVALID_BID', 'You already passed.');
  if (auction.highBidderId === actor.id) fail('INVALID_BID', 'You have the highest bid — you can’t pass.');
  auction.passedIds.push(actor.id);
  d.event('AUCTION_PASSED', actor.id, `${actor.name} passed`, { auctionId });
  const stillIn = auction.participantIds.filter((id) => !auction.passedIds.includes(id));
  if (auction.highBidderId !== null) {
    if (stillIn.length === 1 && stillIn[0] === auction.highBidderId) finalizeAuction(d);
  } else if (stillIn.length === 0) {
    finalizeAuction(d);
  }
}

function closeAuction(d: Draft, auctionId: string): void {
  const auction = openAuction(d, auctionId);
  if (Date.parse(d.ctx.now) < Date.parse(auction.endsAt)) fail('INVALID_PHASE', 'The auction is still running.');
  finalizeAuction(d);
}

function finalizeAuction(d: Draft): void {
  const auction = d.state.auction;
  if (!auction) return;
  const deed = getDeed(auction.propertyKey);
  auction.status = 'CLOSED';
  auction.closedAt = d.ctx.now;
  const winner = auction.highBidderId ? d.player(auction.highBidderId) : null;
  if (winner && auction.highBid !== null && winner.balance >= auction.highBid && winner.status === 'ACTIVE') {
    d.setPhase('TRANSACTION');
    d.transfer({
      type: 'AUCTION_PAYMENT',
      from: winner.id,
      to: null,
      amount: auction.highBid,
      propertyKey: deed.key,
      memo: `Won ${deed.name} at auction`,
    });
    d.state.properties[deed.key].ownerId = winner.id;
    auction.winnerId = winner.id;
    d.event('AUCTION_WON', winner.id, `${winner.name} won ${deed.name} for ${formatINR(auction.highBid)}`, {
      auctionId: auction.id,
      propertyKey: deed.key,
      amount: auction.highBid,
    });
  } else {
    const why = winner ? `${winner.name} couldn't pay` : 'no bids';
    d.event('AUCTION_UNSOLD', null, `${deed.name} stays with the bank (${why})`, { auctionId: auction.id });
  }
  d.setPhase('TURN_COMPLETE');
}

// ---------------------------------------------------------------------------
// Payments, cards, bankruptcy
// ---------------------------------------------------------------------------

const PAYMENT_TX = {
  RENT: 'RENT_PAYMENT',
  TAX: 'TAX_PAYMENT',
  CARD: 'CARD_PAYMENT',
  LOAN_INTEREST: 'LOAN_INTEREST',
  CLUB: 'CLUB_PAYMENT',
} as const;

function payPending(d: Draft, actor: PlayerState, reason: PaymentReason): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_PAYMENT' || pending?.kind !== 'PAYMENT' || pending.reason !== reason) {
    fail('INVALID_PHASE', 'There is nothing to pay right now.');
  }
  if (actor.balance < pending.amount) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — you need ${formatINR(pending.amount)}. Mortgage, sell or take a loan.`);
  }
  d.setPhase('TRANSACTION');
  if (reason === 'LOAN_INTEREST') {
    // Interest (+ any card payment folded into it) — not undoable: it is a loan obligation.
    payLoanInterest(d, actor, pending.amount, pending.loanIds ?? []);
  } else if (pending.payeeIds?.length) {
    const share = Math.floor(pending.amount / pending.payeeIds.length);
    for (const id of pending.payeeIds) {
      d.transfer({ type: PAYMENT_TX[reason], from: actor.id, to: id, amount: share, memo: pending.label });
    }
  } else {
    d.transfer({
      type: PAYMENT_TX[reason],
      from: actor.id,
      to: pending.toPlayerId,
      amount: pending.amount,
      propertyKey: pending.propertyKey,
      memo: pending.label,
    });
  }
  turn.pending = null;
  const to = pending.payeeIds?.length ? 'other players' : d.name(pending.toPlayerId);
  d.event('PAYMENT_MADE', actor.id, `${actor.name} paid ${formatINR(pending.amount)} to ${to} (${pending.label})`, {
    reason,
    amount: pending.amount,
    toPlayerId: pending.toPlayerId,
  });
  if (reason !== 'LOAN_INTEREST') {
    recordUndoable(d, {
      actionType: `PAY_${reason}`,
      actorId: actor.id,
      description: `${actor.name} paid ${formatINR(pending.amount)} to ${to}`,
      propertyKey: pending.propertyKey,
    });
  }
  continueAfterPayment(d, actor);
}

/** After an obligation is settled: resume deferred work (e.g. resolve the landing square) or finish the turn. */
function continueAfterPayment(d: Draft, actor: PlayerState): void {
  const followUp = d.state.turn.followUp;
  d.state.turn.followUp = null;
  if (followUp?.kind === 'RESOLVE_LANDING') {
    d.setPhase('RESOLVING');
    resolveLanding(d, actor, followUp.rollTotal, followUp.depth);
    return;
  }
  if (followUp?.kind === 'PAYMENT') {
    d.state.turn.pending = followUp.pending;
    d.setPhase('AWAITING_PAYMENT');
    return;
  }
  d.setPhase('TURN_COMPLETE');
}

function resolveManualCard(d: Draft, actor: PlayerState, resolution: 'PAY' | 'RECEIVE' | 'NONE', amount: number): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_CARD' || pending?.kind !== 'CARD_MANUAL') {
    fail('INVALID_PHASE', 'There is no card to resolve.');
  }
  const label = `${DECK_LABELS[pending.deck]} ${pending.rollTotal} (entered manually)`;
  if (resolution !== 'NONE') {
    if (!Number.isInteger(amount) || amount <= 0) fail('VALIDATION', 'Enter the amount shown on the card.');
    if (amount > RULES.cards.manualMaxAmount) {
      fail('VALIDATION', `Manual card amounts are limited to ${formatINR(RULES.cards.manualMaxAmount)}.`);
    }
  }
  turn.pending = null;
  if (resolution === 'NONE') {
    d.event('CARD_RESOLVED', actor.id, `${label}: no money effect`);
    d.setPhase('TURN_COMPLETE');
    return;
  }
  if (resolution === 'RECEIVE') {
    d.setPhase('TRANSACTION');
    d.transfer({ type: 'CARD_REWARD', from: null, to: actor.id, amount, memo: label });
    d.event('CARD_RESOLVED', actor.id, `${actor.name} received ${formatINR(amount)} (${label})`);
    recordUndoable(d, { actionType: 'CARD_EFFECT', actorId: actor.id, description: `${actor.name} received ${formatINR(amount)} (${label})` });
    d.setPhase('TURN_COMPLETE');
    return;
  }
  if (actor.balance >= amount) {
    d.setPhase('TRANSACTION');
    d.transfer({ type: 'CARD_PAYMENT', from: actor.id, to: null, amount, memo: label });
    d.event('CARD_RESOLVED', actor.id, `${actor.name} paid ${formatINR(amount)} (${label})`);
    recordUndoable(d, { actionType: 'PAY_CARD', actorId: actor.id, description: `${actor.name} paid ${formatINR(amount)} to Bank` });
    d.setPhase('TURN_COMPLETE');
    return;
  }
  turn.pending = paymentPending('CARD', amount, label, { cardId: pending.cardId });
  d.setPhase('AWAITING_PAYMENT');
}

function declareBankruptcy(d: Draft, actor: PlayerState): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_PAYMENT' || pending?.kind !== 'PAYMENT') {
    fail('INVALID_PHASE', 'You can only declare bankruptcy when you owe money.');
  }
  if (actor.balance >= pending.amount) fail('INVALID_PHASE', 'You can afford this payment.');
  if (actor.balance > 0) {
    d.transfer({
      type: 'BANKRUPTCY_SETTLEMENT',
      from: actor.id,
      to: pending.payeeIds?.length ? null : pending.toPlayerId,
      amount: actor.balance,
      memo: `Bankruptcy settlement (${pending.label})`,
    });
  }
  for (const key of PROPERTY_KEYS) {
    const prop = d.state.properties[key];
    if (prop.ownerId === actor.id) {
      prop.ownerId = null;
      prop.houses = 0;
      prop.hotel = false;
      prop.mortgaged = false;
    }
  }
  for (const loan of d.state.loans) {
    if (loan.playerId === actor.id && loan.status === 'ACTIVE') {
      loan.status = 'DEFAULTED';
      loan.closedAt = d.ctx.now;
    }
  }
  expireTrades(d, (t) => t.fromPlayerId === actor.id || t.toPlayerId === actor.id);
  // Ownership was reset wholesale: no earlier action can be compensated safely.
  d.state.undoStack = [];
  d.state.undoRequest = null;
  actor.status = 'BANKRUPT';
  actor.skipTurns = 0;
  actor.inJail = false;
  actor.jailTurnsLeft = 0;
  turn.pending = null;
  turn.followUp = null;
  d.event('PLAYER_BANKRUPT', actor.id, `${actor.name} is bankrupt`);
  d.setPhase('TURN_COMPLETE');
  if (RULES.endGame.lastPlayerStandingWins && d.activePlayers().length <= 1) {
    finishGame(d, 'LAST_PLAYER_STANDING');
    return;
  }
  d.state.auction = null;
  advanceTurn(d, actor.id);
}

function finishGame(d: Draft, reason: 'HOST_ENDED' | 'LAST_PLAYER_STANDING'): void {
  d.setStatus('FINISHED');
  d.state.pausedFrom = null;
  d.state.pausedAt = null;
  expireTrades(d, () => true);
  d.state.undoStack = [];
  d.state.undoRequest = null;
  const ranked = d
    .activePlayers()
    .map((p) => ({ p, worth: netWorth(d.state, p.id) }))
    .sort((a, b) => b.worth - a.worth);
  const winner = ranked[0]?.p ?? null;
  d.state.winnerId = winner?.id ?? null;
  d.event('GAME_FINISHED', null, winner ? `${winner.name} wins! 🏆` : 'Game over', {
    reason,
    winnerId: winner?.id ?? null,
    standings: ranked.map((r) => ({ playerId: r.p.id, netWorth: r.worth })),
  });
}

function resumeGame(d: Draft, actor: PlayerState): void {
  const pausedAt = d.state.pausedAt;
  d.setStatus('ACTIVE');
  d.state.pausedFrom = null;
  d.state.pausedAt = null;
  const auction = d.state.auction;
  if (auction && auction.status === 'OPEN' && pausedAt) {
    // Give back the time bidders lost while paused.
    const pausedMs = Math.max(0, Date.parse(d.ctx.now) - Date.parse(pausedAt));
    auction.endsAt = new Date(Date.parse(auction.endsAt) + pausedMs).toISOString();
  }
  d.event('GAME_RESUMED', actor.id, `${actor.name} resumed the game`);
}

// ---------------------------------------------------------------------------
// Property management, transfers, loans
// ---------------------------------------------------------------------------

function propertyAction(d: Draft, actor: PlayerState, key: PropertyKey, kind: PropertyActionKind): void {
  const blocker = propertyActionBlocker(d.state, actor.id, key, kind);
  if (blocker) {
    const code =
      blocker.startsWith('Not enough') ? 'INSUFFICIENT_FUNDS' : blocker.startsWith("You don't own") ? 'NOT_OWNER' : kind.includes('MORTGAGE') ? 'MORTGAGE_NOT_ALLOWED' : 'BUILD_NOT_ALLOWED';
    fail(code, blocker);
  }
  const prop = d.state.properties[key];
  const deed = getDeed(key);
  const before = snapshotProps(d, [key]);
  const undoable = (description: string) =>
    recordUndoable(d, { actionType: kind, actorId: actor.id, description, propertyKey: key, before });
  switch (kind) {
    case 'BUILD_HOUSE': {
      if (deed.kind !== 'CITY') return;
      d.transfer({ type: 'HOUSE_PURCHASE', from: actor.id, to: null, amount: deed.houseCost, propertyKey: key, memo: `House on ${deed.name}` });
      prop.houses += 1;
      d.event('HOUSE_BUILT', actor.id, `${actor.name} built a house on ${deed.name}`, { propertyKey: key, houses: prop.houses });
      undoable(`${actor.name} built a house on ${deed.name}`);
      return;
    }
    case 'BUILD_HOTEL': {
      if (deed.kind !== 'CITY') return;
      d.transfer({ type: 'HOTEL_PURCHASE', from: actor.id, to: null, amount: deed.hotelCost, propertyKey: key, memo: `Hotel on ${deed.name}` });
      prop.houses = 0;
      prop.hotel = true;
      d.event('HOTEL_BUILT', actor.id, `${actor.name} built a hotel on ${deed.name}`, { propertyKey: key });
      undoable(`${actor.name} built a hotel on ${deed.name}`);
      return;
    }
    case 'SELL_BUILDING': {
      const refund = sellBuildingRefund(key, prop);
      const wasHotel = prop.hotel;
      if (wasHotel) {
        prop.hotel = false;
        prop.houses = RULES.building.maxHouses;
      } else {
        prop.houses -= 1;
      }
      if (refund > 0) {
        d.transfer({
          type: wasHotel ? 'HOTEL_SALE' : 'HOUSE_SALE',
          from: null,
          to: actor.id,
          amount: refund,
          propertyKey: key,
          memo: `Sold ${wasHotel ? 'hotel' : 'house'} on ${deed.name}`,
        });
      }
      d.event('BUILDING_SOLD', actor.id, `${actor.name} sold a ${wasHotel ? 'hotel' : 'house'} on ${deed.name} for ${formatINR(refund)}`, {
        propertyKey: key,
      });
      undoable(`${actor.name} sold a ${wasHotel ? 'hotel' : 'house'} on ${deed.name}`);
      return;
    }
    case 'SELL_PROPERTY': {
      const amount = deed.mortgageValue;
      d.transfer({ type: 'PROPERTY_SALE', from: null, to: actor.id, amount, propertyKey: key, memo: `Sold ${deed.name} to the bank` });
      prop.ownerId = null;
      d.event('PROPERTY_SOLD', actor.id, `${actor.name} sold ${deed.name} to the bank for ${formatINR(amount)}`, { propertyKey: key });
      undoable(`${actor.name} sold ${deed.name} to the bank`);
      return;
    }
    case 'MORTGAGE_PROPERTY': {
      const m = mortgageResolution(prop);
      if (m.buildingValue > 0) {
        d.transfer({
          type: m.hotelReturned ? 'HOTEL_SALE' : 'HOUSE_SALE',
          from: null,
          to: actor.id,
          amount: m.buildingValue,
          propertyKey: key,
          memo: `Buildings on ${deed.name} returned to the bank (mortgage)`,
        });
      }
      d.transfer({ type: 'MORTGAGE', from: null, to: actor.id, amount: m.mortgageValue, propertyKey: key, memo: `Mortgaged ${deed.name}` });
      prop.houses = 0;
      prop.hotel = false;
      prop.mortgaged = true;
      const buildings = m.hotelReturned ? 'hotel' : m.housesReturned > 0 ? `${m.housesReturned} house${m.housesReturned > 1 ? 's' : ''}` : null;
      d.event(
        'PROPERTY_MORTGAGED',
        actor.id,
        `${actor.name} mortgaged ${deed.name} for ${formatINR(m.payout)}${buildings ? ` (incl. ${formatINR(m.buildingValue)} for the ${buildings})` : ''}`,
        { propertyKey: key, payout: m.payout, buildingValue: m.buildingValue, mortgageValue: m.mortgageValue },
      );
      undoable(`${actor.name} mortgaged ${deed.name}`);
      return;
    }
    case 'UNMORTGAGE_PROPERTY': {
      const cost = unmortgageCost(key);
      d.transfer({ type: 'UNMORTGAGE', from: actor.id, to: null, amount: cost, propertyKey: key, memo: `Unmortgaged ${deed.name}` });
      prop.mortgaged = false;
      d.event('PROPERTY_UNMORTGAGED', actor.id, `${actor.name} unmortgaged ${deed.name} for ${formatINR(cost)}`, { propertyKey: key });
      undoable(`${actor.name} unmortgaged ${deed.name}`);
      return;
    }
  }
}

function transferMoney(d: Draft, actor: PlayerState, toPlayerId: string, amount: number, memo?: string): void {
  if (toPlayerId === actor.id) fail('VALIDATION', 'Choose another player.');
  const to = d.state.players.find((p) => p.id === toPlayerId);
  if (!to || to.status !== 'ACTIVE') fail('NOT_FOUND', 'That player is not in the game.');
  if (amount > RULES.transfers.maxAmount) fail('VALIDATION', 'That amount is too large.');
  if (actor.balance < amount) fail('INSUFFICIENT_FUNDS', 'Not enough money for this payment.');
  const note = memo?.trim() || 'Payment';
  d.transfer({ type: 'PLAYER_TRANSFER', from: actor.id, to: to.id, amount, memo: note });
  d.event('MONEY_TRANSFERRED', actor.id, `${actor.name} paid ${to.name} ${formatINR(amount)}`, { toPlayerId: to.id, amount, memo: note });
  recordUndoable(d, { actionType: 'TRANSFER_MONEY', actorId: actor.id, description: `${actor.name} paid ${to.name} ${formatINR(amount)}` });
}

function requestLoan(d: Draft, actor: PlayerState, amount: number): void {
  const rules = RULES.loans;
  if (amount < rules.minAmount) fail('LOAN_NOT_ALLOWED', `Minimum loan is ${formatINR(rules.minAmount)}.`);
  if (amount % rules.step !== 0) fail('LOAN_NOT_ALLOWED', `Loans come in steps of ${formatINR(rules.step)}.`);
  const current = outstandingPrincipal(d.state.loans, actor.id);
  if (current + amount > rules.maxOutstandingPrincipal) {
    fail('LOAN_NOT_ALLOWED', `Loan limit is ${formatINR(rules.maxOutstandingPrincipal)}. You can borrow ${formatINR(Math.max(0, rules.maxOutstandingPrincipal - current))} more.`);
  }
  const terms = loanTerms(amount);
  const loan = {
    id: d.ctx.newId(),
    playerId: actor.id,
    principal: terms.principal,
    interestRatePercent: rules.interestRatePercent,
    interestAmount: terms.interest,
    totalOwed: terms.totalOwed,
    outstanding: terms.totalOwed,
    status: 'ACTIVE' as const,
    createdAtCircuit: actor.circuits,
    interestCharges: 0,
    interestPaid: 0,
    createdAt: d.ctx.now,
    closedAt: null,
  };
  d.state.loans.push(loan);
  d.transfer({ type: 'LOAN_DISBURSEMENT', from: null, to: actor.id, amount, memo: `Bank loan (${formatINR(terms.interest)} interest due at next Start)` });
  d.event('LOAN_TAKEN', actor.id, `${actor.name} borrowed ${formatINR(amount)} from the bank`, {
    loanId: loan.id,
    principal: amount,
    interestDueAtNextStart: terms.interest,
  });
}

function repayLoan(d: Draft, actor: PlayerState, loanId: string, amount: number): void {
  const loan = d.state.loans.find((l) => l.id === loanId);
  if (!loan || loan.playerId !== actor.id) fail('NOT_FOUND', 'Loan not found.');
  if (loan.status !== 'ACTIVE') fail('LOAN_NOT_ALLOWED', 'This loan is already closed.');
  if (amount > loan.outstanding) fail('VALIDATION', `You only owe ${formatINR(loan.outstanding)} on this loan.`);
  if (actor.balance < amount) fail('INSUFFICIENT_FUNDS', 'Not enough money to repay that much.');
  d.transfer({ type: 'LOAN_REPAYMENT', from: actor.id, to: null, amount, memo: 'Loan repayment' });
  loan.outstanding -= amount;
  if (loan.outstanding === 0) {
    loan.status = 'REPAID';
    loan.closedAt = d.ctx.now;
  }
  d.event('LOAN_REPAID', actor.id, `${actor.name} repaid ${formatINR(amount)}${loan.status === 'REPAID' ? ' — loan cleared!' : ''}`, {
    loanId,
    amount,
    outstanding: loan.outstanding,
  });
}

// ---------------------------------------------------------------------------
// Trades (player ↔ player; executed atomically on accept)
// ---------------------------------------------------------------------------

const KEEP_RESOLVED_TRADES = 20;

function pruneTrades(d: Draft): void {
  const resolved = d.state.trades.filter((t) => t.status !== 'PENDING');
  if (resolved.length <= KEEP_RESOLVED_TRADES) return;
  const drop = new Set(resolved.slice(0, resolved.length - KEEP_RESOLVED_TRADES).map((t) => t.id));
  d.state.trades = d.state.trades.filter((t) => !drop.has(t.id));
}

function describeTradeSide(keys: PropertyKey[], money: number): string {
  const parts = keys.map((k) => getDeed(k).name);
  if (money > 0) parts.push(formatINR(money));
  return parts.join(' + ');
}

function createTrade(d: Draft, actor: PlayerState, input: Extract<GameAction, { type: 'CREATE_TRADE' }>): void {
  if (d.state.trades.filter((t) => t.status === 'PENDING').length >= RULES.trades.maxPendingPerGame) {
    fail('TRADE_NOT_ALLOWED', 'Too many open trade offers. Answer some first.');
  }
  const trade: TradeOffer = {
    id: d.ctx.newId(),
    fromPlayerId: actor.id,
    toPlayerId: input.toPlayerId,
    offeredPropertyKeys: input.offeredPropertyKeys,
    requestedPropertyKeys: input.requestedPropertyKeys,
    offeredMoney: input.offeredMoney,
    requestedMoney: input.requestedMoney,
    status: 'PENDING',
    createdAt: d.ctx.now,
    resolvedAt: null,
  };
  const why = tradeBlocker(d.state, trade);
  if (why) fail('TRADE_NOT_ALLOWED', why);
  d.state.trades.push(trade);
  const to = d.player(trade.toPlayerId);
  d.event(
    'TRADE_OFFERED',
    actor.id,
    `${actor.name} offered ${to.name}: ${describeTradeSide(trade.offeredPropertyKeys, trade.offeredMoney)} ⇄ ${describeTradeSide(trade.requestedPropertyKeys, trade.requestedMoney)}`,
    { tradeId: trade.id, toPlayerId: to.id },
  );
}

function pendingTrade(d: Draft, tradeId: string): TradeOffer {
  const trade = d.state.trades.find((t) => t.id === tradeId);
  if (!trade) fail('NOT_FOUND', 'Trade offer not found.');
  if (trade.status !== 'PENDING') fail('TRADE_NOT_ALLOWED', `This offer was already ${trade.status.toLowerCase()}.`);
  return trade;
}

/**
 * Re-validates EVERYTHING against the current state (players, ownership,
 * buildings, mortgage rules, both players' cash) and then performs the whole
 * exchange inside this one action. Any failure throws before the draft is
 * committed, so either everything changes or nothing does.
 */
function acceptTrade(d: Draft, actor: PlayerState, tradeId: string): void {
  const trade = pendingTrade(d, tradeId);
  if (trade.toPlayerId !== actor.id) fail('FORBIDDEN', 'Only the player this offer was made to can accept it.');
  const why = tradeBlocker(d.state, trade);
  if (why) fail('TRADE_NOT_ALLOWED', `Trade can't go through: ${why}`);
  const from = d.player(trade.fromPlayerId);
  const keys = [...trade.offeredPropertyKeys, ...trade.requestedPropertyKeys];
  const before = snapshotProps(d, keys);
  const label = `Trade ${from.name} ⇄ ${actor.name}`;
  if (trade.offeredMoney > 0) d.transfer({ type: 'TRADE_PAYMENT', from: from.id, to: actor.id, amount: trade.offeredMoney, memo: label });
  if (trade.requestedMoney > 0) d.transfer({ type: 'TRADE_PAYMENT', from: actor.id, to: from.id, amount: trade.requestedMoney, memo: label });
  for (const key of trade.offeredPropertyKeys) d.state.properties[key].ownerId = actor.id;
  for (const key of trade.requestedPropertyKeys) d.state.properties[key].ownerId = from.id;
  trade.status = 'ACCEPTED';
  trade.resolvedAt = d.ctx.now;
  const summary = `${from.name} gave ${describeTradeSide(trade.offeredPropertyKeys, trade.offeredMoney)} for ${describeTradeSide(trade.requestedPropertyKeys, trade.requestedMoney)}`;
  d.event('TRADE_ACCEPTED', actor.id, `${actor.name} accepted: ${summary}`, {
    tradeId: trade.id,
    fromPlayerId: from.id,
    toPlayerId: actor.id,
    offeredPropertyKeys: trade.offeredPropertyKeys,
    requestedPropertyKeys: trade.requestedPropertyKeys,
    offeredMoney: trade.offeredMoney,
    requestedMoney: trade.requestedMoney,
  });
  recordUndoable(d, { actionType: 'ACCEPT_TRADE', actorId: actor.id, description: `Trade: ${summary}`, before });
  pruneTrades(d);
}

function closeTrade(d: Draft, actor: PlayerState, tradeId: string, status: 'REJECTED' | 'CANCELLED'): void {
  const trade = pendingTrade(d, tradeId);
  if (status === 'REJECTED' && trade.toPlayerId !== actor.id) fail('FORBIDDEN', 'Only the player this offer was made to can reject it.');
  if (status === 'CANCELLED' && trade.fromPlayerId !== actor.id) fail('FORBIDDEN', 'Only the player who made the offer can cancel it.');
  trade.status = status;
  trade.resolvedAt = d.ctx.now;
  d.event(status === 'REJECTED' ? 'TRADE_REJECTED' : 'TRADE_CANCELLED', actor.id, `${actor.name} ${status.toLowerCase()} a trade offer`, {
    tradeId,
  });
  pruneTrades(d);
}

function expireTrades(d: Draft, match: (t: TradeOffer) => boolean): void {
  for (const t of d.state.trades) {
    if (t.status === 'PENDING' && match(t)) {
      t.status = 'EXPIRED';
      t.resolvedAt = d.ctx.now;
    }
  }
}

// ---------------------------------------------------------------------------
// Undo history (compensating transactions only — history is never rewritten)
// ---------------------------------------------------------------------------

function snapshotProps(d: Draft, keys: readonly PropertyKey[]): PropertyState[] {
  return keys.map((k) => ({ ...d.state.properties[k] }));
}

/**
 * Pushes an undo entry for the current action. `transactions` defaults to every
 * transaction of this action; `before` = property state before the action (the
 * matching "after" is captured now).
 */
function recordUndoable(
  d: Draft,
  input: {
    actionType: string;
    actorId: string;
    description: string;
    propertyKey?: PropertyKey | null;
    before?: PropertyState[];
    transactions?: TransactionRecord[];
  },
): void {
  const txs = input.transactions ?? d.transactions;
  const moves = txs.map((t) => ({ transactionId: t.id, fromPlayerId: t.fromPlayerId, toPlayerId: t.toPlayerId, amount: t.amount }));
  const before = input.before ?? [];
  const after = snapshotProps(
    d,
    before.map((p) => p.key),
  );
  const counterparties = new Set<string>();
  for (const m of moves) {
    for (const pid of [m.fromPlayerId, m.toPlayerId]) if (pid && pid !== input.actorId) counterparties.add(pid);
  }
  for (const p of [...before, ...after]) if (p.ownerId && p.ownerId !== input.actorId) counterparties.add(p.ownerId);
  d.state.undoStack.push({
    actionId: d.ctx.actionId,
    actionType: input.actionType,
    actorId: input.actorId,
    description: input.description,
    transactionIds: moves.map((m) => m.transactionId),
    moves,
    propertyKey: input.propertyKey ?? null,
    propertiesBefore: before,
    propertiesAfter: after,
    counterpartyIds: [...counterparties],
    createdAt: d.ctx.now,
  });
  if (d.state.undoStack.length > RULES.undo.maxDepth) d.state.undoStack.splice(0, d.state.undoStack.length - RULES.undo.maxDepth);
  // A waiting request targeted an entry that is no longer the newest.
  d.state.undoRequest = null;
}

function requestUndo(d: Draft, actor: PlayerState, targetActionId: string): void {
  const top = topUndoable(d.state);
  if (!top || top.actionId !== targetActionId) {
    fail('UNDO_NOT_ALLOWED', d.state.undoStack.some((r) => r.actionId === targetActionId) ? 'Undo newer actions first.' : 'That action can no longer be undone.');
  }
  const involved = [top.actorId, ...top.counterpartyIds];
  if (!involved.includes(actor.id)) fail('FORBIDDEN', 'Only players involved can ask to undo this.');
  const blocked = undoBlocker(d.state, top);
  if (blocked) fail('UNDO_NOT_ALLOWED', blocked);
  const pendingReq = d.state.undoRequest;
  if (pendingReq && pendingReq.targetActionId === targetActionId) fail('UNDO_NOT_ALLOWED', 'An undo request is already waiting.');
  const activeIds = new Set(d.activePlayers().map((p) => p.id));
  let approvers = involved.filter((id) => id !== actor.id && activeIds.has(id));
  if (approvers.length === 0) approvers = [...activeIds].filter((id) => id !== actor.id);
  if (approvers.length === 0) fail('UNDO_NOT_ALLOWED', 'Nobody is available to approve.');
  d.state.undoRequest = {
    id: d.ctx.newId(),
    targetActionId,
    requestedBy: actor.id,
    description: top.description,
    approverIds: approvers,
    createdAt: d.ctx.now,
  };
  d.event('UNDO_REQUESTED', actor.id, `${actor.name} asked to undo: ${top.description}`, { targetActionId });
}

/**
 * Applies the newest undo entry: verifies it was not superseded, restores the
 * properties it changed, and posts compensating UNDO_REVERSAL transactions in
 * reverse order. Never rolls dice, never moves tokens, never deletes history.
 */
function approveUndo(d: Draft, actor: PlayerState, requestId: string): void {
  const req = d.state.undoRequest;
  if (!req || req.id !== requestId) fail('UNDO_NOT_ALLOWED', 'That undo request is no longer open.');
  if (!req.approverIds.includes(actor.id)) fail('FORBIDDEN', 'Another player needs to approve this.');
  const top = topUndoable(d.state);
  if (!top || top.actionId !== req.targetActionId) {
    fail('UNDO_NOT_ALLOWED', 'Too late to undo — something else happened since.');
  }
  const blocked = undoBlocker(d.state, top);
  if (blocked) fail('UNDO_NOT_ALLOWED', blocked);

  for (const before of top.propertiesBefore) d.state.properties[before.key] = { ...before };

  for (const move of [...top.moves].reverse()) {
    try {
      d.transfer({
        type: 'UNDO_REVERSAL',
        from: move.toPlayerId,
        to: move.fromPlayerId,
        amount: move.amount,
        memo: `Undo: ${top.description}`,
        reversesTransactionId: move.transactionId,
      });
    } catch (error) {
      if (error instanceof GameError && error.code === 'INSUFFICIENT_FUNDS') {
        fail('INSUFFICIENT_FUNDS', `${d.name(move.toPlayerId)} doesn't have enough money to reverse this.`);
      }
      throw error;
    }
  }
  d.state.undoStack.pop();
  d.state.undoRequest = null;
  d.event('UNDO_APPLIED', actor.id, `Undone: ${top.description} (approved by ${actor.name})`, { targetActionId: top.actionId });
}

function rejectUndo(d: Draft, actor: PlayerState, requestId: string): void {
  const req = d.state.undoRequest;
  if (!req || req.id !== requestId) fail('UNDO_NOT_ALLOWED', 'That undo request is no longer open.');
  if (!req.approverIds.includes(actor.id) && req.requestedBy !== actor.id) fail('FORBIDDEN', 'You can’t answer this request.');
  d.state.undoRequest = null;
  d.event('UNDO_REJECTED', actor.id, `${actor.name} ${req.requestedBy === actor.id ? 'cancelled' : 'rejected'} the undo request`);
}
