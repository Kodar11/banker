import {
  BUSINESS_MVP_RULES,
  DECK_LABELS,
  getDeed,
  isPropertyKey,
  minimumNextBid,
  positionOfProperty,
  spaceAt,
  spaceName,
  type GameEventRecord,
  type PlayerState,
} from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';
import { specialSquareInfo } from '@/features/board/squareInfo';
import { describeTradeSide } from '@/features/trade/TradeSheet';
import { describeWaiting, destinationLabel } from './describe';
import type { GameView } from './useGameView';

/**
 * What the main screen should put in front of the player right now. Pure
 * functions of the already-synced GameView: no fetching, no game rules, no
 * mutations — the server stays the only authority.
 */

export const PAY_ACTION = {
  RENT: 'PAY_RENT',
  TAX: 'PAY_TAX',
  CARD: 'PAY_CARD',
  LOAN_INTEREST: 'PAY_INTEREST',
  CLUB: 'PAY_CLUB',
} as const;

// ---------------------------------------------------------------------------
// Turn + primary action
// ---------------------------------------------------------------------------

export type PrimaryAction =
  | { kind: 'roll' }
  /** Opens the decision sheet (buy / jail / card / a payment I can't cover yet). */
  | { kind: 'choose'; label: string }
  | { kind: 'pay'; action: (typeof PAY_ACTION)[keyof typeof PAY_ACTION]; amount: number }
  | { kind: 'end-turn' }
  | { kind: 'bid'; auctionId: string; amount: number }
  | { kind: 'auction'; auctionId: string }
  | { kind: 'resume' }
  /** Someone else is playing: a status, not a button. */
  | { kind: 'waiting'; label: string };

export interface TurnStatus {
  title: string;
  detail: string;
  primary: PrimaryAction | null;
}

/** It's my turn and the game is waiting on a choice that needs more than one button. */
export function needsDecision(view: Pick<GameView, 'snapshot' | 'me' | 'isMyTurn'>): boolean {
  const { turn } = view.snapshot.state;
  const me = view.me;
  if (!view.isMyTurn || !me || me.status !== 'ACTIVE') return false;
  switch (turn.phase) {
    case 'AWAITING_ROLL':
      return me.inJail;
    case 'AWAITING_DECISION':
      return turn.pending?.kind === 'BUY';
    case 'AWAITING_PAYMENT':
      return turn.pending?.kind === 'PAYMENT';
    case 'AWAITING_CARD':
      return !!turn.card;
    default:
      return false;
  }
}

function rolledLine(view: Pick<GameView, 'snapshot'>): string | null {
  const { state } = view.snapshot;
  const roll = state.turn.roll;
  if (!roll) return null;
  const to = destinationLabel(state);
  return to ? `🎲 ${roll.total} → ${to}` : `🎲 ${roll.total}`;
}

export function turnStatus(view: Pick<GameView, 'snapshot' | 'me' | 'current' | 'isMyTurn' | 'playerName'>): TurnStatus {
  const { state } = view.snapshot;
  const { turn } = state;
  const me = view.me;
  const turnNo = `Turn ${turn.number}`;
  if (state.status === 'PAUSED') {
    return { title: 'GAME PAUSED', detail: `${turnNo} · No dice or payments until resumed`, primary: me ? { kind: 'resume' } : null };
  }
  if (state.status === 'FINISHED') {
    return { title: 'GAME OVER', detail: state.winnerId ? `${view.playerName(state.winnerId)} wins` : 'Final positions', primary: null };
  }
  if (state.status !== 'ACTIVE' || !view.current) return { title: 'WAITING TO START', detail: 'Players gather in the lobby', primary: null };

  const current = view.current;
  const title = view.isMyTurn ? 'YOUR TURN' : `${current.name.toUpperCase()}'S TURN`;
  const rolled = rolledLine(view);

  const auction = state.auction?.status === 'OPEN' ? state.auction : null;
  if (turn.phase === 'AUCTION' && auction) {
    const min = minimumNextBid(auction);
    const canBid =
      !!me && auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id) && auction.highBidderId !== me.id && me.balance >= min;
    return {
      title,
      detail: `${turnNo} · Auction: ${getDeed(auction.propertyKey).name}`,
      primary: canBid ? { kind: 'bid', auctionId: auction.id, amount: min } : { kind: 'auction', auctionId: auction.id },
    };
  }

  if (!view.isMyTurn || !me) {
    const label = turn.phase === 'AWAITING_ROLL' ? (current.inJail ? 'In Jail…' : 'Rolling…') : rolled ? `🎲 ${turn.roll!.total}` : 'Waiting…';
    return { title, detail: `${turnNo} · ${describeWaiting(state, current.name)}`, primary: { kind: 'waiting', label } };
  }

  const pending = turn.pending;
  switch (turn.phase) {
    case 'AWAITING_ROLL':
      return me.inJail
        ? { title, detail: `${turnNo} · In Jail — pay or stay`, primary: { kind: 'choose', label: 'Choose' } }
        : { title, detail: `${turnNo} · Roll the dice to move`, primary: { kind: 'roll' } };
    case 'AWAITING_DECISION':
      return { title, detail: `${turnNo} · ${rolled ?? 'Choose what to do'}`, primary: { kind: 'choose', label: 'Choose' } };
    case 'AWAITING_PAYMENT':
      if (pending?.kind !== 'PAYMENT') break;
      return {
        title,
        detail: `${turnNo} · ${rolled ?? pending.label}`,
        primary: me.balance >= pending.amount ? { kind: 'pay', action: PAY_ACTION[pending.reason], amount: pending.amount } : { kind: 'choose', label: 'Raise cash' },
      };
    case 'AWAITING_CARD':
      return { title, detail: `${turnNo} · ${rolled ?? 'Read your card'}`, primary: { kind: 'choose', label: 'Read card' } };
    case 'TURN_COMPLETE':
      return { title, detail: `${turnNo} · ${rolled ?? 'All done'}`, primary: { kind: 'end-turn' } };
    default:
      break;
  }
  return { title, detail: `${turnNo} · Choose what to do`, primary: null };
}

// ---------------------------------------------------------------------------
// Contextual card — the single most relevant thing to know right now
// ---------------------------------------------------------------------------

export type ContextTarget =
  | { kind: 'requests' }
  | { kind: 'decision' }
  | { kind: 'square'; index: number }
  | { kind: 'auction'; auctionId: string }
  | { kind: 'log' }
  | { kind: 'standings' };

export type ContextKind = 'offer' | 'undo' | 'auction' | 'decision' | 'payment' | 'event' | 'news' | 'position' | 'paused' | 'finished' | 'neutral';

export interface ContextItem {
  kind: ContextKind;
  icon: string;
  label: string;
  title: string;
  detail?: string;
  cta?: { label: string; target: ContextTarget };
}

/** Events that never deserve the card on their own (the turn bar / board already say it). */
const ROUTINE_EVENTS: ReadonlySet<string> = new Set([
  'GAME_CREATED',
  'PLAYER_JOINED',
  'PLAYER_READY',
  'GAME_STARTED',
  'GAME_PAUSED',
  'GAME_RESUMED',
  'GAME_FINISHED',
  'TURN_STARTED',
  'DICE_ROLLED',
  'MOVED',
  'EXTRA_ROLL',
  'AUCTION_STARTED',
  'BID_PLACED',
  'AUCTION_PASSED',
  'LOAN_INTEREST_DUE',
  'UNDO_REQUESTED',
]);

/** Game-changing moments, shown above ordinary news. */
const IMPORTANT_EVENTS: Readonly<Record<string, { icon: string; label: string }>> = {
  CARD_DRAWN: { icon: '🃏', label: 'Card drawn' },
  SENT_TO_JAIL: { icon: '🔒', label: 'Sent to Jail' },
  JAIL_RELEASED: { icon: '🔓', label: 'Released' },
  PLAYER_BANKRUPT: { icon: '💥', label: 'Bankrupt' },
  PLAYER_LEFT: { icon: '🚪', label: 'Left the game' },
  HOST_CHANGED: { icon: '👑', label: 'New host' },
  AUCTION_WON: { icon: '🔨', label: 'Auction result' },
  AUCTION_UNSOLD: { icon: '🔨', label: 'Auction result' },
  REST_HOUSE: { icon: '🛏️', label: 'Rest House' },
  TRADE_ACCEPTED: { icon: '🤝', label: 'Trade done' },
  UNDO_APPLIED: { icon: '↩️', label: 'Undone' },
};

function payeeOf(view: Pick<GameView, 'playerName'>, pending: { toPlayerId: string | null; payeeIds?: string[] }): string {
  if (pending.payeeIds?.length) return 'each other player';
  return pending.toPlayerId ? view.playerName(pending.toPlayerId) : 'the Bank';
}

function squareTarget(index: number, kind: 'property' | 'square'): ContextItem['cta'] {
  return { label: kind === 'property' ? 'View Property' : 'View Square', target: { kind: 'square', index } };
}

function eventSquare(event: GameEventRecord): number | null {
  const key = event.payload.propertyKey;
  return typeof key === 'string' && isPropertyKey(key) ? positionOfProperty(key) : null;
}

function positionItem(view: Pick<GameView, 'snapshot' | 'me' | 'current' | 'isMyTurn' | 'playerName'>): ContextItem {
  const { state } = view.snapshot;
  // While someone else is mid-move, everyone wants to know where they landed; otherwise: where am I?
  const who: PlayerState | null =
    !view.isMyTurn && view.current && state.turn.hasRolled ? view.current : view.me?.status === 'ACTIVE' ? view.me : view.current;
  if (!who) return { kind: 'neutral', icon: '🎲', label: 'Game in progress', title: 'Follow the turn on the board' };
  const index = who.position;
  const space = spaceAt(index);
  const isMe = who.id === view.me?.id;
  const label = isMe ? 'You are on' : `${who.name} is on`;
  if (space.kind === 'PROPERTY') {
    const deed = getDeed(space.propertyKey);
    const prop = state.properties[space.propertyKey];
    const owner = prop.ownerId ? (prop.ownerId === view.me?.id ? 'Owned by you' : `Owned by ${view.playerName(prop.ownerId)}`) : 'Not owned';
    return {
      kind: 'position',
      icon: '📍',
      label,
      title: deed.name,
      detail: `${formatINR(deed.price)} · ${owner}${prop.mortgaged ? ' · Mortgaged' : ''}`,
      cta: squareTarget(index, 'property'),
    };
  }
  const where = who.inJail
    ? `In Jail · ${who.jailTurnsLeft} turn${who.jailTurnsLeft === 1 ? '' : 's'} left`
    : who.skipTurns > 0
      ? 'Resting · misses the next turn'
      : specialSquareInfo(space.type, state, view.me)[0];
  return { kind: 'position', icon: '📍', label, title: spaceName(index), detail: where, cta: squareTarget(index, 'square') };
}

/**
 * Priority: 1) offers / decisions that need me, 2) payments, 3) important events,
 * 4) news, 5) where I (or the moving player) stand, 6) a neutral fallback.
 */
export function pickContext(view: Pick<GameView, 'snapshot' | 'me' | 'current' | 'isMyTurn' | 'playerName'>): ContextItem {
  const { state, events } = view.snapshot;
  const { turn } = state;
  const me = view.me;

  if (state.status === 'FINISHED') {
    return {
      kind: 'finished',
      icon: '🏆',
      label: 'Game over',
      title: state.winnerId ? `${view.playerName(state.winnerId)} wins!` : 'Game over',
      detail: 'Highest net worth wins',
      cta: { label: 'Standings', target: { kind: 'standings' } },
    };
  }
  if (state.status === 'PAUSED') {
    return { kind: 'paused', icon: '⏸️', label: 'Game paused', title: 'Everything is on hold', detail: 'No dice, purchases or payments until someone resumes.' };
  }

  const auction = state.auction?.status === 'OPEN' ? state.auction : null;
  const auctionItem = (): ContextItem | null =>
    auction
      ? {
          kind: 'auction',
          icon: '🔨',
          label: 'Auction',
          title: `${getDeed(auction.propertyKey).name} is up for bids`,
          detail: auction.highBid === null ? `Opening bid ${formatINR(minimumNextBid(auction))}` : `Highest ${formatINR(auction.highBid)} · ${view.playerName(auction.highBidderId)}`,
          cta: { label: 'View Auction', target: { kind: 'auction', auctionId: auction.id } },
        }
      : null;

  if (me && me.status === 'ACTIVE') {
    // 1. Things only I can answer.
    const undo = state.undoRequest;
    if (undo && undo.approverIds.includes(me.id)) {
      return {
        kind: 'undo',
        icon: '↩️',
        label: 'Undo request',
        title: `${view.playerName(undo.requestedBy)} wants to undo`,
        detail: undo.description,
        cta: { label: 'Review', target: { kind: 'requests' } },
      };
    }
    const incoming = state.trades.filter((t) => t.status === 'PENDING' && t.toPlayerId === me.id);
    const offer = incoming[0];
    if (offer) {
      return {
        kind: 'offer',
        icon: '🔄',
        label: incoming.length > 1 ? `Trade offers (${incoming.length})` : 'Trade offer',
        title: `${view.playerName(offer.fromPlayerId)} wants to trade`,
        detail: `You get ${describeTradeSide(offer.offeredPropertyKeys, offer.offeredMoney, state)} ↔ you give ${describeTradeSide(offer.requestedPropertyKeys, offer.requestedMoney, state)}`,
        cta: { label: 'Review Offer', target: { kind: 'requests' } },
      };
    }
    if (auction && auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id)) return auctionItem()!;
    if (needsDecision(view) && turn.phase !== 'AWAITING_PAYMENT') {
      const pending = turn.pending;
      if (turn.phase === 'AWAITING_DECISION' && pending?.kind === 'BUY') {
        const deed = getDeed(pending.propertyKey);
        return {
          kind: 'decision',
          icon: '🏷️',
          label: 'For sale',
          title: `${deed.name} · ${formatINR(deed.price)}`,
          detail: BUSINESS_MVP_RULES.auction.enabled ? 'Not owned — buy it or send it to auction' : 'Not owned — buy it or pass',
          cta: { label: 'Choose', target: { kind: 'decision' } },
        };
      }
      if (turn.phase === 'AWAITING_ROLL') {
        return {
          kind: 'decision',
          icon: '🔒',
          label: 'In Jail',
          title: `Pay ${formatINR(BUSINESS_MVP_RULES.jail.fine)} to leave, or stay`,
          detail: `${me.jailTurnsLeft} turn${me.jailTurnsLeft === 1 ? '' : 's'} left in Jail`,
          cta: { label: 'Choose', target: { kind: 'decision' } },
        };
      }
      if (turn.card) {
        return {
          kind: 'decision',
          icon: '🃏',
          label: DECK_LABELS[turn.card.deck],
          title: `Read entry ${turn.card.rollTotal} on your card`,
          detail: 'Enter what your physical card says',
          cta: { label: 'Choose', target: { kind: 'decision' } },
        };
      }
    }

    // 2. Money that has to move.
    const pending = turn.pending;
    if (turn.phase === 'AWAITING_PAYMENT' && pending?.kind === 'PAYMENT') {
      if (view.isMyTurn) {
        return {
          kind: 'payment',
          icon: '💰',
          label: 'Payment required',
          title: `You owe ${formatINR(pending.amount)}`,
          detail: `to ${payeeOf(view, pending)} · ${pending.label}`,
          cta: { label: 'View Payment', target: { kind: 'decision' } },
        };
      }
      if (pending.toPlayerId === me.id || pending.payeeIds?.includes(me.id)) {
        return {
          kind: 'payment',
          icon: '💰',
          label: 'Payment due to you',
          title: `${view.current?.name ?? 'Someone'} owes ${pending.payeeIds?.length ? 'each player' : 'you'} ${formatINR(pending.payeeIds?.length ? Math.floor(pending.amount / pending.payeeIds.length) : pending.amount)}`,
          detail: pending.label,
          cta: squareTarget(pending.propertyKey ? positionOfProperty(pending.propertyKey) : (view.current?.position ?? 0), pending.propertyKey ? 'property' : 'square'),
        };
      }
    }
  }

  // 3. Important things happening at the table.
  const watching = auctionItem();
  if (watching) return watching;
  if (me) {
    const mine = state.trades.find((t) => t.status === 'PENDING' && t.fromPlayerId === me.id);
    if (mine) {
      return {
        kind: 'event',
        icon: '🔄',
        label: 'Your offer',
        title: `Waiting for ${view.playerName(mine.toPlayerId)}`,
        detail: `${describeTradeSide(mine.offeredPropertyKeys, mine.offeredMoney, state)} ↔ ${describeTradeSide(mine.requestedPropertyKeys, mine.requestedMoney, state)}`,
        cta: { label: 'View', target: { kind: 'requests' } },
      };
    }
    if (state.undoRequest?.requestedBy === me.id) {
      return {
        kind: 'event',
        icon: '↩️',
        label: 'Undo requested',
        title: 'Waiting for approval',
        detail: state.undoRequest.description,
        cta: { label: 'View', target: { kind: 'requests' } },
      };
    }
  }
  const latest = events[0];
  if (latest && !ROUTINE_EVENTS.has(latest.type)) {
    const important = IMPORTANT_EVENTS[latest.type];
    const square = eventSquare(latest);
    return {
      kind: important ? 'event' : 'news',
      icon: important?.icon ?? '📰',
      label: important?.label ?? 'Latest',
      title: latest.message,
      cta: square !== null ? squareTarget(square, 'property') : { label: 'Game log', target: { kind: 'log' } },
    };
  }

  // 5–6. Where things stand.
  return positionItem(view);
}
