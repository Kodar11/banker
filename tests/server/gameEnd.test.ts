/// <reference types="node" />
/**
 * Game duration and end-game votes through the real handler (the code the Edge Function runs)
 * against a real Postgres with the production migrations applied: what is stored, what each
 * player's device is actually sent, exactly-once behaviour, races and the server's own deadline.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { closeEndVoteIfDue, handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import { BOARD_SIZE, END_VOTE_SECONDS, INTERMEDIATE_RULES as IR, type ApiResponse, type GameAction, type GameMode, type GameSnapshot, type StateBroadcast } from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('game duration and end-game votes (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedRandoms: number[] = [];
  let queuedDice: number[] = [];
  /** Moves the server's clock forward without waiting. */
  let skewMs = 0;
  let deferred: { delayMs: number; task: () => Promise<void> }[] = [];
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcast: async (gameId, payload) => {
        broadcasts.push({ gameId, payload });
      },
      now: () => new Date(Date.now() + skewMs),
      defer: (delayMs, task) => void deferred.push({ delayMs, task }),
      random: () => {
        const raw = queuedRandoms.shift();
        if (raw !== undefined) return raw;
        const face = queuedDice.shift();
        return face === undefined ? Math.random() : (face - 1) / 6 + 0.01;
      },
    };
  });

  beforeEach(() => {
    broadcasts.length = 0;
    deferred = [];
    skewMs = 0;
    queuedDice = [];
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

  async function setupGame({ mode, config, names = ['Asha', 'Bilal', 'Chitra'], start = true }: { mode?: GameMode; config?: unknown; names?: string[]; start?: boolean } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, ...(mode ? { mode } : {}), ...(config ? { config } : {}) }));
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    const joined: Record<string, GameSnapshot> = { [host!]: created.snapshot };
    for (const name of rest) {
      const t = token();
      const res = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code: created.snapshot.state.code, name }));
      seats[name] = { playerId: res.playerId, token: t };
      joined[name] = res.snapshot;
    }
    const g = {
      gameId,
      seats,
      names,
      joined,
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
  const row = async (g: Game) => (await sql`select status, config, end_game, intermediate, current_player_id, state_version from public.games where id = ${g.gameId}`)[0]!;
  const endGame = async (g: Game) => (await row(g)).end_game as { extraYears: number; requestedIn: Record<string, number>; vote: { id: string; kind: string; required: number; electorate: string[]; ballots: Record<string, string>; endsAt: string } | null; lastResult: { outcome: string } | null } | null;
  const eventTypes = async (g: Game, type: string) => sql`select type, payload, actor_player_id from public.game_events where game_id = ${g.gameId} and type = ${type} order by seq`;
  const ledgerOk = async (g: Game) => (await sql`select ok from public.verify_game_ledger(${g.gameId})`).every((r) => r.ok === true);
  const ballot = (voteId: string, choice: 'END' | 'CONTINUE') => ({ type: 'CAST_END_VOTE', voteId, choice }) as const;

  /** Asha asks for an early vote; returns the vote's id. */
  async function openVote(g: Game, requester = 'Asha'): Promise<string> {
    return ok(await g.act(requester, { type: 'REQUEST_END_VOTE' })).snapshot.state.endGame!.vote!.id;
  }

  /**
   * Test surgery, then real play: puts the dice clock three spaces before the end of financial year
   * `year`, and has the player whose turn it is roll 3 onto Start and end their turn.
   */
  async function playOut(g: Game, year: number): Promise<Ok> {
    const game = await row(g);
    const ids = g.names.map((n) => g.seats[n]!.playerId);
    const movement = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? year * ids.length * IR.year.spacesPerYear - 3 : 0]));
    if (game.intermediate) {
      await sql`update public.games set intermediate = jsonb_set(jsonb_set(intermediate, '{movement}', ${sql.json(movement)}), '{year}', ${sql.json(year)}) where id = ${g.gameId}`;
    } else {
      await sql`update public.games set end_game = jsonb_set(end_game, '{calendar,movement}', ${sql.json(movement)}) where id = ${g.gameId}`;
    }
    const current = g.names.find((n) => g.seats[n]!.playerId === game.current_player_id)!;
    await sql`update public.players set position = ${BOARD_SIZE - 3} where id = ${g.seats[current]!.playerId}`;
    queuedDice = [1, 2];
    ok(await g.act(current, { type: 'ROLL_DICE' }));
    return ok(await g.act(current, { type: 'END_TURN' }));
  }

  // ---------------------------------------------------------------------------

  describe('the duration is stored with the game and validated by the server', () => {
    it.each(['classic', 'intermediate'] as const)('%s: every duration from 5 to 10 is stored and sent to every participant; none sent means 5', async (mode) => {
      for (const durationYears of [undefined, 5, 6, 7, 8, 9, 10]) {
        const g = await setupGame({ mode, config: durationYears ? { durationYears } : undefined, start: false, names: ['Asha', 'Bilal'] });
        const expected = durationYears ?? 5;
        expect(((await row(g)).config as { durationYears: number }).durationYears).toBe(expected);
        for (const name of g.names) {
          expect(g.joined[name]!.state.config.durationYears).toBe(expected);
          expect((await g.view(name)).state.config.durationYears).toBe(expected);
        }
      }
    });

    it('refuses anything else and creates nothing', async () => {
      const before = Number((await sql`select count(*) as n from public.games`)[0]!.n);
      for (const durationYears of [4, 11, 0, -7, 5.5, '7', null, [7], { years: 7 }]) {
        const res = await call({ op: 'create', actionId: randomUUID(), token: token(), name: 'Asha', config: { durationYears } });
        expect(`${JSON.stringify(durationYears)}: ${refused(res).code}`).toBe(`${JSON.stringify(durationYears)}: VALIDATION`);
      }
      expect(Number((await sql`select count(*) as n from public.games`)[0]!.n)).toBe(before);
    });

    it('only the host changes it, only in the lobby; a joiner cannot, and after the start nobody can — the database agrees', async () => {
      const g = await setupGame({ start: false, names: ['Asha', 'Bilal'] });
      expect(refused(await g.act('Bilal', { type: 'UPDATE_CONFIG', config: { durationYears: 9 } })).code).toBe('FORBIDDEN');
      expect(refused(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { durationYears: 11 } })).code).toBe('VALIDATION');
      ok(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { durationYears: 9 } }));
      expect((await g.view('Bilal')).state.config.durationYears).toBe(9);
      // A direct write of a duration the game does not allow is refused by the table itself.
      await expect(sql`update public.games set config = jsonb_set(config, '{durationYears}', '12') where id = ${g.gameId}`).rejects.toThrow(/games_config_duration_years/);
      await expect(sql`update public.games set config = jsonb_set(config, '{durationYears}', '7.5') where id = ${g.gameId}`).rejects.toThrow(/games_config_duration_years/);
      ok(await g.act('Asha', { type: 'START_GAME' }));
      for (const name of g.names) expect(refused(await g.act(name, { type: 'UPDATE_CONFIG', config: { durationYears: 5 } })).code).toBe('INVALID_PHASE');
      await expect(sql`update public.games set config = jsonb_set(config, '{durationYears}', '6') where id = ${g.gameId}`).rejects.toThrow(/config is locked/);
      expect(((await row(g)).config as { durationYears: number }).durationYears).toBe(9);
    });

    it('a game stored before durations existed (no durationYears, no end_game) plays the default five years and can vote', async () => {
      const g = await setupGame({ names: ['Asha', 'Bilal'] });
      await sql.begin(async (tx) => {
        await tx`alter table public.games disable trigger games_config_locked`;
        await tx`update public.games set config = config - 'durationYears', end_game = null where id = ${g.gameId}`;
        await tx`alter table public.games enable trigger games_config_locked`;
      });
      const loaded = await g.view('Bilal');
      expect(loaded.state.config.durationYears).toBe(5);
      const voteId = await openVote(g);
      expect(await endGame(g)).toMatchObject({ extraYears: 0, vote: { id: voteId, kind: 'EARLY', required: 2 } });
    });

    it('the selected duration survives the host leaving, a reconnect and every reload', async () => {
      const g = await setupGame({ config: { durationYears: 8 } });
      ok(await g.act('Asha', { type: 'LEAVE_GAME' }));
      for (const name of ['Bilal', 'Chitra']) expect((await g.view(name)).state.config.durationYears).toBe(8);
      expect((await g.view('Bilal')).state).toMatchObject({ status: 'ACTIVE', hostPlayerId: g.seats.Bilal!.playerId });
    });
  });

  describe('an early vote', () => {
    it('is stored once, with its electorate, threshold and server deadline; the server arms its own close', async () => {
      const g = await setupGame();
      const asked = ok(await g.act('Bilal', { type: 'REQUEST_END_VOTE' }));
      const vote = (await endGame(g))!.vote!;
      expect(vote).toMatchObject({ kind: 'EARLY', required: 2, ballots: { [g.seats.Bilal!.playerId]: 'END' } });
      expect(vote.electorate).toEqual(g.names.map((n) => g.seats[n]!.playerId));
      const left = Date.parse(vote.endsAt) - Date.now();
      expect(left).toBeGreaterThan((END_VOTE_SECONDS - 5) * 1000);
      expect(left).toBeLessThanOrEqual(END_VOTE_SECONDS * 1000);
      expect(asked.snapshot.state.endGame!.vote!.endsAt).toBe(vote.endsAt);
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.delayMs).toBeGreaterThan((END_VOTE_SECONDS - 5) * 1000);
      expect(deferred[0]!.delayMs).toBeLessThanOrEqual(END_VOTE_SECONDS * 1000 + 25);
      expect((await eventTypes(g, 'END_VOTE_STARTED')).map((e) => e.actor_player_id)).toEqual([g.seats.Bilal!.playerId]);
    });

    it('every device is sent its own ballot and nobody else’s — the host included — in responses, reloads and broadcasts', async () => {
      const g = await setupGame();
      const voteId = await openVote(g, 'Bilal');
      const cast = ok(await g.act('Chitra', ballot(voteId, 'CONTINUE')));
      // The response to Chitra's own ballot carries hers alone.
      expect(cast.snapshot.state.endGame!.vote!.ballots).toEqual({ [g.seats.Chitra!.playerId]: 'CONTINUE' });
      const own = { Asha: {}, Bilal: { [g.seats.Bilal!.playerId]: 'END' }, Chitra: { [g.seats.Chitra!.playerId]: 'CONTINUE' } };
      for (const name of g.names) {
        const seen = await g.view(name);
        expect(seen.state.endGame!.vote!.ballots).toEqual(own[name as keyof typeof own]);
        // Still enough to draw the vote: which one, what it asks, until when.
        expect(seen.state.endGame!.vote).toMatchObject({ id: voteId, kind: 'EARLY', required: 2 });
        expect(JSON.stringify(seen.events)).not.toMatch(/CAST_END_VOTE|ballot/i);
      }
      // A ballot is announced to nobody: the broadcast only says the game moved on.
      expect(broadcasts.at(-1)!.payload.events).toEqual([]);
      expect(JSON.stringify(broadcasts)).not.toMatch(/"CONTINUE"|ballots/);
      // The authoritative copy still holds both.
      expect(Object.keys((await endGame(g))!.vote!.ballots)).toHaveLength(2);
    });

    it('the result is published without a tally, to everyone alike', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      ok(await g.act('Bilal', ballot(voteId, 'CONTINUE')));
      const closed = ok(await g.act('Chitra', ballot(voteId, 'CONTINUE')));
      expect(closed.snapshot.state).toMatchObject({ status: 'ACTIVE', endGame: { vote: null, lastResult: { id: voteId, kind: 'EARLY', outcome: 'CONTINUED' } } });
      const [event] = await eventTypes(g, 'END_VOTE_CLOSED');
      expect(event).toMatchObject({ actor_player_id: null, payload: { voteId, kind: 'EARLY', outcome: 'CONTINUED', durationYears: 5 } });
      expect(broadcasts.at(-1)!.payload.events).toEqual([{ type: 'END_VOTE_CLOSED', message: 'Game will continue', actorId: null }]);
      for (const name of g.names) expect(JSON.stringify((await g.view(name)).state.endGame)).not.toMatch(/"END"|"CONTINUE"/);
    });

    it('reaching the strict majority finishes the game through the existing completion flow, once', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      ok(await g.act('Bilal', ballot(voteId, 'END')));
      const ended = ok(await g.act('Chitra', ballot(voteId, 'CONTINUE')));
      expect(ended.snapshot.state.status).toBe('FINISHED');
      const finished = await eventTypes(g, 'GAME_FINISHED');
      expect(finished).toHaveLength(1);
      expect(finished[0]!.payload).toMatchObject({ reason: 'VOTE', standings: g.names.map((n) => ({ playerId: g.seats[n]!.playerId, netWorth: 25000 })) });
      expect(await ledgerOk(g)).toBe(true);
      for (const name of g.names) expect(refused(await g.act(name, { type: 'ROLL_DICE' })).code).toBe('GAME_FINISHED');
      expect(refused(await g.act('Asha', { type: 'REQUEST_END_VOTE' })).code).toBe('GAME_FINISHED');
    });

    it('simultaneous requests from different devices open exactly one vote', async () => {
      const g = await setupGame({ names: ['Asha', 'Bilal', 'Chitra', 'Dev'] });
      const version = (await g.view('Asha')).state.version;
      const results = await Promise.all(g.names.map((name) => g.act(name, { type: 'REQUEST_END_VOTE' }, { expectedVersion: version })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) expect(refused(r)).toEqual({ code: 'INVALID_PHASE', message: 'A vote on ending the game is in progress.' });
      expect(await eventTypes(g, 'END_VOTE_STARTED')).toHaveLength(1);
      const stored = (await endGame(g))!;
      // Only the player whose request opened it has used their request for the year.
      expect(Object.keys(stored.requestedIn)).toEqual([stored.vote!.electorate.find((id) => id in stored.vote!.ballots)]);
    });

    it('a double tap is one request: the same action id is answered again and opens nothing new', async () => {
      const g = await setupGame();
      const actionId = randomUUID();
      const version = (await g.view('Asha')).state.version;
      const first = ok(await g.act('Asha', { type: 'REQUEST_END_VOTE' }, { actionId, expectedVersion: version }));
      const again = ok(await g.act('Asha', { type: 'REQUEST_END_VOTE' }, { actionId, expectedVersion: version }));
      expect(again.duplicate).toBe(true);
      expect(again.snapshot.state.endGame!.vote!.id).toBe(first.snapshot.state.endGame!.vote!.id);
      expect(await eventTypes(g, 'END_VOTE_STARTED')).toHaveLength(1);
    });

    it('once per player per financial year, enforced by the server after a failed vote too', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      for (const name of ['Bilal', 'Chitra']) ok(await g.act(name, ballot(voteId, 'CONTINUE')));
      expect(refused(await g.act('Asha', { type: 'REQUEST_END_VOTE' }))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'You have already asked for a vote this financial year. You can ask again next year.' });
      // Someone else may still ask, and Asha votes in it.
      const second = await openVote(g, 'Chitra');
      ok(await g.act('Asha', ballot(second, 'CONTINUE')));
      expect(await eventTypes(g, 'END_VOTE_STARTED')).toHaveLength(2);
    });
  });

  describe('one ballot per player', () => {
    it('a retried ballot is applied once; another ballot from the same player — a second device — is refused', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      const actionId = randomUUID();
      const version = (await g.view('Bilal')).state.version;
      ok(await g.act('Bilal', ballot(voteId, 'CONTINUE'), { actionId, expectedVersion: version }));
      expect(ok(await g.act('Bilal', ballot(voteId, 'CONTINUE'), { actionId, expectedVersion: version })).duplicate).toBe(true);
      // The same id for a different choice is not a retry, and not a way to change a vote.
      expect(refused(await g.act('Bilal', ballot(voteId, 'END'), { actionId, expectedVersion: version })).code).toBe('VALIDATION');
      expect(refused(await g.act('Bilal', ballot(voteId, 'END')))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'You have already voted.' });
      expect((await endGame(g))!.vote!.ballots[g.seats.Bilal!.playerId]).toBe('CONTINUE');
    });

    it('the same player voting from two devices at once casts one ballot', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      const version = (await g.view('Bilal')).state.version;
      const results = await Promise.all([
        g.act('Bilal', ballot(voteId, 'END'), { expectedVersion: version }),
        g.act('Bilal', ballot(voteId, 'CONTINUE'), { expectedVersion: version }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const stored = (await endGame(g))!.vote!;
      expect(Object.keys(stored.ballots).sort()).toEqual([g.seats.Asha!.playerId, g.seats.Bilal!.playerId].sort());
    });

    it('the last ballots arriving together give one result, the same for everyone', async () => {
      const g = await setupGame({ names: ['Asha', 'Bilal', 'Chitra', 'Dev'] });
      const voteId = await openVote(g);
      const version = (await g.view('Asha')).state.version;
      const results = await Promise.all([
        g.act('Bilal', ballot(voteId, 'END'), { expectedVersion: version }),
        g.act('Chitra', ballot(voteId, 'END'), { expectedVersion: version }),
        g.act('Dev', ballot(voteId, 'CONTINUE'), { expectedVersion: version }),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      // 3 END of 4, 3 needed.
      expect(await eventTypes(g, 'END_VOTE_CLOSED')).toHaveLength(1);
      expect(await eventTypes(g, 'GAME_FINISHED')).toHaveLength(1);
      const views = await Promise.all(g.names.map((n) => g.view(n)));
      expect(new Set(views.map((v) => `${v.state.status}:${v.state.version}:${v.state.endGame!.lastResult!.outcome}:${v.state.winnerId}`)).size).toBe(1);
      expect(views[0]!.state).toMatchObject({ status: 'FINISHED', endGame: { vote: null, lastResult: { outcome: 'ENDED' } } });
    });

    it('a player who is not an elector, or is not in the game, cannot vote', async () => {
      const g = await setupGame();
      const other = await setupGame({ names: ['Xena', 'Yusuf'] });
      const voteId = await openVote(g);
      const outsider = other.seats.Xena!;
      // Another game's seat is turned away at the door, with this game's id or its own.
      expect(refused(await call({ op: 'action', gameId: g.gameId, playerId: outsider.playerId, token: outsider.token, actionId: randomUUID(), expectedVersion: 1, action: ballot(voteId, 'END') })).code).toBe('FORBIDDEN');
      expect(refused(await other.act('Xena', ballot(voteId, 'END'))).code).toBe('VOTE_CLOSED');
      // A stolen player id without that player's token.
      expect(refused(await call({ op: 'action', gameId: g.gameId, playerId: g.seats.Chitra!.playerId, token: token(), actionId: randomUUID(), expectedVersion: 1, action: ballot(voteId, 'END') })).code).toBe('FORBIDDEN');
      ok(await g.act('Chitra', { type: 'LEAVE_GAME' }));
      expect(refused(await g.act('Chitra', ballot(voteId, 'END'))).code).toBe('FORBIDDEN');
      expect(Object.keys((await endGame(g))!.vote!.ballots)).toEqual([g.seats.Asha!.playerId]);
    });
  });

  describe('the deadline belongs to the server', () => {
    it('a ballot after the deadline is rejected, whatever the sender’s clock says', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      skewMs = (END_VOTE_SECONDS - 2) * 1000;
      ok(await g.act('Bilal', ballot(voteId, 'CONTINUE')));
      skewMs = END_VOTE_SECONDS * 1000 + 50;
      expect(refused(await g.act('Chitra', ballot(voteId, 'END')))).toEqual({ code: 'VOTE_CLOSED', message: 'Voting has ended.' });
      expect(Object.keys((await endGame(g))!.vote!.ballots)).toHaveLength(2);
    });

    it('the server’s timer closes the vote on what was cast; a missing ballot counts for neither side', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      // Not yet: the timer firing early changes nothing.
      expect(await closeEndVoteIfDue(g.gameId, voteId, deps)).toBe(false);
      expect((await endGame(g))!.vote).not.toBeNull();
      skewMs = END_VOTE_SECONDS * 1000 + 100;
      await deferred[0]!.task();
      // 1 END of 3 (the requester); the two who never voted are not END votes.
      expect(await endGame(g)).toMatchObject({ vote: null, lastResult: { outcome: 'CONTINUED' } });
      expect((await row(g)).status).toBe('ACTIVE');
      const [action] = await sql`select player_id, payload from public.game_actions where game_id = ${g.gameId} and type = 'CLOSE_END_VOTE'`;
      expect(action).toMatchObject({ player_id: null, payload: { voteId, by: 'SERVER_TIMER' } });
      // Play goes on.
      ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    });

    it('the timeout closes the vote exactly once: timers, phones and a late ballot racing', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      ok(await g.act('Bilal', ballot(voteId, 'END')));
      skewMs = END_VOTE_SECONDS * 1000 + 100;
      const version = (await g.view('Asha')).state.version;
      const results = await Promise.all([
        closeEndVoteIfDue(g.gameId, voteId, deps),
        closeEndVoteIfDue(g.gameId, voteId, deps),
        g.act('Asha', { type: 'CLOSE_END_VOTE', voteId }, { expectedVersion: version }),
        g.act('Chitra', { type: 'CLOSE_END_VOTE', voteId }, { expectedVersion: version }),
        g.act('Chitra', ballot(voteId, 'CONTINUE'), { expectedVersion: version }),
      ]);
      expect(results.filter((r) => r === true || (typeof r === 'object' && r.ok))).toHaveLength(1);
      expect(await eventTypes(g, 'END_VOTE_CLOSED')).toHaveLength(1);
      // 2 END of 3: the game ended, once.
      expect(await eventTypes(g, 'GAME_FINISHED')).toHaveLength(1);
      expect(await ledgerOk(g)).toBe(true);
    });

    it('a lost timer is recovered by the next read of the game', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      deferred = []; // the function instance that armed the timer is gone
      await g.view('Bilal');
      expect(deferred).toHaveLength(0);
      skewMs = END_VOTE_SECONDS * 1000 + 100;
      const read = await g.view('Bilal');
      // The read itself is a read: it answers with what it found, and arms the close.
      expect(read.state.endGame!.vote!.id).toBe(voteId);
      expect(deferred).toHaveLength(1);
      await deferred[0]!.task();
      expect((await endGame(g))!.vote).toBeNull();
    });

    it('a player who reconnects during the vote gets the same vote, the same deadline and their own ballot back', async () => {
      const g = await setupGame();
      const voteId = await openVote(g);
      const cast = ok(await g.act('Chitra', ballot(voteId, 'CONTINUE')));
      const deadline = cast.snapshot.state.endGame!.vote!.endsAt;
      skewMs = 12_000;
      for (let i = 0; i < 3; i += 1) {
        const again = await g.view('Chitra');
        expect(again.state.endGame!.vote).toMatchObject({ id: voteId, endsAt: deadline, ballots: { [g.seats.Chitra!.playerId]: 'CONTINUE' } });
        expect(Object.keys(again.state.endGame!.vote!.ballots)).toHaveLength(1);
      }
      // Reloading opened no second vote and changed no deadline.
      expect(await eventTypes(g, 'END_VOTE_STARTED')).toHaveLength(1);
      expect((await endGame(g))!.vote!.endsAt).toBe(deadline);
    });
  });

  describe.each(['classic', 'intermediate'] as const)('when the selected duration is over (%s)', (mode) => {
    it('the vote opens by itself, no turn starts, and without enough END ballots the same game runs one more year', async () => {
      const g = await setupGame({ mode, config: { secretObjectives: false } });
      const opened = await playOut(g, 5);
      expect(opened.snapshot.state.endGame!.vote).toMatchObject({ kind: 'DURATION', required: 1, requestedBy: null, year: 5 });
      const before = await row(g);
      expect(before.current_player_id).toBe(g.seats.Asha!.playerId);
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      // Nobody plays, and nobody asks for another vote, until this one is settled.
      queuedDice = [1, 1];
      for (const name of g.names) expect(refused(await g.act(name, { type: 'ROLL_DICE' })).code).toMatch(/INVALID_PHASE|NOT_YOUR_TURN/);
      expect(refused(await g.act('Bilal', { type: 'REQUEST_END_VOTE' })).code).toBe('INVALID_PHASE');
      const balances = await sql`select id, balance, position from public.players where game_id = ${g.gameId} order by seat`;
      const voteId = opened.snapshot.state.endGame!.vote!.id;
      for (const name of g.names) ok(await g.act(name, ballot(voteId, 'CONTINUE')));

      const after = await row(g);
      expect(after).toMatchObject({ status: 'ACTIVE', current_player_id: g.seats.Bilal!.playerId });
      expect(after.end_game).toMatchObject({ extraYears: 1, vote: null, lastResult: { kind: 'DURATION', outcome: 'EXTENDED' } });
      // The initial setting is untouched: the extension is recorded beside it, not over it.
      expect((after.config as { durationYears: number }).durationYears).toBe(5);
      expect(await sql`select id, balance, position from public.players where game_id = ${g.gameId} order by seat`).toEqual(balances);
      expect((await eventTypes(g, 'END_VOTE_CLOSED'))[0]!.payload).toMatchObject({ outcome: 'EXTENDED', durationYears: 6 });
      if (mode === 'intermediate') {
        expect((after.intermediate as { year: number }).year).toBe(6);
        // Year 6 began once — with the extension, not with the roll that reached it.
        expect((await eventTypes(g, 'FINANCIAL_YEAR_STARTED')).map((e) => (e.payload as { year: number }).year)).toEqual([6]);
      }
      expect(await ledgerOk(g)).toBe(true);

      // The extra year ends in another vote; one END ballot of three is enough now.
      const again = await playOut(g, 6);
      const second = again.snapshot.state.endGame!.vote!;
      expect(second).toMatchObject({ kind: 'DURATION', year: 6, required: 1 });
      ok(await g.act('Chitra', ballot(second.id, 'END')));
      ok(await g.act('Asha', ballot(second.id, 'CONTINUE')));
      const ended = ok(await g.act('Bilal', ballot(second.id, 'CONTINUE')));
      expect(ended.snapshot.state.status).toBe('FINISHED');
      expect((await eventTypes(g, 'GAME_FINISHED'))[0]!.payload).toMatchObject({ reason: 'DURATION_VOTE' });
      if (mode === 'intermediate') {
        // Ending did not start year 7.
        expect(((await row(g)).intermediate as { year: number }).year).toBe(6);
        expect(await eventTypes(g, 'FINANCIAL_YEAR_STARTED')).toHaveLength(1);
      }
      expect(await ledgerOk(g)).toBe(true);
    });

    it('year 10 cannot be extended: the game finishes there with no vote', async () => {
      const g = await setupGame({ mode, config: { durationYears: 10, secretObjectives: false }, names: ['Asha', 'Bilal'] });
      const ended = await playOut(g, 10);
      expect(ended.snapshot.state).toMatchObject({ status: 'FINISHED', endGame: { extraYears: 0, vote: null } });
      expect(await eventTypes(g, 'END_VOTE_STARTED')).toHaveLength(0);
      expect((await eventTypes(g, 'GAME_FINISHED'))[0]!.payload).toMatchObject({ reason: 'DURATION_REACHED' });
      expect(await ledgerOk(g)).toBe(true);
    });

    it('if nobody answers, the server’s timer extends the game and the next player’s turn begins on every phone', async () => {
      const g = await setupGame({ mode, names: ['Asha', 'Bilal'] });
      const opened = await playOut(g, 5);
      const voteId = opened.snapshot.state.endGame!.vote!.id;
      broadcasts.length = 0;
      skewMs = END_VOTE_SECONDS * 1000 + 100;
      expect(await closeEndVoteIfDue(g.gameId, voteId, deps)).toBe(true);
      expect(await closeEndVoteIfDue(g.gameId, voteId, deps)).toBe(false);
      expect(await row(g)).toMatchObject({ status: 'ACTIVE', current_player_id: g.seats.Bilal!.playerId });
      const told = broadcasts.at(-1)!.payload.events.map((e) => e.type);
      expect(told).toEqual(expect.arrayContaining(['END_VOTE_CLOSED', 'TURN_STARTED']));
      for (const name of g.names) expect((await g.view(name)).state).toMatchObject({ turn: { playerId: g.seats.Bilal!.playerId }, endGame: { extraYears: 1, vote: null } });
    });
  });
});
