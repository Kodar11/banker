import type { BotDifficulty, BotPersonality, Dimension } from './types.ts';

/**
 * BOT_POLICY — every number the bots decide with, in one place. Nothing in src/bots hard-codes a
 * threshold, weight or budget elsewhere: tune here, and re-run the simulations (tests/bots).
 *
 * These are strategy parameters, never game rules. The rules (prices, rent, loans, auctions) are read
 * from the engine. Values marked UNVALIDATED are starting heuristics from the design brief; the
 * calibration notes in docs/bots/README.md record what the seeded simulations showed about them.
 */

/**
 * The agreed initial preference weights (each column sums to 100). UNVALIDATED.
 * They are turned into multipliers relative to the average personality (personalityMultipliers), so a
 * weight of 30 where the average is 21.25 makes that dimension count 1.41×.
 */
export const PERSONALITY_WEIGHTS: Readonly<Record<BotPersonality, Readonly<Record<Dimension, number>>>> = {
  investor: { wealth: 30, liquidity: 15, group: 20, negotiation: 5, market: 15, risk: 10, objectives: 5 },
  banker: { wealth: 20, liquidity: 30, group: 25, negotiation: 5, market: 5, risk: 10, objectives: 5 },
  dealmaker: { wealth: 15, liquidity: 15, group: 20, negotiation: 30, market: 5, risk: 10, objectives: 5 },
  opportunist: { wealth: 20, liquidity: 15, group: 10, negotiation: 5, market: 30, risk: 10, objectives: 10 },
};

/** Behaviour that follows from a personality but is not a weight. Each is explained where it is used. */
export interface PersonalityTuning {
  /** Construction must return this multiple of its cost over the horizon (rent + what it is worth at the end). UNVALIDATED (brief: 1.25). */
  constructionHurdle: number;
  /** A trade must beat what is given up by this share (brief: about 10%). */
  tradeMargin: number;
  /** Proposes a trade on every Nth turn of its own (1 = every turn). 0 = never proposes. */
  tradeCadence: number;
  /** Where between the partner's estimated minimum and its own maximum a cash offer is pitched (0 = partner's minimum). */
  offerSplit: number;
  /** Opening auction bid as a share of the most it would pay. */
  auctionOpening: number;
  /** End-game ballot: votes to end once its estimated lead over the next player is at least this share of its net worth. */
  endVoteLead: number;
  /** Pays the Jail fine only if the cash left afterwards is at least this share of the base reserve. */
  jailFineReserveShare: number;
  /**
   * B_risk covers this percentile of the next turns' plausible outflows (Normal/Hard; brief: 75th), and Easy's
   * fallback buffer is scaled by it relative to 0.75. A Banker guards against the tail. UNVALIDATED.
   */
  reservePercentile: number;
}

export const PERSONALITY_TUNING: Readonly<Record<BotPersonality, PersonalityTuning>> = {
  investor: { constructionHurdle: 1.2, tradeMargin: 0.1, tradeCadence: 3, offerSplit: 0.45, auctionOpening: 0.5, endVoteLead: 0.1, jailFineReserveShare: 0.5, reservePercentile: 0.75 },
  banker: { constructionHurdle: 1.2, tradeMargin: 0.1, tradeCadence: 5, offerSplit: 0.3, auctionOpening: 0.4, endVoteLead: 0.05, jailFineReserveShare: 1, reservePercentile: 0.8 },
  dealmaker: { constructionHurdle: 1.3, tradeMargin: 0.05, tradeCadence: 1, offerSplit: 0.5, auctionOpening: 0.5, endVoteLead: 0.1, jailFineReserveShare: 0.6, reservePercentile: 0.75 },
  opportunist: { constructionHurdle: 1.2, tradeMargin: 0.1, tradeCadence: 2, offerSplit: 0.2, auctionOpening: 0.3, endVoteLead: 0.2, jailFineReserveShare: 0.3, reservePercentile: 0.6 },
};

export type MovementModel = 'one-roll' | 'monte-carlo';

export interface DifficultyTuning {
  /** Easy: exact probabilities of the next roll, then an even spread. Normal/Hard: seeded Monte Carlo of the real board. */
  movement: MovementModel;
  /** Simulated futures per player per decision (brief: 256 Normal, 1024 Hard). Benchmarked in tests/bots/performance. */
  simulations: number;
  /** Turns of play valued at most, whatever the horizon. */
  maxPlanningTurns: number;
  /** Weight of a benefit one turn later (0.985 ≈ a benefit 10 turns away counts 86%). UNVALIDATED. */
  turnDiscount: number;
  /** Hosted games can end early by vote: chance per remaining financial year that it does (0 = ignored). */
  earlyEndPerYear: number;
  /** Deterministic error (±share) in Easy's property estimates, fixed per bot and property: a weaker, not a random, player. */
  valuationNoise: number;
  /** The reserve buffer simulates the bot's next turns (true), or uses the simple fallback (false). */
  riskPercentile: boolean;
  /** Counts an opponent's gain from a deal against the deal (relative standing). */
  rivalryWeight: number;
  /** Proposes trades of its own (subject to the personality cadence). */
  proactiveTrades: boolean;
  /** Turns a nearly acceptable offer into a counteroffer instead of a plain rejection. */
  counteroffers: boolean;
  /** Raises its own bid in jumps towards its limit (fewer, faster bids) instead of the minimum each time. */
  jumpBids: boolean;
  /** Values keeping a property from an opponent who would complete a set with it. */
  denialValue: boolean;
}

export const DIFFICULTY_TUNING: Readonly<Record<BotDifficulty, DifficultyTuning>> = {
  easy: {
    movement: 'one-roll',
    simulations: 0,
    maxPlanningTurns: 8,
    turnDiscount: 0.97,
    earlyEndPerYear: 0,
    valuationNoise: 0.2,
    riskPercentile: false,
    rivalryWeight: 0,
    proactiveTrades: false,
    counteroffers: false,
    jumpBids: false,
    denialValue: false,
  },
  normal: {
    movement: 'monte-carlo',
    simulations: 256,
    maxPlanningTurns: 14,
    turnDiscount: 0.985,
    earlyEndPerYear: 0.08,
    valuationNoise: 0,
    riskPercentile: true,
    rivalryWeight: 0.25,
    proactiveTrades: true,
    counteroffers: true,
    jumpBids: true,
    denialValue: false,
  },
  hard: {
    movement: 'monte-carlo',
    simulations: 1024,
    maxPlanningTurns: 20,
    turnDiscount: 0.985,
    earlyEndPerYear: 0.08,
    valuationNoise: 0,
    riskPercentile: true,
    rivalryWeight: 0.5,
    proactiveTrades: true,
    counteroffers: true,
    jumpBids: true,
    denialValue: true,
  },
};

export const BOT_POLICY = {
  reserve: {
    /** R_base = max(minimum, share × starting cash). */
    baseMinimum: 2000,
    baseShareOfStartingCash: 0.2,
    /** Turns of the bot's own movement the near-term outflow buffer looks at. */
    nearTermTurns: 2,
    /** Easy's documented fallback: B_risk = max(floor, multiple × expected outflow of the next roll). */
    fallbackFloor: 1000,
    fallbackMultiple: 2,
    /** Liquidity penalty for a shortfall s below the target R: s × (linear + quadratic × s / R). */
    shortfallLinear: 0.25,
    shortfallQuadratic: 0.5,
    /** Share of what mortgaging could raise at once that counts towards the reserve (valuation.mortgageable). UNVALIDATED. */
    mortgageableShare: 0.25,
  },
  horizon: {
    /** A matchmade game has no end date: its income is planned over this many financial years. NOT a game rule. */
    matchmadePlanningYears: 2,
    /** Average of two dice: spaces a turn moves. */
    averageRoll: 7,
  },
  value: {
    /**
     * What an asset still on the books when the plan ends counts for. Hosted: the final standings are net
     * worth, which counts property at full value, so 1. Matchmade: survival matters more than book value. UNVALIDATED.
     */
    terminalWeightHosted: 1,
    terminalWeightMatchmade: 0.7,
    /** Each unit of outstanding loan principal counts this much against risk (debt aversion). UNVALIDATED. */
    leverageRisk: 0.12,
    /** Share of a deal's gain attributed to the negotiation dimension (the rest stays where it arose). */
    negotiationShare: 0.5,
    /** Share of an uninsured crisis bill's downside counted as risk on top of its expected cost. */
    crisisDownside: 0.5,
    /** Share of the board the table is expected to own once buying has run its course (Capital crisis odds). UNVALIDATED. */
    crisisOwnershipTarget: 0.75,
  },
  decisions: {
    /** A management action must improve the weighted score by at least this much (rupee-equivalents). */
    minimumImprovement: 120,
    /** Management actions a bot may take in one turn besides what the turn requires. */
    maxManagementActionsPerTurn: 12,
    /** A purchase completing or extending a set may breach the reserve if its score clears this. */
    exceptionalScore: 1500,
  },
  trade: {
    /** Absolute floor for "worth it" when the comparison base is tiny (avoids meaningless percentages of zero). */
    minimumGain: 300,
    /** Candidate deals scored per proactive decision (bounded work). */
    maxCandidates: 12,
    /** A trade the bot proposed and the other side turned down is never proposed again (GameState.botTradeMemory). */
    noRepeatWhileRecorded: true,
    /**
     * How the bot expects a PERSON to judge its offer (a bot partner's own settings are public and used
     * instead): the gain they need, as a share of what they give, and how much the bot's own gain from the
     * deal puts them off. UNVALIDATED; a typical Normal bot's values.
     */
    personMargin: 0.1,
    personRivalry: 0.25,
  },
  auction: {
    /** Jump size when raising its own bid: this share of the gap to its limit (rounded to the increment). */
    jumpShare: 0.35,
  },
  vote: {
    /** Easy bots vote with a deterministic coin weighted by their lead instead of the full estimate. */
    easyLeadWeight: 0.5,
  },
} as const;

/** Average weight of each dimension across the four personalities. */
const AVERAGE: Record<Dimension, number> = (() => {
  const all = Object.values(PERSONALITY_WEIGHTS);
  const out = {} as Record<Dimension, number>;
  for (const d of Object.keys(all[0]!) as Dimension[]) out[d] = all.reduce((s, w) => s + w[d], 0) / all.length;
  return out;
})();

/** Weight relative to the average personality: 1 = neutral, above 1 = cares more. */
export function personalityMultipliers(personality: BotPersonality): Record<Dimension, number> {
  const w = PERSONALITY_WEIGHTS[personality];
  const out = {} as Record<Dimension, number>;
  for (const d of Object.keys(w) as Dimension[]) out[d] = AVERAGE[d] > 0 ? w[d] / AVERAGE[d] : 1;
  return out;
}
