// Edge runtime helpers shared by the Deno entry points (game-action, matchmaking): the realtime broadcast and
// the deferred task runner. Deno-only (Deno.env, EdgeRuntime); the handlers stay runtime-agnostic and get
// these passed in as dependencies.
import { QUICK_CHAT_EVENT, realtimeTopic, type QuickChatEvent, type StateBroadcast } from '../_shared/engine/index.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

/** Server-side broadcast via the Realtime REST API (service key never leaves the server). */
async function send(gameId: string, event: string, payload: unknown): Promise<void> {
  if (!supabaseUrl || !serviceKey) return;
  const res = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ messages: [{ topic: realtimeTopic(gameId), event, payload, private: false }] }),
  });
  if (!res.ok) throw new Error(`broadcast ${res.status}: ${await res.text()}`);
}

export const broadcast = (gameId: string, payload: StateBroadcast) => send(gameId, 'state', payload);
/** A reaction or preset message: the same topic, its own event, and no state behind it. */
export const broadcastChat = (gameId: string, event: QuickChatEvent) => send(gameId, QUICK_CHAT_EVENT, event);

// Supabase Edge Runtime global: keeps the worker alive until the promise settles.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Runs `task` after the response has been sent (auction and vote close timers, the bot runner). */
export function defer(delayMs: number, task: () => Promise<void>): void {
  const run = new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(task);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(run);
}
