import {
  toPublicPlayer,
  toSeatProfiles,
  toSocialState,
  type PublicPlayer,
  type Relationship,
  type SeatProfile,
  type SocialError,
  type SocialErrorCode,
  type SocialResult,
  type SocialState,
} from '@/features/social/types';
import type { Credentials } from './gameApi';
import { recordServerTime } from './serverClock';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Every call the social feature makes to Supabase: one database function each, as the signed-in
 * player. Nothing here decides what a result means for the screen — that is socialStore's job —
 * and nothing here throws. The server never sends an internal error; unknown codes become SERVER.
 */
const TIMEOUT_MS = 12_000;

const MESSAGES: Record<SocialErrorCode, string> = {
  NOT_CONFIGURED: 'The game server is not configured.',
  NETWORK: 'No connection. Check your internet and try again.',
  SERVER: 'The server had a problem. Please try again.',
  SESSION_INVALID: 'Your session on this phone has ended. Open Settings to sign in again.',
  NOT_READY: 'Your profile isn’t loaded yet. Check your connection and try again.',
  BUSY: 'Please wait for the current step to finish.',
  INVALID_PLAYER_ID: 'A Player ID looks like RR-7K4P9X.',
  NOT_FOUND: 'No player has that Player ID. Check it and try again.',
  SELF: 'That’s your own Player ID.',
  RATE_LIMITED: 'Too many attempts. Please wait a little and try again.',
  UNAVAILABLE: 'You can’t do that with this player right now.',
  BLOCKED_BY_YOU: 'You’ve blocked this player. Unblock them first.',
  FRIEND_LIMIT: 'Your friends list is full. Remove a friend to add another.',
  REQUEST_EXPIRED: 'That friend request has expired.',
  REQUEST_GONE: 'That friend request is no longer there.',
  ALREADY_FRIENDS: 'You’re already friends.',
  NOT_FRIENDS: 'You can only invite friends directly. Share the game code instead.',
  NOT_IN_GAME: 'You’re not in that game.',
  ALREADY_IN_GAME: 'They’re already in this game.',
  ALREADY_SEATED: 'Your account is already in this game on another phone.',
  GAME_STARTED: 'The game has already started.',
  GAME_CLOSED: 'This game has ended.',
  GAME_FULL: 'The lobby is full.',
  LOBBY_LOCKED: 'The host has locked the lobby.',
  INVITE_EXPIRED: 'This invitation has expired.',
  INVITE_GONE: 'This invitation is no longer available.',
};

export function socialError(code: SocialErrorCode, retryAfterSeconds?: number): SocialError {
  if (code === 'RATE_LIMITED' && retryAfterSeconds && retryAfterSeconds > 0) {
    const wait = retryAfterSeconds < 90 ? `${retryAfterSeconds} seconds` : retryAfterSeconds < 5400 ? `${Math.ceil(retryAfterSeconds / 60)} minutes` : `${Math.ceil(retryAfterSeconds / 3600)} hours`;
    return { code, message: `Too many attempts. Try again in ${wait}.`, retryAfterSeconds };
  }
  return { code, message: MESSAGES[code] };
}

const fail = (code: SocialErrorCode, retryAfterSeconds?: number): { ok: false; error: SocialError } => ({ ok: false, error: socialError(code, retryAfterSeconds) });
const ok = <T>(value: T): SocialResult<T> => ({ ok: true, value });

type RpcName =
  | 'social_state'
  | 'lookup_player'
  | 'send_friend_request'
  | 'respond_friend_request'
  | 'cancel_friend_request'
  | 'remove_friend'
  | 'block_player'
  | 'unblock_player'
  | 'claim_seat'
  | 'game_player_profiles'
  | 'send_game_invite'
  | 'open_game_invite'
  | 'decline_game_invite'
  | 'revoke_game_invite'
  | 'mark_notifications_read';

/** Runs one database function with a time limit. The value is the function's `{ ok: true, … }` answer. */
async function rpc(name: RpcName, args?: Record<string, unknown>): Promise<SocialResult<Record<string, unknown>>> {
  if (!isSupabaseConfigured) return fail('NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { data, error, status } = await getSupabase().rpc(name, args).abortSignal(controller.signal);
    if (error) {
      if (status === 401 || /^PGRST30[123]$/.test(error.code ?? '')) return fail('SESSION_INVALID');
      if (!status || /abort|network|fetch|timeout/i.test(`${error.message} ${error.details ?? ''}`)) return fail('NETWORK');
      return fail('SERVER');
    }
    if (!data || typeof data !== 'object') return fail('SERVER');
    const body = data as Record<string, unknown>;
    if (body.ok === true) return ok(body);
    const code = String(body.code ?? '');
    if (code === 'UNAUTHENTICATED' || code === 'NO_PROFILE') return fail('SESSION_INVALID');
    if (code === 'VALIDATION' || code === 'FORBIDDEN') return fail('SERVER');
    if (code in MESSAGES) {
      const seconds = Number(body.retry_after_seconds);
      return fail(code as SocialErrorCode, Number.isFinite(seconds) ? seconds : undefined);
    }
    return fail('SERVER');
  } catch {
    return fail('NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

const RELATIONSHIPS: readonly Relationship[] = ['self', 'friends', 'outgoing', 'incoming', 'blocked', 'none'];
const relationship = (raw: unknown): Relationship => (RELATIONSHIPS.includes(raw as Relationship) ? (raw as Relationship) : 'none');

/** The authoritative relationship after a request was sent or answered. */
export interface RelationshipChange {
  relationship: Relationship;
  /** Both had asked: you became friends without anyone accepting. */
  matched: boolean;
}

export interface OpenedInvite {
  gameId: string;
  code: string;
  mode: 'classic' | 'intermediate';
}

async function change(name: RpcName, args: Record<string, unknown>): Promise<SocialResult<RelationshipChange>> {
  const res = await rpc(name, args);
  if (!res.ok) return res;
  return ok({ relationship: relationship(res.value.relationship), matched: res.value.matched === true });
}

async function done(name: RpcName, args: Record<string, unknown>): Promise<SocialResult<true>> {
  const res = await rpc(name, args);
  return res.ok ? ok(true) : res;
}

export const socialApi = {
  /** Friends, requests, invitations and notifications of the signed-in player, in one consistent answer. */
  async state(): Promise<SocialResult<SocialState>> {
    const sentAt = Date.now();
    const res = await rpc('social_state');
    if (!res.ok) return res;
    const state = toSocialState(res.value);
    if (!state) return fail('SERVER');
    recordServerTime(state.serverTime, sentAt, Date.now());
    return ok(state);
  },

  async lookup(playerId: string): Promise<SocialResult<{ player: PublicPlayer; relationship: Relationship }>> {
    const res = await rpc('lookup_player', { p_player_id: playerId });
    if (!res.ok) return res;
    const player = toPublicPlayer(res.value.player);
    return player ? ok({ player, relationship: relationship(res.value.relationship) }) : fail('SERVER');
  },

  sendRequest: (playerId: string) => change('send_friend_request', { p_player_id: playerId }),
  respondRequest: (requestId: string, accept: boolean) => change('respond_friend_request', { p_request_id: requestId, p_accept: accept }),
  cancelRequest: (requestId: string) => change('cancel_friend_request', { p_request_id: requestId }),
  removeFriend: (playerId: string) => done('remove_friend', { p_player_id: playerId }),
  block: (playerId: string) => done('block_player', { p_player_id: playerId }),
  unblock: (playerId: string) => done('unblock_player', { p_player_id: playerId }),

  /** Ties this account to the seat this phone holds (proved by the seat's device token). Idempotent. */
  claimSeat: (c: Credentials) => done('claim_seat', { p_game_id: c.gameId, p_seat_id: c.playerId, p_token: c.token }),

  async seatProfiles(gameId: string): Promise<SocialResult<SeatProfile[]>> {
    const res = await rpc('game_player_profiles', { p_game_id: gameId });
    if (!res.ok) return res;
    const profiles = toSeatProfiles(res.value.players);
    return profiles ? ok(profiles) : fail('SERVER');
  },

  sendInvite: (gameId: string, playerId: string) => done('send_game_invite', { p_game_id: gameId, p_player_id: playerId }),

  /** Re-checks the invitation and the lobby on the server and returns the code for the normal join. */
  async openInvite(inviteId: string): Promise<SocialResult<OpenedInvite>> {
    const res = await rpc('open_game_invite', { p_invite_id: inviteId });
    if (!res.ok) return res;
    const { game_id: gameId, code, mode } = res.value;
    if (typeof gameId !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code)) return fail('SERVER');
    return ok({ gameId, code, mode: mode === 'intermediate' ? 'intermediate' : 'classic' });
  },

  declineInvite: (inviteId: string) => done('decline_game_invite', { p_invite_id: inviteId }),
  revokeInvite: (inviteId: string) => done('revoke_game_invite', { p_invite_id: inviteId }),

  /** All of my unread notifications, or only the ones named. */
  markRead: (ids?: string[]) => done('mark_notifications_read', { p_ids: ids ?? null }),
};
