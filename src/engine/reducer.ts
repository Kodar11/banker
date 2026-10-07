import { GameActionSchema, PlayerNameSchema, type GameAction } from './actions.ts';
import {
  BOARD_SIZE,
  getDeed,
  positionOfSpecial,
  PROPERTY_KEYS,
  RULES_VERSION,
  spaceAt,
  spaceName,
  type PropertyKey,
} from './businessBoard.ts';
import { DECK_LABELS, findCard, type CardDefinition, type Deck } from './cards.ts';
import { Draft } from './draft.ts';
import { fail, GameError } from './errors.ts';
import { formatINR } from './format.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import {
  buildingCount,
  computeRent,
  loanTerms,
  netWorth,
  outstandingPrincipal,
  propertyActionBlocker,
  sellBuildingRefund,
  unmortgageCost,
  type PropertyActionKind,
} from './selectors.ts';
import type { EngineContext, EngineResult, GameState, PlayerState, PropertyState, TurnState } from './types.ts';

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
    card: null,
    consecutiveDoubles: 0,
  };
}

function newPlayer(id: string, name: string, seat: number, isHost: boolean): PlayerState {
  return { id, name, seat, isHost, ready: isHost, balance: 0, position: 0, status: 'ACTIVE', skipTurns: 0, inJail: false };
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
    lastUndoable: null,
    undoRequest: null,
    createdAt: ctx.now,
    expiresAt: addHours(ctx.now, RULES.session.ttlHours),
  };
  const d = new Draft(state, ctx);
  d.event('GAME_CREATED', input.hostPlayerId, `${name.data} created the game`);
  d.event('PLAYER_JOINED', input.hostPlayerId, `${name.data} joined`);
  return d.result();
}

export function joinGame(state: GameState, input: { playerId: string; name: string }, ctx: EngineContext): EngineResult {
  assertNotExpired(state, ctx);
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

function assertNotExpired(state: GameState, ctx: EngineContext): void {
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
  'RESOLVE_CARD',
  'END_TURN',
  'DECLARE_BANKRUPTCY',
]);

/**
 * Apply one player action to the authoritative state.
 * Pure: returns a new state plus the transactions/events it produced. Throws GameError when invalid.
 */
export function applyAction(state: GameState, actorId: string, rawAction: unknown, ctx: EngineContext): EngineResult {
  const parsed = GameActionSchema.safeParse(rawAction);
  if (!parsed.success) fail('VALIDATION', 'That action is not valid.');
  const action = parsed.data;

  if (!state.players.some((p) => p.id === actorId)) fail('FORBIDDEN', 'You are not in this game.');
  if (state.status === 'FINISHED') fail('GAME_FINISHED', 'This game has finished.');
  assertNotExpired(state, ctx);

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
  const dice = rollDiceValues(d.ctx.random);
  const total = dice.reduce((a, b) => a + b, 0);
  const isDouble = dice.length > 1 && dice.every((v) => v === dice[0]);
  turn.roll = { dice, total, isDouble };
  turn.hasRolled = true;
  turn.consecutiveDoubles = isDouble ? turn.consecutiveDoubles + 1 : 0;
  turn.card = null;
  d.setPhase('MOVING');
  const from = actor.position;
  const to = moveForward(d, actor, total, 'roll');
  turn.fromPosition = from;
  turn.toPosition = to;
  d.event('DICE_ROLLED', actor.id, `${actor.name} rolled ${total} → ${spaceName(to)}`, {
    dice,
    total,
    from,
    to,
    destination: spaceName(to),
  });
  d.setPhase('RESOLVING');
  resolveLanding(d, actor, total, 0);
}

/** Moves forward `steps` squares, paying the START reward if START is passed or landed on. */
function moveForward(d: Draft, player: PlayerState, steps: number, reason: 'roll' | 'card'): number {
  const from = player.position;
  const raw = from + steps;
  const to = raw % BOARD_SIZE;
  const passed = steps > 0 && raw >= BOARD_SIZE;
  player.position = to;
  d.state.turn.passedStart = passed;
  if (passed && (reason === 'roll' || RULES.cards.forwardMovePassesStart)) {
    d.transfer({ type: 'START_REWARD', from: null, to: player.id, amount: RULES.start.passReward, memo: 'Passed Start' });
    d.event('PASSED_START', player.id, `${player.name} collected ${formatINR(RULES.start.passReward)} for passing Start`);
  }
  return to;
}

function sendToJail(d: Draft, player: PlayerState): void {
  player.position = positionOfSpecial('JAIL');
  player.inJail = true;
  player.skipTurns += RULES.jail.turnsSkipped;
  d.state.turn.toPosition = player.position;
  d.event('SENT_TO_JAIL', player.id, `${player.name} goes to Jail`);
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
    turn.pending = {
      kind: 'PAYMENT',
      reason: 'RENT',
      amount: rent,
      toPlayerId: prop.ownerId,
      propertyKey: key,
      label: `Rent for ${deed.name}`,
      cardId: null,
    };
    d.setPhase('AWAITING_PAYMENT');
    return;
  }

  switch (space.type) {
    case 'START':
      d.setPhase('TURN_COMPLETE');
      return;
    case 'INCOME_TAX':
      turn.pending = {
        kind: 'PAYMENT',
        reason: 'TAX',
        amount: RULES.incomeTax.amount,
        toPlayerId: null,
        propertyKey: null,
        label: 'Income Tax',
        cardId: null,
      };
      d.setPhase('AWAITING_PAYMENT');
      return;
    case 'JAIL':
      if (RULES.jail.landingByRollSendsToJail) sendToJail(d, player);
      else d.event('JUST_VISITING', player.id, `${player.name} is just visiting Jail`);
      d.setPhase('TURN_COMPLETE');
      return;
    case 'REST_HOUSE':
      player.skipTurns += RULES.restHouse.turnsSkippedOnLanding;
      d.event('REST_HOUSE', player.id, `${player.name} rests — skips next turn`);
      d.setPhase('TURN_COMPLETE');
      return;
    case 'CHANCE':
    case 'COMMUNITY_CHEST':
      drawCard(d, player, space.type, rollTotal, depth);
      return;
  }
}

function drawCard(d: Draft, player: PlayerState, deck: Deck, rollTotal: number, depth: number): void {
  const turn = d.state.turn;
  const card: CardDefinition = findCard(deck, rollTotal);
  turn.card = { cardId: card.id, deck, rollTotal, text: card.text, verified: card.verified };
  d.event('CARD_DRAWN', player.id, `${DECK_LABELS[deck]} (${rollTotal}): ${card.text}`, {
    cardId: card.id,
    deck,
    rollTotal,
    verified: card.verified,
  });

  let payment = 0;
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
        d.transfer({ type: 'CARD_REWARD', from: null, to: player.id, amount: effect.amount, memo: card.text });
        break;
      case 'GO_TO_JAIL':
        sendToJail(d, player);
        break;
      case 'SKIP_TURNS':
        player.skipTurns += effect.count;
        break;
      case 'MOVE_TO': {
        if (effect.destination === 'JAIL') {
          sendToJail(d, player);
          break;
        }
        const target = positionOfSpecial(effect.destination);
        const steps = (target - player.position + BOARD_SIZE) % BOARD_SIZE;
        d.setPhase('MOVING');
        moveForward(d, player, steps, 'card');
        turn.toPosition = player.position;
        d.event('MOVED', player.id, `${player.name} moves to ${spaceName(player.position)}`, { to: player.position });
        d.setPhase('RESOLVING');
        if (effect.resolveLanding && depth < 2) {
          resolveLanding(d, player, rollTotal, depth + 1);
          return;
        }
        break;
      }
    }
  }

  if (payment > 0) {
    turn.pending = {
      kind: 'PAYMENT',
      reason: 'CARD',
      amount: payment,
      toPlayerId: null,
      propertyKey: null,
      label: card.text,
      cardId: card.id,
    };
    d.setPhase('AWAITING_PAYMENT');
    return;
  }
  if (card.effects.some((e) => e.type === 'PAY_PER_BUILDING')) {
    d.event('CARD_NOTHING_TO_PAY', player.id, `${player.name} has no buildings — nothing to pay`);
  }
  d.setPhase('TURN_COMPLETE');
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
      const where = candidate.inJail ? 'in Jail' : 'at the Rest House';
      if (candidate.skipTurns === 0) candidate.inJail = false;
      d.event('TURN_SKIPPED', candidate.id, `${candidate.name} skips a turn (${where})`);
      continue;
    }
    d.state.turn = { ...freshTurn(), playerId: candidate.id, number: number + 1 };
    d.event('TURN_STARTED', candidate.id, `${candidate.name}'s turn`, { turnNumber: number + 1 });
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
  recordUndoable(d, 'BUY_PROPERTY', actor.id, `${actor.name} bought ${deed.name}`, deed.key);
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

function payPending(d: Draft, actor: PlayerState, reason: 'RENT' | 'TAX' | 'CARD'): void {
  const turn = d.state.turn;
  const pending = turn.pending;
  if (turn.phase !== 'AWAITING_PAYMENT' || pending?.kind !== 'PAYMENT' || pending.reason !== reason) {
    fail('INVALID_PHASE', 'There is nothing to pay right now.');
  }
  if (actor.balance < pending.amount) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — you need ${formatINR(pending.amount)}. Mortgage, sell or take a loan.`);
  }
  const type = reason === 'RENT' ? 'RENT_PAYMENT' : reason === 'TAX' ? 'TAX_PAYMENT' : 'CARD_PAYMENT';
  d.setPhase('TRANSACTION');
  d.transfer({
    type,
    from: actor.id,
    to: pending.toPlayerId,
    amount: pending.amount,
    propertyKey: pending.propertyKey,
    memo: pending.label,
  });
  turn.pending = null;
  const to = d.name(pending.toPlayerId);
  d.event('PAYMENT_MADE', actor.id, `${actor.name} paid ${formatINR(pending.amount)} to ${to} (${pending.label})`, {
    reason,
    amount: pending.amount,
    toPlayerId: pending.toPlayerId,
  });
  recordUndoable(d, `PAY_${reason}`, actor.id, `${actor.name} paid ${formatINR(pending.amount)} to ${to}`, pending.propertyKey);
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
    d.setPhase('TURN_COMPLETE');
    return;
  }
  if (actor.balance >= amount) {
    d.setPhase('TRANSACTION');
    d.transfer({ type: 'CARD_PAYMENT', from: actor.id, to: null, amount, memo: label });
    d.event('CARD_RESOLVED', actor.id, `${actor.name} paid ${formatINR(amount)} (${label})`);
    recordUndoable(d, 'PAY_CARD', actor.id, `${actor.name} paid ${formatINR(amount)} to Bank`, null);
    d.setPhase('TURN_COMPLETE');
    return;
  }
  turn.pending = {
    kind: 'PAYMENT',
    reason: 'CARD',
    amount,
    toPlayerId: null,
    propertyKey: null,
    label,
    cardId: pending.cardId,
  };
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
      to: pending.toPlayerId,
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
  actor.status = 'BANKRUPT';
  actor.skipTurns = 0;
  actor.inJail = false;
  turn.pending = null;
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
  switch (kind) {
    case 'BUILD_HOUSE': {
      if (deed.kind !== 'CITY') return;
      d.transfer({ type: 'HOUSE_PURCHASE', from: actor.id, to: null, amount: deed.houseCost, propertyKey: key, memo: `House on ${deed.name}` });
      prop.houses += 1;
      d.event('HOUSE_BUILT', actor.id, `${actor.name} built a house on ${deed.name}`, { propertyKey: key, houses: prop.houses });
      recordUndoable(d, 'BUILD_HOUSE', actor.id, `${actor.name} built a house on ${deed.name}`, key);
      return;
    }
    case 'BUILD_HOTEL': {
      if (deed.kind !== 'CITY') return;
      d.transfer({ type: 'HOTEL_PURCHASE', from: actor.id, to: null, amount: deed.hotelCost, propertyKey: key, memo: `Hotel on ${deed.name}` });
      prop.houses = 0;
      prop.hotel = true;
      d.event('HOTEL_BUILT', actor.id, `${actor.name} built a hotel on ${deed.name}`, { propertyKey: key });
      recordUndoable(d, 'BUILD_HOTEL', actor.id, `${actor.name} built a hotel on ${deed.name}`, key);
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
      return;
    }
    case 'SELL_PROPERTY': {
      const amount = deed.mortgageValue;
      d.transfer({ type: 'PROPERTY_SALE', from: null, to: actor.id, amount, propertyKey: key, memo: `Sold ${deed.name} to the bank` });
      prop.ownerId = null;
      d.event('PROPERTY_SOLD', actor.id, `${actor.name} sold ${deed.name} to the bank for ${formatINR(amount)}`, { propertyKey: key });
      return;
    }
    case 'MORTGAGE_PROPERTY': {
      d.transfer({ type: 'MORTGAGE', from: null, to: actor.id, amount: deed.mortgageValue, propertyKey: key, memo: `Mortgaged ${deed.name}` });
      prop.mortgaged = true;
      d.event('PROPERTY_MORTGAGED', actor.id, `${actor.name} mortgaged ${deed.name} for ${formatINR(deed.mortgageValue)}`, {
        propertyKey: key,
      });
      return;
    }
    case 'UNMORTGAGE_PROPERTY': {
      const cost = unmortgageCost(key);
      d.transfer({ type: 'UNMORTGAGE', from: actor.id, to: null, amount: cost, propertyKey: key, memo: `Unmortgaged ${deed.name}` });
      prop.mortgaged = false;
      d.event('PROPERTY_UNMORTGAGED', actor.id, `${actor.name} unmortgaged ${deed.name} for ${formatINR(cost)}`, { propertyKey: key });
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
  recordUndoable(d, 'TRANSFER_MONEY', actor.id, `${actor.name} paid ${to.name} ${formatINR(amount)}`, null);
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
    totalOwed: terms.totalOwed,
    outstanding: terms.totalOwed,
    status: 'ACTIVE' as const,
    createdAt: d.ctx.now,
    closedAt: null,
  };
  d.state.loans.push(loan);
  d.transfer({ type: 'LOAN_DISBURSEMENT', from: null, to: actor.id, amount, memo: `Bank loan (${formatINR(terms.totalOwed)} to repay)` });
  d.event('LOAN_TAKEN', actor.id, `${actor.name} borrowed ${formatINR(amount)} from the bank`, {
    loanId: loan.id,
    principal: amount,
    totalOwed: terms.totalOwed,
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
// Undo (compensating transactions only — history is never rewritten)
// ---------------------------------------------------------------------------

function recordUndoable(d: Draft, actionType: string, actorId: string, description: string, propertyKey: PropertyKey | null): void {
  const moves = d.transactions.map((t) => ({ transactionId: t.id, fromPlayerId: t.fromPlayerId, toPlayerId: t.toPlayerId, amount: t.amount }));
  const counterparties = new Set<string>();
  for (const m of moves) {
    for (const pid of [m.fromPlayerId, m.toPlayerId]) if (pid && pid !== actorId) counterparties.add(pid);
  }
  d.state.lastUndoable = {
    actionId: d.ctx.actionId,
    actionType,
    actorId,
    description,
    transactionIds: moves.map((m) => m.transactionId),
    moves,
    propertyKey,
    counterpartyIds: [...counterparties],
  };
  d.state.undoRequest = null;
}

function requestUndo(d: Draft, actor: PlayerState, targetActionId: string): void {
  const last = d.state.lastUndoable;
  if (!last || last.actionId !== targetActionId) {
    fail('UNDO_NOT_ALLOWED', 'Only the most recent payment or purchase can be undone.');
  }
  const involved = [last.actorId, ...last.counterpartyIds];
  if (!involved.includes(actor.id)) fail('FORBIDDEN', 'Only players involved can ask to undo this.');
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
    description: last.description,
    approverIds: approvers,
    createdAt: d.ctx.now,
  };
  d.event('UNDO_REQUESTED', actor.id, `${actor.name} asked to undo: ${last.description}`, { targetActionId });
}

function approveUndo(d: Draft, actor: PlayerState, requestId: string): void {
  const req = d.state.undoRequest;
  if (!req || req.id !== requestId) fail('UNDO_NOT_ALLOWED', 'That undo request is no longer open.');
  if (!req.approverIds.includes(actor.id)) fail('FORBIDDEN', 'Another player needs to approve this.');
  const last = d.state.lastUndoable;
  if (!last || last.actionId !== req.targetActionId) {
    fail('UNDO_NOT_ALLOWED', 'Too late to undo — something else happened since.');
  }

  // Reverse property effects first (validates nothing changed since).
  if (last.propertyKey) {
    const prop = d.state.properties[last.propertyKey];
    if (last.actionType === 'BUY_PROPERTY') {
      if (prop.ownerId !== last.actorId || prop.houses > 0 || prop.hotel || prop.mortgaged) {
        fail('UNDO_NOT_ALLOWED', 'The property has changed since — can’t undo.');
      }
      prop.ownerId = null;
    } else if (last.actionType === 'BUILD_HOUSE') {
      if (prop.hotel || prop.houses === 0) fail('UNDO_NOT_ALLOWED', 'The buildings have changed since — can’t undo.');
      prop.houses -= 1;
    } else if (last.actionType === 'BUILD_HOTEL') {
      if (!prop.hotel) fail('UNDO_NOT_ALLOWED', 'The buildings have changed since — can’t undo.');
      prop.hotel = false;
      prop.houses = RULES.building.maxHouses;
    }
  }

  for (const move of [...last.moves].reverse()) {
    try {
      d.transfer({
        type: 'UNDO_REVERSAL',
        from: move.toPlayerId,
        to: move.fromPlayerId,
        amount: move.amount,
        memo: `Undo: ${last.description}`,
        reversesTransactionId: move.transactionId,
      });
    } catch (error) {
      if (error instanceof GameError && error.code === 'INSUFFICIENT_FUNDS') {
        fail('INSUFFICIENT_FUNDS', `${d.name(move.toPlayerId)} doesn't have enough money to reverse this.`);
      }
      throw error;
    }
  }
  d.state.lastUndoable = null;
  d.state.undoRequest = null;
  d.event('UNDO_APPLIED', actor.id, `Undone: ${last.description} (approved by ${actor.name})`, { targetActionId: last.actionId });
}

function rejectUndo(d: Draft, actor: PlayerState, requestId: string): void {
  const req = d.state.undoRequest;
  if (!req || req.id !== requestId) fail('UNDO_NOT_ALLOWED', 'That undo request is no longer open.');
  if (!req.approverIds.includes(actor.id) && req.requestedBy !== actor.id) fail('FORBIDDEN', 'You can’t answer this request.');
  d.state.undoRequest = null;
  d.event('UNDO_REJECTED', actor.id, `${actor.name} ${req.requestedBy === actor.id ? 'cancelled' : 'rejected'} the undo request`);
}
