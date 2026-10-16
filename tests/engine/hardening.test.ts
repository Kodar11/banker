import { describe, expect, it } from 'vitest';
import {
  applyAction,
  GameActionSchema,
  netWorth,
  RULES_VERSION,
  STALE_SENSITIVE_ACTIONS,
  type GameAction,
  type GameActionType,
  type GameState,
} from '@/engine/index.ts';
import { TestGame, testId } from './harness.ts';
import { stateViolations } from './invariantChecks.ts';

/** Every action type the engine accepts, read from the schema itself (so a new one cannot be forgotten here). */
const ALL_ACTIONS = GameActionSchema.options.map((option) => option.shape.type.value as GameActionType);

/**
 * The other half of STALE_SENSITIVE_ACTIONS: every action that is deliberately NOT refused when the
 * sender's screen is a version behind, with the reason. Each of these says in its own payload exactly
 * what it asks for (a property, an amount, an id of a trade/auction/loan/request), and the engine
 * judges it against the state as it is NOW — so an old screen cannot make it mean something else.
 * Requiring the exact version for them would refuse a player's build or transfer every time someone
 * else at the table did anything.
 */
const SELF_DESCRIBING: Record<string, string> = {
  SET_READY: 'sets my own flag to the value sent',
  UPDATE_CONFIG: 'replaces the settings with the ones sent; lobby and host only',
  SET_LOBBY_LOCK: 'sets the lock to the value sent',
  REMOVE_PLAYER: 'names the player; a repeat changes nothing',
  BUILD_HOUSE: 'names the property; fixed deed price; every rule re-checked',
  BUILD_HOTEL: 'names the property; fixed deed price; cannot happen twice',
  SELL_BUILDING: 'names the property; fixed refund',
  SELL_PROPERTY: 'names the property; fixed price; cannot happen twice',
  MORTGAGE_PROPERTY: 'names the property; fixed payout; cannot happen twice',
  UNMORTGAGE_PROPERTY: 'names the property; fixed cost; cannot happen twice',
  TRANSFER_MONEY: 'names the payee and the amount',
  REQUEST_LOAN: 'names the amount; fixed terms; limit re-checked',
  REPAY_LOAN: 'names the loan and the amount',
  TAKE_INTERMEDIATE_LOAN: 'carries the rate the player confirmed; refused if the offer changed',
  PAY_LOAN_INSTALLMENT: 'names the loan; pays the oldest installment due',
  PREPAY_INTERMEDIATE_LOAN: 'names the loan and the principal',
  REFINANCE_INTERMEDIATE_LOAN: 'names the loan; carries the rate the player confirmed; refused if the offer changed',
  PAY_DEFAULTED_LOAN: 'names the loan and the amount',
  INSURE_PROPERTY: 'carries the premium the player confirmed; refused if the price changed',
  INSURE_PROPERTIES: 'carries the premium the player confirmed; all or none',
  RENEW_INSURANCE: 'names the policy and carries the renewal premium the player confirmed; a policy is renewed once',
  PASS_AUCTION: 'names the auction; passing does not depend on the current bid',
  CLOSE_AUCTION: 'names the auction; the server decides by its own clock, exactly once',
  START_RESALE_AUCTION: 'names the property and the reserve price',
  CANCEL_AUCTION: 'names the auction; refused once anyone has bid',
  CREATE_TRADE: 'carries the whole offer; validated against the current state',
  ACCEPT_TRADE: 'names the offer, whose terms never change; an offer whose property changed is closed first',
  REJECT_TRADE: 'names the offer',
  CANCEL_TRADE: 'names the offer',
  REQUEST_UNDO: 'names the action to undo; only the newest one qualifies',
  REJECT_UNDO: 'names the request',
  PAUSE_GAME: 'no payload; pausing an already paused game is refused',
  RESUME_GAME: 'no payload',
  REQUEST_END_VOTE: 'no payload; judged against the state as it is: the table at rest, no vote open, once per player per financial year',
  CAST_END_VOTE: 'names the vote and the choice; one locked ballot per player',
  CLOSE_END_VOTE: 'names the vote; the server decides by its own clock, exactly once',
  LEAVE_GAME: 'no payload; a player who left cannot act again',
};

describe('stale-state classification covers every action', () => {
  it('each action is either version-checked or listed here with the reason it need not be', () => {
    const sensitive = [...STALE_SENSITIVE_ACTIONS];
    const relaxed = Object.keys(SELF_DESCRIBING);
    expect(sensitive.filter((t) => relaxed.includes(t))).toEqual([]);
    expect([...sensitive, ...relaxed].sort()).toEqual([...ALL_ACTIONS].sort());
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
  });

  it('everything whose meaning is "what my screen shows right now" is version-checked', () => {
    // The turn's own decisions, anything that pays "the amount shown", a bid against the bid shown, and approving the undo shown.
    for (const type of ['ROLL_DICE', 'BUY_PROPERTY', 'DECLINE_PROPERTY', 'START_AUCTION', 'PAY_RENT', 'PAY_TAX', 'PAY_CARD', 'PAY_INTEREST', 'PAY_CLUB', 'PAY_JAIL_FINE', 'STAY_IN_JAIL', 'RESOLVE_CARD', 'END_TURN', 'DECLARE_BANKRUPTCY', 'PLACE_BID', 'PAY_CRISIS_BILL', 'DECLARE_CRISIS_BANKRUPTCY', 'APPROVE_UNDO', 'START_GAME'] as const) {
      expect(STALE_SENSITIVE_ACTIONS.has(type)).toBe(true);
    }
  });
});

/** A valid example of every action, for "is it refused, and does it leave the state alone". */
function exampleOf(type: GameActionType, g: TestGame): GameAction {
  const other = g.id('Bilal');
  const id = testId();
  const examples: Partial<Record<GameActionType, GameAction>> = {
    SET_READY: { type: 'SET_READY', ready: true },
    UPDATE_CONFIG: { type: 'UPDATE_CONFIG', config: {} },
    SET_LOBBY_LOCK: { type: 'SET_LOBBY_LOCK', locked: true },
    REMOVE_PLAYER: { type: 'REMOVE_PLAYER', playerId: other },
    BUY_PROPERTY: { type: 'BUY_PROPERTY' },
    RESOLVE_CARD: { type: 'RESOLVE_CARD' },
    BUILD_HOUSE: { type: 'BUILD_HOUSE', propertyKey: 'RAILWAY' },
    BUILD_HOTEL: { type: 'BUILD_HOTEL', propertyKey: 'RAILWAY' },
    SELL_BUILDING: { type: 'SELL_BUILDING', propertyKey: 'RAILWAY' },
    SELL_PROPERTY: { type: 'SELL_PROPERTY', propertyKey: 'RAILWAY' },
    MORTGAGE_PROPERTY: { type: 'MORTGAGE_PROPERTY', propertyKey: 'RAILWAY' },
    UNMORTGAGE_PROPERTY: { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'RAILWAY' },
    TRANSFER_MONEY: { type: 'TRANSFER_MONEY', toPlayerId: other, amount: 100 },
    REQUEST_LOAN: { type: 'REQUEST_LOAN', amount: 1000 },
    REPAY_LOAN: { type: 'REPAY_LOAN', loanId: id, amount: 100 },
    TAKE_INTERMEDIATE_LOAN: { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 10000, expectedRatePercent: 12 },
    PAY_LOAN_INSTALLMENT: { type: 'PAY_LOAN_INSTALLMENT', loanId: id },
    PREPAY_INTERMEDIATE_LOAN: { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 500 },
    REFINANCE_INTERMEDIATE_LOAN: { type: 'REFINANCE_INTERMEDIATE_LOAN', loanId: id, product: 'PERSONAL', amount: 10000, expectedRatePercent: 12 },
    PAY_DEFAULTED_LOAN: { type: 'PAY_DEFAULTED_LOAN', loanId: id, amount: 500 },
    INSURE_PROPERTY: { type: 'INSURE_PROPERTY', propertyKey: 'RAILWAY', expectedPremium: 100 },
    INSURE_PROPERTIES: { type: 'INSURE_PROPERTIES', propertyKeys: ['RAILWAY'], expectedPremium: 100 },
    RENEW_INSURANCE: { type: 'RENEW_INSURANCE', policyId: id, expectedPremium: 100 },
    PAY_CRISIS_BILL: { type: 'PAY_CRISIS_BILL', crisisId: id },
    DECLARE_CRISIS_BANKRUPTCY: { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: id },
    PLACE_BID: { type: 'PLACE_BID', auctionId: id, amount: 500 },
    PASS_AUCTION: { type: 'PASS_AUCTION', auctionId: id },
    CLOSE_AUCTION: { type: 'CLOSE_AUCTION', auctionId: id },
    START_RESALE_AUCTION: { type: 'START_RESALE_AUCTION', propertyKey: 'RAILWAY', reservePrice: 1000 },
    CANCEL_AUCTION: { type: 'CANCEL_AUCTION', auctionId: id },
    CREATE_TRADE: { type: 'CREATE_TRADE', toPlayerId: other, offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 },
    ACCEPT_TRADE: { type: 'ACCEPT_TRADE', tradeId: id },
    REJECT_TRADE: { type: 'REJECT_TRADE', tradeId: id },
    CANCEL_TRADE: { type: 'CANCEL_TRADE', tradeId: id },
    REQUEST_UNDO: { type: 'REQUEST_UNDO', targetActionId: id },
    APPROVE_UNDO: { type: 'APPROVE_UNDO', requestId: id },
    REJECT_UNDO: { type: 'REJECT_UNDO', requestId: id },
    CAST_END_VOTE: { type: 'CAST_END_VOTE', voteId: id, choice: 'END' },
    CLOSE_END_VOTE: { type: 'CLOSE_END_VOTE', voteId: id },
  };
  return examples[type] ?? ({ type } as GameAction);
}

/** Applies an action that must be refused, and proves the refusal touched nothing. */
function refusal(g: TestGame, name: string, action: unknown): string {
  const before = JSON.stringify(g.state);
  let code = 'ACCEPTED';
  try {
    applyAction(g.state, g.id(name), action, g.ctx());
  } catch (error) {
    code = (error as { code?: string }).code ?? `THROWN ${String(error)}`;
  }
  expect(JSON.stringify(g.state)).toBe(before);
  return code;
}

describe('a finished game accepts nothing', () => {
  it('every action, from every player, is refused and changes nothing', () => {
    const g = new TestGame();
    g.endByVote('Asha');
    expect(g.state.status).toBe('FINISHED');
    for (const type of ALL_ACTIONS) {
      for (const name of ['Asha', 'Bilal', 'Chitra']) expect(`${type}: ${refusal(g, name, exampleOf(type, g))}`).toBe(`${type}: GAME_FINISHED`);
    }
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('a vote is never opened over unfinished business; once the table is at rest, ending charges nobody for an open offer', () => {
    const g = new TestGame();
    // Asha owns Railway and has offered it to Chitra; Bilal has landed on it and owes rent.
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 4000 });
    g.act('Asha', { type: 'END_TURN' });
    g.roll('Bilal', 1, 2);
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_PAYMENT', pending: { kind: 'PAYMENT', reason: 'RENT' } });
    // Not while rent is owed: refused, nothing changed, and the request is not used up.
    expect(refusal(g, 'Asha', { type: 'REQUEST_END_VOTE' })).toBe('VOTE_NOT_ALLOWED');
    g.act('Bilal', { type: 'PAY_RENT' });
    const balances = Object.fromEntries(g.state.players.map((p) => [p.name, p.balance]));
    const ended = g.endByVote('Asha');
    expect(g.state.status).toBe('FINISHED');
    expect(ended.transactions).toEqual([]);
    expect(Object.fromEntries(g.state.players.map((p) => [p.name, p.balance]))).toEqual(balances);
    expect(g.state.trades.map((t) => t.status)).toEqual(['EXPIRED']);
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Asha'));
    expect(refusal(g, 'Chitra', { type: 'ACCEPT_TRADE', tradeId: g.state.trades[0]!.id })).toBe('GAME_FINISHED');

    // Nor while the bank's auction is running — for the bidders or for the player who declined. The auction runs to its end first.
    const h = new TestGame();
    h.roll('Asha', 1, 2);
    h.act('Asha', { type: 'DECLINE_PROPERTY' });
    const auctionId = h.state.auction!.id;
    h.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 3000 });
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(refusal(h, name, { type: 'REQUEST_END_VOTE' })).toBe('VOTE_NOT_ALLOWED');
    h.advance(3600);
    h.act('Chitra', { type: 'CLOSE_AUCTION', auctionId });
    expect(h.state.properties.RAILWAY.ownerId).toBe(h.id('Bilal'));
    const over = h.endByVote('Asha');
    expect(over.transactions).toEqual([]);
    expect(h.balance('Bilal')).toBe(22000);
  });
});

describe('who wins', () => {
  it('level on net worth and liabilities: a shared victory, never the earlier seat; one rupee more decides it otherwise', () => {
    const tie = new TestGame();
    tie.endByVote('Asha');
    expect(tie.state.players.map((p) => netWorth(tie.state, p.id))).toEqual([25000, 25000, 25000]);
    expect(tie.state.winnerId).toBeNull();
    const finished = tie.results.at(-1)!.events.find((e) => e.type === 'GAME_FINISHED')!;
    expect(finished.payload).toMatchObject({ sharedVictory: true, winnerIds: ['Asha', 'Bilal', 'Chitra'].map((n) => tie.id(n)) });
    expect(finished.message).toBe('Asha, Bilal and Chitra share the victory! 🏆');
    // Listed in seat order for display only: they share first place.
    expect((finished.payload.standings as { playerId: string; rank: number }[]).map((s) => [s.playerId, s.rank])).toEqual(['Asha', 'Bilal', 'Chitra'].map((n) => [tie.id(n), 1]));

    const edge = new TestGame();
    edge.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: edge.id('Chitra'), amount: 1 });
    edge.endByVote('Asha');
    expect(edge.state.winnerId).toBe(edge.id('Chitra'));
  });

  it('a player who is out of the game never wins it, however much they hold', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    // Everyone pays Dev, who then walks away with the most money at the table.
    for (const name of ['Asha', 'Bilal', 'Chitra']) g.act(name, { type: 'TRANSFER_MONEY', toPlayerId: g.id('Dev'), amount: 10000 });
    const left = g.act('Dev', { type: 'LEAVE_GAME' });
    // Leaving takes the cash out of play — nobody inherits it, and it can't be ranked.
    expect(left.transactions.filter((t) => t.type === 'ESTATE_SETTLEMENT').map((t) => [t.fromPlayerId, t.toPlayerId, t.amount])).toEqual([[g.id('Dev'), null, 55000]]);
    expect(g.balance('Dev')).toBe(0);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 1 });
    g.endByVote('Asha');
    expect(g.state.winnerId).toBe(g.id('Bilal'));
    const finished = g.results.at(-1)!.events.find((e) => e.type === 'GAME_FINISHED')!;
    expect((finished.payload.standings as { playerId: string }[]).map((s) => s.playerId)).not.toContain(g.id('Dev'));
    // Nor can they act on it any more.
    const h = new TestGame(['Asha', 'Bilal', 'Chitra']);
    h.act('Chitra', { type: 'LEAVE_GAME' });
    for (const type of ALL_ACTIONS) expect(`${type}: ${refusal(h, 'Chitra', exampleOf(type, h))}`).toMatch(/: (FORBIDDEN|INVALID_PHASE|GAME_PAUSED)$/);
  });

  it('the last player standing wins the moment the other one is bankrupt, and the bankrupt player keeps nothing', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'RAILWAY');
    g.player('Bilal').balance = 0; // test surgery, mirrored in the ledger below
    g.ledger.push({ id: testId(), actionId: testId(), type: 'TAX_PAYMENT', fromPlayerId: g.id('Bilal'), toPlayerId: null, amount: 25000, propertyKey: null, memo: 'setup', reversesTransactionId: null, createdAt: g.ctx().now });
    // Asha lands on her own Railway: nothing to do but end the turn.
    g.roll('Asha', 1, 2);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    g.act('Asha', { type: 'END_TURN' });
    g.placeBefore('Bilal', 'RAILWAY', 3);
    g.roll('Bilal', 1, 2);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT' });
    g.act('Bilal', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: g.id('Asha') });
    expect(g.player('Bilal')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });
});

describe('actions out of turn, out of order, or malformed', () => {
  it('a player whose turn has ended cannot act on it again; the next player cannot be skipped', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'END_TURN' });
    expect(g.current).toBe('Bilal');
    for (const type of ['ROLL_DICE', 'BUY_PROPERTY', 'DECLINE_PROPERTY', 'START_AUCTION', 'PAY_RENT', 'PAY_TAX', 'PAY_CARD', 'PAY_INTEREST', 'PAY_CLUB', 'PAY_JAIL_FINE', 'STAY_IN_JAIL', 'END_TURN', 'DECLARE_BANKRUPTCY'] as const) {
      expect(`${type}: ${refusal(g, 'Asha', { type })}`).toBe(`${type}: NOT_YOUR_TURN`);
      expect(`${type}: ${refusal(g, 'Chitra', { type })}`).toBe(`${type}: NOT_YOUR_TURN`);
    }
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('NOT_YOUR_TURN');
  });

  it('the right player in the wrong order is refused step by step', () => {
    const g = new TestGame();
    // Before rolling: nothing to buy, pay or end.
    for (const type of ['BUY_PROPERTY', 'DECLINE_PROPERTY', 'PAY_RENT', 'PAY_TAX', 'PAY_CARD', 'PAY_CLUB', 'PAY_INTEREST', 'END_TURN', 'DECLARE_BANKRUPTCY', 'PAY_JAIL_FINE', 'STAY_IN_JAIL'] as const) {
      expect(`${type}: ${refusal(g, 'Asha', { type })}`).toBe(`${type}: INVALID_PHASE`);
    }
    g.roll('Asha', 1, 2);
    // A decision is waiting: no second roll, no ending the turn around it.
    for (const type of ['ROLL_DICE', 'END_TURN', 'PAY_RENT'] as const) expect(refusal(g, 'Asha', { type })).toBe('INVALID_PHASE');
    g.act('Asha', { type: 'BUY_PROPERTY' });
    for (const type of ['ROLL_DICE', 'BUY_PROPERTY', 'DECLINE_PROPERTY'] as const) expect(refusal(g, 'Asha', { type })).toBe('INVALID_PHASE');
    // Things that name something that does not exist.
    expect(refusal(g, 'Asha', { type: 'PLACE_BID', auctionId: testId(), amount: 500 })).toBe('AUCTION_CLOSED');
    expect(refusal(g, 'Asha', { type: 'ACCEPT_TRADE', tradeId: testId() })).toBe('NOT_FOUND');
    expect(refusal(g, 'Asha', { type: 'REPAY_LOAN', loanId: testId(), amount: 100 })).toBe('NOT_FOUND');
    expect(refusal(g, 'Asha', { type: 'APPROVE_UNDO', requestId: testId() })).toBe('UNDO_NOT_ALLOWED');
    expect(refusal(g, 'Bilal', { type: 'SELL_PROPERTY', propertyKey: 'RAILWAY' })).toBe('NOT_OWNER');
    // Capital Mode actions in a Classic game.
    expect(refusal(g, 'Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'RAILWAY', reservePrice: 1000 })).toBe('AUCTION_NOT_ALLOWED');
    expect(refusal(g, 'Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 1000, expectedRatePercent: 10 })).toBe('LOAN_NOT_ALLOWED');
    expect(refusal(g, 'Asha', { type: 'INSURE_PROPERTY', propertyKey: 'RAILWAY', expectedPremium: 100 })).toBe('INSURANCE_NOT_ALLOWED');
  });

  it('a malformed action never reaches the rules: wrong types, unknown fields, impossible amounts', () => {
    const g = new TestGame();
    const bad: unknown[] = [
      null,
      undefined,
      'ROLL_DICE',
      42,
      [],
      {},
      { type: 'CHEAT' },
      { type: 'ROLL_DICE', dice: [6, 6] },
      { type: 'BUY_PROPERTY', price: 1 },
      { type: 'BUY_PROPERTY', insurePremium: 0 },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: -500 },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 0 },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 10.5 },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: '100' },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: Number.MAX_SAFE_INTEGER },
      { type: 'TRANSFER_MONEY', toPlayerId: 'Bilal', amount: 100 },
      { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100, fromPlayerId: g.id('Chitra') },
      { type: 'BUILD_HOUSE', propertyKey: 'ATLANTIS' },
      { type: 'PLACE_BID', auctionId: testId(), amount: -1 },
      { type: 'REQUEST_LOAN', amount: Number.POSITIVE_INFINITY },
      { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: -1, requestedMoney: 0 },
      { type: 'END_GAME' },
      { type: 'REQUEST_END_VOTE', winnerId: g.id('Asha') },
      { type: 'CAST_END_VOTE', voteId: testId(), choice: 'MAYBE' },
      { type: 'CAST_END_VOTE', voteId: testId(), choice: 'END', playerId: g.id('Bilal') },
    ];
    for (const action of bad) expect(`${JSON.stringify(action)}: ${refusal(g, 'Asha', action)}`).toBe(`${JSON.stringify(action)}: VALIDATION`);
    // Somebody who is not at this table at all.
    const before = JSON.stringify(g.state);
    expect(() => applyAction(g.state, testId(), { type: 'ROLL_DICE' }, g.ctx())).toThrow(/not in this game/);
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('a stored game the engine should not touch is refused whole: another rule set, or expired', () => {
    const g = new TestGame();
    const old: GameState = { ...g.state, rulesVersion: `${RULES_VERSION}-OLD` };
    expect(() => applyAction(old, g.id('Asha'), { type: 'ROLL_DICE' }, g.ctx())).toThrow(/older version of the board/);
    g.advance(60 * 60 * 24 * 30);
    for (const type of ['ROLL_DICE', 'LEAVE_GAME', 'REQUEST_END_VOTE'] as const) expect(refusal(g, 'Asha', { type })).toBe('GAME_EXPIRED');
  });
});
