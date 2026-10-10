import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, INTERMEDIATE_RULES } from '@/engine/index.ts';
import {
  cashAfter,
  classicLoanInterest,
  creditScoresAfter,
  futureValue,
  growthSeries,
  houseSellBack,
  incomeTaxFor,
  mortgageTerms,
  netCashFlow,
  presentValue,
  repaymentSchedule,
  totalRepaid,
} from '@/features/learning/calc';
import { FUTURE_VALUE_STORY, LOAN_STORY, MORTGAGE_STORY } from '@/features/learning/lessons';

describe('time value of money', () => {
  it('present value: ₹12,000 in two years at 10% is about ₹9,917 today', () => {
    expect(presentValue(12000, 10, 2)).toBe(9917);
    // 12000 / 1.21 = 9917.355…, rounded once, half up.
    expect(presentValue(12000, 10, 2)).toBe(Math.round(12000 / 1.1 ** 2));
    expect(presentValue(12000, 10, 2)).toBeLessThan(10000);
  });

  it('present value turns the other way at a lower alternative return', () => {
    expect(presentValue(12000, 9, 2)).toBeGreaterThan(10000);
  });

  it('future value: ₹5,000 at 5% for five years is about ₹6,381', () => {
    expect(futureValue(5000, 5, 5)).toBe(6381);
    expect(futureValue(10000, 10, 2)).toBe(12100);
    expect(futureValue(5000, 0, 5)).toBe(5000);
    expect(futureValue(5000, 5, 0)).toBe(5000);
  });

  it('compounding series: every year is rounded from the original amount, so the last year equals the formula', () => {
    const series = growthSeries(5000, 5, 5);
    expect(series).toEqual([5000, 5250, 5513, 5788, 6078, 6381]);
    expect(series[5]).toBe(futureValue(5000, 5, 5));
    series.forEach((value, year) => expect(value).toBe(Math.round(5000 * 1.05 ** year)));
    // Growth accelerates: that is the point of the story.
    expect(series[5]! - series[4]!).toBeGreaterThan(series[1]! - series[0]!);
  });

  it('partial investment and the predefined future-value paths', () => {
    expect(futureValue(3000, 5, 5)).toBe(3829);
    const { price, years, alternatives } = FUTURE_VALUE_STORY;
    expect(alternatives.map((a) => futureValue(price, a.ratePercent, years))).toEqual([7347, 5520, 5000, 4294]);
  });

  it('present value and future value undo each other to within a rupee', () => {
    for (const [amount, rate, years] of [[10000, 10, 2], [5000, 5, 5], [7300, 8, 3]] as const) {
      expect(Math.abs(presentValue(futureValue(amount, rate, years), rate, years) - amount)).toBeLessThanOrEqual(1);
    }
  });
});

describe('cash', () => {
  it('cash flow: ₹2,000 received minus ₹2,500 paid is −₹500', () => {
    expect(netCashFlow([2000], [500, 2000])).toBe(-500);
    expect(netCashFlow([2000], [2500])).toBe(-500);
  });

  it('balances after each movement, and the lowest point reached', () => {
    expect(cashAfter(1500, [2000, -500, -2000])).toEqual({ balances: [3500, 3000, 1000], end: 1000, lowest: 1000 });
    expect(cashAfter(1000, [-1500, 2000]).lowest).toBe(-500);
    expect(cashAfter(6000, [])).toEqual({ balances: [], end: 6000, lowest: 6000 });
  });
});

describe('figures taken from the game rule set', () => {
  it('mortgage: ₹5,000 paid out, ₹5,500 to unmortgage', () => {
    expect(mortgageTerms(MORTGAGE_STORY.mortgageValue)).toEqual({ payout: 5000, unmortgageCost: 5500, interest: 500 });
    expect(BUSINESS_MVP_RULES.mortgage.unmortgageInterestRate).toBe(0.1);
  });

  it('income tax, house sell-back and Classic loan interest follow the rules', () => {
    expect(incomeTaxFor(3)).toBe(150);
    expect(incomeTaxFor(10)).toBe(500);
    expect(incomeTaxFor(40)).toBe(BUSINESS_MVP_RULES.incomeTax.max);
    expect(houseSellBack(2000)).toBe(1000);
    expect(classicLoanInterest(1000)).toBe(100);
  });

  it('sample credit score: overdue, caught up, on time, default', () => {
    const start = INTERMEDIATE_RULES.credit.start;
    expect(start).toBe(700);
    expect(creditScoresAfter(start, ['INSTALLMENT_OVERDUE', 'CAUGHT_UP', 'ON_TIME_PAYMENT'])).toEqual([680, 685, 690]);
    expect(creditScoresAfter(start, ['INSTALLMENT_OVERDUE', 'LOAN_DEFAULT'])).toEqual([680, 605]);
    // Never outside the scale the game uses.
    expect(creditScoresAfter(310, ['LOAN_DEFAULT'])).toEqual([INTERMEDIATE_RULES.credit.min]);
  });
});

describe('loan schedules', () => {
  const { principal, years, fixedRatePercent, variablePaths } = LOAN_STORY;
  const fixed = repaymentSchedule(principal, Array.from({ length: years }, () => fixedRatePercent));
  const totals = Object.fromEntries(variablePaths.map((p) => [p.label, totalRepaid(repaymentSchedule(principal, p.ratesByYear))]));

  it('a fixed loan has level payments and repays exactly the principal', () => {
    expect(fixed.map((l) => l.payment)).toEqual([4021, 4021, 4022]);
    expect(totalRepaid(fixed)).toBe(12064);
    expect(fixed[fixed.length - 1]!.balanceAfter).toBe(0);
    expect(totalRepaid(fixed) - fixed.reduce((s, l) => s + l.interest, 0)).toBe(principal);
  });

  it('every variable path starts cheaper and clears the loan', () => {
    for (const path of variablePaths) {
      const schedule = repaymentSchedule(principal, path.ratesByYear);
      expect(schedule[0]!.payment).toBe(3811);
      expect(schedule[0]!.payment).toBeLessThan(fixed[0]!.payment);
      expect(schedule[schedule.length - 1]!.balanceAfter).toBe(0);
      expect(totalRepaid(schedule) - schedule.reduce((s, l) => s + l.interest, 0)).toBe(principal);
    }
  });

  it('the lowest starting rate is not always the lowest total: cheaper in two paths, dearer in one', () => {
    expect(totals['Rates fall']).toBeLessThan(totals['Rates hold']!);
    expect(totals['Rates hold']).toBeLessThan(totalRepaid(fixed));
    expect(totals['Rates jump']).toBeGreaterThan(totalRepaid(fixed));
  });

  it('the Borrowing vs. Waiting loan: ₹3,000 at 12% over three years', () => {
    const schedule = repaymentSchedule(3000, [12, 12, 12]);
    expect(schedule[0]!.payment).toBe(1249);
    expect(totalRepaid(schedule)).toBe(3747);
  });

  it('is deterministic', () => {
    expect(repaymentSchedule(principal, [7, 13, 16])).toEqual(repaymentSchedule(principal, [7, 13, 16]));
  });
});
