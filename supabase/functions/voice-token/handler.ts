// Voice chat authorization. Not the referee: nothing here reads or writes game state, takes the
// game lock or bumps the game version, so voice can never hold up or change a game.
//
//   validate body → authenticate the seat's device token (the same proof game-action uses) →
//   re-check everything on the server's own data (kill switch, private room, the room's flag,
//   the host's entitlement, game in play, caps) → issue a short-lived Agora token for THIS game's
//   channel and THIS seat's uid → record usage.
//
// The channel and the uid are derived here (voiceChannelName, voiceUidForSeat): a request cannot
// name either. A renewal is a join: every check runs again. The App Certificate stays inside
// `buildToken`, which the entry point supplies; it is never returned and never logged.
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import {
  VoiceRequestSchema,
  voiceChannelName,
  voiceUidForSeat,
  type VoiceDenial,
  type VoiceGrant,
  type VoiceRequest,
  type VoiceResponse,
  type VoiceRoom,
} from '../_shared/engine/index.ts';
import type { Sql, Tx } from '../game-action/db.ts';
import { sha256Hex } from '../game-action/handler.ts';

export interface VoiceDeps {
  sql: Sql;
  /**
   * Signs an Agora RTC token (publisher) for one channel and uid, valid for `ttlSeconds`.
   * Absent when the server has no Agora credentials: every token request is then refused.
   */
  buildToken?: (channel: string, uid: number, ttlSeconds: number) => string;
  /** Tells the phones in a game that its voice setting changed (they ask for the status again). */
  broadcastVoice?: (gameId: string, payload: { v: 1; enabled: boolean }) => Promise<void>;
}

export interface VoiceResult {
  status: number;
  body: VoiceResponse;
}

const MESSAGES: Record<VoiceDenial, string> = {
  VALIDATION: 'That request is not valid.',
  FORBIDDEN: 'You are not a player in this game.',
  NOT_FOUND: 'Game not found.',
  VOICE_DISABLED: 'Voice chat is switched off for now.',
  PUBLIC_GAME: 'Voice chat is only for private games.',
  ROOM_VOICE_OFF: 'Voice chat is not turned on for this game.',
  NOT_ENTITLED: 'The host of this game cannot host voice chat.',
  NOT_HOST: 'Only the host can change voice chat for this game.',
  GAME_NOT_ACTIVE: 'Voice chat starts when the game does.',
  LIMIT_REACHED: 'Voice chat has reached this month’s limit for the experiment.',
  GAME_LIMIT_REACHED: 'This game has used all of its voice time.',
  RATE_LIMITED: 'Too many voice requests. Try again in a moment.',
  NOT_CONFIGURED: 'Voice chat is not set up on the server.',
  SESSION_ENDED: 'Your voice session ended.',
  SERVER_ERROR: 'Voice chat had a problem. The game carries on.',
  NETWORK: 'Connection lost.',
  TIMEOUT: 'The server is taking too long.',
};

function refuse(code: VoiceDenial, status = 200): VoiceResult {
  return { status, body: { ok: false, error: { code, message: MESSAGES[code] } } };
}

/** Thrown inside a transaction to roll it back and answer with a denial. */
class Denied extends Error {
  constructor(readonly code: VoiceDenial) {
    super(code);
  }
}

type Row = Record<string, unknown>;

interface Settings {
  voiceChatEnabled: boolean;
  privateVoiceEnabled: boolean;
  requireEntitlement: boolean;
  monthlyGameLimit: number;
  monthlyParticipantSeconds: number;
  perGameSeconds: number;
  tokenTtlSeconds: number;
  heartbeatSeconds: number;
  staleSeconds: number;
  tokenRateMax: number;
  tokenRateWindowSeconds: number;
}

/** Agora's own floor/ceiling for a sane short-lived token, whatever a settings row says. */
const MIN_TOKEN_TTL = 60;
const MAX_TOKEN_TTL = 3600;

async function loadSettings(db: Sql | Tx): Promise<Settings> {
  const rows = await db`select key, value from public.voice_settings`;
  const map = new Map(rows.map((r) => [r.key as string, Number(r.value)]));
  const get = (key: string, fallback: number) => map.get(key) ?? fallback;
  return {
    // A missing row means "off" for the switches and "nothing allowed" for the caps: failing closed.
    voiceChatEnabled: get('voice_chat_enabled', 0) === 1,
    privateVoiceEnabled: get('private_voice_enabled', 0) === 1,
    requireEntitlement: get('require_entitlement', 1) !== 0,
    monthlyGameLimit: get('monthly_game_limit', 0),
    monthlyParticipantSeconds: get('monthly_participant_minutes', 0) * 60,
    perGameSeconds: get('per_game_minutes', 0) * 60,
    tokenTtlSeconds: Math.min(MAX_TOKEN_TTL, Math.max(MIN_TOKEN_TTL, get('token_ttl_seconds', 600))),
    heartbeatSeconds: Math.max(10, get('heartbeat_seconds', 30)),
    staleSeconds: Math.max(30, get('stale_seconds', 90)),
    tokenRateMax: Math.max(1, get('token_rate_max', 12)),
    tokenRateWindowSeconds: Math.max(1, get('token_rate_window_seconds', 60)),
  };
}

interface Seat {
  seat: number;
  isHost: boolean;
  playerStatus: string;
  gameStatus: string;
  expired: boolean;
  voiceEnabled: boolean;
  matchmade: boolean;
  hostUserId: string | null;
}

/** The caller's seat, proved by the device token. Everything else about the request is taken from this row. */
async function authenticate(db: Sql | Tx, req: VoiceRequest): Promise<Seat> {
  const [row] = (await db`
    select p.token_hash, p.seat, p.is_host, p.status as player_status,
           g.status as game_status, g.expires_at <= now() as expired, g.voice_enabled,
           g.matchmaking_match_id is not null as matchmade,
           (select h.user_id from public.players h where h.id = g.host_player_id) as host_user_id
    from public.players p join public.games g on g.id = p.game_id
    where p.id = ${req.playerId} and p.game_id = ${req.gameId}`) as Row[];
  if (!row || row.token_hash !== (await sha256Hex(req.token))) throw new Denied('FORBIDDEN');
  if (row.player_status === 'LEFT') throw new Denied('FORBIDDEN');
  return {
    seat: row.seat as number,
    isHost: row.is_host as boolean,
    playerStatus: row.player_status as string,
    gameStatus: row.game_status as string,
    expired: row.expired as boolean,
    voiceEnabled: row.voice_enabled as boolean,
    matchmade: row.matchmade as boolean,
    hostUserId: (row.host_user_id as string | null) ?? null,
  };
}

async function hostEntitled(db: Sql | Tx, settings: Settings, seat: Seat): Promise<boolean> {
  if (!settings.requireEntitlement) return true;
  const [row] = await db`select public.voice_host_entitled(${seat.hostUserId}::uuid) as ok`;
  return row?.ok === true;
}

/** May this room have voice at all (asked when the host turns it on, and again for every token)? */
async function roomDenial(db: Sql | Tx, settings: Settings, seat: Seat): Promise<VoiceDenial | null> {
  if (!settings.voiceChatEnabled || !settings.privateVoiceEnabled) return 'VOICE_DISABLED';
  if (seat.matchmade) return 'PUBLIC_GAME';
  if (seat.gameStatus === 'FINISHED' || seat.expired) return 'GAME_NOT_ACTIVE';
  if (!(await hostEntitled(db, settings, seat))) return 'NOT_ENTITLED';
  return null;
}

/** May this seat be connected right now, caps aside? */
async function sessionDenial(db: Sql | Tx, settings: Settings, seat: Seat): Promise<VoiceDenial | null> {
  const room = await roomDenial(db, settings, seat);
  if (room) return room;
  if (!seat.voiceEnabled) return 'ROOM_VOICE_OFF';
  // Seats are shuffled when the game starts, and a uid is a seat: no voice in the lobby.
  if (seat.gameStatus !== 'ACTIVE' && seat.gameStatus !== 'PAUSED') return 'GAME_NOT_ACTIVE';
  return null;
}

const monthSql = (db: Sql | Tx) => db`date_trunc('month', now() at time zone 'utc')::date`;

/** Closes sessions whose phone went quiet: they stop counting at the last moment they could have been connected. */
async function sweepStale(db: Sql | Tx, settings: Settings): Promise<void> {
  await db`
    update public.voice_participant_sessions s
    set ended_at = e.at, end_reason = 'stale', seconds = greatest(0, extract(epoch from (e.at - s.joined_at)))::integer
    from (
      select id, least(token_expires_at, last_seen_at + make_interval(secs => ${settings.staleSeconds})) as at
      from public.voice_participant_sessions
      where ended_at is null and last_seen_at < now() - make_interval(secs => ${settings.staleSeconds})
    ) e
    where s.id = e.id and s.ended_at is null`;
}

async function endSession(db: Sql | Tx, gameId: string, playerId: string, reason: 'left' | 'revoked'): Promise<void> {
  await db`
    update public.voice_participant_sessions
    set ended_at = now(), end_reason = ${reason}, seconds = greatest(0, extract(epoch from (now() - joined_at)))::integer
    where game_id = ${gameId} and player_id = ${playerId} and ended_at is null`;
}

/** Caps for a token request. Call with the month's lock held, so two requests cannot both take the last slot. */
async function capDenial(tx: Tx, settings: Settings, gameId: string): Promise<VoiceDenial | null> {
  const [game] = await tx`
    select started_at + make_interval(secs => ${settings.perGameSeconds}) <= now() as over
    from public.voice_game_sessions where game_id = ${gameId}`;
  if (game && settings.perGameSeconds > 0 && game.over === true) return 'GAME_LIMIT_REACHED';
  const [used] = await tx`
    select
      (select count(*) from public.voice_game_sessions where month = ${monthSql(tx)})::integer as games,
      (select coalesce(sum(coalesce(seconds, greatest(0, extract(epoch from (now() - joined_at))))), 0)
         from public.voice_participant_sessions where month = ${monthSql(tx)})::bigint as seconds`;
  if (Number(used!.seconds) >= settings.monthlyParticipantSeconds) return 'LIMIT_REACHED';
  // A game that already started its voice this month keeps its place; only a NEW game needs a free one.
  if (!game && Number(used!.games) >= settings.monthlyGameLimit) return 'LIMIT_REACHED';
  return null;
}

async function rateLimited(tx: Tx, settings: Settings, playerId: string): Promise<boolean> {
  const [row] = await tx`
    insert into public.voice_token_rate as r (player_id, window_start, count) values (${playerId}, now(), 1)
    on conflict (player_id) do update set
      count = case when r.window_start < now() - make_interval(secs => ${settings.tokenRateWindowSeconds}) then 1 else r.count + 1 end,
      window_start = case when r.window_start < now() - make_interval(secs => ${settings.tokenRateWindowSeconds}) then now() else r.window_start end
    returning count`;
  return Number(row!.count) > settings.tokenRateMax;
}

async function statusOp(req: VoiceRequest, deps: VoiceDeps): Promise<VoiceResult> {
  const seat = await authenticate(deps.sql, req);
  const settings = await loadSettings(deps.sql);
  let reason = await sessionDenial(deps.sql, settings, seat);
  if (!reason && !deps.buildToken) reason = 'NOT_CONFIGURED';
  if (!reason) {
    // Read-only look at the caps: the real decision is made, under the lock, when a token is asked for.
    reason = await deps.sql.begin((tx) => capDenial(tx, settings, req.gameId));
  }
  const room: VoiceRoom = {
    enabled: seat.voiceEnabled && !seat.matchmade,
    available: reason === null,
    reason,
    canConfigure: seat.isHost && !seat.matchmade && seat.gameStatus !== 'FINISHED',
  };
  return { status: 200, body: { ok: true, room } };
}

async function enableOp(req: Extract<VoiceRequest, { op: 'enable' }>, deps: VoiceDeps): Promise<VoiceResult> {
  const changed = await deps.sql.begin(async (tx) => {
    const seat = await authenticate(tx, req);
    if (!seat.isHost) throw new Denied('NOT_HOST');
    if (seat.matchmade) throw new Denied('PUBLIC_GAME');
    if (req.enabled) {
      // Turning it OFF is always allowed; turning it ON needs everything a token would need of the room.
      const denial = await roomDenial(tx, await loadSettings(tx), seat);
      if (denial) throw new Denied(denial);
    }
    const rows = await tx`
      update public.games set voice_enabled = ${req.enabled}
      where id = ${req.gameId} and matchmaking_match_id is null and voice_enabled is distinct from ${req.enabled}
      returning id`;
    if (!req.enabled) {
      // Nobody stays counted (or renewable) in a room whose voice was switched off.
      await tx`
        update public.voice_participant_sessions
        set ended_at = now(), end_reason = 'revoked', seconds = greatest(0, extract(epoch from (now() - joined_at)))::integer
        where game_id = ${req.gameId} and ended_at is null`;
    }
    return rows.length > 0;
  });
  if (changed && deps.broadcastVoice) {
    try {
      await deps.broadcastVoice(req.gameId, { v: 1, enabled: req.enabled });
    } catch (error) {
      // Committed already; phones also ask for the status when they open the game.
      console.error('voice broadcast failed', error);
    }
  }
  return statusOp(req, deps);
}

async function tokenOp(req: Extract<VoiceRequest, { op: 'join' | 'renew' }>, deps: VoiceDeps): Promise<VoiceResult> {
  const buildToken = deps.buildToken;
  if (!buildToken) return refuse('NOT_CONFIGURED');
  const grant = await deps.sql.begin(async (tx): Promise<VoiceGrant | VoiceDenial> => {
    const seat = await authenticate(tx, req);
    const settings = await loadSettings(tx);
    // One token request at a time decides the month's caps: no two games can take the last place.
    await tx`select pg_advisory_xact_lock(hashtext('voice_usage'), hashtext(${monthSql(tx)}::text))`;
    await sweepStale(tx, settings);

    const denial = (await sessionDenial(tx, settings, seat)) ?? (await capDenial(tx, settings, req.gameId));
    if (denial) {
      // Refused, and whatever session this seat had stops here. Returned (not thrown) so that this commits.
      await endSession(tx, req.gameId, req.playerId, 'revoked');
      return denial;
    }
    if (await rateLimited(tx, settings, req.playerId)) throw new Denied('RATE_LIMITED');

    // The game is counted once, by its primary key, when its first token is issued.
    await tx`insert into public.voice_game_sessions (game_id, month) values (${req.gameId}, ${monthSql(tx)}) on conflict (game_id) do nothing`;
    const [open] = await tx`
      update public.voice_participant_sessions
      set last_seen_at = now(),
          token_expires_at = now() + make_interval(secs => ${settings.tokenTtlSeconds}),
          tokens_issued = tokens_issued + 1,
          rejoins = rejoins + ${req.op === 'join' ? 1 : 0}
      where game_id = ${req.gameId} and player_id = ${req.playerId} and ended_at is null
      returning token_expires_at`;
    const [session] = open
      ? [open]
      : await tx`
          insert into public.voice_participant_sessions (game_id, player_id, month, token_expires_at)
          values (${req.gameId}, ${req.playerId}, ${monthSql(tx)}, now() + make_interval(secs => ${settings.tokenTtlSeconds}))
          returning token_expires_at`;
    const channel = voiceChannelName(req.gameId);
    const uid = voiceUidForSeat(seat.seat);
    const expiresAt = session!.token_expires_at instanceof Date ? session!.token_expires_at.toISOString() : String(session!.token_expires_at);
    return { token: buildToken(channel, uid, settings.tokenTtlSeconds), channel, uid, expiresAt, heartbeatSeconds: settings.heartbeatSeconds };
  });
  if (typeof grant === 'string') return refuse(grant);
  return { status: 200, body: { ok: true, grant } };
}

async function heartbeatOp(req: VoiceRequest, deps: VoiceDeps): Promise<VoiceResult> {
  const seat = await authenticate(deps.sql, req);
  const settings = await loadSettings(deps.sql);
  // The caps are NOT asked here: a phone connected when a cap is reached keeps its current token
  // (at most token_ttl_seconds) and is refused at the renewal. The switches and the room are.
  let denial = await sessionDenial(deps.sql, settings, seat);
  if (!denial && settings.perGameSeconds > 0) {
    const [game] = await deps.sql`
      select started_at + make_interval(secs => ${settings.perGameSeconds}) <= now() as over
      from public.voice_game_sessions where game_id = ${req.gameId}`;
    if (game?.over === true) denial = 'GAME_LIMIT_REACHED';
  }
  if (denial) {
    await endSession(deps.sql, req.gameId, req.playerId, 'revoked');
    return refuse(denial);
  }
  const touched = await deps.sql`
    update public.voice_participant_sessions set last_seen_at = now()
    where game_id = ${req.gameId} and player_id = ${req.playerId} and ended_at is null
      and last_seen_at >= now() - make_interval(secs => ${settings.staleSeconds})
      and token_expires_at > now()
    returning id`;
  if (!touched.length) return refuse('SESSION_ENDED');
  return { status: 200, body: { ok: true } };
}

async function leaveOp(req: VoiceRequest, deps: VoiceDeps): Promise<VoiceResult> {
  await authenticate(deps.sql, req);
  await endSession(deps.sql, req.gameId, req.playerId, 'left');
  return { status: 200, body: { ok: true } };
}

export async function handleVoiceRequest(rawBody: unknown, deps: VoiceDeps): Promise<VoiceResult> {
  const parsed = VoiceRequestSchema.safeParse(rawBody);
  if (!parsed.success) return refuse('VALIDATION', 400);
  const req = parsed.data;
  try {
    switch (req.op) {
      case 'status':
        return await statusOp(req, deps);
      case 'enable':
        return await enableOp(req, deps);
      case 'join':
      case 'renew':
        return await tokenOp(req, deps);
      case 'heartbeat':
        return await heartbeatOp(req, deps);
      case 'leave':
        return await leaveOp(req, deps);
    }
  } catch (error) {
    if (error instanceof Denied) return refuse(error.code);
    // Never the request (it carries the device token) and never a token: the error only.
    console.error('voice-token failed', error instanceof Error ? error.message : 'unknown error');
    return refuse('SERVER_ERROR', 500);
  }
}
