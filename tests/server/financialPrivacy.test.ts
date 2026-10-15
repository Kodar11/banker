/// <reference types="node" />
/**
 * Open / Hidden finances through the real game-action handler, against a real Postgres with the
 * production migrations applied: what is stored, and what each player's device is actually sent -
 * on create, join, read, action, retry and broadcast.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { endByVote } from './endByVote.ts';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import {
  formatINR,
  offeredRate,
  premiumForYear,
  type ApiResponse,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type StateBroadcast,
} from '../../supabase/functions/_shared/engine/index.ts';
import { faceToRandom, orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('open and hidden finances (Postgres)', () => {
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
      random: () => queuedRandoms.shift() ?? Math.random(),
    };
  });

  beforeEach(() => {
    broadcasts.length = 0;
    queuedRandoms = [];
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

  const NAMES = ['Asha', 'Bilal', 'Chitra'];

  async function setupGame({ mode, config, start = true }: { mode?: GameMode; config?: unknown; start?: boolean } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = NAMES;
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
    const view = async (name: string) => ok(await call({ op: 'state', gameId, playerId: seats[name]!.playerId, token: seats[name]!.token })).snapshot;
    const g = {
      gameId,
      seats,
      joined,
      id: (name: string) => seats[name]!.playerId,
      view,
      /** Sends an action; `dice` pins the two faces of a ROLL_DICE. Returns the server's whole answer. */
      act: async (name: string, action: GameAction | Record<string, unknown>, opts: { actionId?: string; dice?: [number, number] } = {}) => {
        const seat = seats[name]!;
        const expectedVersion = (await view(name)).state.version;
        if (action.type === 'START_GAME') queuedRandoms = orderRandoms(NAMES, NAMES);
        if (opts.dice) queuedRandoms = opts.dice.map(faceToRandom);
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
  /** Test surgery: hands a property to a player, as if they had bought it earlier. */
  const give = (g: Game, name: string, key: string) => sql`update public.properties set owner_player_id = ${g.id(name)} where game_id = ${g.gameId} and property_key = ${key}`;
  const balanceOf = (snapshot: GameSnapshot, g: Game, name: string) => snapshot.state.players.find((p) => p.id === g.id(name))!.balance;
  const messages = (snapshot: GameSnapshot) => snapshot.events.map((e) => e.message);
  const broadcastMessages = (g: Game) => broadcasts.filter((b) => b.gameId === g.gameId).flatMap((b) => b.payload.events.map((e) => e.message));
  const HIDDEN = { financialPrivacy: 'hidden' };

  // -------------------------------------------------------------------------

  describe('the setting is the server’s', () => {
    it('is Open unless the host asks for Hidden, in both modes, and is stored with the game', async () => {
      for (const mode of ['classic', 'intermediate'] as GameMode[]) {
        const open = await setupGame({ mode, start: false });
        expect((await storedConfig(open))!.financialPrivacy).toBe('open');
        const hidden = await setupGame({ mode, config: HIDDEN, start: false });
        expect((await storedConfig(hidden))!.financialPrivacy).toBe('hidden');
        // Everyone is told the same thing, from the moment they are in: the host on create, joiners on join, anyone on a read.
        for (const name of NAMES) {
          expect(hidden.joined[name]!.state.config.financialPrivacy).toBe('hidden');
          expect((await hidden.view(name)).state.config.financialPrivacy).toBe('hidden');
          expect((await open.view(name)).state.config.financialPrivacy).toBe('open');
        }
      }
    });

    it('refuses a value it does not know, and creates nothing', async () => {
      const before = (await sql`select count(*)::int as n from public.games`)[0]!.n as number;
      const error = refused(await call({ op: 'create', actionId: randomUUID(), token: token(), name: 'Asha', config: { financialPrivacy: 'secret' } }));
      expect(error.code).toBe('VALIDATION');
      expect((await sql`select count(*)::int as n from public.games`)[0]!.n).toBe(before);
    });

    it('nobody can change it after creation: not a joiner, not the host in the lobby, not anyone once started', async () => {
      const g = await setupGame({ config: HIDDEN, start: false });
      expect(refused(await g.act('Bilal', { type: 'UPDATE_CONFIG', config: { financialPrivacy: 'open' } })).code).toBe('FORBIDDEN');
      const lobby = refused(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { financialPrivacy: 'open' } }));
      expect(lobby.code).toBe('VALIDATION');
      expect(lobby.message).toMatch(/can’t be changed/);
      // The host's other settings still save, and leave it alone.
      ok(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 30000 } }));
      expect(await storedConfig(g)).toMatchObject({ startingCash: 30000, financialPrivacy: 'hidden' });
      ok(await g.act('Asha', { type: 'START_GAME' }));
      expect(refused(await g.act('Asha', { type: 'UPDATE_CONFIG', config: { financialPrivacy: 'open' } })).code).toBe('INVALID_PHASE');
      expect((await storedConfig(g))!.financialPrivacy).toBe('hidden');
      // The database itself refuses a direct write once the game has started.
      await expect(sql`update public.games set config = jsonb_set(config, '{financialPrivacy}', '"open"') where id = ${g.gameId}`).rejects.toThrow(/config is locked/);
      // A reconnect or a restore reads it from the game again.
      expect((await g.view('Chitra')).state.config.financialPrivacy).toBe('hidden');
    });

    it('a game stored before the setting existed is an Open game', async () => {
      const g = await setupGame({ start: false });
      await sql`update public.games set config = config - 'financialPrivacy' where id = ${g.gameId}`;
      expect((await g.view('Bilal')).state.config.financialPrivacy).toBe('open');
      await sql`update public.games set config = null where id = ${g.gameId}`;
      expect((await g.view('Bilal')).state.config.financialPrivacy).toBe('open');
      ok(await g.act('Asha', { type: 'START_GAME' }));
      ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      expect(balanceOf(await g.view('Bilal'), g, 'Asha')).toBe(30000);
      expect((await g.view('Bilal')).state.loans).toHaveLength(1);
    });

    it('the app’s own database roles cannot read a game’s tables at all', async () => {
      for (const table of ['games', 'players', 'loans', 'transactions', 'game_events', 'properties', 'trade_offers', 'auctions']) {
        for (const role of ['anon', 'authenticated']) {
          const [row] = await sql`select has_table_privilege(${role}, ${`public.${table}`}, 'select') as can`;
          expect(row!.can, `${role} on ${table}`).toBe(false);
        }
      }
    });
  });

  describe('open finances: every device is sent everything, as before', () => {
    it('balances, loans, the ledger and the full feed reach everyone', async () => {
      const g = await setupGame();
      ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      ok(await g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1234 }));
      const [asha, bilal, chitra] = await Promise.all(NAMES.map((n) => g.view(n)));
      // The same game, whoever asks (only the time of the answer differs).
      expect(bilal!.state).toEqual(asha!.state);
      expect(chitra!.state).toEqual(asha!.state);
      expect(chitra!.events).toEqual(asha!.events);
      expect(chitra!.transactions).toEqual(asha!.transactions);
      expect(balanceOf(chitra!, g, 'Asha')).toBe(25000 + 5000 + 1234);
      expect(chitra!.state.loans).toHaveLength(1);
      expect(messages(chitra!)).toContain(`Asha borrowed ${formatINR(5000)} from the bank`);
      expect(messages(chitra!)).toContain(`Bilal paid Asha ${formatINR(1234)}`);
      expect(broadcastMessages(g)).toContain(`Asha borrowed ${formatINR(5000)} from the bank`);
    });
  });

  describe('hidden finances, Classic: each device is sent only what its player may see', () => {
    it('cash, loans, ledger and private events of another player never leave the server - on a read, an action, a retry or a broadcast', async () => {
      const g = await setupGame({ config: HIDDEN });
      const loanActionId = randomUUID();
      const borrowed = ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }, { actionId: loanActionId }));
      // The borrower's own answer is complete.
      expect(balanceOf(borrowed.snapshot, g, 'Asha')).toBe(30000);
      expect(borrowed.snapshot.state.loans).toHaveLength(1);
      expect(messages(borrowed.snapshot)).toContain(`Asha borrowed ${formatINR(5000)} from the bank`);
      const loanId = borrowed.snapshot.state.loans[0]!.id;
      // So is a retry of it.
      const retried = ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }, { actionId: loanActionId }));
      expect(retried.duplicate).toBe(true);
      expect(retried.snapshot.state.loans).toHaveLength(1);

      // Another player's own action answers with THEIR view: Asha's money is not in it.
      const paid = ok(await g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 700 }));
      expect(balanceOf(paid.snapshot, g, 'Bilal')).toBe(25000 - 700);
      expect(balanceOf(paid.snapshot, g, 'Asha')).toBe(0);
      expect(paid.snapshot.state.loans).toEqual([]);

      const asha = await g.view('Asha');
      expect(balanceOf(asha, g, 'Asha')).toBe(30000);
      expect(asha.transactions.map((t) => t.type).sort()).toEqual(['LOAN_DISBURSEMENT', 'STARTING_FUNDS']);
      // The payment between the other two: she is told it happened, not how much.
      expect(messages(asha)).toContain('Bilal paid Chitra');
      expect(JSON.stringify(asha)).not.toContain(formatINR(700));

      for (const watcher of ['Bilal', 'Chitra']) {
        const view = await g.view(watcher);
        expect(balanceOf(view, g, watcher)).toBe(watcher === 'Bilal' ? 24300 : 25700);
        expect(balanceOf(view, g, 'Asha')).toBe(0);
        expect(view.state.loans).toEqual([]);
        expect(view.transactions.every((t) => t.fromPlayerId === g.id(watcher) || t.toPlayerId === g.id(watcher))).toBe(true);
        expect(view.events.some((e) => e.type === 'LOAN_TAKEN')).toBe(false);
        expect(messages(view)).toContain(`Bilal paid Chitra ${formatINR(700)}`);
        const wire = JSON.stringify(view);
        expect(wire).not.toContain(loanId);
        expect(wire).not.toContain('borrowed');
        expect(wire).not.toContain('30000');
        // Public things are all there: who is in the game, where they stand, what they own.
        expect(view.state.players.map((p) => p.name)).toEqual(NAMES);
        expect(view.state.players.every((p) => typeof p.position === 'number')).toBe(true);
        expect(Object.keys(view.state.properties).length).toBeGreaterThan(20);
      }

      // The broadcast goes to everyone at once: it carries the public version only.
      const sent = broadcastMessages(g);
      expect(sent.some((m) => /borrowed|loan/i.test(m))).toBe(false);
      expect(sent).toContain('Bilal paid Chitra');
      expect(sent.some((m) => m.includes(formatINR(700)))).toBe(false);
      // The server still holds, and plays on, the real figures.
      const rows = await sql`select name, balance from public.players where game_id = ${g.gameId} order by name`;
      expect(rows.map((r) => [r.name, Number(r.balance)])).toEqual([['Asha', 30000], ['Bilal', 24300], ['Chitra', 25700]]);
      expect((await sql`select ok from public.verify_game_ledger(${g.gameId})`).every((r) => r.ok === true)).toBe(true);
    });

    it('rent and purchases are public, amounts included - to the third player and on the broadcast too', async () => {
      const g = await setupGame({ config: HIDDEN });
      await give(g, 'Bilal', 'RAILWAY');
      ok(await g.act('Asha', { type: 'ROLL_DICE' }, { dice: [1, 2] }));
      const [asha, bilal, chitra] = await Promise.all(NAMES.map((n) => g.view(n)));
      const owed = asha!.state.turn.pending!;
      if (owed.kind !== 'PAYMENT') throw new Error('expected rent to be due');
      expect(owed).toMatchObject({ reason: 'RENT', toPlayerId: g.id('Bilal') });
      expect(bilal!.state.turn.pending).toEqual(owed);
      expect(chitra!.state.turn.pending).toEqual(owed);
      // Movement is public to all three.
      for (const view of [asha!, bilal!, chitra!]) expect(messages(view)).toContain('Asha rolled 3 → Railway');

      ok(await g.act('Asha', { type: 'PAY_RENT' }));
      const told = `Asha paid ${formatINR(owed.amount)} to Bilal (Rent for Railway)`;
      expect(messages(await g.view('Asha'))).toContain(told);
      expect(messages(await g.view('Bilal'))).toContain(told);
      const third = await g.view('Chitra');
      expect(messages(third)).toContain(told);
      expect(broadcastMessages(g)).toContain(told);
      // What it left either of them with is still not hers to see.
      expect(third.transactions.some((t) => t.type === 'RENT_PAYMENT')).toBe(false);
      expect(balanceOf(third, g, 'Asha')).toBe(0);
      expect(balanceOf(third, g, 'Bilal')).toBe(0);
      expect(third.state.properties.RAILWAY).toMatchObject({ ownerId: g.id('Bilal') });

      // A purchase is a public property transaction: price and all.
      ok(await g.act('Asha', { type: 'END_TURN' }));
      ok(await g.act('Bilal', { type: 'ROLL_DICE' }, { dice: [1, 3] }));
      const landed = await g.view('Bilal');
      if (landed.state.turn.pending?.kind !== 'BUY') throw new Error('expected a property to be for sale');
      // The offer is on the table for everyone, price included.
      expect((await g.view('Chitra')).state.turn.pending).toEqual(landed.state.turn.pending);
      ok(await g.act('Bilal', { type: 'BUY_PROPERTY' }));
      const after = await g.view('Chitra');
      expect(after.events.find((e) => e.type === 'PROPERTY_PURCHASED')!.message).toMatch(/^Bilal bought .* for ₹/);
      expect(after.state.properties[landed.state.turn.pending.propertyKey].ownerId).toBe(g.id('Bilal'));
      expect(balanceOf(after, g, 'Bilal')).toBe(0);
    });

    it('auctions and trades run, and are shown, as in any game', async () => {
      const g = await setupGame({ config: HIDDEN });
      ok(await g.act('Asha', { type: 'ROLL_DICE' }, { dice: [1, 2] }));
      const started = ok(await g.act('Asha', { type: 'START_AUCTION' }));
      const auction = started.snapshot.state.auction!;
      ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: auction.minimumOpeningBid }));
      const chitra = await g.view('Chitra');
      expect(chitra.state.auction).toMatchObject({ highBid: auction.minimumOpeningBid, highBidderId: g.id('Bilal') });
      expect(messages(chitra)).toContain(`Bilal bid ${formatINR(auction.minimumOpeningBid)}`);
      ok(await g.act('Asha', { type: 'PASS_AUCTION', auctionId: auction.id }));
      ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId: auction.id }));
      const closed = await g.view('Chitra');
      expect(closed.state.properties.RAILWAY.ownerId).toBe(g.id('Bilal'));
      expect(closed.events.find((e) => e.type === 'AUCTION_WON')!.message).toMatch(/^Bilal won Railway for ₹/);

      ok(await g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 3000 }));
      const offered = await g.view('Asha');
      const trade = offered.state.trades.find((t) => t.status === 'PENDING')!;
      expect(trade).toMatchObject({ fromPlayerId: g.id('Bilal'), toPlayerId: g.id('Chitra'), requestedMoney: 3000 });
      ok(await g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: trade.id }));
      const done = await g.view('Asha');
      expect(done.state.properties.RAILWAY.ownerId).toBe(g.id('Chitra'));
      expect(done.events.some((e) => e.type === 'TRADE_ACCEPTED')).toBe(true);
      // Mortgaging is public too; the cash it raised is not on Asha's phone.
      ok(await g.act('Chitra', { type: 'MORTGAGE_PROPERTY', propertyKey: 'RAILWAY' }));
      const mortgaged = await g.view('Asha');
      expect(mortgaged.state.properties.RAILWAY.mortgaged).toBe(true);
      expect(balanceOf(mortgaged, g, 'Chitra')).toBe(0);
      expect((await sql`select ok from public.verify_game_ledger(${g.gameId})`).every((r) => r.ok === true)).toBe(true);
    });

    it('when the game finishes the standings, and everything behind them, are revealed', async () => {
      const g = await setupGame({ config: HIDDEN });
      ok(await g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }));
      expect(balanceOf(await g.view('Chitra'), g, 'Asha')).toBe(0);
      ok(await endByVote(g.act, Object.keys(g.seats), 'Asha'));
      const final = await g.view('Chitra');
      expect(final.state.status).toBe('FINISHED');
      expect(balanceOf(final, g, 'Asha')).toBe(30000);
      expect(final.state.loans).toHaveLength(1);
      expect(final.events.find((e) => e.type === 'GAME_FINISHED')!.payload.standings).toHaveLength(3);
    });
  });

  describe('hidden finances, Capital', () => {
    it('credit, loan contracts and insurance stay with their owner; the market and ownership are public', async () => {
      const g = await setupGame({ mode: 'intermediate', config: { ...HIDDEN, secretObjectives: false } });
      await give(g, 'Asha', 'MUMBAI');
      const before = await g.view('Asha');
      const eco = before.state.intermediate!;
      const rate = offeredRate('PERSONAL', eco.credit[g.id('Asha')]!).ratePercent;
      const premium = premiumForYear(eco.year);
      ok(await g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 10000, expectedRatePercent: rate }));
      ok(await g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: premium }));

      const asha = await g.view('Asha');
      expect(asha.state.intermediate!.loans).toHaveLength(1);
      expect(asha.state.intermediate!.credit[g.id('Asha')]).toBeTypeOf('number');
      expect(asha.state.intermediate!.insurance!.policies[0]!.premiumPaid).toBe(premium);
      expect(messages(asha)).toContain(`Asha insured Mumbai for ${formatINR(premium)}`);
      const loanId = asha.state.intermediate!.loans[0]!.id;

      for (const watcher of ['Bilal', 'Chitra']) {
        const view = await g.view(watcher);
        const seen = view.state.intermediate!;
        expect(seen.loans).toEqual([]);
        expect(Object.keys(seen.credit)).toEqual([g.id(watcher)]);
        expect(seen.creditEvents.every((e) => e.playerId === g.id(watcher))).toBe(true);
        expect(seen.market).toEqual(asha.state.intermediate!.market);
        expect(seen.year).toBe(asha.state.intermediate!.year);
        // Whether Mumbai is insured is Asha's to know.
        expect(seen.insurance!.policies).toEqual([]);
        expect(view.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
        expect(balanceOf(view, g, 'Asha')).toBe(0);
        expect(JSON.stringify(view)).not.toMatch(/insur(ed|ance on)/i);
        expect(view.events.some((e) => e.type === 'INTERMEDIATE_LOAN_TAKEN' || e.type === 'CREDIT_SCORE_CHANGED')).toBe(false);
        expect(JSON.stringify(view)).not.toContain(loanId);
      }
      const sent = broadcastMessages(g);
      expect(sent.some((m) => /insured|took a|credit score/i.test(m))).toBe(false);
      // The authoritative rows are whole.
      expect((await sql`select premium_paid from public.insurance_policies where game_id = ${g.gameId}`).map((r) => Number(r.premium_paid))).toEqual([premium]);
    });
  });
});
