/// <reference types="node" />
/**
 * Property insurance and global crises through the game-action handler, against a real Postgres
 * with the production migrations applied: persistence, exactly-once behaviour, races, the
 * database's own guarantees and the client-role lockdown.
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
  crisisCheckpointClock,
  gameClock,
  pendingCrises,
  yearAt,
  type ApiResponse,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type InsuranceState,
  type IntermediateState,
  type PropertyKey,
  type StateBroadcast,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
/** Two starting players: 36 spaces of average movement = 72 on the shared clock; the first crisis is at 36. */
const COVER = 72;
const FIRST = 36;
const SECOND = 108;
const BILL = 3000;
const START_CASH = 25000;
const START_REWARD = 1500;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('Property insurance through the handler (Postgres)', () => {
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

  async function setupGame(mode: GameMode | undefined, names = ['Asha', 'Bilal']) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    // No secret objectives: these tests read final balances.
    const config = mode === 'intermediate' ? { secretObjectives: false } : undefined;
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, ...(mode ? { mode } : {}), ...(config ? { config } : {}) }));
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
    ok(await g.act(host!, { type: 'START_GAME' }));
    return g;
  }

  type Game = Awaited<ReturnType<typeof setupGame>>;
  const eco = (s: GameSnapshot): IntermediateState => s.state.intermediate!;
  const ins = (s: GameSnapshot): InsuranceState => eco(s).insurance!;
  const nameOf = (g: Game, playerId: string | null) => g.names.find((n) => g.seats[n]!.playerId === playerId)!;
  const idOf = (g: Game, name: string) => g.seats[name]!.playerId;

  /** Puts the shared clock (and the calendar with it) at `value`: test surgery on the stored economy. */
  async function setClock(g: Game, value: number) {
    const snap = await g.snap();
    const ids = Object.keys(eco(snap).movement);
    const movement = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? value : 0]));
    await sql`
      update public.games
      set intermediate = jsonb_set(jsonb_set(intermediate, '{movement}', ${sql.json(movement)}::jsonb), '{year}', ${sql.json(yearAt(eco(snap), value))}::jsonb)
      where id = ${g.gameId}`;
  }

  /** Readies the current player's roll of 1+1 from two squares before Start, taking the clock to `target`. Returns who rolls. */
  async function readyRoll(g: Game, target: number) {
    await setClock(g, target - 2);
    const name = nameOf(g, (await g.snap()).state.turn.playerId);
    await sql`update public.players set position = 34 where id = ${idOf(g, name)}`;
    return name;
  }

  /** The current player rolls the clock to `target` and lands on Start (nothing else to resolve). */
  async function rollTo(g: Game, target: number) {
    const name = await readyRoll(g, target);
    queuedDice = [1, 1];
    const res = ok(await g.act(name, { type: 'ROLL_DICE' }));
    queuedDice = [];
    expect(gameClock(eco(res.snapshot))).toBe(target);
    return { name, res };
  }

  async function give(g: Game, name: string, key: PropertyKey, mortgaged = false) {
    await sql`update public.properties set owner_player_id = ${idOf(g, name)}, mortgaged = ${mortgaged} where game_id = ${g.gameId} and property_key = ${key}`;
  }

  const insure = (g: Game, name: string, propertyKey: PropertyKey, opts: { actionId?: string; expectedPremium?: number } = {}) =>
    g.act(name, { type: 'INSURE_PROPERTY', propertyKey, expectedPremium: opts.expectedPremium ?? 250 }, { actionId: opts.actionId });

  const policyRows = (g: Game) => sql`select * from public.insurance_policies where game_id = ${g.gameId} order by created_at, id`;
  const crisisRows = (g: Game) => sql`select * from public.crisis_events where game_id = ${g.gameId} order by checkpoint`;
  const txRows = (g: Game, type: string) => sql`select * from public.transactions where game_id = ${g.gameId} and type = ${type} order by seq`;
  const balance = async (g: Game, name: string) => Number((await sql`select balance from public.players where id = ${idOf(g, name)}`)[0]!.balance);

  async function ledgerOk(g: Game) {
    const rows = await sql`select * from public.verify_game_ledger(${g.gameId})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ok).toBe(true);
  }

  // -------------------------------------------------------------------------

  describe('buying a policy', () => {
    it('cash, policy, ledger, event and version commit together, and every phone reads the same policy', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const before = (await g.snap()).state.version;
      const res = ok(await insure(g, 'Asha', 'MUMBAI'));
      expect(res.snapshot.state.version).toBe(before + 1);
      expect(await balance(g, 'Asha')).toBe(START_CASH - 250);
      expect(await txRows(g, 'INSURANCE_PREMIUM')).toMatchObject([{ amount: 250, from_player_id: idOf(g, 'Asha'), to_player_id: null, property_key: 'MUMBAI' }]);
      expect(await policyRows(g)).toMatchObject([
        {
          property_key: 'MUMBAI',
          property_keys: ['MUMBAI'],
          bought_keys: ['MUMBAI'],
          owner_player_id: idOf(g, 'Asha'),
          purchase_year: 1,
          entry_year: 1,
          premium_paid: 250,
          base_premium: 250,
          payout_limit: 3000,
          deductible: 0,
          claimed_total: 0,
          renewal_of: null,
          start_clock: 0,
          expiry_clock: COVER,
          status: 'ACTIVE',
          claimed_crisis_id: null,
          closed_at: null,
        },
      ]);
      const seen = await Promise.all(g.names.map((n) => snapshotFor(g.gameId, g.seats[n]!)));
      for (const s of seen) expect(JSON.stringify(ins(s))).toBe(JSON.stringify(ins(seen[0]!)));
      expect(ins(seen[0]!).policies).toMatchObject([{ propertyKeys: ['MUMBAI'], premiumPaid: 250, startClock: 0, expiryClock: COVER, status: 'ACTIVE' }]);
      // Every device is told the state moved on (realtime), with the public event.
      const mine = broadcasts.filter((b) => b.gameId === g.gameId);
      const told = mine[mine.length - 1]!;
      expect(told.payload.version).toBe(before + 1);
      expect(told.payload.events.map((e) => e.type)).toEqual(['INSURANCE_PURCHASED']);
      await ledgerOk(g);
    });

    it('a retried or double-tapped purchase is applied once', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const actionId = randomUUID();
      const version = (await g.snap()).state.version;
      const [a, b] = await Promise.all([
        g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 250 }, { actionId, expectedVersion: version }),
        g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 250 }, { actionId, expectedVersion: version }),
      ]);
      expect(ok(a).snapshot.state.version).toBe(ok(b).snapshot.state.version);
      expect(ok(await insure(g, 'Asha', 'MUMBAI', { actionId })).duplicate).toBe(true);
      expect(await policyRows(g)).toHaveLength(1);
      expect(await txRows(g, 'INSURANCE_PREMIUM')).toHaveLength(1);
      expect(await balance(g, 'Asha')).toBe(START_CASH - 250);
    });

    it('two different purchase requests for one property at once: exactly one policy, one premium', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const version = (await g.snap()).state.version;
      const results = await Promise.all([0, 1, 2].map(() => g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 250 }, { expectedVersion: version })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error.code).toBe('INSURANCE_NOT_ALLOWED');
      expect(await policyRows(g)).toHaveLength(1);
      expect(await txRows(g, 'INSURANCE_PREMIUM')).toHaveLength(1);
      expect(await balance(g, 'Asha')).toBe(START_CASH - 250);
      await ledgerOk(g);
    });

    it('a refused purchase changes nothing: wrong price, not the owner, not enough cash', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const version = (await g.snap()).state.version;
      expect(await insure(g, 'Asha', 'MUMBAI', { expectedPremium: 1 })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
      expect(await insure(g, 'Bilal', 'MUMBAI')).toMatchObject({ ok: false, error: { code: 'NOT_OWNER' } });
      ok(await g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: idOf(g, 'Bilal'), amount: START_CASH - 249 }));
      expect(await insure(g, 'Asha', 'MUMBAI')).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_FUNDS' } });
      expect(await policyRows(g)).toHaveLength(0);
      expect(await txRows(g, 'INSURANCE_PREMIUM')).toHaveLength(0);
      expect(await balance(g, 'Asha')).toBe(249);
      expect((await g.snap()).state.version).toBe(version + 1); // only the transfer
    });

    it('the price is the financial year’s, decided on the server', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      await setClock(g, 3 * COVER + 4);
      await sql`update public.games set intermediate = jsonb_set(intermediate, '{insurance,nextCheckpoint}', '99'::jsonb) where id = ${g.gameId}`;
      expect(await insure(g, 'Asha', 'MUMBAI', { expectedPremium: 250 })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
      ok(await insure(g, 'Asha', 'MUMBAI', { expectedPremium: 400 }));
      expect(await policyRows(g)).toMatchObject([{ purchase_year: 4, premium_paid: 400, start_clock: 3 * COVER + 4, expiry_clock: 4 * COVER + 4 }]);
    });
  });

  describe('who may act', () => {
    it('a wrong token, or a player of another game, cannot buy, pay or read', async () => {
      const g = await setupGame('intermediate');
      const other = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      const asha = g.seats.Asha!;
      const outsider = other.seats.Asha!;
      const action = { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 250 };
      const version = (await g.snap()).state.version;
      const forged = await call({ op: 'action', gameId: g.gameId, playerId: asha.playerId, token: token(), actionId: randomUUID(), expectedVersion: version, action });
      expect(forged).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      const foreign = await call({ op: 'action', gameId: g.gameId, playerId: outsider.playerId, token: outsider.token, actionId: randomUUID(), expectedVersion: version, action });
      expect(foreign).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await call({ op: 'state', gameId: g.gameId, playerId: outsider.playerId, token: outsider.token })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await policyRows(g)).toHaveLength(0);
      expect(await balance(g, 'Asha')).toBe(START_CASH);
    });

    it('a Classic game refuses every insurance action and never gets a row', async () => {
      const c = await setupGame(undefined);
      await give(c, 'Asha', 'MUMBAI');
      expect(await insure(c, 'Asha', 'MUMBAI')).toMatchObject({ ok: false, error: { code: 'INSURANCE_NOT_ALLOWED' } });
      expect(await c.act('Asha', { type: 'PAY_CRISIS_BILL', crisisId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await c.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await policyRows(c)).toHaveLength(0);
      expect(await crisisRows(c)).toHaveLength(0);
      expect((await c.snap()).state.intermediate).toBeNull();
      expect(await balance(c, 'Asha')).toBe(START_CASH);
      // Even a direct write is refused by the database.
      await expect(
        sql`insert into public.insurance_policies (id, game_id, property_key, owner_player_id, purchase_year, premium_paid, start_clock, expiry_clock)
            values (${randomUUID()}, ${c.gameId}, 'MUMBAI', ${idOf(c, 'Asha')}, 1, 500, 0, 72)`,
      ).rejects.toThrow(/only in Intermediate Mode/);
      await expect(
        sql`insert into public.crisis_events (id, game_id, checkpoint, checkpoint_clock, financial_year, amount, status, settled_at)
            values (${randomUUID()}, ${c.gameId}, 1, 36, 1, 0, 'SKIPPED', now())`,
      ).rejects.toThrow(/only in Intermediate Mode/);
    });
  });

  describe('the crisis checkpoint', () => {
    it('an uninsured property: one crisis row, one pending bill, and the game waits for it', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      const { name: roller, res } = await rollTo(g, FIRST);
      expect(res.snapshot.events.some((e) => e.type === 'CRISIS_STRUCK')).toBe(true);
      expect(await crisisRows(g)).toMatchObject([
        { checkpoint: 1, checkpoint_clock: FIRST, financial_year: 1, property_key: 'AGRA', owner_player_id: idOf(g, 'Bilal'), amount: BILL, paid: 0, policy_id: null, status: 'PENDING', settled_at: null },
      ]);
      expect(await txRows(g, 'CRISIS_PAYMENT')).toHaveLength(0);
      // Nobody can move the game past it — not the player whose turn it is, not the one who owes.
      expect(await g.act(roller, { type: 'END_TURN' })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      expect(await g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: idOf(g, 'Asha'), offeredPropertyKeys: ['AGRA'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 1 })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PHASE' },
      });
      // Pausing and resuming do not clear it, and a reconnecting phone gets the same bill back.
      ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
      ok(await g.act('Bilal', { type: 'RESUME_GAME' }));
      for (const n of g.names) {
        const snap = await snapshotFor(g.gameId, g.seats[n]!);
        expect(pendingCrises(snap.state)).toMatchObject([{ checkpoint: 1, propertyKey: 'AGRA', ownerId: idOf(g, 'Bilal'), amount: BILL, paid: 0, status: 'PENDING' }]);
      }
      expect(await g.act(roller, { type: 'END_TURN' })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
    });

    it('the roll that reaches a checkpoint, sent twice and retried, resolves it once', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      const name = await readyRoll(g, FIRST);
      const actionId = randomUUID();
      const version = (await g.snap()).state.version;
      queuedDice = [1, 1];
      const [a, b] = await Promise.all([
        g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version }),
        g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version }),
      ]);
      queuedDice = [];
      expect(ok(a).snapshot.state.version).toBe(ok(b).snapshot.state.version);
      expect(ok(await g.act(name, { type: 'ROLL_DICE' }, { actionId, expectedVersion: version })).duplicate).toBe(true);
      // A second, different roll request is refused: the bill is open.
      expect(await g.act(name, { type: 'ROLL_DICE' })).toMatchObject({ ok: false });
      expect(await crisisRows(g)).toHaveLength(1);
      expect(ins(await g.snap())).toMatchObject({ nextCheckpoint: 2 });
      expect((await sql`select 1 from public.game_events where game_id = ${g.gameId} and type = 'CRISIS_STRUCK'`).length).toBe(1);
    });

    it('paying settles it once — retries, double taps and competing requests never deduct twice', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      const { name: roller } = await rollTo(g, FIRST);
      const crisisId = pendingCrises((await g.snap()).state)[0]!.id;
      const cash = await balance(g, 'Bilal');
      const version = (await g.snap()).state.version;
      const actionId = randomUUID();
      const results = await Promise.all([
        g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId }, { actionId, expectedVersion: version }),
        g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId }, { actionId, expectedVersion: version }),
        g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId }, { expectedVersion: version }),
        g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId }, { expectedVersion: version }),
      ]);
      // The two copies of one action both succeed (one is the duplicate); of the three distinct actions, one wins.
      expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
      expect(await txRows(g, 'CRISIS_PAYMENT')).toMatchObject([{ amount: BILL, from_player_id: idOf(g, 'Bilal'), to_player_id: null, property_key: 'AGRA' }]);
      expect(await balance(g, 'Bilal')).toBe(cash - BILL);
      expect(await crisisRows(g)).toMatchObject([{ status: 'PAID', paid: BILL }]);
      expect((await crisisRows(g))[0]!.settled_at).not.toBeNull();
      expect(await g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      expect(await balance(g, 'Bilal')).toBe(cash - BILL);
      // The game resumes where it stopped.
      ok(await g.act(roller, { type: 'END_TURN' }));
      await ledgerOk(g);
    });

    it('an insured property: the claim is paid automatically from the policy limit and no money moves', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA', true);
      ok(await insure(g, 'Bilal', 'AGRA'));
      const cash = await balance(g, 'Bilal');
      const { name: roller } = await rollTo(g, FIRST);
      const [policy] = await policyRows(g);
      const [crisis] = await crisisRows(g);
      expect(crisis).toMatchObject({ checkpoint: 1, property_key: 'AGRA', mortgaged: true, amount: BILL, covered: BILL, paid: 0, status: 'COVERED', policy_id: policy!.id });
      expect(policy).toMatchObject({ status: 'ACTIVE', claimed_total: BILL, claimed_crisis_id: null });
      expect(await txRows(g, 'CRISIS_PAYMENT')).toHaveLength(0);
      expect(await balance(g, 'Bilal')).toBe(cash + (roller === 'Bilal' ? START_REWARD : 0));
      // The mortgage is exactly as it was.
      expect(await sql`select owner_player_id, mortgaged from public.properties where game_id = ${g.gameId} and property_key = 'AGRA'`).toMatchObject([{ owner_player_id: idOf(g, 'Bilal'), mortgaged: true }]);
      ok(await g.act(roller, { type: 'END_TURN' }));
    });

    it('nobody owns a property: the checkpoint is recorded as skipped and the next one is where it always was', async () => {
      const g = await setupGame('intermediate');
      const { name: roller } = await rollTo(g, FIRST);
      expect(await crisisRows(g)).toMatchObject([{ checkpoint: 1, status: 'SKIPPED', property_key: null, owner_player_id: null, amount: 0 }]);
      ok(await g.act(roller, { type: 'END_TURN' }));
      await give(g, 'Asha', 'MUMBAI');
      const second = await rollTo(g, SECOND);
      expect(await crisisRows(g)).toMatchObject([{ checkpoint: 1 }, { checkpoint: 2, checkpoint_clock: SECOND, financial_year: 2, property_key: 'MUMBAI', status: 'PENDING' }]);
      expect(crisisCheckpointClock(eco(second.res.snapshot), 3)).toBe(SECOND + COVER);
    });

    it('a purchase and the roll that reaches the checkpoint, sent together, get one unambiguous order', async () => {
      for (let round = 0; round < 4; round += 1) {
        const g = await setupGame('intermediate');
        await give(g, 'Bilal', 'AGRA');
        const name = await readyRoll(g, FIRST);
        const version = (await g.snap()).state.version;
        queuedDice = [1, 1];
        const [roll, bought] = await Promise.all([
          g.act(name, { type: 'ROLL_DICE' }, { expectedVersion: version }),
          g.act('Bilal', { type: 'INSURE_PROPERTY', propertyKey: 'AGRA', expectedPremium: 250 }, { expectedVersion: version }),
        ]);
        queuedDice = [];
        const policies = await policyRows(g);
        const crises = await crisisRows(g);
        if (roll.ok) {
          // The crisis was selected first: the purchase is refused and can never cover it.
          expect(bought).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
          expect(crises).toMatchObject([{ status: 'PENDING', policy_id: null }]);
          expect(policies).toHaveLength(0);
          expect(await txRows(g, 'INSURANCE_PREMIUM')).toHaveLength(0);
        } else {
          // The purchase committed first. It moved the version, so the roll was stale and resolved nothing…
          expect(roll).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
          expect(bought.ok).toBe(true);
          expect(crises).toHaveLength(0);
          expect(policies).toMatchObject([{ status: 'ACTIVE', start_clock: FIRST - 2 }]);
          // …and when the roll is made again, that policy is in force at the checkpoint and is the one claimed.
          queuedDice = [1, 1];
          ok(await g.act(name, { type: 'ROLL_DICE' }));
          queuedDice = [];
          expect(await crisisRows(g)).toMatchObject([{ status: 'COVERED', policy_id: policies[0]!.id }]);
          expect(await policyRows(g)).toMatchObject([{ status: 'ACTIVE', claimed_total: BILL }]);
          expect(await txRows(g, 'CRISIS_PAYMENT')).toHaveLength(0);
        }
        await ledgerOk(g);
      }
    });

    it('ending the game with a bill open collects it before the winner is decided', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      await rollTo(g, FIRST);
      const cash = await balance(g, 'Bilal');
      // No vote can be asked for while a bill is open; the game ends here because the other player walks away.
      expect(await g.act('Asha', { type: 'REQUEST_END_VOTE' })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      const ended = ok(await g.act('Asha', { type: 'LEAVE_GAME' }));
      expect(ended.snapshot.state.status).toBe('FINISHED');
      expect(await crisisRows(g)).toMatchObject([{ status: 'PAID', paid: BILL }]);
      expect(await balance(g, 'Bilal')).toBe(cash - BILL);
      const events = await sql`select type from public.game_events where game_id = ${g.gameId} order by seq`;
      const order = events.map((e) => e.type as string);
      expect(order.indexOf('CRISIS_SETTLED')).toBeGreaterThan(-1);
      expect(order.indexOf('CRISIS_SETTLED')).toBeLessThan(order.indexOf('GAME_FINISHED'));
      await ledgerOk(g);
    });
  });

  describe('renewals and portfolios', () => {
    it('a renewal is written once and linked to the period it renews, however many times it is sent at once', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      ok(await insure(g, 'Bilal', 'AGRA'));
      await rollTo(g, FIRST); // the claim is paid: no no-claim discount, the early-buyer one stays
      const [old] = await policyRows(g);
      expect(old).toMatchObject({ claimed_total: BILL });
      const version = (await g.snap()).state.version;
      const results = await Promise.all(
        [0, 1, 2].map(() => g.act('Bilal', { type: 'RENEW_INSURANCE', policyId: old!.id as string, expectedPremium: 200 }, { expectedVersion: version })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error).toMatchObject({ code: 'INSURANCE_NOT_ALLOWED', message: 'This policy has already been renewed.' });
      const rows = await policyRows(g);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        renewal_of: old!.id,
        premium_paid: 200,
        base_premium: 250,
        loyalty_percent: 20,
        no_claim_percent: 0,
        no_claim_periods: 0,
        entry_year: 1,
        start_clock: COVER,
        expiry_clock: 2 * COVER,
        claimed_total: 0,
        status: 'ACTIVE',
      });
      expect((await txRows(g, 'INSURANCE_PREMIUM')).map((t) => Number(t.amount))).toEqual([250, 200]);
      await ledgerOk(g);
    });

    it('a portfolio policy loses a traded property in the database too, and nothing else about it changes', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      await give(g, 'Asha', 'DELHI');
      ok(await g.act('Asha', { type: 'INSURE_PROPERTIES', propertyKeys: ['MUMBAI', 'DELHI'], expectedPremium: 475 }));
      ok(await g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: idOf(g, 'Bilal'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 }));
      const tradeId = (await g.snap()).state.trades[0]!.id;
      ok(await g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId }));
      expect(await policyRows(g)).toMatchObject([
        { property_keys: ['DELHI'], bought_keys: ['MUMBAI', 'DELHI'], status: 'ACTIVE', premium_paid: 475, portfolio_percent: 5, claimed_total: 0, closed_at: null },
      ]);
      await ledgerOk(g);
    });
  });

  describe('the database’s own guarantees', () => {
    it('a second crisis for the same checkpoint, a reopened bill and a deleted row are all refused', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      await rollTo(g, FIRST);
      const [crisis] = await crisisRows(g);
      await expect(
        sql`insert into public.crisis_events (id, game_id, checkpoint, checkpoint_clock, financial_year, property_key, owner_player_id, amount, status)
            values (${randomUUID()}, ${g.gameId}, 1, 36, 1, 'AGRA', ${idOf(g, 'Bilal')}, 3000, 'PENDING')`,
      ).rejects.toThrow(/crisis_events_one_per_checkpoint/);
      await expect(sql`update public.crisis_events set amount = 1 where id = ${crisis!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`update public.crisis_events set owner_player_id = ${idOf(g, 'Asha')} where id = ${crisis!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`delete from public.crisis_events where id = ${crisis!.id}`).rejects.toThrow(/permanent/);
      ok(await g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId: crisis!.id as string }));
      await expect(sql`update public.crisis_events set status = 'PENDING', paid = 0, settled_at = null where id = ${crisis!.id}`).rejects.toThrow(/already paid/);
    });

    it('a policy’s terms cannot be rewritten, its claims match its crises, a closed policy is final, and it is renewed once', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Bilal', 'AGRA');
      ok(await insure(g, 'Bilal', 'AGRA'));
      const [policy] = await policyRows(g);
      await expect(sql`update public.insurance_policies set expiry_clock = 9999 where id = ${policy!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`update public.insurance_policies set premium_paid = 1 where id = ${policy!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`delete from public.insurance_policies where id = ${policy!.id}`).rejects.toThrow(/permanent/);
      // Claims: never written by hand, never above the limit, never taken back; a property is never added.
      await expect(sql`update public.insurance_policies set claimed_total = 1000 where id = ${policy!.id}`).rejects.toThrow(/claims 1000 but its crises record 0/);
      await expect(sql`update public.insurance_policies set claimed_total = 9000 where id = ${policy!.id}`).rejects.toThrow(/claims 9000 but its crises record 0|insurance_policies_limit_check/);
      await expect(sql`update public.insurance_policies set payout_limit = 9000 where id = ${policy!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`update public.insurance_policies set property_keys = '{AGRA,MUMBAI}' where id = ${policy!.id}`).rejects.toThrow(/insurance_policies_keys_check|cannot be added/);
      const insert = (renewalOf: unknown, claimed = 0) => sql`
        insert into public.insurance_policies (id, game_id, property_key, property_keys, bought_keys, owner_player_id, purchase_year, premium_paid,
          base_premium, payout_limit, claimed_total, entry_year, renewal_of, start_clock, expiry_clock)
        values (${randomUUID()}, ${g.gameId}, 'AGRA', '{AGRA}', '{AGRA}', ${idOf(g, 'Bilal')}, 1, 175, 250, 3000, ${claimed}, 1, ${renewalOf as string}, 72, 144)`;
      await expect(insert(null, 3000)).rejects.toThrow(/nothing claimed/);
      await insert(policy!.id);
      await expect(insert(policy!.id)).rejects.toThrow(/insurance_policies_renewed_once_idx/);
      // The claim is fixed with its crisis, and the policy's total follows it.
      const { name: roller } = await rollTo(g, FIRST);
      const [crisis] = await crisisRows(g);
      expect(crisis).toMatchObject({ status: 'COVERED', covered: BILL, policy_id: policy!.id });
      await expect(sql`update public.crisis_events set covered = 0 where id = ${crisis!.id}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`update public.insurance_policies set claimed_total = 0 where id = ${policy!.id}`).rejects.toThrow(/cannot be taken back/);
      // A second claim on an exhausted policy is refused by the database itself.
      await expect(
        sql`insert into public.crisis_events (id, game_id, checkpoint, checkpoint_clock, financial_year, property_key, owner_player_id, amount, covered, policy_id, status)
            values (${randomUUID()}, ${g.gameId}, 50, 3600, 1, 'AGRA', ${idOf(g, 'Bilal')}, 3000, 1, ${policy!.id}, 'PENDING')`,
      ).rejects.toThrow(/has only 0 of cover left/);
      // Closed is final.
      await sql`update public.games set intermediate = jsonb_set(intermediate, '{insurance,nextCheckpoint}', '99'::jsonb) where id = ${g.gameId}`;
      ok(await g.act(roller, { type: 'END_TURN' }));
      await rollTo(g, COVER + 2);
      expect((await policyRows(g))[0]).toMatchObject({ status: 'EXPIRED' });
      await expect(sql`update public.insurance_policies set status = 'ACTIVE', closed_at = null where id = ${policy!.id}`).rejects.toThrow(/already expired/);
    });

    it('the app’s own database roles cannot read or write policies or crises', async () => {
      const g = await setupGame('intermediate');
      for (const role of ['anon', 'authenticated']) {
        for (const table of ['insurance_policies', 'crisis_events']) {
          const [priv] = await sql`
            select has_table_privilege(${role}, ${`public.${table}`}, 'select') as can_select,
                   has_table_privilege(${role}, ${`public.${table}`}, 'insert') as can_insert,
                   has_table_privilege(${role}, ${`public.${table}`}, 'update') as can_update,
                   has_table_privilege(${role}, ${`public.${table}`}, 'delete') as can_delete`;
          expect(priv).toEqual({ can_select: false, can_insert: false, can_update: false, can_delete: false });
          await expect(
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              return tx.unsafe(`select id from public.${table} where game_id = '${g.gameId}'`);
            }),
          ).rejects.toThrow(/permission denied/);
          const [rls] = await sql`select relrowsecurity, (select count(*)::int from pg_policies where tablename = ${table}) as policies from pg_class where oid = ${`public.${table}`}::regclass`;
          expect(rls).toEqual({ relrowsecurity: true, policies: 0 });
        }
      }
    });

    it('an expired game’s policies and crises are purged with it', async () => {
      const g = await setupGame('intermediate');
      await give(g, 'Asha', 'MUMBAI');
      await give(g, 'Bilal', 'AGRA');
      ok(await insure(g, 'Asha', 'MUMBAI'));
      await rollTo(g, FIRST);
      expect((await policyRows(g)).length + (await crisisRows(g)).length).toBe(2);
      await sql`update public.games set expires_at = now() - interval '2 days' where id = ${g.gameId}`;
      await sql`select public.purge_expired_games()`;
      expect(await sql`select 1 from public.games where id = ${g.gameId}`).toHaveLength(0);
      expect(await policyRows(g)).toHaveLength(0);
      expect(await crisisRows(g)).toHaveLength(0);
    });
  });
});
