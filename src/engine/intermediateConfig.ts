import { z } from 'zod';

/**
 * INTERMEDIATE_RULES — every number Capital Mode uses, in one place. The engine
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
        /** The most a player's score can rise in one financial year, whatever earned it. Penalties are never capped. */
        maxGainPerYear: z.number().int().min(0),
        /** Highest band first. `adjustPercent` is added to a product's base rate for new offers. */
        bands: z.array(z.object({ min: z.number().int(), max: z.number().int(), label: z.string(), adjustPercent: percent }).strict()).min(1),
      })
      .strict(),
    rates: z.object({ minPercent: z.number().int().min(0), maxPercent: z.number().int().max(100) }).strict(),
    loans: z
      .object({
        minAmount: rupees,
        step: rupees,
        /** No single loan, of any product, may exceed this. A product's own maximum may be lower. */
        maxSingleLoan: rupees,
        /** Max total outstanding principal across a player's Capital loans. */
        maxOutstandingPrincipal: rupees,
        /**
         * A secured loan can be at most this share of the pooled value of everything pledged for it, rounded down to
         * `collateralRoundTo`. A property counts at its market value; its buildings at `collateralBuildingPercent` of
         * what they cost to build (what selling them back to the bank pays).
         */
        collateralAdvancePercent: z.number().int().min(1).max(100),
        collateralBuildingPercent: z.number().int().min(0).max(100),
        collateralRoundTo: rupees,
        /**
         * Repayment capacity: a year of installments on all of a player's loans, a new one included, may not exceed
         * their net worth plus this many years of Start rewards (the only income the game guarantees).
         */
        affordabilityIncomeYears: z.number().int().min(0),
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
    insurance: z
      .object({
        /** Premium for one property bought in Year 1; it rises by `premiumStepPerYear` each financial year up to `premiumMax`. */
        premiumYear1: rupees,
        premiumStepPerYear: z.number().int().min(0),
        premiumMax: rupees,
        /** A policy lasts this many spaces of average movement from the moment it is bought. */
        coverageSpaces: z.number().int().positive(),
        /** The bill a crisis puts on the property it strikes. A policy in force waives it; nothing else is paid out. */
        crisisBill: rupees,
        /** The first crisis strikes after this many spaces of average movement, then one every `crisisIntervalSpaces`. */
        firstCrisisSpaces: z.number().int().positive(),
        crisisIntervalSpaces: z.number().int().positive(),
      })
      .strict(),
    resale: z
      .object({
        /** The highest reserve price a seller may put on a property they auction. */
        maxReservePrice: rupees,
        /** "Get ready" time before the first bid is accepted, so every phone has the auction on screen when bidding opens. */
        startCountdownSeconds: z.number().int().min(0),
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
    if (cfg.insurance.premiumMax < cfg.insurance.premiumYear1) issue('insurance.premiumMax must not be below premiumYear1');
    for (const key of LOAN_PRODUCT_KEYS) {
      const p = cfg.loans.products[key];
      if (p.maxPrincipal < cfg.loans.minAmount) issue(`${key}: maxPrincipal is below the minimum loan`);
      if (p.maxPrincipal % cfg.loans.step !== 0) issue(`${key}: maxPrincipal must be a multiple of loans.step`);
      if (p.maxPrincipal > cfg.loans.maxSingleLoan) issue(`${key}: maxPrincipal is above the single-loan maximum`);
      if (p.baseRatePercent < cfg.rates.minPercent || p.baseRatePercent > cfg.rates.maxPercent) issue(`${key}: baseRatePercent is outside the rate floor and ceiling`);
    }
  });

export type IntermediateRules = z.infer<typeof IntermediateRulesSchema>;

export function validateIntermediateRules(raw: unknown): IntermediateRules {
  return IntermediateRulesSchema.parse(raw);
}

export const INTERMEDIATE_RULES: IntermediateRules = validateIntermediateRules({
  /** Stored with every Capital game's economy. Bump when any value below changes. */
  version: 'INTERMEDIATE-V4',

  year: {
    spacesPerYear: 36,
  },

  /** Fixed. Explains purchasing power only — no nominal price is changed by it. */
  inflation: {
    ratePercent: 5,
  },

  market: {
    /** Initial balancing values — tune here after playtesting. Balanced is the distribution Capital Mode has always used. */
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
    /**
     * The agreed credit policy. A late installment paid within grace earns nothing back (CAUGHT_UP 0);
     * LOAN_REPAID needs a real repayment history (an installment paid on time, nothing ever late), so
     * borrowing and prepaying at once earns nothing; CLEAN_YEAR needs an installment paid on time
     * that year and nothing due, overdue or in default at its end.
     */
    events: {
      ON_TIME_PAYMENT: 5,
      INSTALLMENT_OVERDUE: -20,
      CAUGHT_UP: 0,
      LOAN_DEFAULT: -100,
      LOAN_REPAID: 10,
      CLEAN_YEAR: 5,
    },
    maxGainPerYear: 10,
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
    minAmount: 10000,
    step: 500,
    maxSingleLoan: 50000,
    /** The host's default total limit (GameConfig.loanLimit); every product maximum still applies within it. */
    maxOutstandingPrincipal: 20000,
    collateralAdvancePercent: 80,
    collateralBuildingPercent: 50,
    collateralRoundTo: 500,
    affordabilityIncomeYears: 1,
    flexibleMoves: [-2, -1, 0, 1, 2],
    paymentWindowPercent: 25,
    graceYears: 1,
    originationFee: 0,
    prepaymentPenalty: 0,
    products: {
      EMERGENCY: {
        name: 'Emergency Loan',
        summary: 'Fast cash for one year. The most expensive way to borrow.',
        baseRatePercent: 18,
        tenureYears: 1,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 20000,
      },
      PERSONAL: {
        name: 'Personal Loan',
        summary: 'A standard three-year loan with equal yearly payments. No property needed.',
        baseRatePercent: 13,
        tenureYears: 3,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 30000,
      },
      SECURED: {
        name: 'Secured Loan',
        summary: 'The cheapest fixed rate, because you pledge property and buildings. Default and the bank takes them.',
        baseRatePercent: 7,
        tenureYears: 3,
        rateType: 'FIXED',
        secured: true,
        maxPrincipal: 50000,
      },
      LONG_TERM: {
        name: 'Long-term Loan',
        summary: 'Smaller yearly payments over five years, more interest in total.',
        baseRatePercent: 11,
        tenureYears: 5,
        rateType: 'FIXED',
        secured: false,
        maxPrincipal: 40000,
      },
      FLEXIBLE: {
        name: 'Flexible-rate Loan',
        summary: 'Starts cheaper than a Personal Loan, but the rate is reviewed every year and can rise or fall.',
        baseRatePercent: 9,
        tenureYears: 3,
        rateType: 'VARIABLE',
        secured: false,
        maxPrincipal: 30000,
      },
    },
  },

  /** Property insurance and the global crisis that makes it worth buying. */
  insurance: {
    premiumYear1: 500,
    premiumStepPerYear: 100,
    premiumMax: 900,
    coverageSpaces: 36,
    crisisBill: 3000,
    firstCrisisSpaces: 18,
    crisisIntervalSpaces: 36,
  },

  /** A player auctioning a property they own. Bidding opens at the seller's reserve; increments and the bidding countdown are the game's auction rules. */
  resale: {
    /** The highest reserve price a seller may ask. */
    maxReservePrice: 1_000_000,
    startCountdownSeconds: 3,
  },

  notifications: {
    introAutoCloseSeconds: 30,
    marketMoversShown: 3,
  },
});
