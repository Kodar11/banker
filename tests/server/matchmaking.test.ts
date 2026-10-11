/// <reference types="node" />
/**
 * Random matchmaking against a real Postgres with the production migrations applied (plus
 * scripts/local-auth-stub.sql standing in for Supabase's auth schema), the real matchmaking
 * worker, and the real game-action referee for everything that happens once a game exists.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Every statement a player could send runs as the `authenticated` role with that player's JWT
 * claims, exactly as PostgREST runs it. Skipped when DATABASE_URL is not set.
 *
 * Time: nothing here sleeps through a threshold. Waiting is simulated by moving a row's own
 * timestamp back (`timeTravel`, which a client could never do), and the thresholds themselves are
 * read from public.matchmaking_settings.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql, type Tx } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import {
  handleMatchmakingRequest,
  matchMode,
  runTick,
  startDueMatches,
  startMatch,
  type FaultPoint,
  type MatchmakingDeps,
} from '../../supabase/functions/matchmaking/handler.ts';
import { defaultGameConfig, type ApiResponse, type GameAction } from '../../supabase/functions/_shared/engine/index.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ok = Extract<ApiResponse, { ok: true }>;
type Mode = 'classic' | 'intermediate';

interface Player {
  userId: string;
  playerId: string;
  nickname: string;
}

describe.skipIf(!DATABASE_URL)('random matchmaking (Postgres)', () => {
  let sql: Sql;
  let referee: HandlerDeps;
  let worker: MatchmakingDeps;
  let defaults: { key: string; value: number }[] = [];
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!, 24);
    referee = { sql };
    worker = { sql, log: (entry) => void logs.push(entry) };
    defaults = (await sql`select key, value from public.matchmaking_settings`) as unknown as { key: string; value: number }[];
  });

  afterAll(async () => {
    await sql?.end();
  });

  // The queue is one shared thing: every test starts with it empty and with the default settings.
  beforeEach(async () => {
    logs.length = 0;
    await sql`delete from public.matchmaking_tickets`;
    await sql`delete from public.matchmaking_matches`;
    await sql`delete from public.parties`;
    await sql`delete from public.matchmaking_cooldowns`;
    await sql`update public.matchmaking_runs set last_run_at = null`;
    await sql`update public.matchmaking_tick_gate set last_tick_at = null`;
    await sql`delete from public.matchmaking_nudges`;
    for (const d of defaults) await sql`update public.matchmaking_settings set value = ${d.value} where key = ${d.key}`;
  });

  // ---- players ------------------------------------------------------------------------------
  function as<T>(userId: string | null, fn: (tx: Tx) => Promise<T>, role: 'authenticated' | 'anon' = 'authenticated'): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${userId ? JSON.stringify({ sub: userId, role }) : ''}, true)`;
      await tx.unsafe(`set local role ${role}`);
      return fn(tx);
    }) as Promise<T>;
  }

  async function newPlayer(): Promise<Player> {
    const [row] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
    const userId = row!.id as string;
    const profile = await as(userId, async (tx) => (await tx`select public.init_profile() as r`)[0]!.r as Json);
    return { userId, playerId: profile.profile.player_id, nickname: profile.profile.nickname };
  }

  const players = (n: number) => Promise.all(Array.from({ length: n }, newPlayer));

  function rpc(who: Player | null, name: string, ...args: unknown[]): Promise<Json> {
    return as(who?.userId ?? null, async (tx) => {
      const list = args.map((_, i) => `$${i + 1}`).join(', ');
      const [row] = await tx.unsafe(`select public.${name}(${list}) as r`, args as never[]);
      return row!.r as Json;
    });
  }

  const state = (who: Player) => rpc(who, 'matchmaking_state');
  const enqueue = (who: Player, mode: Mode | null = 'classic', key: string | null = null) => rpc(who, 'matchmaking_enqueue', mode, key);
  const cancel = (who: Player) => rpc(who, 'matchmaking_cancel');
  const token = () => randomBytes(32).toString('hex');
  const setting = (key: string, value: number) => sql`update public.matchmaking_settings set value = ${value} where key = ${key}`;
  const tick = () => runTick(worker, { force: true });

  // ---- the function's front door (handleMatchmakingRequest) -----------------------------------
  /** What the scheduler holds. Server-only: it exists in Vault and in the function's secrets, never in the app. */
  const WORKER_SECRET = randomBytes(32).toString('hex');
  /** Access tokens Supabase Auth would accept, by player (Auth itself is stood in for; everything behind it is real). */
  const sessions = new Map<string, string>();
  let authCalls = 0;
  let authDown = false;
  /** The worker as deployed: it knows the worker secret and asks Auth who a token belongs to. */
  const secured: MatchmakingDeps = {
    get sql() {
      return sql;
    },
    log: (entry) => void logs.push(entry),
    workerSecret: WORKER_SECRET,
    verifyUser: async (accessToken) => {
      authCalls += 1;
      if (authDown) throw new Error('auth user 503: upstream connect error at 10.0.0.7');
      const userId = sessions.get(accessToken);
      return userId ? { id: userId } : null;
    },
  };
  const accessToken = (who: Player): string => {
    const jwt = `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: who.userId })).toString('base64url')}.${randomBytes(16).toString('base64url')}`;
    sessions.set(jwt, who.userId);
    return jwt;
  };
  const asScheduler = (body: unknown = { op: 'tick', source: 'cron' }) => handleMatchmakingRequest(body, secured, { workerSecret: WORKER_SECRET });
  const asPlayer = (who: Player, body: unknown = { op: 'tick' }) => handleMatchmakingRequest(body, secured, { authorization: `Bearer ${accessToken(who)}` });
  /** Lets the next tick through as if the interval had passed (only time can do that). */
  const passTickInterval = () => sql`update public.matchmaking_tick_gate set last_tick_at = last_tick_at - interval '10 seconds'`;
  const passNudgeInterval = () => sql`update public.matchmaking_nudges set last_nudge_at = last_nudge_at - interval '10 seconds'`;
  /** How much matchmaking work the database has been asked to do: whole ticks let through, and matching runs. */
  const workDone = async () => {
    const [gate] = await sql`select ticks::int as ticks from public.matchmaking_tick_gate`;
    const [runs] = await sql`select coalesce(sum(runs), 0)::int as runs from public.matchmaking_runs`;
    return { ticks: gate!.ticks as number, runs: runs!.runs as number };
  };

  /** Changes a row's own timestamps the way only time can. Triggers are off for this one statement block. */
  async function timeTravel(fn: (tx: Tx) => Promise<unknown>): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await fn(tx);
    });
  }
  const waitInQueue = (seconds: number, who?: Player[]) =>
    timeTravel((tx) =>
      who
        ? tx`update public.matchmaking_tickets t set queued_at = queued_at - make_interval(secs => ${seconds})
             where t.status = 'QUEUED' and t.id in (select m.ticket_id from public.matchmaking_ticket_members m where m.user_id = any(${who.map((p) => p.userId)}::uuid[]))`
        : tx`update public.matchmaking_tickets set queued_at = queued_at - make_interval(secs => ${seconds}) where status = 'QUEUED'`,
    );
  const passReadyDeadline = (matchId: string) =>
    timeTravel((tx) => tx`update public.matchmaking_matches set ready_deadline = now() - interval '1 second' where id = ${matchId}`);
  const passStartDeadline = (matchId: string) =>
    timeTravel((tx) => tx`update public.matchmaking_matches set start_deadline = now() - interval '1 second' where id = ${matchId}`);
  const goSilent = (who: Player, seconds: number) =>
    sql`update public.matchmaking_ticket_members set last_seen_at = now() - make_interval(secs => ${seconds}) where user_id = ${who.userId} and active`;

  const ticketOf = async (who: Player) =>
    (
      await sql`select t.* from public.matchmaking_tickets t join public.matchmaking_ticket_members m on m.ticket_id = t.id
                where m.user_id = ${who.userId} order by t.created_at desc limit 1`
    )[0] as Json | undefined;
  const matchRow = async (matchId: string) => (await sql`select * from public.matchmaking_matches where id = ${matchId}`)[0] as Json;
  const matchIdOf = async (who: Player) => (await state(who)).match?.id as string | undefined;

  async function queueSolos(n: number, mode: Mode = 'classic'): Promise<Player[]> {
    const list = await players(n);
    for (const p of list) expect(await enqueue(p, mode)).toMatchObject({ ok: true, created: true });
    return list;
  }

  /** Everyone confirms. Returns each player's device token (what their phone keeps). */
  async function readyAll(list: Player[], matchId: string): Promise<Map<string, string>> {
    const tokens = new Map<string, string>();
    for (const p of list) {
      const t = token();
      tokens.set(p.userId, t);
      expect(await rpc(p, 'matchmaking_ready', matchId, t)).toMatchObject({ ok: true });
    }
    return tokens;
  }

  // ---- friends and parties --------------------------------------------------------------------
  async function befriend(a: Player, b: Player): Promise<void> {
    expect(await rpc(a, 'send_friend_request', b.playerId)).toMatchObject({ ok: true });
    const incoming = (await rpc(b, 'social_state')).incoming as Json[];
    const request = incoming.find((r) => r.player_id === a.playerId)!;
    expect(await rpc(b, 'respond_friend_request', request.id, true)).toMatchObject({ ok: true, relationship: 'friends' });
  }

  /** A party led by the first player, everyone joined and (unless told otherwise) ready. */
  async function party(size: number, mode: Mode = 'classic', { ready = true }: { ready?: boolean } = {}): Promise<Player[]> {
    const members = await players(size);
    const [leader, ...others] = members;
    expect(await rpc(leader!, 'party_create', mode)).toMatchObject({ ok: true, created: true });
    for (const m of others) {
      await befriend(leader!, m);
      const invited = await rpc(leader!, 'party_invite', m.playerId);
      expect(invited).toMatchObject({ ok: true, created: true });
      expect(await rpc(m, 'party_respond_invite', invited.invite_id, true)).toMatchObject({ ok: true, joined: true });
    }
    if (ready) for (const m of others) expect(await rpc(m, 'party_set_ready', true)).toMatchObject({ ok: true });
    return members;
  }

  // ---- games (the real referee) ---------------------------------------------------------------
  async function call(body: unknown): Promise<ApiResponse> {
    return (await handleRequest(body, referee)).body;
  }
  function ok(res: ApiResponse): Ok {
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  /** `host` creates a private game and claims the seat for their account. */
  async function hostPrivateGame(host: Player) {
    const t = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: 'Host' }));
    expect(await rpc(host, 'claim_seat', created.gameId, created.playerId, t)).toEqual({ ok: true });
    return { gameId: created.gameId, seatId: created.playerId, token: t, code: created.snapshot.state.code };
  }

  /** Queue → reservation → everyone ready → game. The whole happy path, for tests about what follows it. */
  async function playMatch(list: Player[], mode: Mode = 'classic') {
    for (const p of list) expect(await enqueue(p, mode)).toMatchObject({ ok: true });
    await waitInQueue(120);
    await tick();
    const matchId = (await matchIdOf(list[0]!))!;
    expect(matchId).toBeTruthy();
    const tokens = await readyAll(list, matchId);
    await tick();
    const game = (await state(list[0]!)).game as Json;
    return { matchId, tokens, gameId: game.game_id as string };
  }

  // =========================================================================================
  describe('identity and direct access', () => {
    it('every function needs a signed-in player, and the anon role cannot even call them', async () => {
      for (const [name, args] of [
        ['matchmaking_state', []],
        ['matchmaking_heartbeat', []],
        ['matchmaking_enqueue', ['classic', null]],
        ['matchmaking_cancel', []],
        ['matchmaking_ready', [randomUUID(), token()]],
        ['matchmaking_decline', [randomUUID()]],
        ['party_create', ['classic']],
        ['party_invite', ['RR-222222']],
        ['party_respond_invite', [randomUUID(), true]],
        ['party_revoke_invite', [randomUUID()]],
        ['party_set_mode', ['classic']],
        ['party_set_ready', [true]],
        ['party_leave', []],
        ['party_kick', ['RR-222222']],
      ] as [string, unknown[]][]) {
        expect(await rpc(null, name, ...args), name).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
        const list = args.map((_, i) => `$${i + 1}`).join(', ');
        await expect(as(null, (tx) => tx.unsafe(`select public.${name}(${list})`, args as never[]), 'anon'), name).rejects.toThrow(/permission denied/);
      }
    });

    it('the worker’s functions cannot be called by a player', async () => {
      const [a] = await players(1);
      for (const [name, args] of [
        ['matchmaking_candidates', ['classic', true]],
        ['matchmaking_reserve', ['classic', [randomUUID()]]],
        ['matchmaking_begin_start', [randomUUID()]],
        ['matchmaking_finish_start', [randomUUID(), randomUUID(), '[]']],
        ['matchmaking_note_start_failure', [randomUUID(), 'x']],
        ['matchmaking_cancel_match', [randomUUID(), 'CANCELLED', 'x', []]],
        ['matchmaking_sweep', [10]],
        ['matchmaking_strike', [a!.userId]],
        ['matchmaking_touch', [[a!.userId]]],
        ['matchmaking_metrics', ['1 hour']],
        ['matchmaking_cron_tick', []],
        ['matchmaking_setting', ['ready_seconds', 20]],
        ['matchmaking_live_game', [a!.userId]],
      ] as [string, unknown[]][]) {
        const list = args.map((_, i) => `$${i + 1}`).join(', ');
        await expect(as(a!.userId, (tx) => tx.unsafe(`select public.${name}(${list})`, args as never[])), name).rejects.toThrow(/permission denied/);
      }
    });

    it('no table can be read or written directly — not a ticket, a party, a reservation or a setting', async () => {
      const [a, b] = await queueSolos(2);
      const ticket = (await ticketOf(b!))!;
      for (const table of [
        'matchmaking_tickets',
        'matchmaking_ticket_members',
        'matchmaking_matches',
        'matchmaking_match_players',
        'matchmaking_settings',
        'matchmaking_cooldowns',
        'matchmaking_events',
        'matchmaking_runs',
        'matchmaking_touch_queue',
        'parties',
        'party_members',
        'party_invitations',
      ]) {
        await expect(as(a!.userId, (tx) => tx.unsafe(`select * from public.${table} limit 1`)), table).rejects.toThrow(/permission denied/);
      }
      await expect(as(a!.userId, (tx) => tx`update public.matchmaking_tickets set status = 'CANCELLED' where id = ${ticket.id}`)).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`insert into public.matchmaking_tickets (kind, owner_user_id, mode, player_count) values ('solo', ${b!.userId}, 'classic', 1)`)).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`update public.matchmaking_settings set value = 600 where key = 'ready_seconds'`)).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`update public.matchmaking_sync set version = 99`)).rejects.toThrow(/permission denied/);
    });

    it('a player reads their own change counter and nobody else’s', async () => {
      const [a, b] = await queueSolos(2);
      await state(a!);
      await state(b!);
      const rows = await as(a!.userId, (tx) => tx`select user_id from public.matchmaking_sync`);
      expect(rows.map((r) => r.user_id)).toEqual([a!.userId]);
    });

    it('an account without a profile cannot queue', async () => {
      const [row] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
      const ghost: Player = { userId: row!.id, playerId: '', nickname: '' };
      expect(await enqueue(ghost)).toEqual({ ok: false, code: 'NO_PROFILE' });
      expect(await state(ghost)).toEqual({ ok: false, code: 'NO_PROFILE' });
    });

    it('guest and Google-linked accounts queue alike', async () => {
      const [guest, linked] = await players(2);
      await sql`insert into auth.identities (user_id, provider) values (${linked!.userId}, 'google')`;
      expect((await rpc(linked!, 'init_profile')).profile.google_linked).toBe(true);
      expect(await enqueue(guest!)).toMatchObject({ ok: true, created: true });
      expect(await enqueue(linked!)).toMatchObject({ ok: true, created: true });
    });

    it('rejects a mode that does not exist', async () => {
      const [a] = await players(1);
      expect(await rpc(a!, 'matchmaking_enqueue', 'expert', null)).toEqual({ ok: false, code: 'VALIDATION' });
      expect(await rpc(a!, 'matchmaking_enqueue', null, null)).toEqual({ ok: false, code: 'VALIDATION' });
    });
  });

  // =========================================================================================
  describe('solo queue', () => {
    it('entering the queue creates one ticket, shown by the state', async () => {
      const [a] = await players(1);
      const res = await enqueue(a!, 'intermediate');
      expect(res).toMatchObject({ ok: true, created: true, ticket: { kind: 'solo', mode: 'intermediate', player_count: 1, status: 'QUEUED' } });
      const s = await state(a!);
      expect(s).toMatchObject({ ok: true, ticket: { id: res.ticket.id, status: 'QUEUED' }, match: null, party: null, game: null });
      expect(s.settings).toMatchObject({ ready_seconds: 20, prefer_target_seconds: 30, relax_seconds: 60, target_players: 4, min_players: 2, max_players: 8 });
    });

    it('a second request returns the same ticket; another mode is refused while queued', async () => {
      const [a] = await players(1);
      const first = await enqueue(a!, 'classic');
      const again = await enqueue(a!, 'classic');
      expect(again).toMatchObject({ ok: true, created: false, ticket: { id: first.ticket.id } });
      expect(await enqueue(a!, 'intermediate')).toMatchObject({ ok: false, code: 'ALREADY_QUEUED', ticket: { id: first.ticket.id, mode: 'classic' } });
      expect((await sql`select count(*)::int as n from public.matchmaking_ticket_members where user_id = ${a!.userId} and active`)[0]!.n).toBe(1);
    });

    it('twenty simultaneous requests from one account (two phones, a double tap) make one ticket', async () => {
      const [a] = await players(1);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => enqueue(a!, i % 2 ? 'classic' : 'intermediate', randomUUID())));
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
      const ids = new Set(results.filter((r) => r.ticket).map((r) => r.ticket.id));
      expect(ids.size).toBe(1);
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets where owner_user_id = ${a!.userId}`)[0]!.n).toBe(1);
    });

    it('cancel is the player’s own, idempotent, and a cancelled ticket is never matched', async () => {
      const [a, b, c, d] = await queueSolos(4);
      expect(await cancel(a!)).toEqual({ ok: true, cancelled: true, status: 'CANCELLED' });
      expect(await cancel(a!)).toEqual({ ok: true, cancelled: false, status: 'NONE' });
      expect((await ticketOf(a!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'CANCELLED_BY_PLAYER' });
      await tick();
      // Three are left: no table of four, nobody reserved, and certainly not the one who cancelled.
      for (const p of [a!, b!, c!, d!]) expect((await state(p)).match).toBeNull();
      expect((await ticketOf(b!))!.status).toBe('QUEUED');
      // Cancelling never touches someone else's ticket (there is no way to name one).
      expect((await ticketOf(c!))!.status).toBe('QUEUED');
    });

    it('a retry of a request whose ticket has ended does not start a new search', async () => {
      const [a] = await players(1);
      const key = randomUUID();
      expect(await enqueue(a!, 'classic', key)).toMatchObject({ ok: true, created: true });
      expect(await enqueue(a!, 'classic', key)).toMatchObject({ ok: true, created: false });
      await cancel(a!);
      expect(await enqueue(a!, 'classic', key)).toEqual({ ok: false, code: 'STALE_REQUEST' });
      expect(await enqueue(a!, 'classic', randomUUID())).toMatchObject({ ok: true, created: true });
    });

    it('a player at a private table cannot queue until they have left it', async () => {
      const [a] = await players(1);
      const table = await hostPrivateGame(a!);
      expect(await enqueue(a!)).toEqual({ ok: false, code: 'ALREADY_IN_GAME' });
      expect((await state(a!)).live_game).toMatchObject({ game_id: table.gameId, status: 'WAITING', matchmade: false });
      const [game] = await sql`select state_version from public.games where id = ${table.gameId}`;
      ok(await call({ op: 'action', gameId: table.gameId, playerId: table.seatId, token: table.token, actionId: randomUUID(), expectedVersion: game!.state_version, action: { type: 'LEAVE_GAME' } satisfies GameAction }));
      expect(await enqueue(a!)).toMatchObject({ ok: true, created: true });
    });

    it('taking a seat at a private table ends the search (the two are mutually exclusive)', async () => {
      const [a] = await queueSolos(1);
      const t = token();
      const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: 'Host' }));
      expect(await rpc(a!, 'claim_seat', created.gameId, created.playerId, t)).toEqual({ ok: true });
      expect((await ticketOf(a!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'JOINED_GAME' });
      expect((await state(a!)).last_result).toMatchObject({ status: 'CANCELLED', reason: 'JOINED_GAME' });
    });

    it('a private game code works exactly as before while other players are queueing', async () => {
      await queueSolos(3);
      const [host, guest] = await players(2);
      const table = await hostPrivateGame(host!);
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code: table.code, name: 'Guest' }));
      expect(await rpc(guest!, 'claim_seat', table.gameId, joined.playerId, t)).toEqual({ ok: true });
      await tick();
      const [game] = await sql`select status, matchmaking_match_id from public.games where id = ${table.gameId}`;
      expect(game).toMatchObject({ status: 'WAITING', matchmaking_match_id: null });
    });

    it('the queue can be closed for maintenance without a deploy', async () => {
      const [a] = await players(1);
      await setting('enabled', 0);
      expect(await enqueue(a!)).toEqual({ ok: false, code: 'MATCHMAKING_DISABLED' });
      expect((await state(a!)).settings.enabled).toBe(false);
    });
  });

  // =========================================================================================
  describe('grouping and reservation', () => {
    it('four solo players are reserved together at once, with a server deadline 20 s away', async () => {
      const four = await queueSolos(4);
      const before = Date.now();
      const report = await tick();
      expect(report.modes.find((m) => m.mode === 'classic')).toMatchObject({ candidates: 4, reserved: 1, refused: 0 });
      const s = await state(four[0]!);
      expect(s.ticket).toMatchObject({ status: 'RESERVED' });
      expect(s.match).toMatchObject({ mode: 'classic', status: 'READY_UP', player_count: 4 });
      expect(s.match.players).toHaveLength(4);
      expect(s.match.players.filter((p: Json) => p.is_me)).toHaveLength(1);
      expect(s.match.players.map((p: Json) => p.player_id).sort()).toEqual(four.map((p) => p.playerId).sort());
      const deadline = Date.parse(s.match.ready_deadline);
      expect(deadline - before).toBeGreaterThan(15_000);
      expect(deadline - before).toBeLessThan(25_000);
      // Everyone sees the same reservation.
      for (const p of four) expect((await state(p)).match.id).toBe(s.match.id);
    });

    it('two solo players wait, and play together once they have waited 30 s', async () => {
      const [a, b] = await queueSolos(2);
      await tick();
      expect((await state(a!)).match).toBeNull();
      await waitInQueue(31);
      await tick();
      expect((await state(a!)).match).toMatchObject({ player_count: 2 });
      expect((await state(b!)).match).toMatchObject({ player_count: 2 });
    });

    it('one player alone is never given a match', async () => {
      const [a] = await queueSolos(1);
      await waitInQueue(3600);
      await tick();
      expect((await state(a!)).match).toBeNull();
      expect((await ticketOf(a!))!.status).toBe('QUEUED');
      expect((await sql`select count(*)::int as n from public.matchmaking_matches`)[0]!.n).toBe(0);
    });

    it('Classic and Capital are separate queues', async () => {
      const classic = await queueSolos(2, 'classic');
      const intermediate = await queueSolos(2, 'intermediate');
      await tick();
      // Four players in all, but never four in one mode: nobody is matched.
      for (const p of [...classic, ...intermediate]) expect((await state(p)).match).toBeNull();
      await waitInQueue(31);
      await tick();
      const c = (await state(classic[0]!)).match;
      const i = (await state(intermediate[0]!)).match;
      expect(c).toMatchObject({ mode: 'classic', player_count: 2 });
      expect(i).toMatchObject({ mode: 'intermediate', player_count: 2 });
      expect(c.id).not.toBe(i.id);
      expect(c.players.map((p: Json) => p.player_id).sort()).toEqual(classic.map((p) => p.playerId).sort());
    });

    it('the thresholds are settings: changing a row changes the policy', async () => {
      const [a] = await queueSolos(2);
      await setting('prefer_target_seconds', 0);
      await tick();
      expect((await state(a!)).match).toMatchObject({ player_count: 2 });
    });

    it('the countdown length is a setting too', async () => {
      await setting('ready_seconds', 45);
      const four = await queueSolos(4);
      const before = Date.now();
      await tick();
      const deadline = Date.parse((await state(four[0]!)).match.ready_deadline);
      expect(deadline - before).toBeGreaterThan(40_000);
    });

    it('players with a block between them are not seated together', async () => {
      const [a, b, c, d] = await queueSolos(4);
      expect(await rpc(a!, 'block_player', b!.playerId)).toMatchObject({ ok: true });
      await tick();
      for (const p of [a!, b!, c!, d!]) expect((await state(p)).match).toBeNull();
      // Once they have waited, two tables form around the block.
      await waitInQueue(31);
      await tick();
      const ma = (await state(a!)).match;
      const mb = (await state(b!)).match;
      expect(ma.id).not.toBe(mb.id);
      expect(ma.players.map((p: Json) => p.player_id)).not.toContain(b!.playerId);
    });

    it('a proposal the database does not like is refused: wrong size, wrong mode, a ticket twice, a stale ticket', async () => {
      const [a, b] = await queueSolos(2);
      const [c] = await queueSolos(1, 'intermediate');
      const id = async (p: Player) => (await ticketOf(p))!.id as string;
      const reserve = async (mode: Mode, ids: string[]) => (await sql`select public.matchmaking_reserve(${mode}, ${ids}::uuid[]) as r`)[0]!.r as Json;
      expect(await reserve('classic', [await id(a!)])).toEqual({ ok: false, code: 'INVALID_SIZE' });
      expect(await reserve('classic', [await id(a!), await id(a!)])).toEqual({ ok: false, code: 'INVALID_GROUP' });
      expect(await reserve('classic', [await id(a!), await id(c!)])).toEqual({ ok: false, code: 'STALE' });
      expect(await reserve('classic', [])).toEqual({ ok: false, code: 'INVALID_GROUP' });
      const nine = await queueSolos(9);
      expect(await reserve('classic', await Promise.all(nine.map(id)))).toEqual({ ok: false, code: 'INVALID_SIZE' });
      await cancel(b!);
      expect(await reserve('classic', [await id(a!), await id(b!)])).toEqual({ ok: false, code: 'STALE' });
      expect((await sql`select count(*)::int as n from public.matchmaking_matches`)[0]!.n).toBe(0);
    });

    it('the database itself refuses a reservation of one or of nine players', async () => {
      await expect(sql`insert into public.matchmaking_matches (mode, player_count, ready_deadline) values ('classic', 1, now())`).rejects.toThrow(/check/);
      await expect(sql`insert into public.matchmaking_matches (mode, player_count, ready_deadline) values ('classic', 9, now())`).rejects.toThrow(/check/);
    });

    it('a ticket whose player has meanwhile sat down at a table is dropped when the matcher looks', async () => {
      const [a, b] = await queueSolos(2);
      // A seat tied to the account without going through claim_seat (as an older client's would not be).
      const t = token();
      const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: 'Host' }));
      await timeTravel((tx) => tx`update public.players set user_id = ${a!.userId} where id = ${created.playerId}`);
      await waitInQueue(31);
      await tick();
      expect((await ticketOf(a!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'IN_GAME' });
      expect((await ticketOf(b!))!.status).toBe('QUEUED');
    });

    it('a queue longer than one batch is worked through over several runs, oldest first', async () => {
      await setting('batch_size', 8);
      await setting('max_matches_per_run', 2);
      const many = await queueSolos(20);
      const first = await tick();
      expect(first.modes[0]).toMatchObject({ candidates: 8, reserved: 2 });
      // The eight oldest are the ones reserved.
      for (const p of many.slice(0, 8)) expect((await ticketOf(p))!.status).toBe('RESERVED');
      for (const p of many.slice(8)) expect((await ticketOf(p))!.status).toBe('QUEUED');
      await tick();
      await tick();
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets where status = 'RESERVED'`)[0]!.n).toBe(20);
    });

    it('matching runs at most once per interval per mode, whoever asks', async () => {
      await queueSolos(4);
      const first = await matchMode('classic', worker);
      const second = await matchMode('classic', worker);
      expect(first.reserved).toBe(1);
      expect(second.skipped).toBe('THROTTLED');
    });
  });

  // =========================================================================================
  describe('ready-up and game creation', () => {
    it('the whole flow: queue → reservation → everyone ready → one game, every player seated and able to play', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      const tokens = await readyAll(four.slice(0, 3), matchId);
      // Three of four: still counting down, no game.
      await tick();
      expect((await matchRow(matchId)).status).toBe('READY_UP');
      expect((await state(four[0]!)).match.players.filter((p: Json) => p.ready)).toHaveLength(3);
      const last = token();
      tokens.set(four[3]!.userId, last);
      expect(await rpc(four[3]!, 'matchmaking_ready', matchId, last)).toEqual({ ok: true, status: 'STARTING', all_ready: true });
      // The server has not started it yet: the app is told "starting", not "started".
      expect((await state(four[0]!)).match).toMatchObject({ status: 'STARTING' });

      const report = await tick();
      expect(report.started).toBe(1);
      const match = await matchRow(matchId);
      expect(match).toMatchObject({ status: 'STARTED' });
      const [game] = await sql`select * from public.games where id = ${match.game_id}`;
      expect(game).toMatchObject({ status: 'ACTIVE', game_mode: 'classic', matchmaking_match_id: matchId, host_player_id: null });
      expect(game!.config).toEqual(defaultGameConfig('classic'));

      const seats = await sql`select * from public.players where game_id = ${match.game_id} order by seat`;
      expect(seats).toHaveLength(4);
      expect(new Set(seats.map((s) => s.seat)).size).toBe(4);
      expect(seats.map((s) => s.user_id).sort()).toEqual(four.map((p) => p.userId).sort());
      expect(seats.every((s) => !s.is_host && s.status === 'ACTIVE' && Number(s.balance) === defaultGameConfig('classic').startingCash)).toBe(true);
      expect(new Set(seats.map((s) => s.name.toLowerCase())).size).toBe(4);

      // Each player finds their own seat, and their own phone's token opens it — nobody else's does.
      for (const p of four) {
        const s = await state(p);
        expect(s).toMatchObject({ ticket: null, match: null, game: { match_id: matchId, game_id: match.game_id, mode: 'classic' } });
        const seat = seats.find((x) => x.user_id === p.userId)!;
        expect(s.game.seat_id).toBe(seat.id);
        const snap = ok(await call({ op: 'state', gameId: match.game_id, playerId: seat.id, token: tokens.get(p.userId) }));
        expect(snap.snapshot.state.status).toBe('ACTIVE');
        expect(snap.snapshot.state.hostPlayerId).toBeNull();
        const other = four.find((o) => o.userId !== p.userId)!;
        expect(await call({ op: 'state', gameId: match.game_id, playerId: seat.id, token: tokens.get(other.userId) })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      expect((await sql`select status from public.matchmaking_tickets where match_id = ${matchId}`).every((t) => t.status === 'MATCHED')).toBe(true);
      expect((await sql`select * from public.verify_game_ledger(${match.game_id})`).every((r) => r.ok)).toBe(true);

      // The game is an ordinary game: the player whose turn it is rolls, through the referee.
      const current = seats.find((s) => s.id === game!.current_player_id)!;
      const rolled = ok(await call({ op: 'action', gameId: match.game_id, playerId: current.id, token: tokens.get(current.user_id), actionId: randomUUID(), expectedVersion: game!.state_version, action: { type: 'ROLL_DICE' } satisfies GameAction }));
      expect(rolled.snapshot.state.turn.hasRolled).toBe(true);
      // Nobody can end it for the others: there is no host.
      const ended = await call({ op: 'action', gameId: match.game_id, playerId: current.id, token: tokens.get(current.user_id), actionId: randomUUID(), expectedVersion: rolled.snapshot.state.version, action: { type: 'END_GAME' } satisfies GameAction });
      expect(ended).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      // And nobody can join it.
      expect(await call({ op: 'join', actionId: randomUUID(), token: token(), code: game!.code, name: 'Late' })).toMatchObject({ ok: false });
    });

    it('a Capital match starts a Capital game with that mode’s public settings', async () => {
      const two = await players(2);
      const { gameId } = await playMatch(two, 'intermediate');
      const [game] = await sql`select * from public.games where id = ${gameId}`;
      expect(game).toMatchObject({ status: 'ACTIVE', game_mode: 'intermediate' });
      expect(game!.config).toEqual(defaultGameConfig('intermediate'));
      expect(game!.intermediate).not.toBeNull();
      expect((await sql`select count(*)::int as n from public.player_objectives where game_id = ${gameId}`)[0]!.n).toBe(2);
    });

    it('the start is idempotent: a second tick, or five workers at once, still make one game', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => startMatch(matchId, worker)));
      expect(outcomes.filter((o) => o.started)).toHaveLength(1);
      await tick();
      await tick();
      expect((await sql`select count(*)::int as n from public.games where matchmaking_match_id = ${matchId}`)[0]!.n).toBe(1);
      const match = await matchRow(matchId);
      expect((await sql`select count(*)::int as n from public.players where game_id = ${match.game_id}`)[0]!.n).toBe(4);
    });

    it('a second game for the same reservation cannot be stored', async () => {
      const two = await players(2);
      const { matchId } = await playMatch(two);
      const created = ok(await call({ op: 'create', actionId: randomUUID(), token: token(), name: 'Host' }));
      await expect(sql`update public.games set matchmaking_match_id = ${matchId} where id = ${created.gameId}`).rejects.toThrow(/games_matchmaking_match_idx/);
    });

    it('only a player of the reservation can confirm, only for themselves, and repeating it is harmless', async () => {
      const four = await queueSolos(4);
      const [outsider] = await players(1);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      expect(await rpc(outsider!, 'matchmaking_ready', matchId, token())).toEqual({ ok: false, code: 'MATCH_GONE' });
      expect(await rpc(outsider!, 'matchmaking_decline', matchId)).toEqual({ ok: false, code: 'MATCH_GONE' });
      expect(await rpc(four[0]!, 'matchmaking_ready', matchId, 'not-a-token')).toEqual({ ok: false, code: 'VALIDATION' });
      const t = token();
      for (let i = 0; i < 3; i += 1) expect(await rpc(four[0]!, 'matchmaking_ready', matchId, t)).toEqual({ ok: true, status: 'READY_UP', all_ready: false });
      const rows = await sql`select user_id, ready_at from public.matchmaking_match_players where match_id = ${matchId}`;
      expect(rows.filter((r) => r.ready_at !== null).map((r) => r.user_id)).toEqual([four[0]!.userId]);
      // The outsider sees nothing of it.
      expect(await state(outsider!)).toMatchObject({ match: null, ticket: null });
    });

    it('until everyone is ready the last phone to confirm holds the seat; afterwards another phone is told so', async () => {
      const two = await players(2);
      for (const p of two) await enqueue(p);
      await waitInQueue(31);
      await tick();
      const matchId = (await matchIdOf(two[0]!))!;
      const phoneA = token();
      const phoneB = token();
      expect(await rpc(two[0]!, 'matchmaking_ready', matchId, phoneA)).toMatchObject({ ok: true });
      expect(await rpc(two[0]!, 'matchmaking_ready', matchId, phoneB)).toMatchObject({ ok: true });
      expect(await rpc(two[1]!, 'matchmaking_ready', matchId, token())).toMatchObject({ ok: true, all_ready: true });
      expect(await rpc(two[0]!, 'matchmaking_ready', matchId, phoneA)).toEqual({ ok: false, code: 'SEAT_ON_OTHER_DEVICE' });
      expect(await rpc(two[0]!, 'matchmaking_ready', matchId, phoneB)).toMatchObject({ ok: true, all_ready: true });
      await tick();
      const game = (await state(two[0]!)).game;
      expect(await call({ op: 'state', gameId: game.game_id, playerId: game.seat_id, token: phoneB })).toMatchObject({ ok: true });
      expect(await call({ op: 'state', gameId: game.game_id, playerId: game.seat_id, token: phoneA })).toMatchObject({ ok: false });
    });

    it('a client cannot move the deadline, the mode or the size of a reservation — and neither can a bug', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await expect(sql`update public.matchmaking_matches set ready_deadline = now() + interval '1 hour' where id = ${matchId}`).rejects.toThrow(/fixed/);
      await expect(sql`update public.matchmaking_matches set mode = 'intermediate' where id = ${matchId}`).rejects.toThrow(/fixed/);
      await expect(sql`update public.matchmaking_matches set status = 'STARTED' where id = ${matchId}`).rejects.toThrow(/cannot go from/);
      await expect(sql`update public.matchmaking_tickets set mode = 'intermediate' where match_id = ${matchId}`).rejects.toThrow(/fixed/);
      await expect(sql`update public.matchmaking_tickets set status = 'EXPIRED' where match_id = ${matchId}`).rejects.toThrow(/cannot go from/);
    });

    it('a finished ticket is never reused: every state after the last is refused', async () => {
      const two = await players(2);
      await playMatch(two);
      const ticket = (await ticketOf(two[0]!))!;
      expect(ticket.status).toBe('MATCHED');
      for (const status of ['QUEUED', 'RESERVED', 'CANCELLED']) {
        await expect(sql`update public.matchmaking_tickets set status = ${status} where id = ${ticket.id}`, status).rejects.toThrow(/cannot go from|check/);
      }
      const [a] = await queueSolos(1);
      await cancel(a!);
      await expect(sql`update public.matchmaking_tickets set status = 'QUEUED' where id = ${(await ticketOf(a!))!.id}`).rejects.toThrow(/cannot go from/);
    });

    it('a player in a committed match cannot queue again, and finds the same seat after a restart', async () => {
      const two = await players(2);
      const { gameId, tokens } = await playMatch(two);
      expect(await enqueue(two[0]!)).toEqual({ ok: false, code: 'ALREADY_IN_GAME' });
      expect(await rpc(two[0]!, 'party_create', 'classic')).toMatchObject({ ok: true });
      expect(await enqueue(two[0]!, null)).toEqual({ ok: false, code: 'ALREADY_IN_GAME' });
      // "Restart": nothing but the account and the stored token. The server names the game and the seat.
      const s = await state(two[0]!);
      expect(s.live_game).toMatchObject({ game_id: gameId, matchmade: true });
      expect(await call({ op: 'state', gameId: s.game.game_id, playerId: s.game.seat_id, token: tokens.get(two[0]!.userId) })).toMatchObject({ ok: true });
      expect((await sql`select count(*)::int as n from public.players where game_id = ${gameId}`)[0]!.n).toBe(2);
    });

    it('nicknames the game would refuse — identical, or with symbols — still get every player a seat', async () => {
      const three = await players(3);
      await sql`update public.profiles set nickname = 'Same Name' where user_id = any(${three.slice(0, 2).map((p) => p.userId)}::uuid[])`;
      await timeTravel((tx) => tx`update public.profiles set nickname = '🔥🔥🔥' where user_id = ${three[2]!.userId}`);
      const { gameId } = await playMatch(three);
      const names = (await sql`select name from public.players where game_id = ${gameId} order by name`).map((r) => r.name);
      expect(names).toEqual(['Player', 'Same Name', 'Same Name 2']);
    });

    it('the state shows only public profiles: no account id, no token, of anyone else', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(1), matchId);
      const text = JSON.stringify(await state(four[0]!));
      for (const other of four.slice(1)) expect(text).not.toContain(other.userId);
      expect(text).not.toMatch(/token/);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    });
  });

  // =========================================================================================
  describe('missed ready-up, declining and cooldown', () => {
    it('one player never confirms: no game; they leave the queue with a cooldown; the others are queued again with their place', async () => {
      const four = await queueSolos(4);
      const queuedAt = new Map<string, string>();
      for (const p of four) queuedAt.set(p.userId, String((await ticketOf(p))!.queued_at));
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(0, 3), matchId);
      // Before the deadline nothing happens, however often the worker looks.
      await tick();
      expect((await matchRow(matchId)).status).toBe('READY_UP');

      await passReadyDeadline(matchId);
      const report = await runTick(worker);
      expect(report.sweep).toMatchObject({ ready_timeouts: 1 });
      expect(await matchRow(matchId)).toMatchObject({ status: 'CANCELLED', close_reason: 'READY_TIMEOUT', game_id: null });
      expect((await sql`select count(*)::int as n from public.games where matchmaking_match_id = ${matchId}`)[0]!.n).toBe(0);

      expect((await ticketOf(four[3]!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'READY_TIMEOUT' });
      expect((await state(four[3]!)).last_result).toMatchObject({ status: 'CANCELLED', reason: 'READY_TIMEOUT' });
      const cooled = await enqueue(four[3]!);
      expect(cooled).toMatchObject({ ok: false, code: 'COOLDOWN' });
      expect(cooled.retry_after_seconds).toBeGreaterThan(0);
      expect(cooled.retry_after_seconds).toBeLessThanOrEqual(30);
      expect((await state(four[3]!)).cooldown_seconds).toBeGreaterThan(0);

      for (const p of four.slice(0, 3)) {
        const t = (await ticketOf(p))!;
        expect(t).toMatchObject({ status: 'QUEUED', match_id: null, requeue_count: 1 });
        expect(String(t.queued_at)).toBe(queuedAt.get(p.userId));
        expect((await state(p)).cooldown_seconds).toBe(0);
      }
      // The three who were ready are matched again as soon as the policy allows.
      await waitInQueue(31);
      await tick();
      const again = (await state(four[0]!)).match;
      expect(again).toMatchObject({ player_count: 3, status: 'READY_UP' });
      expect(again.id).not.toBe(matchId);
      expect(again.players.every((p: Json) => !p.ready)).toBe(true);
    });

    it('several players never confirm: each of them is out, the rest are queued again', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(0, 1), matchId);
      await passReadyDeadline(matchId);
      await tick();
      expect((await ticketOf(four[0]!))!.status).toBe('QUEUED');
      for (const p of four.slice(1)) expect((await ticketOf(p))!).toMatchObject({ status: 'CANCELLED', close_reason: 'READY_TIMEOUT' });
    });

    it('a confirmation after the deadline is refused, whatever the phone thought the time was', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await passReadyDeadline(matchId);
      expect(await rpc(four[0]!, 'matchmaking_ready', matchId, token())).toEqual({ ok: false, code: 'READY_TIMEOUT' });
      await tick();
      expect(await rpc(four[0]!, 'matchmaking_ready', matchId, token())).toEqual({ ok: false, code: 'MATCH_GONE' });
    });

    it('the deadline passing while the worker was away is handled by the next run, once', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await passReadyDeadline(matchId);
      const sweeps = await Promise.all(Array.from({ length: 4 }, () => sql`select public.matchmaking_sweep() as r`));
      expect(sweeps.reduce((n, s) => n + Number((s[0]!.r as Json).ready_timeouts), 0)).toBe(1);
      expect((await sql`select strikes from public.matchmaking_cooldowns where user_id = ${four[0]!.userId}`)[0]!.strikes).toBe(1);
    });

    it('the last confirmation racing the timeout ends one way or the other, never both', async () => {
      for (let round = 0; round < 6; round += 1) {
        const two = await players(2);
        for (const p of two) await enqueue(p);
        await waitInQueue(31);
        await tick();
        const matchId = (await matchIdOf(two[0]!))!;
        await rpc(two[0]!, 'matchmaking_ready', matchId, token());
        // A deadline a few milliseconds away: the confirmation and the sweep arrive around it together.
        await timeTravel((tx) => tx`update public.matchmaking_matches set ready_deadline = now() + interval '15 milliseconds' where id = ${matchId}`);
        const [ready] = await Promise.all([
          rpc(two[1]!, 'matchmaking_ready', matchId, token()),
          new Promise((r) => setTimeout(r, 10 + round * 3)).then(() => sql`select public.matchmaking_sweep()`),
        ]);
        await passReadyDeadline(matchId).catch(() => undefined);
        await tick();
        const match = await matchRow(matchId);
        if (ready.ok) {
          expect(match.status, `round ${round}`).toBe('STARTED');
          expect((await ticketOf(two[1]!))!.status).toBe('MATCHED');
        } else {
          expect(ready.code).toMatch(/READY_TIMEOUT|MATCH_GONE/);
          expect(match.status, `round ${round}`).toBe('CANCELLED');
          expect(match.game_id).toBeNull();
          expect((await ticketOf(two[1]!))!.status).toBe('CANCELLED');
          expect((await ticketOf(two[0]!))!.status).toBe('QUEUED');
        }
        await sql`delete from public.matchmaking_tickets`;
        await sql`delete from public.matchmaking_matches`;
      }
    });

    it('declining ends the reservation at once: the decliner pauses, everyone else searches on', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(1), matchId);
      expect(await rpc(four[0]!, 'matchmaking_decline', matchId)).toEqual({ ok: true });
      expect(await rpc(four[0]!, 'matchmaking_decline', matchId)).toEqual({ ok: true });
      expect(await matchRow(matchId)).toMatchObject({ status: 'CANCELLED', close_reason: 'DECLINED' });
      expect((await ticketOf(four[0]!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'DECLINED' });
      expect(await enqueue(four[0]!)).toMatchObject({ ok: false, code: 'COOLDOWN' });
      for (const p of four.slice(1)) expect((await ticketOf(p))!.status).toBe('QUEUED');
      expect((await sql`select strikes from public.matchmaking_cooldowns where user_id = ${four[0]!.userId}`)[0]!.strikes).toBe(1);
    });

    it('once everyone is ready it is too late to decline or to cancel', async () => {
      const two = await players(2);
      for (const p of two) await enqueue(p);
      await waitInQueue(31);
      await tick();
      const matchId = (await matchIdOf(two[0]!))!;
      expect(await cancel(two[0]!)).toEqual({ ok: true, cancelled: false, status: 'RESERVED', match_id: matchId });
      await readyAll(two, matchId);
      expect(await rpc(two[0]!, 'matchmaking_decline', matchId)).toEqual({ ok: false, code: 'TOO_LATE' });
      expect(await cancel(two[0]!)).toMatchObject({ cancelled: false, status: 'RESERVED' });
      await tick();
      expect((await matchRow(matchId)).status).toBe('STARTED');
    });

    it('the cooldown grows with repeated misses, is capped, and is not a ban', async () => {
      const [a] = await players(1);
      const left = async () => (await sql`select public.matchmaking_cooldown_left(${a!.userId}) as s`)[0]!.s as number;
      await sql`select public.matchmaking_strike(${a!.userId})`;
      expect(await left()).toBeLessThanOrEqual(30);
      await sql`select public.matchmaking_strike(${a!.userId})`;
      expect(await left()).toBeGreaterThan(30);
      expect(await left()).toBeLessThanOrEqual(60);
      for (let i = 0; i < 8; i += 1) await sql`select public.matchmaking_strike(${a!.userId})`;
      expect(await left()).toBeLessThanOrEqual(300);
      // Time passes: the player queues again, and the count starts over.
      await sql`update public.matchmaking_cooldowns set blocked_until = now() - interval '1 second', last_strike_at = now() - interval '1 hour' where user_id = ${a!.userId}`;
      expect(await enqueue(a!)).toMatchObject({ ok: true, created: true });
      await sql`select public.matchmaking_strike(${a!.userId})`;
      expect((await sql`select strikes from public.matchmaking_cooldowns where user_id = ${a!.userId}`)[0]!.strikes).toBe(1);
    });
  });

  // =========================================================================================
  describe('races and concurrent workers', () => {
    it('cancel against the matcher: the player is told what really happened, and it is one or the other', async () => {
      let cancelled = 0;
      let reserved = 0;
      for (let round = 0; round < 12; round += 1) {
        const four = await queueSolos(4);
        const [answer] = await Promise.all([
          new Promise((r) => setTimeout(r, round % 4)).then(() => cancel(four[0]!)),
          matchMode('classic', worker, true),
        ]);
        const ticket = (await ticketOf(four[0]!))!;
        if (answer.cancelled) {
          cancelled += 1;
          expect(ticket.status).toBe('CANCELLED');
          expect((await sql`select count(*)::int as n from public.matchmaking_match_players where user_id = ${four[0]!.userId}`)[0]!.n).toBe(0);
          for (const p of four.slice(1)) expect((await ticketOf(p))!.status).toBe('QUEUED');
        } else {
          reserved += 1;
          expect(answer).toMatchObject({ status: 'RESERVED' });
          expect(ticket.status).toBe('RESERVED');
          expect((await state(four[0]!)).match).toMatchObject({ player_count: 4 });
        }
        await sql`delete from public.matchmaking_tickets`;
        await sql`delete from public.matchmaking_matches`;
      }
      expect(cancelled + reserved).toBe(12);
    });

    it('eight workers over one queue of sixty: nobody is reserved twice, every table is valid, nobody vanishes', async () => {
      const crowd = await queueSolos(60);
      await waitInQueue(45);
      for (let wave = 0; wave < 4; wave += 1) {
        const reports = await Promise.all(Array.from({ length: 8 }, () => matchMode('classic', worker, true)));
        // One worker at a time holds a mode; the others step aside without doing anything.
        expect(reports.filter((r) => !r.skipped).length).toBeLessThanOrEqual(1);
        expect(reports.every((r) => !r.error)).toBe(true);
      }
      const seats = await sql`select user_id, match_id from public.matchmaking_match_players`;
      expect(new Set(seats.map((s) => s.user_id)).size).toBe(seats.length);
      const matches = await sql`select m.id, m.player_count, (select count(*)::int from public.matchmaking_match_players p where p.match_id = m.id) as seated from public.matchmaking_matches m`;
      for (const m of matches) {
        expect(m.player_count).toBeGreaterThanOrEqual(2);
        expect(m.player_count).toBeLessThanOrEqual(8);
        expect(m.seated).toBe(m.player_count);
      }
      const tickets = await sql`select status, match_id from public.matchmaking_tickets where owner_user_id = any(${crowd.map((p) => p.userId)}::uuid[])`;
      expect(tickets).toHaveLength(60);
      expect(tickets.every((t) => (t.status === 'RESERVED' && t.match_id) || (t.status === 'QUEUED' && !t.match_id))).toBe(true);
      expect(tickets.filter((t) => t.status === 'RESERVED')).toHaveLength(60);
    });

    it('two workers holding overlapping batches: the second skips what the first has locked', async () => {
      const eight = await queueSolos(8);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      // Worker one takes the four oldest tickets and stops, mid-transaction.
      const first = sql.begin(async (tx) => {
        const ids = (await tx`select t.id from public.matchmaking_tickets t where t.status = 'QUEUED' order by t.queued_at, t.id limit 4 for update skip locked`).map((r) => r.id as string);
        locked();
        await held;
        return (await tx`select public.matchmaking_reserve('classic', ${ids}::uuid[]) as r`)[0]!.r as Json;
      });
      await isLocked;
      // Worker two runs a whole pass meanwhile: it can only see, and reserve, the other four.
      const second = await sql.begin(async (tx) => {
        const ids = (await tx`select t.id from public.matchmaking_tickets t where t.status = 'QUEUED' order by t.queued_at, t.id limit 8 for update skip locked`).map((r) => r.id as string);
        expect(ids).toHaveLength(4);
        return (await tx`select public.matchmaking_reserve('classic', ${ids}::uuid[]) as r`)[0]!.r as Json;
      });
      release();
      const firstResult = await first;
      expect(firstResult.ok && second.ok).toBe(true);
      expect(firstResult.match_id).not.toBe(second.match_id);
      const seats = await sql`select user_id from public.matchmaking_match_players`;
      expect(new Set(seats.map((s) => s.user_id)).size).toBe(8);
      expect(seats).toHaveLength(eight.length);
    });

    it('queueing, cancelling and matching all at once leave every ticket in a defined state', async () => {
      const crowd = await players(30);
      await setting('prefer_target_seconds', 0);
      await Promise.all([
        ...crowd.map((p) => enqueue(p)),
        ...crowd.filter((_, i) => i % 3 === 0).map((p) => new Promise((r) => setTimeout(r, 5)).then(() => cancel(p))),
        ...Array.from({ length: 6 }, (_, i) => new Promise((r) => setTimeout(r, i * 4)).then(() => matchMode('classic', worker, true))),
      ]);
      await tick();
      const rows = await sql`
        select m.user_id, t.status, t.match_id, m.active
        from public.matchmaking_ticket_members m join public.matchmaking_tickets t on t.id = m.ticket_id`;
      for (const r of rows) {
        expect(['QUEUED', 'RESERVED', 'CANCELLED']).toContain(r.status);
        expect(r.active).toBe(r.status !== 'CANCELLED');
        if (r.status === 'RESERVED') expect(r.match_id).not.toBeNull();
      }
      const active = rows.filter((r) => r.active).map((r) => r.user_id);
      expect(new Set(active).size).toBe(active.length);
      const seats = await sql`select user_id from public.matchmaking_match_players where active`;
      expect(new Set(seats.map((s) => s.user_id)).size).toBe(seats.length);
    });
  });

  // =========================================================================================
  describe('parties', () => {
    it('a party is formed by invitation between friends, and each member confirms for themselves', async () => {
      const [leader, friend, stranger] = await players(3);
      expect(await rpc(leader!, 'party_create', 'intermediate')).toMatchObject({ ok: true, created: true });
      expect(await rpc(leader!, 'party_create', 'classic')).toMatchObject({ ok: true, created: false });
      expect(await rpc(leader!, 'party_invite', stranger!.playerId)).toEqual({ ok: false, code: 'NOT_FRIENDS' });
      expect(await rpc(leader!, 'party_invite', leader!.playerId)).toEqual({ ok: false, code: 'SELF' });
      expect(await rpc(leader!, 'party_invite', 'nonsense')).toEqual({ ok: false, code: 'INVALID_PLAYER_ID' });
      await befriend(leader!, friend!);
      const invited = await rpc(leader!, 'party_invite', friend!.playerId);
      expect(invited).toMatchObject({ ok: true, created: true });
      // The same invitation again is the same invitation.
      expect(await rpc(leader!, 'party_invite', friend!.playerId)).toMatchObject({ ok: true, created: false, invite_id: invited.invite_id });
      expect((await sql`select count(*)::int as n from public.party_invitations where recipient_user_id = ${friend!.userId}`)[0]!.n).toBe(1);

      // An invitation queues nobody and joins nobody.
      const before = await state(friend!);
      expect(before).toMatchObject({ party: null, ticket: null });
      expect(before.party_invites).toHaveLength(1);
      expect(before.party_invites[0]).toMatchObject({ id: invited.invite_id, mode: 'intermediate', size: 1, inviter: { player_id: leader!.playerId } });
      // It is not a game invitation: the Friends screen's list of those is untouched.
      expect((await rpc(friend!, 'social_state')).invites).toEqual([]);
      // Nobody else can answer it.
      expect(await rpc(stranger!, 'party_respond_invite', invited.invite_id, true)).toEqual({ ok: false, code: 'INVITE_GONE' });

      expect(await rpc(friend!, 'party_respond_invite', invited.invite_id, true)).toMatchObject({ ok: true, joined: true });
      expect(await rpc(friend!, 'party_respond_invite', invited.invite_id, true)).toMatchObject({ ok: true, joined: true });
      const s = await state(leader!);
      expect(s.party).toMatchObject({ mode: 'intermediate', is_leader: true, locked: false });
      expect(s.party.members).toEqual([
        expect.objectContaining({ player_id: leader!.playerId, is_leader: true, is_me: true, ready: true }),
        expect.objectContaining({ player_id: friend!.playerId, is_leader: false, is_me: false, ready: false }),
      ]);
      expect(s.ticket).toBeNull();

      // The leader cannot queue for a member who has not confirmed; a member cannot start the queue.
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'PARTY_NOT_READY' });
      expect(await enqueue(friend!, null)).toEqual({ ok: false, code: 'NOT_LEADER' });
      expect(await rpc(friend!, 'party_set_ready', true)).toEqual({ ok: true, ready: true });
      expect(await enqueue(leader!, 'classic')).toEqual({ ok: false, code: 'PARTY_MODE_MISMATCH' });
      const queued = await enqueue(leader!, null);
      expect(queued).toMatchObject({ ok: true, created: true, ticket: { kind: 'party', mode: 'intermediate', player_count: 2 } });
      // One ticket for the whole party, seen by both.
      expect((await state(friend!)).ticket).toMatchObject({ id: queued.ticket.id });
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets where party_id is not null and status = 'QUEUED'`)[0]!.n).toBe(1);
    });

    it('declined, revoked and expired invitations let nobody in', async () => {
      const [leader, a, b, c] = await players(4);
      await rpc(leader!, 'party_create', 'classic');
      for (const p of [a!, b!, c!]) await befriend(leader!, p);
      const ia = await rpc(leader!, 'party_invite', a!.playerId);
      const ib = await rpc(leader!, 'party_invite', b!.playerId);
      const ic = await rpc(leader!, 'party_invite', c!.playerId);
      expect(await rpc(a!, 'party_respond_invite', ia.invite_id, false)).toMatchObject({ ok: true, joined: false });
      expect(await rpc(a!, 'party_respond_invite', ia.invite_id, true)).toEqual({ ok: false, code: 'INVITE_GONE' });
      expect(await rpc(a!, 'party_revoke_invite', ib.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });
      expect(await rpc(leader!, 'party_revoke_invite', ib.invite_id)).toEqual({ ok: true });
      expect(await rpc(b!, 'party_respond_invite', ib.invite_id, true)).toEqual({ ok: false, code: 'INVITE_GONE' });
      await sql`update public.party_invitations set expires_at = now() - interval '1 second' where id = ${ic.invite_id}`;
      expect((await state(c!)).party_invites).toEqual([]);
      expect(await rpc(c!, 'party_respond_invite', ic.invite_id, true)).toEqual({ ok: false, code: 'INVITE_EXPIRED' });
      expect((await state(leader!)).party.members).toHaveLength(1);
      // The invitation lasts fifteen minutes by default.
      const fresh = await rpc(leader!, 'party_invite', a!.playerId);
      const ttl = Date.parse(fresh.expires_at) - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThan(16 * 60_000);
    });

    it('a blocked player cannot be invited, and an invitation does not survive a block', async () => {
      const [leader, a, b] = await players(3);
      await rpc(leader!, 'party_create', 'classic');
      await befriend(leader!, a!);
      await befriend(leader!, b!);
      const invited = await rpc(leader!, 'party_invite', a!.playerId);
      expect(await rpc(a!, 'block_player', leader!.playerId)).toMatchObject({ ok: true });
      expect((await state(a!)).party_invites).toEqual([]);
      expect(await rpc(a!, 'party_respond_invite', invited.invite_id, true)).toEqual({ ok: false, code: 'INVITE_GONE' });
      expect(await rpc(leader!, 'party_invite', a!.playerId)).toEqual({ ok: false, code: 'UNAVAILABLE' });
      expect(await rpc(leader!, 'block_player', b!.playerId)).toMatchObject({ ok: true });
      expect(await rpc(leader!, 'party_invite', b!.playerId)).toEqual({ ok: false, code: 'BLOCKED_BY_YOU' });
    });

    it('a player is in one party at a time, even when two invitations are accepted at the same instant', async () => {
      const [l1, l2, guest] = await players(3);
      await rpc(l1!, 'party_create', 'classic');
      await rpc(l2!, 'party_create', 'classic');
      await befriend(l1!, guest!);
      await befriend(l2!, guest!);
      const i1 = await rpc(l1!, 'party_invite', guest!.playerId);
      const i2 = await rpc(l2!, 'party_invite', guest!.playerId);
      const answers = await Promise.all([rpc(guest!, 'party_respond_invite', i1.invite_id, true), rpc(guest!, 'party_respond_invite', i2.invite_id, true)]);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.find((a) => !a.ok)).toEqual({ ok: false, code: 'ALREADY_IN_PARTY' });
      expect((await sql`select count(*)::int as n from public.party_members where user_id = ${guest!.userId}`)[0]!.n).toBe(1);
      // A leader of one party cannot accept into another either.
      await befriend(l1!, l2!);
      const cross = await rpc(l1!, 'party_invite', l2!.playerId);
      expect(await rpc(l2!, 'party_respond_invite', cross.invite_id, true)).toEqual({ ok: false, code: 'ALREADY_IN_PARTY' });
    });

    it('a party holds at most eight, counting invitations still open', async () => {
      const members = await party(8);
      const [extra] = await players(1);
      await befriend(members[0]!, extra!);
      expect(await rpc(members[0]!, 'party_invite', extra!.playerId)).toEqual({ ok: false, code: 'PARTY_FULL' });
      expect((await state(members[0]!)).party.members).toHaveLength(8);
      // Two acceptances for the last place: one gets it.
      const seven = await party(7);
      const [x, y] = await players(2);
      await befriend(seven[0]!, x!);
      const ix = await rpc(seven[0]!, 'party_invite', x!.playerId);
      // Squeeze a second live invitation in underneath the count, as two leaders' phones could not — only to race the accept.
      await befriend(seven[0]!, y!);
      const [iy] = await sql`insert into public.party_invitations (party_id, inviter_user_id, recipient_user_id, expires_at)
        select party_id, ${seven[0]!.userId}, ${y!.userId}, now() + interval '5 minutes' from public.party_members where user_id = ${seven[0]!.userId} returning id`;
      const answers = await Promise.all([rpc(x!, 'party_respond_invite', ix.invite_id, true), rpc(y!, 'party_respond_invite', iy!.id, true)]);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.find((a) => !a.ok)).toEqual({ ok: false, code: 'PARTY_FULL' });
      expect((await state(seven[0]!)).party.members).toHaveLength(8);
    });

    it('readiness is asked again when the mode or the members change', async () => {
      const [leader, a, b] = await party(3, 'classic');
      const readyOf = async () => ((await state(leader!)).party.members as Json[]).map((m) => m.ready);
      expect(await readyOf()).toEqual([true, true, true]);
      expect(await rpc(a!, 'party_set_mode', 'intermediate')).toEqual({ ok: false, code: 'NOT_LEADER' });
      expect(await rpc(leader!, 'party_set_mode', 'intermediate')).toEqual({ ok: true, mode: 'intermediate' });
      expect(await readyOf()).toEqual([true, false, false]);
      await rpc(a!, 'party_set_ready', true);
      await rpc(b!, 'party_set_ready', true);
      // Setting the same mode again changes nothing.
      await rpc(leader!, 'party_set_mode', 'intermediate');
      expect(await readyOf()).toEqual([true, true, true]);
      // A member changes their mind.
      await rpc(b!, 'party_set_ready', false);
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'PARTY_NOT_READY' });
      await rpc(b!, 'party_set_ready', true);
      // Someone leaves: the others confirm again.
      expect(await rpc(b!, 'party_leave')).toEqual({ ok: true, left: true });
      expect(await readyOf()).toEqual([true, false]);
      // Someone joins: the same.
      await rpc(a!, 'party_set_ready', true);
      const [c] = await players(1);
      await befriend(leader!, c!);
      const invited = await rpc(leader!, 'party_invite', c!.playerId);
      await rpc(c!, 'party_respond_invite', invited.invite_id, true);
      expect(await readyOf()).toEqual([true, false, false]);
    });

    it('queueing locks the party: nobody joins, the mode stays, readiness stays, until the leader cancels', async () => {
      const [leader, a] = await party(2);
      const [late] = await players(1);
      await befriend(leader!, late!);
      const invited = await rpc(leader!, 'party_invite', late!.playerId);
      expect(await enqueue(leader!, null)).toMatchObject({ ok: true, created: true });
      expect((await state(a!)).party).toMatchObject({ locked: true });

      expect(await rpc(late!, 'party_respond_invite', invited.invite_id, true)).toEqual({ ok: false, code: 'PARTY_LOCKED' });
      expect(await rpc(leader!, 'party_invite', late!.playerId)).toEqual({ ok: false, code: 'PARTY_LOCKED' });
      expect(await rpc(leader!, 'party_set_mode', 'intermediate')).toEqual({ ok: false, code: 'PARTY_LOCKED' });
      expect(await rpc(a!, 'party_set_ready', false)).toEqual({ ok: false, code: 'PARTY_LOCKED' });
      expect(await rpc(leader!, 'party_kick', a!.playerId)).toEqual({ ok: false, code: 'PARTY_LOCKED' });
      // A member cannot queue alone while the party is queued: they get the party's ticket back.
      const mine = await enqueue(a!, 'classic');
      expect(mine).toMatchObject({ ok: true, created: false, ticket: { kind: 'party', player_count: 2 } });
      expect(await enqueue(a!, 'intermediate')).toMatchObject({ ok: false, code: 'ALREADY_QUEUED' });
      // Starting twice, from two phones at once, is one ticket.
      const twice = await Promise.all([enqueue(leader!, null), enqueue(leader!, null), enqueue(a!, null)]);
      expect(twice.every((r) => r.ok && !r.created)).toBe(true);
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets`)[0]!.n).toBe(1);

      // Only the leader stops the party's search.
      expect(await cancel(a!)).toEqual({ ok: false, code: 'NOT_LEADER' });
      expect(await cancel(leader!)).toMatchObject({ ok: true, cancelled: true });
      expect((await state(a!)).party).toMatchObject({ locked: false });
      // Unlocked: changes are allowed again, and the member's "ready" stood (the leader only paused the search).
      expect(((await state(leader!)).party.members as Json[]).map((m) => m.ready)).toEqual([true, true]);
      expect(await rpc(late!, 'party_respond_invite', invited.invite_id, true)).toMatchObject({ ok: true, joined: true });
    });

    it('a party cannot queue with a member who is at a table, cooling down, silent, or blocked by another member', async () => {
      const [leader, a, b] = await party(3);
      await sql`update public.party_members set last_seen_at = now() - interval '5 minutes' where user_id = ${b!.userId}`;
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'MEMBER_OFFLINE' });
      await rpc(b!, 'matchmaking_heartbeat');
      await sql`select public.matchmaking_strike(${a!.userId})`;
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'MEMBER_COOLDOWN' });
      await sql`delete from public.matchmaking_cooldowns`;
      const table = await hostPrivateGame(a!);
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'MEMBER_IN_GAME' });
      await sql`update public.players set status = 'LEFT' where id = ${table.seatId}`;
      await rpc(a!, 'block_player', b!.playerId);
      expect(await enqueue(leader!, null)).toEqual({ ok: false, code: 'PARTY_INVALID' });
      await rpc(a!, 'unblock_player', b!.playerId);
      expect(await enqueue(leader!, null)).toMatchObject({ ok: true, created: true });
    });

    it('the leader leaving hands the party on; the last member leaving dissolves it', async () => {
      const [leader, a, b] = await party(3);
      expect(await rpc(leader!, 'party_leave')).toEqual({ ok: true, left: true });
      expect(await rpc(leader!, 'party_leave')).toEqual({ ok: true, left: false });
      const s = await state(a!);
      expect(s.party.is_leader).toBe(true);
      expect(s.party.members.map((m: Json) => m.player_id)).toEqual([a!.playerId, b!.playerId]);
      expect((await state(leader!)).party).toBeNull();
      await rpc(a!, 'party_leave');
      expect((await state(b!)).party).toMatchObject({ is_leader: true });
      await rpc(b!, 'party_leave');
      expect((await sql`select count(*)::int as n from public.parties`)[0]!.n).toBe(0);
    });

    it('a leader who has been gone for the grace period hands over to a member who is there; a short absence changes nothing', async () => {
      const [leader, a] = await party(2);
      await sql`update public.party_members set last_seen_at = now() - interval '60 seconds' where user_id = ${leader!.userId}`;
      await tick();
      expect((await state(a!)).party.is_leader).toBe(false);
      await sql`update public.party_members set last_seen_at = now() - interval '5 minutes' where user_id = ${leader!.userId}`;
      await rpc(a!, 'matchmaking_heartbeat');
      await tick();
      expect((await state(a!)).party).toMatchObject({ is_leader: true });
      // The old leader comes back as a member of the same party: nothing was dissolved.
      expect((await state(leader!)).party).toMatchObject({ is_leader: false });
      expect((await state(leader!)).party.members).toHaveLength(2);
    });

    it('a member leaving while the party is queued: the others keep their place in the queue, together', async () => {
      const [leader, a, b] = await party(3);
      const queued = await enqueue(leader!, null);
      expect(await rpc(b!, 'party_leave')).toEqual({ ok: true, left: true });
      const ticket = (await sql`select * from public.matchmaking_tickets where id = ${queued.ticket.id}`)[0]!;
      expect(ticket).toMatchObject({ status: 'QUEUED', player_count: 2 });
      expect(String(ticket.queued_at)).toBe(String(new Date(queued.ticket.queued_at)));
      expect((await state(b!))).toMatchObject({ party: null, ticket: null });
      expect((await state(a!)).ticket).toMatchObject({ id: queued.ticket.id, player_count: 2 });
      // The one who left is free to queue alone.
      expect(await enqueue(b!, 'classic')).toMatchObject({ ok: true, created: true, ticket: { kind: 'solo' } });
    });

    it('the leader leaving while queued: leadership passes on and the search continues', async () => {
      const [leader, a, b] = await party(3);
      const queued = await enqueue(leader!, null);
      await rpc(leader!, 'party_leave');
      const s = await state(a!);
      expect(s.party).toMatchObject({ is_leader: true, locked: true });
      expect(s.ticket).toMatchObject({ id: queued.ticket.id, status: 'QUEUED', player_count: 2 });
      // The new leader is the one who can stop it now.
      expect(await cancel(b!)).toEqual({ ok: false, code: 'NOT_LEADER' });
      expect(await cancel(a!)).toMatchObject({ cancelled: true });
    });

    it('the leader removes a member before queueing', async () => {
      const [leader, a, b] = await party(3);
      expect(await rpc(a!, 'party_kick', b!.playerId)).toEqual({ ok: false, code: 'NOT_LEADER' });
      expect(await rpc(leader!, 'party_kick', b!.playerId)).toEqual({ ok: true, removed: true });
      expect(await rpc(leader!, 'party_kick', b!.playerId)).toEqual({ ok: true, removed: false });
      expect((await state(b!)).party).toBeNull();
      expect((await state(leader!)).party.members).toHaveLength(2);
    });

    it('parties of every size from 1 to 8 queue as one ticket and stay whole in the reservation and in the game', async () => {
      for (const size of [1, 2, 3, 5, 8]) {
        const members = await party(size);
        expect(await enqueue(members[0]!, null), `size ${size}`).toMatchObject({ ok: true, ticket: { kind: 'party', player_count: size } });
      }
      const solosIn = await queueSolos(2);
      await waitInQueue(120);
      await tick();
      const rows = await sql`
        select mp.match_id, mp.ticket_id, t.player_count, m.player_count as table_size
        from public.matchmaking_match_players mp
        join public.matchmaking_tickets t on t.id = mp.ticket_id
        join public.matchmaking_matches m on m.id = mp.match_id`;
      // Every ticket sits in exactly one match, with all of its players.
      const byTicket = new Map<string, Json[]>();
      for (const r of rows) byTicket.set(r.ticket_id, [...(byTicket.get(r.ticket_id) ?? []), r]);
      for (const group of byTicket.values()) {
        expect(new Set(group.map((r) => r.match_id)).size).toBe(1);
        expect(group).toHaveLength(group[0]!.player_count);
        expect(group[0]!.table_size).toBeLessThanOrEqual(8);
      }
      // 1+2+3+5+8 party players and 2 solos: all 21 are seated somewhere (8 alone; the rest in valid tables).
      expect(rows).toHaveLength(21);
      expect(solosIn).toHaveLength(2);
    });

    it('a party of eight is a complete match at once; a party of five takes three solo players', async () => {
      const eight = await party(8);
      await enqueue(eight[0]!, null);
      const five = await party(5, 'intermediate');
      await enqueue(five[0]!, null);
      const three = await queueSolos(3, 'intermediate');
      await tick();
      const full = (await state(eight[3]!)).match;
      expect(full).toMatchObject({ player_count: 8, mode: 'classic' });
      expect(new Set(full.players.map((p: Json) => p.group)).size).toBe(1);
      expect(full.players.every((p: Json) => p.party)).toBe(true);
      const mixed = (await state(five[0]!)).match;
      expect(mixed).toMatchObject({ player_count: 8, mode: 'intermediate' });
      // Party grouping is visible: the five share a group, each solo has their own.
      const groups = new Map<number, number>();
      for (const p of mixed.players as Json[]) groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
      expect([...groups.values()].sort()).toEqual([1, 1, 1, 5]);
      expect((await state(three[0]!)).match.id).toBe(mixed.id);
    });

    it('a party of six and a party of three are never combined; five and four neither', async () => {
      const six = await party(6);
      const three = await party(3);
      await enqueue(six[0]!, null);
      await enqueue(three[0]!, null);
      await waitInQueue(45);
      await tick();
      expect((await state(six[0]!)).match).toBeNull();
      expect((await state(three[0]!)).match).toBeNull();
      await waitInQueue(60);
      await tick();
      expect((await state(six[0]!)).match).toMatchObject({ player_count: 6 });
      expect((await state(three[0]!)).match).toBeNull();
      expect((await sql`select max(player_count)::int as n from public.matchmaking_matches`)[0]!.n).toBe(6);
    });

    it('a whole party plays in one game, on the mode it chose', async () => {
      const members = await party(3, 'intermediate');
      await enqueue(members[0]!, null);
      const [solo] = await queueSolos(1, 'intermediate');
      await tick();
      const matchId = (await matchIdOf(solo!))!;
      await readyAll([...members, solo!], matchId);
      await tick();
      const match = await matchRow(matchId);
      expect(match.status).toBe('STARTED');
      const seats = await sql`select user_id from public.players where game_id = ${match.game_id}`;
      expect(seats.map((s) => s.user_id).sort()).toEqual([...members, solo!].map((p) => p.userId).sort());
      expect((await sql`select game_mode from public.games where id = ${match.game_id}`)[0]!.game_mode).toBe('intermediate');
      // Afterwards the party still exists, is unlocked, and asks for a fresh "ready" before the next search.
      const s = await state(members[1]!);
      expect(s.party).toMatchObject({ locked: false });
      expect((s.party.members as Json[]).filter((m) => !m.is_leader).every((m) => !m.ready)).toBe(true);
    });

    it('one member of a party not confirming takes the whole party out — together — and the others at the table search on', async () => {
      const members = await party(2);
      await enqueue(members[0]!, null);
      const solosIn = await queueSolos(2);
      await tick();
      const matchId = (await matchIdOf(solosIn[0]!))!;
      await readyAll([members[0]!, ...solosIn], matchId);
      await passReadyDeadline(matchId);
      await tick();
      const partyTicket = (await ticketOf(members[0]!))!;
      expect(partyTicket).toMatchObject({ status: 'CANCELLED', close_reason: 'READY_TIMEOUT', player_count: 2 });
      // Only the member who did not confirm is paused; the party is intact and unlocked.
      expect((await state(members[0]!)).cooldown_seconds).toBe(0);
      expect((await state(members[1]!)).cooldown_seconds).toBeGreaterThan(0);
      expect((await state(members[0]!)).party.members).toHaveLength(2);
      expect((await state(members[0]!)).party.locked).toBe(false);
      for (const p of solosIn) expect((await ticketOf(p))!.status).toBe('QUEUED');
    });

    it('a member walking out during the countdown: the reservation ends, the rest of the party searches on together', async () => {
      const members = await party(3);
      await enqueue(members[0]!, null);
      const [solo] = await queueSolos(1);
      await tick();
      const matchId = (await matchIdOf(solo!))!;
      expect(await rpc(members[2]!, 'party_leave')).toEqual({ ok: true, left: true });
      expect(await matchRow(matchId)).toMatchObject({ status: 'CANCELLED', close_reason: 'PLAYER_LEFT' });
      expect((await ticketOf(members[0]!))!).toMatchObject({ status: 'QUEUED', player_count: 2 });
      expect((await ticketOf(solo!))!.status).toBe('QUEUED');
      expect((await state(members[2]!)).cooldown_seconds).toBeGreaterThan(0);
      expect((await sql`select count(*)::int as n from public.matchmaking_match_players where active`)[0]!.n).toBe(0);
    });

    it('an abandoned party is dissolved; one somebody still looks at is not', async () => {
      const [l1] = await party(2);
      const [l2] = await party(2);
      await timeTravel((tx) => tx`update public.parties set updated_at = now() - interval '2 hours'`);
      await sql`update public.party_members set last_seen_at = now() - interval '2 hours'`;
      await rpc(l2!, 'matchmaking_heartbeat');
      await tick();
      expect((await state(l1!)).party).toBeNull();
      expect((await state(l2!)).party).not.toBeNull();
    });
  });

  // =========================================================================================
  describe('disconnects, restarts and stale state', () => {
    it('a searching phone that goes silent keeps its ticket through the grace period, then loses it', async () => {
      const [a, b] = await queueSolos(2);
      await goSilent(a!, 20);
      await tick();
      expect((await ticketOf(a!))!.status).toBe('QUEUED');
      // Back within the grace period: the same ticket, no new one.
      const before = (await ticketOf(a!))!.id;
      expect((await rpc(a!, 'matchmaking_heartbeat')).ok).toBe(true);
      await tick();
      expect((await ticketOf(a!))!).toMatchObject({ id: before, status: 'QUEUED' });
      await goSilent(a!, 45);
      await tick();
      expect((await ticketOf(a!))!).toMatchObject({ status: 'EXPIRED', close_reason: 'DISCONNECTED' });
      expect((await ticketOf(b!))!.status).toBe('QUEUED');
      // Coming back after that is a new search; there is no cooldown for a lost connection.
      expect((await state(a!))).toMatchObject({ ticket: null, cooldown_seconds: 0, last_result: { status: 'EXPIRED', reason: 'DISCONNECTED' } });
      expect(await enqueue(a!)).toMatchObject({ ok: true, created: true });
    });

    it('asking for the state is itself a sign of life', async () => {
      const [a] = await queueSolos(1);
      await goSilent(a!, 25);
      await state(a!);
      await goSilent(a!, 10);
      await tick();
      expect((await ticketOf(a!))!.status).toBe('QUEUED');
    });

    it('one silent member takes the party out of the queue as a whole; the party itself stays', async () => {
      const members = await party(3);
      await enqueue(members[0]!, null);
      await goSilent(members[1]!, 45);
      await tick();
      expect((await ticketOf(members[0]!))!).toMatchObject({ status: 'EXPIRED', close_reason: 'DISCONNECTED', player_count: 3 });
      const s = await state(members[0]!);
      expect(s.party.members).toHaveLength(3);
      expect(s.party.locked).toBe(false);
    });

    it('after a restart the server, not the phone, says where the player is: queued, counting down, or playing', async () => {
      const four = await queueSolos(4);
      // Queued.
      expect(await state(four[0]!)).toMatchObject({ ticket: { status: 'QUEUED' }, match: null, game: null });
      await tick();
      // Counting down — with the server's own deadline, however late the phone asks.
      const s = await state(four[0]!);
      expect(s).toMatchObject({ ticket: { status: 'RESERVED' }, match: { status: 'READY_UP' } });
      const matchId = s.match.id;
      // Confirm, "restart", confirm again with the token the phone kept: same seat.
      const t = token();
      await rpc(four[0]!, 'matchmaking_ready', matchId, t);
      expect((await state(four[0]!)).match.players.find((p: Json) => p.is_me).ready).toBe(true);
      await rpc(four[0]!, 'matchmaking_ready', matchId, t);
      await readyAll(four.slice(1), matchId);
      await tick();
      // Playing.
      expect(await state(four[0]!)).toMatchObject({ ticket: null, match: null, game: { match_id: matchId } });
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets where owner_user_id = ${four[0]!.userId}`)[0]!.n).toBe(1);
    });

    it('reconnecting during the countdown does not move the deadline', async () => {
      const four = await queueSolos(4);
      await tick();
      const first = (await state(four[0]!)).match.ready_deadline;
      for (let i = 0; i < 5; i += 1) {
        await rpc(four[0]!, 'matchmaking_heartbeat');
        expect((await state(four[0]!)).match.ready_deadline).toBe(first);
      }
    });

    it('the change counter moves for everyone concerned, and the heartbeat carries it', async () => {
      const four = await queueSolos(4);
      const before = await Promise.all(four.map(async (p) => Number((await state(p)).version)));
      await tick();
      const after = await Promise.all(four.map(async (p) => Number((await rpc(p, 'matchmaking_heartbeat')).version)));
      after.forEach((v, i) => expect(v).toBeGreaterThan(before[i]!));
      const matchId = (await matchIdOf(four[0]!))!;
      await rpc(four[1]!, 'matchmaking_ready', matchId, token());
      // One player's confirmation is news for the other three.
      expect(Number((await rpc(four[0]!, 'matchmaking_heartbeat')).version)).toBeGreaterThan(after[0]!);
      // The notes of who to tell are turned into bumps at commit and leave nothing behind.
      expect((await sql`select count(*)::int as n from public.matchmaking_touch_queue`)[0]!.n).toBe(0);
    });

    it('the heartbeat tells a searching phone when the worker has something to do', async () => {
      const [a] = await queueSolos(1);
      expect((await rpc(a!, 'matchmaking_heartbeat')).tick_due).toBe(false);
      const [b] = await queueSolos(1);
      expect((await rpc(a!, 'matchmaking_heartbeat')).tick_due).toBe(true);
      await setting('client_tick', 0);
      expect((await rpc(a!, 'matchmaking_heartbeat')).tick_due).toBe(false);
      await setting('client_tick', 1);
      await waitInQueue(31);
      await tick();
      const matchId = (await matchIdOf(a!))!;
      expect((await rpc(a!, 'matchmaking_heartbeat')).tick_due).toBe(false);
      await readyAll([a!, b!], matchId);
      expect((await rpc(b!, 'matchmaking_heartbeat')).tick_due).toBe(true);
    });

    it('a player’s account deleted while they search: the ticket goes; a party loses only that member', async () => {
      const [a] = await queueSolos(1);
      await sql`delete from auth.users where id = ${a!.userId}`;
      expect((await sql`select status, close_reason from public.matchmaking_tickets where owner_user_id is null and kind = 'solo'`)[0]).toMatchObject({ status: 'CANCELLED', close_reason: 'ABANDONED' });

      const members = await party(3);
      const queued = await enqueue(members[0]!, null);
      await sql`delete from auth.users where id = ${members[0]!.userId}`;
      const ticket = (await sql`select * from public.matchmaking_tickets where id = ${queued.ticket.id}`)[0]!;
      expect(ticket).toMatchObject({ status: 'QUEUED', player_count: 2 });
      const s = await state(members[1]!);
      expect(s.party.members).toHaveLength(2);
      expect(s.party.members.filter((m: Json) => m.is_leader)).toHaveLength(1);
      expect(s.ticket).toMatchObject({ id: queued.ticket.id });
    });

    it('an account deleted during the countdown ends that reservation; the others search on', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(1), matchId);
      await sql`delete from auth.users where id = ${four[0]!.userId}`;
      expect(await matchRow(matchId)).toMatchObject({ status: 'CANCELLED', close_reason: 'PLAYER_LEFT' });
      for (const p of four.slice(1)) expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED', match_id: null });
      await tick();
      expect((await sql`select count(*)::int as n from public.games where matchmaking_match_id = ${matchId}`)[0]!.n).toBe(0);
    });

    it('an account deleted after the game started: the game goes on, as for any game', async () => {
      const two = await players(2);
      const { gameId } = await playMatch(two);
      await sql`delete from auth.users where id = ${two[0]!.userId}`;
      const seats = await sql`select user_id, status from public.players where game_id = ${gameId}`;
      expect(seats).toHaveLength(2);
      expect(seats.filter((s) => s.user_id === null)).toHaveLength(1);
      expect((await sql`select status from public.games where id = ${gameId}`)[0]!.status).toBe('ACTIVE');
    });

    it('a party dissolved by account deletions leaves no ticket pointing at nothing', async () => {
      const members = await party(2);
      await enqueue(members[0]!, null);
      await sql`delete from auth.users where id = any(${members.map((m) => m.userId)}::uuid[])`;
      expect((await sql`select count(*)::int as n from public.parties`)[0]!.n).toBe(0);
      expect((await sql`select count(*)::int as n from public.matchmaking_tickets where status in ('QUEUED', 'RESERVED')`)[0]!.n).toBe(0);
    });

    it('removing a friend, or blocking them, never corrupts a queue or a match they share', async () => {
      const members = await party(2);
      await enqueue(members[0]!, null);
      expect(await rpc(members[0]!, 'remove_friend', members[1]!.playerId)).toMatchObject({ ok: true, removed: true });
      const [x, y] = await queueSolos(2);
      await tick();
      const matchId = (await matchIdOf(x!))!;
      expect(matchId).toBeTruthy();
      await rpc(x!, 'block_player', y!.playerId);
      await readyAll([...members, x!, y!], matchId);
      await tick();
      // The block came after the reservation was committed: like a block inside a running game, it removes nobody.
      expect((await matchRow(matchId)).status).toBe('STARTED');
    });
  });

  // =========================================================================================
  describe('who may make the worker run', () => {
    const queuedCount = async () => (await sql`select count(*)::int as n from public.matchmaking_tickets where status = 'QUEUED'`)[0]!.n as number;

    it('a request with no credential is refused, and not one statement of a tick runs', async () => {
      await queueSolos(4);
      const before = await workDone();
      for (const caller of [{}, { authorization: null }, { authorization: '' }, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }]) {
        const res = await handleMatchmakingRequest({ op: 'tick' }, secured, caller);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      }
      // The project's publishable key, which every copy of the app carries, is not a player.
      expect((await handleMatchmakingRequest({ op: 'tick' }, secured, { authorization: 'Bearer sb_publishable_0123456789abcdef' })).status).toBe(401);
      // A token Supabase Auth does not know.
      expect((await handleMatchmakingRequest({ op: 'tick' }, secured, { authorization: 'Bearer aaaa.bbbb.cccc' })).status).toBe(401);
      expect(await workDone()).toEqual(before);
      expect(await queuedCount()).toBe(4);
    });

    it('a wrong worker secret is refused, never falls back to a player, and nothing runs', async () => {
      const [a] = await queueSolos(4);
      const before = await workDone();
      const wrong = [WORKER_SECRET.slice(0, -1) + (WORKER_SECRET.endsWith('0') ? '1' : '0'), WORKER_SECRET.slice(0, 32), `${WORKER_SECRET}0`, '', ' ', 'null'];
      for (const workerSecret of wrong) {
        const res = await handleMatchmakingRequest({ op: 'tick' }, secured, { workerSecret });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
        expect(JSON.stringify(res)).not.toContain(WORKER_SECRET);
      }
      // A searching player who also presents a wrong secret is judged on the secret alone.
      authCalls = 0;
      expect((await handleMatchmakingRequest({ op: 'tick' }, secured, { workerSecret: 'guess', authorization: `Bearer ${accessToken(a!)}` })).status).toBe(403);
      expect(authCalls).toBe(0);
      // A server that has no secret configured (or a uselessly short one) accepts no internal request at all.
      for (const workerSecret of [undefined, null, '', 'short']) {
        const unconfigured: MatchmakingDeps = { ...secured, sql, workerSecret };
        expect((await handleMatchmakingRequest({ op: 'tick' }, unconfigured, { workerSecret: workerSecret ?? '' })).status).toBe(403);
      }
      expect(await workDone()).toEqual(before);
      expect(await queuedCount()).toBe(4);
      expect(JSON.stringify(logs)).not.toContain(WORKER_SECRET);
    });

    it('the scheduler, with the worker secret, runs a tick and is told what it did', async () => {
      const four = await queueSolos(4);
      const res = await asScheduler();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, ran: true, report: { ok: true, modes: [{ mode: 'classic', reserved: 1 }, { mode: 'intermediate' }] } });
      for (const p of four) expect((await state(p)).match).toMatchObject({ status: 'READY_UP' });
    });

    it('guests queue and are matched through the app’s own path: one of them asks the worker to look', async () => {
      const four = await queueSolos(4);
      const [guest] = await sql`select is_anonymous from auth.users where id = ${four[0]!.userId}`;
      expect(guest!.is_anonymous).toBe(true);
      // What the app sends today (and what apps already installed send): { op: 'tick' } with the player's token.
      const res = await asPlayer(four[0]!);
      expect(res).toEqual({ status: 200, body: { ok: true, ran: true } });
      const seated = new Set<string>();
      for (const p of four) {
        const match = (await state(p)).match as Json;
        expect(match).toMatchObject({ status: 'READY_UP' });
        seated.add(match.id);
      }
      expect(seated.size).toBe(1);
      // The same request under its new name is the same thing.
      await passTickInterval();
      await passNudgeInterval();
      expect((await asPlayer(four[1]!, { op: 'nudge' })).body).toEqual({ ok: true, ran: true });
    });

    it('the last ready-up confirmation completes: a player’s request starts the game', async () => {
      const four = await queueSolos(4);
      expect((await asPlayer(four[0]!)).body).toMatchObject({ ran: true });
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      expect((await rpc(four[3]!, 'matchmaking_heartbeat')).tick_due).toBe(true);
      await passTickInterval();
      expect((await asPlayer(four[3]!)).body).toEqual({ ok: true, ran: true });
      expect(await matchRow(matchId)).toMatchObject({ status: 'STARTED' });
      const games = new Set<string>();
      for (const p of four) games.add(((await state(p)).game as Json).game_id);
      expect(games.size).toBe(1);
    });

    it('expiry and recovery still run: from the scheduler’s tick, from a player’s, and from pg_cron’s own sweep', async () => {
      // A countdown that ran out, handled by the scheduled tick.
      const four = await queueSolos(4);
      await asScheduler();
      const first = (await matchIdOf(four[0]!))!;
      await passReadyDeadline(first);
      await passTickInterval();
      const swept = await asScheduler();
      expect(swept.body).toMatchObject({ ok: true, ran: true, report: { sweep: { ready_timeouts: 1 } } });
      expect(await matchRow(first)).toMatchObject({ status: 'CANCELLED' });

      // A reservation whose game was never created, released by a waiting player's request.
      await sql`delete from public.matchmaking_tickets`;
      await sql`delete from public.matchmaking_cooldowns`;
      const two = await queueSolos(2);
      await waitInQueue(120);
      await tick();
      const second = (await matchIdOf(two[0]!))!;
      await readyAll(two, second);
      await passStartDeadline(second);
      await passTickInterval();
      expect((await asPlayer(two[0]!)).body).toEqual({ ok: true, ran: true });
      expect(await matchRow(second)).toMatchObject({ status: 'FAILED' });
      for (const p of two) expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED' });

      // pg_cron runs the sweep as plain SQL: it needs neither the function nor a secret.
      await sql`delete from public.matchmaking_tickets`;
      const more = await queueSolos(4);
      await tick();
      const third = (await matchIdOf(more[0]!))!;
      await passReadyDeadline(third);
      expect((await sql`select public.matchmaking_sweep() as r`)[0]!.r).toMatchObject({ ready_timeouts: 1 });
      expect(await matchRow(third)).toMatchObject({ status: 'CANCELLED' });
    });

    it('repeated triggers cannot get past the throttle: fifty at once are one tick', async () => {
      const four = await queueSolos(4);
      const before = await workDone();
      const results = await Promise.all([
        ...Array.from({ length: 30 }, () => asScheduler()),
        ...Array.from({ length: 20 }, (_, i) => asPlayer(four[i % 4]!)),
      ]);
      expect(results.filter((r) => r.body.ok && r.body.ran).length).toBe(1);
      for (const r of results) expect([200, 429]).toContain(r.status);
      const after = await workDone();
      expect(after.ticks - before.ticks).toBe(1);
      // One matching run per mode at most, however many asked.
      expect(after.runs - before.runs).toBeLessThanOrEqual(2);
      expect((await sql`select count(*)::int as n from public.matchmaking_matches`)[0]!.n).toBe(1);

      // Sequentially, inside the interval: still nothing more.
      for (let i = 0; i < 10; i += 1) expect((await asScheduler()).body).toEqual({ ok: true, ran: false, skipped: 'THROTTLED' });
      expect(await workDone()).toEqual(after);
      // Once the interval has passed the next one runs.
      await passTickInterval();
      expect((await asScheduler()).body).toMatchObject({ ran: true });
    });

    it('one player hammering the worker is told to wait, and costs no ticks', async () => {
      const [a, b] = await queueSolos(2);
      expect((await asPlayer(a!)).body).toEqual({ ok: true, ran: true });
      const before = await workDone();
      for (let i = 0; i < 25; i += 1) {
        await passTickInterval();
        const res = await asPlayer(a!);
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
        expect(Number(res.headers?.['Retry-After'])).toBeGreaterThanOrEqual(1);
      }
      expect(await workDone()).toEqual(before);
      // That limit is this player's alone: another searching player is served at once.
      await passTickInterval();
      expect(await asPlayer(b!)).toEqual({ status: 200, body: { ok: true, ran: true } });
      // And it is a pause, not a ban.
      await passTickInterval();
      await passNudgeInterval();
      expect((await asPlayer(a!)).body).toEqual({ ok: true, ran: true });
    });

    it('independent players are never rate-limited by each other', async () => {
      const eight = await queueSolos(8);
      const statuses: number[] = [];
      for (const p of eight) {
        await passTickInterval();
        statuses.push((await asPlayer(p)).status);
      }
      expect(statuses).toEqual(Array(8).fill(200));
      // Without the interval passing, the others are not refused either: a tick has just run for all of them.
      const [x, y] = await queueSolos(2, 'intermediate');
      await passTickInterval();
      expect((await asPlayer(x!)).body).toEqual({ ok: true, ran: true });
      expect(await asPlayer(y!)).toEqual({ status: 200, body: { ok: true, ran: false, skipped: 'THROTTLED' } });
    });

    it('a player cannot pass for the scheduler, name a target, or run the worker when they are not searching', async () => {
      const [a] = await queueSolos(4);
      // Whatever the body claims, it is a player's request: no report, and the player's own limits apply.
      const forged = await asPlayer(a!, { op: 'tick', source: 'cron', internal: true, workerSecret: WORKER_SECRET, force: true, userId: randomUUID() });
      expect(forged).toEqual({ status: 200, body: { ok: true, ran: true } });
      expect((await asPlayer(a!, { op: 'tick', source: 'cron' })).status).toBe(429);
      // The worker's own operations are not on offer to anyone through this door.
      await passNudgeInterval();
      for (const op of ['reserve', 'start', 'sweep', 'force', '']) expect((await asPlayer(a!, { op })).status).toBe(400);

      // A signed-in player with nothing in the queue: nothing runs on their word.
      const [idle] = await players(1);
      await passTickInterval();
      const before = await workDone();
      const res = await asPlayer(idle!);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      // Nor for a player who only sits in a party.
      const [leader] = await party(2);
      expect((await asPlayer(leader!)).status).toBe(403);
      expect(await workDone()).toEqual(before);

      // Nudges switched off (settings.client_tick = 0): players are refused, the scheduler is not.
      await setting('client_tick', 0);
      await passNudgeInterval();
      expect((await asPlayer(a!)).status).toBe(403);
      expect((await asScheduler()).body).toMatchObject({ ok: true, ran: true });
      // And no player can reach the gate itself.
      await expect(rpc(a!, 'matchmaking_tick_claim', null)).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`select * from public.matchmaking_tick_gate`)).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`update public.matchmaking_nudges set last_nudge_at = now() - interval '1 hour'`)).rejects.toThrow(/permission denied/);
    });

    it('failures answer safely and leave nothing stuck', async () => {
      const four = await queueSolos(4);
      // Supabase Auth unreachable: a generic error, nothing about the cause, nothing run.
      authDown = true;
      const before = await workDone();
      const down = await asPlayer(four[0]!);
      authDown = false;
      expect(down).toEqual({ status: 500, body: { ok: false, error: { code: 'SERVER_ERROR', message: 'Matchmaking is temporarily unavailable.' } } });
      expect(await workDone()).toEqual(before);

      // The database unreachable: the same answer, and no detail of it.
      const dead: MatchmakingDeps = { ...secured, sql: (() => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432 password authentication failed'))) as never, log: () => undefined };
      const broken = await handleMatchmakingRequest({ op: 'tick' }, dead, { workerSecret: WORKER_SECRET });
      expect(broken.status).toBe(500);
      expect(JSON.stringify(broken)).not.toMatch(/ECONNREFUSED|password|10\.1\.2\.3/);

      // A tick that dies in the middle of reserving: reported, rolled back, and the next one succeeds.
      const faulty: MatchmakingDeps = {
        ...secured,
        sql,
        fault: (at) => {
          if (at === 'after-reserve') throw new Error('injected failure after-reserve');
        },
      };
      const failed = await handleMatchmakingRequest({ op: 'tick' }, faulty, { workerSecret: WORKER_SECRET });
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ ok: true, ran: true, report: { ok: false } });
      expect(await queuedCount()).toBe(4);
      expect((await sql`select count(*)::int as n from public.matchmaking_matches`)[0]!.n).toBe(0);
      await passTickInterval();
      await sql`update public.matchmaking_runs set last_run_at = null`;
      expect((await asScheduler()).body).toMatchObject({ ran: true, report: { ok: true } });
      for (const p of four) expect((await state(p)).match).toMatchObject({ status: 'READY_UP' });
    });
  });

  // =========================================================================================
  describe('worker failures and recovery', () => {
    const failing = (point: FaultPoint, times = Infinity): MatchmakingDeps => {
      let left = times;
      return {
        ...worker,
        fault: (at) => {
          if (at === point && left > 0) {
            left -= 1;
            throw new Error(`injected failure ${point}`);
          }
        },
      };
    };

    it('a worker that dies before committing a reservation leaves every ticket queued, exactly as it was', async () => {
      const four = await queueSolos(4);
      const report = await matchMode('classic', failing('after-reserve'), true);
      expect(report).toMatchObject({ reserved: 0, error: 'injected failure after-reserve' });
      expect((await sql`select count(*)::int as n from public.matchmaking_matches`)[0]!.n).toBe(0);
      for (const p of four) expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED', match_id: null });
      // The next worker simply does the job.
      await tick();
      expect((await state(four[0]!)).match).toMatchObject({ player_count: 4 });
    });

    it('a worker that dies after committing a reservation: the reservation stands and the countdown runs', async () => {
      const four = await queueSolos(4);
      await matchMode('classic', worker, true);
      // Nothing else of that tick ever ran. A different worker picks it up from the rows alone.
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      expect((await startDueMatches(worker)).started).toBe(1);
    });

    for (const point of ['before-game', 'after-game'] as const) {
      it(`a failure ${point === 'before-game' ? 'before' : 'in the middle of'} game creation leaves no game and no half of one; a retry creates exactly one`, async () => {
        const four = await queueSolos(4);
        await tick();
        const matchId = (await matchIdOf(four[0]!))!;
        await readyAll(four, matchId);
        const gamesBefore = (await sql`select count(*)::int as n from public.games`)[0]!.n;
        const playersBefore = (await sql`select count(*)::int as n from public.players`)[0]!.n;

        expect(await startMatch(matchId, failing(point))).toEqual({ started: false, code: 'START_FAILED' });
        expect(await matchRow(matchId)).toMatchObject({ status: 'STARTING', game_id: null, start_attempts: 1 });
        expect((await sql`select count(*)::int as n from public.games`)[0]!.n).toBe(gamesBefore);
        expect((await sql`select count(*)::int as n from public.players`)[0]!.n).toBe(playersBefore);
        // The players are still told "starting": nobody is thrown back, nobody is in a game that does not exist.
        expect(await state(four[0]!)).toMatchObject({ match: { status: 'STARTING' }, game: null });

        await tick();
        expect((await matchRow(matchId)).status).toBe('STARTED');
        expect((await sql`select count(*)::int as n from public.games`)[0]!.n).toBe(gamesBefore + 1);
        expect((await sql`select count(*)::int as n from public.players`)[0]!.n).toBe(playersBefore + 4);
      });
    }

    it('game creation that keeps failing gives up after three tries: everyone is queued again, nobody is penalised', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      const broken = failing('after-game');
      for (let i = 0; i < 3; i += 1) await startMatch(matchId, broken);
      expect(await matchRow(matchId)).toMatchObject({ status: 'FAILED', close_reason: 'START_FAILED', game_id: null });
      for (const p of four) {
        expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED', match_id: null, requeue_count: 1 });
        expect((await state(p)).cooldown_seconds).toBe(0);
      }
      expect((await sql`select count(*)::int as n from public.games where matchmaking_match_id = ${matchId}`)[0]!.n).toBe(0);
      // And they are matched again by a healthy worker, into a new reservation.
      await tick();
      const again = (await state(four[0]!)).match;
      expect(again).toMatchObject({ status: 'READY_UP', player_count: 4 });
      expect(again.id).not.toBe(matchId);
    });

    it('a reservation stuck in STARTING past its deadline is released by the sweep — once, however often it runs', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      await passStartDeadline(matchId);
      const sweeps = await Promise.all(Array.from({ length: 4 }, () => sql`select public.matchmaking_sweep() as r`));
      expect(sweeps.reduce((n, s) => n + Number((s[0]!.r as Json).start_failures), 0)).toBe(1);
      expect(await matchRow(matchId)).toMatchObject({ status: 'FAILED', close_reason: 'START_TIMEOUT' });
      for (const p of four) expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED', requeue_count: 1 });
      expect(await startMatch(matchId, worker)).toEqual({ started: false, code: 'NOT_STARTING' });
    });

    it('recovery never queues players again when their game exists', async () => {
      const two = await players(2);
      const { matchId, gameId } = await playMatch(two);
      // The reservation is put back to "starting, overdue" as if the commit's answer had been lost and the row never updated.
      await timeTravel(
        (tx) => tx`update public.matchmaking_matches set status = 'STARTING', game_id = null, start_deadline = now() - interval '1 minute' where id = ${matchId}`,
      );
      await timeTravel((tx) => tx`update public.matchmaking_tickets set status = 'RESERVED', closed_at = null where match_id = ${matchId}`);
      await sql`update public.matchmaking_ticket_members set active = true where ticket_id in (select id from public.matchmaking_tickets where match_id = ${matchId})`;
      const [r] = await sql`select public.matchmaking_sweep() as r`;
      expect(r!.r).toMatchObject({ repaired: 1, start_failures: 0 });
      expect(await matchRow(matchId)).toMatchObject({ status: 'STARTED', game_id: gameId });
      expect((await sql`select status from public.matchmaking_tickets where match_id = ${matchId}`).every((t) => t.status === 'MATCHED')).toBe(true);
      expect((await sql`select count(*)::int as n from public.games where matchmaking_match_id = ${matchId}`)[0]!.n).toBe(1);
    });

    it('a reservation that no longer adds up is not started: its players are queued again', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      // One assignment disappears without its ticket knowing (it cannot, short of a bug or a manual fix).
      await timeTravel((tx) => tx`delete from public.matchmaking_match_players where match_id = ${matchId} and user_id = ${four[3]!.userId}`);
      expect(await startMatch(matchId, worker)).toEqual({ started: false, code: 'INVALID_RESERVATION' });
      expect(await matchRow(matchId)).toMatchObject({ status: 'FAILED', close_reason: 'INVALID_RESERVATION' });
      for (const p of four) expect((await ticketOf(p))!.status).toBe('QUEUED');
    });

    it('a player who sat down elsewhere before the start is taken out; the others are queued again', async () => {
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four, matchId);
      const created = ok(await call({ op: 'create', actionId: randomUUID(), token: token(), name: 'Host' }));
      await timeTravel((tx) => tx`update public.players set user_id = ${four[2]!.userId} where id = ${created.playerId}`);
      expect(await startMatch(matchId, worker)).toEqual({ started: false, code: 'IN_GAME' });
      expect(await matchRow(matchId)).toMatchObject({ status: 'CANCELLED', close_reason: 'IN_GAME' });
      expect((await ticketOf(four[2]!))!).toMatchObject({ status: 'CANCELLED', close_reason: 'IN_GAME' });
      for (const p of [four[0]!, four[1]!, four[3]!]) expect((await ticketOf(p))!.status).toBe('QUEUED');
    });

    it('a reserved ticket whose reservation is already over is put back by the sweep', async () => {
      const [a, b] = await queueSolos(2);
      await waitInQueue(31);
      await tick();
      const matchId = (await matchIdOf(a!))!;
      // The reservation is closed without its tickets (only a bug could do this).
      await timeTravel((tx) => tx`update public.matchmaking_matches set status = 'CANCELLED', closed_at = now(), close_reason = 'TEST' where id = ${matchId}`);
      const [r] = await sql`select public.matchmaking_sweep() as r`;
      expect(r!.r).toMatchObject({ repaired: 2 });
      for (const p of [a!, b!]) expect((await ticketOf(p))!).toMatchObject({ status: 'QUEUED', match_id: null });
    });

    it('a tick never throws, reports what it did, and logs counts — never a player', async () => {
      const four = await queueSolos(4);
      const scheduler = { workerSecret: WORKER_SECRET };
      const res = await handleMatchmakingRequest({ op: 'tick' }, secured, scheduler);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, report: { ok: true, modes: [{ mode: 'classic', reserved: 1 }, { mode: 'intermediate' }] } });
      expect(await handleMatchmakingRequest({ op: 'reserve', tickets: [] }, secured, scheduler)).toMatchObject({ status: 400 });
      expect(await handleMatchmakingRequest(null, secured, scheduler)).toMatchObject({ status: 400 });
      const text = JSON.stringify(logs);
      for (const p of four) {
        expect(text).not.toContain(p.userId);
        expect(text).not.toContain(p.nickname);
      }
      const dead: MatchmakingDeps = { sql: (() => Promise.reject(new Error('db down'))) as never, log: () => undefined };
      Object.assign(dead.sql, { begin: () => Promise.reject(new Error('db down')), json: (v: unknown) => v });
      const report = await runTick(dead);
      expect(report.ok).toBe(false);
    });

    it('every transition is in the log, with a reason and no personal data, and the metrics add up', async () => {
      await playMatch(await players(2), 'intermediate');
      const four = await queueSolos(4);
      await tick();
      const matchId = (await matchIdOf(four[0]!))!;
      await readyAll(four.slice(0, 3), matchId);
      await passReadyDeadline(matchId);
      await tick();
      await enqueue(four[0]!);
      const events = await sql`select entity, from_status, to_status, reason from public.matchmaking_events order by id`;
      const seen = events.map((e) => `${e.entity}:${e.from_status ?? ''}>${e.to_status ?? ''}:${e.reason ?? ''}`);
      expect(seen).toContain('ticket:>QUEUED:');
      expect(seen).toContain('ticket:QUEUED>RESERVED:');
      expect(seen).toContain('match:>READY_UP:');
      expect(seen).toContain('match:READY_UP>CANCELLED:READY_TIMEOUT');
      expect(seen).toContain('ticket:RESERVED>CANCELLED:READY_TIMEOUT');
      expect(seen).toContain('ticket:RESERVED>QUEUED:');
      expect(seen).toContain('ticket:>:DUPLICATE_ENQUEUE');
      const text = JSON.stringify(await sql`select * from public.matchmaking_events`);
      for (const p of four) expect(text).not.toContain(p.userId);

      const [m] = await sql`select public.matchmaking_metrics() as r`;
      const metrics = m!.r as Json;
      expect(metrics.queue.classic).toMatchObject({ tickets: 3, players: 3 });
      expect(metrics.matches.ready_timeouts).toBeGreaterThanOrEqual(1);
      expect(metrics.matches.started).toBeGreaterThanOrEqual(1);
      expect(metrics.match_sizes['2']).toBeGreaterThanOrEqual(1);
      expect(metrics.wait_seconds.matched).toBeGreaterThanOrEqual(2);
      expect(metrics.duplicate_requests).toBeGreaterThanOrEqual(1);
      expect(metrics.requeues).toBeGreaterThanOrEqual(3);
      expect(metrics.worker.runs).toBeGreaterThanOrEqual(1);
      expect(metrics.stale).toEqual({ queued_tickets_silent: 0, ready_up_overdue: 0, starting_overdue: 0 });
    });

    it('old rows are cleaned up; live ones are not', async () => {
      const [a, b] = await queueSolos(2);
      await cancel(a!);
      await timeTravel((tx) => tx`update public.matchmaking_tickets set closed_at = now() - interval '30 days' where status = 'CANCELLED'`);
      await sql`select public.matchmaking_sweep()`;
      expect(await ticketOf(a!)).toBeUndefined();
      expect((await ticketOf(b!))!.status).toBe('QUEUED');
    });
  });
});
