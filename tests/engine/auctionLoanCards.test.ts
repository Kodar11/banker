import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, minimumNextBid, positionOfSpecial } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;

function auctionGame() {
  const g = new TestGame();
  g.roll('Asha', 1, 2); // Railway
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

describe('bankruptcy and game end', () => {
  it('bankrupt player pays remaining cash to creditor, loses properties, turn advances', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.give('Asha', 'INDORE', { houses: 1 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 1500 });
    g.placeBefore('Asha', 'MUMBAI', 4); // passes Start: 1,500 + 1,500 = 3,000
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
    g.landOn('Asha', positionOfSpecial('CLUB'), 5); // Club: ₹100 to each of 2 players
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
