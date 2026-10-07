import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { POLL_MS_DEGRADED } from '@/constants/app';
import type { StateBroadcast } from '@/engine/index.ts';
import { gameApi, type Credentials } from '@/lib/gameApi';
import { subscribeToGame, type ChannelHealth, type GameChannelHandlers } from '@/lib/realtime';
import { syncLog, syncStats } from '@/lib/syncStats';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

const inFlight = new Map<string, Promise<void>>();

/** Fetches authoritative state from the server and reconciles the store. Coalesces concurrent calls. */
export function refreshGame(credentials: Credentials): Promise<void> {
  const key = credentials.gameId;
  const existing = inFlight.get(key);
  if (existing) return existing;
  syncStats.refreshes += 1;
  syncLog('refresh', key);
  const run = (async () => {
    const res = await gameApi.state(credentials);
    const store = useGameStore.getState();
    if (store.gameId !== credentials.gameId) return;
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

export interface SyncDeps {
  refresh: () => Promise<void>;
  localVersion: () => number;
  subscribe: (handlers: GameChannelHandlers) => () => void;
  setHealth: (health: ChannelHealth) => void;
  setOnline: (ids: string[]) => void;
  appState: {
    current: () => AppStateStatus;
    onChange: (cb: (next: AppStateStatus) => void) => { remove: () => void };
  };
  pollMs?: number;
}

/**
 * Sync lifecycle for one game (one instance per game per device):
 *
 *  PRIMARY    realtime broadcast → refetch ONLY when the broadcast version is
 *             ahead of the local snapshot (equal/older pings are ignored).
 *  SECONDARY  realtime reconnect (live again after being down) → one refetch.
 *  SECONDARY  app returns to the foreground from background → one refetch.
 *  FALLBACK   polling runs ONLY while realtime is not live, and stops as soon
 *             as it is live again. A healthy idle connection does no work.
 *
 * Plus one initial fetch, and one reconcile when the channel first goes live
 * (covers changes made between the initial fetch and the subscription).
 */
export function startGameSync(deps: SyncDeps): () => void {
  const pollMs = deps.pollMs ?? POLL_MS_DEGRADED;
  let stopped = false;
  let everLive = false;
  let wasDown = false;
  let live = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Highest server version announced over realtime. */
  let wanted = 0;
  let chasing = false;
  let lastAppState = deps.appState.current();

  /** Refetch until the local snapshot has caught up with `wanted` (bounded). */
  const catchUp = async () => {
    if (chasing) return;
    chasing = true;
    try {
      for (let i = 0; i < 3 && !stopped; i += 1) {
        await deps.refresh();
        if (deps.localVersion() >= wanted) break;
      }
    } finally {
      chasing = false;
    }
  };

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (pollTimer || stopped || live) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (stopped || live) return;
      if (deps.appState.current() === 'active') {
        syncStats.pollTicks += 1;
        syncLog('poll tick');
        await deps.refresh();
      }
      startPolling();
    }, pollMs);
  };

  void deps.refresh();

  const unsubscribe = deps.subscribe({
    onState: (payload: StateBroadcast) => {
      if (payload.version <= deps.localVersion()) return;
      wanted = Math.max(wanted, payload.version);
      void catchUp();
    },
    onPresence: deps.setOnline,
    onHealth: (health) => {
      deps.setHealth(health);
      if (health === 'live') {
        live = true;
        stopPolling();
        if (!everLive || wasDown) void deps.refresh();
        everLive = true;
        wasDown = false;
        return;
      }
      live = false;
      if (health === 'down') wasDown = true;
      startPolling();
    },
  });

  const appSub = deps.appState.onChange((next) => {
    const prev = lastAppState;
    lastAppState = next;
    if (next === 'active' && prev !== 'active') void deps.refresh();
  });

  return () => {
    stopped = true;
    stopPolling();
    unsubscribe();
    appSub.remove();
  };
}

/** Keeps the store in sync with the server for one game. */
export function useGameSync(credentials: Credentials | null): void {
  const gameId = credentials?.gameId;
  const playerId = credentials?.playerId;
  const token = credentials?.token;

  useEffect(() => {
    if (!gameId || !playerId || !token) return;
    const creds = { gameId, playerId, token };
    const store = useGameStore.getState();
    if (store.gameId !== gameId) store.reset(gameId);
    return startGameSync({
      refresh: () => refreshGame(creds),
      localVersion: () => useGameStore.getState().snapshot?.state.version ?? 0,
      subscribe: (handlers) => subscribeToGame(gameId, playerId, handlers),
      setHealth: (health) => {
        const s = useGameStore.getState();
        if (health === 'live') s.setConnection('live');
        else if (health === 'connecting') s.setConnection(s.snapshot ? 'reconnecting' : 'connecting');
        else s.setConnection('reconnecting');
      },
      setOnline: (ids) => useGameStore.getState().setOnline(ids),
      appState: {
        current: () => AppState.currentState,
        onChange: (cb) => AppState.addEventListener('change', cb),
      },
    });
  }, [gameId, playerId, token]);
}

/** Mounted once in the root layout: the ONLY place that syncs, whichever screen is open. */
export function GameSyncHost(): null {
  const session = useSessionStore((s) => s.session);
  useGameSync(session);
  return null;
}
