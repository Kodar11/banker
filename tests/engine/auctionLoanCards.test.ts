import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, loanTerms, minimumNextBid } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;

function auctionGame() {
  const g = new TestGame();
  g.roll('Asha', 3, 2); // Railway
  g.act('Asha', { type: 'DECLINE_PROPERTY' });
  const auction = g.state.auction!;
  return { g, auction };
}

describe('auctions', () => {
  it('declining starts an auction for all active players', () => {
    const { g, auction } = auctionGame();
    expect(g.state.turn.phase).toBe('AUCTION');
    expect(auction).toMatchObject({ propertyKey: 'RAILWAY', status: 'OPEN', highBid: null });
    expect(auction.participantIds).toHaveLength(3);
    expect(minimumNextBid(auction)).toBe(BUSINESS_MVP_RULES.auction.minimumOpeningBid);
  });

  it('first bid, higher bid, minimum increment, invalid bids', () => {
    const { g, auction } = auctionGame();
    const id = auction.id;
    expect(() => g.act('Bilal', { type: 'PLACE_BID', auctionId: id, amount: 50 })).toThrow('Minimum bid is ₹100.');
    g.act('Bilal', { type: 'PLACE_BID', auctionId: id, amount: 1000 });
    expect(g.state.auction).toMatchObject({ highBid: 1000, highBidderId: g.id('Bilal') });
    expect(() => g.act('Chitra', { type: 'PLACE_BID', auctionId: id, amount: 1050 })).toThrow('Minimum bid is ₹1,100.');
    expect(() => g.act('Bilal', { type: 'PLACE_BID', auctionId: id, amount: 2000 })).toThrow('You already have the highest bid.');
    expect(() => g.act('Chitra', { type: 'PLACE_BID', auctionId: id, amount: START + 100 })).toThrow("can't bid more than your balance");
    g.act('Chitra', { type: 'PLACE_BID', auctionId: id, amount: 1100 });
    expect(g.state.auction).toMatchObject({ highBid: 1100, highBidderId: g.id('Chitra') });
    // A duplicate (stale) bid at the same amount is rejected.
    expect(() => g.act('Asha', { type: 'PLACE_BID', auctionId: id, amount: 1100 })).toThrow('Minimum bid is ₹1,200.');
  });

  it('winner pays atomically and receives ownership when everyone else passes', () => {
    const { g, auction } = auctionGame();
    g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 4000 });
    g.act('Asha', { type: 'PASS_AUCTION', auctionId: auction.id });
    expect(g.state.auction?.status).toBe('OPEN');
    const r = g.act('Chitra', { type: 'PASS_AUCTION', auctionId: auction.id });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Bilal') });
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Bilal'));
    expect(r.transactions).toMatchObject([{ type: 'AUCTION_PAYMENT', amount: 4000, fromPlayerId: g.id('Bilal'), toPlayerId: null }]);
    expect(g.balance('Bilal')).toBe(START - 4000);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    expect(() => g.act('Asha', { type: 'PLACE_BID', auctionId: auction.id, amount: 5000 })).toThrow(/no longer running/);
  });

  it('timer: bids after the deadline are rejected; CLOSE_AUCTION only after the deadline', () => {
    const { g, auction } = auctionGame();
    g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 500 });
    expect(() => g.act('Asha', { type: 'CLOSE_AUCTION', auctionId: auction.id })).toThrow('The auction is still running.');
    g.advance(BUSINESS_MVP_RULES.auction.bidTimerSeconds + 1);
    expect(() => g.act('Chitra', { type: 'PLACE_BID', auctionId: auction.id, amount: 600 })).toThrow('Bidding has ended.');
    g.act('Chitra', { type: 'CLOSE_AUCTION', auctionId: auction.id });
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Bilal'));
  });

  it('all pass with no bids → property stays with the bank', () => {
    const { g, auction } = auctionGame();
    for (const n of ['Asha', 'Bilal', 'Chitra']) g.act(n, { type: 'PASS_AUCTION', auctionId: auction.id });
    expect(g.state.auction?.status).toBe('CLOSED');
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(g.ledger.some((t) => t.type === 'AUCTION_PAYMENT')).toBe(false);
  });

  it('a bid against an old auction id is rejected', () => {
    const { g } = auctionGame();
    expect(() => g.act('Bilal', { type: 'PLACE_BID', auctionId: '00000000-0000-4000-8000-0000deadbeef', amount: 500 })).toThrow(/no longer running/);
  });

  it('the turn player can end the turn after the auction', () => {
    const { g, auction } = auctionGame();
    for (const n of ['Asha', 'Bilal', 'Chitra']) g.act(n, { type: 'PASS_AUCTION', auctionId: auction.id });
    g.act('Asha', { type: 'END_TURN' });
    expect(g.current).toBe('Bilal');
    expect(g.state.auction).toBeNull();
  });
});

describe('loans', () => {
  it('creates a loan with flat interest and disburses the principal', () => {
    const g = new TestGame();
    const r = g.act('Bilal', { type: 'REQUEST_LOAN', amount: 5000 });
    const loan = g.state.loans[0]!;
    const terms = loanTerms(5000);
    expect(loan).toMatchObject({ principal: 5000, totalOwed: terms.totalOwed, outstanding: terms.totalOwed, status: 'ACTIVE' });
    expect(terms.totalOwed).toBe(5000 + (5000 * BUSINESS_MVP_RULES.loans.interestRatePercent) / 100);
    expect(r.transactions).toMatchObject([{ type: 'LOAN_DISBURSEMENT', amount: 5000, toPlayerId: g.id('Bilal'), fromPlayerId: null }]);
    expect(g.balance('Bilal')).toBe(START + 5000);
  });

  it('partial then full repayment completes the loan', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'REQUEST_LOAN', amount: 2000 });
    const id = g.state.loans[0]!.id;
    g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1000 });
    expect(g.state.loans[0]).toMatchObject({ outstanding: 1200, status: 'ACTIVE' });
    expect(() => g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1500 })).toThrow('You only owe ₹1,200 on this loan.');
    g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1200 });
    expect(g.state.loans[0]).toMatchObject({ outstanding: 0, status: 'REPAID' });
    expect(g.balance('Bilal')).toBe(START + 2000 - 2200);
    expect(() => g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 100 })).toThrow('This loan is already closed.');
  });

  it('enforces min, step and maximum outstanding', () => {
    const g = new TestGame();
    const { minAmount, step, maxOutstandingPrincipal } = BUSINESS_MVP_RULES.loans;
    expect(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: minAmount - step })).toThrow(/Minimum loan/);
    expect(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: minAmount + 1 })).toThrow(/steps of/);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: maxOutstandingPrincipal });
    expect(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: minAmount })).toThrow(/Loan limit/);
  });

  it("cannot repay someone else's loan", () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'REQUEST_LOAN', amount: 2000 });
    expect(() => g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 100 })).toThrow('Loan not found.');
  });
});

describe('Chance & Community Chest effects', () => {
  it('Chance 2: loss in share market — pay bank ₹2,000', () => {
    const g = new TestGame();
    g.player('Asha').position = 5; // 5 + 2 = 7 Chance
    g.roll('Asha', 1, 1);
    expect(g.state.turn.card).toMatchObject({ cardId: 'CHANCE_2', verified: true });
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CARD', amount: 2000, toPlayerId: null });
    const r = g.act('Asha', { type: 'PAY_CARD' });
    expect(r.transactions[0]).toMatchObject({ type: 'CARD_PAYMENT', amount: 2000 });
    expect(g.balance('Asha')).toBe(START - 2000);
  });

  it('Chance 10: go to jail (skip 1 turn, no Start reward)', () => {
    const g = new TestGame();
    g.player('Asha').position = 10; // 10 + 10 = 20 Chance
    g.roll('Asha', 5, 5);
    expect(g.player('Asha')).toMatchObject({ position: 9, inJail: true, skipTurns: 1 });
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    expect(g.ledger.some((t) => t.type === 'START_REWARD')).toBe(false);
  });

  it('Chance 12: go to Rest House and skip next turn', () => {
    const g = new TestGame();
    g.player('Asha').position = 8; // 8 + 12 = 20 Chance
    g.roll('Asha', 6, 6);
    expect(g.player('Asha')).toMatchObject({ position: 18, skipTurns: 1 });
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('Community Chest 5: go to jail; 3: marriage ₹200; 11: insurance ₹1,500; 1-entry exists', () => {
    const g = new TestGame();
    g.player('Asha').position = 11; // 11 + 5 = 16 CC
    g.roll('Asha', 2, 3);
    expect(g.player('Asha')).toMatchObject({ inJail: true, position: 9 });
    g.act('Asha', { type: 'END_TURN' });

    g.player('Bilal').position = 13; // 13 + 3 = 16 CC
    g.roll('Bilal', 1, 2);
    expect(g.state.turn.pending).toMatchObject({ amount: 200 });
    g.act('Bilal', { type: 'PAY_CARD' });
    g.act('Bilal', { type: 'END_TURN' });

    g.player('Chitra').position = 17; // 17 + 11 = 28 CC
    g.roll('Chitra', 5, 6);
    expect(g.state.turn.pending).toMatchObject({ amount: 1500 });
  });

  it('Community Chest 9: repairs ₹100 per house and ₹500 per hotel', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE', { houses: 2 });
    g.give('Asha', 'AGRA', { houses: 3 });
    g.give('Asha', 'MUMBAI', { hotel: true });
    g.player('Asha').position = 7; // 7 + 9 = 16 CC
    g.roll('Asha', 4, 5);
    expect(g.state.turn.pending).toMatchObject({ amount: 5 * 100 + 500 });
  });

  it('Community Chest 9 with no buildings costs nothing', () => {
    const g = new TestGame();
    g.player('Asha').position = 7;
    g.roll('Asha', 4, 5);
    expect(g.state.turn.pending).toBeNull();
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('unverified card entry asks for manual resolution (pay / receive / none)', () => {
    const g = new TestGame();
    g.roll('Asha', 3, 4); // 7 → Chance 7 (not captured)
    expect(g.state.turn.phase).toBe('AWAITING_CARD');
    expect(g.state.turn.card?.verified).toBe(false);
    const r = g.act('Asha', { type: 'RESOLVE_CARD', resolution: 'RECEIVE', amount: 1500 });
    expect(r.transactions[0]).toMatchObject({ type: 'CARD_REWARD', amount: 1500, toPlayerId: g.id('Asha') });
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('manual card amount is capped and must be positive', () => {
    const g = new TestGame();
    g.roll('Asha', 3, 4);
    expect(() => g.act('Asha', { type: 'RESOLVE_CARD', resolution: 'PAY', amount: 0 })).toThrow('Enter the amount shown on the card.');
    expect(() => g.act('Asha', { type: 'RESOLVE_CARD', resolution: 'RECEIVE', amount: BUSINESS_MVP_RULES.cards.manualMaxAmount + 1 })).toThrow(/limited/);
  });
});

describe('bankruptcy and game end', () => {
  it('bankrupt player pays remaining cash to creditor, loses properties, turn advances', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.give('Asha', 'INDORE', { houses: 1 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 3000 });
    g.placeBefore('Asha', 'MUMBAI', 4);
    g.roll('Asha', 2, 2);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.player('Asha')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(g.balance('Bilal')).toBe(START + 3000);
    expect(g.state.properties.INDORE).toMatchObject({ ownerId: null, houses: 0 });
    expect(g.current).toBe('Bilal');
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 1 })).toThrow('You are out of the game.');
  });

  it('cannot declare bankruptcy when you can afford the payment', () => {
    const g = new TestGame();
    g.roll('Asha', 2, 2);
    expect(() => g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).toThrow('You can afford this payment.');
  });

  it('last player standing wins', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 100 });
    g.placeBefore('Asha', 'MUMBAI', 4);
    g.roll('Asha', 2, 2);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.status).toBe('FINISHED');
    expect(g.state.winnerId).toBe(g.id('Bilal'));
    expect(() => g.act('Bilal', { type: 'ROLL_DICE' })).toThrow('This game has finished.');
  });

  it('host can end a paused game; pause markers are cleared', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'PAUSE_GAME' });
    g.act('Asha', { type: 'END_GAME' });
    expect(g.state).toMatchObject({ status: 'FINISHED', pausedAt: null, pausedFrom: null });
  });

  it('host can end the game; highest net worth wins', () => {
    const g = new TestGame();
    g.give('Chitra', 'AIR_INDIA');
    expect(() => g.act('Bilal', { type: 'END_GAME' })).toThrow('Only the host can end the game.');
    g.act('Asha', { type: 'END_GAME' });
    expect(g.state.status).toBe('FINISHED');
    expect(g.state.winnerId).toBe(g.id('Chitra'));
  });
});
