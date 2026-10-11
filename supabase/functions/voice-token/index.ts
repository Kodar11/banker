// Supabase Edge Function entry point (Deno): voice chat tokens for private rooms.
// Deploy: npm run deploy:functions   (syncs src/engine first; verify_jwt is off — players
// authenticate with their per-device token, exactly as for game-action; see handler.ts).
//
// Secrets (supabase secrets set NAME=value): AGORA_APP_ID, AGORA_APP_CERTIFICATE.
// The certificate is read here, handed to the signer, and goes nowhere else.
import { createSql } from '../game-action/db.ts';
import { realtimeTopic, VOICE_EVENT } from '../_shared/engine/index.ts';
import { createTokenBuilder } from './agora.ts';
import { handleVoiceRequest } from './handler.ts';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');

const sql = createSql(dbUrl);
const buildToken = createTokenBuilder(Deno.env.get('AGORA_APP_ID'), Deno.env.get('AGORA_APP_CERTIFICATE'));
if (!buildToken) console.error('voice-token: AGORA_APP_ID / AGORA_APP_CERTIFICATE are missing or malformed; voice is unavailable');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Server-side broadcast via the Realtime REST API (service key never leaves the server). */
async function broadcastVoice(gameId: string, payload: unknown): Promise<void> {
  if (!supabaseUrl || !serviceKey) return;
  const res = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ messages: [{ topic: realtimeTopic(gameId), event: VOICE_EVENT, payload, private: false }] }),
  });
  if (!res.ok) throw new Error(`broadcast ${res.status}`);
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
  const result = await handleVoiceRequest(body, { sql, buildToken, broadcastVoice });
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
