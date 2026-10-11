// Quick reactions and preset messages. Not the referee: nothing here reads or writes game state,
// takes the game lock or bumps the game version.
//
//   validate body (ids from the shared catalogue only) → authenticate the player's device token →
//   claim the cooldown (one atomic UPDATE on the database clock) → broadcast to the game's topic.
//
// The sender in the broadcast is the player the token proved, never a field the client chose.
// Nothing is stored except the time of the player's last send.
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import { QUICK_CHAT_COOLDOWN_MS, QUICK_CHAT_VERSION, QuickChatRequestSchema, type QuickChatEvent, type QuickChatResponse } from '../_shared/engine/index.ts';
import type { Sql } from './db.ts';
import { sha256Hex } from './handler.ts';

export interface QuickChatDeps {
  sql: Sql;
  /** Sends the event to everyone subscribed to the game's realtime topic. */
  broadcastChat?: (gameId: string, event: QuickChatEvent) => Promise<void>;
}

export interface QuickChatResult {
  status: number;
  body: QuickChatResponse;
}

type Failure = Extract<QuickChatResponse, { ok: false }>['error'];

function refuse(code: Failure['code'], message: string, status = 200, retryAfterMs?: number): QuickChatResult {
  return { status, body: { ok: false, error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } } };
}

export async function handleQuickChat(rawBody: unknown, deps: QuickChatDeps): Promise<QuickChatResult> {
  const parsed = QuickChatRequestSchema.safeParse(rawBody);
  if (!parsed.success) return refuse('VALIDATION', 'That reaction is not valid.', 400);
  const req = parsed.data;
  try {
    const [seat] = await deps.sql`
      select p.token_hash, p.status as player_status, g.status as game_status
      from public.players p join public.games g on g.id = p.game_id
      where p.id = ${req.playerId} and p.game_id = ${req.gameId}`;
    if (!seat || seat.token_hash !== (await sha256Hex(req.token))) return refuse('FORBIDDEN', 'You are not a player in this game.');
    if (seat.player_status === 'LEFT') return refuse('FORBIDDEN', 'You have left this game.');
    if (seat.game_status !== 'ACTIVE' && seat.game_status !== 'PAUSED') return refuse('GAME_NOT_ACTIVE', 'Reactions are for a game in play.');

    // One statement claims the slot: of two requests racing for it, the second waits for the first's
    // row lock, re-checks against the time it wrote and finds nothing to update.
    const cooldownSeconds = QUICK_CHAT_COOLDOWN_MS / 1000;
    const [claimed] = await deps.sql`
      update public.players set last_chat_at = now()
      where id = ${req.playerId} and game_id = ${req.gameId}
        and (last_chat_at is null or last_chat_at <= now() - make_interval(secs => ${cooldownSeconds}))
      returning last_chat_at`;
    if (!claimed) {
      const [left] = await deps.sql`
        select ceil(extract(epoch from (last_chat_at + make_interval(secs => ${cooldownSeconds}) - now())) * 1000)::int as ms
        from public.players where id = ${req.playerId}`;
      const retryAfterMs = Math.min(QUICK_CHAT_COOLDOWN_MS, Math.max(0, Number(left?.ms ?? QUICK_CHAT_COOLDOWN_MS)));
      return refuse('COOLDOWN', 'One at a time. Try again in a moment.', 200, retryAfterMs);
    }

    const at = claimed.last_chat_at instanceof Date ? claimed.last_chat_at.toISOString() : String(claimed.last_chat_at);
    const event = { v: QUICK_CHAT_VERSION, id: req.eventId, gameId: req.gameId, playerId: req.playerId, kind: req.kind, key: req.key, at } as QuickChatEvent;
    if (deps.broadcastChat) {
      try {
        await deps.broadcastChat(req.gameId, event);
      } catch (error) {
        // Nothing to undo and nothing to retry for the player: it simply was not sent.
        console.error('chat broadcast failed', error);
        return refuse('UNAVAILABLE', 'That could not be sent. The game carries on.');
      }
    }
    return { status: 200, body: { ok: true, event } };
  } catch (error) {
    console.error('quick chat failed', error);
    return refuse('SERVER_ERROR', 'That could not be sent. The game carries on.', 500);
  }
}
