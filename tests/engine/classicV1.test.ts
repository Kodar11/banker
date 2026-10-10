/**
 * Classic Mode V1 — rules that changed or were pinned down when the rule set was finalized:
 * building eligibility, building sell-back, net worth and the winner of an early end, and the
 * in-app rulebook staying in step with the values the engine enforces.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_RULES,
  buildingCost,
  BUSINESS_MVP_RULES as R,
  formatINR,
  getDeed,
  groupMembers,
  netWorth,
  PROPERTY_KEYS,
  propertyActionBlocker,
  RULE_SECTIONS,
  sellBuildingRefund,
  TOP_RULES,
  unmortgageCost,
  unpaidLoanInterest,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = R.startingCash;

describe('building — one property is enough', () => {
  it('the rule set says so', () => {
    expect(R.building).toMatchObject({ requireFullGroup: false, maxHouses: 3, hotelRequiresMaxHouses: true, onlyOnOwnTurn: true, sellBackRate: 0.5 });
  });

  it('a player who owns a single property of a colour can build on it', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'BUILD_HOUSE')).toBeNull();
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    expect(g.state.properties.MUMBAI.houses).toBe(1);
    expect(g.balance('Asha')).toBe(START - 7500);
  });

  it('other players owning the rest of the colour does not block building, including a hotel', () => {
    const g = new TestGame();
    for (const key of groupMembers('GREEN')) g.give('Bilal', key);
    g.give('Asha', 'INDORE', { houses: 3 });
    g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'INDORE' });
    expect(g.state.properties.INDORE).toMatchObject({ houses: 0, hotel: true, ownerId: g.id('Asha') });
  });

  it('you still cannot build on a property you do not own, or on a mortgaged one', () => {
    const g = new TestGame();
    g.give('Bilal', 'AGRA');
    g.give('Asha', 'INDORE', { mortgaged: true });
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'AGRA' })).toThrow("You don't own this property.");
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' })).toThrow('Unmortgage this property first.');
    expect(g.balance('Asha')).toBe(START);
  });

  it('progression is the same for every action: 3 houses, then a hotel that replaces them, then nothing more', () => {
    const g = new TestGame();
    g.giveGroup('Asha', 'INDORE'); // house 2,000; hotel 2,000
    expect(() => g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'INDORE' })).toThrow('Build 3 houses first.');
    for (let i = 0; i < 3; i += 1) g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' })).toThrow(/Maximum houses/);
    g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'INDORE' });
    expect(g.state.properties.INDORE).toMatchObject({ houses: 0, hotel: true });
    for (const type of ['BUILD_HOUSE', 'BUILD_HOTEL'] as const) {
      expect(() => g.act('Asha', { type, propertyKey: 'INDORE' })).toThrow('This site already has a hotel.');
    }
    expect(g.balance('Asha')).toBe(START - 4 * 2000);
  });

  it('only on your own turn', () => {
    const g = new TestGame();
    g.giveGroup('Bilal', 'INDORE');
    expect(g.current).toBe('Asha');
    expect(() => g.act('Bilal', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' })).toThrow('You can only build during your turn.');
  });
});

describe('selling buildings back — 50% of the original building cost', () => {
  it('a house refunds half its cost, one at a time, down to none', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 3 }); // house 7,500
    for (let left = 2; left >= 0; left -= 1) {
      const r = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
      expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['HOUSE_SALE', 3750]]);
      expect(g.state.properties.MUMBAI.houses).toBe(left);
    }
    expect(g.balance('Asha')).toBe(START + 3 * 3750);
    expect(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' })).toThrow('Nothing built here.');
    expect(g.state.properties.MUMBAI.houses).toBe(0);
  });

  it('a hotel refunds 50% of (hotel cost + the 3 houses it replaced), in one sale, and leaves the site empty', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { hotel: true }); // hotel 7,500 + 3 × 7,500 = 30,000
    expect(buildingCost(g.state.properties.MUMBAI)).toBe(30000);
    expect(sellBuildingRefund('MUMBAI', g.state.properties.MUMBAI)).toBe(15000);
    const r = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['HOTEL_SALE', 15000]]);
    expect(g.state.properties.MUMBAI).toMatchObject({ hotel: false, houses: 0 });
    // The houses the hotel replaced were refunded with it: there is nothing left to sell.
    expect(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' })).toThrow('Nothing built here.');
    expect(g.balance('Asha')).toBe(START + 15000);
  });

  it('building everything and selling it all back returns exactly half, for every city', () => {
    for (const key of PROPERTY_KEYS) {
      const deed = getDeed(key);
      if (deed.kind !== 'CITY') continue;
      const spent = 3 * deed.houseCost + deed.hotelCost;
      expect(sellBuildingRefund(key, { key, ownerId: 'x', houses: 0, hotel: true, mortgaged: false })).toBe(Math.floor(spent / 2));
      expect(sellBuildingRefund(key, { key, ownerId: 'x', houses: 2, hotel: false, mortgaged: false })).toBe(Math.floor(deed.houseCost / 2));
      expect(sellBuildingRefund(key, { key, ownerId: 'x', houses: 0, hotel: false, mortgaged: false })).toBe(0);
    }
  });

  it('buildings can be sold when it is not your turn, but never by someone else', () => {
    const g = new TestGame();
    g.give('Bilal', 'INDORE', { houses: 1 });
    expect(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'INDORE' })).toThrow("You don't own this property.");
    g.act('Bilal', { type: 'SELL_BUILDING', propertyKey: 'INDORE' });
    expect(g.balance('Bilal')).toBe(START + 1000);
  });

  it('the property screen and the engine read the same refusal', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 1, mortgaged: true });
    const why = propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'SELL_BUILDING');
    expect(why).toBe('Unmortgage this property first.');
    expect(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' })).toThrow(why!);
  });
});

describe('net worth — one calculation', () => {
  it('cash + deed prices (less mortgage value when mortgaged) + buildings at cost − loans owed', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 }); // 8,500 + 15,000
    g.give('Asha', 'INDORE', { hotel: true }); // 1,500 + (2,000 + 3 × 2,000)
    g.give('Asha', 'RAILWAY', { mortgaged: true }); // 9,500 − 4,750
    g.give('Asha', 'DELHI', { houses: 1, mortgaged: true }); // 6,000 − 4,000 + 5,000
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 2000 });
    const cash = START + 5000 - 2000;
    expect(netWorth(g.state, g.id('Asha'))).toBe(cash + 23500 + 9500 + 4750 + 7000 - 3000);
  });

  it('borrowing does not change net worth; loan interest only counts once it has been charged', () => {
    const g = new TestGame();
    const before = netWorth(g.state, g.id('Asha'));
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 }); // interest 2,000
    expect(netWorth(g.state, g.id('Asha'))).toBe(before);
    expect(unpaidLoanInterest(g.state.loans, g.id('Asha'))).toBe(0);
    // Charged at Start while unable to pay: owed, so it counts against net worth until it is paid.
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START + 20000 - 100 });
    g.placeAt('Asha', 34);
    g.roll('Asha', 2, 3);
    expect(g.state.turn.pending).toMatchObject({ reason: 'LOAN_INTEREST', amount: 2000 });
    expect(unpaidLoanInterest(g.state.loans, g.id('Asha'))).toBe(2000);
    expect(netWorth(g.state, g.id('Asha'))).toBe(100 + R.start.passReward - 20000 - 2000);
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1000 });
    g.act('Asha', { type: 'PAY_INTEREST' });
    expect(unpaidLoanInterest(g.state.loans, g.id('Asha'))).toBe(0);
    expect(netWorth(g.state, g.id('Asha'))).toBe(100 + R.start.passReward + 1000 - 2000 - 20000);
  });

  it('host ends early: the winner and the published standings are that same calculation', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI', { hotel: true, mortgaged: true });
    g.give('Chitra', 'AIR_INDIA');
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 10000 });
    const expected = ['Asha', 'Bilal', 'Chitra'].map((n) => ({ playerId: g.id(n), netWorth: netWorth(g.state, g.id(n)) })).sort((a, b) => b.netWorth - a.netWorth);
    const r = g.act('Asha', { type: 'END_GAME' });
    // Bilal: 25,000 + (8,500 − 4,250) + 30,000.
    expect(expected[0]).toEqual({ playerId: g.id('Bilal'), netWorth: START + 4250 + 30000 });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: g.id('Bilal') });
    expect(r.events.find((e) => e.type === 'GAME_FINISHED')!.payload).toMatchObject({ reason: 'HOST_ENDED', winnerId: g.id('Bilal'), standings: expected });
  });

  it('bankrupt players are not ranked; last player standing wins whatever the net worth', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 100 });
    g.placeBefore('Asha', 'MUMBAI', 4);
    g.roll('Asha', 2, 2);
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: g.id('Bilal') });
    const standings = r.events.find((e) => e.type === 'GAME_FINISHED')!.payload.standings as { playerId: string }[];
    expect(standings.map((s) => s.playerId)).toEqual([g.id('Bilal')]);
  });
});

describe('the in-app rulebook is written from the rule set', () => {
  const text = (titles?: string[]) =>
    ALL_RULES.filter((r) => !titles || titles.includes(r.title))
      .flatMap((r) => [r.title, ...r.lines, r.example ?? ''])
      .join('\n');

  it('opens with the five rules to know, in order', () => {
    expect(TOP_RULES.map((r) => r.title)).toEqual([
      'Take turns, roll, and move',
      'Buy properties and collect rent',
      'Own colour sets and build',
      'Manage your money',
      'Trade, negotiate, and win',
    ]);
    for (const rule of TOP_RULES) {
      expect(rule.lines.length).toBeGreaterThanOrEqual(2);
      expect(rule.lines.length).toBeLessThanOrEqual(3);
    }
  });

  it('then three ranked sections', () => {
    expect(RULE_SECTIONS.map((s) => [s.title, s.rules.map((r) => r.title)])).toEqual([
      [
        'Property and money',
        ['Buying and auctions', 'Rent', 'Transport and utility rent', 'Mortgages', 'Building and selling', 'Loans', 'Trading', 'Income Tax and Wealth Taxes', 'Not enough money and bankruptcy'],
      ],
      ['Special squares and cards', ['Start', 'Jail', 'Rest House', 'Club', 'Chance and Community Chest', 'Card moves and the Start reward']],
      ['Game flow and resolution', ['Turn order and dice', 'Undo', 'Winning', 'Net worth', 'Leaving, pausing and expiry']],
    ]);
    const titles = ALL_RULES.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('carries no development wording, and every amount uses the rupee symbol', () => {
    const all = text();
    expect(all).not.toMatch(/assum|MVP|verif|unconfirmed|not confirmed|configured|engine|server|TODO|V1|\bv\d/i);
    // No bare "Rs" and no amount written without the symbol where one is meant.
    expect(all).not.toMatch(/\bRs\.?\b|INR/);
    for (const rule of ALL_RULES) for (const line of rule.lines) expect(line.length).toBeLessThanOrEqual(230);
  });

  it.each([
    ['starting cash', ['Manage your money'], formatINR(R.startingCash)],
    ['Start reward', ['Take turns, roll, and move', 'Start'], formatINR(R.start.passReward)],
    ['colour-set threshold', ['Own colour sets and build', 'Rent'], `${R.rent.sameColorThreshold} or more properties`],
    ['houses before a hotel', ['Own colour sets and build', 'Building and selling'], `up to ${R.building.maxHouses} houses`],
    ['building sell-back', ['Building and selling'], `${R.building.sellBackRate * 100}% of what they cost`],
    ['unmortgage interest', ['Mortgages'], `plus ${R.mortgage.unmortgageInterestRate * 100}%`],
    ['mortgage example payout', ['Mortgages'], formatINR(getDeed('MUMBAI').mortgageValue)],
    ['mortgage example repayment', ['Mortgages'], formatINR(unmortgageCost('MUMBAI'))],
    ['Income Tax per property', ['Income Tax and Wealth Taxes'], `${formatINR(R.incomeTax.perProperty)} for every property`],
    ['Income Tax cap', ['Income Tax and Wealth Taxes'], `at most ${formatINR(R.incomeTax.max)}`],
    ['Wealth Taxes per house', ['Income Tax and Wealth Taxes'], `${formatINR(R.wealthTax.perHouse)} for every house`],
    ['Wealth Taxes per hotel', ['Income Tax and Wealth Taxes'], `${formatINR(R.wealthTax.perHotel)} for every hotel`],
    ['Club', ['Club'], `Pay ${formatINR(R.club.payEachPlayer)} to every other player`],
    ['Jail fine', ['Jail'], `pay ${formatINR(R.jail.fine)}`],
    ['Jail turns', ['Jail'], `After ${R.jail.maxTurns} missed turns`],
    ['Rest House', ['Rest House'], `collect ${formatINR(R.restHouse.collectFromEachPlayer)} from every other player`],
    ['manual card limit', ['Chance and Community Chest'], formatINR(R.cards.manualMaxAmount)],
    ['loan minimum', ['Loans'], `at least ${formatINR(R.loans.minAmount)}`],
    ['loan step', ['Loans'], `steps of ${formatINR(R.loans.step)}`],
    ['loan maximum', ['Loans'], formatINR(R.loans.maxOutstandingPrincipal)],
    ['loan interest', ['Loans'], `${R.loans.interestRatePercent}% of the amount you borrowed`],
    ['auction opening bid', ['Buying and auctions'], `at least ${formatINR(R.auction.minimumOpeningBid)}`],
    ['auction increment', ['Buying and auctions'], `${formatINR(R.auction.minimumIncrement)} higher`],
    ['auction countdown', ['Buying and auctions'], `${R.auction.bidTimerSeconds} seconds`],
    ['players', ['Turn order and dice'], `${R.players.min} to ${R.players.max} players`],
    ['undo depth', ['Undo'], `last ${R.undo.maxDepth}`],
    ['expiry', ['Leaving, pausing and expiry'], `${R.session.ttlHours} hours`],
    ['transfer limit', ['Leaving, pausing and expiry'], formatINR(R.transfers.maxAmount)],
  ])('states the %s the engine uses', (_what, titles, expected) => {
    expect(text(titles)).toContain(expected);
  });

  it('states the rules that are switches, the way they are switched', () => {
    expect(R.dice.doublesGrantExtraRoll).toBe(false);
    expect(R.building.requireFullGroup).toBe(false);
    expect(text(['Own colour sets and build'])).toContain('you do not need the whole colour');
    expect(text(['Building and selling'])).toContain('even if it is your only one of that colour');
    expect(text()).not.toMatch(/Own all \d+ properties|only when you own all/);
    expect(text(['Take turns, roll, and move'])).toContain('Doubles do not give an extra roll.');
    expect(R.loans.interestEveryCircuit).toBe(false);
    expect(text(['Loans'])).toContain('charged once');
    expect(R.property.pairCountsMortgagedPartner).toBe(false);
    expect(text(['Transport and utility rent'])).toContain('only while the partner property is not mortgaged');
    expect(R.mortgage.buildingsOnMortgage).toBe('STAY_ATTACHED_INACTIVE');
    expect(text(['Mortgages'])).toMatch(/stays yours, and so do its houses or hotel\. You are paid nothing extra/);
    expect(R.trades).toMatchObject({ requireNoBuildings: false, allowMortgaged: true });
    expect(text(['Trading'])).toContain('traded together with its houses or hotel: they go to the new owner');
    expect(text(['Trading'])).toContain('stays mortgaged');
    expect(text()).not.toMatch(/cannot be traded/);
    expect(R.cards).toMatchObject({ goBackToMumbaiDirection: 'FORWARD', goBackToMumbaiResolvesLanding: true, jailAndRestHouseMovesAreDirect: true });
    expect(R.auction).toMatchObject({ declinerMayBid: true, bidGraceSeconds: 1 });
    expect(text(['Buying and auctions'])).toContain('including the player who declined');
    // The server-only delivery grace is never described to players.
    expect(text()).not.toMatch(/grace/i);
  });

  it('lists every transport and utility deed with the rents on its card', () => {
    const transport = text(['Transport and utility rent']);
    for (const key of PROPERTY_KEYS) {
      const deed = getDeed(key);
      if (deed.kind !== 'TRANSPORT_UTILITY') continue;
      expect(transport).toContain(`${deed.name}: `);
      const [low, high] = deed.rent.type === 'FIXED' ? [deed.rent.base, deed.rent.pairedRent] : [deed.rent.multiplier, deed.rent.pairedMultiplier];
      expect(transport).toContain(formatINR(low));
      expect(transport).toContain(formatINR(high));
    }
  });
});
