import { describe, expect, it } from 'vitest';
import {
  activePolicyFor,
  applyAction,
  auctionAcceptUntil,
  auctionOpensAt,
  BUSINESS_MVP_RULES,
  computeRent,
  creditScoreOf,
  eligibleCollateral,
  GameError,
  INTERMEDIATE_RULES,
  intermediateRuleEntries,
  minimumNextBid,
  offeredRate,
  openResaleFor,
  premiumForYear,
  propertyActionBlocker,
  propertyInsurance,
  resaleBlocker,
  reservePriceBlocker,
  type AuctionState,
  type EngineResult,
  type GameAction,
  type PropertyKey,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const RULES = BUSINESS_MVP_RULES.auction;
const RESERVE = 5000;
/** The "get ready" before the first bid of a resale is accepted. */
const LEAD = INTERMEDIATE_RULES.resale.startCountdownSeconds;

const newGame = (names = ['Asha', 'Bilal', 'Chitra']) => new TestGame(names, { mode: 'intermediate' });
const types = (r: EngineResult) => r.events.map((e) => e.type);
const balances = (g: TestGame) => Object.fromEntries(g.state.players.map((p) => [p.name, p.balance]));

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

/** Asha owns `key` (with whatever `patch` builds on it) and lists it on her turn. */
function listed(patch: { houses?: number; hotel?: boolean } = {}, key: PropertyKey = 'MUMBAI', reserve = RESERVE) {
  const g = newGame();
  g.give('Asha', key, patch);
  const result = g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: key, reservePrice: reserve });
  return { g, auction: g.state.auction!, result };
}

/** Bids once the "get ready" is over (waits it out first, as a real bidder has to). */
function bid(g: TestGame, name: string, amount: number) {
  const auction = g.state.auction!;
  g.nowMs = Math.max(g.nowMs, auctionOpensAt(auction));
  return g.act(name, { type: 'PLACE_BID', auctionId: auction.id, amount });
}
const pass = (g: TestGame, name: string) => g.act(name, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
/** Lets the countdown and the hidden grace run out, then closes. */
function timeout(g: TestGame, by = 'Chitra') {
  g.nowMs = Math.max(g.nowMs, auctionAcceptUntil(g.state.auction!) + 1000);
  return g.act(by, { type: 'CLOSE_AUCTION', auctionId: g.state.auction!.id });
}

function insure(g: TestGame, name: string, key: PropertyKey) {
  return g.act(name, { type: 'INSURE_PROPERTY', propertyKey: key, expectedPremium: premiumForYear(g.state.intermediate!.year) });
}

function pledge(g: TestGame, name: string, key: PropertyKey, amount = 2000) {
  const expectedRatePercent = offeredRate('SECURED', creditScoreOf(g.state.intermediate!, g.id(name))).ratePercent;
  return g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product: 'SECURED', amount, collateralKey: key, expectedRatePercent });
}

describe('listing a property for resale', () => {
  it('an unmortgaged property I own can be listed in Capital Mode, on the existing auction', () => {
    const { g, auction, result } = listed();
    expect(g.state.turn.phase).toBe('AUCTION');
    expect(auction).toMatchObject({
      propertyKey: 'MUMBAI',
      status: 'OPEN',
      highBid: null,
      highBidderId: null,
      winnerId: null,
      // Bidding opens at the seller's reserve: no time is spent on bids that could never buy it.
      minimumOpeningBid: RESERVE,
      minimumIncrement: RULES.minimumIncrement,
      resale: { sellerId: g.id('Asha'), reservePrice: RESERVE, houses: 0, hotel: false, resumePhase: 'AWAITING_ROLL', outcome: null },
    });
    // The same countdown as any auction, and every other player — never the seller — may bid.
    expect(auctionOpensAt(auction) - g.nowMs).toBe(LEAD * 1000);
    expect(Date.parse(auction.endsAt) - g.nowMs).toBe((LEAD + RULES.openingTimerSeconds) * 1000);
    expect(auction.participantIds).toEqual([g.id('Bilal'), g.id('Chitra')]);
    expect(result.transactions).toEqual([]);
    expect(result.events).toMatchObject([{ type: 'AUCTION_STARTED', payload: { resale: true, reservePrice: RESERVE, sellerId: g.id('Asha') } }]);
    expect(openResaleFor(g.state, 'MUMBAI')?.id).toBe(auction.id);
    // Listing changed nothing about the property.
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 0, hotel: false, mortgaged: false });
  });

  it('a mortgaged property cannot be listed', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { mortgaged: true });
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toMatchObject({
      code: 'AUCTION_NOT_ALLOWED',
      message: expect.stringMatching(/^Mortgaged/),
    });
    expect(g.state.auction).toBeNull();
  });

  it('a property pledged as loan collateral cannot be listed', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    pledge(g, 'Asha', 'MUMBAI');
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toMatchObject({
      code: 'AUCTION_NOT_ALLOWED',
      message: expect.stringMatching(/^Pledged as loan collateral/),
    });
  });

  it("a player cannot list another player's property, nor one the bank still owns", () => {
    const g = newGame();
    g.give('Bilal', 'MUMBAI');
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toEqual({
      code: 'NOT_OWNER',
      message: "You don't own this property.",
    });
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'RAILWAY', reservePrice: RESERVE }))).toEqual({
      code: 'NOT_OWNER',
      message: 'This property belongs to the bank.',
    });
    expect(g.state.auction).toBeNull();
    expect(g.state.turn.phase).toBe('AWAITING_ROLL');
  });

  it('a Classic game refuses resale auctions, and its own auctions are what they always were', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toEqual({
      code: 'AUCTION_NOT_ALLOWED',
      message: 'Property auctions are only available in Capital Mode.',
    });
    expect(resaleBlocker(g.state, g.id('Asha'), 'MUMBAI')).toMatch(/Capital Mode/);
    // The bank's auction: no resale terms, the decliner may bid, the leader may not raise, nobody can cancel.
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    const auction = g.state.auction!;
    expect(auction.resale ?? null).toBeNull();
    expect(auction.participantIds).toHaveLength(3);
    expect(refusal(() => g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id })).code).toBe('FORBIDDEN');
    bid(g, 'Asha', 500);
    expect(refusal(() => bid(g, 'Asha', 700)).message).toBe('You already have the highest bid.');
    pass(g, 'Bilal');
    const closed = pass(g, 'Chitra');
    expect(closed.transactions).toMatchObject([{ type: 'AUCTION_PAYMENT', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 500 }]);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('one auction at a time: a second listing — of the same property or another — is refused', () => {
    const { g, auction } = listed();
    g.give('Asha', 'AHMEDABAD');
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toEqual({
      code: 'AUCTION_NOT_ALLOWED',
      message: 'Already up for auction.',
    });
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'AHMEDABAD', reservePrice: RESERVE })).message).toBe('Wait for the auction to finish.');
    expect(g.state.auction!.id).toBe(auction.id);
  });

  it('invalid reserve prices are rejected', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    const max = INTERMEDIATE_RULES.resale.maxReservePrice;
    for (const reservePrice of [0, -500, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null, undefined, 10_000_001]) {
      const action = { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice } as unknown as GameAction;
      expect(refusal(() => g.act('Asha', action)).code, String(reservePrice)).toBe('VALIDATION');
    }
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: max + 1 }))).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/at most/),
    });
    expect(g.state.auction).toBeNull();
    expect(reservePriceBlocker(0)).not.toBeNull();
    expect(reservePriceBlocker(2.5)).not.toBeNull();
    expect(reservePriceBlocker(max)).toBeNull();
    // The seller chooses it: far below or far above the deed price are both fine.
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 1 });
    expect(g.state.auction!.resale!.reservePrice).toBe(1);
  });

  it('only on my own turn, and not in the middle of a decision', () => {
    const g = newGame();
    g.give('Bilal', 'MUMBAI');
    expect(refusal(() => g.act('Bilal', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).message).toBe(
      'You can auction a property during your own turn.',
    );
    g.give('Asha', 'AHMEDABAD');
    g.roll('Asha', 1, 2); // lands on the unowned Railway: buy or decline first
    expect(g.state.turn.phase).toBe('AWAITING_DECISION');
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'AHMEDABAD', reservePrice: RESERVE })).message).toBe('Finish your current action first.');
  });

  it('is refused while the game is paused, and for a player who is out of it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'PAUSE_GAME' });
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).code).toBe('GAME_PAUSED');
    expect(resaleBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBe('Game is paused.');
  });
});

describe('bidding on a resale', () => {
  it('the owner can never bid on their own property', () => {
    const { g } = listed();
    expect(refusal(() => bid(g, 'Asha', 6000))).toEqual({ code: 'FORBIDDEN', message: "You can't bid on your own property." });
    bid(g, 'Bilal', RESERVE);
    expect(refusal(() => bid(g, 'Asha', 6000)).code).toBe('FORBIDDEN');
    expect(refusal(() => pass(g, 'Asha')).code).toBe('FORBIDDEN');
    expect(g.state.auction!.participantIds).not.toContain(g.id('Asha'));
  });

  it('bids follow the existing opening bid, increment, balance and countdown rules', () => {
    const { g, auction } = listed();
    expect(minimumNextBid(auction)).toBe(RESERVE);
    expect(refusal(() => bid(g, 'Bilal', RESERVE - 100)).message).toBe('Minimum bid is ₹5,000.');
    const first = bid(g, 'Bilal', 6000);
    expect(first.bids).toMatchObject([{ playerId: g.id('Bilal'), amount: 6000 }]);
    expect(Date.parse(g.state.auction!.endsAt) - g.nowMs).toBe(RULES.bidTimerSeconds * 1000);
    expect(refusal(() => bid(g, 'Chitra', 6050)).message).toBe('Minimum bid is ₹6,100.');
    expect(refusal(() => bid(g, 'Bilal', 7000)).message).toBe('You already have the highest bid.');
    expect(refusal(() => bid(g, 'Chitra', g.balance('Chitra') + 100)).code).toBe('INSUFFICIENT_FUNDS');
    bid(g, 'Chitra', 6100);
    expect(g.state.auction).toMatchObject({ highBid: 6100, highBidderId: g.id('Chitra'), status: 'OPEN' });
    // Still running: nobody can close it early, and a bid after the deadline is too late.
    expect(refusal(() => g.act('Asha', { type: 'CLOSE_AUCTION', auctionId: auction.id })).message).toBe('The auction is still running.');
    g.advance(RULES.bidTimerSeconds + RULES.bidGraceSeconds + 1);
    expect(refusal(() => bid(g, 'Bilal', 7000)).code).toBe('AUCTION_CLOSED');
  });

  it('a player who is not in the game cannot bid', () => {
    const { g, auction } = listed();
    const stranger = '00000000-0000-4000-8000-00000000dead';
    expect(() => applyAction(g.state, stranger, { type: 'PLACE_BID', auctionId: auction.id, amount: 6000 }, g.ctx())).toThrow('You are not in this game.');
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(refusal(() => bid(g, 'Chitra', 6000)).code).toBe('FORBIDDEN');
  });

  it('bidding opens at the reserve: nothing lower is a bid, and the first bid already buys it', () => {
    const { g } = listed();
    for (const amount of [100, 1000, RESERVE - 1]) {
      expect(refusal(() => bid(g, 'Bilal', amount))).toEqual({ code: 'INVALID_BID', message: 'Minimum bid is ₹5,000.' });
    }
    expect(g.state.auction).toMatchObject({ highBid: null, status: 'OPEN' });
    bid(g, 'Bilal', RESERVE);
    // The leader waits, as in any auction; the next bid is the usual increment higher.
    expect(refusal(() => bid(g, 'Bilal', RESERVE + 500)).message).toBe('You already have the highest bid.');
    expect(minimumNextBid(g.state.auction!)).toBe(RESERVE + RULES.minimumIncrement);
    const sold = pass(g, 'Chitra');
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Bilal'), highBid: RESERVE, resale: { outcome: 'SOLD' } });
    expect(types(sold)).toEqual(['AUCTION_PASSED', 'AUCTION_WON']);
  });

  it('get ready: no bid counts before bidding opens, and then bidders have the full countdown', () => {
    const { g, auction } = listed();
    const opensAt = auctionOpensAt(auction);
    const early = () => g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: RESERVE });
    expect(refusal(early)).toEqual({ code: 'INVALID_BID', message: 'Bidding has not started yet.' });
    g.nowMs = opensAt - 1;
    expect(refusal(early).message).toBe('Bidding has not started yet.');
    expect(g.state.auction).toMatchObject({ highBid: null, status: 'OPEN' });
    // The auction cannot be closed during the get-ready or the countdown that follows it.
    expect(refusal(() => g.act('Chitra', { type: 'CLOSE_AUCTION', auctionId: auction.id })).message).toBe('The auction is still running.');
    g.nowMs = opensAt;
    expect(Date.parse(auction.endsAt) - g.nowMs).toBe(RULES.openingTimerSeconds * 1000);
    early();
    expect(g.state.auction).toMatchObject({ highBid: RESERVE, highBidderId: g.id('Bilal') });
    expect(Date.parse(g.state.auction!.endsAt) - g.nowMs).toBe(RULES.bidTimerSeconds * 1000);
  });

  it('passing and cancelling do not wait for the get-ready', () => {
    const first = listed();
    pass(first.g, 'Bilal');
    pass(first.g, 'Chitra');
    expect(first.g.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'UNSOLD' } });
    const second = listed();
    second.g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: second.auction.id });
    expect(second.g.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'CANCELLED' } });
  });

  it('the bank’s auction of an unowned property has no get-ready and still opens at the usual bid', () => {
    const g = newGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    const auction = g.state.auction!;
    expect(auctionOpensAt(auction)).toBe(g.nowMs);
    expect(Date.parse(auction.endsAt) - g.nowMs).toBe(RULES.openingTimerSeconds * 1000);
    expect(minimumNextBid(auction)).toBe(RULES.minimumOpeningBid);
    g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: RULES.minimumOpeningBid });
    expect(g.state.auction!.highBid).toBe(RULES.minimumOpeningBid);
  });

  it('the reserve price is not a bid: an untouched auction never sells', () => {
    const { g } = listed();
    expect(g.state.auction).toMatchObject({ highBid: null, highBidderId: null });
    expect(minimumNextBid(g.state.auction!)).toBe(RESERVE);
  });
});

describe('an auction that does not sell', () => {
  it('no bids: no sale, no money moves, the turn goes back where it was', () => {
    const { g } = listed({ houses: 2 });
    const before = balances(g);
    const ledger = g.ledger.length;
    const closed = timeout(g);
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 2, hotel: false });
    expect(balances(g)).toEqual(before);
    expect(g.ledger).toHaveLength(ledger);
    expect(closed.events).toMatchObject([{ type: 'AUCTION_UNSOLD', message: 'Mumbai stays with Asha (no bids)' }]);
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', playerId: g.id('Asha') });
  });

  it('everyone passing ends it at once, unsold', () => {
    const { g } = listed();
    pass(g, 'Bilal');
    expect(g.state.auction!.status).toBe('OPEN');
    pass(g, 'Chitra');
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'UNSOLD' } });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
  });

  it('a bidder who cannot afford the reserve cannot bid, and the auction ends unsold', () => {
    const { g } = listed({ hotel: true }, 'MUMBAI', 900_000);
    expect(refusal(() => bid(g, 'Bilal', 900_000)).code).toBe('INSUFFICIENT_FUNDS');
    const before = balances(g);
    const closed = timeout(g, 'Asha');
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, highBid: null, resale: { outcome: 'UNSOLD' } });
    expect(closed.transactions).toEqual([]);
    expect(balances(g)).toEqual(before);
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), hotel: true, houses: 0 });
  });

  it('releases the property: it can be built on, and listed again', () => {
    const { g, auction } = listed();
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'MORTGAGE_PROPERTY')).toBe('Wait for the auction to finish.');
    timeout(g);
    expect(openResaleFor(g.state, 'MUMBAI')).toBeNull();
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'MORTGAGE_PROPERTY')).toBeNull();
    expect(resaleBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBeNull();
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 3000 });
    expect(g.state.auction).toMatchObject({ status: 'OPEN', highBid: null, resale: { reservePrice: 3000, outcome: null } });
    expect(g.state.auction!.id).not.toBe(auction.id);
    expect(g.state.auction!.passedIds).toEqual([]);
  });

  it('while listed the property cannot be built on, mortgaged, sold, traded or pledged', () => {
    const { g } = listed();
    for (const type of ['BUILD_HOUSE', 'MORTGAGE_PROPERTY', 'SELL_PROPERTY'] as const) {
      expect(refusal(() => g.act('Asha', { type, propertyKey: 'MUMBAI' })).message, type).toBe('Wait for the auction to finish.');
    }
    const trade: GameAction = { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 };
    expect(refusal(() => g.act('Asha', trade))).toEqual({ code: 'TRADE_NOT_ALLOWED', message: 'Mumbai is up for auction.' });
    expect(eligibleCollateral(g.state, g.id('Asha'))).toEqual([]);
    expect(resaleBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBe('Already up for auction.');
    expect(refusal(() => pledge(g, 'Asha', 'MUMBAI')).code).toBe('LOAN_NOT_ALLOWED');
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 0, mortgaged: false });
  });
});

describe('undo while a property is listed', () => {
  it('a house built before listing cannot be undone from under the bidders', () => {
    const g = newGame();
    g.giveGroup('Asha', 'MUMBAI');
    const built = g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    const targetActionId = built.state.undoStack.at(-1)!.actionId;
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    expect(g.state.auction!.resale).toMatchObject({ houses: 1 });
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId }))).toEqual({ code: 'UNDO_NOT_ALLOWED', message: 'Mumbai is up for auction — can’t undo.' });
    expect(g.state.properties.MUMBAI.houses).toBe(1);
    // Once the auction is over without a sale, the build is an ordinary undoable action again.
    timeout(g);
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId });
    expect(g.state.undoRequest).not.toBeNull();
  });
});

describe('cancelling', () => {
  it('the owner can cancel before the first bid; repeating it changes nothing', () => {
    const { g, auction } = listed({ houses: 1 });
    const before = balances(g);
    const cancelled = g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'CANCELLED' } });
    expect(types(cancelled)).toEqual(['AUCTION_CANCELLED']);
    expect(g.state.turn.phase).toBe('AWAITING_ROLL');
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 1 });
    const again = g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id });
    expect(again.events).toEqual([]);
    expect(again.transactions).toEqual([]);
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'CANCELLED' } });
    expect(balances(g)).toEqual(before);
    // Nothing is left locked: bids are over, and the property can be listed again.
    expect(refusal(() => bid(g, 'Bilal', 6000)).code).toBe('AUCTION_CLOSED');
    expect(resaleBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBeNull();
  });

  it('cancelling is refused once a bid has been accepted', () => {
    const { g, auction } = listed();
    bid(g, 'Bilal', RESERVE);
    expect(refusal(() => g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id }))).toEqual({
      code: 'AUCTION_NOT_ALLOWED',
      message: 'Bidding has started — the auction can no longer be cancelled.',
    });
    expect(g.state.auction!.status).toBe('OPEN');
  });

  it("other players cannot cancel the owner's auction", () => {
    const { g, auction } = listed();
    expect(refusal(() => g.act('Bilal', { type: 'CANCEL_AUCTION', auctionId: auction.id }))).toEqual({ code: 'FORBIDDEN', message: 'Only the owner can cancel this auction.' });
    expect(refusal(() => g.act('Bilal', { type: 'CANCEL_AUCTION', auctionId: '00000000-0000-4000-8000-0000deadbeef' })).code).toBe('AUCTION_CLOSED');
    expect(g.state.auction!.status).toBe('OPEN');
  });

  it('a finished auction cannot be cancelled after the fact', () => {
    const { g, auction } = listed();
    bid(g, 'Bilal', 6000);
    pass(g, 'Chitra');
    expect(refusal(() => g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id })).code).toBe('AUCTION_CLOSED');
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
  });
});

describe('a successful sale', () => {
  it('the winning bid goes from the buyer to the seller, and the property to the buyer', () => {
    const { g } = listed();
    const before = balances(g);
    bid(g, 'Bilal', 6000);
    bid(g, 'Chitra', 7200);
    const closed = timeout(g, 'Bilal');
    expect(closed.transactions).toMatchObject([{ type: 'AUCTION_PAYMENT', fromPlayerId: g.id('Chitra'), toPlayerId: g.id('Asha'), amount: 7200, propertyKey: 'MUMBAI' }]);
    expect(balances(g)).toEqual({ Asha: before.Asha! + 7200, Bilal: before.Bilal, Chitra: before.Chitra! - 7200 });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Chitra'), houses: 0, hotel: false, mortgaged: false });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Chitra'), highBid: 7200, resale: { outcome: 'SOLD' } });
    expect(closed.events).toMatchObject([{ type: 'AUCTION_WON', actorId: g.id('Chitra'), message: 'Chitra bought Mumbai from Asha for ₹7,200' }]);
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', playerId: g.id('Asha') });
  });

  it('a bid exactly at the reserve buys it', () => {
    const { g } = listed();
    bid(g, 'Bilal', RESERVE);
    timeout(g);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
  });

  it.each([
    ['no buildings', {}, null],
    ['1 house', { houses: 1 }, '1 house'],
    ['3 houses', { houses: 3 }, '3 houses'],
    ['a hotel', { hotel: true }, 'hotel'],
  ] as const)('a property with %s transfers exactly as it stands, for the bid alone', (_label, patch, built) => {
    const { g, auction } = listed(patch);
    expect(auction.resale).toMatchObject({ houses: 0, hotel: false, ...patch });
    const before = balances(g);
    bid(g, 'Bilal', 9000);
    const closed = pass(g, 'Chitra');
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Bilal'), houses: 0, hotel: false, mortgaged: false, ...patch });
    // One payment: the buildings are part of what the bid bought.
    expect(closed.transactions).toHaveLength(1);
    expect(balances(g).Bilal).toBe(before.Bilal! - 9000);
    expect(closed.events.at(-1)!.message).toBe(`Bilal bought Mumbai${built ? ` (${built})` : ''} from Asha for ₹9,000`);
  });

  it('rent, colour sets and building rights follow the new owner', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.give('Bilal', 'AHMEDABAD');
    g.give('Bilal', 'CALCUTTA');
    expect(computeRent(g.state, 'MUMBAI', 7)).toBe(5500);
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    bid(g, 'Bilal', 8000);
    pass(g, 'Chitra');
    // Bilal now holds three Blue properties: the 2-house rent doubles, and it is owed to him.
    expect(computeRent(g.state, 'MUMBAI', 7)).toBe(11000);
    g.landOn('Asha', 1, 4);
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_PAYMENT', pending: { kind: 'PAYMENT', reason: 'RENT', amount: 11000, toPlayerId: g.id('Bilal'), propertyKey: 'MUMBAI' } });
    g.act('Asha', { type: 'PAY_RENT' });
    g.act('Asha', { type: 'END_TURN' });
    // Only the new owner can build on it — and continues from the houses that came with it.
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'BUILD_HOUSE')).toBe("You don't own this property.");
    expect(propertyActionBlocker(g.state, g.id('Bilal'), 'MUMBAI', 'BUILD_HOUSE')).toBeNull();
    g.act('Bilal', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Bilal'), houses: 3 });
  });

  it('closes open trade offers for the property and forgets undo entries on it', () => {
    const g = newGame();
    g.giveGroup('Asha', 'MUMBAI');
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 9000 });
    expect(g.state.undoStack).toHaveLength(1);
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    const tradeId = g.state.trades[0]!.id;
    expect(refusal(() => g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId })).message).toMatch(/up for auction/);
    bid(g, 'Bilal', 6000);
    const closed = pass(g, 'Chitra');
    expect(g.state.trades[0]!.status).toBe('EXPIRED');
    expect(types(closed)).toContain('TRADE_EXPIRED');
    expect(g.state.undoStack).toEqual([]);
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Bilal'), houses: 1 });
  });

  it('returns the turn to where it was: after the move, or to a payment still owed', () => {
    const done = newGame();
    done.give('Asha', 'MUMBAI');
    done.landOn('Asha', 1, 4); // her own Mumbai: nothing to do
    expect(done.state.turn.phase).toBe('TURN_COMPLETE');
    done.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    expect(refusal(() => done.act('Asha', { type: 'END_TURN' })).code).toBe('INVALID_PHASE');
    bid(done, 'Bilal', 6000);
    pass(done, 'Chitra');
    expect(done.state.turn.phase).toBe('TURN_COMPLETE');
    done.act('Asha', { type: 'END_TURN' });
    expect(done.current).toBe('Bilal');
    expect(done.state.auction).toBeNull();

    const owing = newGame();
    owing.give('Asha', 'MUMBAI');
    owing.give('Bilal', 'AHMEDABAD');
    owing.rollTotal('Asha', 4); // Ahmedabad: rent owed to Bilal
    const pending = owing.state.turn.pending;
    expect(owing.state.turn.phase).toBe('AWAITING_PAYMENT');
    owing.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    expect(owing.state.auction!.resale!.resumePhase).toBe('AWAITING_PAYMENT');
    expect(refusal(() => owing.act('Asha', { type: 'PAY_RENT' })).code).toBe('INVALID_PHASE');
    bid(owing, 'Chitra', 6000);
    pass(owing, 'Bilal');
    expect(owing.state.turn).toMatchObject({ phase: 'AWAITING_PAYMENT', pending });
    owing.act('Asha', { type: 'PAY_RENT' });
    expect(owing.state.turn.phase).toBe('TURN_COMPLETE');
  });
});

describe('insurance on a sold property', () => {
  it("the seller's policy ends with the sale — no refund, no transfer — and the buyer may insure it or not", () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const policyId = activePolicyFor(g.state, 'MUMBAI')!.id;
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    // Still the seller's property, still insured, until it is actually sold.
    expect(activePolicyFor(g.state, 'MUMBAI')?.id).toBe(policyId);
    bid(g, 'Bilal', 6000);
    const sold = pass(g, 'Chitra');

    const policies = g.state.intermediate!.insurance!.policies;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ id: policyId, ownerId: g.id('Asha'), status: 'EXPIRED', claimedCrisisId: null });
    expect(policies[0]!.closedAt).not.toBeNull();
    expect(types(sold)).toEqual(['AUCTION_PASSED', 'INSURANCE_ENDED', 'AUCTION_WON']);
    // The only money that moved is the bid: nothing came back for unused cover.
    expect(sold.transactions.map((t) => t.type)).toEqual(['AUCTION_PAYMENT']);
    // The new owner has no policy on it, and nothing was bought for them.
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(propertyInsurance(g.state, 'MUMBAI')).toMatchObject({ active: null, latest: null });

    // Optional: Bilal can simply play on …
    g.rollTotal('Asha', 4);
    // … or insure it himself, through the ordinary purchase.
    const cash = g.balance('Bilal');
    insure(g, 'Bilal', 'MUMBAI');
    expect(activePolicyFor(g.state, 'MUMBAI')).toMatchObject({ ownerId: g.id('Bilal'), status: 'ACTIVE' });
    expect(g.balance('Bilal')).toBe(cash - premiumForYear(1));
    expect(g.state.intermediate!.insurance!.policies).toHaveLength(2);
  });

  it("the ended policy never comes back, even if the seller owns the property again", () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    bid(g, 'Bilal', 6000);
    pass(g, 'Chitra');
    g.give('Asha', 'MUMBAI');
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
  });

  it('an auction that does not sell leaves the policy alone', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    timeout(g);
    expect(activePolicyFor(g.state, 'MUMBAI')).toMatchObject({ ownerId: g.id('Asha'), status: 'ACTIVE', closedAt: null });
  });
});

describe('finalization is all or nothing', () => {
  /** A hotel, insured, with a winning bid on the table — and then something goes wrong before the close. */
  function aboutToSell() {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { hotel: true });
    insure(g, 'Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    bid(g, 'Bilal', 20000);
    return g;
  }

  function expectNothingSold(g: TestGame, before: Record<string, number>, reason: RegExp, ownerId = g.id('Asha')) {
    const closed = timeout(g);
    expect(closed.transactions).toEqual([]);
    expect(closed.events).toMatchObject([{ type: 'AUCTION_UNSOLD', message: expect.stringMatching(reason) }]);
    expect(balances(g)).toEqual(before);
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId, hotel: true, houses: 0 });
    expect(g.state.intermediate!.insurance!.policies[0]).toMatchObject({ status: 'ACTIVE', closedAt: null });
    expect(g.state.turn.phase).toBe('AWAITING_ROLL');
  }

  it('a winner who can no longer afford the bid buys nothing and pays nothing', () => {
    const g = aboutToSell();
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 10000 });
    expectNothingSold(g, balances(g), /Bilal couldn't pay/);
  });

  it('a winner who left the game buys nothing', () => {
    const g = aboutToSell();
    const before = balances(g);
    const left = g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(left.transactions).toEqual([]);
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), hotel: true });
    expect(balances(g)).toEqual(before);
  });

  const stale: [string, (g: TestGame) => void, RegExp][] = [
    ['the seller no longer owns it', (g) => void (g.state.properties.MUMBAI.ownerId = g.id('Chitra')), /seller no longer owns it/],
    ['it was mortgaged meanwhile', (g) => void (g.state.properties.MUMBAI.mortgaged = true), /it was mortgaged/],
    ['its buildings changed', (g) => void Object.assign(g.state.properties.MUMBAI, { hotel: false, houses: 1 }), /its buildings changed/],
    ['the game is not Capital', (g) => void (g.state.mode = 'classic'), /cannot sell/],
  ];
  it.each(stale)('stale state — %s — prevents the sale', (_label, corrupt, reason) => {
    const g = aboutToSell();
    const before = balances(g);
    corrupt(g);
    const closed = timeout(g);
    expect(closed.transactions).toEqual([]);
    expect(closed.events.at(-1)).toMatchObject({ type: 'AUCTION_UNSOLD', message: expect.stringMatching(reason) });
    expect(balances(g)).toEqual(before);
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(g.state.properties.MUMBAI.ownerId).not.toBe(g.id('Bilal'));
  });

  it('a property pledged after listing cannot be sold from under the bank', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    bid(g, 'Bilal', 6000);
    // Not reachable through an action (a listed property can't be pledged): the close still checks.
    const loan = { id: '00000000-0000-4000-8000-00000000c0de', playerId: g.id('Asha'), collateralKey: 'MUMBAI', status: 'ACTIVE', installments: [] };
    g.state.intermediate!.loans.push(loan as never);
    const before = balances(g);
    const closed = timeout(g);
    expect(closed.events.at(-1)!.message).toMatch(/pledged as loan collateral/);
    expect(balances(g)).toEqual(before);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
  });

  it('a repeated close does not charge or transfer twice', () => {
    const g = aboutToSell();
    const id = g.state.auction!.id;
    timeout(g);
    const after = balances(g);
    const ledger = g.ledger.length;
    for (const name of ['Asha', 'Bilal', 'Chitra']) {
      expect(refusal(() => g.act(name, { type: 'CLOSE_AUCTION', auctionId: id })).code).toBe('AUCTION_CLOSED');
    }
    expect(balances(g)).toEqual(after);
    expect(g.ledger).toHaveLength(ledger);
    expect(g.ledger.filter((t) => t.type === 'AUCTION_PAYMENT')).toHaveLength(1);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
  });

  it('two closes racing from the same state: the one that lands second finds the auction closed', () => {
    const g = aboutToSell();
    g.advance(RULES.bidTimerSeconds + RULES.bidGraceSeconds + 1);
    const action: GameAction = { type: 'CLOSE_AUCTION', auctionId: g.state.auction!.id };
    // Both requests read the same snapshot; the server serializes them on the game row, so the
    // second runs against the first one's result (tests/server proves the lock; this is the rule).
    const first = applyAction(g.state, g.id('Bilal'), action, g.ctx());
    expect(first.transactions).toHaveLength(1);
    expect(() => applyAction(first.state, g.id('Chitra'), action, g.ctx())).toThrow(/no longer running/);
    expect(first.state.version).toBe(g.state.version + 1);
  });

  it('the seller leaving withdraws the auction, whatever was bid', () => {
    const g = aboutToSell();
    const before = balances(g);
    const left = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(left.transactions).toEqual([]);
    expect(g.state.auction).toBeNull();
    expect(types(left)).toContain('AUCTION_UNSOLD');
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), hotel: true });
    expect(balances(g)).toEqual(before);
    expect(g.current).toBe('Bilal');
    expect(g.state.turn.phase).toBe('AWAITING_ROLL');
  });

  it('pausing gives bidders their time back, as for any auction', () => {
    const { g } = listed();
    const endsAt = Date.parse(g.state.auction!.endsAt);
    g.act('Bilal', { type: 'PAUSE_GAME' });
    g.advance(60);
    g.act('Bilal', { type: 'RESUME_GAME' });
    expect(Date.parse(g.state.auction!.endsAt)).toBe(endsAt + 60_000);
    bid(g, 'Bilal', 6000);
    expect(g.state.auction!.highBid).toBe(6000);
  });
});

describe('the shared eligibility answer', () => {
  it('says why, in the order a player would fix things', () => {
    const g = newGame();
    const asha = g.id('Asha');
    expect(resaleBlocker(g.state, asha, 'MUMBAI')).toBe('This property belongs to the bank.');
    g.give('Bilal', 'MUMBAI');
    expect(resaleBlocker(g.state, asha, 'MUMBAI')).toBe("You don't own this property.");
    expect(resaleBlocker(g.state, g.id('Bilal'), 'MUMBAI')).toBe('You can auction a property during your own turn.');
    g.give('Asha', 'MUMBAI', { mortgaged: true });
    expect(resaleBlocker(g.state, asha, 'MUMBAI')).toMatch(/^Mortgaged/);
    g.give('Asha', 'MUMBAI', { mortgaged: false, houses: 3 });
    expect(resaleBlocker(g.state, asha, 'MUMBAI')).toBeNull();
  });

  it('the rulebook explains the feature from the same numbers', () => {
    const entry = intermediateRuleEntries().find((e) => e.title === 'Auctioning your property');
    expect(entry?.lines.join(' ')).toContain('₹10,00,000');
  });

  it('the auction state type stays what the server stores', () => {
    const { auction } = listed({ houses: 2 });
    const stored = JSON.parse(JSON.stringify(auction)) as AuctionState;
    expect(stored).toEqual(auction);
  });
});
