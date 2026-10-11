// Supabase Edge Function entry point (Deno): the matchmaking worker.
// Deploy: npm run deploy:functions   (syncs src/engine first).
//
// verify_jwt is off at the gateway because the caller's identity is never used: the only operation
// is "run a tick", it takes no input, and what a tick does is decided entirely by the database
// (who is queued, who is ready, how often a run may happen — see matchmaking_candidates). A caller
// can make the worker look; it cannot make it do anything for or to a particular player.
import { createSql } from '../game-action/db.ts';
import { handleMatchmakingRequest } from './handler.ts';

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
  const result = await handleMatchmakingRequest(body, { sql });
  // The report is counts only; the app ignores it and reads its own state from the database.
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
