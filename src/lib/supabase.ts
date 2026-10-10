import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { installCryptoPolyfill } from './cryptoPolyfill';
import { secureSessionStorage } from './secureSessionStorage';

/**
 * The app's one Supabase client, using the PUBLISHABLE key only. It is used for:
 *   1. calling the `game-action` Edge Function (the referee),
 *   2. Realtime broadcast/presence on `game:<id>` topics, and
 *   3. the player's account: Supabase Auth (guest or Google-linked), the profile functions and
 *      the `delete-account` Edge Function (src/lib/accountApi.ts).
 * The app never writes tables directly, and reads only its own profile row (RLS).
 *
 * The Auth session lives in the platform keystore (secureSessionStorage). Token refresh is
 * started and stopped with the app's foreground state by AccountHost.
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

export const AUTH_STORAGE_KEY = 'business-banker.auth.v1';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!url || !key) {
    throw new Error('Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY in .env');
  }
  if (!client) {
    installCryptoPolyfill();
    client = createClient(url, key, {
      auth: {
        storage: secureSessionStorage,
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // There is no page URL in a native app; the OAuth redirect is handled in accountApi.
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return client;
}
