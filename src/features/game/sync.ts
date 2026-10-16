import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { POLL_MS_DEGRADED } from '@/constants/app';
import type { GameState, StateBroadcast } from '@/engine/index.ts';
import { subscribeLocal } from '@/features/solo/localGame';
import { clearQuickChat, receiveQuickChat } from '@/features/quickChat/quickChatStore';
import { voice } from '@/features/voice/voice';
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
  /** Quick reactions and messages ride the same channel; they never touch the snapshot or trigger a refetch. */
  onChat?: (payload: unknown) => void;
  /** The room's voice setting changed (same channel, nothing to do with the snapshot). */
  onVoice?: () => void;
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
    onChat: (payload) => {
      if (!stopped) deps.onChat?.(payload);
    },
    onVoice: () => {
      if (!stopped) deps.onVoice?.();
    },
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
  const local = credentials?.local === true;

  useEffect(() => {
    if (!gameId || !playerId || !token) return;
    const creds = { gameId, playerId, token, local };
    const store = useGameStore.getState();
    if (store.gameId !== gameId) store.reset(gameId);
    const stop = startGameSync({
      refresh: () => refreshGame(creds),
      localVersion: () => useGameStore.getState().snapshot?.state.version ?? 0,
      // A solo game is on this device: its "realtime" is the local game itself, always live.
      subscribe: (handlers) => (local ? subscribeToLocal(gameId, handlers) : subscribeToGame(gameId, playerId, handlers)),
      setHealth: (health) => {
        const s = useGameStore.getState();
        if (health === 'live') s.setConnection('live');
        else if (health === 'connecting') s.setConnection(s.snapshot ? 'reconnecting' : 'connecting');
        else s.setConnection('reconnecting');
      },
      setOnline: (ids) => useGameStore.getState().setOnline(ids),
      onChat: (payload) => receiveQuickChat(gameId, payload),
      onVoice: () => void voice.refreshRoom(),
      appState: {
        current: () => AppState.currentState,
        onChange: (cb) => AppState.addEventListener('change', cb),
      },
    });
    return () => {
      stop();
      // Nothing of this game's chatter may show up in the next one.
      clearQuickChat();
    };
  }, [gameId, playerId, token, local]);

  useBotWatchdog(gameId && playerId && token && !local ? { gameId, playerId, token } : null);
}

function subscribeToLocal(gameId: string, handlers: GameChannelHandlers): () => void {
  handlers.onHealth('live');
  return subscribeLocal(gameId, handlers.onState);
}

/** How long an online game with bots may sit unchanged, with a bot to move, before this phone reads it again. */
export const BOT_WATCHDOG_MS = 6000;

/**
 * Online games with bots: the server plays the bots, triggered by every committed action. If such a trigger
 * is ever lost (an instance restarted), the game would wait. So while a bot may be the one to move and
 * nothing has changed for a while, this phone reads the game again — and the server, seeing an idle game
 * with a bot due, starts its bot runner. The phone never decides or sends anything for a bot.
 */
function useBotWatchdog(credentials: Credentials | null): void {
  const gameId = credentials?.gameId;
  const playerId = credentials?.playerId;
  const token = credentials?.token;
  useEffect(() => {
    if (!gameId || !playerId || !token) return;
    let version = -1;
    let since = Date.now();
    const timer = setInterval(() => {
      const state = useGameStore.getState().snapshot?.state;
      if (!state || state.id !== gameId) return;
      if (state.version !== version) {
        version = state.version;
        since = Date.now();
        return;
      }
      if (Date.now() - since >= BOT_WATCHDOG_MS && botMayBeDue(state)) {
        since = Date.now();
        void refreshGame({ gameId, playerId, token });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [gameId, playerId, token]);
}

/** A bot could be the one the game is waiting on (its turn, an auction, a vote, an offer made to it). */
export function botMayBeDue(state: GameState): boolean {
  if (state.status !== 'ACTIVE') return false;
  const bots = new Set(state.players.filter((p) => p.status === 'ACTIVE' && p.bot).map((p) => p.id));
  if (bots.size === 0) return false;
  return (
    bots.has(state.turn.playerId ?? '') ||
    state.auction?.status === 'OPEN' ||
    !!state.endGame?.vote ||
    state.trades.some((t) => t.status === 'PENDING' && bots.has(t.toPlayerId))
  );
}

/** Mounted once in the root layout: the ONLY place that syncs, whichever screen is open. */
export function GameSyncHost(): null {
  const session = useSessionStore((s) => s.session);
  useGameSync(session);
  return null;
}
