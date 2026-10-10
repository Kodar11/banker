/// <reference types="node" />
/**
 * Intermediate Mode through the game-action handler, against a real Postgres with the
 * production migrations applied: persistence, exactly-once behaviour and races.
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
import {
  gameClock,
  offeredRate,
  PROPERTY_KEYS,
  type ApiResponse,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
  type StateBroadcast,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/** Two starting players: one financial year = 72 spaces on the shared clock; the payment window is a quarter of it. */
const YEAR = 72;
const WINDOW = 18;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('Intermediate Mode through the handler (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedDice: number[] = [];
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
  const call = async (body: unknown): Promise<ApiResponse> => (await handleRequest(body, deps)).body;
  function ok(res: ApiResponse): Ok {
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  interface Seat {
    playerId: string;
    token: string;
  }

  async function snapshotFor(gameId: string, seat: Seat): Promise<GameSnapshot> {
    return ok(await call({ op: 'state', gameId, playerId: seat.playerId, token: seat.token })).snapshot;
  }

  async function setupGame(mode: GameMode | undefined, names = ['Asha', 'Bilal'], { start = true } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, ...(mode ? { mode } : {}) }));
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    const code = created.snapshot.state.code;
    for (const name of rest) {
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code, name }));
      seats[name] = { playerId: joined.playerId, token: t };
    }
    const g = {
      gameId,
      code,
      seats,
      names,
      snap: () => snapshotFor(gameId, seats[host!]!),
      /** Sends an action as `name`, against the version the server currently holds unless one is given. */
      act: async (name: string, action: GameAction, opts: { actionId?: string; expectedVersion?: number } = {}) => {
        const seat = seats[name]!;
        const expectedVersion = opts.expectedVersion ?? (await snapshotFor(gameId, seat)).state.version;
        if (action.type === 'START_GAME') queuedRandoms = orderRandoms(names, names);
        const res = await call({ op: 'action', gameId, playerId: seat.playerId, token: seat.token, actionId: opts.actionId ?? randomUUID(), expectedVersion, action });
        queuedRandoms = [];
        return res;
      },
    };
    if (start) ok(await g.act(host!, { type: 'START_GAME' }));
    return g;
  }

  type Game = Awaited<ReturnType<typeof setupGame>>;
  const eco = (s: GameSnapshot): IntermediateState => s.state.intermediate!;
  const nameOf = (g: Game, playerId: string | null) => g.names.find((n) => g.seats[n]!.playerId === playerId)!;

  /** The current player rolls 2 from two squares before Start (nothing to resolve) and ends the turn. */
  async function tick(g: Game) {
    const before = await g.snap();
    const name = nameOf(g, before.state.turn.playerId);
    await sql`update public.players set position = 34 where id = ${g.seats[name]!.playerId}`;
    queuedDice = [1, 1];
    const rolled = await g.act(name, { type: 'ROLL_DICE' });
    queuedDice = [];
    if (rolled.ok) ok(await g.act(name, { type: 'END_TURN' }));
    return rolled;
  }

  /** Puts the shared clock at `target` with one roll of 2 (test surgery on the stored movement). */
  async function jumpTo(g: Game, target: number) {
    const snap = await g.snap();
    const ids = Object.keys(eco(snap).movement);
    const movement = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? target - 2 : 0]));
    await sql`update public.games set intermediate = jsonb_set(intermediate, '{movement}', ${sql.json(movement)}::jsonb) where id = ${g.gameId}`;
    ok(await tick(g));
    const after = await g.snap();
    expect(gameClock(eco(after))).toBe(target);
    return after;
  }

  async function give(g: Game, name: string, key: PropertyKey) {
    await sql`update public.properties set owner_player_id = ${g.seats[name]!.playerId} where game_id = ${g.gameId} and property_key = ${key}`;
  }

  async function borrow(g: Game, name: string, product: LoanProductKey, amount: number, collateralKey?: PropertyKey, actionId?: string) {
    const snap = await g.snap();
    const expectedRatePercent = offeredRate(product, eco(snap).credit[g.seats[name]!.playerId]!).ratePercent;
    return g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKey ? { collateralKey } : {}) }, { actionId });
  }

  async function ledgerOk(gameId: string) {
    const rows = await sql`select * from public.verify_game_ledger(${gameId})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ok).toBe(true);
  }

  // -------------------------------------------------------------------------

  describe('game mode', () => {
    it('a game created without a mode is Classic, and the column defaults to classic for legacy rows', async () => {
      const g = await setupGame(undefined);
      const [row] = await sql`select game_mode, intermediate from public.games where id = ${g.gameId}`;
      expect(row).toMatchObject({ game_mode: 'classic', intermediate: null });
      expect((await g.snap()).state).toMatchObject({ mode: 'classic', intermediate: null });
      const [col] = await sql`select column_default, is_nullable from information_schema.columns where table_name = 'games' and column_name = 'game_mode'`;
      expect(String(col!.column_default)).toContain('classic');
      expect(col!.is_nullable).toBe('NO');
    });

    it('the host mode is stored, every joiner is served it, and joining cannot carry a mode', async () => {
      const g = await setupGame('intermediate', ['Asha', 'Bilal', 'Chitra'], { start: false });
      const [row] = await sql`select game_mode, intermediate from public.games where id = ${g.gameId}`;
      expect(row).toMatchObject({ game_mode: 'intermediate', intermediate: null });
      for (const name of g.names) expect((await snapshotFor(g.gameId, g.seats[name]!)).state.mode).toBe('intermediate');
      const bad = await handleRequest({ op: 'join', actionId: randomUUID(), token: token(), code: g.code, name: 'Dev', mode: 'classic' }, deps);
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      const unknown = await handleRequest({ op: 'create', actionId: randomUUID(), token: token(), name: 'Dev', mode: 'advanced' }, deps);
      expect(unknown.status).toBe(400);
    });

    it('the mode cannot change, and a Classic game cannot carry an economy — the database refuses both', async () => {
      const g = await setupGame('intermediate');
      await expect(sql`update public.games set game_mode = 'classic', intermediate = null where id = ${g.gameId}`).rejects.toThrow(/game_mode cannot change/);
      const c = await setupGame(undefined);
      await expect(sql`update public.games set game_mode = 'intermediate' where id = ${c.gameId}`).rejects.toThrow(/game_mode cannot change/);
      await expect(sql`update public.games set intermediate = '{}'::jsonb where id = ${c.gameId}`).rejects.toThrow(/games_intermediate_only_in_mode/);
      expect((await c.snap()).state.mode).toBe('classic');
    });

    it('a Classic game refuses Intermediate banking and keeps the Classic loan', async () => {
      const c = await setupGame(undefined);
      expect(await c.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: 11 })).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
      ok(await c.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      const snap = await c.snap();
      expect(snap.state.intermediate).toBeNull();
      expect(snap.state.loans).toHaveLength(1);
      expect(snap.state.loans[0]).toMatchObject({ principal: 5000, interestRatePercent: 10, interestAmount: 500 });
      const [row] = await sql`select intermediate from public.games where id = ${c.gameId}`;
      expect(row!.intermediate).toBeNull();
      await ledgerOk(c.gameId);
    });

    it('an Intermediate game refuses the Classic loan action', async () => {
      const g = await setupGame('intermediate');
      expect(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 })).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
      expect((await sql`select 1 from public.loans where game_id = ${g.gameId}`).length).toBe(0);
    });
  });

  describe('the economy is persisted once and served identically', () => {
    it('START_GAME stores the economy; every phone and every reconnect reads the same one', async () => {
      const g = await setupGame('intermediate', ['Asha', 'Bilal', 'Chitra']);
      const seen = await Promise.all(g.names.map((n) => snapshotFor(g.gameId, g.seats[n]!)));
      const first = JSON.stringify(eco(seen[0]!));
      for (const s of seen) expect(JSON.stringify(eco(s))).toBe(first);
      expect(eco(seen[0]!)).toMatchObject({ year: 1, playerCount: 3, loans: [] });
      expect(Object.keys(eco(seen[0]!).market).sort()).toEqual([...PROPERTY_KEYS].sort());
      // Reading again never rerolls a trend.
      expect(JSON.stringify(eco(await g.snap()))).toBe(first);
    });

    it('a financial year advances once: retried and repeated requests never apply it again', async () => {
      const g = await setupGame('intermediate');
      const snap = await g.snap();
      const ids = Object.keys(eco(snap).movement);
      await sql`update public.games set intermediate = jsonb_set(intermediate, '{movement}', ${sql.json({ [ids[0]!]: 35, [ids[1]!]: 35 })}::jsonb) where id = ${g.gameId}`;
      const name = nameOf(g, snap.state.turn.playerId);
      await sql`update public.players set position = 34 where id = ${g.seats[name]!.playerId}`;
      const actionId = randomUUID();
      queuedDice = [1, 1];
      const version = snap.state.version;
      const [a, b] = await Promise.all([
        g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version }),
        g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version }),
      ]);
      queuedDice = [];
      expect(ok(a).snapshot.state.version).toBe(ok(b).snapshot.state.version);
      const retried = ok(await g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version }));
      expect(retried.duplicate).toBe(true);

      const after = await g.snap();
      expect(eco(after).year).toBe(2);
      expect(gameClock(eco(after))).toBe(72);
      const years = await sql`select 1 from public.game_events where game_id = ${g.gameId} and type = 'FINANCIAL_YEAR_STARTED'`;
      expect(years).toHaveLength(1);
      // Both phones see the same prices, and refetching does not move them.
      const [x, y] = await Promise.all(g.names.map((n) => snapshotFor(g.gameId, g.seats[n]!)));
      expect(JSON.stringify(eco(x!).market)).toBe(JSON.stringify(eco(y!).market));
      expect(JSON.stringify(eco(await g.snap()).market)).toBe(JSON.stringify(eco(x!).market));
      expect(eco(x!).lastReport?.year).toBe(2);
      // The applied changes are in the append-only event log, one per property.
      const [event] = await sql`select payload from public.game_events where game_id = ${g.gameId} and type = 'FINANCIAL_YEAR_STARTED'`;
      expect(Object.keys((event!.payload as { changes: object }).changes)).toHaveLength(PROPERTY_KEYS.length);
      await ledgerOk(g.gameId);
    });
  });

  describe('loans: exactly once', () => {
    it('a retried loan request (same action id) creates one loan and pays out once', async () => {
      const g = await setupGame('intermediate');
      const actionId = randomUUID();
      const first = ok(await borrow(g, 'Asha', 'PERSONAL', 5000, undefined, actionId));
      const again = ok(await borrow(g, 'Asha', 'PERSONAL', 5000, undefined, actionId));
      expect(again.duplicate).toBe(true);
      const snap = await g.snap();
      expect(eco(snap).loans).toHaveLength(1);
      expect(eco(first.snapshot).loans[0]!.id).toBe(eco(snap).loans[0]!.id);
      expect(snap.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.balance).toBe(30000);
      const paid = await sql`select amount from public.transactions where game_id = ${g.gameId} and type = 'LOAN_DISBURSEMENT'`;
      expect(paid.map((r) => Number(r.amount))).toEqual([5000]);
      await ledgerOk(g.gameId);
    });

    it('a contract at a rate the server no longer offers is refused, with nothing written', async () => {
      const g = await setupGame('intermediate');
      expect(await g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: 5 })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
      expect(eco(await g.snap()).loans).toEqual([]);
      expect(await g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: 11, ratePercent: 1 } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    });

    it('two simultaneous loans against the same property: one pledge, one payout', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const results = await Promise.all([borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI'), borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI'), borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI')]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
      const snap = await g.snap();
      expect(eco(snap).loans.filter((l) => l.collateralKey === 'MUMBAI')).toHaveLength(1);
      expect(snap.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.balance).toBe(29000);
      // The pledged property can take no second claim.
      expect(await g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toMatchObject({ ok: false, error: { code: 'MORTGAGE_NOT_ALLOWED' } });
      expect(await g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.seats.Bilal!.playerId, offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 })).toMatchObject({ ok: false, error: { code: 'TRADE_NOT_ALLOWED' } });
      await ledgerOk(g.gameId);
    });

    it('simultaneous borrowing never passes the total limit', async () => {
      const g = await setupGame('intermediate');
      const results = await Promise.all([borrow(g, 'Asha', 'LONG_TERM', 15000), borrow(g, 'Asha', 'PERSONAL', 10000), borrow(g, 'Asha', 'FLEXIBLE', 10000)]);
      const snap = await g.snap();
      const borrowed = eco(snap).loans.reduce((s, l) => s + l.principal, 0);
      expect(borrowed).toBeLessThanOrEqual(20000);
      expect(results.filter((r) => r.ok).length).toBe(eco(snap).loans.length);
      await ledgerOk(g.gameId);
    });

    it('an installment is paid once: double taps and retries deduct the money a single time', async () => {
      const g = await setupGame('intermediate');
      ok(await borrow(g, 'Asha', 'PERSONAL', 9000));
      const due = await jumpTo(g, YEAR);
      const loan = eco(due).loans[0]!;
      const first = loan.installments[0]!;
      expect(first.status).toBe('DUE');
      const cash = due.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.balance;
      const actionId = randomUUID();
      const results = await Promise.all([
        g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }, { actionId }),
        g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }, { actionId }),
        g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }),
      ]);
      // However the three requests interleave, exactly one payment is made: a repeat of its action id
      // is answered as a duplicate, and any other request finds nothing left due.
      expect(results.some((r) => r.ok)).toBe(true);
      for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
      const after = await g.snap();
      expect(after.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.balance).toBe(cash - first.principal - first.interest);
      expect(eco(after).loans[0]!.installments[0]!.status).toBe('PAID');
      expect(eco(after).creditEvents.filter((e) => e.type === 'ON_TIME_PAYMENT')).toHaveLength(1);
      const rows = await sql`select type, amount from public.transactions where game_id = ${g.gameId} and type in ('LOAN_REPAYMENT', 'LOAN_INTEREST') order by seq`;
      expect(rows.map((r) => [r.type, Number(r.amount)])).toEqual([
        ['LOAN_REPAYMENT', first.principal],
        ['LOAN_INTEREST', first.interest],
      ]);
      await ledgerOk(g.gameId);
    });

    it('nobody can pay or repay another player’s loan', async () => {
      const g = await setupGame('intermediate');
      const loanId = eco(ok(await borrow(g, 'Asha', 'PERSONAL', 3000)).snapshot).loans[0]!.id;
      expect(await g.act('Bilal', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId, amount: 1000 })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await g.act('Bilal', { type: 'PAY_LOAN_INSTALLMENT', loanId })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    });
  });

  describe('overdue, default and collateral through the database', () => {
    it('overdue and default are each applied once however many requests follow', async () => {
      const g = await setupGame('intermediate');
      ok(await borrow(g, 'Asha', 'EMERGENCY', 2000));
      await jumpTo(g, YEAR + WINDOW);
      let snap = await g.snap();
      expect(eco(snap).loans[0]!.installments[0]!.status).toBe('OVERDUE');
      expect(await borrow(g, 'Asha', 'PERSONAL', 1000)).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
      ok(await tick(g));
      ok(await tick(g));
      snap = await jumpTo(g, YEAR + WINDOW + YEAR);
      expect(eco(snap).loans[0]).toMatchObject({ status: 'DEFAULTED', defaultBalance: 2000 + 380 });
      ok(await tick(g));
      ok(await tick(g));
      snap = await g.snap();
      const kinds = eco(snap).creditEvents.filter((e) => e.playerId === g.seats.Asha!.playerId).map((e) => e.type);
      expect(kinds.filter((k) => k === 'INSTALLMENT_OVERDUE')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'LOAN_DEFAULT')).toHaveLength(1);
      expect((await sql`select 1 from public.game_events where game_id = ${g.gameId} and type = 'LOAN_DEFAULTED'`).length).toBe(1);
      // Default is not bankruptcy.
      expect(snap.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.status).toBe('ACTIVE');
      await ledgerOk(g.gameId);
    });

    it('secured default: the property returns to the bank once, the surplus is one ledger entry', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      ok(await borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI'));
      const snap = await jumpTo(g, YEAR + WINDOW + YEAR);
      const loan = eco(snap).loans[0]!;
      expect(loan.collateralKey).toBeNull();
      expect(loan.settlement).toMatchObject({ propertyKey: 'MUMBAI' });
      expect(loan.settlement!.applied + loan.settlement!.surplus).toBe(loan.settlement!.value);
      const [prop] = await sql`select owner_player_id, mortgaged, houses from public.properties where game_id = ${g.gameId} and property_key = 'MUMBAI'`;
      expect(prop).toMatchObject({ owner_player_id: null, mortgaged: false, houses: 0 });
      ok(await tick(g));
      ok(await tick(g));
      const surplus = await sql`select amount, to_player_id from public.transactions where game_id = ${g.gameId} and type = 'COLLATERAL_SURPLUS'`;
      expect(surplus).toHaveLength(loan.settlement!.surplus > 0 ? 1 : 0);
      if (surplus[0]) expect(surplus[0]).toMatchObject({ to_player_id: g.seats.Asha!.playerId });
      expect((await sql`select 1 from public.game_events where game_id = ${g.gameId} and type = 'COLLATERAL_SEIZED'`).length).toBe(1);
      await ledgerOk(g.gameId);
    });

    it('a catch-up payment racing the default: one of them wins, and the books agree with whichever did', async () => {
      const g = await setupGame('intermediate');
      ok(await borrow(g, 'Asha', 'EMERGENCY', 2000));
      // One roll of 2 away from the default deadline.
      const before = await jumpTo(g, YEAR + WINDOW + YEAR - 2);
      const loan = eco(before).loans[0]!;
      expect(loan.installments[0]!.status).toBe('OVERDUE');
      const roller = nameOf(g, before.state.turn.playerId);
      await sql`update public.players set position = 34 where id = ${g.seats[roller]!.playerId}`;
      queuedDice = [1, 1];
      const [paid, rolled] = await Promise.all([
        g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }, { expectedVersion: before.state.version }),
        g.act(roller, { type: 'ROLL_DICE' }, { expectedVersion: before.state.version }),
      ]);
      // If the payment committed first the roll saw a newer version: the player looks again and rolls.
      if (!rolled.ok) {
        expect(rolled).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
        queuedDice = [1, 1];
        ok(await g.act(roller, { type: 'ROLL_DICE' }));
      }
      queuedDice = [];
      const after = await g.snap();
      const final = eco(after).loans[0]!;
      const kinds = eco(after).creditEvents.map((e) => e.type);
      if (paid.ok) {
        expect(final.status).toBe('REPAID');
        expect(final.installments[0]!.status).toBe('CAUGHT_UP');
        expect(kinds).not.toContain('LOAN_DEFAULT');
        expect(kinds.filter((k) => k === 'CAUGHT_UP')).toHaveLength(1);
      } else {
        expect(paid).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });
        expect(final.status).toBe('DEFAULTED');
        expect(kinds).not.toContain('CAUGHT_UP');
        expect(kinds.filter((k) => k === 'LOAN_DEFAULT')).toHaveLength(1);
        expect((await sql`select 1 from public.transactions where game_id = ${g.gameId} and type in ('LOAN_REPAYMENT', 'LOAN_INTEREST')`).length).toBe(0);
      }
      await ledgerOk(g.gameId);
    });
  });

  it('a reconnecting phone reads the whole financial picture back from the server', async () => {
    const g = await setupGame('intermediate');
    await give(g, 'Asha', 'DELHI');
    ok(await borrow(g, 'Asha', 'SECURED', 2000, 'DELHI'));
    ok(await borrow(g, 'Asha', 'FLEXIBLE', 3000));
    await jumpTo(g, YEAR + 3);
    const [a, b] = await Promise.all([snapshotFor(g.gameId, g.seats.Asha!), snapshotFor(g.gameId, g.seats.Bilal!)]);
    expect(JSON.stringify(a.state.intermediate)).toBe(JSON.stringify(b.state.intermediate));
    const [row] = await sql`select intermediate from public.games where id = ${g.gameId}`;
    expect(JSON.stringify(row!.intermediate)).toBe(JSON.stringify(a.state.intermediate));
    expect(eco(a)).toMatchObject({ year: 2 });
    expect(eco(a).loans.map((l) => [l.product, l.status, l.installments[0]!.status])).toEqual([
      ['SECURED', 'ACTIVE', 'DUE'],
      ['FLEXIBLE', 'ACTIVE', 'DUE'],
    ]);
    expect(eco(a).loans[1]!.rateHistory).toHaveLength(2);
    // Broadcasts carried the year change to connected players.
    expect(broadcasts.some((x) => x.gameId === g.gameId && x.payload.events.some((e) => e.type === 'FINANCIAL_YEAR_STARTED'))).toBe(true);
    await ledgerOk(g.gameId);
  });
});
