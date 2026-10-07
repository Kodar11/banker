import type { PropertyKey } from './businessBoard.ts';
import type { Deck } from './cards.ts';

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
  seat: number;
  isHost: boolean;
  ready: boolean;
  balance: number;
  position: number;
  status: PlayerStatus;
  /** Turns this player will skip (Rest House / Jail). */
  skipTurns: number;
  inJail: boolean;
}

export interface PropertyState {
  key: PropertyKey;
  ownerId: string | null;
  houses: number;
  hotel: boolean;
  mortgaged: boolean;
}

export type LoanStatus = 'ACTIVE' | 'REPAID' | 'DEFAULTED';

export interface LoanState {
  id: string;
  playerId: string;
  principal: number;
  interestRatePercent: number;
  totalOwed: number;
  outstanding: number;
  status: LoanStatus;
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

export type PaymentReason = 'RENT' | 'TAX' | 'CARD';

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
    }
  | { kind: 'CARD_MANUAL'; cardId: string; deck: Deck; rollTotal: number };

export interface DrawnCard {
  cardId: string;
  deck: Deck;
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
  card: DrawnCard | null;
  consecutiveDoubles: number;
}

export interface UndoableRecord {
  actionId: string;
  actionType: string;
  actorId: string;
  description: string;
  transactionIds: string[];
  /** Snapshot of the money moves to reverse. */
  moves: { transactionId: string; fromPlayerId: string | null; toPlayerId: string | null; amount: number }[];
  propertyKey: PropertyKey | null;
  /** Players (other than actor) whose money was touched. */
  counterpartyIds: string[];
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
  lastUndoable: UndoableRecord | null;
  undoRequest: UndoRequest | null;
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
  | 'CARD_PAYMENT'
  | 'CARD_REWARD'
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
