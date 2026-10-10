// Supabase Edge Function entry point (Deno).
// Deploy: npm run deploy:functions   (verify_jwt is off at the gateway — the handler verifies the
// caller's token itself with Supabase Auth, which works with both legacy and signing-key JWTs).
import { handleDeleteAccount, type AuthUser } from './handler.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Supabase Auth decides whether the token is valid (signature, expiry, session and user still exist). */
async function verifyUser(accessToken: string, apiKey: string): Promise<AuthUser | null> {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`auth user ${res.status}: ${await res.text()}`);
  const user = (await res.json()) as { id?: unknown; last_sign_in_at?: unknown; identities?: { provider?: unknown }[] | null };
  if (typeof user.id !== 'string') return null;
  return {
    id: user.id,
    hasGoogle: (user.identities ?? []).some((identity) => identity.provider === 'google'),
    lastSignInAt: typeof user.last_sign_in_at === 'string' ? user.last_sign_in_at : null,
  };
}

/** The service key never leaves the server. */
async function deleteUser(userId: string): Promise<'deleted' | 'not_found'> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ should_soft_delete: false }),
  });
  if (res.status === 404) return 'not_found';
  if (!res.ok) throw new Error(`admin delete ${res.status}: ${await res.text()}`);
  return 'deleted';
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
  const result = await handleDeleteAccount(req.headers.get('Authorization'), body, {
    verifyUser: (token) => verifyUser(token, apiKey),
    deleteUser,
  });
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
