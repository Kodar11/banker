/// <reference types="node" />
/**
 * Integration tests for the game-action Edge Function handler against a real
 * Postgres with the production migrations applied.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import type { ApiResponse, GameAction, GameSnapshot, StateBroadcast } from '../../supabase/functions/_shared/engine/index.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('game-action handler (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedDice: number[] = [];
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcast: async (gameId, payload) => {
        broadcasts.push({ gameId, payload });
      },
      random: () => {
        const face = queuedDice.shift();
        return face === undefined ? Math.random() : (face - 1) / 6 + 0.01;
      },
    };
  });

  afterAll(async () => {
    await sql?.end();
  });

  const token = () => randomBytes(32).toString('hex');

  async function call(body: unknown): Promise<ApiResponse> {
    return (await handleRequest(body, deps)).body;
  }

  function ok(res: ApiResponse): Ok {
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  interface Seat {
    playerId: string;
    token: string;
  }

  async function setupGame(names = ['Asha', 'Bilal', 'Chitra']) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host }));
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    const code = created.snapshot.state.code;
    for (const name of rest) {
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code, name }));
      seats[name] = { playerId: joined.playerId, token: t };
    }
    let version = (await state(gameId, seats[host!]!)).state.version;
    const act = async (name: string, action: GameAction, opts: { actionId?: string; expectedVersion?: number } = {}) => {
      const seat = seats[name]!;
      const res = await call({
        op: 'action',
        gameId,
        playerId: seat.playerId,
        token: seat.token,
        actionId: opts.actionId ?? randomUUID(),
        expectedVersion: opts.expectedVersion ?? version,
        action,
      });
      if (res.ok) version = res.snapshot.state.version;
      return res;
    };
    return { gameId, code, seats, act, get version() { return version; } };
  }

  async function state(gameId: string, seat: Seat): Promise<GameSnapshot> {
    return ok(await call({ op: 'state', gameId, playerId: seat.playerId, token: seat.token })).snapshot;
  }

  async function ledgerOk(gameId: string) {
    const rows = await sql`select * from public.verify_game_ledger(${gameId})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ok).toBe(true);
  }

  it('create → join → start: lobby, starting cash, ledger', async () => {
    const g = await setupGame();
    expect(g.code).toMatch(/^\d{6}$/);
    const lobby = await state(g.gameId, g.seats.Asha!);
    expect(lobby.state.status).toBe('WAITING');
    expect(lobby.state.players.map((p) => p.name)).toEqual(['Asha', 'Bilal', 'Chitra']);
    expect(broadcasts.some((b) => b.gameId === g.gameId)).toBe(true);

    ok(await g.act('Asha', { type: 'START_GAME' }));
    const snap = await state(g.gameId, g.seats.Bilal!);
    expect(snap.state.status).toBe('ACTIVE');
    expect(snap.state.players.every((p) => p.balance === 25000)).toBe(true);
    expect(snap.transactions.filter((t) => t.type === 'STARTING_FUNDS')).toHaveLength(3);
    await ledgerOk(g.gameId);
  });

  it('rejects bad tokens, unknown codes, and joining a started game', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const bad = await call({ op: 'state', gameId: g.gameId, playerId: g.seats.Asha!.playerId, token: token() });
    expect(bad).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const noGame = await call({ op: 'join', actionId: randomUUID(), token: token(), code: '000000', name: 'X' });
    expect(noGame.ok).toBe(false);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    const late = await call({ op: 'join', actionId: randomUUID(), token: token(), code: g.code, name: 'Late' });
    expect(late).toMatchObject({ ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'This game has already started.' } });
    const name = await setupGame(['Dee', 'Eve']);
    const dup = await call({ op: 'join', actionId: randomUUID(), token: token(), code: name.code, name: 'eve' });
    expect(dup).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } });
  });

  it('rejects malformed requests and client-supplied state', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    const res = await g.act('Asha', { type: 'ROLL_DICE', dice: [6, 6] } as never);
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const garbage = await handleRequest({ op: 'action', gameId: 'nope' }, deps);
    expect(garbage.status).toBe(400);
  });

  describe('idempotency (same action_id twice)', () => {
    it('duplicate create returns the same game', async () => {
      const t = token();
      const actionId = randomUUID();
      const a = ok(await call({ op: 'create', actionId, token: t, name: 'Host' }));
      const b = ok(await call({ op: 'create', actionId, token: t, name: 'Host' }));
      expect(b.gameId).toBe(a.gameId);
      expect(b.duplicate).toBe(true);
    });

    it('duplicate join does not add a second player', async () => {
      const g = await setupGame(['Asha']);
      const t = token();
      const actionId = randomUUID();
      const a = ok(await call({ op: 'join', actionId, token: t, code: g.code, name: 'Bilal' }));
      const b = ok(await call({ op: 'join', actionId, token: t, code: g.code, name: 'Bilal' }));
      expect(b.playerId).toBe(a.playerId);
      expect(b.snapshot.state.players).toHaveLength(2);
    });

    it('duplicate dice action rolls once', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      const actionId = randomUUID();
      const v = g.version;
      queuedDice = [3, 2];
      const first = ok(await g.act('Asha', { type: 'ROLL_DICE' }, { actionId, expectedVersion: v }));
      queuedDice = [6, 6];
      const second = ok(await g.act('Asha', { type: 'ROLL_DICE' }, { actionId, expectedVersion: v }));
      expect(second.duplicate).toBe(true);
      expect(second.snapshot.state.version).toBe(first.snapshot.state.version);
      expect(second.snapshot.state.turn.roll?.total).toBe(5);
      expect(second.snapshot.events.filter((e) => e.type === 'DICE_ROLLED')).toHaveLength(1);
    });

    it('duplicate buy charges once', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [3, 2]; // Railway
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      const actionId = randomUUID();
      const v = g.version;
      const results = await Promise.all([
        g.act('Asha', { type: 'BUY_PROPERTY' }, { actionId, expectedVersion: v }),
        g.act('Asha', { type: 'BUY_PROPERTY' }, { actionId, expectedVersion: v }),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      const snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.transactions.filter((t) => t.type === 'PROPERTY_PURCHASE')).toHaveLength(1);
      expect(snap.state.players.find((p) => p.name === 'Asha')!.balance).toBe(25000 - 9500);
      await ledgerOk(g.gameId);
    });

    it('duplicate payment, loan and transfer apply once', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [2, 2]; // Income Tax
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      const pay = randomUUID();
      ok(await g.act('Asha', { type: 'PAY_TAX' }, { actionId: pay }));
      expect((await g.act('Asha', { type: 'PAY_TAX' }, { actionId: pay, expectedVersion: g.version - 1 })).ok).toBe(true);
      const loan = randomUUID();
      ok(await g.act('Bilal', { type: 'REQUEST_LOAN', amount: 5000 }, { actionId: loan }));
      ok(await g.act('Bilal', { type: 'REQUEST_LOAN', amount: 5000 }, { actionId: loan }));
      const transfer = randomUUID();
      ok(await g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.seats.Asha!.playerId, amount: 700 }, { actionId: transfer }));
      ok(await g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.seats.Asha!.playerId, amount: 700 }, { actionId: transfer }));
      const snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.transactions.filter((t) => t.type === 'TAX_PAYMENT')).toHaveLength(1);
      expect(snap.state.loans).toHaveLength(1);
      expect(snap.transactions.filter((t) => t.type === 'PLAYER_TRANSFER')).toHaveLength(1);
      await ledgerOk(g.gameId);
    });

    it('duplicate bid is recorded once', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [3, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'DECLINE_PROPERTY' }));
      const auctionId = (await state(g.gameId, g.seats.Asha!)).state.auction!.id;
      const bid = randomUUID();
      const v = g.version;
      ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 1000 }, { actionId: bid, expectedVersion: v }));
      ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 1000 }, { actionId: bid, expectedVersion: v }));
      const bids = await sql`select * from public.auction_bids where auction_id = ${auctionId}`;
      expect(bids).toHaveLength(1);
    });
  });

  describe('stale state & concurrency', () => {
    it('rejects a stale-sensitive action against an old version, allows side actions', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [3, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      const seen = g.version;
      ok(await g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.seats.Chitra!.playerId, amount: 10 }));
      const stale = await g.act('Asha', { type: 'BUY_PROPERTY' }, { expectedVersion: seen });
      expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
      const sideStale = await g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.seats.Bilal!.playerId, amount: 10 }, { expectedVersion: seen });
      expect(sideStale.ok).toBe(true);
      ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
    });

    it('two simultaneous equal bids: exactly one wins, auction stays consistent', async () => {
      const g = await setupGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [3, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'DECLINE_PROPERTY' }));
      const auctionId = (await state(g.gameId, g.seats.Asha!)).state.auction!.id;
      const v = g.version;
      const results = await Promise.all(
        ['Bilal', 'Chitra', 'Dev'].map((n) => g.act(n, { type: 'PLACE_BID', auctionId, amount: 2000 }, { expectedVersion: v })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
      const snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.state.auction).toMatchObject({ highBid: 2000 });
      const bids = await sql`select * from public.auction_bids where auction_id = ${auctionId}`;
      expect(bids).toHaveLength(1);
    });

    it('many parallel transfers keep every balance equal to its ledger', async () => {
      const g = await setupGame(['Asha', 'Bilal', 'Chitra']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      const names = ['Asha', 'Bilal', 'Chitra'];
      const jobs = Array.from({ length: 30 }, (_, i) => {
        const from = names[i % 3]!;
        const to = names[(i + 1) % 3]!;
        return g.act(from, { type: 'TRANSFER_MONEY', toPlayerId: g.seats[to]!.playerId, amount: 100 + i });
      });
      const results = await Promise.all(jobs);
      expect(results.every((r) => r.ok)).toBe(true);
      await ledgerOk(g.gameId);
      const snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.state.players.reduce((s, p) => s + p.balance, 0)).toBe(75000);
      const [counted] = await sql`select count(*)::int as count from public.game_actions where game_id = ${g.gameId}`;
      const count = counted!.count as number;
      // Every recorded action (create, joins, start, 30 transfers) bumped the version exactly once.
      expect(snap.state.version).toBe(count);
    });
  });

  it('full turn: rent between players, auction win, loan, pause/resume, undo, finish', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    queuedDice = [3, 2];
    ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
    ok(await g.act('Asha', { type: 'END_TURN' }));
    queuedDice = [3, 2]; // Bilal → Railway, owned by Asha
    ok(await g.act('Bilal', { type: 'ROLL_DICE' }));
    let snap = await state(g.gameId, g.seats.Bilal!);
    expect(snap.state.turn.pending).toMatchObject({ reason: 'RENT', amount: 1000 });
    ok(await g.act('Bilal', { type: 'PAY_RENT' }));
    // Undo the rent with Asha's approval.
    snap = await state(g.gameId, g.seats.Bilal!);
    ok(await g.act('Bilal', { type: 'REQUEST_UNDO', targetActionId: snap.state.lastUndoable!.actionId }));
    snap = await state(g.gameId, g.seats.Asha!);
    ok(await g.act('Asha', { type: 'APPROVE_UNDO', requestId: snap.state.undoRequest!.id }));
    snap = await state(g.gameId, g.seats.Asha!);
    expect(snap.transactions.map((t) => t.type)).toEqual(expect.arrayContaining(['RENT_PAYMENT', 'UNDO_REVERSAL']));
    expect(snap.state.players.find((p) => p.name === 'Bilal')!.balance).toBe(25000);

    ok(await g.act('Bilal', { type: 'REQUEST_LOAN', amount: 3000 }));
    ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
    expect(await g.act('Bilal', { type: 'END_TURN' })).toMatchObject({ ok: false, error: { code: 'GAME_PAUSED' } });
    ok(await g.act('Bilal', { type: 'RESUME_GAME' }));
    ok(await g.act('Bilal', { type: 'END_TURN' }));
    ok(await g.act('Asha', { type: 'END_GAME' }));
    snap = await state(g.gameId, g.seats.Asha!);
    expect(snap.state.status).toBe('FINISHED');
    expect(snap.state.winnerId).toBeTruthy();
    await ledgerOk(g.gameId);
  });

  it('auction win is persisted atomically with ownership', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    queuedDice = [3, 2];
    ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    ok(await g.act('Asha', { type: 'DECLINE_PROPERTY' }));
    const auctionId = (await state(g.gameId, g.seats.Asha!)).state.auction!.id;
    ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 3000 }));
    ok(await g.act('Asha', { type: 'PASS_AUCTION', auctionId }));
    const [prop] = await sql`select owner_player_id from public.properties where game_id = ${g.gameId} and property_key = 'RAILWAY'`;
    expect(prop!.owner_player_id).toBe(g.seats.Bilal!.playerId);
    const [auction] = await sql`select status, winner_player_id from public.auctions where id = ${auctionId}`;
    expect(auction).toMatchObject({ status: 'CLOSED', winner_player_id: g.seats.Bilal!.playerId });
    await ledgerOk(g.gameId);
  });

  it('host can end a paused game (persists without violating constraints)', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    ok(await g.act('Bilal', { type: 'PAUSE_GAME' }));
    ok(await g.act('Asha', { type: 'END_GAME' }));
    const [row] = await sql`select status, paused_at from public.games where id = ${g.gameId}`;
    expect(row).toMatchObject({ status: 'FINISHED', paused_at: null });
  });

  it('expired games reject actions', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'START_GAME' }));
    await sql`update public.games set expires_at = now() - interval '1 minute' where id = ${g.gameId}`;
    expect(await g.act('Asha', { type: 'ROLL_DICE' })).toMatchObject({ ok: false, error: { code: 'GAME_EXPIRED' } });
  });

  it('fuzz: random play through the handler never hits a DB constraint the engine missed', async () => {
    for (let game = 0; game < 3; game += 1) {
      const names = ['Asha', 'Bilal', 'Chitra'];
      const g = await setupGame(names);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      let seed = 7 + game;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
      const nameOf = (id: string) => names.find((n) => g.seats[n]!.playerId === id)!;
      for (let step = 0; step < 120; step += 1) {
        const snap = await state(g.gameId, g.seats.Asha!);
        const s = snap.state;
        if (s.status === 'FINISHED') break;
        const who = nameOf(s.turn.playerId!);
        const p = s.turn.pending;
        let res: ApiResponse;
        const r = rand();
        if (r < 0.05) res = await g.act(pick(names), { type: 'PAUSE_GAME' });
        else if (s.status === 'PAUSED') res = await g.act(pick(names), { type: 'RESUME_GAME' });
        else if (r < 0.1) res = await g.act(pick(names), { type: 'REQUEST_LOAN', amount: 1000 });
        else if (r < 0.15) {
          const mine = Object.values(s.properties).filter((x) => x.ownerId === g.seats[who]!.playerId);
          res = mine.length ? await g.act(who, { type: pick(['BUILD_HOUSE', 'MORTGAGE_PROPERTY', 'SELL_BUILDING', 'UNMORTGAGE_PROPERTY'] as const), propertyKey: pick(mine).key }) : await g.act(who, { type: 'END_TURN' });
        } else if (r < 0.18 && s.lastUndoable) res = await g.act(nameOf(s.lastUndoable.actorId), { type: 'REQUEST_UNDO', targetActionId: s.lastUndoable.actionId });
        else if (r < 0.2 && s.undoRequest) res = await g.act(nameOf(s.undoRequest.approverIds[0]!), { type: 'APPROVE_UNDO', requestId: s.undoRequest.id });
        else if (s.turn.phase === 'AWAITING_ROLL') res = await g.act(who, { type: 'ROLL_DICE' });
        else if (s.turn.phase === 'AWAITING_DECISION') res = await g.act(who, { type: rand() < 0.6 ? 'BUY_PROPERTY' : 'DECLINE_PROPERTY' });
        else if (s.turn.phase === 'AUCTION' && s.auction) {
          const a = s.auction;
          const bidder = pick(a.participantIds.filter((id) => !a.passedIds.includes(id) && id !== a.highBidderId));
          res = bidder
            ? await g.act(nameOf(bidder), rand() < 0.5 ? { type: 'PLACE_BID', auctionId: a.id, amount: (a.highBid ?? 0) + 100 } : { type: 'PASS_AUCTION', auctionId: a.id })
            : await g.act(who, { type: 'CLOSE_AUCTION', auctionId: a.id });
        } else if (s.turn.phase === 'AWAITING_PAYMENT' && p?.kind === 'PAYMENT') {
          const me = s.players.find((x) => x.id === s.turn.playerId)!;
          res = await g.act(who, me.balance >= p.amount ? { type: `PAY_${p.reason}` as 'PAY_RENT' } : { type: 'DECLARE_BANKRUPTCY' });
        } else if (s.turn.phase === 'AWAITING_CARD') res = await g.act(who, { type: 'RESOLVE_CARD', resolution: pick(['PAY', 'RECEIVE', 'NONE'] as const), amount: 300 });
        else res = await g.act(who, { type: 'END_TURN' });
        if (!res.ok) expect(res.error.code).not.toBe('SERVER_ERROR');
      }
      await ledgerOk(g.gameId);
    }
  }, 120_000);

  describe('database guards', () => {
    it('ledger tables are append-only', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await expect(sql`update public.transactions set amount = 1 where game_id = ${g.gameId}`).rejects.toThrow(/append-only/);
      await expect(sql`delete from public.transactions where game_id = ${g.gameId}`).rejects.toThrow(/append-only/);
      await expect(sql`delete from public.game_events where game_id = ${g.gameId}`).rejects.toThrow(/append-only/);
    });

    it('balances can never go negative; a property cannot have two rows', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      await expect(sql`update public.players set balance = -1 where game_id = ${g.gameId}`).rejects.toThrow(/check/);
      await expect(
        sql`insert into public.properties (game_id, property_key) values (${g.gameId}, 'MUMBAI')`,
      ).rejects.toThrow(/duplicate key/);
    });

    it('client roles (anon/authenticated) cannot read or write any table', async () => {
      for (const role of ['anon', 'authenticated']) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx`select * from public.games limit 1`;
          }),
        ).rejects.toThrow(/permission denied/);
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx`update public.players set balance = 999999`;
          }),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it('expired sessions can be purged (cascade bypasses append-only only during purge)', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await sql`update public.games set expires_at = now() - interval '2 days' where id = ${g.gameId}`;
      const [purged] = await sql`select public.purge_expired_games() as removed`;
      const removed = purged!.removed as number;
      expect(removed).toBeGreaterThanOrEqual(1);
      const rows = await sql`select 1 from public.transactions where game_id = ${g.gameId}`;
      expect(rows).toHaveLength(0);
    });
  });
});
