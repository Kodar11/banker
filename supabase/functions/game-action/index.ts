// Supabase Edge Function entry point (Deno).
// Deploy: npm run deploy:functions   (syncs src/engine first; verify_jwt is off — players
// authenticate with their per-device token, see handler.ts).
import { createSql } from './db.ts';
import { handleRequest } from './handler.ts';
import { handleQuickChat } from './quickChat.ts';
import { QUICK_CHAT_EVENT, realtimeTopic, type QuickChatEvent, type StateBroadcast } from '../_shared/engine/index.ts';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');

const sql = createSql(dbUrl);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

const broadcast = (gameId: string, payload: StateBroadcast) => send(gameId, 'state', payload);
/** A reaction or preset message: the same topic, its own event, and no state behind it. */
const broadcastChat = (gameId: string, event: QuickChatEvent) => send(gameId, QUICK_CHAT_EVENT, event);

// Supabase Edge Runtime global: keeps the worker alive until the promise settles.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Runs `task` after the response has been sent (the auction close timer: a few seconds; the end-game vote timer: half a minute). */
function defer(delayMs: number, task: () => Promise<void>): void {
  const run = new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(task);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(run);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const isChat = typeof body === 'object' && body !== null && (body as { op?: unknown }).op === 'chat';
  const result = isChat ? await handleQuickChat(body, { sql, broadcastChat }) : await handleRequest(body, { sql, broadcast, defer });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
