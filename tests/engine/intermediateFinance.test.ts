import { describe, expect, it } from 'vitest';
import {
  accruedInterest,
  annualInstallment,
  annualInterest,
  applyMarketChange,
  buildSchedule,
  clampScore,
  collateralLimit,
  creditBand,
  debtRatio,
  INTERMEDIATE_RULES,
  LOAN_PRODUCT_KEYS,
  offeredRate,
  pickFrom,
  pickMarketChange,
  projectedValue,
  realValue,
  reviewedRate,
  scheduleTotal,
  settleCollateral,
  validateIntermediateRules,
} from '@/engine/index.ts';

const IR = INTERMEDIATE_RULES;

describe('Intermediate config', () => {
  it('holds the agreed starting values', () => {
    expect(IR.year.spacesPerYear).toBe(36);
    expect(IR.inflation.ratePercent).toBe(5);
    expect(IR.market.profiles.balanced).toEqual([
      { percent: -20, weight: 10 },
      { percent: -10, weight: 20 },
      { percent: 0, weight: 20 },
      { percent: 10, weight: 30 },
      { percent: 20, weight: 20 },
    ]);
    expect(IR.credit).toMatchObject({ start: 700, min: 300, max: 850 });
    expect(IR.credit.events).toEqual({ ON_TIME_PAYMENT: 5, INSTALLMENT_OVERDUE: -20, CAUGHT_UP: 5, LOAN_DEFAULT: -75, LOAN_REPAID: 15, CLEAN_YEAR: 5 });
    expect(IR.rates).toEqual({ minPercent: 4, maxPercent: 30 });
    expect(IR.loans).toMatchObject({ minAmount: 1000, step: 500, maxOutstandingPrincipal: 20000, collateralAdvancePercent: 50, graceYears: 1, originationFee: 0, prepaymentPenalty: 0 });
    const p = IR.loans.products;
    expect([p.EMERGENCY.baseRatePercent, p.EMERGENCY.tenureYears, p.EMERGENCY.maxPrincipal, p.EMERGENCY.secured]).toEqual([20, 1, 5000, false]);
    expect([p.PERSONAL.baseRatePercent, p.PERSONAL.tenureYears, p.PERSONAL.maxPrincipal, p.PERSONAL.secured]).toEqual([12, 3, 10000, false]);
    expect([p.SECURED.baseRatePercent, p.SECURED.tenureYears, p.SECURED.maxPrincipal, p.SECURED.secured]).toEqual([8, 3, 10000, true]);
    expect([p.LONG_TERM.baseRatePercent, p.LONG_TERM.tenureYears, p.LONG_TERM.maxPrincipal, p.LONG_TERM.secured]).toEqual([10, 5, 15000, false]);
    expect([p.FLEXIBLE.baseRatePercent, p.FLEXIBLE.tenureYears, p.FLEXIBLE.maxPrincipal, p.FLEXIBLE.rateType]).toEqual([7, 3, 10000, 'VARIABLE']);
  });

  it('is validated: a broken configuration is rejected', () => {
    const copy = () => JSON.parse(JSON.stringify(IR));
    expect(() => validateIntermediateRules(copy())).not.toThrow();
    const weights = copy();
    weights.market.profiles.balanced[0].weight = 11;
    expect(() => validateIntermediateRules(weights)).toThrow(/sum to 100/);
    const bands = copy();
    bands.credit.bands[1].max = 700;
    expect(() => validateIntermediateRules(bands)).toThrow(/contiguous/);
    const limit = copy();
    limit.loans.products.EMERGENCY.maxPrincipal = 500;
    expect(() => validateIntermediateRules(limit)).toThrow(/minimum loan/);
    const unknown = copy();
    unknown.extra = 1;
    expect(() => validateIntermediateRules(unknown)).toThrow();
  });
});

describe('inflation', () => {
  it('realValue = V / 1.05^n, to the nearest rupee', () => {
    expect(realValue(10000, 0)).toBe(10000);
    expect(realValue(10000, 1)).toBe(9524);
    expect(realValue(10000, 2)).toBe(9070);
    expect(realValue(10000, 5)).toBe(7835);
    expect(realValue(0, 3)).toBe(0);
  });

  it('stays exact over many years', () => {
    expect(realValue(1_000_000, 30)).toBe(231377);
  });
});

describe('property market', () => {
  it('applies a change to the previous value and rounds to the nearest ₹100', () => {
    expect(applyMarketChange(10000, 10)).toBe(11000);
    expect(applyMarketChange(11000, -10)).toBe(9900);
    expect(applyMarketChange(8500, 20)).toBe(10200);
    expect(applyMarketChange(2500, -10)).toBe(2300); // 2,250 rounds half up
    expect(applyMarketChange(1500, -20)).toBe(1200);
    expect(applyMarketChange(4000, 0)).toBe(4000);
  });

  it('can fall below the original price but never below ₹100', () => {
    let v = 1500;
    for (let i = 0; i < 40; i += 1) v = applyMarketChange(v, -20);
    expect(v).toBeLessThan(1500);
    expect(v).toBeGreaterThanOrEqual(100);
    expect(applyMarketChange(100, -20)).toBe(100);
  });

  it('draws changes from the configured probabilities', () => {
    const at = (r: number) => pickMarketChange(() => r);
    expect([at(0), at(0.0999)]).toEqual([-20, -20]);
    expect([at(0.1), at(0.2999)]).toEqual([-10, -10]);
    expect([at(0.3), at(0.4999)]).toEqual([0, 0]);
    expect([at(0.5), at(0.7999)]).toEqual([10, 10]);
    expect([at(0.8), at(0.9999), at(1)]).toEqual([20, 20, 20]);
  });

  it('pickFrom is uniform over its options and safe at the edges', () => {
    expect([0, 0.25, 0.5, 0.75, 0.999, 1].map((r) => pickFrom([-5, 0, 5, 10], () => r))).toEqual([-5, 0, 5, 10, 10, 10]);
  });

  it('projects five years of compound growth at the trend', () => {
    expect(projectedValue(10000, 10)).toBe(16100); // 16,105.1
    expect(projectedValue(10000, 5)).toBe(12800); // 12,762.8
    expect(projectedValue(10000, 0)).toBe(10000);
    expect(projectedValue(10000, -5)).toBe(7700); // 7,737.8
    expect(projectedValue(8500, 10, 1)).toBe(9400); // 9,350 rounds half up
  });

  it('limits a secured loan to 50% of market value, rounded down to ₹500', () => {
    expect(collateralLimit(8500)).toBe(4000);
    expect(collateralLimit(10000)).toBe(5000);
    expect(collateralLimit(2500)).toBe(1000);
    expect(collateralLimit(1500)).toBe(500);
    expect(collateralLimit(9900)).toBe(4500);
  });
});

describe('credit score → interest rate', () => {
  it('maps each band to its adjustment', () => {
    expect([850, 750].map((s) => creditBand(s).adjustPercent)).toEqual([-2, -2]);
    expect([749, 700].map((s) => creditBand(s).adjustPercent)).toEqual([-1, -1]);
    expect([699, 650].map((s) => creditBand(s).adjustPercent)).toEqual([0, 0]);
    expect([649, 550].map((s) => creditBand(s).adjustPercent)).toEqual([3, 3]);
    expect([549, 300].map((s) => creditBand(s).adjustPercent)).toEqual([6, 6]);
  });

  it('clamps scores to 300–850', () => {
    expect([200, 300, 700, 850, 900].map(clampScore)).toEqual([300, 300, 700, 850, 850]);
  });

  it('personalised rate = base + adjustment, kept within 4%–30%', () => {
    expect(offeredRate('PERSONAL', 700)).toEqual({ marketRatePercent: 12, creditAdjustmentPercent: -1, ratePercent: 11 });
    expect(offeredRate('PERSONAL', 800).ratePercent).toBe(10);
    expect(offeredRate('PERSONAL', 660).ratePercent).toBe(12);
    expect(offeredRate('EMERGENCY', 400).ratePercent).toBe(26);
    expect(offeredRate('FLEXIBLE', 850).ratePercent).toBe(5);
    expect(offeredRate('SECURED', 600).ratePercent).toBe(11);
    for (const product of LOAN_PRODUCT_KEYS) {
      for (const score of [300, 549, 550, 649, 650, 699, 700, 749, 750, 850]) {
        const { ratePercent } = offeredRate(product, score);
        expect(ratePercent).toBeGreaterThanOrEqual(4);
        expect(ratePercent).toBeLessThanOrEqual(30);
      }
    }
  });

  it('a flexible rate review moves the market component, keeps the signed adjustment, and respects the bounds', () => {
    expect(reviewedRate(7, 2, -1)).toEqual({ marketRatePercent: 9, ratePercent: 8 });
    expect(reviewedRate(7, -2, 6)).toEqual({ marketRatePercent: 5, ratePercent: 11 });
    expect(reviewedRate(5, -2, -2)).toEqual({ marketRatePercent: 4, ratePercent: 4 });
    expect(reviewedRate(29, 2, 6)).toEqual({ marketRatePercent: 30, ratePercent: 30 });
  });
});

describe('loan amortization', () => {
  it('₹10,000 at 12% over 3 years → ₹4,163 a year', () => {
    expect(annualInstallment(10000, 12, 3)).toBe(4163);
    const lines = buildSchedule(10000, 12, 3);
    expect(lines).toEqual([
      { principal: 2963, interest: 1200 },
      { principal: 3319, interest: 844 },
      { principal: 3718, interest: 446 },
    ]);
    expect(scheduleTotal(lines)).toEqual({ principal: 10000, interest: 2490, total: 12490 });
  });

  it('a one-year loan repays principal plus one year of interest', () => {
    expect(annualInstallment(5000, 20, 1)).toBe(6000);
    expect(buildSchedule(5000, 20, 1)).toEqual([{ principal: 5000, interest: 1000 }]);
  });

  it('interest is charged on the outstanding principal only', () => {
    expect(annualInterest(10000, 12)).toBe(1200);
    expect(annualInterest(7037, 12)).toBe(844);
    expect(annualInterest(1050, 7)).toBe(74); // 73.5 rounds half up
  });

  it('every schedule reconciles: the principal parts sum to the loan, the last installment clears it', () => {
    for (const payments of [1, 3, 5]) {
      for (let rate = 4; rate <= 30; rate += 1) {
        for (let principal = 1000; principal <= 15000; principal += 500) {
          const lines = buildSchedule(principal, rate, payments);
          expect(lines).toHaveLength(payments);
          let balance = principal;
          for (const line of lines) {
            expect(line.interest).toBe(annualInterest(balance, rate));
            expect(line.principal).toBeGreaterThan(0);
            balance -= line.principal;
          }
          expect(balance).toBe(0);
          // Level payments: every installment but the last is the formula's amount.
          const level = annualInstallment(principal, rate, payments);
          for (const line of lines.slice(0, -1)) expect(line.principal + line.interest).toBe(level);
          const last = lines[lines.length - 1]!;
          // The last one differs only by the rupees of rounding it absorbs.
          expect(Math.abs(last.principal + last.interest - level)).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it('handles a zero rate and empty inputs', () => {
    expect(buildSchedule(9000, 0, 3)).toEqual([
      { principal: 3000, interest: 0 },
      { principal: 3000, interest: 0 },
      { principal: 3000, interest: 0 },
    ]);
    expect(annualInstallment(0, 12, 3)).toBe(0);
    expect(buildSchedule(1000, 12, 0)).toEqual([]);
  });

  it('accrues interest pro rata through the loan year', () => {
    expect(accruedInterest(10000, 12, 0, 72)).toBe(0);
    expect(accruedInterest(10000, 12, 36, 72)).toBe(600);
    expect(accruedInterest(10000, 12, 72, 72)).toBe(1200);
    expect(accruedInterest(10000, 12, 500, 72)).toBe(1200); // never more than the year
    expect(accruedInterest(10000, 12, -5, 72)).toBe(0);
    expect(accruedInterest(5000, 11, 18, 72)).toBe(138); // 137.5 rounds half up
  });
});

describe('collateral settlement and debt ratio', () => {
  it('collateral worth more than the debt clears it and returns the surplus', () => {
    expect(settleCollateral(9000, 6000)).toEqual({ applied: 6000, surplus: 3000, remaining: 0 });
  });

  it('collateral worth less leaves the rest owed', () => {
    expect(settleCollateral(4000, 6500)).toEqual({ applied: 4000, surplus: 0, remaining: 2500 });
    expect(settleCollateral(6000, 6000)).toEqual({ applied: 6000, surplus: 0, remaining: 0 });
  });

  it('debtRatio = principal / max(net assets, 1)', () => {
    expect(debtRatio(5000, 20000)).toBe(0.25);
    expect(debtRatio(5000, 0)).toBe(5000);
    expect(debtRatio(0, 30000)).toBe(0);
  });
});
