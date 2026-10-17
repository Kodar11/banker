// Supabase Edge Function entry point (Deno).
// Deploy: npm run deploy:functions   (syncs src/engine first; verify_jwt is off — players
// authenticate with their per-device token, see handler.ts).
import { createSql } from './db.ts';
import { handleRequest } from './handler.ts';
import { handleQuickChat } from './quickChat.ts';
import { broadcast, broadcastChat, defer } from './runtime.ts';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');

const sql = createSql(dbUrl);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
