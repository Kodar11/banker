/// <reference types="node" />
/**
 * The debt, insolvency and departure rules (docs/economy-rules.md) through the game-action handler,
 * against a real Postgres with every migration applied: what is stored, that the ledger still
 * balances, and that a retried request settles nothing twice.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npx vitest run tests/server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endByVote } from './endByVote.ts';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import { BUSINESS_MVP_RULES, type ApiResponse, type GameAction, type GameSnapshot, type PropertyKey } from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const START = BUSINESS_MVP_RULES.startingCash;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('debt, insolvency and departure through the handler (Postgres)', () => {
  let sql: Sql;
  let queuedDice: number[] = [];
  let queuedRandoms: number[] = [];
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcast: async () => {},
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

  async function setupGame(names: string[]) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host }));
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    for (const name of rest) {
      const t = token();
      const joined = ok(await call({ op: 'join', actionId: randomUUID(), token: t, code: created.snapshot.state.code, name }));
      seats[name] = { playerId: joined.playerId, token: t };
    }
    const snap = (name: string = host!): Promise<GameSnapshot> =>
      call({ op: 'state', gameId, playerId: seats[name]!.playerId, token: seats[name]!.token }).then((r) => ok(r).snapshot);
    const act = async (name: string, action: GameAction, opts: { actionId?: string; dice?: number[] } = {}) => {
      const seat = seats[name]!;
      const expectedVersion = (await snap(name)).state.version;
      if (action.type === 'START_GAME') queuedRandoms = orderRandoms(names, names);
      queuedDice = opts.dice ?? [];
      const res = await call({ op: 'action', gameId, playerId: seat.playerId, token: seat.token, actionId: opts.actionId ?? randomUUID(), expectedVersion, action });
      queuedRandoms = [];
      queuedDice = [];
      return res;
    };
    ok(await act(host!, { type: 'START_GAME' }));
    const id = (name: string) => seats[name]!.playerId;
    /** Test surgery on the stored board: who owns a property and what stands on it. */
    const give = (name: string, key: PropertyKey, built: { houses?: number; hotel?: boolean } = {}) =>
      sql`update public.properties set owner_player_id = ${id(name)}, houses = ${built.houses ?? 0}, hotel = ${built.hotel ?? false}
          where game_id = ${gameId} and property_key = ${key}`;
    const place = (name: string, position: number, circuits?: number) =>
      circuits === undefined
        ? sql`update public.players set position = ${position} where id = ${id(name)}`
        : sql`update public.players set position = ${position}, circuits = ${circuits} where id = ${id(name)}`;
    return { gameId, names, seats, id, snap, act, give, place };
  }

  async function ledgerOk(gameId: string) {
    const rows = await sql`select * from public.verify_game_ledger(${gameId})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ok).toBe(true);
  }

  it('a Classic loan stores its maturity; two missed Starts default it once; repaying it clears the default', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
    const [loan] = await sql`select id, created_at_circuit, maturity_circuit, status, closed_at from public.loans where game_id = ${g.gameId}`;
    expect(loan).toMatchObject({ created_at_circuit: 0, maturity_circuit: BUSINESS_MVP_RULES.loans.maturityCircuits, status: 'ACTIVE', closed_at: null });

    // Asha has already reached her maturity Start once without repaying (overdue); the next Start defaults it.
    await g.place('Asha', 34, BUSINESS_MVP_RULES.loans.maturityCircuits + 1);
    const rolled = ok(await g.act('Asha', { type: 'ROLL_DICE' }, { dice: [1, 1] }));
    expect(rolled.snapshot.events.some((e) => e.type === 'LOAN_DEFAULTED')).toBe(true);
    const [defaulted] = await sql`select status, outstanding, closed_at from public.loans where id = ${loan!.id}`;
    expect(defaulted).toMatchObject({ status: 'DEFAULTED', outstanding: 5000, closed_at: null });
    expect(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).toMatchObject({ ok: false, error: { code: 'LOAN_NOT_ALLOWED' } });

    ok(await g.act('Asha', { type: 'REPAY_LOAN', loanId: loan!.id as string, amount: 2000 }));
    expect((await sql`select status, outstanding from public.loans where id = ${loan!.id}`)[0]).toMatchObject({ status: 'DEFAULTED', outstanding: 3000 });
    ok(await g.act('Asha', { type: 'REPAY_LOAN', loanId: loan!.id as string, amount: 3000 }));
    const [cleared] = await sql`select status, outstanding, closed_at from public.loans where id = ${loan!.id}`;
    expect(cleared).toMatchObject({ status: 'REPAID', outstanding: 0 });
    expect(cleared!.closed_at).not.toBeNull();
    ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 }));
    await ledgerOk(g.gameId);
  });

  it('bankruptcy: refused while the money can be raised; then the estate pays the creditor once, and the bank, with every row stored', async () => {
    const g = await setupGame(['Asha', 'Bilal', 'Chitra']);
    await g.give('Bilal', 'MUMBAI', { hotel: true });
    await g.give('Asha', 'INDORE', { houses: 1 });
    ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 2000 }));
    ok(await g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START + 2000 - 500 }));
    await g.place('Asha', 33); // 4 to Mumbai, passing Start: + ₹1,500, and the loan's ₹200 interest is paid there
    ok(await g.act('Asha', { type: 'ROLL_DICE' }, { dice: [2, 2] }));
    const owing = await g.snap('Asha');
    expect(owing.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', toPlayerId: g.id('Bilal') });
    // While she owes, she can't give money away — and nothing is stored for the attempt.
    expect(await g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 100 })).toMatchObject({ ok: false, error: { code: 'TRANSFER_NOT_ALLOWED' } });

    const bilal = (await g.snap('Bilal')).state.players.find((p) => p.name === 'Bilal')!.balance;
    const actionId = randomUUID();
    const res = ok(await g.act('Asha', { type: 'DECLARE_BANKRUPTCY' }, { actionId }));
    // A retry of the same request is answered from the record: nothing is settled twice.
    const retry = await call({ op: 'action', gameId: g.gameId, playerId: g.id('Asha'), token: g.seats.Asha!.token, actionId, expectedVersion: res.snapshot.state.version - 1, action: { type: 'DECLARE_BANKRUPTCY' } });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(await g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).toMatchObject({ ok: false });

    const rows = await sql`select type, from_player_id, to_player_id, amount from public.transactions where game_id = ${g.gameId} and action_id = ${actionId} order by seq`;
    const cash = 500 + 1500 - 200;
    expect(rows.map((r) => [r.type, r.amount])).toEqual([
      ['HOUSE_SALE', 1000],
      ['PROPERTY_SALE', 750],
      ['BANKRUPTCY_SETTLEMENT', cash + 1750],
    ]);
    expect(rows.at(-1)).toMatchObject({ from_player_id: g.id('Asha'), to_player_id: g.id('Bilal') });
    const after = await g.snap('Bilal');
    expect(after.state.players.find((p) => p.name === 'Bilal')!.balance).toBe(bilal + cash + 1750);
    const [player] = await sql`select status, balance from public.players where id = ${g.id('Asha')}`;
    expect(player).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(await sql`select property_key from public.properties where game_id = ${g.gameId} and owner_player_id = ${g.id('Asha')}`).toHaveLength(0);
    expect((await sql`select houses from public.properties where game_id = ${g.gameId} and property_key = 'INDORE'`)[0]).toMatchObject({ houses: 0 });
    // The loan the estate could not pay stays on record, closed — not erased.
    const [loan] = await sql`select status, outstanding, closed_at from public.loans where game_id = ${g.gameId}`;
    expect(loan).toMatchObject({ status: 'DEFAULTED', outstanding: 2000 });
    expect(loan!.closed_at).not.toBeNull();
    expect(after.events.filter((e) => e.type === 'ESTATE_SETTLED')).toHaveLength(1);
    await ledgerOk(g.gameId);
  });

  it('leaving while owing rent pays the rent first and takes the rest out of play; a retried leave settles nothing twice', async () => {
    const g = await setupGame(['Asha', 'Bilal', 'Chitra']);
    await g.give('Bilal', 'DELHI');
    await g.give('Asha', 'AGRA');
    await g.place('Asha', 7); // 3 to Delhi
    ok(await g.act('Asha', { type: 'ROLL_DICE' }, { dice: [1, 2] }));
    const rent = ((await g.snap('Asha')).state.turn.pending as { amount: number }).amount;
    const actionId = randomUUID();
    const left = ok(await g.act('Asha', { type: 'LEAVE_GAME' }, { actionId }));
    expect(left.snapshot.state.turn.playerId).toBe(g.id('Bilal'));
    const retry = await call({ op: 'action', gameId: g.gameId, playerId: g.id('Asha'), token: g.seats.Asha!.token, actionId, expectedVersion: left.snapshot.state.version - 1, action: { type: 'LEAVE_GAME' } });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    const rows = await sql`select type, to_player_id, amount from public.transactions where game_id = ${g.gameId} and from_player_id = ${g.id('Asha')} and type in ('RENT_PAYMENT', 'ESTATE_SETTLEMENT') order by seq`;
    expect(rows.map((r) => [r.type, r.to_player_id, r.amount])).toEqual([
      ['RENT_PAYMENT', g.id('Bilal'), rent],
      ['ESTATE_SETTLEMENT', null, START - rent],
    ]);
    expect((await sql`select status, balance from public.players where id = ${g.id('Asha')}`)[0]).toMatchObject({ status: 'LEFT', balance: 0 });
    expect((await sql`select owner_player_id from public.properties where game_id = ${g.gameId} and property_key = 'AGRA'`)[0]).toMatchObject({ owner_player_id: null });
    await ledgerOk(g.gameId);
  });

  it('a game ended with every player level is a shared victory: no single winner is stored', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const res = ok(await endByVote(g.act, g.names));
    expect(res.snapshot.state.status).toBe('FINISHED');
    const [game] = await sql`select status, winner_player_id from public.games where id = ${g.gameId}`;
    expect(game).toMatchObject({ status: 'FINISHED', winner_player_id: null });
    const finished = res.snapshot.events.find((e) => e.type === 'GAME_FINISHED')!;
    expect(finished.payload).toMatchObject({ sharedVictory: true, winnerIds: [g.id('Asha'), g.id('Bilal')] });
    // Finished means finished: nothing more is accepted, so the result can't change.
    expect(await g.act('Asha', { type: 'REQUEST_END_VOTE' })).toMatchObject({ ok: false, error: { code: 'GAME_FINISHED' } });
    await ledgerOk(g.gameId);
  });
});
