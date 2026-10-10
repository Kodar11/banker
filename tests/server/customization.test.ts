/// <reference types="node" />
/**
 * Game customization and secret objectives through the real game-action handler, against a real
 * Postgres with the production migrations applied: what is stored, who can read it, and that
 * nothing can be changed, dealt or paid twice.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import {
  OBJECTIVE_IDS,
  OBJECTIVES,
  type ApiResponse,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type ObjectiveId,
  type StateBroadcast,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('game customization and secret objectives (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedRandoms: number[] = [];
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcast: async (gameId, payload) => {
        broadcasts.push({ gameId, payload });
      },
      // Queued values pin START_GAME's turn-order draw; everything after it (the objective deal included) is really random.
      random: () => queuedRandoms.shift() ?? Math.random(),
    };
  });

  beforeEach(() => {
    broadcasts.length = 0;
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
  const refused = (res: ApiResponse) => {
    if (res.ok) throw new Error('expected the server to refuse');
    return res.error;
  };

  interface Seat {
    playerId: string;
    token: string;
  }

  async function snapshotFor(gameId: string, seat: Seat): Promise<GameSnapshot> {
    return ok(await call({ op: 'state', gameId, playerId: seat.playerId, token: seat.token })).snapshot;
  }

  async function setupGame({ mode, config, names = ['Asha', 'Bilal'], start = true }: { mode?: GameMode; config?: unknown; names?: string[]; start?: boolean } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, ...(mode ? { mode } : {}), ...(config ? { config } : {}) }));
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    const code = created.snapshot.state.code;
    const joinedSnapshots: Record<string, GameSnapshot> = { [host!]: created.snapshot };
    for (const name of rest) {
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code, name }));
      seats[name] = { playerId: joined.playerId, token: t };
      joinedSnapshots[name] = joined.snapshot;
    }
    const g = {
      gameId,
      code,
      seats,
      names,
      joinedSnapshots,
      view: (name: string) => snapshotFor(gameId, seats[name]!),
      act: async (name: string, action: GameAction | Record<string, unknown>, opts: { actionId?: string; expectedVersion?: number } = {}) => {
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
  const storedConfig = async (g: Game) => (await sql`select config from public.games where id = ${g.gameId}`)[0]!.config as Record<string, unknown> | null;
  const objectiveRows = (g: Game) => sql`select * from public.player_objectives where game_id = ${g.gameId} order by player_id`;
  const rewardRows = (g: Game) => sql`select to_player_id, amount, memo from public.transactions where game_id = ${g.gameId} and type = 'OBJECTIVE_REWARD' order by seq`;
  const ledgerOk = async (g: Game) => (await sql`select ok from public.verify_game_ledger(${g.gameId})`).every((r) => r.ok === true);
  /** Test surgery: rewrites who holds which objective (bypassing the guard) so an outcome can be scripted. */
  async function forceObjectives(g: Game, by: Record<string, ObjectiveId>) {
    await sql.begin(async (tx) => {
      await tx`alter table public.player_objectives disable trigger player_objectives_guard`;
      for (const [name, id] of Object.entries(by)) {
        await tx`update public.player_objectives set objective_id = ${id} where game_id = ${g.gameId} and player_id = ${g.seats[name]!.playerId}`;
      }
      await tx`alter table public.player_objectives enable trigger player_objectives_guard`;
    });
  }

  // -------------------------------------------------------------------------

  describe('the server owns the configuration', () => {
    it('a game created with no settings stores the defaults of its mode', async () => {
      const classic = await setupGame({ start: false });
      expect(await storedConfig(classic)).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false });
      const intermediate = await setupGame({ mode: 'intermediate', start: false });
      expect(await storedConfig(intermediate)).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: true });
    });

    it('normalises what it is sent: missing settings take defaults, Classic never keeps Intermediate ones', async () => {
      const g = await setupGame({ config: { startingCash: 40000, marketVolatility: 'volatile', secretObjectives: true }, start: false });
      expect(await storedConfig(g)).toEqual({ startingCash: 40000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false });
      expect((await g.view('Asha')).state.config).toEqual(await storedConfig(g));
    });

    it.each([
      [{ startingCash: 5000 }, /Starting cash must be at least ₹10,000/],
      [{ startingCash: 60000 }, /Starting cash can be at most ₹50,000/],
      [{ startingCash: 27000 }, /multiple of ₹5,000/],
      [{ startingCash: '25000' }, /Starting cash must be a number/],
      [{ loanLimit: 1000 }, /loan limit must be at least ₹5,000/],
      [{ loanLimit: 100000 }, /loan limit can be at most ₹50,000/],
      [{ marketVolatility: 'chaos' }, /Stable, Balanced or Volatile/],
      [{ secretObjectives: 'yes' }, /on or off/],
      [{ startingCash: 30000, freeMoney: 1 }, /not valid/],
      ['big', /not valid|expected/i],
    ])('refuses %j and creates nothing', async (config, message) => {
      const before = Number((await sql`select count(*)::int as n from public.games`)[0]!.n);
      const res = await handleRequest({ op: 'create', actionId: randomUUID(), token: token(), name: 'Asha', mode: 'intermediate', config }, deps);
      expect(res.body.ok).toBe(false);
      const error = refused(res.body);
      expect(error.code).toBe('VALIDATION');
      expect(error.message).toMatch(message);
      expect(Number((await sql`select count(*)::int as n from public.games`)[0]!.n)).toBe(before);
    });

    it('every player — host, joiner, and anyone reconnecting — receives the same configuration', async () => {
      const config = { startingCash: 35000, loanLimit: 15000, marketVolatility: 'stable', secretObjectives: false };
      const g = await setupGame({ mode: 'intermediate', config, names: ['Asha', 'Bilal', 'Chitra'], start: false });
      // What each of them was handed when they entered…
      for (const name of g.names) expect(g.joinedSnapshots[name]!.state.config).toEqual(config);
      // …and what each reads back later, before and after the start.
      for (const name of g.names) expect((await g.view(name)).state.config).toEqual(config);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      for (const name of g.names) {
        const s = await g.view(name);
        expect(s.state.config).toEqual(config);
        expect(s.state.players.every((p) => p.balance === 35000)).toBe(true);
      }
    });

    it('a joining player cannot bring their own mode or settings', async () => {
      const g = await setupGame({ config: { startingCash: 30000 }, start: false });
      const res = await handleRequest({ op: 'join', actionId: randomUUID(), token: token(), code: g.code, name: 'Mallory', mode: 'intermediate', config: { startingCash: 50000 } }, deps);
      expect(res.status).toBe(400);
      expect(refused(res.body).code).toBe('VALIDATION');
      expect((await storedConfig(g))!.startingCash).toBe(30000);
      expect((await g.view('Asha')).state.players).toHaveLength(2);
    });

    it('starting cash comes from the stored configuration, as one ledger entry per player', async () => {
      const g = await setupGame({ config: { startingCash: 10000 } });
      const funds = await sql`select to_player_id, amount from public.transactions where game_id = ${g.gameId} and type = 'STARTING_FUNDS'`;
      expect(funds.map((f) => Number(f.amount))).toEqual([10000, 10000]);
      expect((await sql`select balance from public.players where game_id = ${g.gameId}`).map((p) => Number(p.balance))).toEqual([10000, 10000]);
      expect(await ledgerOk(g)).toBe(true);
    });

    it('the Classic loan limit is the stored one, enforced on the server', async () => {
      const g = await setupGame({ config: { loanLimit: 5000 } });
      ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      expect(refused(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 }))).toEqual({ code: 'LOAN_NOT_ALLOWED', message: 'Loan limit is ₹5,000. You can borrow ₹0 more.' });
    });

    it('a game stored before settings existed (config is null) loads and plays by the old rules', async () => {
      const g = await setupGame({ mode: 'intermediate', start: false });
      await sql`update public.games set config = null where id = ${g.gameId}`;
      const lobby = await g.view('Bilal');
      expect(lobby.state.config).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false });
      ok(await g.act('Asha', { type: 'START_GAME' }));
      const s = await g.view('Asha');
      expect(s.state.players.every((p) => p.balance === 25000)).toBe(true);
      expect(s.state.objectives).toBeNull();
      expect(await objectiveRows(g)).toHaveLength(0);
      // Playing on never writes a config into the old row.
      ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
      expect(await storedConfig(g)).toBeNull();
    });
  });

  describe('the configuration is the host’s until the game starts, then locked', () => {
    it('the host changes it in the lobby and everyone sees the change', async () => {
      const g = await setupGame({ mode: 'intermediate', start: false });
      const next = { startingCash: 45000, loanLimit: 30000, marketVolatility: 'volatile', secretObjectives: false };
      ok(await g.act('Asha', { type: 'UPDATE_CONFIG', config: next }));
      expect(await storedConfig(g)).toEqual(next);
      for (const name of g.names) expect((await g.view(name)).state.config).toEqual(next);
      expect(broadcasts.at(-1)!.payload.events).toMatchObject([{ type: 'GAME_CONFIG_UPDATED', message: 'Asha changed the game settings' }]);
    });

    it('nobody else can, and an invalid change stores nothing', async () => {
      const g = await setupGame({ start: false });
      const before = await storedConfig(g);
      expect(refused(await g.act('Bilal', { type: 'UPDATE_CONFIG', config: { startingCash: 50000 } })).code).toBe('FORBIDDEN');
      expect(refused(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 99999 } })).message).toMatch(/at most ₹50,000/);
      expect(refused(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { mode: 'intermediate' } })).code).toBe('VALIDATION');
      expect(await storedConfig(g)).toEqual(before);
      expect((await sql`select game_mode from public.games where id = ${g.gameId}`)[0]!.game_mode).toBe('classic');
    });

    it('after the start every attempt is refused — host, other players, paused or finished', async () => {
      const g = await setupGame({ config: { startingCash: 30000 } });
      const before = await storedConfig(g);
      const change = { type: 'UPDATE_CONFIG', config: { startingCash: 50000, loanLimit: 50000 } };
      const locked = { code: 'INVALID_PHASE', message: 'The game has started — its settings are locked.' };
      expect(refused(await g.act('Asha', change))).toEqual(locked);
      expect(refused(await g.act('Bilal', change))).toEqual(locked);
      ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
      expect(refused(await g.act('Asha', change))).toEqual(locked);
      ok(await g.act('Asha', { type: 'RESUME_GAME' }));
      ok(await g.act('Asha', { type: 'END_GAME' }));
      expect(refused(await g.act('Asha', change)).code).toBe('GAME_FINISHED');
      expect(await storedConfig(g)).toEqual(before);
    });

    it('the database itself refuses a change once the game has started, and allows one before', async () => {
      const lobby = await setupGame({ start: false });
      await sql`update public.games set config = jsonb_set(config, '{startingCash}', '30000') where id = ${lobby.gameId}`;
      expect((await storedConfig(lobby))!.startingCash).toBe(30000);

      const running = await setupGame();
      await expect(sql`update public.games set config = jsonb_set(config, '{startingCash}', '50000') where id = ${running.gameId}`).rejects.toThrow(/config is locked/);
      await expect(sql`update public.games set config = null where id = ${running.gameId}`).rejects.toThrow(/config is locked/);
      expect((await storedConfig(running))!.startingCash).toBe(25000);
    });

    it('a start and a settings change racing each other: the game starts with exactly one configuration', async () => {
      const g = await setupGame({ start: false });
      const version = (await g.view('Asha')).state.version;
      const [start, change] = await Promise.all([
        g.act('Asha', { type: 'START_GAME' }, { expectedVersion: version }),
        g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 50000 } }, { expectedVersion: version }),
      ]);
      const s = await g.view('Bilal');
      const stored = await storedConfig(g);
      if (start.ok) {
        // Whichever won, every balance equals the stored starting cash — never a mix.
        expect(s.state.status).toBe('ACTIVE');
        expect(s.state.players.every((p) => p.balance === stored!.startingCash)).toBe(true);
        if (!change.ok) expect(stored!.startingCash).toBe(25000);
      } else {
        // The change landed first; the start was looking at an old lobby and was told so.
        expect(change.ok).toBe(true);
        expect(refused(start).code).toBe('STALE_STATE');
        expect(s.state.status).toBe('WAITING');
        expect(stored!.startingCash).toBe(50000);
      }
      expect(s.state.config).toEqual(stored);
    });

    it('survives the host leaving and every reconnect', async () => {
      const config = { startingCash: 20000, loanLimit: 10000, marketVolatility: 'balanced', secretObjectives: false };
      const g = await setupGame({ config, names: ['Asha', 'Bilal', 'Chitra'] });
      ok(await g.act('Asha', { type: 'LEAVE_GAME' }));
      for (let i = 0; i < 3; i += 1) expect((await g.view('Bilal')).state.config).toEqual(config);
      expect((await g.view('Bilal')).state.players.find((p) => p.isHost)!.id).toBe(g.seats.Bilal!.playerId);
      expect(refused(await g.act('Bilal', { type: 'UPDATE_CONFIG', config: { startingCash: 50000 } })).code).toBe('INVALID_PHASE');
      expect(await storedConfig(g)).toEqual(config);
    });
  });

  describe('market volatility is stored with the game', () => {
    it.each(['stable', 'balanced', 'volatile'] as const)('%s: persisted, sent to every player, and never applied to a Classic game', async (marketVolatility) => {
      const g = await setupGame({ mode: 'intermediate', config: { marketVolatility } });
      expect((await storedConfig(g))!.marketVolatility).toBe(marketVolatility);
      for (const name of g.names) expect((await g.view(name)).state.config.marketVolatility).toBe(marketVolatility);
      const classic = await setupGame({ config: { marketVolatility } });
      expect((await storedConfig(classic))!.marketVolatility).toBe('balanced');
      expect((await sql`select intermediate from public.games where id = ${classic.gameId}`)[0]!.intermediate).toBeNull();
    });
  });

  describe('secret objectives: dealt once, stored privately', () => {
    it('an Intermediate game deals one row per player at the start, all different for four players', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra', 'Dev'], start: false });
      expect(await objectiveRows(g)).toHaveLength(0);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      const rows = await objectiveRows(g);
      expect(rows.map((r) => r.player_id).sort()).toEqual(g.names.map((n) => g.seats[n]!.playerId).sort());
      expect(new Set(rows.map((r) => r.objective_id)).size).toBe(4);
      for (const r of rows) {
        expect(OBJECTIVE_IDS).toContain(r.objective_id);
        expect([r.completed, r.reward, r.detail, r.evaluated_at]).toEqual([null, null, null, null]);
      }
    });

    it('none in Classic, none when the host disabled them', async () => {
      const classic = await setupGame();
      expect(await objectiveRows(classic)).toHaveLength(0);
      expect((await classic.view('Asha')).state.objectives).toBeNull();
      const off = await setupGame({ mode: 'intermediate', config: { secretObjectives: false } });
      expect(await objectiveRows(off)).toHaveLength(0);
      expect((await off.view('Asha')).state.objectives).toBeNull();
    });

    it('each player is sent their own objective and nobody else’s — the host gets no more than anyone', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      const rows = await objectiveRows(g);
      const held = Object.fromEntries(rows.map((r) => [r.player_id as string, r.objective_id as string]));
      for (const name of g.names) {
        const me = g.seats[name]!.playerId;
        const snapshot = await g.view(name);
        expect(snapshot.state.objectives!.assignments).toEqual({ [me]: held[me] });
        // Nothing anywhere in the response names an objective the player does not hold.
        const body = JSON.stringify(snapshot);
        for (const id of OBJECTIVE_IDS) {
          if (id === held[me]) continue;
          expect(body).not.toContain(id);
          expect(body).not.toContain(OBJECTIVES[id].name);
        }
      }
    });

    it('the response to a player’s own action is cut down the same way', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      const res = ok(await g.act('Bilal', { type: 'PAUSE_GAME' }));
      expect(Object.keys(res.snapshot.state.objectives!.assignments)).toEqual([g.seats.Bilal!.playerId]);
      const retried = randomUUID();
      ok(await g.act('Asha', { type: 'RESUME_GAME' }, { actionId: retried }));
      const duplicate = ok(await g.act('Asha', { type: 'RESUME_GAME' }, { actionId: retried }));
      expect(duplicate.duplicate).toBe(true);
      expect(Object.keys(duplicate.snapshot.state.objectives!.assignments)).toEqual([g.seats.Asha!.playerId]);
    });

    it('nothing that is broadcast or logged while the game runs mentions an objective', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
      ok(await g.act('Bilal', { type: 'RESUME_GAME' }));
      ok(await g.act('Chitra', { type: 'LEAVE_GAME' }));
      const sent = JSON.stringify(broadcasts.filter((b) => b.gameId === g.gameId));
      const logged = JSON.stringify(await sql`select type, message, payload from public.game_events where game_id = ${g.gameId}`);
      const ledger = JSON.stringify(await sql`select type, memo from public.transactions where game_id = ${g.gameId}`);
      for (const text of [sent, logged, ledger]) {
        expect(text).not.toMatch(/objective/i);
        for (const id of OBJECTIVE_IDS) {
          expect(text).not.toContain(id);
          expect(text).not.toContain(OBJECTIVES[id].name);
        }
      }
    });

    it('someone who is not in the game is told nothing', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      const stranger = await handleRequest({ op: 'state', gameId: g.gameId, playerId: g.seats.Bilal!.playerId, token: token() }, deps);
      expect(refused(stranger.body).code).toBe('FORBIDDEN');
      // A real player of another game cannot read this one by naming its id.
      const other = await setupGame({ mode: 'intermediate' });
      const crossed = await handleRequest({ op: 'state', gameId: g.gameId, playerId: other.seats.Asha!.playerId, token: other.seats.Asha!.token }, deps);
      expect(refused(crossed.body).code).toBe('FORBIDDEN');
    });

    it('reconnecting, retrying and playing on never change an assignment', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      const dealt = (await objectiveRows(g)).map((r) => [r.player_id, r.objective_id, String(r.assigned_at)]);
      const mine = (await g.view('Bilal')).state.objectives!.assignments;
      for (let i = 0; i < 5; i += 1) expect((await g.view('Bilal')).state.objectives!.assignments).toEqual(mine);
      ok(await g.act('Asha', { type: 'PAUSE_GAME' }));
      ok(await g.act('Asha', { type: 'RESUME_GAME' }));
      // A second start — retried or fresh — deals nothing.
      expect(refused(await g.act('Asha', { type: 'START_GAME' })).code).toBe('INVALID_PHASE');
      expect((await objectiveRows(g)).map((r) => [r.player_id, r.objective_id, String(r.assigned_at)])).toEqual(dealt);
    });

    it('a retried START_GAME deals once', async () => {
      const g = await setupGame({ mode: 'intermediate', start: false });
      const actionId = randomUUID();
      const version = (await g.view('Asha')).state.version;
      ok(await g.act('Asha', { type: 'START_GAME' }, { actionId, expectedVersion: version }));
      const first = (await objectiveRows(g)).map((r) => [r.player_id, r.objective_id]);
      const again = ok(await g.act('Asha', { type: 'START_GAME' }, { actionId, expectedVersion: version }));
      expect(again.duplicate).toBe(true);
      expect((await objectiveRows(g)).map((r) => [r.player_id, r.objective_id])).toEqual(first);
      expect(await sql`select 1 from public.transactions where game_id = ${g.gameId} and type = 'STARTING_FUNDS'`).toHaveLength(2);
    });

    it('the database refuses a second objective, a changed one, a deleted one, and any in a Classic game', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      const asha = g.seats.Asha!.playerId;
      await expect(sql`insert into public.player_objectives (game_id, player_id, objective_id) values (${g.gameId}, ${asha}, 'BUILDER')`).rejects.toThrow(/duplicate key/);
      const current = (await sql`select objective_id from public.player_objectives where game_id = ${g.gameId} and player_id = ${asha}`)[0]!.objective_id as string;
      const other = OBJECTIVE_IDS.find((id) => id !== current)!;
      await expect(sql`update public.player_objectives set objective_id = ${other} where game_id = ${g.gameId} and player_id = ${asha}`).rejects.toThrow(/cannot be changed/);
      await expect(sql`delete from public.player_objectives where game_id = ${g.gameId} and player_id = ${asha}`).rejects.toThrow(/permanent/);
      await expect(sql`update public.player_objectives set objective_id = 'TRANSPORT_TYCOON' where game_id = ${g.gameId}`).rejects.toThrow();
      const classic = await setupGame();
      await expect(sql`insert into public.player_objectives (game_id, player_id, objective_id) values (${classic.gameId}, ${classic.seats.Asha!.playerId}, 'BUILDER')`).rejects.toThrow(/only in Intermediate Mode/);
      // A player of one game can't be given an objective in another.
      const second = await setupGame({ mode: 'intermediate', config: { secretObjectives: false } });
      await expect(sql`insert into public.player_objectives (game_id, player_id, objective_id) values (${second.gameId}, ${asha}, 'BUILDER')`).rejects.toThrow(/is not in game/);
    });

    it('the app’s own database roles cannot read or write objectives or settings', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      for (const role of ['anon', 'authenticated']) {
        for (const table of ['player_objectives', 'games']) {
          const [priv] = await sql`
            select has_table_privilege(${role}, ${`public.${table}`}, 'select') as can_select,
                   has_table_privilege(${role}, ${`public.${table}`}, 'insert') as can_insert,
                   has_table_privilege(${role}, ${`public.${table}`}, 'update') as can_update`;
          expect(priv).toEqual({ can_select: false, can_insert: false, can_update: false });
        }
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            return tx`select objective_id from public.player_objectives where game_id = ${g.gameId}`;
          }),
        ).rejects.toThrow(/permission denied/);
      }
      const [rls] = await sql`select relrowsecurity, (select count(*)::int from pg_policies where tablename = 'player_objectives') as policies from pg_class where oid = 'public.player_objectives'::regclass`;
      expect(rls).toEqual({ relrowsecurity: true, policies: 0 });
    });
  });

  describe('the end of the game: evaluated once, paid once, then revealed', () => {
    it('pays each completed objective from the bank, stores every result, and reveals them to all', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      await forceObjectives(g, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER', Chitra: 'CASH_GUARDIAN' });
      // Chitra drops ₹100 below the threshold.
      ok(await g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.seats.Bilal!.playerId, amount: 13100 }));
      const ended = ok(await g.act('Asha', { type: 'END_GAME' }));

      expect((await rewardRows(g)).map((r) => [r.to_player_id, Number(r.amount), r.memo])).toEqual([[g.seats.Asha!.playerId, 4000, 'Secret objective bonus: Cash Guardian']]);
      const rows = Object.fromEntries((await objectiveRows(g)).map((r) => [r.player_id as string, r]));
      expect(rows[g.seats.Asha!.playerId]).toMatchObject({ objective_id: 'CASH_GUARDIAN', completed: true, detail: 'Finished with ₹25,000 cash (needs ₹12,000).' });
      expect(Number(rows[g.seats.Asha!.playerId]!.reward)).toBe(4000);
      expect(rows[g.seats.Bilal!.playerId]).toMatchObject({ objective_id: 'BUILDER', completed: false, detail: 'Finished with 0 houses (needs 3).' });
      expect(rows[g.seats.Chitra!.playerId]).toMatchObject({ objective_id: 'CASH_GUARDIAN', completed: false, detail: 'Finished with ₹11,900 cash (needs ₹12,000).' });
      for (const r of Object.values(rows)) expect(r.evaluated_at).not.toBeNull();
      expect(await ledgerOk(g)).toBe(true);

      // The winner is the one the final balances say: Bilal (₹38,100) ahead of Asha (₹29,000 with her bonus).
      expect(ended.snapshot.state.winnerId).toBe(g.seats.Bilal!.playerId);
      const expected = [
        { playerId: g.seats.Asha!.playerId, objectiveId: 'CASH_GUARDIAN', completed: true, reward: 4000, detail: 'Finished with ₹25,000 cash (needs ₹12,000).' },
        { playerId: g.seats.Bilal!.playerId, objectiveId: 'BUILDER', completed: false, reward: 0, detail: 'Finished with 0 houses (needs 3).' },
        { playerId: g.seats.Chitra!.playerId, objectiveId: 'CASH_GUARDIAN', completed: false, reward: 0, detail: 'Finished with ₹11,900 cash (needs ₹12,000).' },
      ];
      // Now — and only now — every player receives every objective and result, identically.
      for (const name of g.names) {
        const s = await g.view(name);
        expect(Object.keys(s.state.objectives!.assignments).sort()).toEqual(g.names.map((n) => g.seats[n]!.playerId).sort());
        expect(s.state.objectives!.results).toEqual(expected);
        expect(s.state.players.find((p) => p.id === g.seats.Asha!.playerId)!.balance).toBe(29000);
      }
      const types = broadcasts.at(-1)!.payload.events.map((e) => e.type);
      expect(types.filter((t) => t === 'OBJECTIVE_RESULT')).toHaveLength(3);
      expect(types.at(-1)).toBe('GAME_FINISHED');
    });

    it('a retried END_GAME, a second END_GAME and a late action pay nothing more', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      await forceObjectives(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN' });
      const actionId = randomUUID();
      const version = (await g.view('Asha')).state.version;
      ok(await g.act('Asha', { type: 'END_GAME' }, { actionId, expectedVersion: version }));
      const retried = ok(await g.act('Asha', { type: 'END_GAME' }, { actionId, expectedVersion: version }));
      expect(retried.duplicate).toBe(true);
      expect(refused(await g.act('Asha', { type: 'END_GAME' })).code).toBe('GAME_FINISHED');
      expect(refused(await g.act('Bilal', { type: 'LEAVE_GAME' })).code).toBe('GAME_FINISHED');
      expect(await rewardRows(g)).toHaveLength(2);
      expect((await sql`select balance from public.players where game_id = ${g.gameId}`).map((p) => Number(p.balance))).toEqual([29000, 29000]);
      expect(await ledgerOk(g)).toBe(true);
    });

    it('two requests finishing the game at the same moment: it is finished once', async () => {
      const g = await setupGame({ mode: 'intermediate', names: ['Asha', 'Bilal', 'Chitra'] });
      await forceObjectives(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN', Chitra: 'CASH_GUARDIAN' });
      const version = (await g.view('Asha')).state.version;
      // The host ends the game twice at once (two taps, two action ids) while another player leaves.
      const results = await Promise.all([
        g.act('Asha', { type: 'END_GAME' }, { expectedVersion: version }),
        g.act('Asha', { type: 'END_GAME' }, { expectedVersion: version }),
        g.act('Chitra', { type: 'LEAVE_GAME' }, { expectedVersion: version }),
      ]);
      expect(results.slice(0, 2).filter((r) => r.ok)).toHaveLength(1);
      const rewards = await rewardRows(g);
      // One bonus per player at most, whoever was still in the game when it ended.
      expect(new Set(rewards.map((r) => r.to_player_id)).size).toBe(rewards.length);
      expect(rewards.length).toBeGreaterThanOrEqual(2);
      expect(rewards.length).toBeLessThanOrEqual(3);
      expect((await objectiveRows(g)).every((r) => r.evaluated_at !== null)).toBe(true);
      expect(await sql`select 1 from public.game_events where game_id = ${g.gameId} and type = 'GAME_FINISHED'`).toHaveLength(1);
      expect(await ledgerOk(g)).toBe(true);
    });

    it('the database refuses a second bonus and a rewritten result', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      await forceObjectives(g, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER' });
      ok(await g.act('Asha', { type: 'END_GAME' }));
      const asha = g.seats.Asha!.playerId;
      const bilal = g.seats.Bilal!.playerId;
      await expect(
        sql`insert into public.transactions (id, game_id, action_id, type, from_player_id, to_player_id, amount, memo)
            values (${randomUUID()}, ${g.gameId}, ${randomUUID()}, 'OBJECTIVE_REWARD', null, ${asha}, 4000, 'again')`,
      ).rejects.toThrow(/transactions_one_objective_reward_idx/);
      await expect(sql`update public.player_objectives set completed = true, reward = 4000 where game_id = ${g.gameId} and player_id = ${bilal}`).rejects.toThrow(/already final/);
      expect(await rewardRows(g)).toHaveLength(1);
    });

    it('a failure while finishing leaves nothing half done: no result, no bonus, game still running', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      await forceObjectives(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN' });
      // Sabotage: a result already written for one player makes the result write fail mid-transaction.
      await sql`update public.player_objectives set completed = false, reward = 0, detail = 'x', evaluated_at = now() where game_id = ${g.gameId} and player_id = ${g.seats.Bilal!.playerId}`;
      const res = await g.act('Asha', { type: 'END_GAME' });
      expect(res.ok).toBe(false);
      expect((await sql`select status from public.games where id = ${g.gameId}`)[0]!.status).toBe('ACTIVE');
      expect(await rewardRows(g)).toHaveLength(0);
      expect((await sql`select balance from public.players where game_id = ${g.gameId}`).map((p) => Number(p.balance))).toEqual([25000, 25000]);
      expect((await sql`select evaluated_at from public.player_objectives where game_id = ${g.gameId} and player_id = ${g.seats.Asha!.playerId}`)[0]!.evaluated_at).toBeNull();
      expect(await ledgerOk(g)).toBe(true);
    });

    it('a completed trade is counted once and survives reloads; an undone one is forgotten', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      await forceObjectives(g, { Asha: 'DEAL_MAKER', Bilal: 'BUILDER' });
      const asha = g.seats.Asha!.playerId;
      const bilal = g.seats.Bilal!.playerId;
      await sql`update public.properties set owner_player_id = ${asha} where game_id = ${g.gameId} and property_key in ('MUMBAI', 'INDORE')`;
      const tradeOnce = async (key: string) => {
        ok(await g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: bilal, offeredPropertyKeys: [key], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 }));
        const offer = (await g.view('Bilal')).state.trades.filter((t) => t.status === 'PENDING').at(-1)!;
        const actionId = randomUUID();
        const version = (await g.view('Bilal')).state.version;
        ok(await g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: offer.id }, { actionId, expectedVersion: version }));
        // The same accept, delivered again: answered from the record, not run again.
        expect(ok(await g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: offer.id }, { actionId, expectedVersion: version })).duplicate).toBe(true);
      };
      const counted = async () => ((await sql`select objective_trades from public.games where id = ${g.gameId}`)[0]!.objective_trades as unknown[]).length;
      await tradeOnce('MUMBAI');
      expect(await counted()).toBe(1);
      // Undo it: it no longer counts.
      const top = (await g.view('Asha')).state.undoStack.at(-1)!;
      ok(await g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top.actionId }));
      ok(await g.act('Bilal', { type: 'APPROVE_UNDO', requestId: (await g.view('Bilal')).state.undoRequest!.id }));
      expect(await counted()).toBe(0);
      await tradeOnce('MUMBAI');
      await tradeOnce('INDORE');
      expect(await counted()).toBe(2);
      ok(await g.act('Asha', { type: 'END_GAME' }));
      const row = (await sql`select completed, reward, detail from public.player_objectives where game_id = ${g.gameId} and player_id = ${asha}`)[0]!;
      expect([row.completed, Number(row.reward), row.detail]).toEqual([true, 4000, 'Finished with 2 trades completed (needs 2).']);
    });

    it('Classic and objectives-off games finish with no objective rows, results or bonus', async () => {
      for (const options of [{}, { mode: 'intermediate' as const, config: { secretObjectives: false } }]) {
        const g = await setupGame(options);
        const ended = ok(await g.act('Asha', { type: 'END_GAME' }));
        expect(ended.snapshot.state.objectives).toBeNull();
        expect(await objectiveRows(g)).toHaveLength(0);
        expect(await rewardRows(g)).toHaveLength(0);
        expect(ended.snapshot.events.some((e) => e.type === 'OBJECTIVE_RESULT')).toBe(false);
        expect((await sql`select balance from public.players where game_id = ${g.gameId}`).map((p) => Number(p.balance))).toEqual([25000, 25000]);
      }
    });

    it('an expired game’s objectives are purged with it', async () => {
      const g = await setupGame({ mode: 'intermediate' });
      expect(await objectiveRows(g)).toHaveLength(2);
      await sql`update public.games set expires_at = now() - interval '2 days' where id = ${g.gameId}`;
      await sql`select public.purge_expired_games()`;
      expect(await sql`select 1 from public.games where id = ${g.gameId}`).toHaveLength(0);
      expect(await objectiveRows(g)).toHaveLength(0);
    });
  });
});
