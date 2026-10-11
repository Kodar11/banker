/// <reference types="node" />
/**
 * Integration tests for voice chat authorization (the `voice-token` Edge Function) against a real
 * Postgres with the production migrations applied.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest } from '../../supabase/functions/game-action/handler.ts';
import { createTokenBuilder } from '../../supabase/functions/voice-token/agora.ts';
import { handleVoiceRequest, type VoiceDeps } from '../../supabase/functions/voice-token/handler.ts';
import {
  voiceChannelName,
  voiceUidForSeat,
  type ApiResponse,
  type GameAction,
  type VoiceGrant,
  type VoiceResponse,
  type VoiceRoom,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

interface Seat {
  playerId: string;
  token: string;
}

const DEFAULTS: Record<string, number> = {
  voice_chat_enabled: 1,
  private_voice_enabled: 1,
  require_entitlement: 1,
  monthly_game_limit: 20,
  monthly_participant_minutes: 3000,
  per_game_minutes: 120,
  token_ttl_seconds: 600,
  heartbeat_seconds: 30,
  stale_seconds: 90,
  token_rate_max: 12,
  token_rate_window_seconds: 60,
};

describe.skipIf(!DATABASE_URL)('voice chat authorization (Postgres)', () => {
  let sql: Sql;
  let deps: VoiceDeps;
  /** Every token the fake signer was asked for. */
  let signed: { channel: string; uid: number; ttl: number }[] = [];
  let broadcasts: { gameId: string; enabled: boolean }[] = [];
  let queuedRandoms: number[] = [];

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      buildToken: (channel, uid, ttl) => {
        signed.push({ channel, uid, ttl });
        return `token:${channel}:${uid}:${signed.length}`;
      },
      broadcastVoice: async (gameId, payload) => {
        broadcasts.push({ gameId, enabled: payload.enabled });
      },
    };
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    signed = [];
    broadcasts = [];
    await sql`delete from public.voice_participant_sessions`;
    await sql`delete from public.voice_game_sessions`;
    await sql`delete from public.voice_token_rate`;
    await sql`delete from public.voice_entitlements`;
    for (const [key, value] of Object.entries(DEFAULTS)) await sql`update public.voice_settings set value = ${value} where key = ${key}`;
  });

  const setting = (key: string, value: number) => sql`update public.voice_settings set value = ${value} where key = ${key}`;
  const token = () => randomBytes(32).toString('hex');

  async function game(body: unknown): Promise<Extract<ApiResponse, { ok: true }>> {
    const res = (await handleRequest(body, { sql, random: () => queuedRandoms.shift() ?? Math.random() })).body;
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  /** A private game with an entitled host. `voice` turns the room's voice on (as the host would). */
  async function setupGame(names = ['Asha', 'Bilal', 'Chitra'], { start = true, entitled = true, voice = true }: { start?: boolean; entitled?: boolean; voice?: boolean } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = await game({ op: 'create', actionId: randomUUID(), token: hostToken, name: host });
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    let version = created.snapshot.state.version;
    for (const name of rest) {
      const t = token();
      const joined = await game({ op: 'join', actionId: randomUUID(), token: t, code: created.snapshot.state.code, name });
      seats[name] = { playerId: joined.playerId, token: t };
      version = joined.snapshot.state.version;
    }
    const act = async (name: string, action: GameAction) => {
      if (action.type === 'START_GAME') queuedRandoms = orderRandoms(names, names);
      const seat = seats[name]!;
      const res = await game({ op: 'action', gameId, playerId: seat.playerId, token: seat.token, actionId: randomUUID(), expectedVersion: version, action });
      queuedRandoms = [];
      version = res.snapshot.state.version;
      return res;
    };
    // The host's account, as claim_seat would have attached it. The other seats stay guests with no account.
    const [user] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
    const hostUserId = user!.id as string;
    await sql`update public.players set user_id = ${hostUserId} where id = ${seats[host!]!.playerId}`;
    if (entitled) await sql`insert into public.voice_entitlements (user_id) values (${hostUserId})`;
    if (start) await act(host!, { type: 'START_GAME' });
    if (voice) {
      const res = await call('enable', gameId, seats[host!]!, { enabled: true });
      if (!res.ok) throw new Error(`enable: ${res.error.code}`);
      broadcasts = [];
    }
    return { gameId, seats, act, hostUserId, host: seats[host!]! };
  }

  async function call(op: string, gameId: string, seat: Seat, extra: Record<string, unknown> = {}): Promise<VoiceResponse> {
    return (await handleVoiceRequest({ op, gameId, playerId: seat.playerId, token: seat.token, ...extra }, deps)).body;
  }

  async function grantOf(gameId: string, seat: Seat, op: 'join' | 'renew' = 'join'): Promise<VoiceGrant> {
    const res = await call(op, gameId, seat);
    if (!res.ok || !('grant' in res)) throw new Error(`expected a grant, got ${res.ok ? 'no grant' : res.error.code}`);
    return res.grant;
  }

  async function denial(op: string, gameId: string, seat: Seat, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call(op, gameId, seat, extra);
    return res.ok ? 'OK' : res.error.code;
  }

  async function room(gameId: string, seat: Seat): Promise<VoiceRoom> {
    const res = await call('status', gameId, seat);
    if (!res.ok || !('room' in res)) throw new Error('expected a room');
    return res.room;
  }

  const sessions = (gameId: string) =>
    sql`select player_id, ended_at, end_reason, seconds, tokens_issued, rejoins from public.voice_participant_sessions where game_id = ${gameId} order by joined_at`;
  const gamesCounted = async () => Number((await sql`select count(*)::int as n from public.voice_game_sessions`)[0]!.n);

  /** Everything permanent about a game: none of it may change because of voice. */
  async function footprint(gameId: string) {
    const [g] = await sql`select state_version, status, updated_at, turn from public.games where id = ${gameId}`;
    const [counts] = await sql`
      select (select count(*) from public.game_events where game_id = ${gameId})::int as events,
             (select count(*) from public.game_actions where game_id = ${gameId})::int as actions,
             (select count(*) from public.transactions where game_id = ${gameId})::int as transactions`;
    return JSON.stringify({ g, counts });
  }

  // ---------------------------------------------------------------- tokens

  it('issues a token for this game’s channel and this seat’s uid, and returns nothing else', async () => {
    const { gameId, seats } = await setupGame();
    const res = await call('join', gameId, seats.Bilal!);
    expect(res.ok).toBe(true);
    const grant = (res as { grant: VoiceGrant }).grant;
    const [row] = await sql`select seat from public.players where id = ${seats.Bilal!.playerId}`;
    expect(grant.channel).toBe(voiceChannelName(gameId));
    expect(grant.uid).toBe(voiceUidForSeat(row!.seat as number));
    expect(signed).toEqual([{ channel: grant.channel, uid: grant.uid, ttl: 600 }]);
    expect(Object.keys(grant).sort()).toEqual(['channel', 'expiresAt', 'heartbeatSeconds', 'token', 'uid']);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThan(610_000);
    expect(JSON.stringify(res)).not.toMatch(/certificate/i);
  });

  it('gives every seat of a game the same channel and a different uid', async () => {
    const { gameId, seats } = await setupGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    const grants = await Promise.all(Object.values(seats).map((s) => grantOf(gameId, s)));
    expect(new Set(grants.map((g) => g.channel)).size).toBe(1);
    expect(new Set(grants.map((g) => g.uid)).size).toBe(4);
    expect(grants.every((g) => g.uid >= 1 && g.uid <= 8)).toBe(true);
  });

  it('signs a real Agora token with the official library (and refuses malformed credentials)', () => {
    const build = createTokenBuilder('0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210');
    expect(build).toBeTypeOf('function');
    const a = build!('rr-abc', 3, 600);
    // AccessToken2: version prefix "007".
    expect(a.startsWith('007')).toBe(true);
    expect(a).not.toContain('fedcba9876543210fedcba9876543210');
    expect(build!('rr-other', 3, 600)).not.toBe(a);
    expect(createTokenBuilder(undefined, 'fedcba9876543210fedcba9876543210')).toBeUndefined();
    expect(createTokenBuilder('0123456789abcdef0123456789abcdef', undefined)).toBeUndefined();
    expect(createTokenBuilder('not-an-app-id', 'fedcba9876543210fedcba9876543210')).toBeUndefined();
  });

  it('refuses every token when the server has no Agora credentials', async () => {
    const { gameId, seats } = await setupGame();
    const res = (await handleVoiceRequest({ op: 'join', gameId, playerId: seats.Asha!.playerId, token: seats.Asha!.token }, { sql })).body;
    expect(res.ok ? 'OK' : res.error.code).toBe('NOT_CONFIGURED');
    expect(await gamesCounted()).toBe(0);
  });

  // ---------------------------------------------------------------- who

  it('lets invited players with no account and no entitlement join an entitled host’s room', async () => {
    const { gameId, seats } = await setupGame();
    const [guest] = await sql`select user_id from public.players where id = ${seats.Chitra!.playerId}`;
    expect(guest!.user_id).toBeNull();
    expect(await denial('join', gameId, seats.Chitra!)).toBe('OK');
  });

  it('refuses someone who is not in the game, a wrong token, another game’s seat and a player who left', async () => {
    const a = await setupGame(['Asha', 'Bilal', 'Chitra']);
    const b = await setupGame(['Dev', 'Esha']);
    // A seat of game B asking for game A's channel, with its own valid token.
    expect(await denial('join', a.gameId, b.seats.Dev!)).toBe('FORBIDDEN');
    // A real seat id of game A with somebody else's token.
    expect(await denial('join', a.gameId, { playerId: a.seats.Bilal!.playerId, token: b.seats.Dev!.token })).toBe('FORBIDDEN');
    expect(await denial('join', a.gameId, { playerId: randomUUID(), token: token() })).toBe('FORBIDDEN');
    expect(await denial('join', randomUUID(), a.seats.Asha!)).toBe('FORBIDDEN');
    expect(await denial('status', a.gameId, b.seats.Dev!)).toBe('FORBIDDEN');
    expect(signed).toEqual([]);

    expect(await denial('join', a.gameId, a.seats.Chitra!)).toBe('OK');
    await a.act('Chitra', { type: 'LEAVE_GAME' });
    expect(await denial('renew', a.gameId, a.seats.Chitra!)).toBe('FORBIDDEN');
    expect(await denial('heartbeat', a.gameId, a.seats.Chitra!)).toBe('FORBIDDEN');
  });

  it('rejects malformed requests, and a request cannot name a channel or a uid', async () => {
    const { gameId, seats } = await setupGame();
    const seat = seats.Asha!;
    const base = { op: 'join', gameId, playerId: seat.playerId, token: seat.token };
    for (const body of [
      null,
      {},
      { ...base, op: 'talk' },
      { ...base, gameId: 'not-a-uuid' },
      { ...base, token: 'short' },
      { ...base, channel: 'rr-somewhere-else' },
      { ...base, uid: 7 },
      { ...base, entitled: true },
      { op: 'enable', gameId, playerId: seat.playerId, token: seat.token, enabled: 'yes' },
    ]) {
      const res = await handleVoiceRequest(body, deps);
      expect(res.status).toBe(400);
      expect(res.body.ok ? 'OK' : res.body.error.code).toBe('VALIDATION');
    }
    expect(signed).toEqual([]);
  });

  // ---------------------------------------------------------------- the room

  it('only the host can turn voice on, and only when entitled', async () => {
    const plain = await setupGame(['Asha', 'Bilal'], { entitled: false, voice: false });
    expect(await denial('enable', plain.gameId, plain.seats.Bilal!, { enabled: true })).toBe('NOT_HOST');
    expect(await denial('enable', plain.gameId, plain.host, { enabled: true })).toBe('NOT_ENTITLED');
    expect((await room(plain.gameId, plain.host)).enabled).toBe(false);
    expect(await denial('join', plain.gameId, plain.seats.Bilal!)).toBe('NOT_ENTITLED');
    expect(broadcasts).toEqual([]);

    // An expired entitlement is no entitlement.
    await sql`insert into public.voice_entitlements (user_id, expires_at) values (${plain.hostUserId}, now() - interval '1 minute')`;
    expect(await denial('enable', plain.gameId, plain.host, { enabled: true })).toBe('NOT_ENTITLED');

    await sql`update public.voice_entitlements set expires_at = now() + interval '1 day' where user_id = ${plain.hostUserId}`;
    const res = await call('enable', plain.gameId, plain.host, { enabled: true });
    expect(res.ok && 'room' in res && res.room.enabled).toBe(true);
    expect(broadcasts).toEqual([{ gameId: plain.gameId, enabled: true }]);
    // Turning it on twice changes nothing and tells nobody.
    await call('enable', plain.gameId, plain.host, { enabled: true });
    expect(broadcasts).toHaveLength(1);
  });

  it('a host whose seat has no account cannot host voice while entitlement is required; can when it is not', async () => {
    const { gameId, host } = await setupGame(['Asha', 'Bilal'], { voice: false });
    await sql`update public.players set user_id = null where id = ${host.playerId}`;
    expect(await denial('enable', gameId, host, { enabled: true })).toBe('NOT_ENTITLED');
    await setting('require_entitlement', 0);
    expect(await denial('enable', gameId, host, { enabled: true })).toBe('OK');
  });

  it('an ordinary private room stays voice-free, and its status says so', async () => {
    const { gameId, seats } = await setupGame(['Asha', 'Bilal'], { voice: false });
    expect(await denial('join', gameId, seats.Bilal!)).toBe('ROOM_VOICE_OFF');
    expect(await room(gameId, seats.Bilal!)).toEqual({ enabled: false, available: false, reason: 'ROOM_VOICE_OFF', canConfigure: false });
    expect((await room(gameId, seats.Asha!)).canConfigure).toBe(true);
  });

  it('rechecks the host’s entitlement for every token: a lapsed one stops renewals', async () => {
    const { gameId, seats, hostUserId } = await setupGame();
    expect(await denial('join', gameId, seats.Bilal!)).toBe('OK');
    await sql`delete from public.voice_entitlements where user_id = ${hostUserId}`;
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('NOT_ENTITLED');
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('NOT_ENTITLED');
    const [s] = await sessions(gameId);
    expect(s!.end_reason).toBe('revoked');
  });

  it('a matchmade game can never have voice: not by the host, and not by the database', async () => {
    const { gameId, seats, host } = await setupGame(['Asha', 'Bilal'], { voice: false });
    const [match] = await sql`insert into public.matchmaking_matches (mode, player_count, ready_deadline) values ('classic', 2, now()) returning id`;
    await sql`update public.games set matchmaking_match_id = ${match!.id} where id = ${gameId}`;
    expect(await denial('enable', gameId, host, { enabled: true })).toBe('PUBLIC_GAME');
    expect(await denial('join', gameId, seats.Bilal!)).toBe('PUBLIC_GAME');
    expect(await room(gameId, host)).toEqual({ enabled: false, available: false, reason: 'PUBLIC_GAME', canConfigure: false });
    await expect(sql`update public.games set voice_enabled = true where id = ${gameId}`).rejects.toThrow(/games_voice_private_only/);
    expect(signed).toEqual([]);
  });

  it('voice is for a game in play: not the lobby, not a finished game', async () => {
    const lobby = await setupGame(['Asha', 'Bilal'], { start: false });
    expect(await denial('join', lobby.gameId, lobby.seats.Bilal!)).toBe('GAME_NOT_ACTIVE');
    // The lobby can already see that the room will have voice.
    expect(await room(lobby.gameId, lobby.seats.Bilal!)).toMatchObject({ enabled: true, available: false, reason: 'GAME_NOT_ACTIVE' });

    const played = await setupGame(['Asha', 'Bilal']);
    expect(await denial('join', played.gameId, played.seats.Bilal!)).toBe('OK');
    await played.act('Asha', { type: 'PAUSE_GAME' });
    expect(await denial('renew', played.gameId, played.seats.Bilal!)).toBe('OK');
    await played.act('Asha', { type: 'RESUME_GAME' });
    await played.act('Asha', { type: 'END_GAME' });
    expect(await denial('renew', played.gameId, played.seats.Bilal!)).toBe('GAME_NOT_ACTIVE');
    expect(await denial('heartbeat', played.gameId, played.seats.Bilal!)).toBe('GAME_NOT_ACTIVE');
    expect(await denial('enable', played.gameId, played.host, { enabled: true })).toBe('GAME_NOT_ACTIVE');
  });

  it('turning voice off closes the room’s sessions and refuses new tokens', async () => {
    const { gameId, seats, host } = await setupGame();
    await grantOf(gameId, seats.Bilal!);
    await grantOf(gameId, seats.Chitra!);
    expect(await denial('enable', gameId, host, { enabled: false })).toBe('OK');
    expect(broadcasts).toEqual([{ gameId, enabled: false }]);
    expect((await sessions(gameId)).map((s) => s.end_reason)).toEqual(['revoked', 'revoked']);
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('ROOM_VOICE_OFF');
    expect(await denial('heartbeat', gameId, seats.Chitra!)).toBe('ROOM_VOICE_OFF');
  });

  // ---------------------------------------------------------------- switches

  it('the kill switch stops new joins and renewals at once, and tells connected phones at their next heartbeat', async () => {
    const { gameId, seats } = await setupGame();
    await grantOf(gameId, seats.Bilal!);
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('OK');
    await setting('voice_chat_enabled', 0);
    expect(await denial('join', gameId, seats.Chitra!)).toBe('VOICE_DISABLED');
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('VOICE_DISABLED');
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('VOICE_DISABLED');
    expect(await room(gameId, seats.Bilal!)).toMatchObject({ enabled: true, available: false, reason: 'VOICE_DISABLED' });
    expect(signed).toHaveLength(1);

    await setting('voice_chat_enabled', 1);
    await setting('private_voice_enabled', 0);
    expect(await denial('join', gameId, seats.Chitra!)).toBe('VOICE_DISABLED');
    await setting('private_voice_enabled', 1);
    expect(await denial('join', gameId, seats.Chitra!)).toBe('OK');
  });

  it('fails closed when the settings rows are missing', async () => {
    const { gameId, seats } = await setupGame();
    const saved = await sql`select key, value from public.voice_settings`;
    await sql`delete from public.voice_settings`;
    try {
      expect(await denial('join', gameId, seats.Bilal!)).toBe('VOICE_DISABLED');
    } finally {
      for (const row of saved) await sql`insert into public.voice_settings (key, value) values (${row.key}, ${row.value})`;
    }
  });

  // ---------------------------------------------------------------- caps

  it('counts a game once, however many players, renewals and reconnects it has', async () => {
    const { gameId, seats } = await setupGame();
    await Promise.all([grantOf(gameId, seats.Asha!), grantOf(gameId, seats.Bilal!), grantOf(gameId, seats.Chitra!)]);
    await grantOf(gameId, seats.Bilal!, 'renew');
    await grantOf(gameId, seats.Bilal!, 'join'); // a reconnect while the session is open
    expect(await gamesCounted()).toBe(1);
    const rows = await sessions(gameId);
    expect(rows).toHaveLength(3);
    const bilal = rows.find((r) => r.player_id === seats.Bilal!.playerId)!;
    expect(bilal).toMatchObject({ tokens_issued: 3, rejoins: 1, ended_at: null });
  });

  it('a room that turned voice on but never connected uses no allowance', async () => {
    await setupGame();
    expect(await gamesCounted()).toBe(0);
  });

  it('the monthly game cap is atomic: concurrent first joins of different games cannot exceed it', async () => {
    await setting('monthly_game_limit', 2);
    // Set up one after another (the scripted turn order is shared); only the joins race.
    const games = [];
    for (const i of [1, 2, 3, 4, 5]) games.push(await setupGame([`Host${i}`, `Guest${i}`]));
    const results = await Promise.all(games.flatMap((g) => [denial('join', g.gameId, g.seats[Object.keys(g.seats)[0]!]!), denial('join', g.gameId, g.seats[Object.keys(g.seats)[1]!]!)]));
    expect(await gamesCounted()).toBe(2);
    const counted = (await sql`select game_id from public.voice_game_sessions`).map((r) => r.game_id as string);
    games.forEach((g, i) => {
      const expected = counted.includes(g.gameId) ? 'OK' : 'LIMIT_REACHED';
      expect([results[2 * i], results[2 * i + 1]]).toEqual([expected, expected]);
    });
    // A game that has its place keeps it; the board game of a refused one is untouched.
    const inGame = games.find((g) => counted.includes(g.gameId))!;
    const refused = games.find((g) => !counted.includes(g.gameId))!;
    expect(await denial('renew', inGame.gameId, Object.values(inGame.seats)[0]!)).toBe('OK');
    expect(await room(refused.gameId, refused.host)).toMatchObject({ enabled: true, available: false, reason: 'LIMIT_REACHED' });
    const rolled = await refused.act(Object.keys(refused.seats)[0]!, { type: 'ROLL_DICE' });
    expect(rolled.ok).toBe(true);
  });

  it('the participant-minute cap refuses joins and renewals, and lets a connected phone run out its token', async () => {
    const { gameId, seats } = await setupGame();
    await setting('monthly_participant_minutes', 10);
    await grantOf(gameId, seats.Bilal!);
    // Bilal has been connected for eleven minutes (the test moves the mark, not the clock).
    await sql`update public.voice_participant_sessions set joined_at = now() - interval '11 minutes' where game_id = ${gameId}`;
    expect(await denial('join', gameId, seats.Chitra!)).toBe('LIMIT_REACHED');
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('OK');
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('LIMIT_REACHED');
    const [s] = await sessions(gameId);
    expect(s).toMatchObject({ end_reason: 'revoked' });
    expect(Number(s!.seconds)).toBeGreaterThanOrEqual(660);
    // The heartbeat of the closed session now says so.
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('SESSION_ENDED');

    const other = await setupGame(['Dev', 'Esha']);
    expect(await denial('join', other.gameId, other.seats.Dev!)).toBe('LIMIT_REACHED');
    expect(await gamesCounted()).toBe(1);
  });

  it('last month’s usage does not count against this month', async () => {
    const old = await setupGame(['Dev', 'Esha']);
    await setting('monthly_game_limit', 1);
    await setting('monthly_participant_minutes', 10);
    await grantOf(old.gameId, old.seats.Dev!);
    await sql`update public.voice_game_sessions set month = (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date`;
    await sql`update public.voice_participant_sessions
      set month = (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date,
          ended_at = now(), end_reason = 'left', seconds = 86400`;
    const fresh = await setupGame(['Asha', 'Bilal']);
    expect(await denial('join', fresh.gameId, fresh.seats.Asha!)).toBe('OK');
  });

  it('the per-game limit ends a game’s voice, for joins, renewals and heartbeats', async () => {
    const { gameId, seats } = await setupGame();
    await setting('per_game_minutes', 30);
    await grantOf(gameId, seats.Bilal!);
    await sql`update public.voice_game_sessions set started_at = now() - interval '31 minutes' where game_id = ${gameId}`;
    expect(await denial('join', gameId, seats.Chitra!)).toBe('GAME_LIMIT_REACHED');
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('GAME_LIMIT_REACHED');
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('GAME_LIMIT_REACHED');
    await setting('per_game_minutes', 0);
    expect(await denial('join', gameId, seats.Chitra!)).toBe('OK');
  });

  // ---------------------------------------------------------------- usage

  it('leave closes the session once; leaving again, or without one, changes nothing', async () => {
    const { gameId, seats } = await setupGame();
    await grantOf(gameId, seats.Bilal!);
    await sql`update public.voice_participant_sessions set joined_at = now() - interval '90 seconds' where game_id = ${gameId}`;
    expect(await denial('leave', gameId, seats.Bilal!)).toBe('OK');
    const [first] = await sessions(gameId);
    expect(first).toMatchObject({ end_reason: 'left' });
    expect(Number(first!.seconds)).toBeGreaterThanOrEqual(90);
    expect(Number(first!.seconds)).toBeLessThan(100);
    expect(await denial('leave', gameId, seats.Bilal!)).toBe('OK');
    expect(await denial('leave', gameId, seats.Chitra!)).toBe('OK');
    const rows = await sessions(gameId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seconds).toBe(first!.seconds);

    // Rejoining is a new session of the same game: the game is still counted once.
    await grantOf(gameId, seats.Bilal!);
    expect(await sessions(gameId)).toHaveLength(2);
    expect(await gamesCounted()).toBe(1);
  });

  it('a phone that went quiet stops being counted, and concurrent joins of one seat open one session', async () => {
    const { gameId, seats } = await setupGame();
    await Promise.all([1, 2, 3, 4].map(() => call('join', gameId, seats.Bilal!)));
    expect(await sessions(gameId)).toHaveLength(1);

    // Connected five minutes ago, last heard from four minutes ago.
    await sql`update public.voice_participant_sessions
      set joined_at = now() - interval '5 minutes', last_seen_at = now() - interval '4 minutes', token_expires_at = now() + interval '5 minutes'
      where game_id = ${gameId}`;
    expect(await denial('heartbeat', gameId, seats.Bilal!)).toBe('SESSION_ENDED');
    // The next token request sweeps it: counted to the last moment it could have been connected (last seen + 90 s).
    await grantOf(gameId, seats.Chitra!);
    const rows = await sessions(gameId);
    const bilal = rows.find((r) => r.player_id === seats.Bilal!.playerId)!;
    expect(bilal.end_reason).toBe('stale');
    expect(Number(bilal.seconds)).toBeGreaterThanOrEqual(149);
    expect(Number(bilal.seconds)).toBeLessThanOrEqual(151);
  });

  it('limits how many tokens one seat can ask for', async () => {
    const { gameId, seats } = await setupGame();
    await setting('token_rate_max', 3);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await denial('renew', gameId, seats.Bilal!));
    expect(results).toEqual(['OK', 'OK', 'OK', 'RATE_LIMITED', 'RATE_LIMITED']);
    // Another seat is not affected, and the window passes.
    expect(await denial('join', gameId, seats.Chitra!)).toBe('OK');
    await sql`update public.voice_token_rate set window_start = now() - interval '61 seconds' where player_id = ${seats.Bilal!.playerId}`;
    expect(await denial('renew', gameId, seats.Bilal!)).toBe('OK');
  });

  it('reports the month’s usage for cost estimates', async () => {
    const { gameId, seats } = await setupGame();
    await grantOf(gameId, seats.Asha!);
    await grantOf(gameId, seats.Bilal!);
    await sql`update public.voice_participant_sessions set joined_at = now() - interval '30 minutes' where game_id = ${gameId}`;
    await call('leave', gameId, seats.Asha!);
    await call('leave', gameId, seats.Bilal!);
    const [row] = await sql`select * from public.voice_usage_monthly`;
    expect(row).toMatchObject({ voice_games: 1, participant_sessions: 2 });
    expect(Number(row!.participant_minutes)).toBeCloseTo(60, 0);
    expect(Number(row!.avg_participants_per_game)).toBe(2);
    expect(Number(row!.estimated_cost_usd)).toBeCloseTo(0.06, 2);
  });

  // ---------------------------------------------------------------- isolation

  it('never touches the game: no version, event, action or transaction changes because of voice', async () => {
    const { gameId, seats, host } = await setupGame();
    const before = await footprint(gameId);
    await grantOf(gameId, seats.Asha!);
    await grantOf(gameId, seats.Bilal!, 'renew');
    await call('heartbeat', gameId, seats.Asha!);
    await call('leave', gameId, seats.Asha!);
    await call('enable', gameId, host, { enabled: false });
    await call('enable', gameId, host, { enabled: true });
    expect(await footprint(gameId)).toBe(before);
    // And the game plays on.
    const rolled = await (await setupGame(['Dev', 'Esha'])).act('Dev', { type: 'ROLL_DICE' });
    expect(rolled.ok).toBe(true);
  });

  it('the app’s own database roles cannot read or write any of it', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['voice_settings', 'voice_entitlements', 'voice_game_sessions', 'voice_participant_sessions', 'voice_token_rate', 'voice_usage_monthly']) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(`select * from public.${table} limit 1`);
          }),
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select public.voice_grant('RR-ABC234')`;
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('voice_grant / voice_revoke manage entitlement by public player id', async () => {
    const [user] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
    const profile = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user!.id, role: 'authenticated' })}, true)`;
      return (await tx`select public.init_profile() as r`)[0]!.r as { profile?: { player_id: string }; player_id?: string };
    });
    const [row] = await sql`select player_id from public.profiles where user_id = ${user!.id}`;
    expect(profile).toBeTruthy();
    const publicId = row!.player_id as string;
    expect((await sql`select public.voice_host_entitled(${user!.id}::uuid) as ok`)[0]!.ok).toBe(false);
    expect((await sql`select public.voice_grant(${publicId.toLowerCase()}, 30) as ok`)[0]!.ok).toBe(true);
    expect((await sql`select public.voice_host_entitled(${user!.id}::uuid) as ok`)[0]!.ok).toBe(true);
    expect((await sql`select public.voice_grant('RR-ZZZZZZ') as ok`)[0]!.ok).toBe(false);
    expect((await sql`select public.voice_revoke(${publicId}) as ok`)[0]!.ok).toBe(true);
    expect((await sql`select public.voice_host_entitled(${user!.id}::uuid) as ok`)[0]!.ok).toBe(false);
  });
});
