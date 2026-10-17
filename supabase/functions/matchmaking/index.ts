// Supabase Edge Function entry point (Deno): the matchmaking worker.
// Deploy: npm run deploy:functions   (syncs src/engine first).
//
// verify_jwt is off at the gateway because the two legitimate callers are told apart here, by the
// handler (see handler.ts, handleMatchmakingRequest) — it is NOT unauthenticated:
//   - the scheduler sends the server-only worker secret (function secret MATCHMAKING_WORKER_SECRET,
//     the same value pg_cron reads from Vault as matchmaking_tick_secret). It has no user token,
//     which is why the gateway check cannot be the one that lets it in;
//   - a searching phone sends its player's access token, verified with Supabase Auth exactly as
//     delete-account does (works with legacy and signing-key JWTs).
// Everybody else gets 401/403 before the database is asked to do any matchmaking work.
//
// Secrets (supabase secrets set NAME=value): MATCHMAKING_WORKER_SECRET — at least 32 characters,
// random, server-only. It never goes into the app or any EXPO_PUBLIC_* variable.
import { createSql } from '../game-action/db.ts';
import { startBotRunner } from '../game-action/handler.ts';
import { broadcast, defer } from '../game-action/runtime.ts';
import { handleMatchmakingRequest, MIN_WORKER_SECRET_LENGTH, WORKER_SECRET_HEADER } from './handler.ts';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const workerSecret = Deno.env.get('MATCHMAKING_WORKER_SECRET') ?? null;
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');
if (!workerSecret || workerSecret.length < MIN_WORKER_SECRET_LENGTH) {
  console.error('matchmaking: MATCHMAKING_WORKER_SECRET is missing or too short; scheduled ticks are refused (players can still nudge the worker)');
}

const sql = createSql(dbUrl);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Supabase Auth decides whether the token is valid (signature, expiry, session and user still exist). */
async function verifyUser(accessToken: string, apiKey: string): Promise<{ id: string } | null> {
  if (!supabaseUrl) throw new Error('SUPABASE_URL is not set');
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`auth user ${res.status}`);
  const user = (await res.json()) as { id?: unknown };
  return typeof user.id === 'string' ? { id: user.id } : null;
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
  const apiKey = anonKey ?? req.headers.get('apikey') ?? '';
  const result = await handleMatchmakingRequest(
    body,
    // A game started with bot seats gets its bot runner at once: the game-action function's own runner,
    // broadcast and timers, run in this worker's background.
    { sql, workerSecret, verifyUser: (token) => verifyUser(token, apiKey), startBots: (gameId) => startBotRunner({ sql, broadcast, defer }, gameId) },
    { authorization: req.headers.get('Authorization'), workerSecret: req.headers.get(WORKER_SECRET_HEADER) },
  );
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...CORS, ...(result.headers ?? {}), 'Content-Type': 'application/json' } });
});
