import { getDeed, isPropertyKey } from './businessBoard.ts';
import { configOf, type ConfigAware } from './gameConfig.ts';
import type { GameSnapshot } from './protocol.ts';
import type { GameEventRecord, GameState, Pending, TurnState, UndoableRecord, UndoRequest } from './types.ts';

/**
 * Open / Hidden finances — THE visibility policy, in one place.
 *
 * The host picks it when the game is created (GameConfig.financialPrivacy) and it never changes.
 * With hidden finances a player's money is theirs alone while the game runs:
 *
 *   private  cash, the ledger, loans and repayments, credit score and its history, insurance (whether
 *            a property is insured at all, until a crisis strikes it), and the rupee amounts of
 *            taxes, card charges and other personal payments
 *   public   who is where on the board, who owns what, houses and hotels, mortgages, purchases and
 *            sales, rent, auctions and bids, trades, crises and how they ended
 *
 * The server is the boundary: every snapshot it sends goes through redactFinances for the player it
 * is sent to, and every broadcast through publicEvents. The app uses the same predicates
 * (canSeeFinances, financesHidden) only to decide what to draw - it never holds what it may not show.
 *
 * When the game has finished everything is revealed, like the secret objectives: the final standings
 * are net worths, and there is nothing left to keep from anyone.
 */

type PrivacyState = ConfigAware & Pick<GameState, 'status'>;

/** Hidden finances are in force: the host chose them and the game has not finished. */
export function financesHidden(state: PrivacyState): boolean {
  return configOf(state).financialPrivacy === 'hidden' && state.status !== 'FINISHED';
}

/** May `viewerId` see `playerId`'s cash, ledger, loans and credit? Always their own; anyone's when finances are open. */
export function canSeeFinances(state: PrivacyState, viewerId: string | null | undefined, playerId: string): boolean {
  return !financesHidden(state) || (!!viewerId && viewerId === playerId);
}

/** What a redacted snapshot carries in place of an amount the viewer may not see. Never shown: the app asks canSeeFinances first. */
const WITHHELD = 0;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type PublicView = { message: string; payload: Record<string, unknown> } | null;

interface EventRule {
  /** Besides the actor: players who took part and read the event in full. */
  parties?: (event: GameEventRecord) => unknown[];
  /** What everyone else reads. Null: nothing - the event is the player's own business. */
  publicView: (event: GameEventRecord, name: (id: unknown) => string) => PublicView;
}

const nothing = (): PublicView => null;
const deedName = (key: unknown): string => (typeof key === 'string' && isPropertyKey(key) ? getDeed(key).name : 'a property');

/** Shown to all, exactly as written: board, property, auction, trade and crisis events. */
const PUBLIC = 'PUBLIC' as const;
/** The player's own business: nobody else is told. */
const PRIVATE: EventRule = { publicView: nothing };

/**
 * Every event the engine emits, classified. `PUBLIC` events carry no private money; the others are
 * replaced for everyone but the players involved by a version without it, or left out.
 * An event type missing here is treated as private (privacy fails closed), and
 * tests/engine/financialPrivacy.test.ts fails until it is classified.
 */
export const EVENT_PRIVACY: Readonly<Record<string, typeof PUBLIC | EventRule>> = {
  // Lobby and lifecycle
  GAME_CREATED: PUBLIC,
  PLAYER_JOINED: PUBLIC,
  PLAYER_READY: PUBLIC,
  GAME_CONFIG_UPDATED: PUBLIC,
  LOBBY_LOCK_CHANGED: PUBLIC,
  PLAYER_REMOVED: PUBLIC,
  GAME_STARTED: PUBLIC,
  GAME_PAUSED: PUBLIC,
  GAME_RESUMED: PUBLIC,
  GAME_FINISHED: PUBLIC,
  OBJECTIVE_RESULT: PUBLIC,
  PLAYER_LEFT: PUBLIC,
  HOST_CHANGED: PUBLIC,
  PLAYER_BANKRUPT: PUBLIC,
  // Votes on ending the game: that one opened and how it ended. Never who voted for what, or how many.
  // Classic's count of financial years (Capital announces its own, with the market, below).
  GAME_YEAR_STARTED: PUBLIC,
  END_VOTE_STARTED: PUBLIC,
  END_VOTE_CLOSED: PUBLIC,
  // Movement and the board
  DICE_ROLLED: PUBLIC,
  MOVED: PUBLIC,
  TURN_STARTED: PUBLIC,
  TURN_SKIPPED: PUBLIC,
  EXTRA_ROLL: PUBLIC,
  SENT_TO_JAIL: PUBLIC,
  JAIL_RELEASED: PUBLIC,
  JAIL_STAYED: PUBLIC,
  LANDED_OWN: PUBLIC,
  NO_RENT: PUBLIC,
  TAX_NONE: PUBLIC,
  // The card is fixed by the square and the dice, both public: drawing it tells nobody anything new.
  CARD_DRAWN: PUBLIC,
  CARD_NOTHING_TO_PAY: PUBLIC,
  PAYMENT_CANCELLED: PUBLIC,
  // Property, auctions and trades
  PROPERTY_PURCHASED: PUBLIC,
  PROPERTY_DECLINED: PUBLIC,
  PROPERTY_SOLD: PUBLIC,
  PROPERTY_MORTGAGED: PUBLIC,
  PROPERTY_UNMORTGAGED: PUBLIC,
  HOUSE_BUILT: PUBLIC,
  HOTEL_BUILT: PUBLIC,
  BUILDING_SOLD: PUBLIC,
  AUCTION_STARTED: PUBLIC,
  AUCTION_CANCELLED: PUBLIC,
  AUCTION_UNSOLD: PUBLIC,
  AUCTION_WON: PUBLIC,
  AUCTION_PASSED: PUBLIC,
  BID_PLACED: PUBLIC,
  TRADE_OFFERED: PUBLIC,
  TRADE_ACCEPTED: PUBLIC,
  TRADE_REJECTED: PUBLIC,
  TRADE_CANCELLED: PUBLIC,
  UNDO_REJECTED: PUBLIC,
  // Capital Mode: the shared calendar, and crises with their outcome
  FINANCIAL_YEAR_STARTED: PUBLIC,
  CRISIS_STRUCK: PUBLIC,
  CRISIS_COVERED: PUBLIC,
  CRISIS_SETTLED: PUBLIC,
  CRISIS_UNPAID: PUBLIC,

  // Public events with a private amount: the event stays, the money goes.
  PASSED_START: { publicView: (e, name) => ({ message: `${name(e.actorId)} passed Start`, payload: {} }) },
  JAIL_FINE_PAID: { publicView: (e, name) => ({ message: `${name(e.actorId)} left Jail`, payload: {} }) },
  REST_HOUSE: { publicView: (e, name) => ({ message: `${name(e.actorId)} rests at the Rest House and skips the next turn`, payload: {} }) },
  CARD_RESOLVED: { publicView: (e, name) => ({ message: `${name(e.actorId)} resolved a card`, payload: {} }) },
  // The property changes hands, which the board shows anyway; the loan behind it stays private.
  COLLATERAL_SEIZED: {
    publicView: (e, name) => ({ message: `The bank took ${deedName(e.payload.propertyKey)} from ${name(e.actorId)}`, payload: { propertyKey: e.payload.propertyKey } }),
  },
  // A trade offer that named a property just pledged for a loan: the offer closes for all to see, the reason does not.
  TRADE_EXPIRED: {
    publicView: (e) => ({ message: e.message.replace(/ was pledged as loan collateral$/, ' is no longer available'), payload: e.payload }),
  },
  PAYMENT_MADE: {
    parties: (e) => [e.payload.toPlayerId],
    publicView: (e, name) => {
      const who = name(e.actorId);
      switch (e.payload.reason) {
        // The Club fee is paid to every other player: the whole table took part.
        case 'CLUB':
        // Rent is set by the deed and what is built on it, all of it on the board for everyone to read.
        case 'RENT':
          return { message: e.message, payload: e.payload };
        case 'TAX':
          return { message: `${who} paid tax`, payload: { reason: 'TAX' } };
        case 'CARD':
          return { message: `${who} paid for a card`, payload: { reason: 'CARD' } };
        // Loan interest (and anything this version does not know): that there is a loan at all is private.
        default:
          return null;
      }
    },
  },
  MONEY_TRANSFERRED: {
    parties: (e) => [e.payload.toPlayerId],
    publicView: (e, name) => ({ message: `${name(e.actorId)} paid ${name(e.payload.toPlayerId)}`, payload: { toPlayerId: e.payload.toPlayerId } }),
  },
  // The approvers read what is to be undone in the request itself (redactState keeps it for them).
  UNDO_REQUESTED: { publicView: (e, name) => ({ message: `${name(e.actorId)} asked to undo an action`, payload: {} }) },
  UNDO_APPLIED: { publicView: (e, name) => ({ message: `An action was undone (approved by ${name(e.actorId)})`, payload: {} }) },

  // A player's own business.
  // Whether a property is insured is its owner's secret until a crisis strikes it (CRISIS_COVERED / CRISIS_STRUCK tell the table then).
  INSURANCE_PURCHASED: PRIVATE,
  INSURANCE_ENDED: PRIVATE,
  INSURANCE_EXPIRED: PRIVATE,
  CARD_SHORTFALL: PRIVATE,
  REST_HOUSE_SHORTFALL: PRIVATE,
  LOAN_TAKEN: PRIVATE,
  LOAN_REPAID: PRIVATE,
  LOAN_INTEREST_DUE: PRIVATE,
  LOAN_INTEREST_PAID: PRIVATE,
  INTERMEDIATE_LOAN_TAKEN: PRIVATE,
  INTERMEDIATE_LOAN_REPAID: PRIVATE,
  LOAN_INSTALLMENT_DUE: PRIVATE,
  LOAN_INSTALLMENT_OVERDUE: PRIVATE,
  LOAN_INSTALLMENT_PAID: PRIVATE,
  LOAN_INSTALLMENT_CAUGHT_UP: PRIVATE,
  LOAN_RATE_CHANGED: PRIVATE,
  LOAN_DEFAULTED: PRIVATE,
  LOAN_PREPAID: PRIVATE,
  LOAN_DEFAULT_PAYMENT: PRIVATE,
  CREDIT_SCORE_CHANGED: PRIVATE,
  // Classic loan principal: due, overdue (LOAN_DEFAULTED above covers the default).
  LOAN_PRINCIPAL_DUE: PRIVATE,
  LOAN_OVERDUE: PRIVATE,
  // A departed or bankrupt player's estate: what each creditor was paid. The table sees that it was
  // settled and what returned to the bank (the board shows it anyway); the debts behind it stay private.
  ESTATE_SETTLED: {
    parties: (e) => (Array.isArray(e.payload.creditorIds) ? e.payload.creditorIds : []),
    publicView: (e, name) => ({ message: `${name(e.actorId)}'s estate was settled`, payload: { propertiesReturned: e.payload.propertiesReturned } }),
  },
};

/**
 * One event as `viewerId` may read it under hidden finances: unchanged for a public event and for the
 * players involved, without the private money for everyone else, or null when it is not theirs to see.
 * A null viewer is "anyone at all" (the realtime broadcast).
 */
export function viewEvent(event: GameEventRecord, viewerId: string | null, name: (id: unknown) => string): GameEventRecord | null {
  const rule = EVENT_PRIVACY[event.type] ?? PRIVATE;
  if (rule === PUBLIC) return event;
  if (viewerId !== null && (event.actorId === viewerId || (rule.parties?.(event) ?? []).includes(viewerId))) return event;
  const view = rule.publicView(event, name);
  return view ? { ...event, message: view.message, payload: view.payload } : null;
}

function namer(state: Pick<GameState, 'players'>): (id: unknown) => string {
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  return (id) => (id === null || id === undefined ? 'the Bank' : (names.get(String(id)) ?? 'A player'));
}

/**
 * Events as they may be sent to everyone at once (the realtime broadcast, which is not addressed to
 * one player). With open finances, or once the game has finished, that is the events themselves.
 */
export function publicEvents<E extends GameEventRecord>(state: PrivacyState & Pick<GameState, 'players'>, events: readonly E[]): GameEventRecord[] {
  if (!financesHidden(state)) return [...events];
  const name = namer(state);
  return events.flatMap((e) => viewEvent(e, null, name) ?? []);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** An amount another player owes is theirs and their payee's. Rent is public, and the Club fee is owed to the whole table. */
function redactTurn(turn: TurnState, viewerId: string | null): TurnState {
  if (viewerId !== null && turn.playerId === viewerId) return turn;
  const pending: Pending | null = turn.pending;
  const involved =
    pending?.kind !== 'PAYMENT' ||
    pending.reason === 'CLUB' ||
    pending.reason === 'RENT' ||
    (viewerId !== null && (pending.toPlayerId === viewerId || (pending.payeeIds ?? []).includes(viewerId)));
  // Not theirs to see: the phase still says a payment is awaited; what for and how much does not travel.
  return { ...turn, pending: involved ? pending : null, followUp: null };
}

const OTHERS_ACTION = "Another player's action";

function redactUndoRecord(record: UndoableRecord, viewerId: string | null): UndoableRecord {
  if (viewerId !== null && (record.actorId === viewerId || record.counterpartyIds.includes(viewerId))) return record;
  return { ...record, description: OTHERS_ACTION, transactionIds: [], moves: [] };
}

function redactUndoRequest(request: UndoRequest | null, viewerId: string | null): UndoRequest | null {
  if (!request) return null;
  // Whoever asked, and whoever is asked to approve, has to know what it is about.
  if (viewerId !== null && (request.requestedBy === viewerId || request.approverIds.includes(viewerId))) return request;
  return { ...request, description: OTHERS_ACTION };
}

function redactState(state: GameState, viewerId: string | null): GameState {
  const own = (id: string | null) => viewerId !== null && id === viewerId;
  const ownEntry = <T>(record: Record<string, T>): Record<string, T> => (viewerId !== null && viewerId in record ? { [viewerId]: record[viewerId]! } : {});
  const eco = state.intermediate;
  return {
    ...state,
    players: state.players.map((p) => (own(p.id) ? p : { ...p, balance: WITHHELD })),
    loans: state.loans.filter((l) => own(l.playerId)),
    intermediate: eco
      ? {
          ...eco,
          credit: ownEntry(eco.credit),
          creditEvents: eco.creditEvents.filter((e) => own(e.playerId)),
          loans: eco.loans.filter((l) => own(l.playerId)),
          yearFlags: ownEntry(eco.yearFlags),
          // Another player's policies do not travel at all: the crises stay, and say how each one ended.
          ...(eco.insurance ? { insurance: { ...eco.insurance, policies: eco.insurance.policies.filter((p) => own(p.ownerId)) } } : {}),
        }
      : eco,
    turn: redactTurn(state.turn, viewerId),
    undoStack: state.undoStack.map((r) => redactUndoRecord(r, viewerId)),
    undoRequest: redactUndoRequest(state.undoRequest, viewerId),
  };
}

/**
 * The snapshot as one player may receive it. THE privacy boundary for finances: the server passes
 * every snapshot through here before it leaves (db.loadSnapshot). With open finances, or once the
 * game has finished, it is returned untouched. With hidden finances the viewer keeps everything of
 * their own and loses, of everyone else: cash, loans, credit, insurance, amounts owed, ledger entries
 * they took no part in, and the private side of the event feed.
 */
export function redactFinances(snapshot: GameSnapshot, viewerId: string | null): GameSnapshot {
  const { state } = snapshot;
  if (!financesHidden(state)) return snapshot;
  const own = (id: string | null) => viewerId !== null && id === viewerId;
  const name = namer(state);
  return {
    ...snapshot,
    state: redactState(state, viewerId),
    // Order and timestamps are the server's: events are only ever rewritten in place or left out.
    events: snapshot.events.flatMap((e) => viewEvent(e, viewerId, name) ?? []),
    transactions: snapshot.transactions.filter((t) => own(t.fromPlayerId) || own(t.toPlayerId)),
  };
}
