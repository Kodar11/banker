/// <reference types="node" />
/**
 * Property resale auctions through the game-action handler, against a real Postgres with the
 * production migrations applied: persistence and recovery, the atomic sale, exactly-once closure
 * under races and retries, and the database's own guarantees.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { closeAuctionIfDue, handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import {
  auctionAcceptUntil,
  auctionOpensAt,
  premiumForYear,
  type ApiResponse,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type PropertyKey,
  type StateBroadcast,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const RESERVE = 5000;

type Ok = Extract<ApiResponse, { ok: true }>;

describe.skipIf(!DATABASE_URL)('Property resale auctions through the handler (Postgres)', () => {
  let sql: Sql;
  const broadcasts: { gameId: string; payload: StateBroadcast }[] = [];
  let queuedDice: number[] = [];
  let queuedRandoms: number[] = [];
  let deps: HandlerDeps;
  /** Moves the server's clock forward without waiting. */
  let skewMs = 0;
  let deferred: { delayMs: number; task: () => Promise<void> }[] = [];

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

  beforeEach(() => {
    skewMs = 0;
    deferred = [];
    deps.now = () => new Date(Date.now() + skewMs);
    deps.defer = (delayMs, task) => void deferred.push({ delayMs, task });
  });
  afterEach(() => {
    delete deps.now;
    delete deps.defer;
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
  function refused(res: ApiResponse): { code: string; message: string } {
    if (res.ok) throw new Error('expected the server to refuse');
    return res.error;
  }

  interface Seat {
    playerId: string;
    token: string;
  }

  async function snapshotFor(gameId: string, seat: Seat): Promise<GameSnapshot> {
    return ok(await call({ op: 'state', gameId, playerId: seat.playerId, token: seat.token })).snapshot;
  }

  async function setupGame(mode: GameMode = 'intermediate', names = ['Asha', 'Bilal', 'Chitra']) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    // No secret objectives: these tests read balances.
    const config = mode === 'intermediate' ? { secretObjectives: false } : undefined;
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, mode, ...(config ? { config } : {}) }));
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
      id: (name: string) => seats[name]!.playerId,
      snap: (name = host!) => snapshotFor(gameId, seats[name]!),
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

  /** Test surgery: `name` owns `key` (ownership setup only — no money moves). */
  async function give(g: Game, name: string, key: PropertyKey, patch: { houses?: number; hotel?: boolean; mortgaged?: boolean } = {}) {
    await sql`
      update public.properties
      set owner_player_id = ${g.id(name)}, houses = ${patch.houses ?? 0}, hotel = ${patch.hotel ?? false}, mortgaged = ${patch.mortgaged ?? false}
      where game_id = ${g.gameId} and property_key = ${key}`;
  }

  const balances = (snap: GameSnapshot) => Object.fromEntries(snap.state.players.map((p) => [p.name, p.balance]));
  const payments = (gameId: string) => sql`select * from public.transactions where game_id = ${gameId} and type = 'AUCTION_PAYMENT'`;
  const auctionRow = async (auctionId: string) => (await sql`select * from public.auctions where id = ${auctionId}`)[0]!;
  const propertyRow = async (g: Game, key: PropertyKey) => (await sql`select * from public.properties where game_id = ${g.gameId} and property_key = ${key}`)[0]!;

  async function ledgerOk(gameId: string) {
    const rows = await sql`select * from public.verify_game_ledger(${gameId})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ok).toBe(true);
  }

  /** Moves the server's clock just past the "get ready" of the auction as it stands: bids are accepted from here. */
  async function biddingOpen(g: Game) {
    const auction = (await g.snap()).state.auction!;
    skewMs = Math.max(skewMs, auctionOpensAt(auction) - Date.now() + 100);
  }

  /** Asha owns Mumbai (with `patch`) and lists it; the "get ready" is over unless `wait` is false. */
  async function listed(patch: { houses?: number; hotel?: boolean } = {}, reserve = RESERVE, wait = true) {
    const g = await setupGame();
    await give(g, 'Asha', 'MUMBAI', patch);
    const snap = ok(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: reserve })).snapshot;
    if (wait) await biddingOpen(g);
    return { g, auctionId: snap.state.auction!.id, snap };
  }

  /** Past the countdown and the hidden grace of the auction as it stands now. */
  async function pastDeadline(g: Game) {
    const auction = (await g.snap()).state.auction!;
    skewMs = auctionAcceptUntil(auction) - Date.now() + 500;
  }

  it('listing is stored on the game’s one auction, is seen by every player and survives a reconnect', async () => {
    const { g, auctionId, snap } = await listed({ houses: 2 });
    expect(snap.state.turn.phase).toBe('AUCTION');
    const terms = { sellerId: g.id('Asha'), reservePrice: RESERVE, houses: 2, hotel: false, resumePhase: 'AWAITING_ROLL', outcome: null };
    // Bidding opens at the reserve, after the get-ready, with the full countdown still ahead.
    expect(snap.state.auction).toMatchObject({ minimumOpeningBid: RESERVE });
    expect(Date.parse(snap.state.auction!.endsAt) - auctionOpensAt(snap.state.auction!)).toBe(5000);
    expect(auctionOpensAt(snap.state.auction!) - Date.parse(snap.state.auction!.createdAt)).toBe(3000);
    // A fresh read as each player — what a phone gets when it reconnects — is the same listing.
    for (const name of g.names) {
      const seen = await g.snap(name);
      expect(seen.state.auction).toMatchObject({ id: auctionId, propertyKey: 'MUMBAI', status: 'OPEN', highBid: null, resale: terms });
      expect(seen.state.auction!.participantIds).toEqual([g.id('Bilal'), g.id('Chitra')]);
    }
    expect(await auctionRow(auctionId)).toMatchObject({
      status: 'OPEN',
      seller_player_id: g.id('Asha'),
      reserve_price: 5000,
      minimum_opening_bid: 5000,
      listed_houses: 2,
      listed_hotel: false,
      resume_phase: 'AWAITING_ROLL',
      resale_outcome: null,
    });
    // The server armed its own close for the deadline, and everyone was told.
    expect(deferred).toHaveLength(1);
    expect(broadcasts.at(-1)).toMatchObject({ gameId: g.gameId, payload: { events: [{ type: 'AUCTION_STARTED' }] } });
    expect(await payments(g.gameId)).toHaveLength(0);
  });

  it('a sale is one transaction: payment to the seller, the property with its houses, the seller’s insurance ended', async () => {
    const g = await setupGame();
    await give(g, 'Asha', 'MUMBAI', { houses: 2 });
    ok(await g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: premiumForYear(1) }));
    const auctionId = ok(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).snapshot.state.auction!.id;
    const before = balances(await g.snap());

    await biddingOpen(g);
    ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 6000 }));
    const sold = ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId })).snapshot;

    expect(sold.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Bilal'), highBid: 6000, resale: { outcome: 'SOLD' } });
    expect(sold.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', playerId: g.id('Asha') });
    expect(balances(sold)).toEqual({ Asha: before.Asha! + 6000, Bilal: before.Bilal! - 6000, Chitra: before.Chitra });
    expect(sold.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Bilal'), houses: 2, hotel: false, mortgaged: false });

    // The same facts in the tables the state is rebuilt from.
    expect(await propertyRow(g, 'MUMBAI')).toMatchObject({ owner_player_id: g.id('Bilal'), houses: 2, hotel: false, mortgaged: false });
    const paid = await payments(g.gameId);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ from_player_id: g.id('Bilal'), to_player_id: g.id('Asha'), amount: 6000, property_key: 'MUMBAI' });
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'CLOSED', winner_player_id: g.id('Bilal'), high_bid: 6000, resale_outcome: 'SOLD' });
    const policies = await sql`select * from public.insurance_policies where game_id = ${g.gameId}`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ owner_player_id: g.id('Asha'), status: 'EXPIRED', claimed_crisis_id: null });
    expect(policies[0]!.closed_at).not.toBeNull();
    // No refund: the bid and the original premium are the only money on this property.
    const refunds = await sql`select 1 from public.transactions where game_id = ${g.gameId} and to_player_id = ${g.id('Asha')} and type <> 'AUCTION_PAYMENT' and type <> 'STARTING_FUNDS'`;
    expect(refunds).toHaveLength(0);
    expect(broadcasts.at(-1)!.payload.events.map((e) => e.type)).toEqual(['AUCTION_PASSED', 'INSURANCE_ENDED', 'AUCTION_WON']);
    await ledgerOk(g.gameId);

    // Play simply goes on (the closed auction is saved again with every action, unchanged) …
    queuedDice = [2, 2];
    const rolled = ok(await g.act('Asha', { type: 'ROLL_DICE' })).snapshot;
    expect(rolled.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'SOLD' } });
    // … and the buyer may insure the property themselves, through the ordinary purchase.
    const insured = ok(await g.act('Bilal', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: premiumForYear(1) })).snapshot;
    expect(insured.state.intermediate!.insurance!.policies.map((p) => [p.ownerId, p.status])).toEqual([
      [g.id('Asha'), 'EXPIRED'],
      [g.id('Bilal'), 'ACTIVE'],
    ]);
    await ledgerOk(g.gameId);
  });

  it('a retried request is applied once: one listing, one bid, one sale', async () => {
    const g = await setupGame();
    await give(g, 'Asha', 'MUMBAI');
    const listId = randomUUID();
    const first = ok(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }, { actionId: listId }));
    const again = ok(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }, { actionId: listId }));
    expect(again.duplicate).toBe(true);
    expect(again.snapshot.state.version).toBe(first.snapshot.state.version);
    expect(await sql`select 1 from public.auctions where game_id = ${g.gameId}`).toHaveLength(1);
    const auctionId = first.snapshot.state.auction!.id;

    const bidId = randomUUID();
    await biddingOpen(g);
    ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 6000 }, { actionId: bidId }));
    expect(ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 6000 }, { actionId: bidId })).duplicate).toBe(true);
    expect(await sql`select 1 from public.auction_bids where auction_id = ${auctionId}`).toHaveLength(1);

    const passId = randomUUID();
    const sold = ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId }, { actionId: passId }));
    const replay = ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId }, { actionId: passId }));
    expect(replay.duplicate).toBe(true);
    expect(balances(replay.snapshot)).toEqual(balances(sold.snapshot));
    expect(await payments(g.gameId)).toHaveLength(1);
    await ledgerOk(g.gameId);
  });

  it('phones and the server timer all closing at once: the property is sold exactly once', async () => {
    const { g, auctionId } = await listed({ hotel: true });
    ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 7000 }));
    const before = balances(await g.snap());
    await pastDeadline(g);
    const asked = await Promise.all([
      ...g.names.map((n) => g.act(n, { type: 'CLOSE_AUCTION', auctionId })),
      closeAuctionIfDue(g.gameId, auctionId, deps),
      closeAuctionIfDue(g.gameId, auctionId, deps),
      ...deferred.map((d) => d.task()),
    ]);
    expect(asked.filter((r) => r === true || (typeof r === 'object' && r.ok))).toHaveLength(1);
    for (const r of asked) if (typeof r === 'object' && !r.ok) expect(r.error.code).toBe('AUCTION_CLOSED');
    expect(await payments(g.gameId)).toHaveLength(1);
    const seen = await Promise.all(g.names.map((n) => g.snap(n)));
    for (const snap of seen) {
      expect(snap.state.version).toBe(seen[0]!.state.version);
      expect(snap.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Bilal'), resale: { outcome: 'SOLD' } });
      expect(snap.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Bilal'), hotel: true, houses: 0 });
      expect(balances(snap)).toEqual({ Asha: before.Asha! + 7000, Bilal: before.Bilal! - 7000, Chitra: before.Chitra });
    }
    // Late closes after the fact change nothing either.
    expect(await closeAuctionIfDue(g.gameId, auctionId, deps)).toBe(false);
    expect(refused(await g.act('Asha', { type: 'CLOSE_AUCTION', auctionId })).code).toBe('AUCTION_CLOSED');
    expect(await payments(g.gameId)).toHaveLength(1);
    await ledgerOk(g.gameId);
  });

  it('the close timer is lost (a restart): the next phone to read the game gets the resale settled, exactly once', async () => {
    const { g, auctionId } = await listed({ houses: 2 });
    ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 7000 }));
    const before = balances(await g.snap());
    // The instance that armed the timers is gone, and no phone has the auction screen open.
    deferred = [];
    // While the auction runs, reading the game arms nothing.
    expect((await g.snap('Chitra')).state.auction!.status).toBe('OPEN');
    expect(deferred).toHaveLength(0);
    await pastDeadline(g);
    expect(deferred).toHaveLength(0);

    // A phone comes back after the deadline and reads the state: still a read, and the close is armed again.
    const found = await g.snap('Chitra');
    expect(found.state.auction!.status).toBe('OPEN');
    expect(await payments(g.gameId)).toHaveLength(0);
    expect(deferred.map((d) => d.delayMs)).toEqual([0]);
    // Several phones read before it has run: every one arms it, and together they settle it once.
    await Promise.all(g.names.map((n) => g.snap(n)));
    expect(deferred.length).toBeGreaterThan(1);
    const ran = deferred.splice(0);
    await Promise.all(ran.map((d) => d.task()));

    const snap = await g.snap('Chitra');
    expect(deferred).toHaveLength(0);
    expect(snap.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Bilal'), resale: { outcome: 'SOLD' } });
    expect(snap.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Bilal'), houses: 2, hotel: false });
    expect(balances(snap)).toEqual({ Asha: before.Asha! + 7000, Bilal: before.Bilal! - 7000, Chitra: before.Chitra });
    // The seller's turn is back where it was.
    expect(snap.state.turn).toMatchObject({ playerId: g.id('Asha'), phase: 'AWAITING_ROLL' });
    expect(await payments(g.gameId)).toHaveLength(1);
    expect(await sql`select 1 from public.game_actions where game_id = ${g.gameId} and type = 'CLOSE_AUCTION'`).toHaveLength(1);
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'CLOSED', resale_outcome: 'SOLD' });
    await ledgerOk(g.gameId);
  });

  it('the server timer ends an auction nobody bid in: nothing sold, nothing charged, and it can be listed again', async () => {
    const { g, auctionId } = await listed({ houses: 1 });
    const before = balances(await g.snap());
    expect(deferred).toHaveLength(1);
    await deferred[0]!.task();
    expect((await g.snap()).state.auction!.status).toBe('OPEN'); // not due yet: the timer does nothing early
    await pastDeadline(g);
    await deferred[0]!.task();
    const snap = await g.snap();
    expect(snap.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(snap.state.turn.phase).toBe('AWAITING_ROLL');
    expect(balances(snap)).toEqual(before);
    expect(await payments(g.gameId)).toHaveLength(0);
    expect(await propertyRow(g, 'MUMBAI')).toMatchObject({ owner_player_id: g.id('Asha'), houses: 1 });
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'CLOSED', winner_player_id: null, resale_outcome: 'UNSOLD' });
    expect(broadcasts.at(-1)!.payload.events.map((e) => e.type)).toEqual(['AUCTION_UNSOLD']);

    const relisted = ok(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 3000 })).snapshot;
    expect(relisted.state.auction).toMatchObject({ status: 'OPEN', resale: { reservePrice: 3000, outcome: null } });
    expect(relisted.state.auction!.id).not.toBe(auctionId);
    expect(await sql`select 1 from public.auctions where game_id = ${g.gameId} and status = 'OPEN'`).toHaveLength(1);
  });

  it('no bid before the get-ready is over, none under the reserve, and a winner who can no longer pay buys nothing', async () => {
    const low = await listed({}, RESERVE, false);
    // On the server's clock, bidding has not opened yet — however fast a phone is.
    expect(refused(await low.g.act('Bilal', { type: 'PLACE_BID', auctionId: low.auctionId, amount: RESERVE }))).toEqual({ code: 'INVALID_BID', message: 'Bidding has not started yet.' });
    await biddingOpen(low.g);
    expect(refused(await low.g.act('Bilal', { type: 'PLACE_BID', auctionId: low.auctionId, amount: 1000 }))).toEqual({ code: 'INVALID_BID', message: 'Minimum bid is ₹5,000.' });
    expect(await sql`select 1 from public.auction_bids where auction_id = ${low.auctionId}`).toHaveLength(0);
    const lowBefore = balances(await low.g.snap());
    await pastDeadline(low.g);
    const lowClosed = ok(await low.g.act('Chitra', { type: 'CLOSE_AUCTION', auctionId: low.auctionId })).snapshot;
    expect(lowClosed.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, highBid: null, resale: { outcome: 'UNSOLD' } });
    expect(balances(lowClosed)).toEqual(lowBefore);
    expect(await payments(low.g.gameId)).toHaveLength(0);
    expect(await auctionRow(low.auctionId)).toMatchObject({ resale_outcome: 'UNSOLD', winner_player_id: null, high_bid: null });

    skewMs = 0;
    const broke = await listed();
    ok(await broke.g.act('Bilal', { type: 'PLACE_BID', auctionId: broke.auctionId, amount: 20000 }));
    ok(await broke.g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: broke.g.id('Chitra'), amount: 10000 }));
    const brokeBefore = balances(await broke.g.snap());
    await pastDeadline(broke.g);
    const brokeClosed = ok(await broke.g.act('Asha', { type: 'CLOSE_AUCTION', auctionId: broke.auctionId })).snapshot;
    expect(brokeClosed.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'UNSOLD' } });
    expect(brokeClosed.state.properties.MUMBAI.ownerId).toBe(broke.g.id('Asha'));
    expect(balances(brokeClosed)).toEqual(brokeBefore);
    expect(await payments(broke.g.gameId)).toHaveLength(0);
    await ledgerOk(broke.g.gameId);
  });

  it('the server, not the client, decides who may list, bid and cancel', async () => {
    const { g, auctionId } = await listed();
    // The seller cannot bid; nobody else can cancel; a second listing is refused.
    expect(refused(await g.act('Asha', { type: 'PLACE_BID', auctionId, amount: 6000 }))).toMatchObject({ code: 'FORBIDDEN', message: "You can't bid on your own property." });
    expect(refused(await g.act('Bilal', { type: 'CANCEL_AUCTION', auctionId })).code).toBe('FORBIDDEN');
    expect(refused(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).code).toBe('AUCTION_NOT_ALLOWED');
    // Someone else's seat with my own token is not me.
    const forged = await call({ op: 'action', gameId: g.gameId, playerId: g.id('Asha'), token: g.seats.Bilal!.token, actionId: randomUUID(), expectedVersion: 1, action: { type: 'CANCEL_AUCTION', auctionId } });
    expect(refused(forged).code).toBe('FORBIDDEN');
    // Malformed reserve prices never reach the game.
    const other = await setupGame();
    await give(other, 'Asha', 'MUMBAI');
    for (const reservePrice of [0, -1, 2.5, '5000', null, 20_000_000]) {
      const res = await other.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice } as unknown as GameAction);
      expect(refused(res).code, String(reservePrice)).toBe('VALIDATION');
    }
    expect(refused(await other.act('Bilal', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).code).toBe('NOT_OWNER');
    await give(other, 'Asha', 'MUMBAI', { mortgaged: true });
    expect(refused(await other.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE })).message).toMatch(/^Mortgaged/);
    expect(await sql`select 1 from public.auctions where game_id = ${other.gameId}`).toHaveLength(0);
    expect((await other.snap()).state.turn.phase).toBe('AWAITING_ROLL');
  });

  it('cancelling: the owner, before any bid, as often as the request is repeated', async () => {
    const { g, auctionId } = await listed();
    const before = balances(await g.snap());
    const cancelled = ok(await g.act('Asha', { type: 'CANCEL_AUCTION', auctionId })).snapshot;
    expect(cancelled.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null, resale: { outcome: 'CANCELLED' } });
    expect(cancelled.state.turn.phase).toBe('AWAITING_ROLL');
    // A second, separate cancel request (a second tap that got through) changes nothing.
    const again = ok(await g.act('Asha', { type: 'CANCEL_AUCTION', auctionId })).snapshot;
    expect(again.state.auction).toMatchObject({ status: 'CLOSED', resale: { outcome: 'CANCELLED' } });
    expect(balances(again)).toEqual(before);
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'CLOSED', resale_outcome: 'CANCELLED', high_bid: null });
    expect(await closeAuctionIfDue(g.gameId, auctionId, deps)).toBe(false);
    expect(await payments(g.gameId)).toHaveLength(0);

    const bidOn = await listed();
    ok(await bidOn.g.act('Bilal', { type: 'PLACE_BID', auctionId: bidOn.auctionId, amount: RESERVE }));
    expect(refused(await bidOn.g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: bidOn.auctionId }))).toMatchObject({ code: 'AUCTION_NOT_ALLOWED' });
    expect((await bidOn.g.snap()).state.auction!.status).toBe('OPEN');
  });

  it('a Classic game refuses a resale and its own auctions are stored as before', async () => {
    const g = await setupGame('classic');
    await give(g, 'Asha', 'MUMBAI');
    expect(refused(await g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE }))).toEqual({
      code: 'AUCTION_NOT_ALLOWED',
      message: 'Property auctions are only available in Capital Mode.',
    });
    expect(await sql`select 1 from public.auctions where game_id = ${g.gameId}`).toHaveLength(0);

    queuedDice = [1, 2]; // Railway
    ok(await g.act('Asha', { type: 'ROLL_DICE' }));
    const auction = ok(await g.act('Asha', { type: 'DECLINE_PROPERTY' })).snapshot.state.auction!;
    expect(auction.resale).toBeNull();
    expect(auction.participantIds).toHaveLength(3);
    expect(refused(await g.act('Asha', { type: 'CANCEL_AUCTION', auctionId: auction.id })).code).toBe('FORBIDDEN');
    ok(await g.act('Asha', { type: 'PLACE_BID', auctionId: auction.id, amount: 500 }));
    ok(await g.act('Bilal', { type: 'PASS_AUCTION', auctionId: auction.id }));
    const closed = ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId: auction.id })).snapshot;
    expect(closed.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Asha'), resale: null });
    expect(closed.state.turn.phase).toBe('TURN_COMPLETE');
    expect(await auctionRow(auction.id)).toMatchObject({ seller_player_id: null, reserve_price: null, resale_outcome: null, winner_player_id: g.id('Asha') });
    const paid = await payments(g.gameId);
    expect(paid).toMatchObject([{ from_player_id: g.id('Asha'), to_player_id: null, amount: 500 }]);
    await ledgerOk(g.gameId);
  });

  describe('the database’s own guarantees', () => {
    it('a resale row cannot exist in a Classic game, and the seller can never be a bidder', async () => {
      const classic = await setupGame('classic');
      const row = (gameId: string, sellerId: string, participants: string[]) => sql`
        insert into public.auctions (id, game_id, property_key, status, minimum_opening_bid, minimum_increment, ends_at, participant_ids,
          seller_player_id, reserve_price, listed_houses, listed_hotel, resume_phase)
        values (${randomUUID()}, ${gameId}, 'MUMBAI', 'OPEN', 100, 100, now(), ${participants}::uuid[],
          ${sellerId}, 5000, 0, false, 'AWAITING_ROLL')`;
      await expect(row(classic.gameId, classic.id('Asha'), [classic.id('Bilal')])).rejects.toThrow(/only in Intermediate Mode/);
      const g = await setupGame();
      await expect(row(g.gameId, g.id('Asha'), [g.id('Asha'), g.id('Bilal')])).rejects.toThrow(/auctions_seller_never_bids/);
      await expect(row(g.gameId, classic.id('Asha'), [g.id('Bilal')])).rejects.toThrow(/is not in game/);
      // Half a listing is not a listing.
      await expect(
        sql`insert into public.auctions (id, game_id, property_key, status, minimum_opening_bid, minimum_increment, ends_at, participant_ids, seller_player_id)
            values (${randomUUID()}, ${g.gameId}, 'MUMBAI', 'OPEN', 100, 100, now(), ${[g.id('Bilal')]}::uuid[], ${g.id('Asha')})`,
      ).rejects.toThrow(/auctions_resale_terms_complete/);
    });

    it('the terms of a listing cannot be rewritten and a closed resale is final', async () => {
      const { g, auctionId } = await listed();
      await expect(sql`update public.auctions set reserve_price = 1 where id = ${auctionId}`).rejects.toThrow(/terms of a resale auction cannot be changed/);
      await expect(sql`update public.auctions set seller_player_id = ${g.id('Chitra')} where id = ${auctionId}`).rejects.toThrow(/cannot be changed/);
      // "Sold" without a bid that reached the reserve is not a sale the database will record.
      await expect(
        sql`update public.auctions set status = 'CLOSED', closed_at = now(), resale_outcome = 'SOLD', high_bid = 100, high_bidder_id = ${g.id('Bilal')}, winner_player_id = ${g.id('Bilal')} where id = ${auctionId}`,
      ).rejects.toThrow(/auctions_resale_sold_at_reserve/);
      await expect(sql`update public.auctions set high_bid = 9000, high_bidder_id = ${g.id('Asha')} where id = ${auctionId}`).rejects.toThrow(/auctions_seller_never_bids/);

      ok(await g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 6000 }));
      ok(await g.act('Chitra', { type: 'PASS_AUCTION', auctionId }));
      await expect(sql`update public.auctions set winner_player_id = ${g.id('Chitra')}, high_bidder_id = ${g.id('Chitra')} where id = ${auctionId}`).rejects.toThrow(/already sold/);
      await expect(sql`update public.auctions set status = 'OPEN', closed_at = null, resale_outcome = null, winner_player_id = null where id = ${auctionId}`).rejects.toThrow(/already sold/);
      expect(await auctionRow(auctionId)).toMatchObject({ status: 'CLOSED', winner_player_id: g.id('Bilal'), resale_outcome: 'SOLD', reserve_price: 5000 });
    });

    it('the app’s own database roles still cannot read or write auctions', async () => {
      for (const role of ['anon', 'authenticated']) {
        const [priv] = await sql`
          select has_table_privilege(${role}, 'public.auctions', 'select') as can_select,
                 has_table_privilege(${role}, 'public.auctions', 'insert') as can_insert,
                 has_table_privilege(${role}, 'public.auctions', 'update') as can_update,
                 has_function_privilege(${role}, 'public.guard_resale_auction()', 'execute') as can_execute`;
        expect(priv).toEqual({ can_select: false, can_insert: false, can_update: false, can_execute: false });
      }
    });
  });
});
