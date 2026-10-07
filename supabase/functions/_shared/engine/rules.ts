/**
 * BUSINESS_MVP_RULES — every game rule the engine reads, in one place.
 *
 * Two kinds of values live here and each one is labelled:
 *
 *  ✅ CONFIRMED — stated by the owner of the physical board (board order, card
 *     tables, ₹1,500 at Start, 3+ same colour doubles rent, loan interest at the
 *     next Start, trading, multi-undo, ₹25,000 starting cash, Income Tax,
 *     Wealth Taxes, Club, Jail, Rest House, 5-second auction countdown).
 *  ⚠️ ASSUMPTION — not established by the physical board/cards/deeds. A default
 *     chosen to keep the MVP playable. Verify against the physical rules and
 *     change it here; nothing else in the code hard-codes these values.
 *
 * Photographed card/deed data lives in businessBoard.ts and cards.ts, not here.
 */
import { formatINR } from './format.ts';

export const BUSINESS_MVP_RULES = {
  /** Bump when any value below changes so old sessions are identifiable. */
  assumptionsVersion: 'MVP-3',

  /** ⚠️ ASSUMPTION */
  players: {
    min: 2,
    max: 8,
  },

  /** ✅ CONFIRMED — cash each player receives from the bank when the game starts. */
  startingCash: 25000,

  /** ⚠️ ASSUMPTION */
  dice: {
    count: 2,
    sides: 6,
    /** Rolling doubles grants another roll after finishing the turn. */
    doublesGrantExtraRoll: false,
    /** Only used when doublesGrantExtraRoll is true. */
    maxConsecutiveDoubles: 3,
  },

  start: {
    /** ✅ CONFIRMED — paid whenever a forward move completes a circuit (passes or lands on Start). */
    passReward: 1500,
  },

  /** ✅ CONFIRMED — ₹50 for every property/site the player owns, at most ₹500. */
  incomeTax: {
    perProperty: 50,
    max: 500,
  },

  /** ✅ CONFIRMED — ₹100 per house + ₹200 per hotel the player owns, at most ₹500. */
  wealthTax: {
    perHouse: 100,
    perHotel: 200,
    max: 500,
  },

  /** ✅ CONFIRMED — landing on Club: pay this much to every other player. */
  club: {
    payEachPlayer: 100,
  },

  /**
   * ✅ CONFIRMED — landing on Jail (or a "Go to Jail" card) traps the player.
   * On each of their turns in Jail they either pay the fine and play normally,
   * or stay and miss the turn. After `maxTurns` missed turns they are released.
   * There is no doubles escape.
   */
  jail: {
    maxTurns: 3,
    fine: 500,
  },

  /** ✅ CONFIRMED — landing on Rest House: collect from every other player, then miss the next turn. */
  restHouse: {
    collectFromEachPlayer: 100,
    turnsSkippedOnLanding: 1,
  },

  cards: {
    /**
     * ✅ CONFIRMED — two tables per deck; the dice total that landed the player on
     * the square picks the EVEN or ODD table and the entry with that number.
     */
    selection: 'PARITY_TABLE_BY_DICE_TOTAL' as const,
    /**
     * ⚠️ ASSUMPTION — direction for Chance odd 9 "Go back to Bombay". The card says
     * to collect ₹1,500 if the move passes Start, which only happens moving
     * forward from a Chance square, so FORWARD is the default. 'BACKWARD' is
     * supported (never passes Start).
     */
    goBackToMumbaiDirection: 'FORWARD' as 'FORWARD' | 'BACKWARD',
    /** ⚠️ ASSUMPTION — after "Go back to Bombay" the Mumbai square is resolved (buy offer / rent). */
    goBackToMumbaiResolvesLanding: true,
    /**
     * ⚠️ ASSUMPTION — "Go to Jail" / "Go to Rest House" move the token directly:
     * they never pass Start and never collect ₹1,500.
     */
    jailAndRestHouseMovesAreDirect: true,
    /**
     * ⚠️ ASSUMPTION — when a player cannot pay their share of "collect from each
     * player" (Birthday), they pay what they have. No debt is created.
     */
    collectFromEachShortfall: 'PAY_WHAT_THEY_CAN' as const,
    /** Cap for amounts entered manually (card entries not in the data). */
    manualMaxAmount: 10000,
  },

  /** ✅ CONFIRMED (doubling) / ⚠️ ASSUMPTION (details marked below) */
  rent: {
    /** ✅ Owning at least this many properties of one colour group doubles that group's rent. */
    sameColorThreshold: 3,
    /** ✅ */
    sameColorMultiplier: 2,
    /** ⚠️ Mortgaged properties still count towards the 3 (ownership is unchanged). */
    sameColorCountsMortgaged: true,
  },

  /** ⚠️ ASSUMPTION */
  property: {
    /** No rent is charged on a mortgaged property. */
    rentWhenMortgaged: false,
    /** Paired transport/utility rent applies even if the partner is mortgaged. */
    pairCountsMortgagedPartner: true,
    /** Selling a site back to the bank pays its mortgage value. */
    sellToBankPays: 'MORTGAGE_VALUE' as const,
  },

  /** ⚠️ ASSUMPTION */
  building: {
    /** Must own every site in a colour group before building there. */
    requireFullGroup: false,
    /** Houses allowed before a hotel (title deeds list rent for 1–3 houses then hotel). */
    maxHouses: 3,
    /** A hotel replaces the 3 houses. */
    hotelRequiresMaxHouses: true,
    /** Building only during your own turn. */
    onlyOnOwnTurn: true,
    /** Fraction of cost refunded when selling a house/hotel back to the bank. */
    sellBackRate: 0.5,
  },

  mortgage: {
    /** ⚠️ ASSUMPTION — extra charged on top of the mortgage value to unmortgage. */
    unmortgageInterestRate: 0.1,
    /**
     * ✅ Mortgaging a developed site is allowed (no "sell buildings first").
     * ⚠️ ASSUMPTION — how the buildings are valued: the deeds give house/hotel
     * COSTS but no separate building mortgage value, so the buildings are handed
     * back to the bank at the existing building sell-back value
     * (building.sellBackRate × cost, hotel = hotel + the houses it replaced).
     * See selectors.mortgageResolution — the only place this is computed.
     */
    buildingsOnMortgage: 'RETURN_TO_BANK_AT_SELL_BACK_VALUE' as const,
  },

  /** ✅ CONFIRMED (5-second countdown) / ⚠️ ASSUMPTION (the rest) */
  auction: {
    enabled: true,
    /** The player who declined may also bid. */
    declinerMayBid: true,
    minimumOpeningBid: 100,
    minimumIncrement: 100,
    /** ✅ Time to place the first bid. */
    openingTimerSeconds: 5,
    /** ✅ Each bid resets the countdown to this many seconds. */
    bidTimerSeconds: 5,
  },

  loans: {
    /** ⚠️ ASSUMPTION (existing configured rate) — interest as % of principal. */
    interestRatePercent: 10,
    /** ✅ CONFIRMED — interest becomes payable when the borrower next reaches/passes Start. */
    interestDue: 'NEXT_START' as const,
    /**
     * ⚠️ ASSUMPTION — false: interest is charged once (at the first Start after
     * borrowing). true: charged again at every later Start while the loan is open.
     */
    interestEveryCircuit: false,
    /** ⚠️ ASSUMPTION */
    minAmount: 1000,
    step: 500,
    /** Max total outstanding principal per player. */
    maxOutstandingPrincipal: 20000,
  },

  /** ✅ CONFIRMED (trading exists) / ⚠️ ASSUMPTION (limits) */
  trades: {
    /** ⚠️ Properties with houses/hotel can't be traded — sell the buildings first. */
    requireNoBuildings: true,
    /** ⚠️ Mortgaged properties may be traded; the mortgage goes with them. */
    allowMortgaged: true,
    /** Bound on open offers per game (keeps state small). */
    maxPendingPerGame: 20,
  },

  undo: {
    /** ✅ CONFIRMED — multiple undo. Depth of the undo history kept per game. */
    maxDepth: 20,
  },

  /** ⚠️ ASSUMPTION */
  bankruptcy: {
    /** On bankruptcy remaining cash goes to the creditor; properties return to the bank. */
    propertiesReturnTo: 'BANK' as const,
  },

  /** ⚠️ ASSUMPTION */
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

const R = BUSINESS_MVP_RULES;

/** Rules confirmed by the owner of the physical board. Shown in Settings. */
export const CONFIRMED_RULES: readonly { title: string; detail: string }[] = [
  { title: 'Board order', detail: 'Exact order of the physical board: Start → Mumbai → … → Margao → Start (36 squares).' },
  { title: 'Starting cash', detail: `Each player starts with ${formatINR(R.startingCash)}.` },
  { title: 'Start', detail: `Completing a circuit (passing or landing on Start) pays ${formatINR(R.start.passReward)}.` },
  { title: 'Chance / Community Chest', detail: 'Even or odd dice total picks the table; the dice number picks the card.' },
  { title: 'Colour sets', detail: 'Owning 3 or more properties of one colour doubles the current rent on that colour.' },
  { title: 'Loans', detail: `Interest (${R.loans.interestRatePercent}%) is payable when you next reach or pass Start — not when you borrow.` },
  { title: 'Trading', detail: 'Players can trade properties and money. The other player must accept.' },
  { title: 'Undo', detail: 'Several recent actions can be undone, newest first, with another player’s approval.' },
  {
    title: 'Income Tax',
    detail: `${formatINR(R.incomeTax.perProperty)} for every property you own, at most ${formatINR(R.incomeTax.max)}.`,
  },
  {
    title: 'Wealth Taxes',
    detail: `${formatINR(R.wealthTax.perHouse)} per house + ${formatINR(R.wealthTax.perHotel)} per hotel you own, at most ${formatINR(R.wealthTax.max)}.`,
  },
  { title: 'Club', detail: `Landing on Club: pay every other player ${formatINR(R.club.payEachPlayer)}.` },
  {
    title: 'Jail',
    detail: `Landing on Jail (or a Go to Jail card) traps you for up to ${R.jail.maxTurns} turns. On your turn, pay ${formatINR(R.jail.fine)} to leave and play, or stay and miss the turn. Released automatically after ${R.jail.maxTurns} missed turns. No doubles escape.`,
  },
  {
    title: 'Rest House',
    detail: `Landing on Rest House: collect ${formatINR(R.restHouse.collectFromEachPlayer)} from every other player, then miss your next turn.`,
  },
  { title: 'Auction timer', detail: `${R.auction.bidTimerSeconds}-second countdown, restarted by every bid.` },
];

/** Human-readable list of the ASSUMPTIONS, shown in Settings so players can compare with their rulebook. */
export const MVP_ASSUMPTIONS: readonly { title: string; detail: string }[] = [
  { title: 'Players', detail: `${R.players.min}–${R.players.max} players.` },
  { title: 'Dice', detail: 'Two six-sided dice. Doubles do not give an extra roll.' },
  {
    title: 'Card moves',
    detail: `"Go back to Bombay" moves ${R.cards.goBackToMumbaiDirection === 'FORWARD' ? 'forward (collect at Start if passed)' : 'backward'}. Go to Jail / Rest House move directly (no Start reward). The Rest House card only skips your next turn — collecting from players happens when you land there by a roll.`,
  },
  { title: 'Birthday / Rest House', detail: 'A player who cannot pay their full share pays what they have.' },
  { title: 'Unreadable cards', detail: 'Card numbers with no entry in the supplied data are entered by hand.' },
  { title: 'Rent', detail: 'No rent on mortgaged properties. Mortgaged properties still count towards a colour set.' },
  { title: 'Building', detail: 'Build on any site you own during your turn: up to 3 houses, then a hotel. Sell back for 50%.' },
  {
    title: 'Mortgage',
    detail: 'Mortgage pays the deed value plus the sell-back value of any buildings, which return to the bank. Unmortgage = value + 10%.',
  },
  { title: 'Trades', detail: 'Only properties without buildings can be traded. Mortgaged properties keep their mortgage.' },
  {
    title: 'Auctions',
    detail: `Declined properties go to auction. Minimum bid ${formatINR(R.auction.minimumOpeningBid)}, +${formatINR(R.auction.minimumIncrement)} steps.`,
  },
  {
    title: 'Loans',
    detail: `Bank loans of ${formatINR(R.loans.minAmount)}–${formatINR(R.loans.maxOutstandingPrincipal)} at ${R.loans.interestRatePercent}%, charged ${R.loans.interestEveryCircuit ? 'at every Start' : 'once'}. Repaying before Start avoids interest.`,
  },
  { title: 'Bankruptcy', detail: 'If you cannot pay, your cash goes to the creditor and your properties return to the bank.' },
  { title: 'Winning', detail: 'Last player not bankrupt wins, or the host ends the game and highest net worth wins.' },
];
