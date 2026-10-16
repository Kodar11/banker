import type { BotSeat } from './botSeat.ts';
import type { PropertyKey } from './businessBoard.ts';
import type { CardTable, Deck } from './cards.ts';
import type { GameConfig } from './gameConfig.ts';
import type { GameMode, IntermediateState } from './intermediateState.ts';
import type { ObjectivesState } from './objectives.ts';

export type GameStatus = 'WAITING' | 'ACTIVE' | 'PAUSED' | 'FINISHED';

/**
 * Turn phases. MOVING, RESOLVING and TRANSACTION are transient: the server passes
 * through them while processing a single action; they are never persisted as the
 * resting phase but are recorded in the transition trace.
 */
export type TurnPhase =
  | 'AWAITING_ROLL'
  | 'MOVING'
  | 'RESOLVING'
  | 'AWAITING_DECISION'
  | 'AWAITING_PAYMENT'
  | 'AWAITING_CARD'
  | 'AUCTION'
  | 'TRANSACTION'
  | 'TURN_COMPLETE';

/**
 * ACTIVE plays. BANKRUPT could not pay a debt and was settled out (estate.ts). LEFT walked away
 * (LEAVE_GAME): their estate was settled the same way — debts first, properties back to the bank,
 * remaining cash out of play — and they take no more part in the game.
 */
export type PlayerStatus = 'ACTIVE' | 'BANKRUPT' | 'LEFT';

export interface PlayerState {
  id: string;
  name: string;
  /**
   * Turn-order position. Joining order while in the lobby; START_GAME replaces it
   * with a random draw (0 = first to roll) and it never changes after that.
   */
  seat: number;
  isHost: boolean;
  ready: boolean;
  balance: number;
  position: number;
  status: PlayerStatus;
  /** Turns this player will skip automatically (Rest House). */
  skipTurns: number;
  /** Trapped in Jail. Always equals jailTurnsLeft > 0. */
  inJail: boolean;
  /**
   * Jail turns left (BUSINESS_MVP_RULES.jail.maxTurns when jailed). Each of the
   * player's turns in Jail is either bought out (fine → 0) or missed (−1);
   * reaching 0 releases them.
   */
  jailTurnsLeft: number;
  /** Completed circuits (times this player passed or landed on Start by a forward move). */
  circuits: number;
  /**
   * Set for a seat the game plays by itself (botSeat.ts): its difficulty and personality. Absent or null for a
   * person. Public — every device may show which seats are bots. Never changes once the seat exists.
   */
  bot?: BotSeat | null;
}

export interface PropertyState {
  key: PropertyKey;
  ownerId: string | null;
  houses: number;
  hotel: boolean;
  mortgaged: boolean;
}

/**
 * ACTIVE     being repaid; `outstanding` is the principal still owed.
 * REPAID     cleared (closedAt set).
 * DEFAULTED  closedAt null: the principal was not repaid by the default checkpoint; `outstanding`
 *            is still owed and enforceable (it counts in net worth and blocks new borrowing).
 *            closedAt set: the borrower's estate was settled (bankruptcy or leaving) and `outstanding`
 *            is the part the estate could not pay — recorded, no longer collectable.
 */
export type LoanStatus = 'ACTIVE' | 'REPAID' | 'DEFAULTED';

/**
 * A bank loan. The principal is repaid with REPAY_LOAN; interest is NOT added
 * when borrowing — it becomes payable (in cash, to the bank) when the borrower
 * next reaches/passes Start (see BUSINESS_MVP_RULES.loans). The principal itself falls due at
 * `maturityCircuit` (classicLoanStanding).
 */
export interface LoanState {
  id: string;
  playerId: string;
  principal: number;
  interestRatePercent: number;
  /** Interest charged at each interest checkpoint (principal × rate). */
  interestAmount: number;
  /** Amount to repay (= principal; interest is paid separately at Start). */
  totalOwed: number;
  /** Principal still owed. */
  outstanding: number;
  status: LoanStatus;
  /** Borrower's `circuits` when the loan was taken; interest is due at circuit + 1 (+ n). */
  createdAtCircuit: number;
  /** Number of interest checkpoints already charged. */
  interestCharges: number;
  /** Total interest paid so far. */
  interestPaid: number;
  /**
   * The borrower's `circuits` at which the principal falls due (createdAtCircuit + BUSINESS_MVP_RULES.loans.maturityCircuits,
   * fixed at signing). Null for a loan signed before loans had a maturity: it keeps the contract it was signed under.
   */
  maturityCircuit: number | null;
  createdAt: string;
  closedAt: string | null;
}

export type AuctionStatus = 'OPEN' | 'CLOSED';

/** Phases a seller's turn can be in when they list a property, and returns to when that auction ends. */
export type ResaleResumePhase = 'AWAITING_ROLL' | 'AWAITING_PAYMENT' | 'TURN_COMPLETE';

/** SOLD to the high bidder · UNSOLD (no bid, reserve not met, or the sale could not go through) · CANCELLED by the seller before any bid. */
export type ResaleOutcome = 'SOLD' | 'UNSOLD' | 'CANCELLED';

/**
 * What makes an auction a resale (Capital Mode): a player selling a property they own, with
 * whatever is built on it, to the highest bidder — provided the bid reaches their reserve price.
 */
export interface ResaleTerms {
  sellerId: string;
  /** The least the seller accepts. Not a bid: a lower high bid simply does not buy the property. */
  reservePrice: number;
  /** What stood on the property when it was listed. The sale goes through only if it still does. */
  houses: number;
  hotel: boolean;
  resumePhase: ResaleResumePhase;
  /** Null while the auction is open. */
  outcome: ResaleOutcome | null;
}

export interface AuctionState {
  id: string;
  propertyKey: PropertyKey;
  status: AuctionStatus;
  highBid: number | null;
  highBidderId: string | null;
  minimumOpeningBid: number;
  minimumIncrement: number;
  /**
   * ISO timestamp on the server's clock: the deadline every device counts down to. Set by the
   * server when the auction opens and again by each accepted bid — never by a client. The server
   * accepts bids for a short hidden grace after it (reducer.auctionAcceptUntil).
   */
  endsAt: string;
  participantIds: string[];
  passedIds: string[];
  winnerId: string | null;
  createdAt: string;
  closedAt: string | null;
  /** Set for a player's resale auction; absent or null for the bank's auction of an unowned property. */
  resale?: ResaleTerms | null;
}

export interface DiceRoll {
  dice: number[];
  total: number;
  isDouble: boolean;
}

export type PaymentReason = 'RENT' | 'TAX' | 'CARD' | 'LOAN_INTEREST' | 'CLUB';

export type Pending =
  | { kind: 'BUY'; propertyKey: PropertyKey; price: number }
  | {
      kind: 'PAYMENT';
      reason: PaymentReason;
      amount: number;
      /** null = bank */
      toPlayerId: string | null;
      propertyKey: PropertyKey | null;
      label: string;
      cardId: string | null;
      /** LOAN_INTEREST: loans whose interest this payment settles. */
      loanIds?: string[];
      /** Split equally between these players instead of toPlayerId (e.g. "pay each player"). */
      payeeIds?: string[];
    }
  /**
   * LEGACY: games saved while Chance odd 11 was entered by hand can still hold this. The engine now
   * resolves it from the card data (RESOLVE_CARD carries no amount); nothing creates it any more.
   */
  | { kind: 'CARD_MANUAL'; cardId: string; deck: Deck; rollTotal: number };

/** Work left after the current obligation is paid (e.g. resolve the square after paying loan interest). */
export type FollowUp =
  | { kind: 'RESOLVE_LANDING'; rollTotal: number; depth: number }
  /** Another obligation to request next (e.g. a card payment after loan interest). */
  | { kind: 'PAYMENT'; pending: Pending };

export interface DrawnCard {
  cardId: string;
  deck: Deck;
  table: CardTable;
  rollTotal: number;
  text: string;
  /** CARD: a printed card. BANK_EVENT: a landing with no card, settled by the bank (cards.ts BANK_EVENTS). */
  kind: 'CARD' | 'BANK_EVENT';
}

export interface TurnState {
  phase: TurnPhase;
  playerId: string | null;
  number: number;
  roll: DiceRoll | null;
  hasRolled: boolean;
  fromPosition: number | null;
  toPosition: number | null;
  passedStart: boolean;
  pending: Pending | null;
  /** Continues the turn once `pending` is paid. */
  followUp: FollowUp | null;
  card: DrawnCard | null;
  consecutiveDoubles: number;
}

/**
 * One entry of the undo history. Undo applies compensating transactions for
 * `moves` and restores `propertiesBefore` — but only while every property still
 * equals `propertiesAfter` (otherwise a later action superseded it).
 */
export interface UndoableRecord {
  actionId: string;
  actionType: string;
  actorId: string;
  description: string;
  transactionIds: string[];
  /** Snapshot of the money moves to reverse. */
  moves: { transactionId: string; fromPlayerId: string | null; toPlayerId: string | null; amount: number }[];
  propertyKey: PropertyKey | null;
  /** Property state right before the action (restored by undo). */
  propertiesBefore: PropertyState[];
  /** Property state right after the action (must still hold for undo to be allowed). */
  propertiesAfter: PropertyState[];
  /** Players (other than actor) whose money or property was touched. */
  counterpartyIds: string[];
  createdAt: string;
}

export type TradeStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

/** A player-to-player trade offer. Executed atomically on ACCEPT_TRADE after full revalidation. */
export interface TradeOffer {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  offeredPropertyKeys: PropertyKey[];
  requestedPropertyKeys: PropertyKey[];
  offeredMoney: number;
  requestedMoney: number;
  status: TradeStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UndoRequest {
  id: string;
  targetActionId: string;
  requestedBy: string;
  description: string;
  /** Any one of these players may approve/reject. */
  approverIds: string[];
  createdAt: string;
}

export interface GameState {
  id: string;
  code: string;
  rulesVersion: string;
  /** The ruleset, chosen by the host when the game was created. Never changes. */
  mode: GameMode;
  /**
   * The rules the host customised (starting cash, loan limit, market volatility, secret objectives).
   * Editable by the host while the game is WAITING; locked from START_GAME on.
   */
  config: GameConfig;
  /**
   * Secret objectives: null in Classic games, when the host disabled them, and before the game starts.
   * A device only ever holds its own assignment until the game has finished (see redactObjectives).
   */
  objectives: ObjectivesState | null;
  /** Capital Mode's economy (financial year, market, loans, credit). Null in Classic games and before the game starts. */
  intermediate: IntermediateState | null;
  status: GameStatus;
  /**
   * The host closed admission: nobody new can join while this is set. Only meaningful while WAITING
   * (a started game never takes new players). Missing on a snapshot from an older server means open.
   */
  lobbyLocked?: boolean;
  /** Status to restore when resuming from PAUSED. */
  pausedFrom: GameStatus | null;
  pausedAt: string | null;
  version: number;
  hostPlayerId: string | null;
  winnerId: string | null;
  players: PlayerState[];
  properties: Record<PropertyKey, PropertyState>;
  loans: LoanState[];
  auction: AuctionState | null;
  turn: TurnState;
  /** Undo history, oldest first. Only the last entry can be undone (then the one before, …). */
  undoStack: UndoableRecord[];
  undoRequest: UndoRequest | null;
  /** Open trade offers plus recently resolved ones. */
  trades: TradeOffer[];
  /**
   * How a hosted game ends: its duration, the vote in progress and the last result (gameEnd.ts).
   * Null or missing in the lobby, in a matchmade game (no duration, no votes) and in a game stored
   * before votes existed — a hosted one of those gets it the first time it is needed.
   */
  endGame?: GameEndState | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * EARLY: asked for by a player before the game's last financial year; a strict majority ends the game.
 * DURATION: opened by the server when the agreed duration is over; finish, or play one more year.
 */
export type EndVoteKind = 'EARLY' | 'DURATION';

/** END the game now, or CONTINUE (an early vote: keep playing; a duration vote: one more financial year). */
export type EndVoteChoice = 'END' | 'CONTINUE';

/** ENDED the game · CONTINUED after a failed early vote · EXTENDED by one financial year. */
export type EndVoteOutcome = 'ENDED' | 'CONTINUED' | 'EXTENDED';

/** One vote on ending the game. At most one is open per game, and while it is open nothing else is played. */
export interface EndVote {
  id: string;
  kind: EndVoteKind;
  /** The financial year it was opened in. */
  year: number;
  /** The player who asked for an early vote; null for a duration vote (nobody asks for that one). */
  requestedBy: string | null;
  /**
   * The players who may vote: everyone ACTIVE when the vote opened. Fixed for the whole vote — a
   * player who disconnects or leaves meanwhile still counts towards `required`.
   */
  electorate: string[];
  /** END ballots needed to end the game, worked out once from the electorate when the vote opened. */
  required: number;
  /**
   * One locked ballot per player. Secret: a device is only ever sent its own (redactEndVote), and no
   * event or result says who voted for what, or how many did.
   */
  ballots: Record<string, EndVoteChoice>;
  /** ISO timestamp on the server's clock: no ballot counts from this instant on. Never set by a client. */
  endsAt: string;
  createdAt: string;
  /** DURATION only: the player whose turn had just ended. If the game goes on, the next player after them plays. */
  resumeAfterPlayerId: string | null;
}

/** How the last vote ended. Deliberately without a tally. */
export interface EndVoteResult {
  id: string;
  kind: EndVoteKind;
  outcome: EndVoteOutcome;
  closedAt: string;
}

export interface GameEndState {
  /** Financial years added by duration votes. The game's limit is config.durationYears plus this, never past the maximum. */
  extraYears: number;
  /**
   * Classic only — a Capital game already keeps the calendar in its economy, and that one is used.
   * The same clock: spaces each starting player has moved by dice. Null in a Capital game.
   */
  calendar: { playerCount: number; movement: Record<string, number> } | null;
  /** Per player: the financial year in which they last asked for an early vote (once a year each). */
  requestedIn: Record<string, number>;
  vote: EndVote | null;
  lastResult: EndVoteResult | null;
}

export type TransactionType =
  | 'STARTING_FUNDS'
  | 'PROPERTY_PURCHASE'
  | 'RENT_PAYMENT'
  | 'PLAYER_TRANSFER'
  | 'TAX_PAYMENT'
  | 'HOUSE_PURCHASE'
  | 'HOUSE_SALE'
  | 'HOTEL_PURCHASE'
  | 'HOTEL_SALE'
  | 'PROPERTY_SALE'
  | 'AUCTION_PAYMENT'
  | 'LOAN_DISBURSEMENT'
  | 'LOAN_REPAYMENT'
  | 'START_REWARD'
  | 'LOAN_INTEREST'
  | 'CARD_PAYMENT'
  | 'CARD_REWARD'
  | 'CARD_COLLECTION'
  | 'CLUB_PAYMENT'
  | 'REST_HOUSE_COLLECTION'
  | 'JAIL_FINE'
  | 'TRADE_PAYMENT'
  | 'MORTGAGE'
  | 'UNMORTGAGE'
  | 'BANKRUPTCY_SETTLEMENT'
  | 'COLLATERAL_SURPLUS'
  | 'INSURANCE_PREMIUM'
  | 'CRISIS_PAYMENT'
  | 'OBJECTIVE_REWARD'
  /** A departed or bankrupt player's cash left after every claim on their estate was settled: it leaves play. */
  | 'ESTATE_SETTLEMENT'
  | 'UNDO_REVERSAL';

export interface TransactionRecord {
  id: string;
  actionId: string;
  type: TransactionType;
  /** null = bank */
  fromPlayerId: string | null;
  /** null = bank */
  toPlayerId: string | null;
  amount: number;
  propertyKey: PropertyKey | null;
  memo: string;
  reversesTransactionId: string | null;
  createdAt: string;
}

export interface GameEventRecord {
  id: string;
  type: string;
  actorId: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BidRecord {
  id: string;
  auctionId: string;
  playerId: string;
  amount: number;
  actionId: string;
  createdAt: string;
}

export interface EngineContext {
  actionId: string;
  /** ISO timestamp of "now" on the server. */
  now: string;
  /**
   * ISO timestamp at which the server received this request, before it queued for the game lock.
   * Decides whether a bid arrived in time; defaults to `now`. Never a client-supplied time.
   */
  receivedAt?: string;
  /** Uniform random in [0, 1). Injected so tests are deterministic. */
  random: () => number;
  newId: () => string;
}

export interface EngineResult {
  state: GameState;
  transactions: TransactionRecord[];
  events: GameEventRecord[];
  bids: BidRecord[];
  /** Phase transitions taken while processing (for auditing/tests). */
  transitions: { from: TurnPhase; to: TurnPhase }[];
}
