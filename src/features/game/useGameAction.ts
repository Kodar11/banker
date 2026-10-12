import { useCallback } from 'react';
import type { GameAction } from '@/engine/index.ts';
import { newActionId } from '@/lib/device';
import { gameApi, isRetryable, type ApiError, type Credentials } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { haptics } from '@/utils/haptics';
import { refreshGame } from './sync';

const MAX_ATTEMPTS = 3;
/** Wait before the next attempt with the same action id: this long, then twice this long. */
export const RETRY_DELAY_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendOptions {
  /** Don't show error toasts (e.g. automatic auction close). */
  silent?: boolean;
  /** Toast shown after the server accepts the action. */
  successMessage?: string;
  /**
   * What to tell the player when the action was refused because the game had moved on (STALE_STATE).
   * Called after the server's state has been read again, so it can say what the game looks like now;
   * null keeps the server's own message.
   */
  staleMessage?: () => string | null;
}

/** `unknown`: every attempt was lost on the way, so the server may or may not have carried the action out. */
export type SendResult = { ok: true } | { ok: false; error: ApiError; unknown?: boolean };

const UNKNOWN_SYNCED = 'The connection dropped while sending. The game is up to date again. Check it before you try again.';
const STILL_UNKNOWN = 'Still reconnecting. Your last action may have gone through. Wait for the game to update.';
const LEFT: SendResult = { ok: false, error: { code: 'NETWORK', message: 'You left that game.' } };

/**
 * Reads the server's state after an action whose outcome is unknown. Always a request of its own
 * (never one that was already on its way before the action was sent), so a success really is the
 * game as it stands after whatever the server did with that action. Returns true when the screen
 * can be trusted again.
 */
async function reconcile(credentials: Credentials): Promise<boolean> {
  const res = await gameApi.state(credentials);
  const store = useGameStore.getState();
  if (store.gameId !== credentials.gameId) return false;
  // No answer at all counts as no connection: the screen is trusted only on a real answer.
  if (!res) {
    store.setConnection('offline');
    return false;
  }
  if (res.ok) {
    store.applySnapshot(res.snapshot);
    store.setOutcomeUnknown(false);
    if (store.connection === 'offline') store.setConnection('reconnecting');
    return true;
  }
  if (isRetryable(res.error)) store.setConnection('offline');
  // The seat or the game is gone (session ended, game expired): the screen shows that, as for any refresh.
  else store.setLoadError(res.error);
  return false;
}

/**
 * Sends a player intent to the referee.
 * - One action id per tap; network retries reuse it, so the server applies it at most once.
 * - Double taps are ignored while an action is in flight.
 * - Stale state → refetch and tell the player to look again.
 * - Outcome unknown (every attempt timed out or lost the connection): the action is NOT reported as
 *   failed and safe to repeat. The server's state is read again; until that has succeeded nothing
 *   else is sent, so a second tap can never be a second execution of something that did go through.
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
      let expectedVersion = snapshot.state.version;
      // An earlier action's outcome is still unknown: nothing more is sent on top of a screen that
      // may be behind the server. Read the game first; if that is not possible either, send nothing.
      if (store.outcomeUnknown) {
        const synced = await reconcile(session);
        const now = useGameStore.getState();
        if (now.gameId !== session.gameId) return LEFT;
        if (!synced) {
          now.setPending(null);
          if (!options.silent) {
            haptics.error();
            now.notify('error', STILL_UNKNOWN);
          }
          return { ok: false, error: { code: 'NETWORK', message: STILL_UNKNOWN }, unknown: true };
        }
        expectedVersion = now.snapshot?.state.version ?? expectedVersion;
      }
      const actionId = newActionId();
      let res = await gameApi.action(session, actionId, expectedVersion, action);
      for (let attempt = 1; attempt < MAX_ATTEMPTS && !res.ok && isRetryable(res.error); attempt += 1) {
        useGameStore.getState().setConnection('reconnecting');
        await sleep(RETRY_DELAY_MS * attempt);
        res = await gameApi.action(session, actionId, expectedVersion, action);
      }
      // Left this game while the request was in flight: its outcome belongs to no screen any more.
      if (useGameStore.getState().gameId !== session.gameId) return LEFT;

      // Every attempt was lost: the server may have carried the action out. Not a plain failure:
      // find out what the game looks like now, and hold further actions until that is known.
      if (!res.ok && isRetryable(res.error)) {
        useGameStore.getState().setOutcomeUnknown(true);
        const synced = await reconcile(session);
        const now = useGameStore.getState();
        if (now.gameId !== session.gameId) return LEFT;
        now.setPending(null);
        if (!options.silent) {
          haptics.error();
          // Still offline: the message the player has always seen. Back in sync: say what to do next.
          now.notify(synced ? 'info' : 'error', synced ? UNKNOWN_SYNCED : res.error.message);
        }
        return { ok: false, error: res.error, unknown: true };
      }
      useGameStore.getState().setPending(null);

      if (res.ok) {
        useGameStore.getState().applySnapshot(res.snapshot);
        if (useGameStore.getState().connection !== 'live') useGameStore.getState().setConnection('reconnecting');
        haptics.success();
        if (options.successMessage) useGameStore.getState().notify('success', options.successMessage);
        return { ok: true };
      }

      const stale = res.error.code === 'STALE_STATE';
      if (stale) {
        await refreshGame(session);
        // Left this game while it was being read again: nothing of it is reported any more.
        if (useGameStore.getState().gameId !== session.gameId) return LEFT;
      }
      if (!options.silent) {
        haptics.error();
        useGameStore.getState().notify(stale ? 'info' : 'error', (stale && options.staleMessage?.()) || res.error.message);
      }
      return { ok: false, error: res.error };
    },
    [session],
  );
}

/** Why a send() did not go through, or null when it did. For dialogs that stay open to retry. */
export function sendFailure(result: unknown): string | null {
  const r = result as SendResult | undefined;
  return r && r.ok === false ? r.error.message : null;
}
