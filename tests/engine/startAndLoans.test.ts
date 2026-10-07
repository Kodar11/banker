import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, loanTerms, nextInterestCircuit, positionOfSpecial } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;
const REWARD = BUSINESS_MVP_RULES.start.passReward;
const RATE = BUSINESS_MVP_RULES.loans.interestRatePercent;
const startRewards = (g: TestGame) => g.ledger.filter((t) => t.type === 'START_REWARD');
const interest = (g: TestGame) => g.ledger.filter((t) => t.type === 'LOAN_INTEREST');

/** Ends the current turn and lets the other two players take a harmless turn (Wealth Taxes with no buildings: nothing to pay). */
function cycleBackTo(g: TestGame, name: string) {
  g.act(g.current, { type: 'END_TURN' });
  while (g.current !== name) {
    const who = g.current;
    g.landOn(who, positionOfSpecial('WEALTH_TAX'), 4);
    g.act(who, { type: 'END_TURN' });
  }
}

describe('Start — ₹1,500 when a move completes a circuit', () => {
  it('normal crossing (wraps 33 → 2)', () => {
    const g = new TestGame();
    g.placeAt('Asha', 33);
    const r = g.roll('Asha', 2, 3);
    expect(g.player('Asha').position).toBe(2);
    expect(r.transactions[0]).toMatchObject({ type: 'START_REWARD', amount: REWARD, fromPlayerId: null, toPlayerId: g.id('Asha') });
    expect(g.player('Asha').circuits).toBe(1);
    expect(g.state.turn.passedStart).toBe(true);
  });

  it('landing exactly on Start completes the circuit', () => {
    const g = new TestGame();
    g.placeAt('Asha', 30);
    g.roll('Asha', 3, 3);
    expect(g.player('Asha').position).toBe(0);
    expect(startRewards(g)).toHaveLength(1);
    expect(g.balance('Asha')).toBe(START + REWARD);
  });

  it('a move that does not reach Start pays nothing', () => {
    const g = new TestGame();
    g.placeAt('Asha', 20);
    g.roll('Asha', 3, 3);
    expect(startRewards(g)).toHaveLength(0);
    expect(g.state.turn.passedStart).toBe(false);
  });

  it('merely starting a move from Start (index 0) pays nothing', () => {
    const g = new TestGame();
    expect(g.player('Asha').position).toBe(0);
    g.roll('Asha', 1, 2);
    expect(startRewards(g)).toHaveLength(0);
  });

  it('card movement crossing Start pays (Chance odd 9 → Mumbai)', () => {
    const g = new TestGame();
    g.landOn('Asha', 20, 9);
    expect(startRewards(g)).toHaveLength(1);
    expect(g.player('Asha').circuits).toBe(1);
  });

  it('a direct card move past index 0 (Go to Jail from the last Community Chest) pays nothing', () => {
    const g = new TestGame();
    g.landOn('Asha', 29, 3);
    expect(g.player('Asha').position).toBe(positionOfSpecial('JAIL'));
    expect(startRewards(g)).toHaveLength(0);
    expect(g.player('Asha').circuits).toBe(0);
  });
});

describe('loans — interest is charged at the NEXT Start, not when borrowing', () => {
  it('borrowing ₹5,000 gives exactly ₹5,000 and owes no interest yet', () => {
    const g = new TestGame();
    const r = g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    expect(r.transactions).toMatchObject([{ type: 'LOAN_DISBURSEMENT', amount: 5000, toPlayerId: g.id('Asha'), fromPlayerId: null }]);
    expect(g.balance('Asha')).toBe(START + 5000);
    expect(g.state.loans[0]).toMatchObject({
      principal: 5000,
      totalOwed: 5000,
      outstanding: 5000,
      interestAmount: loanTerms(5000).interest,
      interestCharges: 0,
      createdAtCircuit: 0,
      status: 'ACTIVE',
    });
    expect(loanTerms(5000).interest).toBe((5000 * RATE) / 100);
    expect(nextInterestCircuit(g.state.loans[0]!)).toBe(1);
  });

  it('loan before Start: moving without reaching Start charges nothing', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.roll('Asha', 1, 2);
    expect(interest(g)).toHaveLength(0);
  });

  it('loan while close to Start: the very next crossing charges the interest', () => {
    const g = new TestGame();
    g.placeAt('Asha', 34);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    const r = g.roll('Asha', 2, 3); // 34 → 3 (Railway)
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['START_REWARD', REWARD],
      ['LOAN_INTEREST', 500],
    ]);
    expect(g.balance('Asha')).toBe(START + 5000 + REWARD - 500);
    expect(g.state.loans[0]).toMatchObject({ interestCharges: 1, interestPaid: 500, outstanding: 5000 });
    expect(g.state.turn.phase).toBe('AWAITING_DECISION'); // turn continues normally on Railway
  });

  it('landing exactly on Start charges the interest', () => {
    const g = new TestGame();
    g.placeAt('Asha', 30);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 2000 });
    g.roll('Asha', 3, 3);
    expect(interest(g).map((t) => t.amount)).toEqual([200]);
  });

  it('next cycle / multiple circuits: interest is charged once (configured), never every turn', () => {
    const g = new TestGame();
    g.placeAt('Asha', 34);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.roll('Asha', 2, 3); // circuit 1 → interest
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    for (const n of ['Asha', 'Bilal', 'Chitra']) g.act(n, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
    for (let lap = 2; lap <= 3; lap += 1) {
      cycleBackTo(g, 'Asha');
      g.landOn('Asha', positionOfSpecial('WEALTH_TAX'), 4); // turns without passing Start
      expect(interest(g)).toHaveLength(1);
      cycleBackTo(g, 'Asha');
      g.placeAt('Asha', 32);
      g.roll('Asha', 2, 2); // lands on Start: circuit `lap`
      expect(g.player('Asha').circuits).toBe(lap);
    }
    expect(BUSINESS_MVP_RULES.loans.interestEveryCircuit).toBe(false);
    expect(interest(g)).toHaveLength(1);
    expect(nextInterestCircuit(g.state.loans[0]!)).toBeNull();
  });

  it('a loan taken after a crossing waits for the following Start', () => {
    const g = new TestGame();
    g.placeAt('Asha', 30);
    g.roll('Asha', 3, 3); // circuit 1, no loan yet
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 3000 });
    expect(g.state.loans[0]).toMatchObject({ createdAtCircuit: 1 });
    expect(nextInterestCircuit(g.state.loans[0]!)).toBe(2);
    expect(interest(g)).toHaveLength(0);
  });

  it('multiple loans are all charged at the next Start, as one payment', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 3000 });
    g.placeAt('Asha', 33);
    g.roll('Asha', 2, 1); // lands on Start
    expect(interest(g).map((t) => t.amount)).toEqual([800]);
    expect(g.state.loans.map((l) => l.interestPaid)).toEqual([500, 300]);
  });

  it('a loan repaid before reaching Start owes no interest', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 5000 });
    expect(g.state.loans[0]!.status).toBe('REPAID');
    g.placeAt('Asha', 33);
    g.roll('Asha', 2, 1);
    expect(interest(g)).toHaveLength(0);
  });

  it('partial then full repayment of the principal closes the loan', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'REQUEST_LOAN', amount: 2000 });
    const id = g.state.loans[0]!.id;
    g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1000 });
    expect(g.state.loans[0]).toMatchObject({ outstanding: 1000, status: 'ACTIVE' });
    expect(() => g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1500 })).toThrow('You only owe ₹1,000 on this loan.');
    g.act('Bilal', { type: 'REPAY_LOAN', loanId: id, amount: 1000 });
    expect(g.state.loans[0]).toMatchObject({ outstanding: 0, status: 'REPAID' });
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

  describe('insufficient money when interest becomes due', () => {
    function brokeAtStart() {
      const g = new TestGame();
      g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 }); // interest 2,000
      // Leave Asha with ₹100; the Start reward (1,500) is still short of 2,000.
      g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START + 20000 - 100 });
      g.placeAt('Asha', 34);
      const r = g.roll('Asha', 2, 3); // → Railway, after Start
      return { g, r };
    }

    it('the turn rests on a LOAN_INTEREST payment (same rules as any debt)', () => {
      const { g } = brokeAtStart();
      expect(g.balance('Asha')).toBe(100 + REWARD);
      expect(g.state.turn).toMatchObject({
        phase: 'AWAITING_PAYMENT',
        pending: { kind: 'PAYMENT', reason: 'LOAN_INTEREST', amount: 2000, toPlayerId: null },
        followUp: { kind: 'RESOLVE_LANDING' },
      });
      expect(() => g.act('Asha', { type: 'PAY_INTEREST' })).toThrow(/Not enough money/);
      expect(() => g.act('Asha', { type: 'END_TURN' })).toThrow('Finish your current action first.');
    });

    it('after raising money and paying, the landing square is resolved', () => {
      const { g } = brokeAtStart();
      g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1000 });
      g.act('Asha', { type: 'PAY_INTEREST' });
      expect(g.state.loans[0]).toMatchObject({ interestPaid: 2000 });
      expect(g.state.turn).toMatchObject({ phase: 'AWAITING_DECISION', pending: { kind: 'BUY', propertyKey: 'RAILWAY' }, followUp: null });
    });

    it('or the player declares bankruptcy to the bank', () => {
      const { g } = brokeAtStart();
      g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
      expect(g.player('Asha').status).toBe('BANKRUPT');
      expect(g.state.loans[0]!.status).toBe('DEFAULTED');
      expect(g.ledger.at(-1)).toMatchObject({ type: 'BANKRUPTCY_SETTLEMENT', toPlayerId: null, amount: 100 + REWARD });
    });
  });
});
