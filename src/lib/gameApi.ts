import { FunctionsHttpError } from '@supabase/supabase-js';
import type { ApiRequest, ApiResponse, GameAction, GameConfig, GameMode } from '@/engine/index.ts';
import { recordServerTime } from './serverClock';
import { getSupabase } from './supabase';

export const FUNCTION_NAME = 'game-action';
const TIMEOUT_MS = 12_000;

export type ApiError = Extract<ApiResponse, { ok: false }>['error'];

/** Thin, typed wrapper around the referee Edge Function. Never throws. */
export async function callGameApi(body: ApiRequest): Promise<ApiResponse> {
  try {
    const sentAt = Date.now();
    const { data, error } = await getSupabase().functions.invoke<ApiResponse>(FUNCTION_NAME, {
      body,
      timeout: TIMEOUT_MS,
    });
    const receivedAt = Date.now();
    if (error) {
      if (error instanceof FunctionsHttpError) {
        try {
          const parsed = (await error.context.json()) as ApiResponse;
          if (parsed && parsed.ok === false) return parsed;
        } catch {
          // fall through
        }
        return { ok: false, error: { code: 'SERVER_ERROR', message: 'The game server had a problem. Try again.' } };
      }
      const timedOut = /abort|timeout/i.test(String(error.message ?? error));
      return {
        ok: false,
        error: timedOut
          ? { code: 'TIMEOUT', message: 'The server is taking too long. Check your connection.' }
          : { code: 'NETWORK', message: 'Connection lost. Reconnecting…' },
      };
    }
    if (!data) return { ok: false, error: { code: 'SERVER_ERROR', message: 'Empty response from the server.' } };
    if (data.ok) recordServerTime(data.snapshot.serverTime, sentAt, receivedAt);
    return data;
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Connection lost. Reconnecting…' } };
  }
}

export interface Credentials {
  gameId: string;
  playerId: string;
  token: string;
}

export const gameApi = {
  /**
   * `mode` is the host's choice of ruleset for the whole game. Leaving it out creates a Classic game, with the request Classic has always sent.
   * `config` is the host's settings; leaving it out means the mode's defaults. The server validates it and has the last word.
   */
  create: (actionId: string, token: string, name: string, mode?: GameMode, config?: GameConfig) =>
    callGameApi({ op: 'create', actionId, token, name, ...(mode && mode !== 'classic' ? { mode } : {}), ...(config ? { config } : {}) }),
  join: (actionId: string, token: string, code: string, name: string) => callGameApi({ op: 'join', actionId, token, code, name }),
  state: (c: Credentials) => callGameApi({ op: 'state', gameId: c.gameId, playerId: c.playerId, token: c.token }),
  action: (c: Credentials, actionId: string, expectedVersion: number, action: GameAction) =>
    callGameApi({ op: 'action', gameId: c.gameId, playerId: c.playerId, token: c.token, actionId, expectedVersion, action }),
};

/** Errors where resending the SAME action id is safe and useful. */
export function isRetryable(error: ApiError): boolean {
  return error.code === 'NETWORK' || error.code === 'TIMEOUT';
}
