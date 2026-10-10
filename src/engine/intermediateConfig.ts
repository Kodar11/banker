import { z } from 'zod';

/**
 * INTERMEDIATE_RULES — every number Intermediate Mode uses, in one place. The engine
 * (intermediateEngine.ts), the pure maths (intermediateFinance.ts) and the screens all read
 * from here; nothing else hard-codes a rate, limit or threshold. Classic Mode never reads it.
 *
 * These are game-balancing values, not claims about real loan products. Change them here only.
 */

export const LOAN_PRODUCT_KEYS = ['EMERGENCY', 'PERSONAL', 'SECURED', 'LONG_TERM', 'FLEXIBLE'] as const;
export type LoanProductKey = (typeof LOAN_PRODUCT_KEYS)[number];

export const CREDIT_EVENT_TYPES = ['ON_TIME_PAYMENT', 'INSTALLMENT_OVERDUE', 'CAUGHT_UP', 'LOAN_DEFAULT', 'LOAN_REPAID', 'CLEAN_YEAR'] as const;
export type CreditEventType = (typeof CREDIT_EVENT_TYPES)[number];

/**
 * How far property values swing each year. Chosen by the host before the game starts (GameConfig.marketVolatility);
 * each profile is one distribution of annual changes in `market.profiles`.
 */
export const MARKET_VOLATILITIES = ['stable', 'balanced', 'volatile'] as const;
export type MarketVolatility = (typeof MARKET_VOLATILITIES)[number];

const percent = z.number().int().min(-100).max(100);
const MarketChangesSchema = z.array(z.object({ percent, weight: z.number().int().positive() }).strict()).min(1);
const rupees = z.number().int().positive();

const LoanProductSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    baseRatePercent: z.number().int().min(0).max(100),
    tenureYears: z.number().int().min(1).max(10),
    rateType: z.enum(['FIXED', 'VARIABLE']),
    secured: z.boolean(),
    maxPrincipal: rupees,
  })
  .strict();

export type LoanProduct = z.infer<typeof LoanProductSchema>;

const IntermediateRulesSchema = z
  .object({
    version: z.string().min(1),
    year: z.object({ /** Average spaces moved per player that make one financial year. */ spacesPerYear: z.number().int().positive() }).strict(),
    inflation: z.object({ ratePercent: z.number().int().min(0).max(100) }).strict(),
    market: z
      .object({
        /**
         * Annual change of one property's value, drawn independently per property per year, for each volatility
         * profile. Weights sum to 100; a change a profile never produces is simply left out of it.
         */
        profiles: z.object(Object.fromEntries(MARKET_VOLATILITIES.map((v) => [v, MarketChangesSchema])) as Record<MarketVolatility, typeof MarketChangesSchema>).strict(),
        /** The profile of a game whose host did not choose one (and of every game stored before profiles existed). */
        defaultProfile: z.enum(MARKET_VOLATILITIES),
        /** Market values are rounded to the nearest multiple of this, and never drop below `minValue`. */
        roundTo: rupees,
        minValue: rupees,
        /** Expected long-term trend per property (per game), used only for the labelled projection. */
        trendOptions: z.array(percent).min(1),
        projectionYears: z.number().int().positive(),
      })
      .strict(),
    credit: z
      .object({
        start: z.number().int(),
        min: z.number().int(),
        max: z.number().int(),
        events: z.object(Object.fromEntries(CREDIT_EVENT_TYPES.map((t) => [t, z.number().int()])) as Record<CreditEventType, z.ZodNumber>).strict(),
        /** Highest band first. `adjustPercent` is added to a product's base rate for new offers. */
        bands: z.array(z.object({ min: z.number().int(), max: z.number().int(), label: z.string(), adjustPercent: percent }).strict()).min(1),
      })
      .strict(),
    rates: z.object({ minPercent: z.number().int().min(0), maxPercent: z.number().int().max(100) }).strict(),
    loans: z
      .object({
        minAmount: rupees,
        step: rupees,
        /** Max total outstanding principal across a player's Intermediate loans. */
        maxOutstandingPrincipal: rupees,
        /** A secured loan can be at most this share of the collateral's market value, rounded down to `collateralRoundTo`. */
        collateralAdvancePercent: z.number().int().min(1).max(100),
        collateralRoundTo: rupees,
        /** Annual movement of a Flexible-rate loan's market rate, in percentage points (equally likely). */
        flexibleMoves: z.array(percent).min(1),
        /** After an installment falls due it can be paid on time for this share of a financial year; then it is overdue. */
        paymentWindowPercent: z.number().int().min(1).max(100),
        /** Full financial years an overdue installment may stay unpaid before the loan defaults. */
        graceYears: z.number().int().min(1),
        originationFee: z.number().int().min(0),
        prepaymentPenalty: z.number().int().min(0),
        products: z.object(Object.fromEntries(LOAN_PRODUCT_KEYS.map((k) => [k, LoanProductSchema])) as Record<LoanProductKey, typeof LoanProductSchema>).strict(),
      })
      .strict(),
    notifications: z
      .object({
        introAutoCloseSeconds: z.number().int().positive(),
        /** How many of the biggest price moves the yearly announcement lists. */
        marketMoversShown: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const v of MARKET_VOLATILITIES) {
      if (cfg.market.profiles[v].reduce((s, c) => s + c.weight, 0) !== 100) issue(`market.profiles.${v} weights must sum to 100`);
    }
    if (cfg.credit.min > cfg.credit.start || cfg.credit.start > cfg.credit.max) issue('credit.start must lie within min..max');
    const sorted = [...cfg.credit.bands].sort((a, b) => a.min - b.min);
    if (sorted[0]?.min !== cfg.credit.min || sorted[sorted.length - 1]?.max !== cfg.credit.max) issue('credit bands must cover min..max');
    sorted.forEach((b, i) => {
      const next = sorted[i + 1];
      if (b.min > b.max || (next && next.min !== b.max + 1)) issue('credit bands must be contiguous and not overlap');
    });
    if (cfg.rates.minPercent > cfg.rates.maxPercent) issue('rates.minPercent must not exceed maxPercent');
    if (cfg.loans.minAmount % cfg.loans.step !== 0) issue('loans.minAmount must be a multiple of loans.step');
    for (const key of LOAN_PRODUCT_KEYS) {
      const p = cfg.loans.products[key];
      if (p.maxPrincipal < cfg.loans.minAmount) issue(`${key}: maxPrincipal is below the minimum loan`);
      if (p.maxPrincipal % cfg.loans.step !== 0) issue(`${key}: maxPrincipal must be a multiple of loans.step`);
    }
  });

export type IntermediateRules = z.infer<typeof IntermediateRulesSchema>;

export function validateIntermediateRules(raw: unknown): IntermediateRules {
  return IntermediateRulesSchema.parse(raw);
}

export const INTERMEDIATE_RULES: IntermediateRules = validateIntermediateRules({
  /** Stored with every Intermediate game's economy. Bump when any value below changes. */
  version: 'INTERMEDIATE-V1',

  year: {
    spacesPerYear: 36,
  },

  /** Fixed. Explains purchasing power only — no nominal price is changed by it. */
  inflation: {
    ratePercent: 5,
  },

  market: {
    /** Initial balancing values — tune here after playtesting. Balanced is the distribution Intermediate Mode has always used. */
    profiles: {
      stable: [
        { percent: -10, weight: 20 },
        { percent: 0, weight: 40 },
        { percent: 10, weight: 30 },
        { percent: 20, weight: 10 },
      ],
      balanced: [
        { percent: -20, weight: 10 },
        { percent: -10, weight: 20 },
        { percent: 0, weight: 20 },
        { percent: 10, weight: 30 },
        { percent: 20, weight: 20 },
      ],
      volatile: [
        { percent: -20, weight: 20 },
        { percent: -10, weight: 20 },
        { percent: 0, weight: 10 },
        { percent: 10, weight: 25 },
        { percent: 20, weight: 25 },
      ],
    },
    defaultProfile: 'balanced',
    roundTo: 100,
    minValue: 100,
    trendOptions: [-5, 0, 5, 10],
    projectionYears: 5,
  },

  credit: {
    start: 700,
    min: 300,
    max: 850,
    events: {
      ON_TIME_PAYMENT: 5,
      INSTALLMENT_OVERDUE: -20,
      CAUGHT_UP: 5,
      LOAN_DEFAULT: -75,
      LOAN_REPAID: 15,
      CLEAN_YEAR: 5,
    },
    bands: [
      { min: 750, max: 850, label: 'Excellent', adjustPercent: -2 },
      { min: 700, max: 749, label: 'Good', adjustPercent: -1 },
      { min: 650, max: 699, label: 'Fair', adjustPercent: 0 },
      { min: 550, max: 649, label: 'Weak', adjustPercent: 3 },
      { min: 300, max: 549, label: 'Poor', adjustPercent: 6 },
    ],
  },

  rates: {
    minPercent: 4,
    maxPercent: 30,
  },

  loans: {
    minAmount: 1000,
    step: 500,
    maxOutstandingPrincipal: 20000,
    collateralAdvancePercent: 50,
    collateralRoundTo: 500,
    flexibleMoves: [-2, -1, 0, 1, 2],
    paymentWindowPercent: 25,
    graceYears: 1,
    originationFee: 0,
    prepaymentPenalty: 0,
    products: {
      EMERGENCY: {
        name: 'Emergency Loan',
        summary: 'Fast cash for one year. The most expensive way to borrow.',
        baseRatePercent: 20,
        tenureYears: 1,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 5000,
      },
      PERSONAL: {
        name: 'Personal Loan',
        summary: 'A standard three-year loan with equal yearly payments.',
        baseRatePercent: 12,
        tenureYears: 3,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 10000,
      },
      SECURED: {
        name: 'Secured Loan',
        summary: 'Cheaper because one of your properties is pledged. Default and the bank takes it.',
        baseRatePercent: 8,
        tenureYears: 3,
        rateType: 'FIXED',
        secured: true,
        maxPrincipal: 10000,
      },
      LONG_TERM: {
        name: 'Long-term Loan',
        summary: 'Smaller yearly payments over five years, more interest in total.',
        baseRatePercent: 10,
        tenureYears: 5,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 15000,
      },
      FLEXIBLE: {
        name: 'Flexible-rate Loan',
        summary: 'Starts cheapest, but the rate is reviewed every year and can rise or fall.',
        baseRatePercent: 7,
        tenureYears: 3,
        rateType: 'VARIABLE',
        secured: false,
        maxPrincipal: 10000,
      },
    },
  },

  notifications: {
    introAutoCloseSeconds: 30,
    marketMoversShown: 3,
  },
});
