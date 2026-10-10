import { z } from 'zod';
import { PLAYER_ID_PATTERN } from '@/features/account/types';

/** How I stand with another player. A block by THEM is never shown: it reads as `none`. */
export type Relationship = 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none';

/** What one player may know about another: the public Player ID and the current nickname. */
export interface PublicPlayer {
  playerId: string;
  nickname: string;
}

export interface Friend extends PublicPlayer {
  /** Their Realtime Presence topic. Informational only; replaced by the server when a friendship ends. */
  presenceKey: string;
  since: string;
}

export interface FriendRequest extends PublicPlayer {
  id: string;
  createdAt: string;
  expiresAt: string;
}

/** Whether an invitation can still be used, as the server saw the game when it answered. */
export type InviteState = 'open' | 'started' | 'closed' | 'expired' | 'locked' | 'full';

export interface GameInvite {
  id: string;
  state: InviteState;
  mode: 'classic' | 'intermediate';
  players: number;
  capacity: number;
  inviter: PublicPlayer;
  createdAt: string;
  expiresAt: string;
}

/** A live invitation I sent (the lobby shows "Invited" next to that friend). */
export interface SentInvite {
  id: string;
  gameId: string;
  playerId: string;
  expiresAt: string;
}

export type NotificationType = 'friend_request' | 'friend_accepted' | 'friends_matched' | 'game_invite';

export interface SocialNotification {
  id: string;
  type: NotificationType;
  /** null when the other player's account no longer exists. */
  actor: PublicPlayer | null;
  entityId: string | null;
  createdAt: string;
  read: boolean;
}

/** Everything the Friends screen shows, exactly as the server returned it (public.social_state). */
export interface SocialState {
  /** The server's change counter for this player. A higher number heard later means: refetch. */
  version: number;
  serverTime: string;
  me: { playerId: string; presenceKey: string };
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: PublicPlayer[];
  invites: GameInvite[];
  sentInvites: SentInvite[];
  notifications: SocialNotification[];
  unread: number;
}

/** Another player at my table whose seat belongs to an account (public.game_player_profiles). */
export interface SeatProfile {
  seatId: string;
  /** They cannot be befriended from here (the reason is not given). */
  unavailable: boolean;
  player: PublicPlayer | null;
}

export type PresenceStatus = 'online' | 'offline' | 'unknown';

export type SocialErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'SERVER'
  | 'SESSION_INVALID'
  | 'NOT_READY'
  | 'BUSY'
  | 'INVALID_PLAYER_ID'
  | 'NOT_FOUND'
  | 'SELF'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'BLOCKED_BY_YOU'
  | 'FRIEND_LIMIT'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_GONE'
  | 'ALREADY_FRIENDS'
  | 'NOT_FRIENDS'
  | 'NOT_IN_GAME'
  | 'ALREADY_IN_GAME'
  | 'ALREADY_SEATED'
  | 'GAME_STARTED'
  | 'GAME_CLOSED'
  | 'GAME_FULL'
  | 'LOBBY_LOCKED'
  | 'INVITE_EXPIRED'
  | 'INVITE_GONE';

export interface SocialError {
  code: SocialErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export type SocialResult<T> = { ok: true; value: T } | { ok: false; error: SocialError };

// ---------------------------------------------------------------------------
// The server's answers, checked before anything is shown.
// ---------------------------------------------------------------------------
const playerId = z.string().regex(PLAYER_ID_PATTERN);
const publicPlayer = z.object({ player_id: playerId, nickname: z.string().min(1) });
const request = publicPlayer.extend({ id: z.string().min(1), created_at: z.string(), expires_at: z.string() });

const ServerStateSchema = z.object({
  version: z.coerce.number().int().min(1),
  server_time: z.string(),
  me: z.object({ player_id: playerId, presence_key: z.string().min(1) }),
  friends: z.array(publicPlayer.extend({ presence_key: z.string().min(1), since: z.string() })),
  incoming: z.array(request),
  outgoing: z.array(request),
  blocked: z.array(publicPlayer),
  invites: z.array(
    z.object({
      id: z.string().min(1),
      state: z.enum(['open', 'started', 'closed', 'expired', 'locked', 'full']),
      mode: z.enum(['classic', 'intermediate']),
      players: z.coerce.number().int().min(0),
      capacity: z.coerce.number().int().min(1),
      inviter: publicPlayer,
      created_at: z.string(),
      expires_at: z.string(),
    }),
  ),
  sent_invites: z.array(z.object({ id: z.string().min(1), game_id: z.string().min(1), player_id: playerId, expires_at: z.string() })),
  notifications: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['friend_request', 'friend_accepted', 'friends_matched', 'game_invite']),
      actor: publicPlayer.nullable(),
      entity_id: z.string().nullable(),
      created_at: z.string(),
      read: z.boolean(),
    }),
  ),
  unread: z.coerce.number().int().min(0),
});

const toPlayer = (p: { player_id: string; nickname: string }): PublicPlayer => ({ playerId: p.player_id, nickname: p.nickname });

export function toPublicPlayer(raw: unknown): PublicPlayer | null {
  const parsed = publicPlayer.safeParse(raw);
  return parsed.success ? toPlayer(parsed.data) : null;
}

export function toSocialState(raw: unknown): SocialState | null {
  const parsed = ServerStateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const toRequest = (r: z.infer<typeof request>): FriendRequest => ({ ...toPlayer(r), id: r.id, createdAt: r.created_at, expiresAt: r.expires_at });
  return {
    version: s.version,
    serverTime: s.server_time,
    me: { playerId: s.me.player_id, presenceKey: s.me.presence_key },
    friends: s.friends.map((f) => ({ ...toPlayer(f), presenceKey: f.presence_key, since: f.since })),
    incoming: s.incoming.map(toRequest),
    outgoing: s.outgoing.map(toRequest),
    blocked: s.blocked.map(toPlayer),
    invites: s.invites.map((i) => ({
      id: i.id,
      state: i.state,
      mode: i.mode,
      players: i.players,
      capacity: i.capacity,
      inviter: toPlayer(i.inviter),
      createdAt: i.created_at,
      expiresAt: i.expires_at,
    })),
    sentInvites: s.sent_invites.map((i) => ({ id: i.id, gameId: i.game_id, playerId: i.player_id, expiresAt: i.expires_at })),
    notifications: s.notifications.map((n) => ({ id: n.id, type: n.type, actor: n.actor ? toPlayer(n.actor) : null, entityId: n.entity_id, createdAt: n.created_at, read: n.read })),
    unread: s.unread,
  };
}

const SeatProfilesSchema = z.array(
  z.object({ seat_id: z.string().min(1), unavailable: z.boolean(), player_id: playerId.optional(), nickname: z.string().optional() }),
);

export function toSeatProfiles(raw: unknown): SeatProfile[] | null {
  const parsed = SeatProfilesSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.map((p) => ({
    seatId: p.seat_id,
    unavailable: p.unavailable || !p.player_id,
    player: !p.unavailable && p.player_id ? { playerId: p.player_id, nickname: p.nickname ?? p.player_id } : null,
  }));
}
