/**
 * BUSINESS_MVP_RULES — the Classic Mode V1 rules, in one place. Every configurable
 * value the engine reads lives here, and nothing else in the code hard-codes them:
 * the engine enforces them (reducer.ts, selectors.ts) and the in-app rulebook
 * (rulebook.ts) is written from them.
 *
 * Photographed card/deed data lives in businessBoard.ts and cards.ts, not here.
 */
export const BUSINESS_MVP_RULES = {
  /**
   * Identifies this rule set. Stored with every new game (games.assumptions_version), so sessions
   * created under an earlier rule set stay identifiable. Bump when any value below changes.
   */
  rulesetVersion: 'CLASSIC-V1',

  players: {
    min: 2,
    max: 8,
  },

  /** Cash each player receives from the bank when the game starts. */
  startingCash: 25000,

  dice: {
    count: 2,
    sides: 6,
    /** Rolling doubles grants another roll after finishing the turn. */
    doublesGrantExtraRoll: false,
    /** Only used when doublesGrantExtraRoll is true. */
    maxConsecutiveDoubles: 3,
  },

  start: {
    /** Paid whenever a forward move completes a circuit (passes or lands on Start). */
    passReward: 1500,
  },

  /** ₹50 for every property/site the player owns, at most ₹500. */
  incomeTax: {
    perProperty: 50,
    max: 500,
  },

  /** ₹100 per house + ₹200 per hotel the player owns, at most ₹500. */
  wealthTax: {
    perHouse: 100,
    perHotel: 200,
    max: 500,
  },

  /** Landing on Club: pay this much to every other player. */
  club: {
    payEachPlayer: 100,
  },

  /**
   * Landing on Jail (or a "Go to Jail" card) traps the player.
   * On each of their turns in Jail they either pay the fine and play normally,
   * or stay and miss the turn. After `maxTurns` missed turns they are released.
   * There is no doubles escape.
   */
  jail: {
    maxTurns: 3,
    fine: 500,
  },

  /** Landing on Rest House: collect from every other player, then miss the next turn. */
  restHouse: {
    collectFromEachPlayer: 100,
    turnsSkippedOnLanding: 1,
  },

  cards: {
    /**
     * Two tables per deck; the dice total that landed the player on
     * the square picks the EVEN or ODD table and the entry with that number.
     */
    selection: 'PARITY_TABLE_BY_DICE_TOTAL' as const,
    /**
     * Direction for Chance odd 9 "Go back to Bombay". The card says to collect
     * ₹1,500 if the move passes Start, which only happens moving forward from a
     * Chance square. 'BACKWARD' is supported by the engine (never passes Start).
     */
    goBackToMumbaiDirection: 'FORWARD' as 'FORWARD' | 'BACKWARD',
    /** After "Go back to Bombay" the Mumbai square is resolved (buy offer / rent). */
    goBackToMumbaiResolvesLanding: true,
    /**
     * "Go to Jail" / "Go to Rest House" move the token directly:
     * they never pass Start and never collect ₹1,500.
     */
    jailAndRestHouseMovesAreDirect: true,
    /**
     * When a player cannot pay their share of "collect from each player"
     * (Birthday, Rest House), they pay what they have. No debt is created.
     */
    collectFromEachShortfall: 'PAY_WHAT_THEY_CAN' as const,
    /** Cap for amounts entered manually (card entries not in the data). */
    manualMaxAmount: 10000,
  },

  rent: {
    /** Owning at least this many properties of one colour group doubles that group's rent. */
    sameColorThreshold: 3,
    sameColorMultiplier: 2,
    /** Mortgaged properties still count towards the 3 (ownership is unchanged). */
    sameColorCountsMortgaged: true,
  },

  property: {
    /** No rent is charged on a mortgaged property. */
    rentWhenMortgaged: false,
    /** A mortgaged transport/utility partner does not raise its pair's rent. */
    pairCountsMortgagedPartner: false,
    /** Selling a site back to the bank pays its mortgage value. */
    sellToBankPays: 'MORTGAGE_VALUE' as const,
  },

  building: {
    /** false: a player can build on any city site they own — one property is enough. */
    requireFullGroup: false,
    /** Houses allowed before a hotel (title deeds list rent for 1–3 houses then hotel). */
    maxHouses: 3,
    /** A hotel replaces the 3 houses. */
    hotelRequiresMaxHouses: true,
    /** Building only during your own turn. */
    onlyOnOwnTurn: true,
    /**
     * Fraction of the original building cost refunded when selling back to the bank.
     * A hotel is sold whole: (hotel cost + the 3 houses it replaced) × this rate.
     */
    sellBackRate: 0.5,
  },

  mortgage: {
    /** Extra charged on top of the mortgage value to unmortgage. */
    unmortgageInterestRate: 0.1,
    /**
     * A developed site can be mortgaged. Its houses/hotel stay attached and are
     * inactive (no rent, no building, no selling) until it is unmortgaged; the
     * payout is the deed's mortgage value only — nothing is paid for buildings.
     */
    buildingsOnMortgage: 'STAY_ATTACHED_INACTIVE' as const,
  },

  auction: {
    enabled: true,
    /** The player who declined may also bid. */
    declinerMayBid: true,
    minimumOpeningBid: 100,
    minimumIncrement: 100,
    /** Time to place the first bid. */
    openingTimerSeconds: 5,
    /** Each bid resets the countdown to this many seconds. */
    bidTimerSeconds: 5,
    /**
     * Hidden bid-delivery grace: the server still accepts a bid that reaches it up to this long
     * after the displayed deadline (network latency), and closes the auction only once it has
     * passed. Server logic only — never shown, never added to the countdown.
     */
    bidGraceSeconds: 1,
  },

  loans: {
    /** Interest as % of the original principal. */
    interestRatePercent: 10,
    /** Interest becomes payable when the borrower next reaches/passes Start. */
    interestDue: 'NEXT_START' as const,
    /**
     * false: interest is charged once (at the first Start after borrowing).
     * true: charged again at every later Start while the loan is open.
     */
    interestEveryCircuit: false,
    minAmount: 1000,
    step: 500,
    /** Max total outstanding principal per player. */
    maxOutstandingPrincipal: 20000,
  },

  trades: {
    /** false: a property is traded together with its houses / hotel, which go to the new owner. */
    requireNoBuildings: false,
    /** Mortgaged properties may be traded; the mortgage goes with them. */
    allowMortgaged: true,
    /** Bound on open offers per game (keeps state small). */
    maxPendingPerGame: 20,
  },

  undo: {
    /** Multiple undo, newest first. Depth of the undo history kept per game. */
    maxDepth: 20,
  },

  bankruptcy: {
    /** On bankruptcy remaining cash goes to the creditor; properties return to the bank. */
    propertiesReturnTo: 'BANK' as const,
  },

  endGame: {
    /** Game ends when only one player is not bankrupt. */
    lastPlayerStandingWins: true,
    /** Host may end the game at any time; highest net worth wins. */
    hostMayEnd: true,
  },

  session: {
    /** Games expire after this many hours without activity. */
    ttlHours: 12,
  },

  transfers: {
    maxAmount: 1_000_000,
  },
} as const;

export type BusinessMvpRules = typeof BUSINESS_MVP_RULES;
