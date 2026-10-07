import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client using the PUBLISHABLE key only. It is used for two things:
 *   1. calling the `game-action` Edge Function (the referee), and
 *   2. Realtime broadcast/presence on `game:<id>` topics.
 * The app never reads or writes tables directly (RLS denies it anyway).
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!url || !key) {
    throw new Error('Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY in .env');
  }
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return client;
}
