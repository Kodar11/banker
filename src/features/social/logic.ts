import { APP_NAME, joinLink } from '@/constants/app';
import { BUSINESS_MVP_RULES, type GameMode, type GameState } from '@/engine/index.ts';
import { PLAYER_ID_PATTERN } from '@/features/account/types';
import type { FriendRequest, GameInvite, InviteState, PresenceStatus, Relationship, SeatProfile, SocialNotification, SocialState } from './types';

/**
 * The rules of the social feature that need no server and no screen: Player ID input, how I stand
 * with someone, when a request or an invitation has run out, what a presence channel means, and
 * which server answer may replace which. The server enforces every one of them again; this is what
 * the phone shows in the meantime.
 */

// ---------------------------------------------------------------------------
// Player ID input (the same normalisation as public.normalize_player_id)
// ---------------------------------------------------------------------------
export type PlayerIdProblem = 'EMPTY' | 'MALFORMED';

export const PLAYER_ID_MESSAGES: Record<PlayerIdProblem, string> = {
  EMPTY: 'Enter a Player ID.',
  MALFORMED: 'A Player ID looks like RR-7K4P9X.',
};

/** Spaces removed, upper case, a missing dash added. null when the result is not a Player ID. */
export function normalizePlayerId(raw: string): string | null {
  const compact = (raw ?? '').replace(/\s+/g, '').toUpperCase();
  const dashed = /^RR[2-9A-HJ-NP-Z]{6}$/.test(compact) ? `RR-${compact.slice(2)}` : compact;
  return PLAYER_ID_PATTERN.test(dashed) ? dashed : null;
}

export function checkPlayerId(raw: string): { ok: true; playerId: string } | { ok: false; problem: PlayerIdProblem } {
  if (!(raw ?? '').trim()) return { ok: false, problem: 'EMPTY' };
  const playerId = normalizePlayerId(raw);
  return playerId ? { ok: true, playerId } : { ok: false, problem: 'MALFORMED' };
}

// ---------------------------------------------------------------------------
// Expiry (by the server's clock: pass serverNow())
// ---------------------------------------------------------------------------
export function isExpired(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  // A time that cannot be read is treated as passed: nothing stays actionable by accident.
  return !Number.isFinite(at) || at <= nowMs;
}

/** Outgoing and incoming requests that are still live at `nowMs`. */
export function liveRequests(requests: readonly FriendRequest[], nowMs: number): FriendRequest[] {
  return requests.filter((r) => !isExpired(r.expiresAt, nowMs));
}

/** The server's verdict, except that an open invitation runs out on the phone the moment its time passes. */
export function inviteStateAt(invite: Pick<GameInvite, 'state' | 'expiresAt'>, nowMs: number): InviteState {
  return invite.state === 'open' && isExpired(invite.expiresAt, nowMs) ? 'expired' : invite.state;
}

export const INVITE_REASONS: Record<Exclude<InviteState, 'open'>, string> = {
  started: 'The game has already started.',
  closed: 'This game has ended.',
  expired: 'This invitation has expired.',
  locked: 'The host has locked the lobby.',
  full: 'The lobby is full.',
};

/** "4:59" until the invitation runs out, or null once it has. */
export function inviteTimeLeft(expiresAt: string, nowMs: number): string | null {
  const left = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  const seconds = Math.ceil(left / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Lobbies and sharing
// ---------------------------------------------------------------------------
export const MODE_LABEL: Record<GameMode, string> = { classic: 'Classic', intermediate: 'Intermediate' };

/**
 * What the share sheet sends: the mode, the code, and the app's own deep link (the scheme in
 * app.json — the same link the lobby's QR code carries). Nothing about who is playing.
 */
export function gameShareMessage(mode: GameMode, code: string): string {
  return `Join my ${APP_NAME} ${MODE_LABEL[mode]} game! Code: ${code}. Open ${APP_NAME} and enter this code to join.\n${joinLink(code)}`;
}

/** Why nobody can be invited into this game right now, or null when they can. The server decides again. */
export function lobbyClosedReason(state: GameState, mySeatId: string | null): string | null {
  const me = state.players.find((p) => p.id === mySeatId);
  if (!me || me.status === 'LEFT') return 'You’re not in this lobby.';
  if (state.status !== 'WAITING') return 'The game has already started.';
  if (state.lobbyLocked) return 'The host has locked the lobby.';
  if (state.players.filter((p) => p.status !== 'LEFT').length >= BUSINESS_MVP_RULES.players.max) return 'The lobby is full.';
  return null;
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------
/** How I stand with `playerId`, from the last server answer. Expired requests no longer count. */
export function relationshipOf(state: SocialState | null, playerId: string, nowMs: number): Relationship {
  if (!state) return 'none';
  if (state.me.playerId === playerId) return 'self';
  if (state.blocked.some((p) => p.playerId === playerId)) return 'blocked';
  if (state.friends.some((p) => p.playerId === playerId)) return 'friends';
  if (liveRequests(state.outgoing, nowMs).some((p) => p.playerId === playerId)) return 'outgoing';
  if (liveRequests(state.incoming, nowMs).some((p) => p.playerId === playerId)) return 'incoming';
  return 'none';
}

/** What the "Add Friend" control of a player at my table shows. */
export type FriendAction = 'add' | 'sent' | 'respond' | 'friends' | 'unavailable';

export const FRIEND_ACTION_LABEL: Record<FriendAction, string> = {
  add: 'Add Friend',
  sent: 'Request Sent',
  respond: 'Respond to Request',
  friends: 'Friends',
  unavailable: 'Unavailable',
};

/**
 * `seat` is the server's description of that player's seat; undefined when it has none
 * (their app has no account attached to the seat, or the list has not loaded).
 */
export function friendActionOf(state: SocialState | null, seat: SeatProfile | undefined, nowMs: number): FriendAction {
  if (!state || !seat || seat.unavailable || !seat.player) return 'unavailable';
  switch (relationshipOf(state, seat.player.playerId, nowMs)) {
    case 'friends':
      return 'friends';
    case 'outgoing':
      return 'sent';
    case 'incoming':
      return 'respond';
    case 'none':
      return 'add';
    default:
      return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Reconciling server answers
// ---------------------------------------------------------------------------
/**
 * Whether `incoming` may replace `current`. Answers are ordered by the server's change counter, so a
 * slow response that left before a newer one can never bring back a removed friend or an expired
 * invitation. An equal version is accepted: it re-reads the parts decided by the clock.
 */
export function shouldApply(current: SocialState | null, incoming: SocialState): boolean {
  return !current || incoming.version >= current.version;
}

/** Whether a version heard over Realtime means the phone is behind. Duplicates and late events say no. */
export function isBehind(current: SocialState | null, announcedVersion: number): boolean {
  if (!Number.isFinite(announcedVersion)) return true;
  return !current || announcedVersion > current.version;
}

// ---------------------------------------------------------------------------
// Notifications and badges
// ---------------------------------------------------------------------------
export function notificationText(n: Pick<SocialNotification, 'type' | 'actor'>): string {
  const who = n.actor?.nickname ?? 'A player';
  switch (n.type) {
    case 'friend_request':
      return `${who} sent you a friend request`;
    case 'friend_accepted':
      return `${who} accepted your friend request`;
    case 'friends_matched':
      return `You and ${who} are now friends`;
    case 'game_invite':
      return `${who} invited you to a game`;
  }
}

/** Unread notifications not announced before. `announced` is updated: each one is returned once, ever. */
export function takeUnannounced(notifications: readonly SocialNotification[], announced: Set<string>): SocialNotification[] {
  const fresh = notifications.filter((n) => !n.read && !announced.has(n.id));
  for (const n of notifications) announced.add(n.id);
  return fresh;
}

export interface SocialBadges {
  /** Incoming friend requests waiting for an answer. */
  requests: number;
  /** Game invitations that can still be joined. */
  invites: number;
  /** The number on the Friends button: things to answer, plus news not yet seen. */
  total: number;
}

export function badgesOf(state: SocialState | null, nowMs: number): SocialBadges {
  if (!state) return { requests: 0, invites: 0, total: 0 };
  const requests = liveRequests(state.incoming, nowMs).length;
  const invites = state.invites.filter((i) => inviteStateAt(i, nowMs) === 'open').length;
  // A request or an invitation is counted once, as the thing to answer — not again as its notification.
  const news = state.notifications.filter((n) => !n.read && (n.type === 'friend_accepted' || n.type === 'friends_matched')).length;
  return { requests, invites, total: requests + invites + news };
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------
/** A friend who dropped off is shown offline only after this long without coming back. */
export const PRESENCE_OFFLINE_GRACE_MS = 12_000;

/** The most presence channels the Friends screen opens. Friends beyond it show "unknown". */
export const MAX_PRESENCE_CHANNELS = 50;

export interface PresenceObservation {
  /** My own subscription to their topic is joined and has delivered its state. */
  synced: boolean;
  /** At least one of their devices is on the topic. */
  present: boolean;
  /** When they were last seen leaving (ms), if they are not present. */
  leftAt: number | null;
}

/**
 * What to show for a friend.
 *   unknown  my channel is not up (not joined yet, or my own connection dropped) — never "offline"
 *   online   they are there
 *   online   they just dropped: a short reconnect must not flicker to offline
 *   offline  they are gone and the grace period is over (or they were never seen in this session)
 */
export function presenceStatusOf(o: PresenceObservation | undefined, nowMs: number): PresenceStatus {
  if (!o || !o.synced) return 'unknown';
  if (o.present) return 'online';
  if (o.leftAt !== null && nowMs - o.leftAt < PRESENCE_OFFLINE_GRACE_MS) return 'online';
  return 'offline';
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = { online: 'Online', offline: 'Offline', unknown: 'Unknown' };
