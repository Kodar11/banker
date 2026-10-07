import { useEffect } from 'react';
import { AppState } from 'react-native';
import { POLL_MS_DEGRADED, POLL_MS_LIVE } from '@/constants/app';
import { gameApi, type Credentials } from '@/lib/gameApi';
import { subscribeToGame } from '@/lib/realtime';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

const inFlight = new Map<string, Promise<void>>();

/** Fetches authoritative state from the server and reconciles the store. Coalesces concurrent calls. */
export function refreshGame(credentials: Credentials): Promise<void> {
  const key = credentials.gameId;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const store = useGameStore.getState();
    const res = await gameApi.state(credentials);
    if (useGameStore.getState().gameId !== credentials.gameId) return;
    if (res.ok) {
      store.applySnapshot(res.snapshot);
      if (store.connection === 'offline') store.setConnection('reconnecting');
    } else if (res.error.code === 'NETWORK' || res.error.code === 'TIMEOUT') {
      store.setConnection('offline');
    } else {
      store.setLoadError(res.error);
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * Keeps the store in sync with the server for one game:
 *  - initial fetch,
 *  - realtime broadcast pings → refetch when the version moved,
 *  - on (re)subscribe → refetch (reconcile after reconnect),
 *  - app returns to foreground → refetch,
 *  - safety-net polling (faster while realtime is down).
 */
export function useGameSync(credentials: Credentials | null): void {
  const gameId = credentials?.gameId;
  const playerId = credentials?.playerId;
  const token = credentials?.token;

  useEffect(() => {
    if (!gameId || !playerId || !token) return;
    const creds = { gameId, playerId, token };
    const store = useGameStore.getState();
    if (store.gameId !== gameId) store.reset(gameId);

    let cancelled = false;
    void refreshGame(creds);

    const unsubscribe = subscribeToGame(gameId, playerId, {
      onState: (payload) => {
        const local = useGameStore.getState().snapshot?.state.version ?? 0;
        if (payload.version > local) void refreshGame(creds);
      },
      onPresence: (ids) => useGameStore.getState().setOnline(ids),
      onHealth: (health) => {
        const s = useGameStore.getState();
        if (health === 'live') {
          s.setConnection('live');
          void refreshGame(creds); // reconcile anything missed while disconnected
        } else if (health === 'connecting') {
          if (s.connection !== 'live') s.setConnection(s.snapshot ? 'reconnecting' : 'connecting');
        } else {
          s.setConnection('reconnecting');
        }
      },
    });

    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      const live = useGameStore.getState().connection === 'live';
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (AppState.currentState === 'active') await refreshGame(creds);
        poll();
      }, live ? POLL_MS_LIVE : POLL_MS_DEGRADED);
    };
    poll();

    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshGame(creds);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
      appSub.remove();
    };
  }, [gameId, playerId, token]);
}

/** Mounted once in the root layout: syncs whichever game this device is in. */
export function GameSyncHost(): null {
  const session = useSessionStore((s) => s.session);
  useGameSync(session);
  return null;
}
