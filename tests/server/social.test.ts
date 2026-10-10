/// <reference types="node" />
/**
 * Friends, invitations and notifications against a real Postgres with the production migrations
 * applied (plus scripts/local-auth-stub.sql standing in for Supabase's auth schema), and the real
 * game-action handler for everything that happens in a lobby.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Every statement a player could send runs as the `authenticated` role with that player's JWT
 * claims, exactly as PostgREST runs it. Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql, type Tx } from '../../supabase/functions/game-action/db.ts';
import { handleRequest, type HandlerDeps } from '../../supabase/functions/game-action/handler.ts';
import { BUSINESS_MVP_RULES, type ApiResponse, type GameAction } from '../../supabase/functions/_shared/engine/index.ts';

const DATABASE_URL = process.env.DATABASE_URL;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ok = Extract<ApiResponse, { ok: true }>;

interface Player {
  userId: string;
  playerId: string;
  nickname: string;
}

describe.skipIf(!DATABASE_URL)('friends, invitations and notifications (Postgres)', () => {
  let sql: Sql;
  let deps: HandlerDeps;

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 12);
    deps = { sql };
  });

  afterAll(async () => {
    await sql?.end();
  });

  /** Runs `fn` the way PostgREST runs a signed-in player's request. */
  function as<T>(userId: string | null, fn: (tx: Tx) => Promise<T>, role: 'authenticated' | 'anon' = 'authenticated'): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${userId ? JSON.stringify({ sub: userId, role }) : ''}, true)`;
      await tx.unsafe(`set local role ${role}`);
      return fn(tx);
    }) as Promise<T>;
  }

  async function newPlayer(): Promise<Player> {
    const [row] = await sql`insert into auth.users (is_anonymous) values (true) returning id`;
    const userId = row!.id as string;
    const profile = await as(userId, async (tx) => (await tx`select public.init_profile() as r`)[0]!.r as Json);
    return { userId, playerId: profile.profile.player_id, nickname: profile.profile.nickname };
  }

  const players = (n: number) => Promise.all(Array.from({ length: n }, newPlayer));

  /** One RPC as `who`. Arguments are positional, as declared. */
  function rpc(who: Player | null, name: string, ...args: unknown[]): Promise<Json> {
    return as(who?.userId ?? null, async (tx) => {
      const list = args.map((_, i) => `$${i + 1}`).join(', ');
      const [row] = await tx.unsafe(`select public.${name}(${list}) as r`, args as never[]);
      return row!.r as Json;
    });
  }

  const socialState = (who: Player) => rpc(who, 'social_state');
  const send = (from: Player, to: Player) => rpc(from, 'send_friend_request', to.playerId);
  const versionOf = async (who: Player) => Number((await socialState(who)).version);

  async function befriend(a: Player, b: Player): Promise<void> {
    expect(await send(a, b)).toMatchObject({ ok: true, relationship: 'outgoing' });
    const incoming = (await socialState(b)).incoming as Json[];
    const request = incoming.find((r) => r.player_id === a.playerId)!;
    expect(await rpc(b, 'respond_friend_request', request.id, true)).toMatchObject({ ok: true, relationship: 'friends' });
  }

  const friendshipsOf = async (a: Player, b: Player) =>
    (await sql`select * from public.friendships where (user_low = ${a.userId} and user_high = ${b.userId}) or (user_low = ${b.userId} and user_high = ${a.userId})`).length;

  // ---- games (the real referee) ------------------------------------------------------------
  const token = () => randomBytes(32).toString('hex');

  async function call(body: unknown): Promise<ApiResponse> {
    return (await handleRequest(body, deps)).body;
  }
  function ok(res: ApiResponse): Ok {
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  interface Seat {
    seatId: string;
    token: string;
  }

  interface Table {
    gameId: string;
    code: string;
    seats: Map<string, Seat>;
  }

  /** `host` creates a game and claims the seat for their account. */
  async function hostGame(host: Player, mode?: 'intermediate'): Promise<Table> {
    const t = token();
    const created = ok(await call({ op: 'create', actionId: randomUUID(), token: t, name: host.nickname, ...(mode ? { mode } : {}) }));
    const table: Table = { gameId: created.gameId, code: created.snapshot.state.code, seats: new Map([[host.userId, { seatId: created.playerId, token: t }]]) };
    expect(await rpc(host, 'claim_seat', table.gameId, created.playerId, t)).toEqual({ ok: true });
    return table;
  }

  /** Joins by code (the normal Join Game flow) and, unless told otherwise, claims the seat. */
  async function joinTable(table: Table, who: Player, { claim = true, name = who.nickname }: { claim?: boolean; name?: string } = {}): Promise<ApiResponse> {
    const t = token();
    const res = await call({ op: 'join', actionId: randomUUID(), token: t, code: table.code, name });
    if (res.ok) {
      table.seats.set(who.userId, { seatId: res.playerId, token: t });
      if (claim) expect(await rpc(who, 'claim_seat', table.gameId, res.playerId, t)).toEqual({ ok: true });
    }
    return res;
  }

  async function act(table: Table, who: Player, action: GameAction): Promise<ApiResponse> {
    const seat = table.seats.get(who.userId)!;
    const [game] = await sql`select state_version from public.games where id = ${table.gameId}`;
    return call({ op: 'action', gameId: table.gameId, playerId: seat.seatId, token: seat.token, actionId: randomUUID(), expectedVersion: game!.state_version, action });
  }

  // =========================================================================================
  describe('identity and direct access', () => {
    it('every function needs a signed-in player, and the anon role cannot even call them', async () => {
      const [a] = await players(1);
      for (const [name, args] of [
        ['social_state', []],
        ['lookup_player', [a!.playerId]],
        ['send_friend_request', [a!.playerId]],
        ['respond_friend_request', [randomUUID(), true]],
        ['cancel_friend_request', [randomUUID()]],
        ['remove_friend', [a!.playerId]],
        ['block_player', [a!.playerId]],
        ['unblock_player', [a!.playerId]],
        ['claim_seat', [randomUUID(), randomUUID(), 'a'.repeat(64)]],
        ['game_player_profiles', [randomUUID()]],
        ['send_game_invite', [randomUUID(), a!.playerId]],
        ['open_game_invite', [randomUUID()]],
        ['decline_game_invite', [randomUUID()]],
        ['revoke_game_invite', [randomUUID()]],
        ['mark_notifications_read', [null]],
      ] as [string, unknown[]][]) {
        // A request with the authenticated role but no user in its token.
        expect(await rpc(null, name, ...args), name).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
        const list = args.map((_, i) => `$${i + 1}`).join(', ');
        await expect(as(null, (tx) => tx.unsafe(`select public.${name}(${list})`, args as never[]), 'anon'), name).rejects.toThrow(/permission denied/);
      }
    });

    it('the app cannot read or write the tables, or call the internal functions', async () => {
      const [a, b] = await players(2);
      await befriend(a!, b!);
      for (const table of ['friend_requests', 'friendships', 'player_blocks', 'game_invitations', 'notifications', 'social_limits', 'social_rate_events']) {
        await expect(as(a!.userId, (tx) => tx.unsafe(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
      }
      const low = a!.userId < b!.userId ? a! : b!;
      const high = low === a ? b! : a!;
      await expect(as(a!.userId, (tx) => tx`insert into public.friendships (user_low, user_high) values (${low.userId}, ${high.userId})`)).rejects.toThrow(/permission denied/);
      await expect(
        as(a!.userId, (tx) => tx`insert into public.notifications (recipient_user_id, event_type, deduplication_key) values (${b!.userId}, 'friend_request', 'x')`),
      ).rejects.toThrow(/permission denied/);
      await expect(as(a!.userId, (tx) => tx`update public.social_sync set version = 99`)).rejects.toThrow(/permission denied/);
      for (const fn of [
        `social_notify('${b!.userId}', 'friend_request', '${a!.userId}', null, 'k')`,
        `social_touch('${b!.userId}')`,
        `social_rotate_presence('${b!.userId}')`,
        `social_unfriend('${a!.userId}', '${b!.userId}')`,
        `social_public_profile('${b!.userId}')`,
        'social_cleanup()',
      ]) {
        await expect(as(a!.userId, (tx) => tx.unsafe(`select public.${fn}`)), fn).rejects.toThrow(/permission denied/);
      }
      // The presence key is not a column the app can select from profiles.
      await expect(as(a!.userId, (tx) => tx`select presence_key from public.profiles`)).rejects.toThrow(/permission denied/);
    });

    it('a player reads only their own change counter', async () => {
      const [a, b] = await players(2);
      await socialState(a!);
      await socialState(b!);
      const rows = await as(a!.userId, (tx) => tx`select user_id from public.social_sync`);
      expect(rows.map((r) => r.user_id)).toEqual([a!.userId]);
    });
  });

  // =========================================================================================
  describe('Player ID lookup', () => {
    it('normalises the ID and returns only the public profile', async () => {
      const [a, b] = await players(2);
      const messy = `  ${b!.playerId.toLowerCase().replace('-', '')} `;
      const found = await rpc(a!, 'lookup_player', messy);
      expect(found).toEqual({ ok: true, player: { player_id: b!.playerId, nickname: b!.nickname }, relationship: 'none' });
      expect(JSON.stringify(found)).not.toContain(b!.userId);
    });

    it('rejects malformed IDs, unknown IDs and reports the caller as self', async () => {
      const [a] = await players(1);
      for (const bad of ['', '   ', 'RR-', 'RR-00000O', 'RR-7K4P9XX', 'XX-7K4P9X', "RR-7K4P9X'; drop table profiles; --", null]) {
        expect(await rpc(a!, 'lookup_player', bad), String(bad)).toEqual({ ok: false, code: 'INVALID_PLAYER_ID' });
      }
      // Well formed, but (unless a test run happened to draw it) nobody has it.
      const [taken] = await sql`select 1 from public.profiles where player_id = 'RR-ZZZZZ9'`;
      if (!taken) expect(await rpc(a!, 'lookup_player', 'RR-ZZZZZ9')).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(a!, 'lookup_player', a!.playerId)).toMatchObject({ ok: true, relationship: 'self' });
      expect(await send(a!, a!)).toEqual({ ok: false, code: 'SELF' });
    });

    it('is rate limited per player, with a wait time and no internals', async () => {
      const [a, b, c] = await players(3);
      const [limit] = await sql`select max_count from public.social_limits where key = 'lookup'`;
      const max = Number(limit!.max_count);
      for (let i = 0; i < max; i += 1) expect((await rpc(a!, 'lookup_player', b!.playerId)).ok).toBe(true);
      const refused = await rpc(a!, 'lookup_player', b!.playerId);
      expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      expect(refused.retry_after_seconds).toBeGreaterThan(0);
      expect(refused.retry_after_seconds).toBeLessThanOrEqual(60);
      expect(Object.keys(refused).sort()).toEqual(['code', 'ok', 'retry_after_seconds']);
      // Sending a request resolves an ID too: it cannot be used to get around the limit.
      expect(await send(a!, c!)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      // Someone else is not affected.
      expect((await rpc(b!, 'lookup_player', a!.playerId)).ok).toBe(true);
    });
  });

  // =========================================================================================
  describe('friend requests', () => {
    it('send: outgoing for the sender, incoming for the recipient, one notification', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      expect(sent).toMatchObject({ ok: true, relationship: 'outgoing', created: true, matched: false, player: { player_id: b!.playerId } });

      const mine = await socialState(a!);
      expect(mine.outgoing).toHaveLength(1);
      expect(mine.outgoing[0]).toMatchObject({ id: sent.request_id, player_id: b!.playerId, nickname: b!.nickname });
      expect(mine.incoming).toEqual([]);
      expect(mine.friends).toEqual([]);

      const theirs = await socialState(b!);
      expect(theirs.incoming).toHaveLength(1);
      expect(theirs.incoming[0]).toMatchObject({ id: sent.request_id, player_id: a!.playerId, nickname: a!.nickname });
      expect(theirs.unread).toBe(1);
      expect(theirs.notifications[0]).toMatchObject({ type: 'friend_request', read: false, actor: { player_id: a!.playerId, nickname: a!.nickname } });
      // 30 days, by the server's clock.
      const days = (Date.parse(theirs.incoming[0].expires_at) - Date.parse(theirs.incoming[0].created_at)) / 86_400_000;
      expect(days).toBeCloseTo(30, 3);
      expect(await rpc(a!, 'lookup_player', b!.playerId)).toMatchObject({ relationship: 'outgoing' });
      expect(await rpc(b!, 'lookup_player', a!.playerId)).toMatchObject({ relationship: 'incoming' });
    });

    it('sending again (a retry, a double tap, five at once) creates nothing new', async () => {
      const [a, b] = await players(2);
      const first = await send(a!, b!);
      const again = await Promise.all(Array.from({ length: 5 }, () => send(a!, b!)));
      for (const r of again) expect(r).toMatchObject({ ok: true, relationship: 'outgoing', created: false, request_id: first.request_id });
      const [rows] = await sql`select count(*)::int as n from public.friend_requests where sender_user_id = ${a!.userId}`;
      expect(rows!.n).toBe(1);
      const [notes] = await sql`select count(*)::int as n from public.notifications where recipient_user_id = ${b!.userId}`;
      expect(notes!.n).toBe(1);
    });

    it('five simultaneous first requests still create exactly one', async () => {
      const [a, b] = await players(2);
      const results = await Promise.all(Array.from({ length: 5 }, () => send(a!, b!)));
      expect(results.every((r) => r.ok && r.relationship === 'outgoing')).toBe(true);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.request_id)).size).toBe(1);
    });

    it('the sender is always the caller: the nickname changes nothing, and nobody can send as someone else', async () => {
      const [a, b] = await players(2);
      await as(a!.userId, (tx) => tx`select public.update_nickname('Renamed One')`);
      const sent = await send(a!, b!);
      const [row] = await sql`select sender_user_id, recipient_user_id from public.friend_requests where id = ${sent.request_id}`;
      expect(row).toMatchObject({ sender_user_id: a!.userId, recipient_user_id: b!.userId });
      // The function has no parameter that could carry a sender.
      const [sig] = await sql`select pg_get_function_identity_arguments('public.send_friend_request(text)'::regprocedure) as args`;
      expect(sig!.args).toBe('p_player_id text');
      expect((await socialState(b!)).incoming[0]).toMatchObject({ nickname: 'Renamed One', player_id: a!.playerId });
    });

    it('accept: only the recipient; both become friends; the sender is told once', async () => {
      const [a, b, c] = await players(3);
      const sent = await send(a!, b!);
      // The sender and a stranger cannot answer it — for them it does not exist.
      expect(await rpc(a!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(c!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await friendshipsOf(a!, b!)).toBe(0);

      expect(await rpc(b!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: true, relationship: 'friends' });
      // Accepting again (retry) changes nothing.
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: true, relationship: 'friends' });
      expect(await friendshipsOf(a!, b!)).toBe(1);

      const mine = await socialState(a!);
      expect(mine.friends.map((f: Json) => f.player_id)).toEqual([b!.playerId]);
      expect(mine.outgoing).toEqual([]);
      expect(mine.notifications.filter((n: Json) => n.type === 'friend_accepted')).toHaveLength(1);
      const theirs = await socialState(b!);
      expect(theirs.friends.map((f: Json) => f.player_id)).toEqual([a!.playerId]);
      expect(theirs.incoming).toEqual([]);
      // The request b was told about is answered: nothing unread is left for it.
      expect(theirs.unread).toBe(0);
      expect(await send(a!, b!)).toMatchObject({ ok: true, relationship: 'friends', created: false });
    });

    it('decline: only the recipient; no friendship; the sender still sees it pending', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      expect(await rpc(a!, 'respond_friend_request', sent.request_id, false)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, false)).toEqual({ ok: true, relationship: 'none' });
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, false)).toEqual({ ok: true, relationship: 'none' });
      expect(await friendshipsOf(a!, b!)).toBe(0);
      expect((await socialState(b!)).incoming).toEqual([]);
      // Nothing tells the sender it was declined.
      const mine = await socialState(a!);
      expect(mine.outgoing.map((r: Json) => r.id)).toEqual([sent.request_id]);
      expect(mine.notifications).toEqual([]);
      expect(await send(a!, b!)).toMatchObject({ ok: true, relationship: 'outgoing', created: false });
      // A declined request cannot be accepted afterwards.
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'REQUEST_GONE' });
    });

    it('cancel: only the sender, idempotent, removes the pending notification, never a friendship', async () => {
      const [a, b, c] = await players(3);
      const sent = await send(a!, b!);
      expect(await rpc(b!, 'cancel_friend_request', sent.request_id)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(c!, 'cancel_friend_request', sent.request_id)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(a!, 'cancel_friend_request', sent.request_id)).toEqual({ ok: true, relationship: 'none' });
      expect(await rpc(a!, 'cancel_friend_request', sent.request_id)).toEqual({ ok: true, relationship: 'none' });
      const theirs = await socialState(b!);
      expect(theirs.incoming).toEqual([]);
      expect(theirs.notifications).toEqual([]);
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'REQUEST_GONE' });

      // Cancelling an accepted request does not end the friendship.
      const second = await send(a!, c!);
      await rpc(c!, 'respond_friend_request', second.request_id, true);
      expect(await rpc(a!, 'cancel_friend_request', second.request_id)).toEqual({ ok: false, code: 'ALREADY_FRIENDS' });
      expect(await friendshipsOf(a!, c!)).toBe(1);
    });

    it('expires after 30 days by the server clock, and a fresh one can then be sent', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      await sql`update public.friend_requests set expires_at = now() - interval '1 second' where id = ${sent.request_id}`;
      expect((await socialState(a!)).outgoing).toEqual([]);
      expect((await socialState(b!)).incoming).toEqual([]);
      expect(await rpc(a!, 'lookup_player', b!.playerId)).toMatchObject({ relationship: 'none' });
      expect(await rpc(b!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'REQUEST_EXPIRED' });
      expect(await friendshipsOf(a!, b!)).toBe(0);

      const fresh = await send(a!, b!);
      expect(fresh).toMatchObject({ ok: true, relationship: 'outgoing', created: true });
      expect(fresh.request_id).not.toBe(sent.request_id);
      expect((await socialState(b!)).incoming.map((r: Json) => r.id)).toEqual([fresh.request_id]);
    });

    it('an expired request from the other side is not a reciprocal match', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      await sql`update public.friend_requests set expires_at = now() - interval '1 second' where id = ${sent.request_id}`;
      expect(await send(b!, a!)).toMatchObject({ ok: true, relationship: 'outgoing', created: true, matched: false });
      expect(await friendshipsOf(a!, b!)).toBe(0);
    });

    it('repeated requests to the same player are limited', async () => {
      const [a, b] = await players(2);
      const [limit] = await sql`select max_count from public.social_limits where key = 'friend_request_pair'`;
      for (let i = 0; i < Number(limit!.max_count); i += 1) {
        const sent = await send(a!, b!);
        expect(sent).toMatchObject({ ok: true, created: true });
        await rpc(a!, 'cancel_friend_request', sent.request_id);
      }
      const refused = await send(a!, b!);
      expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      expect(refused.retry_after_seconds).toBeGreaterThan(0);
      expect((await socialState(b!)).incoming).toEqual([]);
      // The other direction is its own counter — and a reciprocal request never counts at all.
      expect(await send(b!, a!)).toMatchObject({ ok: true, created: true });
    });

    it('new requests to anyone are limited per hour', async () => {
      const [a] = await players(1);
      await sql`update public.social_limits set max_count = 3 where key = 'friend_request'`;
      try {
        const others = await players(4);
        for (const o of others.slice(0, 3)) expect(await send(a!, o)).toMatchObject({ ok: true, created: true });
        expect(await send(a!, others[3]!)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      } finally {
        await sql`update public.social_limits set max_count = 20 where key = 'friend_request'`;
      }
    });
  });

  // =========================================================================================
  describe('reciprocal requests', () => {
    it('B asks while A’s request is pending: one friendship, no acceptance, both are told', async () => {
      const [a, b] = await players(2);
      const first = await send(a!, b!);
      const second = await send(b!, a!);
      expect(second).toMatchObject({ ok: true, relationship: 'friends', matched: true, created: false });
      expect(await friendshipsOf(a!, b!)).toBe(1);

      const [request] = await sql`select status from public.friend_requests where id = ${first.request_id}`;
      expect(request!.status).toBe('accepted');
      const [open] = await sql`select count(*)::int as n from public.friend_requests
        where status in ('pending', 'declined') and sender_user_id in (${a!.userId}, ${b!.userId}) and recipient_user_id in (${a!.userId}, ${b!.userId})`;
      expect(open!.n).toBe(0);

      for (const [me, other] of [[a!, b!], [b!, a!]] as const) {
        const state = await socialState(me);
        expect(state.friends.map((f: Json) => f.player_id)).toEqual([other.playerId]);
        expect(state.incoming).toEqual([]);
        expect(state.outgoing).toEqual([]);
        const matched = state.notifications.filter((n: Json) => n.type === 'friends_matched');
        expect(matched).toHaveLength(1);
        expect(matched[0].actor).toEqual({ player_id: other.playerId, nickname: other.nickname });
        // The answered request leaves no "you have a request" behind.
        expect(state.notifications.filter((n: Json) => n.type === 'friend_request')).toEqual([]);
      }
    });

    it('both ask at the same moment, many times over: always exactly one friendship', async () => {
      for (let round = 0; round < 12; round += 1) {
        const [a, b] = await players(2);
        const results = await Promise.all([send(a!, b!), send(b!, a!), send(a!, b!), send(b!, a!), send(a!, b!), send(b!, a!)]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(await friendshipsOf(a!, b!)).toBe(1);
        // Whatever each call saw on the way, the final state is the same for both.
        expect(await send(a!, b!)).toMatchObject({ relationship: 'friends' });
        expect(await send(b!, a!)).toMatchObject({ relationship: 'friends' });
        const [open] = await sql`select count(*)::int as n from public.friend_requests
          where status in ('pending', 'declined') and sender_user_id in (${a!.userId}, ${b!.userId}) and recipient_user_id in (${a!.userId}, ${b!.userId})`;
        expect(open!.n).toBe(0);
        for (const me of [a!, b!]) {
          const [n] = await sql`select count(*)::int as n from public.notifications where recipient_user_id = ${me.userId} and event_type = 'friends_matched'`;
          expect(n!.n).toBe(1);
        }
      }
    });

    it('an accept racing a reciprocal request ends in one friendship', async () => {
      for (let round = 0; round < 8; round += 1) {
        const [a, b] = await players(2);
        const sent = await send(a!, b!);
        const [accepted, reciprocal] = await Promise.all([rpc(b!, 'respond_friend_request', sent.request_id, true), send(b!, a!)]);
        expect(accepted).toMatchObject({ ok: true, relationship: 'friends' });
        expect(reciprocal).toMatchObject({ ok: true, relationship: 'friends' });
        expect(await friendshipsOf(a!, b!)).toBe(1);
        const [open] = await sql`select count(*)::int as n from public.friend_requests where status in ('pending', 'declined') and sender_user_id in (${a!.userId}, ${b!.userId})`;
        expect(open!.n).toBe(0);
      }
    });

    it('a request the other player declined still matches when they ask later', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      await rpc(b!, 'respond_friend_request', sent.request_id, false);
      expect(await send(b!, a!)).toMatchObject({ ok: true, relationship: 'friends', matched: true });
      expect(await friendshipsOf(a!, b!)).toBe(1);
    });
  });

  // =========================================================================================
  describe('friendships', () => {
    it('are stored once, low id first; the database refuses anything else', async () => {
      const [a, b] = await players(2);
      await befriend(a!, b!);
      const [row] = await sql`select user_low, user_high from public.friendships where user_low in (${a!.userId}, ${b!.userId})`;
      expect(row!.user_low < row!.user_high).toBe(true);
      // As the database owner — the last line of defence, below every function.
      await expect(sql`insert into public.friendships (user_low, user_high) values (${row!.user_low}, ${row!.user_high})`).rejects.toThrow(/duplicate key/);
      await expect(sql`insert into public.friendships (user_low, user_high) values (${row!.user_high}, ${row!.user_low})`).rejects.toThrow(/friendships_ordered/);
      await expect(sql`insert into public.friendships (user_low, user_high) values (${a!.userId}, ${a!.userId})`).rejects.toThrow(/friendships_ordered/);
      await expect(
        sql`insert into public.friend_requests (sender_user_id, recipient_user_id, expires_at) values (${a!.userId}, ${a!.userId}, now())`,
      ).rejects.toThrow(/friend_requests_not_self/);
    });

    it('either friend can remove; repeating it is safe; nothing else is touched', async () => {
      const [a, b, c] = await players(3);
      await befriend(a!, b!);
      await befriend(a!, c!);
      const keysBefore = await socialState(a!);
      expect(await rpc(b!, 'remove_friend', a!.playerId)).toEqual({ ok: true, removed: true });
      expect(await rpc(b!, 'remove_friend', a!.playerId)).toEqual({ ok: true, removed: false });
      expect(await rpc(a!, 'remove_friend', b!.playerId)).toEqual({ ok: true, removed: false });
      expect(await friendshipsOf(a!, b!)).toBe(0);
      expect(await friendshipsOf(a!, c!)).toBe(1);
      const after = await socialState(a!);
      expect(after.friends.map((f: Json) => f.player_id)).toEqual([c!.playerId]);
      expect((await socialState(b!)).friends).toEqual([]);
      // Both presence topics were replaced: the former friend can no longer watch either.
      expect(after.me.presence_key).not.toBe(keysBefore.me.presence_key);
      // …and the friend who stayed is told (their counter moved) and gets the new key.
      expect((await socialState(c!)).friends[0].presence_key).toBe(after.me.presence_key);
      // They can become friends again.
      await befriend(b!, a!);
      expect(await friendshipsOf(a!, b!)).toBe(1);
    });

    it('every change moves the change counter of exactly the players it concerns', async () => {
      const [a, b, c] = await players(3);
      const before = { a: await versionOf(a!), b: await versionOf(b!), c: await versionOf(c!) };
      const sent = await send(a!, b!);
      const afterSend = { a: await versionOf(a!), b: await versionOf(b!), c: await versionOf(c!) };
      expect(afterSend.a).toBeGreaterThan(before.a);
      expect(afterSend.b).toBeGreaterThan(before.b);
      expect(afterSend.c).toBe(before.c);
      await rpc(b!, 'respond_friend_request', sent.request_id, true);
      expect(await versionOf(a!)).toBeGreaterThan(afterSend.a);
      await rpc(a!, 'remove_friend', b!.playerId);
      expect(await versionOf(b!)).toBeGreaterThan(afterSend.b);
      expect(await versionOf(c!)).toBe(before.c);
    });

    it('a friend is described by Player ID, nickname and presence key — never an account id', async () => {
      const [a, b] = await players(2);
      await befriend(a!, b!);
      const state = await socialState(a!);
      expect(Object.keys(state.friends[0]).sort()).toEqual(['nickname', 'player_id', 'presence_key', 'since']);
      const text = JSON.stringify(state);
      expect(text).not.toContain(b!.userId);
      expect(text).not.toContain(a!.userId);
    });
  });

  // =========================================================================================
  describe('blocking', () => {
    it('ends the friendship and stops requests in both directions, without telling the blocked player', async () => {
      const [a, b] = await players(2);
      await befriend(a!, b!);
      expect(await rpc(a!, 'block_player', b!.playerId)).toEqual({ ok: true, relationship: 'blocked' });
      expect(await rpc(a!, 'block_player', b!.playerId)).toEqual({ ok: true, relationship: 'blocked' });
      expect(await friendshipsOf(a!, b!)).toBe(0);

      expect(await send(a!, b!)).toEqual({ ok: false, code: 'BLOCKED_BY_YOU' });
      expect(await send(b!, a!)).toEqual({ ok: false, code: 'UNAVAILABLE' });
      // The blocker sees the block; the blocked player sees an ordinary stranger.
      expect(await rpc(a!, 'lookup_player', b!.playerId)).toMatchObject({ relationship: 'blocked' });
      expect(await rpc(b!, 'lookup_player', a!.playerId)).toMatchObject({ relationship: 'none' });
      expect((await socialState(a!)).blocked).toEqual([{ player_id: b!.playerId, nickname: b!.nickname }]);
      expect((await socialState(b!)).blocked).toEqual([]);
      expect(await rpc(a!, 'block_player', a!.playerId)).toEqual({ ok: false, code: 'SELF' });
    });

    it('withdraws open requests, and a reciprocal request cannot get around it', async () => {
      const [a, b] = await players(2);
      const sent = await send(b!, a!);
      await rpc(a!, 'block_player', b!.playerId);
      expect((await socialState(a!)).incoming).toEqual([]);
      expect((await socialState(a!)).notifications).toEqual([]);
      expect((await socialState(b!)).outgoing).toEqual([]);
      // a (the blocker) "accepting" or asking back creates nothing.
      expect(await rpc(a!, 'respond_friend_request', sent.request_id, true)).toEqual({ ok: false, code: 'REQUEST_GONE' });
      expect(await send(a!, b!)).toEqual({ ok: false, code: 'BLOCKED_BY_YOU' });
      expect(await send(b!, a!)).toEqual({ ok: false, code: 'UNAVAILABLE' });
      expect(await friendshipsOf(a!, b!)).toBe(0);
    });

    it('unblocking allows requests again', async () => {
      const [a, b] = await players(2);
      await rpc(a!, 'block_player', b!.playerId);
      expect(await rpc(a!, 'unblock_player', b!.playerId)).toEqual({ ok: true, relationship: 'none' });
      expect(await rpc(a!, 'unblock_player', b!.playerId)).toEqual({ ok: true, relationship: 'none' });
      await befriend(b!, a!);
      expect(await friendshipsOf(a!, b!)).toBe(1);
    });
  });

  // =========================================================================================
  describe('notifications', () => {
    it('belong to their recipient: nobody else can see or mark them', async () => {
      const [a, b, c] = await players(3);
      await send(a!, b!);
      const note = (await socialState(b!)).notifications[0];
      expect(await rpc(c!, 'mark_notifications_read', [note.id])).toEqual({ ok: true, marked: 0 });
      expect(await rpc(a!, 'mark_notifications_read', null)).toEqual({ ok: true, marked: 0 });
      expect((await socialState(b!)).unread).toBe(1);
      expect((await socialState(c!)).notifications).toEqual([]);

      expect(await rpc(b!, 'mark_notifications_read', [note.id])).toEqual({ ok: true, marked: 1 });
      expect(await rpc(b!, 'mark_notifications_read', [note.id])).toEqual({ ok: true, marked: 0 });
      const state = await socialState(b!);
      expect(state.unread).toBe(0);
      expect(state.notifications[0]).toMatchObject({ id: note.id, read: true });
    });

    it('are stored (an offline player finds them later) and never duplicated', async () => {
      const [a, b] = await players(2);
      const sent = await send(a!, b!);
      // The same event processed again, as the database owner: still one row.
      await sql`select public.social_notify(${b!.userId}, 'friend_request', ${a!.userId}, ${sent.request_id}, ${'friend_request:' + sent.request_id})`;
      await sql`select public.social_notify(${b!.userId}, 'friend_request', ${a!.userId}, ${sent.request_id}, ${'friend_request:' + sent.request_id})`;
      const state = await socialState(b!);
      expect(state.notifications).toHaveLength(1);
      expect(state.unread).toBe(1);
    });

    it('show the current nickname, and return a bounded page', async () => {
      const [a, b] = await players(2);
      await send(a!, b!);
      await as(a!.userId, (tx) => tx`select public.update_nickname('Brand New Name')`);
      expect((await socialState(b!)).notifications[0].actor.nickname).toBe('Brand New Name');
      for (let i = 0; i < 40; i += 1) {
        await sql`select public.social_notify(${b!.userId}, 'friend_accepted', ${a!.userId}, null, ${'bulk:' + i})`;
      }
      const state = await socialState(b!);
      expect(state.notifications).toHaveLength(30);
      expect(state.unread).toBe(41);
    });
  });

  // =========================================================================================
  describe('seats and accounts', () => {
    it('a seat is claimed only with its device token', async () => {
      const [host, guest, thief] = await players(3);
      const table = await hostGame(host!);
      ok(await joinTable(table, guest!, { claim: false }));
      const seat = table.seats.get(guest!.userId)!;

      expect(await rpc(thief!, 'claim_seat', table.gameId, seat.seatId, token())).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await rpc(thief!, 'claim_seat', table.gameId, seat.seatId, 'not-a-token')).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await rpc(thief!, 'claim_seat', randomUUID(), seat.seatId, seat.token)).toEqual({ ok: false, code: 'FORBIDDEN' });
      const [unclaimed] = await sql`select user_id from public.players where id = ${seat.seatId}`;
      expect(unclaimed!.user_id).toBeNull();

      expect(await rpc(guest!, 'claim_seat', table.gameId, seat.seatId, seat.token)).toEqual({ ok: true });
      expect(await rpc(guest!, 'claim_seat', table.gameId, seat.seatId, seat.token)).toEqual({ ok: true });
      const [claimed] = await sql`select user_id from public.players where id = ${seat.seatId}`;
      expect(claimed!.user_id).toBe(guest!.userId);
      // One account, one seat per table.
      const hostSeat = table.seats.get(host!.userId)!;
      expect(await rpc(guest!, 'claim_seat', table.gameId, hostSeat.seatId, hostSeat.token)).toEqual({ ok: false, code: 'ALREADY_SEATED' });
    });

    it('game_player_profiles: only for a seated player, only public profiles of claimed seats', async () => {
      const [host, friend, unclaimed, outsider] = await players(4);
      const table = await hostGame(host!);
      ok(await joinTable(table, friend!));
      ok(await joinTable(table, unclaimed!, { claim: false }));

      expect(await rpc(outsider!, 'game_player_profiles', table.gameId)).toEqual({ ok: false, code: 'NOT_IN_GAME' });
      expect(await rpc(unclaimed!, 'game_player_profiles', table.gameId)).toEqual({ ok: false, code: 'NOT_IN_GAME' });
      const seen = await rpc(host!, 'game_player_profiles', table.gameId);
      expect(seen).toEqual({
        ok: true,
        players: [{ seat_id: table.seats.get(friend!.userId)!.seatId, unavailable: false, player_id: friend!.playerId, nickname: friend!.nickname }],
      });
      // A player who blocked me is listed without a profile.
      await rpc(friend!, 'block_player', host!.playerId);
      expect(await rpc(host!, 'game_player_profiles', table.gameId)).toEqual({
        ok: true,
        players: [{ seat_id: table.seats.get(friend!.userId)!.seatId, unavailable: true }],
      });
    });

    it('two players who met at a table can become friends from it, without touching the game', async () => {
      const [host, guest] = await players(2);
      const table = await hostGame(host!);
      ok(await joinTable(table, guest!));
      ok(await act(table, host!, { type: 'START_GAME' }));
      const [before] = await sql`select state_version, current_player_id, turn from public.games where id = ${table.gameId}`;

      const seen = await rpc(guest!, 'game_player_profiles', table.gameId);
      const hostProfile = seen.players[0];
      expect(hostProfile.player_id).toBe(host!.playerId);
      // Both tap Add Friend during the match: the reciprocal rule applies exactly as from the Friends screen.
      expect(await rpc(guest!, 'send_friend_request', hostProfile.player_id)).toMatchObject({ ok: true, relationship: 'outgoing' });
      expect(await rpc(host!, 'send_friend_request', guest!.playerId)).toMatchObject({ ok: true, relationship: 'friends', matched: true });

      const [after] = await sql`select state_version, current_player_id, turn from public.games where id = ${table.gameId}`;
      expect(after).toEqual(before);
    });
  });

  // =========================================================================================
  describe('lobby admission (enforced by the referee)', () => {
    it('the capacity the invitations describe is the engine’s', async () => {
      const [row] = await sql`select public.social_game_capacity() as n`;
      expect(row!.n).toBe(BUSINESS_MVP_RULES.players.max);
    });

    it('friend of a friend: a non-host shares the code and a stranger to the host joins', async () => {
      const [a, b, c] = await players(3);
      await befriend(a!, b!);
      await befriend(b!, c!);
      const table = await hostGame(a!);
      ok(await joinTable(table, b!));
      // c is not a's friend, and is given the code by b.
      expect(await friendshipsOf(a!, c!)).toBe(0);
      const joined = ok(await joinTable(table, c!));
      expect(joined.snapshot.state.players.filter((p) => p.status !== 'LEFT')).toHaveLength(3);
      // Joining created no friendship and no request.
      expect(await friendshipsOf(a!, c!)).toBe(0);
      expect((await socialState(a!)).incoming).toEqual([]);
      expect((await socialState(c!)).incoming).toEqual([]);
    });

    it('lock: only the host; while locked nobody joins by code; unlocking reopens', async () => {
      const [host, guest, late] = await players(3);
      const table = await hostGame(host!);
      ok(await joinTable(table, guest!));

      const refused = await act(table, guest!, { type: 'SET_LOBBY_LOCK', locked: true });
      expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

      const locked = ok(await act(table, host!, { type: 'SET_LOBBY_LOCK', locked: true }));
      expect(locked.snapshot.state.lobbyLocked).toBe(true);
      const [row] = await sql`select lobby_locked from public.games where id = ${table.gameId}`;
      expect(row!.lobby_locked).toBe(true);

      const blocked = await joinTable(table, late!);
      expect(blocked).toMatchObject({ ok: false, error: { code: 'LOBBY_LOCKED' } });
      const [count] = await sql`select count(*)::int as n from public.players where game_id = ${table.gameId}`;
      expect(count!.n).toBe(2);

      const unlocked = ok(await act(table, host!, { type: 'SET_LOBBY_LOCK', locked: false }));
      expect(unlocked.snapshot.state.lobbyLocked).toBe(false);
      ok(await joinTable(table, late!));
    });

    it('remove: only the host, only in the lobby; the removed player is out and the seat is free', async () => {
      const [host, guest, other] = await players(3);
      const table = await hostGame(host!);
      ok(await joinTable(table, guest!));
      ok(await joinTable(table, other!));
      const guestSeat = table.seats.get(guest!.userId)!.seatId;

      expect(await act(table, other!, { type: 'REMOVE_PLAYER', playerId: guestSeat })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await act(table, host!, { type: 'REMOVE_PLAYER', playerId: table.seats.get(host!.userId)!.seatId })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      const removed = ok(await act(table, host!, { type: 'REMOVE_PLAYER', playerId: guestSeat }));
      expect(removed.snapshot.state.players.find((p) => p.id === guestSeat)!.status).toBe('LEFT');
      // The removed player can do nothing more in this game, and is no longer "seated" for invitations.
      expect(await act(table, guest!, { type: 'SET_READY', ready: true })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await rpc(guest!, 'game_player_profiles', table.gameId)).toEqual({ ok: false, code: 'NOT_IN_GAME' });

      ok(await act(table, host!, { type: 'START_GAME' }));
      expect(await act(table, host!, { type: 'REMOVE_PLAYER', playerId: table.seats.get(other!.userId)!.seatId })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
      expect(await act(table, host!, { type: 'SET_LOBBY_LOCK', locked: true })).toMatchObject({ ok: false, error: { code: 'INVALID_PHASE' } });
    });

    it('a started game takes no new players; a full lobby takes no more', async () => {
      const [host, guest, late] = await players(3);
      const table = await hostGame(host!);
      ok(await joinTable(table, guest!));
      ok(await act(table, host!, { type: 'START_GAME' }));
      expect(await joinTable(table, late!)).toMatchObject({ ok: false, error: { code: 'GAME_NOT_ACTIVE' } });

      const crowd = await players(BUSINESS_MVP_RULES.players.max);
      const full = await hostGame(crowd[0]!);
      for (const p of crowd.slice(1)) ok(await joinTable(full, p));
      expect(await joinTable(full, late!)).toMatchObject({ ok: false, error: { code: 'GAME_FULL' } });
    });

    it('a player who rejoins with the same request gets their own seat back, not a second one', async () => {
      const [host, guest] = await players(2);
      const table = await hostGame(host!);
      const t = token();
      const actionId = randomUUID();
      const first = ok(await call({ op: 'join', actionId, token: t, code: table.code, name: guest!.nickname }));
      const again = ok(await call({ op: 'join', actionId, token: t, code: table.code, name: guest!.nickname }));
      expect(again.playerId).toBe(first.playerId);
      expect(again.duplicate).toBe(true);
      const [count] = await sql`select count(*)::int as n from public.players where game_id = ${table.gameId}`;
      expect(count!.n).toBe(2);
      // …and reading the game again later (a reconnect) is the same seat with the same token.
      expect(ok(await call({ op: 'state', gameId: table.gameId, playerId: first.playerId, token: t })).playerId).toBe(first.playerId);
    });
  });

  // =========================================================================================
  describe('direct game invitations', () => {
    it('a seated player invites a friend; the friend sees it, opens it and joins by the normal flow', async () => {
      const [host, friend] = await players(2);
      await befriend(host!, friend!);
      const table = await hostGame(host!, 'intermediate');

      const sent = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      expect(sent).toMatchObject({ ok: true, created: true });
      const minutes = (Date.parse(sent.expires_at) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15.1);

      const inbox = await socialState(friend!);
      expect(inbox.invites).toHaveLength(1);
      expect(inbox.invites[0]).toMatchObject({
        id: sent.invite_id,
        state: 'open',
        mode: 'intermediate',
        players: 1,
        capacity: BUSINESS_MVP_RULES.players.max,
        inviter: { player_id: host!.playerId, nickname: host!.nickname },
      });
      expect(inbox.notifications[0]).toMatchObject({ type: 'game_invite', read: false, entity_id: sent.invite_id });
      // No credential travels with an invitation: not the code, not a token, not the game id.
      expect(JSON.stringify(inbox.invites)).not.toContain(table.code);
      expect(JSON.stringify(inbox.invites)).not.toContain(table.gameId);
      expect((await socialState(host!)).sent_invites).toEqual([expect.objectContaining({ id: sent.invite_id, game_id: table.gameId, player_id: friend!.playerId })]);

      const opened = await rpc(friend!, 'open_game_invite', sent.invite_id);
      expect(opened).toEqual({ ok: true, game_id: table.gameId, code: table.code, mode: 'intermediate' });
      ok(await joinTable(table, friend!));
      // Joining settled the invitation.
      const [row] = await sql`select status from public.game_invitations where id = ${sent.invite_id}`;
      expect(row!.status).toBe('accepted');
      expect((await socialState(friend!)).invites).toEqual([]);
      expect((await socialState(host!)).sent_invites).toEqual([]);
      // Accepting an invitation is not a friendship change.
      expect(await friendshipsOf(host!, friend!)).toBe(1);
    });

    it('sending the same invitation again creates nothing new', async () => {
      const [host, friend] = await players(2);
      await befriend(host!, friend!);
      const table = await hostGame(host!);
      const first = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      const again = await Promise.all(Array.from({ length: 4 }, () => rpc(host!, 'send_game_invite', table.gameId, friend!.playerId)));
      for (const r of again) expect(r).toMatchObject({ ok: true, created: false, invite_id: first.invite_id });
      const [rows] = await sql`select count(*)::int as n from public.game_invitations where game_id = ${table.gameId}`;
      expect(rows!.n).toBe(1);
      const state = await socialState(friend!);
      expect(state.notifications.filter((n: Json) => n.type === 'game_invite')).toHaveLength(1);
    });

    it('who may invite whom', async () => {
      const [host, participant, friendOfParticipant, stranger, outsider] = await players(5);
      await befriend(host!, participant!);
      await befriend(participant!, friendOfParticipant!);
      await befriend(outsider!, stranger!);
      const table = await hostGame(host!);
      ok(await joinTable(table, participant!));

      // Not at the table: cannot invite into it.
      expect(await rpc(outsider!, 'send_game_invite', table.gameId, stranger!.playerId)).toEqual({ ok: false, code: 'NOT_IN_GAME' });
      // At the table, but the invitee is not a friend of the inviter (they are given the code instead).
      expect(await rpc(host!, 'send_game_invite', table.gameId, stranger!.playerId)).toEqual({ ok: false, code: 'NOT_FRIENDS' });
      expect(await rpc(host!, 'send_game_invite', table.gameId, host!.playerId)).toEqual({ ok: false, code: 'SELF' });
      // Already seated.
      expect(await rpc(host!, 'send_game_invite', table.gameId, participant!.playerId)).toEqual({ ok: false, code: 'ALREADY_IN_GAME' });
      // A participant who is not the host invites THEIR friend, who is not the host's friend.
      const sent = await rpc(participant!, 'send_game_invite', table.gameId, friendOfParticipant!.playerId);
      expect(sent).toMatchObject({ ok: true, created: true });
      expect(await rpc(friendOfParticipant!, 'open_game_invite', sent.invite_id)).toMatchObject({ ok: true, code: table.code });
      // Only the recipient can open or decline it.
      expect(await rpc(stranger!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });
      expect(await rpc(stranger!, 'decline_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'NOT_FOUND' });
      ok(await joinTable(table, friendOfParticipant!));
      expect(await friendshipsOf(host!, friendOfParticipant!)).toBe(0);
    });

    it('an invitation is refused or invalid when the lobby is locked, full, started or closed — and is never a way in', async () => {
      const [host, friend, second] = await players(3);
      await befriend(host!, friend!);
      await befriend(host!, second!);
      const table = await hostGame(host!);
      const sent = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);

      // Locked: existing invitation stops working, new ones are refused, the join itself is refused.
      ok(await act(table, host!, { type: 'SET_LOBBY_LOCK', locked: true }));
      expect((await socialState(friend!)).invites[0]).toMatchObject({ id: sent.invite_id, state: 'locked' });
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'LOBBY_LOCKED' });
      expect(await rpc(host!, 'send_game_invite', table.gameId, second!.playerId)).toEqual({ ok: false, code: 'LOBBY_LOCKED' });
      expect(await joinTable(table, friend!)).toMatchObject({ ok: false, error: { code: 'LOBBY_LOCKED' } });
      // Unlocked: it works again.
      ok(await act(table, host!, { type: 'SET_LOBBY_LOCK', locked: false }));
      expect((await socialState(friend!)).invites[0]).toMatchObject({ state: 'open' });

      // Started.
      ok(await joinTable(table, second!));
      ok(await act(table, host!, { type: 'START_GAME' }));
      expect((await socialState(friend!)).invites[0]).toMatchObject({ state: 'started' });
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'GAME_STARTED' });
      expect(await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId)).toEqual({ ok: false, code: 'GAME_STARTED' });
      expect(await joinTable(table, friend!)).toMatchObject({ ok: false, error: { code: 'GAME_NOT_ACTIVE' } });

      // Closed (the game finished).
      ok(await act(table, host!, { type: 'END_GAME' }));
      expect((await socialState(friend!)).invites[0]).toMatchObject({ state: 'closed' });
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'GAME_CLOSED' });
      expect(await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId)).toEqual({ ok: false, code: 'GAME_CLOSED' });
    });

    it('full lobby: the invitation says so and the join is refused', async () => {
      const crowd = await players(BUSINESS_MVP_RULES.players.max);
      const [host, friend, other] = [crowd[0]!, ...(await players(2))];
      await befriend(host, friend!);
      await befriend(host, other!);
      const table = await hostGame(host);
      const sent = await rpc(host, 'send_game_invite', table.gameId, friend!.playerId);
      for (const p of crowd.slice(1)) ok(await joinTable(table, p));
      expect((await socialState(friend!)).invites[0]).toMatchObject({ state: 'full', players: BUSINESS_MVP_RULES.players.max });
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'GAME_FULL' });
      expect(await rpc(host, 'send_game_invite', table.gameId, other!.playerId)).toEqual({ ok: false, code: 'GAME_FULL' });
      expect(await joinTable(table, friend!)).toMatchObject({ ok: false, error: { code: 'GAME_FULL' } });
    });

    it('expires after 15 minutes by the server clock; a new one can then be sent', async () => {
      const [host, friend] = await players(2);
      await befriend(host!, friend!);
      const table = await hostGame(host!);
      const sent = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      await sql`update public.game_invitations set expires_at = now() - interval '1 second' where id = ${sent.invite_id}`;
      expect((await socialState(friend!)).invites[0]).toMatchObject({ id: sent.invite_id, state: 'expired' });
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'INVITE_EXPIRED' });
      expect((await socialState(host!)).sent_invites).toEqual([]);
      const fresh = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      expect(fresh).toMatchObject({ ok: true, created: true });
      expect(fresh.invite_id).not.toBe(sent.invite_id);
    });

    it('decline (recipient) and revoke (inviter, or the host of the game)', async () => {
      const [host, participant, f1, f2, f3] = await players(5);
      await befriend(host!, participant!);
      for (const f of [f1!, f2!, f3!]) await befriend(participant!, f);
      const table = await hostGame(host!);
      ok(await joinTable(table, participant!));
      const [i1, i2, i3] = await Promise.all([f1!, f2!, f3!].map((f) => rpc(participant!, 'send_game_invite', table.gameId, f.playerId)));

      expect(await rpc(f1!, 'decline_game_invite', i1!.invite_id)).toEqual({ ok: true });
      expect(await rpc(f1!, 'decline_game_invite', i1!.invite_id)).toEqual({ ok: true });
      expect((await socialState(f1!)).invites).toEqual([]);
      expect((await socialState(f1!)).unread).toBe(0);
      expect(await rpc(f1!, 'open_game_invite', i1!.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });

      // Someone unrelated cannot revoke; the inviter and the host can.
      expect(await rpc(f3!, 'revoke_game_invite', i2!.invite_id)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(participant!, 'revoke_game_invite', i2!.invite_id)).toEqual({ ok: true });
      expect(await rpc(host!, 'revoke_game_invite', i3!.invite_id)).toEqual({ ok: true });
      for (const [f, invite] of [[f2!, i2!], [f3!, i3!]] as const) {
        const state = await socialState(f);
        expect(state.invites).toEqual([]);
        expect(state.notifications.filter((n: Json) => n.type === 'game_invite')).toEqual([]);
        expect(await rpc(f, 'open_game_invite', invite.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });
      }
    });

    it('a block withdraws invitations between the two and refuses new ones', async () => {
      const [host, friend] = await players(2);
      await befriend(host!, friend!);
      const table = await hostGame(host!);
      const sent = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      await rpc(friend!, 'block_player', host!.playerId);
      const [row] = await sql`select status from public.game_invitations where id = ${sent.invite_id}`;
      expect(row!.status).toBe('revoked');
      expect((await socialState(friend!)).invites).toEqual([]);
      expect(await rpc(friend!, 'open_game_invite', sent.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });
      expect(await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    });

    it('invitations are rate limited per recipient', async () => {
      const [host, friend] = await players(2);
      await befriend(host!, friend!);
      const table = await hostGame(host!);
      const [limit] = await sql`select max_count from public.social_limits where key = 'game_invite_pair'`;
      for (let i = 0; i < Number(limit!.max_count); i += 1) {
        const sent = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
        expect(sent).toMatchObject({ ok: true, created: true });
        await rpc(host!, 'revoke_game_invite', sent.invite_id);
      }
      const refused = await rpc(host!, 'send_game_invite', table.gameId, friend!.playerId);
      expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      expect(refused.retry_after_seconds).toBeGreaterThan(0);
    });
  });

  // =========================================================================================
  describe('account deletion', () => {
    it('removes every social record of the account, tells the others, and leaves the game alone', async () => {
      const [gone, friend, requester, requested, blocked] = await players(5);
      await befriend(gone!, friend!);
      await send(requester!, gone!);
      await send(gone!, requested!);
      await rpc(gone!, 'block_player', blocked!.playerId);
      const table = await hostGame(friend!);
      ok(await joinTable(table, gone!));
      const other = await hostGame(gone!);
      const invite = await rpc(gone!, 'send_game_invite', other.gameId, friend!.playerId);
      expect(invite.ok).toBe(true);
      const versionBefore = await versionOf(friend!);
      const [gameBefore] = await sql`select state_version, status from public.games where id = ${table.gameId}`;

      // What the delete-account function does: Supabase Auth deletes the user.
      await sql`delete from auth.users where id = ${gone!.userId}`;

      for (const table of ['friend_requests', 'friendships', 'player_blocks', 'game_invitations', 'notifications', 'social_sync', 'social_rate_events']) {
        const columns: Record<string, string[]> = {
          friend_requests: ['sender_user_id', 'recipient_user_id'],
          friendships: ['user_low', 'user_high'],
          player_blocks: ['blocker_user_id', 'blocked_user_id'],
          game_invitations: ['inviter_user_id', 'recipient_user_id'],
          notifications: ['recipient_user_id', 'actor_user_id'],
          social_sync: ['user_id'],
          social_rate_events: ['user_id', 'target_user_id'],
        };
        const where = columns[table]!.map((c) => `${c} = '${gone!.userId}'`).join(' or ');
        const [left] = await sql.unsafe(`select count(*)::int as n from public.${table} where ${where}`);
        expect(left!.n, table).toBe(0);
      }

      // The friend: no friend, no invitation, no notification naming the deleted player — and told to refetch.
      const state = await socialState(friend!);
      expect(state.friends).toEqual([]);
      expect(state.invites).toEqual([]);
      expect(JSON.stringify(state)).not.toContain(gone!.playerId);
      expect(JSON.stringify(state)).not.toContain(gone!.nickname);
      expect(Number(state.version)).toBeGreaterThan(versionBefore);
      expect((await socialState(requester!)).outgoing).toEqual([]);
      expect((await socialState(requested!)).incoming).toEqual([]);

      // Nothing can be created for the deleted account any more.
      expect(await rpc(friend!, 'lookup_player', gone!.playerId)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(friend!, 'send_friend_request', gone!.playerId)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(friend!, 'send_game_invite', table.gameId, gone!.playerId)).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rpc(friend!, 'open_game_invite', invite.invite_id)).toEqual({ ok: false, code: 'INVITE_GONE' });
      // A still-valid token of the deleted account gets nowhere.
      expect(await rpc(gone!, 'social_state')).toEqual({ ok: false, code: 'NO_PROFILE' });
      expect(await rpc(gone!, 'send_friend_request', friend!.playerId)).toEqual({ ok: false, code: 'NO_PROFILE' });

      // The game they sat in is untouched: same version, their seat is still a seat (just not an account's).
      const [gameAfter] = await sql`select state_version, status from public.games where id = ${table.gameId}`;
      expect(gameAfter).toEqual(gameBefore);
      const seat = table.seats.get(gone!.userId)!;
      const [row] = await sql`select user_id, status from public.players where id = ${seat.seatId}`;
      expect(row).toMatchObject({ user_id: null, status: 'ACTIVE' });
      const snapshot = ok(await call({ op: 'state', gameId: table.gameId, playerId: seat.seatId, token: seat.token })).snapshot;
      expect(snapshot.state.players).toHaveLength(2);
      ok(await act(table, friend!, { type: 'START_GAME' }));
    });
  });

  // =========================================================================================
  describe('housekeeping', () => {
    it('social_cleanup() expires what is past its time and changes nothing else', async () => {
      const [a, b, c] = await players(3);
      const stale = await send(a!, b!);
      const live = await send(a!, c!);
      await sql`update public.friend_requests set expires_at = now() - interval '1 second' where id = ${stale.request_id}`;
      await sql`select public.social_cleanup()`;
      const rows = await sql`select id, status from public.friend_requests where id in (${stale.request_id}, ${live.request_id})`;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [stale.request_id]: 'expired', [live.request_id]: 'pending' });
    });
  });
});
