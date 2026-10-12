/// <reference types="node" />
/**
 * Integration tests for quick reactions and preset messages (the `chat` op of the game-action
 * Edge Function) against a real Postgres with the production migrations applied.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
 *
 * Skipped when DATABASE_URL is not set.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { endByVote } from './endByVote.ts';
import { createSql, type Sql } from '../../supabase/functions/game-action/db.ts';
import { handleRequest } from '../../supabase/functions/game-action/handler.ts';
import { handleQuickChat, type QuickChatDeps } from '../../supabase/functions/game-action/quickChat.ts';
import {
  QUICK_CHAT_COOLDOWN_MS,
  QuickChatEventSchema,
  type ApiResponse,
  type GameAction,
  type QuickChatEvent,
  type QuickChatItem,
  type QuickChatResponse,
} from '../../supabase/functions/_shared/engine/index.ts';
import { orderRandoms } from '../engine/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;

interface Seat {
  playerId: string;
  token: string;
}

describe.skipIf(!DATABASE_URL)('quick chat (Postgres)', () => {
  let sql: Sql;
  let deps: QuickChatDeps;
  /** Everything the server sent to realtime, and to which game's topic. */
  let sent: { gameId: string; event: QuickChatEvent }[] = [];
  let queuedRandoms: number[] = [];

  beforeAll(() => {
    sql = createSql(DATABASE_URL!, 10);
    deps = {
      sql,
      broadcastChat: async (gameId, event) => {
        sent.push({ gameId, event });
      },
    };
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    sent = [];
  });

  const token = () => randomBytes(32).toString('hex');

  async function game(body: unknown): Promise<Extract<ApiResponse, { ok: true }>> {
    const res = (await handleRequest(body, { sql, random: () => queuedRandoms.shift() ?? Math.random() })).body;
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  }

  /** A started game (unless `start: false`), with each player's seat. */
  async function setupGame(names = ['Asha', 'Bilal', 'Chitra'], { start = true, mode }: { start?: boolean; mode?: 'classic' | 'intermediate' } = {}) {
    const seats: Record<string, Seat> = {};
    const [host, ...rest] = names;
    const hostToken = token();
    const created = await game({ op: 'create', actionId: randomUUID(), token: hostToken, name: host, ...(mode ? { mode } : {}) });
    seats[host!] = { playerId: created.playerId, token: hostToken };
    const gameId = created.gameId;
    let version = created.snapshot.state.version;
    for (const name of rest) {
      const t = token();
      const joined = await game({ op: 'join', actionId: randomUUID(), token: t, code: created.snapshot.state.code, name });
      seats[name] = { playerId: joined.playerId, token: t };
      version = joined.snapshot.state.version;
    }
    const act = async (name: string, action: GameAction) => {
      if (action.type === 'START_GAME') queuedRandoms = orderRandoms(names, names);
      const seat = seats[name]!;
      const res = await game({ op: 'action', gameId, playerId: seat.playerId, token: seat.token, actionId: randomUUID(), expectedVersion: version, action });
      queuedRandoms = [];
      version = res.snapshot.state.version;
      return res;
    };
    if (start) await act(host!, { type: 'START_GAME' });
    return { gameId, seats, act };
  }

  const reaction = (key = 'funny'): QuickChatItem => ({ kind: 'reaction', key }) as QuickChatItem;
  const message = (key = 'skill_issue'): QuickChatItem => ({ kind: 'preset_message', key }) as QuickChatItem;

  async function chat(gameId: string, seat: Seat, item: { kind: string; key: string }, extra: Record<string, unknown> = {}) {
    return handleQuickChat({ op: 'chat', gameId, playerId: seat.playerId, token: seat.token, eventId: randomUUID(), ...item, ...extra }, deps);
  }

  async function send(gameId: string, seat: Seat, item: { kind: string; key: string }, extra: Record<string, unknown> = {}): Promise<QuickChatResponse> {
    return (await chat(gameId, seat, item, extra)).body;
  }

  /** The cooldown has passed for this player (the server's own clock decides; the test moves the mark, not the clock). */
  const coolDown = (seat: Seat) => sql`update public.players set last_chat_at = now() - interval '2100 milliseconds' where id = ${seat.playerId}`;

  /** Everything permanent about a game: none of it may change because of chat. */
  async function footprint(gameId: string) {
    const [g] = await sql`select state_version, status, updated_at from public.games where id = ${gameId}`;
    const [counts] = await sql`
      select (select count(*)::int from public.game_events where game_id = ${gameId}) as events,
             (select count(*)::int from public.game_actions where game_id = ${gameId}) as actions,
             (select count(*)::int from public.transactions where game_id = ${gameId}) as transactions`;
    const players = await sql`select id, balance, position, status, seat, is_host from public.players where game_id = ${gameId} order by seat`;
    return JSON.stringify({ g, counts, players });
  }

  it('a reaction from a player goes to that game’s topic, named by the server as theirs, with the server’s time', async () => {
    const g = await setupGame();
    const eventId = randomUUID();
    const before = Date.now();
    const res = await handleQuickChat({ op: 'chat', gameId: g.gameId, playerId: g.seats.Bilal!.playerId, token: g.seats.Bilal!.token, eventId, kind: 'reaction', key: 'great_move' }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, event: { v: 1, id: eventId, gameId: g.gameId, playerId: g.seats.Bilal!.playerId, kind: 'reaction', key: 'great_move' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.gameId).toBe(g.gameId);
    const event = sent[0]!.event;
    // Exactly the minimal, versioned payload the app validates: nothing else rides along.
    expect(QuickChatEventSchema.safeParse(event).success).toBe(true);
    expect(Object.keys(event).sort()).toEqual(['at', 'gameId', 'id', 'key', 'kind', 'playerId', 'v']);
    expect(JSON.stringify(event)).not.toContain(g.seats.Bilal!.token);
    expect(Math.abs(Date.parse(event.at) - before)).toBeLessThan(5000);
  });

  it('a preset message travels the same way, as its id', async () => {
    const g = await setupGame();
    expect(await send(g.gameId, g.seats.Asha!, message('too_expensive'))).toMatchObject({ ok: true });
    expect(sent.map((s) => [s.gameId, s.event.playerId, s.event.kind, s.event.key])).toEqual([[g.gameId, g.seats.Asha!.playerId, 'preset_message', 'too_expensive']]);
  });

  it('nothing is sent to another game: each event goes to the topic of the game its sender is in', async () => {
    const a = await setupGame(['Asha', 'Bilal']);
    const b = await setupGame(['Dev', 'Esha']);
    await send(a.gameId, a.seats.Asha!, reaction());
    await send(b.gameId, b.seats.Dev!, message());
    expect(sent.map((s) => [s.gameId, s.event.gameId, s.event.playerId])).toEqual([
      [a.gameId, a.gameId, a.seats.Asha!.playerId],
      [b.gameId, b.gameId, b.seats.Dev!.playerId],
    ]);
  });

  it('nobody can speak as someone else: another player’s id with my token, or a sender field of my own, is refused', async () => {
    const g = await setupGame();
    const asBilal = await send(g.gameId, { playerId: g.seats.Bilal!.playerId, token: g.seats.Asha!.token }, reaction());
    expect(asBilal).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    for (const extra of [{ senderId: g.seats.Bilal!.playerId }, { from: g.seats.Bilal!.playerId }, { at: '2020-01-01T00:00:00.000Z' }, { text: 'anything I like' }]) {
      const res = await chat(g.gameId, g.seats.Asha!, reaction(), extra);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(sent).toHaveLength(0);
    // …and the refused attempts did not use up Bilal's or Asha's turn to speak.
    expect(await send(g.gameId, g.seats.Bilal!, reaction())).toMatchObject({ ok: true });
    expect(await send(g.gameId, g.seats.Asha!, reaction())).toMatchObject({ ok: true });
  });

  it('only a player of the game may send: a stranger, a wrong token and a player of another game are refused', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const other = await setupGame(['Dev', 'Esha']);
    expect(await send(g.gameId, { playerId: randomUUID(), token: token() }, reaction())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await send(g.gameId, { playerId: g.seats.Asha!.playerId, token: token() }, reaction())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    // Dev is a real player with a real token — of another game.
    expect(await send(g.gameId, other.seats.Dev!, reaction())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await send(randomUUID(), g.seats.Asha!, reaction())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(sent).toHaveLength(0);
  });

  it('only ids from the catalogue: unknown ids, the other kind’s ids, free text and malformed bodies are refused', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const seat = g.seats.Asha!;
    const base = { op: 'chat', gameId: g.gameId, playerId: seat.playerId, token: seat.token, eventId: randomUUID() };
    for (const body of [
      { ...base, kind: 'reaction', key: 'made_up' },
      { ...base, kind: 'reaction', key: 'skill_issue' },
      { ...base, kind: 'preset_message', key: 'funny' },
      { ...base, kind: 'preset_message', key: 'You are all terrible' },
      { ...base, kind: 'message', key: 'skill_issue' },
      { ...base, kind: 'reaction', key: '' },
      { ...base, kind: 'reaction' },
      { ...base, kind: 'reaction', key: 'funny', eventId: 'not-a-uuid' },
      { ...base, kind: 'reaction', key: 'funny', token: 'short' },
      { op: 'chat' },
      null,
      'chat',
    ]) {
      const res = await handleQuickChat(body, deps);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(sent).toHaveLength(0);
    // The referee does not take it either: chat is not a game action.
    expect((await handleRequest({ ...base, kind: 'reaction', key: 'funny' }, { sql })).body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('two seconds per player, across reactions and messages together, on the server’s clock', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const asha = g.seats.Asha!;
    expect(await send(g.gameId, asha, reaction('funny'))).toMatchObject({ ok: true });
    const tooSoon = await send(g.gameId, asha, message('nice_try'));
    expect(tooSoon).toMatchObject({ ok: false, error: { code: 'COOLDOWN' } });
    if (tooSoon.ok) throw new Error('unreachable');
    expect(tooSoon.error.retryAfterMs).toBeGreaterThan(0);
    expect(tooSoon.error.retryAfterMs).toBeLessThanOrEqual(QUICK_CHAT_COOLDOWN_MS);
    expect(await send(g.gameId, asha, reaction('respect'))).toMatchObject({ ok: false, error: { code: 'COOLDOWN' } });
    expect(sent).toHaveLength(1);
    // A refusal does not push the cooldown back.
    const lastSpoke = async () => new Date((await sql`select last_chat_at from public.players where id = ${asha.playerId}`)[0]!.last_chat_at as Date).getTime();
    const first = await lastSpoke();
    await send(g.gameId, asha, reaction('respect'));
    expect(await lastSpoke()).toBe(first);

    await coolDown(asha);
    expect(await send(g.gameId, asha, message('nice_try'))).toMatchObject({ ok: true });
    expect(await send(g.gameId, asha, reaction('funny'))).toMatchObject({ ok: false, error: { code: 'COOLDOWN' } });
    expect(sent.map((s) => s.event.key)).toEqual(['funny', 'nice_try']);
  });

  it('really two seconds: just under is refused, just over is accepted', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const asha = g.seats.Asha!;
    await sql`update public.players set last_chat_at = now() - interval '1500 milliseconds' where id = ${asha.playerId}`;
    expect(await send(g.gameId, asha, reaction())).toMatchObject({ ok: false, error: { code: 'COOLDOWN' } });
    await sql`update public.players set last_chat_at = now() - interval '2001 milliseconds' where id = ${asha.playerId}`;
    expect(await send(g.gameId, asha, reaction())).toMatchObject({ ok: true });
  });

  it('each player has their own cooldown: one being told to wait does not hold up the others', async () => {
    const g = await setupGame();
    expect(await send(g.gameId, g.seats.Asha!, reaction())).toMatchObject({ ok: true });
    expect(await send(g.gameId, g.seats.Bilal!, message())).toMatchObject({ ok: true });
    expect(await send(g.gameId, g.seats.Asha!, reaction())).toMatchObject({ ok: false, error: { code: 'COOLDOWN' } });
    expect(await send(g.gameId, g.seats.Chitra!, reaction('deal'))).toMatchObject({ ok: true });
    expect(sent.map((s) => s.event.playerId)).toEqual([g.seats.Asha!.playerId, g.seats.Bilal!.playerId, g.seats.Chitra!.playerId]);
  });

  it('a burst from one player — two phones, a double tap — gets exactly one through', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => send(g.gameId, g.seats.Asha!, i % 2 ? reaction() : message())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'COOLDOWN')).toHaveLength(7);
    expect(sent).toHaveLength(1);
  });

  it('nothing is kept: no history, no log entry, no ledger entry, no version bump — only when the player last spoke', async () => {
    const g = await setupGame();
    const before = await footprint(g.gameId);
    const tables = async () => (await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`).map((r) => r.table_name as string);
    const tablesBefore = await tables();
    await send(g.gameId, g.seats.Asha!, reaction());
    await send(g.gameId, g.seats.Bilal!, message('its_over'));
    await send(g.gameId, g.seats.Asha!, reaction()); // refused
    expect(await footprint(g.gameId)).toBe(before);
    expect(await tables()).toEqual(tablesBefore);
    expect(tablesBefore.filter((t) => /chat|message|reaction/.test(t))).toEqual([]);
    // What a player gets when they (re)connect carries no chat at all.
    const snapshot = (await game({ op: 'state', gameId: g.gameId, playerId: g.seats.Chitra!.playerId, token: g.seats.Chitra!.token })).snapshot;
    expect(JSON.stringify(snapshot)).not.toMatch(/its_over|preset_message|last_chat/i);
    expect(snapshot.events.some((e) => /chat|reaction/i.test(e.type))).toBe(false);
  });

  it('the game goes on untouched: turns, purchases and the version are exactly what they would have been', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    await send(g.gameId, g.seats.Asha!, reaction());
    queuedRandoms = [0.01, 0.2]; // 1 + 2 → Railway
    const rolled = await g.act('Asha', { type: 'ROLL_DICE' });
    await send(g.gameId, g.seats.Bilal!, message('lucky_roll')); // not Bilal's turn: no turn is needed
    const bought = await g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(bought.snapshot.state.version).toBe(rolled.snapshot.state.version + 1);
    expect(bought.snapshot.state.properties.RAILWAY.ownerId).toBe(g.seats.Asha!.playerId);
    await g.act('Asha', { type: 'END_TURN' });
    expect(sent).toHaveLength(2);
  });

  it('a broadcast that fails is reported as not sent, and breaks nothing', async () => {
    const g = await setupGame(['Asha', 'Bilal']);
    const failing: QuickChatDeps = {
      sql,
      broadcastChat: async () => {
        throw new Error('realtime is down');
      },
    };
    const before = await footprint(g.gameId);
    const res = await handleQuickChat({ op: 'chat', gameId: g.gameId, playerId: g.seats.Asha!.playerId, token: g.seats.Asha!.token, eventId: randomUUID(), kind: 'reaction', key: 'funny' }, failing);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(await footprint(g.gameId)).toBe(before);
    queuedRandoms = [0.01, 0.2];
    expect((await g.act('Asha', { type: 'ROLL_DICE' })).ok).toBe(true);
  });

  it('only in a game that is being played: not in the lobby, not after the end; a paused game still talks; someone who left does not', async () => {
    const lobby = await setupGame(['Asha', 'Bilal'], { start: false });
    expect(await send(lobby.gameId, lobby.seats.Asha!, reaction())).toMatchObject({ ok: false, error: { code: 'GAME_NOT_ACTIVE' } });

    const g = await setupGame();
    await g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(await send(g.gameId, g.seats.Chitra!, reaction())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await g.act('Bilal', { type: 'PAUSE_GAME' });
    expect(await send(g.gameId, g.seats.Bilal!, reaction())).toMatchObject({ ok: true });
    await g.act('Bilal', { type: 'RESUME_GAME' });
    await endByVote(g.act, Object.keys(g.seats), 'Asha');
    expect(await send(g.gameId, g.seats.Asha!, message())).toMatchObject({ ok: false, error: { code: 'GAME_NOT_ACTIVE' } });
    expect(sent).toHaveLength(1);
  });

  it.each(['classic', 'intermediate'] as const)('works in a %s game', async (mode) => {
    const g = await setupGame(['Asha', 'Bilal'], { mode });
    expect(await send(g.gameId, g.seats.Asha!, message('coming_for_you'))).toMatchObject({ ok: true });
    expect(await send(g.gameId, g.seats.Bilal!, reaction('unexpected'))).toMatchObject({ ok: true });
    expect(sent.map((s) => s.event.key)).toEqual(['coming_for_you', 'unexpected']);
  });
});
