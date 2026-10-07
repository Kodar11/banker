import { useCallback } from 'react';
import type { GameAction } from '@/engine/index.ts';
import { newActionId } from '@/lib/device';
import { gameApi, isRetryable, type ApiError } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { haptics } from '@/utils/haptics';
import { refreshGame } from './sync';

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendOptions {
  /** Don't show error toasts (e.g. automatic auction close). */
  silent?: boolean;
  /** Toast shown after the server accepts the action. */
  successMessage?: string;
}

export type SendResult = { ok: true } | { ok: false; error: ApiError };

/**
 * Sends a player intent to the referee.
 * - One action id per tap; network retries reuse it, so the server applies it at most once.
 * - Double taps are ignored while an action is in flight.
 * - Stale state → refetch and tell the player to look again.
 */
export function useGameAction() {
  const session = useSessionStore((s) => s.session);

  return useCallback(
    async (action: GameAction, options: SendOptions = {}): Promise<SendResult> => {
      const store = useGameStore.getState();
      const snapshot = store.snapshot;
      if (!session || !snapshot) return { ok: false, error: { code: 'NETWORK', message: 'Not connected yet.' } };
      if (store.pendingAction) return { ok: false, error: { code: 'VALIDATION', message: 'Hold on…' } };

      store.setPending(action.type);
      haptics.tap();
      const actionId = newActionId();
      let res = await gameApi.action(session, actionId, snapshot.state.version, action);
      for (let attempt = 1; attempt < MAX_ATTEMPTS && !res.ok && isRetryable(res.error); attempt += 1) {
        useGameStore.getState().setConnection('reconnecting');
        await sleep(700 * attempt);
        res = await gameApi.action(session, actionId, snapshot.state.version, action);
      }
      useGameStore.getState().setPending(null);

      if (res.ok) {
        useGameStore.getState().applySnapshot(res.snapshot);
        if (useGameStore.getState().connection !== 'live') useGameStore.getState().setConnection('reconnecting');
        haptics.success();
        if (options.successMessage) useGameStore.getState().notify('success', options.successMessage);
        return { ok: true };
      }

      if (res.error.code === 'STALE_STATE') {
        await refreshGame(session);
      } else if (isRetryable(res.error)) {
        useGameStore.getState().setConnection('offline');
      }
      if (!options.silent) {
        haptics.error();
        useGameStore.getState().notify(res.error.code === 'STALE_STATE' ? 'info' : 'error', res.error.message);
      }
      return { ok: false, error: res.error };
    },
    [session],
  );
}
