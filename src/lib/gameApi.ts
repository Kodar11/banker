import { FunctionsHttpError } from '@supabase/supabase-js';
import type { ApiRequest, ApiResponse, GameAction, GameConfig, GameMode, QuickChatItem, QuickChatResponse } from '@/engine/index.ts';
import { localAction, localState } from '@/features/solo/localGame';
import { recordServerTime } from './serverClock';
import { getSupabase } from './supabase';

export const FUNCTION_NAME = 'game-action';
const TIMEOUT_MS = 12_000;

export type ApiError = Extract<ApiResponse, { ok: false }>['error'];

export type TransportFailure = { ok: false; error: { code: 'SERVER_ERROR' | 'NETWORK' | 'TIMEOUT'; message: string } };

/** One POST to an Edge Function (the referee unless another is named). Never throws: a transport problem comes back as a failure of the same shape the server uses. */
export async function invoke<T extends { ok: boolean }>(
  body: object,
  onResponse?: (data: T, sentAt: number, receivedAt: number) => void,
  functionName: string = FUNCTION_NAME,
): Promise<T | TransportFailure> {
  try {
    const sentAt = Date.now();
    const { data, error } = await getSupabase().functions.invoke<T>(functionName, {
      body,
      timeout: TIMEOUT_MS,
    });
    const receivedAt = Date.now();
    if (error) {
      if (error instanceof FunctionsHttpError) {
        try {
          const parsed = (await error.context.json()) as T;
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
    onResponse?.(data, sentAt, receivedAt);
    return data;
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Connection lost. Reconnecting…' } };
  }
}

/** Thin, typed wrapper around the referee Edge Function. Never throws. */
export function callGameApi(body: ApiRequest): Promise<ApiResponse> {
  return invoke<ApiResponse>(body, (data, sentAt, receivedAt) => {
    if (data.ok) recordServerTime(data.snapshot.serverTime, sentAt, receivedAt);
  });
}

export interface Credentials {
  gameId: string;
  playerId: string;
  token: string;
  /** A solo game against bots, played on this device only (features/solo/localGame.ts): never sent to any server. */
  local?: boolean;
}

export const gameApi = {
  /**
   * `mode` is the host's choice of ruleset for the whole game. Leaving it out creates a Classic game, with the request Classic has always sent.
   * `config` is the host's settings; leaving it out means the mode's defaults. The server validates it and has the last word.
   */
  create: (actionId: string, token: string, name: string, mode?: GameMode, config?: GameConfig) =>
    callGameApi({ op: 'create', actionId, token, name, ...(mode && mode !== 'classic' ? { mode } : {}), ...(config ? { config } : {}) }),
  join: (actionId: string, token: string, code: string, name: string) => callGameApi({ op: 'join', actionId, token, code, name }),
  state: (c: Credentials) => (c.local ? Promise.resolve(localState(c)) : callGameApi({ op: 'state', gameId: c.gameId, playerId: c.playerId, token: c.token })),
  action: (c: Credentials, actionId: string, expectedVersion: number, action: GameAction) =>
    c.local ? Promise.resolve(localAction(c, actionId, expectedVersion, action)) : callGameApi({ op: 'action', gameId: c.gameId, playerId: c.playerId, token: c.token, actionId, expectedVersion, action }),
  /** A quick reaction or preset message to everyone in the game. Not a game action: no version, no snapshot, never retried. */
  chat: (c: Credentials, eventId: string, item: QuickChatItem) =>
    c.local
      ? Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: 'Quick chat is for games with other people.' } } as unknown as QuickChatResponse)
      : invoke<QuickChatResponse>({ op: 'chat', gameId: c.gameId, playerId: c.playerId, token: c.token, eventId, kind: item.kind, key: item.key }),
};

/** Errors where resending the SAME action id is safe and useful. */
export function isRetryable(error: ApiError): boolean {
  return error.code === 'NETWORK' || error.code === 'TIMEOUT';
}
