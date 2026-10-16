import type { GameMode } from '@/engine/index.ts';
import {
  toMatchmakingState,
  type MatchmakingError,
  type MatchmakingErrorCode,
  type MatchmakingResult,
  type MatchmakingState,
  type TicketStatus,
} from '@/features/matchmaking/types';
import { recordServerTime } from './serverClock';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Every call random matchmaking makes to Supabase: one database function each, as the signed-in
 * player, plus one nudge to the worker. Nothing here decides what a result means for the screen —
 * that is matchmakingStore's job — and nothing here throws. The server never sends an internal
 * error; unknown codes become SERVER.
 *
 * NETWORK means the outcome is UNKNOWN (the request may have been carried out): the store always
 * asks the server for its state again before anything is retried.
 */
export const MATCHMAKING_FUNCTION_NAME = 'matchmaking';
const TIMEOUT_MS = 12_000;

const MESSAGES: Record<MatchmakingErrorCode, string> = {
  NOT_CONFIGURED: 'The game server is not configured.',
  NETWORK: 'No connection. Check your internet and try again.',
  SERVER: 'The server had a problem. Please try again.',
  SESSION_INVALID: 'Your session on this phone has ended. Open Settings to sign in again.',
  NOT_READY: 'Your profile isn’t loaded yet. Check your connection and try again.',
  BUSY: 'Please wait for the current step to finish.',
  RATE_LIMITED: 'Too many attempts. Please wait a little and try again.',
  MATCHMAKING_DISABLED: 'Online matchmaking is closed for maintenance. Please try again soon.',
  ALREADY_QUEUED: 'You’re already searching for a match.',
  ALREADY_IN_GAME: 'You’re already in a game. Finish or leave it before playing online.',
  ALREADY_IN_PARTY: 'You’re already in a party. Leave it before joining another.',
  ALREADY_MEMBER: 'They’re already in your party.',
  NOT_IN_PARTY: 'You’re not in a party any more.',
  NOT_LEADER: 'Only the party leader can do that.',
  PARTY_NOT_READY: 'Not everyone in your party is ready yet.',
  PARTY_MODE_MISMATCH: 'Your party is set to a different game mode.',
  PARTY_INVALID: 'This party can’t queue as it is. Check its members and try again.',
  PARTY_FULL: 'The party is full.',
  PARTY_LOCKED: 'The party is searching for a match. Stop the search to change it.',
  MEMBER_OFFLINE: 'Someone in your party isn’t connected right now.',
  MEMBER_QUEUED: 'Someone in your party is already searching for a match.',
  MEMBER_IN_GAME: 'Someone in your party is already in a game.',
  MEMBER_COOLDOWN: 'Someone in your party has to wait a moment after missing a match.',
  BOTS_SOLO_ONLY: 'Bots can fill seats only for a solo search: everyone at a bot table chooses that for themselves.',
  COOLDOWN: 'You missed a match. Please wait a moment before searching again.',
  STALE_REQUEST: 'That search has already ended. Start a new one.',
  MATCH_GONE: 'That match is no longer available.',
  READY_TIMEOUT: 'Ready-up timed out. The match was cancelled.',
  SEAT_ON_OTHER_DEVICE: 'You confirmed this match on another device. Continue there.',
  TOO_LATE: 'Everyone has confirmed — the game is starting.',
  INVALID_PLAYER_ID: 'A Player ID looks like RR-7K4P9X.',
  NOT_FOUND: 'No player has that Player ID.',
  SELF: 'That’s your own Player ID.',
  NOT_FRIENDS: 'You can only invite friends to your party.',
  BLOCKED_BY_YOU: 'You’ve blocked this player. Unblock them first.',
  UNAVAILABLE: 'You can’t do that with this player right now.',
  INVITE_GONE: 'This party invitation is no longer available.',
  INVITE_EXPIRED: 'This party invitation has expired.',
};

export function matchmakingError(code: MatchmakingErrorCode, retryAfterSeconds?: number): MatchmakingError {
  if ((code === 'COOLDOWN' || code === 'RATE_LIMITED') && retryAfterSeconds && retryAfterSeconds > 0) {
    const wait = retryAfterSeconds < 90 ? `${retryAfterSeconds} ${retryAfterSeconds === 1 ? 'second' : 'seconds'}` : `${Math.ceil(retryAfterSeconds / 60)} minutes`;
    return { code, message: code === 'COOLDOWN' ? `You missed a match. You can search again in ${wait}.` : `Too many attempts. Try again in ${wait}.`, retryAfterSeconds };
  }
  return { code, message: MESSAGES[code] };
}

const fail = (code: MatchmakingErrorCode, retryAfterSeconds?: number): { ok: false; error: MatchmakingError } => ({ ok: false, error: matchmakingError(code, retryAfterSeconds) });
const ok = <T>(value: T): MatchmakingResult<T> => ({ ok: true, value });

type RpcName =
  | 'matchmaking_state'
  | 'matchmaking_heartbeat'
  | 'matchmaking_enqueue'
  | 'matchmaking_cancel'
  | 'matchmaking_ready'
  | 'matchmaking_decline'
  | 'party_create'
  | 'party_invite'
  | 'party_respond_invite'
  | 'party_revoke_invite'
  | 'party_set_mode'
  | 'party_set_ready'
  | 'party_leave'
  | 'party_kick';

/** Runs one database function with a time limit. The value is the function's `{ ok: true, … }` answer. */
async function rpc(name: RpcName, args?: Record<string, unknown>): Promise<MatchmakingResult<Record<string, unknown>>> {
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
    if (code === 'VALIDATION') return fail('SERVER');
    if (code in MESSAGES) {
      const seconds = Number(body.retry_after_seconds);
      return fail(code as MatchmakingErrorCode, Number.isFinite(seconds) ? seconds : undefined);
    }
    return fail('SERVER');
  } catch {
    return fail('NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

async function done(name: RpcName, args?: Record<string, unknown>): Promise<MatchmakingResult<true>> {
  const res = await rpc(name, args);
  return res.ok ? ok(true) : res;
}

/** What the server says after "stop searching": cancelled, or too late — a match was already reserved. */
export interface CancelOutcome {
  cancelled: boolean;
  status: TicketStatus | 'CANCELLED' | 'NONE' | 'OTHER';
}

export interface ReadyOutcome {
  /** Every player has confirmed: the server is starting the game. */
  allReady: boolean;
}

export interface Heartbeat {
  version: number;
  /** The worker has something to do for this player right now (a group to form, a game to start). */
  tickDue: boolean;
}

export const matchmakingApi = {
  /** Party, ticket, match and game of the signed-in player, in one consistent answer. Also a sign of life. */
  async state(): Promise<MatchmakingResult<MatchmakingState>> {
    const sentAt = Date.now();
    const res = await rpc('matchmaking_state');
    if (!res.ok) return res;
    const state = toMatchmakingState(res.value);
    if (!state) return fail('SERVER');
    recordServerTime(state.serverTime, sentAt, Date.now());
    return ok(state);
  },

  async heartbeat(): Promise<MatchmakingResult<Heartbeat>> {
    const sentAt = Date.now();
    const res = await rpc('matchmaking_heartbeat');
    if (!res.ok) return res;
    if (typeof res.value.server_time === 'string') recordServerTime(res.value.server_time, sentAt, Date.now());
    return ok({ version: Number(res.value.version), tickDue: res.value.tick_due === true });
  },

  /**
   * Enter the queue: alone in `mode`, or — for a party's leader — with the whole party in the party's mode.
   * `key` identifies one tap: sending it again can never create a second search.
   */
  /** `allowBots`: fill the table's empty seats with bots (solo only). Left out, the request is exactly what older apps send. */
  enqueue: (mode: GameMode | null, key: string, allowBots = false) =>
    done('matchmaking_enqueue', allowBots ? { p_mode: mode, p_idempotency_key: key, p_allow_bots: true } : { p_mode: mode, p_idempotency_key: key }),

  async cancel(): Promise<MatchmakingResult<CancelOutcome>> {
    const res = await rpc('matchmaking_cancel');
    if (!res.ok) return res;
    const status = String(res.value.status ?? '');
    return ok({
      cancelled: res.value.cancelled === true,
      status: status === 'QUEUED' || status === 'RESERVED' || status === 'CANCELLED' || status === 'NONE' ? status : 'OTHER',
    });
  },

  /** Confirm a match with the device token that will hold this phone's seat (the server keeps only its hash). */
  async ready(matchId: string, token: string): Promise<MatchmakingResult<ReadyOutcome>> {
    const res = await rpc('matchmaking_ready', { p_match_id: matchId, p_token: token });
    return res.ok ? ok({ allReady: res.value.all_ready === true }) : res;
  },

  decline: (matchId: string) => done('matchmaking_decline', { p_match_id: matchId }),

  createParty: (mode: GameMode) => done('party_create', { p_mode: mode }),
  invite: (playerId: string) => done('party_invite', { p_player_id: playerId }),
  respondInvite: (inviteId: string, accept: boolean) => done('party_respond_invite', { p_invite_id: inviteId, p_accept: accept }),
  revokeInvite: (inviteId: string) => done('party_revoke_invite', { p_invite_id: inviteId }),
  setMode: (mode: GameMode) => done('party_set_mode', { p_mode: mode }),
  setReady: (ready: boolean) => done('party_set_ready', { p_ready: ready }),
  leaveParty: () => done('party_leave'),
  kick: (playerId: string) => done('party_kick', { p_player_id: playerId }),

  /**
   * Asks the worker to look at the queue now instead of at its next scheduled run. Carries nothing
   * about this player and its answer is ignored: whatever happens shows up in `state()`. Never throws.
   */
  async nudge(): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      await getSupabase().functions.invoke(MATCHMAKING_FUNCTION_NAME, { body: { op: 'tick' }, timeout: TIMEOUT_MS });
    } catch {
      // The scheduler runs it anyway.
    }
  },
};
