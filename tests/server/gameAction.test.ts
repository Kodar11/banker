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
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('game-action handler (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedDice: number[] = [];
  /** Raw RNG values, used before queued dice (pins START_GAME's turn-order draw). */
  let queuedRandoms: number[] = [];
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcast: async (gameId, payload) => {
        broadcasts.push({ gameId, payload });
      },
      random: () => {
        const raw = queuedRandoms.shift();
        if (raw !== undefined) return raw;
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
    const act = async (
      name: string,
      action: GameAction,
      /** START_GAME only — `order`: the turn order the draw produces (default: joining order, so tests can script turns by name); `randomOrder`: a real draw. */
      opts: { actionId?: string; expectedVersion?: number; order?: string[]; randomOrder?: boolean } = {},
    ) => {
      const seat = seats[name]!;
      if (action.type === 'START_GAME' && !opts.randomOrder) queuedRandoms = orderRandoms(names, opts.order ?? names);
      const res = await call({
        op: 'action',
        gameId,
        playerId: seat.playerId,
        token: seat.token,
        actionId: opts.actionId ?? randomUUID(),
        expectedVersion: opts.expectedVersion ?? version,
        action,
      });
      queuedRandoms = [];
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

  describe('random starting player', () => {
    const NAMES = ['Tanmay', 'Shamin', 'Ram', 'Priya']; // Tanmay hosts
    const ORDER = ['Priya', 'Tanmay', 'Ram', 'Shamin'];
    const seatRows = async (gameId: string) =>
      (await sql`select name, seat from public.players where game_id = ${gameId} order by seat`).map((r) => `${r.seat}:${r.name}`);
    const quietTurn = async (g: Awaited<ReturnType<typeof setupGame>>, name: string) => {
      await sql`update public.players set position = 0 where game_id = ${g.gameId} and id = ${g.seats[name]!.playerId}`;
      queuedDice = [2, 3]; // Income Tax while owning nothing
      ok(await g.act(name, { type: 'ROLL_DICE' }));
      ok(await g.act(name, { type: 'END_TURN' }));
    };

    it('START_GAME stores the drawn order as seats, in the same transaction that activates the game', async () => {
      const g = await setupGame(NAMES);
      expect(await seatRows(g.gameId)).toEqual(['0:Tanmay', '1:Shamin', '2:Ram', '3:Priya']);
      const started = ok(await g.act('Tanmay', { type: 'START_GAME' }, { order: ORDER }));
      expect(started.snapshot.state.status).toBe('ACTIVE');
      expect(started.snapshot.state.players.map((p) => p.name)).toEqual(ORDER);
      expect(started.snapshot.state.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
      expect(started.snapshot.state.turn).toMatchObject({ playerId: g.seats.Priya!.playerId, number: 1, phase: 'AWAITING_ROLL' });
      expect(await seatRows(g.gameId)).toEqual(['0:Priya', '1:Tanmay', '2:Ram', '3:Shamin']);
      const [game] = await sql`select status, current_player_id, turn_number, host_player_id from public.games where id = ${g.gameId}`;
      expect(game).toMatchObject({ status: 'ACTIVE', current_player_id: g.seats.Priya!.playerId, turn_number: 1, host_player_id: g.seats.Tanmay!.playerId });
      await ledgerOk(g.gameId);
    });

    it('every phone, and every reconnect, is served the same order and the same current player', async () => {
      const g = await setupGame(NAMES);
      ok(await g.act('Tanmay', { type: 'START_GAME' }, { order: ORDER }));
      queuedRandoms = [0.1, 0.1, 0.1]; // would produce another order if anything drew again
      for (let round = 0; round < 2; round += 1) {
        for (const name of NAMES) {
          const snap = await state(g.gameId, g.seats[name]!);
          expect(snap.state.players.map((p) => p.name)).toEqual(ORDER);
          expect(snap.state.turn.playerId).toBe(g.seats.Priya!.playerId);
          expect(snap.state.turn.number).toBe(1);
        }
      }
      queuedRandoms = [];
    });

    it('the draw happens once: a retried START_GAME and a second START_GAME both leave the order alone', async () => {
      const g = await setupGame(NAMES);
      const actionId = randomUUID();
      const v = g.version;
      ok(await g.act('Tanmay', { type: 'START_GAME' }, { actionId, expectedVersion: v, order: ORDER }));
      const retry = ok(await g.act('Tanmay', { type: 'START_GAME' }, { actionId, expectedVersion: v, order: ['Ram', 'Shamin', 'Priya', 'Tanmay'] }));
      expect(retry.duplicate).toBe(true);
      const again = await g.act('Tanmay', { type: 'START_GAME' }, { order: ['Ram', 'Shamin', 'Priya', 'Tanmay'] });
      expect(again).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      expect(await seatRows(g.gameId)).toEqual(['0:Priya', '1:Tanmay', '2:Ram', '3:Shamin']);
      const snap = await state(g.gameId, g.seats.Ram!);
      expect(snap.events.filter((e) => e.type === 'GAME_STARTED')).toHaveLength(1);
      expect(snap.transactions.filter((t) => t.type === 'STARTING_FUNDS')).toHaveLength(4);
    });

    it('two concurrent START_GAME requests: one draw', async () => {
      const g = await setupGame(NAMES);
      const v = g.version;
      const results = await Promise.all([
        g.act('Tanmay', { type: 'START_GAME' }, { expectedVersion: v, randomOrder: true }),
        g.act('Tanmay', { type: 'START_GAME' }, { expectedVersion: v, randomOrder: true }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const snap = await state(g.gameId, g.seats.Tanmay!);
      expect(snap.events.filter((e) => e.type === 'GAME_STARTED')).toHaveLength(1);
      expect(snap.state.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
      expect(snap.state.turn.playerId).toBe(snap.state.players[0]!.id);
    });

    it('turns follow the stored order; nobody but the drawn player can take turn 1', async () => {
      const g = await setupGame(NAMES);
      ok(await g.act('Tanmay', { type: 'START_GAME' }, { order: ORDER }));
      expect(await g.act('Tanmay', { type: 'ROLL_DICE' })).toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } });
      for (const name of [...ORDER, 'Priya']) {
        expect((await state(g.gameId, g.seats.Ram!)).state.turn.playerId).toBe(g.seats[name]!.playerId);
        await quietTurn(g, name);
      }
      expect(await seatRows(g.gameId)).toEqual(['0:Priya', '1:Tanmay', '2:Ram', '3:Shamin']);
    });

    it('with the real RNG the host does not always start', async () => {
      const firsts = new Set<string>();
      for (let i = 0; i < 24 && firsts.size < 2; i += 1) {
        const g = await setupGame(['Tanmay', 'Shamin']);
        const started = ok(await g.act('Tanmay', { type: 'START_GAME' }, { randomOrder: true }));
        firsts.add(started.snapshot.state.players.find((p) => p.id === started.snapshot.state.turn.playerId)!.name);
      }
      expect([...firsts].sort()).toEqual(['Shamin', 'Tanmay']);
    });
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
      queuedDice = [1, 2]; // Railway (square 3)
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
      // Asha buys Railway (3), then on her next turn rolls 2 → Income Tax (5): 1 property × ₹50.
      queuedDice = [1, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
      ok(await g.act('Asha', { type: 'END_TURN' }));
      for (const n of ['Bilal', 'Chitra']) {
        queuedDice = [2, 3]; // Income Tax with no properties: nothing to pay
        ok(await g.act(n, { type: 'ROLL_DICE' }));
        ok(await g.act(n, { type: 'END_TURN' }));
      }
      queuedDice = [1, 1];
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
      expect(snap.transactions.filter((t) => t.type === 'TAX_PAYMENT').map((t) => t.amount)).toEqual([50]);
      expect(snap.state.loans).toHaveLength(1);
      expect(snap.transactions.filter((t) => t.type === 'PLAYER_TRANSFER')).toHaveLength(1);
      await ledgerOk(g.gameId);
    });

    it('duplicate bid is recorded once', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [1, 2];
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
      queuedDice = [1, 2];
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
      queuedDice = [1, 2];
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
    queuedDice = [1, 2];
    ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
    ok(await g.act('Asha', { type: 'END_TURN' }));
    queuedDice = [1, 2]; // Bilal → Railway, owned by Asha
    ok(await g.act('Bilal', { type: 'ROLL_DICE' }));
    let snap = await state(g.gameId, g.seats.Bilal!);
    expect(snap.state.turn.pending).toMatchObject({ reason: 'RENT', amount: 1000 });
    ok(await g.act('Bilal', { type: 'PAY_RENT' }));
    // Undo the rent with Asha's approval.
    snap = await state(g.gameId, g.seats.Bilal!);
    ok(await g.act('Bilal', { type: 'REQUEST_UNDO', targetActionId: snap.state.undoStack.at(-1)!.actionId }));
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
    queuedDice = [1, 2];
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

  describe('Classic rules: Jail, Rest House, Club, taxes', () => {
    const playerRow = async (gameId: string, playerId: string) => {
      const [row] = await sql`select balance, position, in_jail, jail_turns_left, skip_turns from public.players
        where game_id = ${gameId} and id = ${playerId}`;
      return row!;
    };
    /** Test setup only: put a player on a board index (the handler loads state from the tables). */
    const place = (gameId: string, playerId: string, position: number) =>
      sql`update public.players set position = ${position} where game_id = ${gameId} and id = ${playerId}`;
    /** A turn that moves no money: Income Tax while owning nothing. */
    const quietTurn = async (g: Awaited<ReturnType<typeof setupGame>>, name: string) => {
      await place(g.gameId, g.seats[name]!.playerId, 0);
      queuedDice = [2, 3];
      ok(await g.act(name, { type: 'ROLL_DICE' }));
      ok(await g.act(name, { type: 'END_TURN' }));
    };
    const jailedAsha = async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [4, 5]; // Start + 9 = Jail
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'END_TURN' }));
      await quietTurn(g, 'Bilal');
      await quietTurn(g, 'Chitra');
      return g;
    };

    it('Jail: entering is persisted; rolling is refused; paying ₹500 is atomic and idempotent', async () => {
      const g = await jailedAsha();
      expect(await playerRow(g.gameId, g.seats.Asha!.playerId)).toMatchObject({ position: 9, in_jail: true, jail_turns_left: 3 });
      queuedDice = [6, 6];
      expect(await g.act('Asha', { type: 'ROLL_DICE' })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      const actionId = randomUUID();
      const v = g.version;
      const results = await Promise.all([
        g.act('Asha', { type: 'PAY_JAIL_FINE' }, { actionId, expectedVersion: v }),
        g.act('Asha', { type: 'PAY_JAIL_FINE' }, { actionId, expectedVersion: v }),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      // A second, different attempt is refused: not in Jail any more.
      expect(await g.act('Asha', { type: 'PAY_JAIL_FINE' })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      const snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.transactions.filter((t) => t.type === 'JAIL_FINE').map((t) => [t.amount, t.toPlayerId])).toEqual([[500, null]]);
      expect(await playerRow(g.gameId, g.seats.Asha!.playerId)).toMatchObject({ balance: 24500, in_jail: false, jail_turns_left: 0 });
      // Every client reads the same Jail state; the freed player rolls normally.
      expect(snap.state.players.find((p) => p.name === 'Asha')).toMatchObject({ inJail: false, jailTurnsLeft: 0 });
      queuedDice = [1, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      expect((await playerRow(g.gameId, g.seats.Asha!.playerId)).position).toBe(12);
      await ledgerOk(g.gameId);
    });

    it('Jail: three missed turns, then released exactly once (duplicate STAY applies once)', async () => {
      const g = await jailedAsha();
      for (const left of [2, 1, 0]) {
        const actionId = randomUUID();
        const v = g.version;
        ok(await g.act('Asha', { type: 'STAY_IN_JAIL' }, { actionId, expectedVersion: v }));
        const dup = ok(await g.act('Asha', { type: 'STAY_IN_JAIL' }, { actionId, expectedVersion: v }));
        expect(dup.duplicate).toBe(true);
        expect(await playerRow(g.gameId, g.seats.Asha!.playerId)).toMatchObject({ in_jail: left > 0, jail_turns_left: left, balance: 25000 });
        await quietTurn(g, 'Bilal');
        await quietTurn(g, 'Chitra');
      }
      const snap = await state(g.gameId, g.seats.Chitra!);
      expect(snap.events.filter((e) => e.type === 'JAIL_RELEASED')).toHaveLength(1);
      expect(snap.events.filter((e) => e.type === 'JAIL_STAYED')).toHaveLength(2);
      queuedDice = [1, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    });

    it('Jail: the database refuses an inconsistent Jail state', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      await expect(sql`update public.players set in_jail = true, jail_turns_left = 0 where id = ${g.seats.Asha!.playerId}`).rejects.toThrow(
        /players_jail_state_check/,
      );
      await expect(sql`update public.players set in_jail = true, jail_turns_left = 4 where id = ${g.seats.Asha!.playerId}`).rejects.toThrow(
        /check/,
      );
    });

    it('Rest House: ₹100 from each other player in the same action, then the next turn is skipped', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await place(g.gameId, g.seats.Asha!.playerId, 21);
      queuedDice = [3, 3]; // 21 + 6 = Rest House
      const res = ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      const collected = res.snapshot.transactions.filter((t) => t.type === 'REST_HOUSE_COLLECTION');
      expect(collected).toHaveLength(2);
      expect(new Set(collected.map((t) => t.actionId)).size).toBe(1);
      expect(await playerRow(g.gameId, g.seats.Asha!.playerId)).toMatchObject({ balance: 25200, skip_turns: 1 });
      ok(await g.act('Asha', { type: 'END_TURN' }));
      await quietTurn(g, 'Bilal');
      await quietTurn(g, 'Chitra');
      const snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.state.turn.playerId).toBe(g.seats.Bilal!.playerId); // Asha skipped
      expect(await playerRow(g.gameId, g.seats.Asha!.playerId)).toMatchObject({ skip_turns: 0 });
      await ledgerOk(g.gameId);
    });

    it('Club: ₹100 to each other player; Income Tax and Wealth Taxes are computed by the server', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await place(g.gameId, g.seats.Asha!.playerId, 13);
      queuedDice = [2, 3]; // 13 + 5 = Club
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'PAY_CLUB' }));
      let snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.transactions.filter((t) => t.type === 'CLUB_PAYMENT').map((t) => t.amount)).toEqual([100, 100]);
      expect(snap.state.players.map((p) => p.balance)).toEqual([24800, 25100, 25100]);
      ok(await g.act('Asha', { type: 'END_TURN' }));

      // Bilal owns 3 sites (one with 2 houses, one with a hotel) — test setup.
      const bilal = g.seats.Bilal!.playerId;
      await sql`update public.properties set owner_player_id = ${bilal} where game_id = ${g.gameId} and property_key in ('DELHI', 'MUMBAI', 'RAILWAY')`;
      await sql`update public.properties set houses = 2 where game_id = ${g.gameId} and property_key = 'DELHI'`;
      await sql`update public.properties set hotel = true where game_id = ${g.gameId} and property_key = 'MUMBAI'`;
      queuedDice = [2, 3]; // Start + 5 = Income Tax
      ok(await g.act('Bilal', { type: 'ROLL_DICE' }));
      snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.state.turn.pending).toMatchObject({ reason: 'TAX', amount: 150 });
      ok(await g.act('Bilal', { type: 'PAY_TAX' }));
      ok(await g.act('Bilal', { type: 'END_TURN' }));
      await quietTurn(g, 'Chitra');
      await quietTurn(g, 'Asha');
      await place(g.gameId, bilal, 27);
      queuedDice = [2, 2]; // 27 + 4 = Wealth Taxes
      ok(await g.act('Bilal', { type: 'ROLL_DICE' }));
      snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.state.turn.pending).toMatchObject({ reason: 'TAX', amount: 400 });
      ok(await g.act('Bilal', { type: 'PAY_TAX' }));
      snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.transactions.filter((t) => t.type === 'TAX_PAYMENT').map((t) => t.amount)).toEqual([400, 150]);
      await ledgerOk(g.gameId);
    });
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
        } else if (r < 0.18 && s.undoStack.length) {
          const top = s.undoStack.at(-1)!;
          res = await g.act(nameOf(top.actorId), { type: 'REQUEST_UNDO', targetActionId: top.actionId });
        } else if (r < 0.22) {
          const open = s.trades.find((t) => t.status === 'PENDING');
          const mine = Object.values(s.properties).filter((x) => x.ownerId === g.seats[who]!.playerId);
          const other = pick(names.filter((n) => n !== who && s.players.find((x) => x.name === n)?.status === 'ACTIVE'));
          if (open) res = await g.act(nameOf(open.toPlayerId), { type: rand() < 0.6 ? 'ACCEPT_TRADE' : 'REJECT_TRADE', tradeId: open.id });
          else if (mine.length && other) {
            res = await g.act(who, {
              type: 'CREATE_TRADE',
              toPlayerId: g.seats[other]!.playerId,
              offeredPropertyKeys: [pick(mine).key],
              requestedPropertyKeys: [],
              offeredMoney: 0,
              requestedMoney: 500,
            });
          } else res = await g.act(who, { type: 'END_TURN' });
        }
        else if (r < 0.2 && s.undoRequest) res = await g.act(nameOf(s.undoRequest.approverIds[0]!), { type: 'APPROVE_UNDO', requestId: s.undoRequest.id });
        else if (s.turn.phase === 'AWAITING_ROLL' && s.players.find((x) => x.id === s.turn.playerId)?.inJail) {
          res = await g.act(who, { type: rand() < 0.5 ? 'PAY_JAIL_FINE' : 'STAY_IN_JAIL' });
        } else if (s.turn.phase === 'AWAITING_ROLL') res = await g.act(who, { type: 'ROLL_DICE' });
        else if (s.turn.phase === 'AWAITING_DECISION') res = await g.act(who, { type: rand() < 0.6 ? 'BUY_PROPERTY' : 'DECLINE_PROPERTY' });
        else if (s.turn.phase === 'AUCTION' && s.auction) {
          const a = s.auction;
          const bidder = pick(a.participantIds.filter((id) => !a.passedIds.includes(id) && id !== a.highBidderId));
          res = bidder
            ? await g.act(nameOf(bidder), rand() < 0.5 ? { type: 'PLACE_BID', auctionId: a.id, amount: (a.highBid ?? 0) + 100 } : { type: 'PASS_AUCTION', auctionId: a.id })
            : await g.act(who, { type: 'CLOSE_AUCTION', auctionId: a.id });
        } else if (s.turn.phase === 'AWAITING_PAYMENT' && p?.kind === 'PAYMENT') {
          const me = s.players.find((x) => x.id === s.turn.playerId)!;
          const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', LOAN_INTEREST: 'PAY_INTEREST', CLUB: 'PAY_CLUB' } as const;
          res = await g.act(who, me.balance >= p.amount ? { type: pay[p.reason] } : { type: 'DECLARE_BANKRUPTCY' });
        } else if (s.turn.phase === 'AWAITING_CARD') res = await g.act(who, { type: 'RESOLVE_CARD', resolution: pick(['PAY', 'RECEIVE', 'NONE'] as const), amount: 300 });
        else res = await g.act(who, { type: 'END_TURN' });
        if (!res.ok) expect(res.error.code).not.toBe('SERVER_ERROR');
      }
      await ledgerOk(g.gameId);
    }
  }, 120_000);

  describe('BUSINESS_V2 rules through the server', () => {
    const playerRow = (g: { seats: Record<string, Seat> }, name: string) => g.seats[name]!.playerId;

    it('Start crossing pays ₹1,500 and the loan interest falls due there (persisted)', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      let snap = await state(g.gameId, g.seats.Asha!);
      expect(snap.state.loans[0]).toMatchObject({ principal: 5000, totalOwed: 5000, interestAmount: 500, interestCharges: 0 });
      await sql`update public.players set position = 34 where id = ${playerRow(g, 'Asha')}`;
      queuedDice = [2, 3]; // 34 → 3 Railway, passing Start
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      snap = await state(g.gameId, g.seats.Asha!);
      const asha = snap.state.players.find((p) => p.name === 'Asha')!;
      expect(asha).toMatchObject({ position: 3, circuits: 1, balance: 25000 + 5000 + 1500 - 500 });
      expect(snap.state.loans[0]).toMatchObject({ interestCharges: 1, interestPaid: 500 });
      expect(snap.transactions.map((t) => t.type)).toEqual(expect.arrayContaining(['START_REWARD', 'LOAN_INTEREST']));
      const [loan] = await sql`select interest_charges, interest_paid from public.loans where game_id = ${g.gameId}`;
      expect(loan).toMatchObject({ interest_charges: 1, interest_paid: 500 });
      await ledgerOk(g.gameId);
    });

    it('card effects: Community Chest Birthday collects from each player atomically', async () => {
      const g = await setupGame(['Asha', 'Bilal', 'Chitra']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await sql`update public.players set position = 14 where id = ${playerRow(g, 'Asha')}`;
      queuedDice = [1, 1]; // 14 + 2 = 16 Community Chest, even 2 → Birthday
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      const snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.state.turn.card).toMatchObject({ cardId: 'COMMUNITY_CHEST_EVEN_2' });
      expect(snap.state.players.map((p) => [p.name, p.balance])).toEqual([
        ['Asha', 26000],
        ['Bilal', 24500],
        ['Chitra', 24500],
      ]);
      expect(snap.transactions.filter((t) => t.type === 'CARD_COLLECTION')).toHaveLength(2);
      await ledgerOk(g.gameId);
    });

    it('mortgage with buildings: buildings returned, payout includes them, state persisted', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      await sql`update public.players set position = 3 where id = ${playerRow(g, 'Asha')}`;
      queuedDice = [1, 2]; // 3 + 3 = 6 Indore
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
      ok(await g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' }));
      ok(await g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' }));
      ok(await g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }));
      const [prop] = await sql`select houses, hotel, mortgaged from public.properties where game_id = ${g.gameId} and property_key = 'INDORE'`;
      expect(prop).toMatchObject({ houses: 0, hotel: false, mortgaged: true });
      const snap = await state(g.gameId, g.seats.Asha!);
      // 25,000 − 1,500 − 2×2,000 + (2×1,000 + 750)
      expect(snap.state.players.find((p) => p.name === 'Asha')!.balance).toBe(25000 - 1500 - 4000 + 2750);
      await ledgerOk(g.gameId);
    });

    it('trade: create → accept executes once (same action id twice) and persists ownership + money', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [1, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'BUY_PROPERTY' })); // Railway
      ok(
        await g.act('Asha', {
          type: 'CREATE_TRADE',
          toPlayerId: playerRow(g, 'Bilal'),
          offeredPropertyKeys: ['RAILWAY'],
          requestedPropertyKeys: [],
          offeredMoney: 0,
          requestedMoney: 6000,
        }),
      );
      let snap = await state(g.gameId, g.seats.Bilal!);
      const trade = snap.state.trades.find((t) => t.status === 'PENDING')!;
      expect(trade).toMatchObject({ requestedMoney: 6000, offeredPropertyKeys: ['RAILWAY'] });
      const accept = randomUUID();
      const [a, b] = await Promise.all([
        g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: trade.id }, { actionId: accept }),
        g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: trade.id }, { actionId: accept }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      snap = await state(g.gameId, g.seats.Bilal!);
      expect(snap.transactions.filter((t) => t.type === 'TRADE_PAYMENT')).toHaveLength(1);
      expect(snap.state.properties.RAILWAY.ownerId).toBe(playerRow(g, 'Bilal'));
      expect(snap.state.players.map((p) => p.balance)).toEqual([25000 - 9500 + 6000, 25000 - 6000]);
      const [row] = await sql`select status, resolved_at from public.trade_offers where id = ${trade.id}`;
      expect(row!.status).toBe('ACCEPTED');
      expect(row!.resolved_at).not.toBeNull();
      // A second accept with a NEW action id is refused by the engine.
      expect(await g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: trade.id })).toMatchObject({ ok: false, error: { code: 'TRADE_NOT_ALLOWED' } });
      await ledgerOk(g.gameId);
    });

    it('trade: reject, and accept after the property moved fails without any change', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      queuedDice = [1, 2];
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
      ok(await g.act('Asha', { type: 'BUY_PROPERTY' }));
      const create = () =>
        g.act('Asha', {
          type: 'CREATE_TRADE',
          toPlayerId: playerRow(g, 'Bilal'),
          offeredPropertyKeys: ['RAILWAY'],
          requestedPropertyKeys: [],
          offeredMoney: 0,
          requestedMoney: 100,
        });
      ok(await create());
      let snap = await state(g.gameId, g.seats.Bilal!);
      ok(await g.act('Bilal', { type: 'REJECT_TRADE', tradeId: snap.state.trades.at(-1)!.id }));
      ok(await create());
      snap = await state(g.gameId, g.seats.Bilal!);
      const t2 = snap.state.trades.find((t) => t.status === 'PENDING')!;
      ok(await g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'RAILWAY' }));
      const before = await sql`select count(*)::int as n from public.transactions where game_id = ${g.gameId}`;
      expect(await g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t2.id })).toMatchObject({ ok: false, error: { code: 'TRADE_NOT_ALLOWED' } });
      const after = await sql`select count(*)::int as n from public.transactions where game_id = ${g.gameId}`;
      expect(after[0]!.n).toBe(before[0]!.n);
      const rows = await sql`select status from public.trade_offers where game_id = ${g.gameId} order by created_at`;
      expect(rows.map((r) => r.status)).toEqual(['REJECTED', 'PENDING']);
      await expect(sql`update public.trade_offers set requested_money = 1 where id = ${t2.id}`).rejects.toThrow(/immutable/);
    });

    it('multi-undo through the server: two undos in a row, versions + broadcasts advance', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      ok(await g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: playerRow(g, 'Bilal'), amount: 100 }));
      ok(await g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: playerRow(g, 'Bilal'), amount: 200 }));
      for (const expected of [25000 - 100, 25000]) {
        let snap = await state(g.gameId, g.seats.Asha!);
        ok(await g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: snap.state.undoStack.at(-1)!.actionId }));
        snap = await state(g.gameId, g.seats.Bilal!);
        const before = broadcasts.length;
        const v = g.version;
        const res = ok(await g.act('Bilal', { type: 'APPROVE_UNDO', requestId: snap.state.undoRequest!.id }));
        expect(res.snapshot.state.version).toBe(v + 1);
        expect(broadcasts.slice(before).at(-1)).toMatchObject({ gameId: g.gameId, payload: { version: v + 1 } });
        expect(res.snapshot.state.players.find((p) => p.name === 'Asha')!.balance).toBe(expected);
      }
      const [row] = await sql`select jsonb_array_length(undo_stack) as n from public.games where id = ${g.gameId}`;
      expect(row!.n).toBe(0);
      await ledgerOk(g.gameId);
    });

    it('games from the old V1 engine are reported as expired, not loaded', async () => {
      const g = await setupGame(['Asha', 'Bilal']);
      await sql`update public.games set rules_version = 'BUSINESS_V1' where id = ${g.gameId}`;
      expect(await call({ op: 'state', gameId: g.gameId, playerId: g.seats.Asha!.playerId, token: g.seats.Asha!.token })).toMatchObject({
        ok: false,
        error: { code: 'GAME_EXPIRED' },
      });
      expect(await g.act('Asha', { type: 'START_GAME' })).toMatchObject({ ok: false, error: { code: 'GAME_EXPIRED' } });
    });
  });

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
