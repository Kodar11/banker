import type { PropertyKey } from './businessBoard.ts';
import type { CardTable, Deck } from './cards.ts';

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

export type PlayerStatus = 'ACTIVE' | 'BANKRUPT';

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
}

export interface PropertyState {
  key: PropertyKey;
  ownerId: string | null;
  houses: number;
  hotel: boolean;
  mortgaged: boolean;
}

export type LoanStatus = 'ACTIVE' | 'REPAID' | 'DEFAULTED';

/**
 * A bank loan. The principal is repaid with REPAY_LOAN; interest is NOT added
 * when borrowing — it becomes payable (in cash, to the bank) when the borrower
 * next reaches/passes Start (see BUSINESS_MVP_RULES.loans).
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
  createdAt: string;
  closedAt: string | null;
}

export type AuctionStatus = 'OPEN' | 'CLOSED';

export interface AuctionState {
  id: string;
  propertyKey: PropertyKey;
  status: AuctionStatus;
  highBid: number | null;
  highBidderId: string | null;
  minimumOpeningBid: number;
  minimumIncrement: number;
  /** ISO timestamp. Bidding closes after this unless someone bids. */
  endsAt: string;
  participantIds: string[];
  passedIds: string[];
  winnerId: string | null;
  createdAt: string;
  closedAt: string | null;
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
  verified: boolean;
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
  status: GameStatus;
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
  createdAt: string;
  expiresAt: string;
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
