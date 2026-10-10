import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, netWorth, totalMoneyInPlay } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;

describe('property purchase', () => {
  it('buys an unowned property: money to bank, ownership set, transaction recorded', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2); // Railway (square 3) 9500
    expect(g.state.turn.pending).toEqual({ kind: 'BUY', propertyKey: 'RAILWAY', price: 9500 });
    const r = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Asha'));
    expect(g.balance('Asha')).toBe(START - 9500);
    expect(r.transactions).toMatchObject([{ type: 'PROPERTY_PURCHASE', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 9500, propertyKey: 'RAILWAY' }]);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('a second BUY (double tap) is rejected and charges nothing', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(() => g.act('Asha', { type: 'BUY_PROPERTY' })).toThrow('There is no property to buy right now.');
    expect(g.balance('Asha')).toBe(START - 9500);
    expect(g.ledger.filter((t) => t.type === 'PROPERTY_PURCHASE')).toHaveLength(1);
  });

  it('rejects purchase with insufficient funds', () => {
    const g = new TestGame();
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 1000 });
    g.roll('Asha', 3, 2);
    expect(() => g.act('Asha', { type: 'BUY_PROPERTY' })).toThrow('Not enough money for this purchase.');
    expect(g.state.properties.MUMBAI.ownerId).toBeNull();
  });

  it('a property has at most one owner — landing on an owned property never offers it for sale', () => {
    const g = new TestGame();
    g.give('Bilal', 'RAILWAY');
    g.roll('Asha', 1, 2);
    expect(g.state.turn.pending?.kind).toBe('PAYMENT');
    expect(() => g.act('Asha', { type: 'BUY_PROPERTY' })).toThrow();
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Bilal'));
  });
});

describe('rent', () => {
  it('pays rent to the owner', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI');
    g.placeBefore('Asha', 'MUMBAI', 7);
    g.roll('Asha', 3, 4);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', amount: 1200, toPlayerId: g.id('Bilal') });
    const r = g.act('Asha', { type: 'PAY_RENT' });
    expect(r.transactions).toMatchObject([{ type: 'RENT_PAYMENT', amount: 1200, fromPlayerId: g.id('Asha'), toPlayerId: g.id('Bilal') }]);
    // Mumbai is square 1, so reaching it from behind passes Start (+₹1,500).
    expect(g.balance('Asha')).toBe(START + BUSINESS_MVP_RULES.start.passReward - 1200);
    expect(g.balance('Bilal')).toBe(START + 1200);
    expect(() => g.act('Asha', { type: 'PAY_RENT' })).toThrow('There is nothing to pay right now.');
  });

  it('dice-based rent uses the roll that landed the player', () => {
    const g = new TestGame();
    g.give('Bilal', 'MOTOR_BOAT');
    g.give('Bilal', 'ELECTRIC_COMPANY');
    g.placeBefore('Asha', 'MOTOR_BOAT', 9);
    g.roll('Asha', 4, 5);
    expect(g.state.turn.pending).toMatchObject({ amount: 9 * 200 });
  });

  it('no rent when landing on your own property or a mortgaged one', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY');
    g.roll('Asha', 1, 2);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    g.act('Asha', { type: 'END_TURN' });
    g.give('Asha', 'MUMBAI', { mortgaged: true });
    g.placeBefore('Bilal', 'MUMBAI', 4);
    g.roll('Bilal', 2, 2);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('cannot pay rent without enough money; must raise funds or go bankrupt', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI', { houses: 0, hotel: true }); // 9000
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 3500 });
    g.placeBefore('Asha', 'MUMBAI', 6); // passes Start: 3,500 + 1,500 = 5,000
    g.roll('Asha', 3, 3);
    expect(() => g.act('Asha', { type: 'PAY_RENT' })).toThrow(/Not enough money/);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.act('Asha', { type: 'PAY_RENT' });
    expect(g.balance('Asha')).toBe(1000);
  });
});

describe('tax and transfers', () => {
  it('Income Tax creates a payment to the bank', () => {
    const g = new TestGame();
    g.give('Asha', 'DELHI');
    g.give('Asha', 'SHIMLA');
    g.roll('Asha', 2, 3); // Income Tax (square 5)
    expect(g.state.turn.pending).toMatchObject({ reason: 'TAX', amount: 100, toPlayerId: null });
    const r = g.act('Asha', { type: 'PAY_TAX' });
    expect(r.transactions[0]).toMatchObject({ type: 'TAX_PAYMENT', toPlayerId: null, amount: 100 });
    expect(g.balance('Asha')).toBe(START - 100);
  });

  it('PAY_RENT cannot be used to settle a tax (types must match)', () => {
    const g = new TestGame();
    g.give('Asha', 'DELHI');
    g.roll('Asha', 2, 3);
    expect(() => g.act('Asha', { type: 'PAY_RENT' })).toThrow('There is nothing to pay right now.');
  });

  it('player-to-player transfer works at any time, even off-turn', () => {
    const g = new TestGame();
    const r = g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 750, memo: 'deal' });
    expect(r.transactions[0]).toMatchObject({ type: 'PLAYER_TRANSFER', amount: 750, memo: 'deal' });
    expect(g.balance('Chitra')).toBe(START - 750);
    expect(g.balance('Bilal')).toBe(START + 750);
  });

  it('rejects transfers to self, overdrafts and non-integer amounts', () => {
    const g = new TestGame();
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 10 })).toThrow('Choose another player.');
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START + 1 })).toThrow('Not enough money');
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 10.5 })).toThrow('That action is not valid.');
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: -10 })).toThrow('That action is not valid.');
  });
});

describe('houses, hotels, mortgage', () => {
  it('builds up to 3 houses then a hotel, charging deed costs', () => {
    const g = new TestGame();
    g.giveGroup('Asha', 'MUMBAI');
    for (let i = 1; i <= 3; i += 1) {
      g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
      expect(g.state.properties.MUMBAI.houses).toBe(i);
    }
    expect(g.balance('Asha')).toBe(START - 3 * 7500);
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' })).toThrow(/Maximum houses/);
    expect(() => g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'MUMBAI' })).toThrow('Not enough money for a hotel.');
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 5000 });
    g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'MUMBAI' });
    expect(g.state.properties.MUMBAI).toMatchObject({ hotel: true, houses: 0 });
    expect(g.ledger.filter((t) => t.type === 'HOUSE_PURCHASE').map((t) => t.amount)).toEqual([7500, 7500, 7500]);
    expect(g.ledger.find((t) => t.type === 'HOTEL_PURCHASE')?.amount).toBe(7500);
  });

  it('hotel requires 3 houses; cannot build on transport, off-turn, or on others’ property', () => {
    const g = new TestGame();
    g.giveGroup('Asha', 'DELHI');
    g.give('Asha', 'RAILWAY');
    g.give('Bilal', 'AGRA');
    expect(() => g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'DELHI' })).toThrow('Build 3 houses first.');
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'RAILWAY' })).toThrow('You can only build on city sites.');
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'AGRA' })).toThrow("You don't own this property.");
    expect(() => g.act('Bilal', { type: 'BUILD_HOUSE', propertyKey: 'AGRA' })).toThrow('You can only build during your turn.');
  });

  it('sells buildings back at 50%', () => {
    const g = new TestGame();
    g.giveGroup('Asha', 'INDORE');
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    const r = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'INDORE' });
    expect(r.transactions[0]).toMatchObject({ type: 'HOUSE_SALE', amount: 1000, toPlayerId: g.id('Asha') });
    expect(g.state.properties.INDORE.houses).toBe(0);
  });

  it('mortgage pays the deed mortgage value; unmortgage costs value + 10%', () => {
    const g = new TestGame();
    g.give('Bilal', 'DELHI');
    g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' });
    expect(g.balance('Bilal')).toBe(START + 4000);
    expect(() => g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' })).toThrow('Already mortgaged.');
    g.act('Bilal', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'DELHI' });
    expect(g.balance('Bilal')).toBe(START + 4000 - 4400);
    expect(g.ledger.map((t) => t.type)).toContain('UNMORTGAGE');
  });

  it('sell property to bank for mortgage value (buildings must be sold first)', () => {
    const g = new TestGame();
    g.give('Asha', 'AGRA', { houses: 1 });
    expect(() => g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'AGRA' })).toThrow('Sell the buildings first.');
    g.give('Asha', 'PATNA');
    g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'PATNA' });
    expect(g.state.properties.PATNA.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(START + 1000);
  });
});

describe('net worth', () => {
  it('cash + property at deed price + buildings at cost − loans', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE', { houses: 2 });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 });
    // Loan interest is not owed until the next Start, so the debt is the principal.
    expect(netWorth(g.state, g.id('Asha'))).toBe(START + 1000 + 1500 + 2 * 2000 - 1000);
  });
});

describe('money invariant under random play', () => {
  it('ledger always equals balances, no negatives, across many seeded games', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) % 2 ** 31;
        return s / 2 ** 31;
      };
      const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
      for (let step = 0; step < 300 && g.state.status === 'ACTIVE'; step += 1) {
        const who = g.current;
        const phase = g.state.turn.phase;
        const pending = g.state.turn.pending;
        try {
          if (rand() < 0.1) {
            const others = g.state.players.filter((p) => p.status === 'ACTIVE' && p.name !== who);
            if (others.length) g.act(who, { type: 'TRANSFER_MONEY', toPlayerId: pick(others).id, amount: 1 + Math.floor(rand() * 3000) });
            continue;
          }
          if (rand() < 0.05) {
            // Off-turn trades and their answers, mortgages and loans interleave with turns.
            const others = g.state.players.filter((p) => p.status === 'ACTIVE' && p.name !== who);
            const mine = Object.values(g.state.properties).filter((p) => p.ownerId === g.id(who));
            const open = g.state.trades.find((t) => t.status === 'PENDING');
            if (open) {
              const to = g.state.players.find((p) => p.id === open.toPlayerId)!.name;
              g.act(to, { type: rand() < 0.6 ? 'ACCEPT_TRADE' : 'REJECT_TRADE', tradeId: open.id });
            } else if (others.length && mine.length) {
              g.act(who, {
                type: 'CREATE_TRADE',
                toPlayerId: pick(others).id,
                offeredPropertyKeys: [pick(mine).key],
                requestedPropertyKeys: [],
                offeredMoney: 0,
                requestedMoney: 100 + Math.floor(rand() * 20) * 100,
              });
            }
            if (mine.length && rand() < 0.5) g.act(who, { type: 'MORTGAGE_PROPERTY', propertyKey: pick(mine).key });
            if (rand() < 0.3) g.act(who, { type: 'REQUEST_LOAN', amount: 1000 });
            continue;
          }
          if (phase === 'AWAITING_ROLL' && g.player(who).inJail) {
            g.act(who, { type: g.balance(who) >= BUSINESS_MVP_RULES.jail.fine && rand() < 0.5 ? 'PAY_JAIL_FINE' : 'STAY_IN_JAIL' });
          } else if (phase === 'AWAITING_ROLL') g.roll(who, 1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6));
          else if (phase === 'AWAITING_DECISION') g.act(who, { type: rand() < 0.6 ? 'BUY_PROPERTY' : 'DECLINE_PROPERTY' });
          else if (phase === 'AUCTION') {
            const a = g.state.auction!;
            const bidder = pick(a.participantIds.filter((id) => !a.passedIds.includes(id)));
            const name = g.state.players.find((p) => p.id === bidder)!.name;
            if (rand() < 0.5 && bidder !== a.highBidderId) g.act(name, { type: 'PLACE_BID', auctionId: a.id, amount: (a.highBid ?? 0) + 100 + Math.floor(rand() * 5) * 100 });
            else if (bidder !== a.highBidderId) g.act(name, { type: 'PASS_AUCTION', auctionId: a.id });
            else {
              g.advance(60);
              g.act(name, { type: 'CLOSE_AUCTION', auctionId: a.id });
            }
          } else if (phase === 'AWAITING_PAYMENT' && pending?.kind === 'PAYMENT') {
            const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', LOAN_INTEREST: 'PAY_INTEREST', CLUB: 'PAY_CLUB' } as const;
            if (g.balance(who) >= pending.amount) g.act(who, { type: pay[pending.reason] });
            else if (rand() < 0.5) g.act(who, { type: 'REQUEST_LOAN', amount: 1000 });
            else g.act(who, { type: 'DECLARE_BANKRUPTCY' });
          } else if (phase === 'AWAITING_CARD') {
            g.act(who, { type: 'RESOLVE_CARD', resolution: pick(['PAY', 'RECEIVE', 'NONE'] as const), amount: 500 });
          } else if (phase === 'TURN_COMPLETE') {
            const mine = Object.values(g.state.properties).filter((p) => p.ownerId === g.id(who));
            if (mine.length && rand() < 0.3) g.act(who, { type: 'BUILD_HOUSE', propertyKey: pick(mine).key });
            else g.act(who, { type: 'END_TURN' });
          }
        } catch (error) {
          // Rejected actions are fine; they must not have changed anything (TestGame only absorbs successes).
          if (!(error as Error).name?.includes('GameError')) throw error;
        }
      }
      g.assertInvariants();
      // Bank is the only source/sink: net bank flow equals money in play.
      const bankOut = g.ledger.filter((t) => t.fromPlayerId === null).reduce((a, t) => a + t.amount, 0);
      const bankIn = g.ledger.filter((t) => t.toPlayerId === null).reduce((a, t) => a + t.amount, 0);
      expect(totalMoneyInPlay(g.state)).toBe(bankOut - bankIn);
    }
  });
});
