/**
 * BUSINESS_MVP_RULES
 *
 * ⚠️  Configured MVP assumption — verify against physical rules.
 *
 * The original Business rulebook was not available. Every value in this file is
 * a default chosen to make the MVP playable; none of it is a confirmed Business
 * rule. Photographed card/deed data lives in businessBoard.ts and cards.ts and is
 * NOT mixed in here.
 *
 * All game logic reads these values from here — change them in one place.
 */
import { formatINR } from './format.ts';

export const BUSINESS_MVP_RULES = {
  /** Bump when any value below changes so old sessions are identifiable. */
  assumptionsVersion: 'MVP-1',

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
    /** Paid when passing or landing on START by a forward move. */
    passReward: 1500,
  },

  incomeTax: {
    amount: 1000,
  },

  jail: {
    /** Landing on the Jail square by a normal roll is "just visiting". */
    landingByRollSendsToJail: false,
    /** Turns skipped after being sent to jail (by a card). */
    turnsSkipped: 1,
  },

  restHouse: {
    /** Turns skipped after landing on Rest House by a normal roll. */
    turnsSkippedOnLanding: 1,
  },

  cards: {
    /** Card outcome = entry matching the dice total that landed the player there. */
    selection: 'DICE_TOTAL' as const,
    /** Moving forward to a destination by card pays the START reward if START is passed. */
    forwardMovePassesStart: true,
    /** Cap for amounts entered manually for unverified card entries. */
    manualMaxAmount: 10000,
  },

  property: {
    /** No rent is charged on a mortgaged property. */
    rentWhenMortgaged: false,
    /** Paired transport/utility rent applies even if the partner is mortgaged. */
    pairCountsMortgagedPartner: true,
    /** Selling a site back to the bank pays its mortgage value. */
    sellToBankPays: 'MORTGAGE_VALUE' as const,
  },

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
    /** Extra charged on top of the mortgage value to unmortgage. */
    unmortgageInterestRate: 0.1,
  },

  auction: {
    enabled: true,
    /** The player who declined may also bid. */
    declinerMayBid: true,
    minimumOpeningBid: 100,
    minimumIncrement: 100,
    /** Time to place the first bid. */
    openingTimerSeconds: 30,
    /** Each bid resets the countdown to this many seconds. */
    bidTimerSeconds: 20,
  },

  loans: {
    /** Flat interest added once when the loan is taken. Not an original rule. */
    interestRatePercent: 10,
    minAmount: 1000,
    step: 500,
    /** Max total outstanding principal per player. */
    maxOutstandingPrincipal: 20000,
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

/** Human-readable list shown in Settings so players can compare with their rulebook. */
export const MVP_ASSUMPTIONS: readonly { title: string; detail: string }[] = [
  { title: 'Board order', detail: 'The order of squares around the board is a placeholder. Check that "Move to …" matches your board.' },
  { title: 'Starting cash', detail: `Each player starts with ${formatINR(BUSINESS_MVP_RULES.startingCash)}.` },
  { title: 'Players', detail: `${BUSINESS_MVP_RULES.players.min}–${BUSINESS_MVP_RULES.players.max} players.` },
  { title: 'Dice', detail: 'Two six-sided dice. Doubles do not give an extra roll.' },
  { title: 'Start', detail: `Passing or landing on Start pays ${formatINR(BUSINESS_MVP_RULES.start.passReward)}.` },
  { title: 'Income Tax', detail: `Flat ${formatINR(BUSINESS_MVP_RULES.incomeTax.amount)}.` },
  { title: 'Jail', detail: 'Landing on Jail by a roll is just visiting. Sent to jail by a card = skip 1 turn.' },
  { title: 'Rest House', detail: 'Landing on Rest House = skip your next turn.' },
  { title: 'Chance / Community Chest', detail: 'The outcome is the card entry matching your dice total. Unreadable entries are entered by hand.' },
  { title: 'Rent', detail: 'No rent on mortgaged properties. No bonus rent for owning a full colour group.' },
  { title: 'Building', detail: 'Build on any site you own during your turn: up to 3 houses, then a hotel. Sell back for 50%.' },
  { title: 'Mortgage', detail: 'Mortgage for the deed value; unmortgage for the value + 10%.' },
  { title: 'Auctions', detail: 'Declined properties go to auction. Minimum bid ₹100, +₹100 steps, 20s timer per bid.' },
  {
    title: 'Loans',
    detail: `Bank loans of ${formatINR(BUSINESS_MVP_RULES.loans.minAmount)}–${formatINR(BUSINESS_MVP_RULES.loans.maxOutstandingPrincipal)} with ${BUSINESS_MVP_RULES.loans.interestRatePercent}% flat interest.`,
  },
  { title: 'Bankruptcy', detail: 'If you cannot pay, your cash goes to the creditor and your properties return to the bank.' },
  { title: 'Winning', detail: 'Last player not bankrupt wins, or the host ends the game and highest net worth wins.' },
];
