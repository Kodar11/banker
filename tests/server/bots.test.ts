/// <reference types="node" />
/**
 * Bot seats through the real referee and database: host-added bots, the server's bot runner, the
 * security of bot seats, and opt-in bot filling in matchmaking.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { botActionId, nextBotCheck, runBots } from '../../supabase/functions/game-action/bots.ts';
import { createSql, type Sql, type Tx } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import { runTick, type MatchmakingDeps } from '../../supabase/functions/matchmaking/handler.ts';
import { ledgerViolations, type ApiResponse, type GameAction, type GameSnapshot } from '../../supabase/functions/_shared/engine/index.ts';

const DATABASE_URL = process.env.DATABASE_URL;
type Ok = Extract<ApiResponse, { ok: true }>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!DATABASE_URL)('bots (Postgres)', { timeout: 120_000 }, () => {
  let sql: Sql;
  let deps: HandlerDeps;
  let worker: MatchmakingDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 12);
    deps = { sql, botPaceMs: 0 };
    worker = { sql, log: () => undefined };
  });
  afterAll(async () => {
    await sql?.end();
  });

  const token = () => randomBytes(32).toString('hex');
  const call = async (body: unknown) => (await handleRequest(body, deps)).body;
  function ok(res: ApiResponse): Ok {
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  async function hostWithBots(bots: number, config?: unknown) {
    const t = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: 'Host', ...(config ? { config } : {}) }));
    const host = { gameId: created.gameId, playerId: created.playerId, token: t };
    let snap = created.snapshot;
    const act = async (action: GameAction, seat = host) => {
      const res = await call({ op: 'action', gameId: host.gameId, playerId: seat.playerId, token: seat.token, actionId: randomUUID(), expectedVersion: snap.state.version, action });
      if (res.ok) snap = res.snapshot;
      return res;
    };
    for (let i = 0; i < bots; i += 1) ok(await act({ type: 'ADD_BOT', difficulty: 'normal', personality: (['investor', 'banker', 'dealmaker', 'opportunist'] as const)[i % 4]! }));
    return { host, act, snap: () => snap };
  }

  async function ledgerOk(gameId: string) {
    const ledger = (await sql`select * from public.transactions where game_id = ${gameId} order by seq`).map((t) => ({ ...t, fromPlayerId: t.from_player_id, toPlayerId: t.to_player_id, amount: Number(t.amount), id: t.id })) as never[];
    const players = (await sql`select id, name, balance from public.players where game_id = ${gameId}`).map((p) => ({ id: p.id, name: p.name, balance: Number(p.balance) })) as never[];
    expect(ledgerViolations({ players } as never, ledger)).toEqual([]);
  }

  describe('seats', () => {
    it('a host-added bot is a seat without a token or an account, marked as a bot everyone can see', async () => {
      const g = await hostWithBots(2);
      const rows = await sql`select name, token_hash, user_id, bot_difficulty, bot_personality, ready from public.players where game_id = ${g.host.gameId} and bot_difficulty is not null order by seat`;
      expect(rows.map((r) => [r.token_hash, r.user_id, r.bot_difficulty, r.bot_personality, r.ready])).toEqual([
        [null, null, 'normal', 'investor', true],
        [null, null, 'normal', 'banker', true],
      ]);
      expect(g.snap().state.players.filter((p) => p.bot).map((p) => p.bot)).toEqual([
        { difficulty: 'normal', personality: 'investor' },
        { difficulty: 'normal', personality: 'banker' },
      ]);
    });

    it('only the host may add a bot', async () => {
      const g = await hostWithBots(0);
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code: g.snap().state.code, name: 'Riya' }));
      const res = await call({ op: 'action', gameId: g.host.gameId, playerId: joined.playerId, token: t, actionId: randomUUID(), expectedVersion: joined.snapshot.state.version, action: { type: 'ADD_BOT', difficulty: 'easy', personality: 'banker' } });
      expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    });

    it('nobody can act as a bot seat or claim it, and the database keeps a bot a bot', async () => {
      const g = await hostWithBots(1);
      const bot = g.snap().state.players.find((p) => p.bot)!;
      for (const t of [token(), g.host.token]) {
        const res = await call({ op: 'action', gameId: g.host.gameId, playerId: bot.id, token: t, actionId: randomUUID(), expectedVersion: g.snap().state.version, action: { type: 'SET_READY', ready: false } });
        expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
        expect(await call({ op: 'state', gameId: g.host.gameId, playerId: bot.id, token: t })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      await expect(sql`update public.players set token_hash = ${'a'.repeat(64)} where id = ${bot.id}`).rejects.toThrow();
      await expect(sql`update public.players set bot_personality = 'banker' where id = ${bot.id}`).rejects.toThrow();
      // claim_seat: an account can never attach itself to a bot seat.
      const [user] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
      const claimed = await sql.begin(async (tx: Tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user!.id, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        await tx`select public.init_profile()`;
        const [row] = await tx`select public.claim_seat(${g.host.gameId}, ${bot.id}, ${token()}) as r`;
        return row!.r as Json;
      });
      expect(claimed).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    });
  });

  describe('the server bot runner', () => {
    it('plays the bots’ turns through the engine until a person is to move, recording each as the bot’s action', async () => {
      const g = await hostWithBots(3);
      ok(await g.act({ type: 'START_GAME' }));
      let report = await runBots(g.host.gameId, deps);
      let guard = 0;
      // Whenever it is the person's turn, they roll and end their turn; the bots play the rest.
      while (guard++ < 12) {
        const snap = ok(await call({ op: 'state', gameId: g.host.gameId, playerId: g.host.playerId, token: g.host.token })).snapshot;
        if (snap.state.status !== 'ACTIVE') break;
        const turn = snap.state.turn;
        if (turn.playerId === g.host.playerId) {
          const send = (action: GameAction) => call({ op: 'action', gameId: g.host.gameId, playerId: g.host.playerId, token: g.host.token, actionId: randomUUID(), expectedVersion: snap.state.version, action });
          if (turn.phase === 'AWAITING_ROLL') await send({ type: 'ROLL_DICE' });
          else if (turn.phase === 'AWAITING_DECISION') await send({ type: 'DECLINE_PROPERTY' });
          else if (turn.phase === 'TURN_COMPLETE') await send({ type: 'END_TURN' });
          else if (turn.phase === 'AWAITING_PAYMENT' && turn.pending?.kind === 'PAYMENT') {
            const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', CLUB: 'PAY_CLUB', LOAN_INTEREST: 'PAY_INTEREST' } as const;
            const paid = await send({ type: pay[turn.pending.reason] });
            if (!paid.ok) await send({ type: 'DECLARE_BANKRUPTCY' });
          }
          else if (snap.state.auction?.status === 'OPEN') await send({ type: 'PASS_AUCTION', auctionId: snap.state.auction.id });
        } else if (snap.state.auction?.status === 'OPEN' && snap.state.auction.participantIds.includes(g.host.playerId) && !snap.state.auction.passedIds.includes(g.host.playerId)) {
          await call({ op: 'action', gameId: g.host.gameId, playerId: g.host.playerId, token: g.host.token, actionId: randomUUID(), expectedVersion: snap.state.version, action: { type: 'PASS_AUCTION', auctionId: snap.state.auction.id } });
        }
        report = await runBots(g.host.gameId, deps);
        expect(report.claimed).toBe(true);
      }
      const actions = await sql`select a.player_id, a.payload from public.game_actions a join public.players p on p.id = a.player_id where a.game_id = ${g.host.gameId} and p.bot_difficulty is not null`;
      expect(actions.length).toBeGreaterThan(5);
      expect(actions.every((a) => (a.payload as Json).by === 'BOT')).toBe(true);
      expect((await sql`select bot_runner_until from public.games where id = ${g.host.gameId}`)[0]!.bot_runner_until).toBeNull();
      await ledgerOk(g.host.gameId);
    });

    it('one runner at a time, and a move already recorded is never applied again', async () => {
      const g = await hostWithBots(2);
      ok(await g.act({ type: 'START_GAME' }));
      const [a, b] = await Promise.all([runBots(g.host.gameId, deps), runBots(g.host.gameId, deps)]);
      // Concurrent runners take turns on the lease; whichever ran, the moves are the bots' and none is doubled.
      expect(a.claimed || b.claimed).toBe(true);
      // Every committed version has exactly one action.
      const rows = await sql`select state_version_after, count(*)::int as n from public.game_actions where game_id = ${g.host.gameId} group by 1 having count(*) > 1`;
      expect(rows).toEqual([]);
      // The deterministic id: the same move at the same version is the same id.
      expect(await botActionId(g.host.gameId, 7, 'x', 'k')).toBe(await botActionId(g.host.gameId, 7, 'x', 'k'));
      expect(await botActionId(g.host.gameId, 7, 'x', 'k')).not.toBe(await botActionId(g.host.gameId, 8, 'x', 'k'));
      await ledgerOk(g.host.gameId);
    });

    it('does nothing in a paused, finished or lobby game', async () => {
      const lobby = await hostWithBots(1);
      expect(await runBots(lobby.host.gameId, deps)).toMatchObject({ claimed: false, moves: 0 });
      const g = await hostWithBots(1);
      ok(await g.act({ type: 'START_GAME' }));
      ok(await g.act({ type: 'PAUSE_GAME' }));
      expect(await runBots(g.host.gameId, deps)).toMatchObject({ claimed: false, moves: 0 });
      ok(await g.act({ type: 'RESUME_GAME' }));
      ok(await g.act({ type: 'LEAVE_GAME' }));
      // The last person left: the game ended (only bots were still playing).
      expect((await sql`select status from public.games where id = ${g.host.gameId}`)[0]!.status).toBe('FINISHED');
      expect(await runBots(g.host.gameId, deps)).toMatchObject({ moves: 0 });
    });

    it('wakes itself for a person’s resale: nothing during the countdown, a bot bid once bidding opens', async () => {
      const t = token();
      const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: 'Host', mode: 'intermediate' }));
      const host = { gameId: created.gameId, playerId: created.playerId, token: t };
      let snap = created.snapshot;
      const act = async (action: GameAction) => {
        const res = ok(await call({ op: 'action', gameId: host.gameId, playerId: host.playerId, token: host.token, actionId: randomUUID(), expectedVersion: snap.state.version, action }));
        snap = res.snapshot;
      };
      for (const personality of ['opportunist', 'investor'] as const) await act({ type: 'ADD_BOT', difficulty: 'normal', personality });
      await act({ type: 'START_GAME' });
      // The bots play until it is the person's turn to roll.
      for (let i = 0; i < 6; i += 1) {
        snap = ok(await call({ op: 'state', ...host })).snapshot;
        if (snap.state.turn.playerId === host.playerId && snap.state.turn.phase === 'AWAITING_ROLL') break;
        await runBots(host.gameId, { sql, paceMs: 0 });
      }
      snap = ok(await call({ op: 'state', ...host })).snapshot;
      expect(snap.state.turn).toMatchObject({ playerId: host.playerId, phase: 'AWAITING_ROLL' });
      // Test setup: the person owns Mumbai (ownership lives in the properties table).
      await sql`update public.properties set owner_player_id = ${host.playerId} where game_id = ${host.gameId} and property_key = 'MUMBAI'`;
      await act({ type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 1000 });
      const auction = snap.state.auction!;
      const opensAt = Date.parse(auction.createdAt) + 3000;

      // During the countdown: no move, and the runner arms itself for the moment bidding opens.
      const armed: number[] = [];
      const report = await runBots(host.gameId, { sql, paceMs: 0, defer: (delayMs) => void armed.push(delayMs) });
      expect(report.moves).toBe(0);
      expect(await nextBotCheck(host.gameId, { sql })).toMatchObject({ due: false });
      expect(armed).toHaveLength(1);
      expect(armed[0]!).toBeGreaterThan(1000);
      expect(armed[0]!).toBeLessThanOrEqual(3100);

      // When it wakes, a bot bids.
      const at = () => new Date(Math.max(Date.now(), opensAt + 100));
      expect(await nextBotCheck(host.gameId, { sql, now: at })).toMatchObject({ due: true });
      await runBots(host.gameId, { sql, paceMs: 0, now: at });
      const bids = await sql`select a.type from public.game_actions a join public.players p on p.id = a.player_id where a.game_id = ${host.gameId} and p.bot_difficulty is not null and a.type = 'PLACE_BID'`;
      expect(bids.length).toBeGreaterThan(0);
      await ledgerOk(host.gameId);
    });

    it('with hidden finances, a person’s snapshot never carries a bot’s cash', async () => {
      const g = await hostWithBots(2, { financialPrivacy: 'hidden' });
      ok(await g.act({ type: 'START_GAME' }));
      await runBots(g.host.gameId, deps);
      const snap: GameSnapshot = ok(await call({ op: 'state', gameId: g.host.gameId, playerId: g.host.playerId, token: g.host.token })).snapshot;
      for (const p of snap.state.players) if (p.bot) expect(p.balance).toBe(0);
    });
  });

  describe('matchmaking: opt-in bot filling', () => {
    beforeEach(async () => {
      await sql`delete from public.matchmaking_tickets`;
      await sql`delete from public.matchmaking_matches`;
      await sql`update public.matchmaking_runs set last_run_at = null`;
      await sql`update public.matchmaking_settings set value = 1 where key = 'bot_fill_enabled'`;
    });

    function as<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return sql.begin(async (tx: Tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
        await tx.unsafe('set local role authenticated');
        return fn(tx);
      }) as Promise<T>;
    }
    async function newPlayer(): Promise<string> {
      const [row] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
      await as(row!.id as string, (tx) => tx`select public.init_profile()`);
      return row!.id as string;
    }
    const rpc = (user: string, name: string, ...args: unknown[]) =>
      as(user, async (tx) => (await tx.unsafe(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args as never[]))[0]!.r as Json);
    const waitInQueue = () =>
      sql.begin(async (tx: Tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update public.matchmaking_tickets set queued_at = queued_at - interval '120 seconds' where status = 'QUEUED'`;
      });

    async function matchOf(users: string[], allow: boolean[]) {
      for (const [i, u] of users.entries()) expect(await rpc(u, 'matchmaking_enqueue', 'classic', null, allow[i])).toMatchObject({ ok: true });
      await waitInQueue();
      await runTick(worker, { force: true });
      return (await rpc(users[0]!, 'matchmaking_state')).match as Json;
    }

    it('two people who both asked for bots get a table filled to the preferred size, and the game seats the bots', async () => {
      const users = [await newPlayer(), await newPlayer()];
      const match = await matchOf(users, [true, true]);
      expect(match).toMatchObject({ player_count: 2, bot_seats: 2 });
      for (const u of users) expect(await rpc(u, 'matchmaking_ready', match.id, token())).toMatchObject({ ok: true });
      await runTick(worker, { force: true });
      const game = (await rpc(users[0]!, 'matchmaking_state')).live_game as Json;
      const seats = await sql`select bot_difficulty, user_id from public.players where game_id = ${game.game_id}`;
      expect(seats.filter((s) => s.bot_difficulty).length).toBe(2);
      expect(seats.filter((s) => s.user_id).length).toBe(2);
      expect((await sql`select status from public.games where id = ${game.game_id}`)[0]!.status).toBe('ACTIVE');
    });

    it('a game started with bot seats starts its bot runner at once; one without bots does not', async () => {
      const started: string[] = [];
      const withHook: MatchmakingDeps = { ...worker, startBots: (gameId) => void started.push(gameId) };
      const users = [await newPlayer(), await newPlayer()];
      for (const u of users) expect(await rpc(u, 'matchmaking_enqueue', 'classic', null, true)).toMatchObject({ ok: true });
      await waitInQueue();
      await runTick(withHook, { force: true });
      const match = (await rpc(users[0]!, 'matchmaking_state')).match as Json;
      for (const u of users) expect(await rpc(u, 'matchmaking_ready', match.id, token())).toMatchObject({ ok: true });
      await runTick(withHook, { force: true });
      const game = (await rpc(users[0]!, 'matchmaking_state')).live_game as Json;
      expect(started).toEqual([game.game_id]);

      await sql`delete from public.matchmaking_tickets`;
      await sql`delete from public.matchmaking_matches`;
      await sql`update public.matchmaking_runs set last_run_at = null`;
      const people = [await newPlayer(), await newPlayer()];
      for (const u of people) expect(await rpc(u, 'matchmaking_enqueue', 'classic', null, false)).toMatchObject({ ok: true });
      await waitInQueue();
      await runTick(withHook, { force: true });
      const plain = (await rpc(people[0]!, 'matchmaking_state')).match as Json;
      for (const u of people) expect(await rpc(u, 'matchmaking_ready', plain.id, token())).toMatchObject({ ok: true });
      await runTick(withHook, { force: true });
      expect(started).toHaveLength(1);
    });

    it('no bots unless every person asked; parties cannot ask; the setting switches it off', async () => {
      const mixed = await matchOf([await newPlayer(), await newPlayer()], [true, false]);
      expect(mixed).toMatchObject({ bot_seats: 0 });
      await sql`delete from public.matchmaking_tickets`;
      await sql`delete from public.matchmaking_matches`;
      await sql`update public.matchmaking_runs set last_run_at = null`;
      await sql`update public.matchmaking_settings set value = 0 where key = 'bot_fill_enabled'`;
      const off = await matchOf([await newPlayer(), await newPlayer()], [true, true]);
      expect(off).toMatchObject({ bot_seats: 0 });
      const leader = await newPlayer();
      await rpc(leader, 'party_create', 'classic');
      expect(await rpc(leader, 'matchmaking_enqueue', 'classic', null, true)).toMatchObject({ ok: false, code: 'BOTS_SOLO_ONLY' });
    });

    it('an app that does not know about bots queues exactly as before', async () => {
      const u = await newPlayer();
      const res = await rpc(u, 'matchmaking_enqueue', 'classic', null);
      expect(res).toMatchObject({ ok: true, ticket: { allow_bots: false } });
    });
  });
});
