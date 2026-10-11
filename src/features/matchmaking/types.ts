import { z } from 'zod';
import type { GameMode } from '@/engine/index.ts';
import { PLAYER_ID_PATTERN } from '@/features/account/types';
import type { PublicPlayer } from '@/features/social/types';

/**
 * Random matchmaking as the phone sees it. Everything here is the server's answer
 * (public.matchmaking_state): the phone never decides that it is queued, that a match was found,
 * who is in it, or how long the countdown has left.
 */

/** A queue entry that is still live. Finished tickets never reach the phone as a ticket (see LastResult). */
export type TicketStatus = 'QUEUED' | 'RESERVED';
export type MatchStatus = 'READY_UP' | 'STARTING' | 'STARTED' | 'CANCELLED' | 'FAILED';

export interface MatchmakingSettings {
  /** false: the queue is closed (maintenance). */
  enabled: boolean;
  readySeconds: number;
  heartbeatSeconds: number;
  preferTargetSeconds: number;
  relaxSeconds: number;
  targetPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  partyMaxMembers: number;
}

export interface PartyMember extends PublicPlayer {
  isLeader: boolean;
  isMe: boolean;
  /** Confirmed for this party, these members and this mode. The leader counts as ready. */
  ready: boolean;
  /** Their app has been heard from recently. */
  online: boolean;
}

/** An invitation into my party that has not been answered (the leader can take it back). */
export interface SentPartyInvite extends PublicPlayer {
  id: string;
  expiresAt: string;
}

export interface Party {
  id: string;
  mode: GameMode;
  isLeader: boolean;
  /** Queued or in a match: nobody joins, and the mode and readiness stay as they are. */
  locked: boolean;
  members: PartyMember[];
  invites: SentPartyInvite[];
}

/** An invitation into someone's party. Not a game invitation: accepting joins a group, nothing more. */
export interface PartyInvite {
  id: string;
  mode: GameMode;
  /** Players in that party now. */
  size: number;
  inviter: PublicPlayer;
  expiresAt: string;
}

export interface Ticket {
  id: string;
  kind: 'solo' | 'party';
  mode: GameMode;
  playerCount: number;
  status: TicketStatus;
  queuedAt: string;
  /** How often this search went back into the queue after a match fell through. */
  requeueCount: number;
}

export interface MatchPlayer extends PublicPlayer {
  /** Players who queued together share a number. */
  group: number;
  /** Part of a party (rather than a solo player). */
  party: boolean;
  ready: boolean;
  isMe: boolean;
}

export interface Match {
  id: string;
  mode: GameMode;
  status: MatchStatus;
  playerCount: number;
  /** The server's deadline for confirming. */
  readyDeadline: string;
  players: MatchPlayer[];
}

/** The game my last match became, while I am still playing in it. */
export interface MatchedGame {
  matchId: string;
  gameId: string;
  /** My seat in that game. Opened with the device token this phone confirmed with. */
  seatId: string;
  mode: GameMode;
}

/** Why my last search ended (kept by the server for a couple of minutes). */
export interface LastResult {
  ticketId: string;
  status: 'MATCHED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  reason: string | null;
  at: string;
}

export interface LiveGame {
  gameId: string;
  status: 'WAITING' | 'ACTIVE' | 'PAUSED';
  /** It came from matchmaking (rather than a private lobby). */
  matchmade: boolean;
}

export interface MatchmakingState {
  /** The server's change counter for this player. A higher number heard later means: refetch. */
  version: number;
  serverTime: string;
  settings: MatchmakingSettings;
  /** Server time (ms) until which this player cannot queue after missing a ready-up; 0 when free. */
  cooldownUntilMs: number;
  /** A game this account is still playing in: it must be finished or left before queueing. */
  liveGame: LiveGame | null;
  party: Party | null;
  partyInvites: PartyInvite[];
  ticket: Ticket | null;
  match: Match | null;
  game: MatchedGame | null;
  lastResult: LastResult | null;
}

export type MatchmakingErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'SERVER'
  | 'SESSION_INVALID'
  | 'NOT_READY'
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'MATCHMAKING_DISABLED'
  | 'ALREADY_QUEUED'
  | 'ALREADY_IN_GAME'
  | 'ALREADY_IN_PARTY'
  | 'ALREADY_MEMBER'
  | 'NOT_IN_PARTY'
  | 'NOT_LEADER'
  | 'PARTY_NOT_READY'
  | 'PARTY_MODE_MISMATCH'
  | 'PARTY_INVALID'
  | 'PARTY_FULL'
  | 'PARTY_LOCKED'
  | 'MEMBER_OFFLINE'
  | 'MEMBER_QUEUED'
  | 'MEMBER_IN_GAME'
  | 'MEMBER_COOLDOWN'
  | 'COOLDOWN'
  | 'STALE_REQUEST'
  | 'MATCH_GONE'
  | 'READY_TIMEOUT'
  | 'SEAT_ON_OTHER_DEVICE'
  | 'TOO_LATE'
  | 'INVALID_PLAYER_ID'
  | 'NOT_FOUND'
  | 'SELF'
  | 'NOT_FRIENDS'
  | 'BLOCKED_BY_YOU'
  | 'UNAVAILABLE'
  | 'INVITE_GONE'
  | 'INVITE_EXPIRED';

export interface MatchmakingError {
  code: MatchmakingErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export type MatchmakingResult<T> = { ok: true; value: T } | { ok: false; error: MatchmakingError };

// ---------------------------------------------------------------------------
// The server's answer, checked before anything is shown.
// ---------------------------------------------------------------------------
const playerId = z.string().regex(PLAYER_ID_PATTERN);
const publicPlayer = z.object({ player_id: playerId, nickname: z.string().min(1) });
const mode = z.enum(['classic', 'intermediate']);
const count = z.coerce.number().int().min(0);

const ServerStateSchema = z.object({
  version: z.coerce.number().int().min(1),
  server_time: z.string(),
  settings: z.object({
    enabled: z.boolean(),
    ready_seconds: count,
    heartbeat_seconds: count,
    prefer_target_seconds: count,
    relax_seconds: count,
    target_players: count,
    min_players: count,
    max_players: count,
    party_max_members: count,
  }),
  cooldown_seconds: count,
  live_game: z.object({ game_id: z.string().min(1), status: z.enum(['WAITING', 'ACTIVE', 'PAUSED']), matchmade: z.boolean() }).nullable(),
  party: z
    .object({
      id: z.string().min(1),
      mode,
      is_leader: z.boolean(),
      locked: z.boolean(),
      members: z.array(publicPlayer.extend({ is_leader: z.boolean(), is_me: z.boolean(), ready: z.boolean(), online: z.boolean() })),
      invites: z.array(publicPlayer.extend({ id: z.string().min(1), expires_at: z.string() })),
    })
    .nullable(),
  party_invites: z.array(z.object({ id: z.string().min(1), mode, size: count, inviter: publicPlayer, expires_at: z.string() })),
  ticket: z
    .object({
      id: z.string().min(1),
      kind: z.enum(['solo', 'party']),
      mode,
      player_count: count,
      status: z.enum(['QUEUED', 'RESERVED']),
      queued_at: z.string(),
      requeue_count: count,
    })
    .nullable(),
  match: z
    .object({
      id: z.string().min(1),
      mode,
      status: z.enum(['READY_UP', 'STARTING', 'STARTED', 'CANCELLED', 'FAILED']),
      player_count: count,
      ready_deadline: z.string(),
      players: z.array(publicPlayer.extend({ group: count, party: z.boolean(), ready: z.boolean(), is_me: z.boolean() })),
    })
    .nullable(),
  game: z.object({ match_id: z.string().min(1), game_id: z.string().min(1), seat_id: z.string().min(1), mode }).nullable(),
  last_result: z
    .object({ ticket_id: z.string().min(1), status: z.enum(['MATCHED', 'CANCELLED', 'EXPIRED', 'FAILED']), reason: z.string().nullable(), at: z.string() })
    .nullable(),
});

const toPlayer = (p: { player_id: string; nickname: string }): PublicPlayer => ({ playerId: p.player_id, nickname: p.nickname });

/** null when the answer is not what this version of the app understands: then nothing is shown rather than something wrong. */
export function toMatchmakingState(raw: unknown): MatchmakingState | null {
  const parsed = ServerStateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const serverMs = Date.parse(s.server_time);
  return {
    version: s.version,
    serverTime: s.server_time,
    settings: {
      enabled: s.settings.enabled,
      readySeconds: s.settings.ready_seconds,
      heartbeatSeconds: Math.max(3, s.settings.heartbeat_seconds),
      preferTargetSeconds: s.settings.prefer_target_seconds,
      relaxSeconds: s.settings.relax_seconds,
      targetPlayers: s.settings.target_players,
      minPlayers: s.settings.min_players,
      maxPlayers: s.settings.max_players,
      partyMaxMembers: s.settings.party_max_members,
    },
    cooldownUntilMs: s.cooldown_seconds > 0 && Number.isFinite(serverMs) ? serverMs + s.cooldown_seconds * 1000 : 0,
    liveGame: s.live_game ? { gameId: s.live_game.game_id, status: s.live_game.status, matchmade: s.live_game.matchmade } : null,
    party: s.party
      ? {
          id: s.party.id,
          mode: s.party.mode,
          isLeader: s.party.is_leader,
          locked: s.party.locked,
          members: s.party.members.map((m) => ({ ...toPlayer(m), isLeader: m.is_leader, isMe: m.is_me, ready: m.ready, online: m.online })),
          invites: s.party.invites.map((i) => ({ ...toPlayer(i), id: i.id, expiresAt: i.expires_at })),
        }
      : null,
    partyInvites: s.party_invites.map((i) => ({ id: i.id, mode: i.mode, size: i.size, inviter: toPlayer(i.inviter), expiresAt: i.expires_at })),
    ticket: s.ticket
      ? {
          id: s.ticket.id,
          kind: s.ticket.kind,
          mode: s.ticket.mode,
          playerCount: s.ticket.player_count,
          status: s.ticket.status,
          queuedAt: s.ticket.queued_at,
          requeueCount: s.ticket.requeue_count,
        }
      : null,
    match: s.match
      ? {
          id: s.match.id,
          mode: s.match.mode,
          status: s.match.status,
          playerCount: s.match.player_count,
          readyDeadline: s.match.ready_deadline,
          players: s.match.players.map((p) => ({ ...toPlayer(p), group: p.group, party: p.party, ready: p.ready, isMe: p.is_me })),
        }
      : null,
    game: s.game ? { matchId: s.game.match_id, gameId: s.game.game_id, seatId: s.game.seat_id, mode: s.game.mode } : null,
    lastResult: s.last_result ? { ticketId: s.last_result.ticket_id, status: s.last_result.status, reason: s.last_result.reason, at: s.last_result.at } : null,
  };
}
