import { create } from 'zustand';
import type { GameSnapshot } from '@/engine/index.ts';
import type { ApiError } from '@/lib/gameApi';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface Notice {
  id: number;
  kind: 'error' | 'success' | 'info';
  message: string;
}

interface GameStoreState {
  gameId: string | null;
  snapshot: GameSnapshot | null;
  connection: ConnectionStatus;
  onlinePlayerIds: string[];
  /** Action type currently being sent (drives button spinners, blocks double taps). */
  pendingAction: string | null;
  loadError: ApiError | null;
  notice: Notice | null;

  reset: (gameId: string | null) => void;
  /** Applies a server snapshot. Older versions are ignored so stale responses never win. */
  applySnapshot: (snapshot: GameSnapshot) => boolean;
  setConnection: (c: ConnectionStatus) => void;
  setOnline: (ids: string[]) => void;
  setPending: (action: string | null) => void;
  setLoadError: (e: ApiError | null) => void;
  notify: (kind: Notice['kind'], message: string) => void;
  dismissNotice: () => void;
}

let noticeId = 0;

export const useGameStore = create<GameStoreState>((set, get) => ({
  gameId: null,
  snapshot: null,
  connection: 'connecting',
  onlinePlayerIds: [],
  pendingAction: null,
  loadError: null,
  notice: null,

  reset: (gameId) =>
    set({ gameId, snapshot: null, connection: 'connecting', onlinePlayerIds: [], pendingAction: null, loadError: null, notice: null }),
  applySnapshot: (snapshot) => {
    const current = get().snapshot;
    if (get().gameId && snapshot.state.id !== get().gameId) return false;
    if (current && snapshot.state.version < current.state.version) return false;
    set({ snapshot, loadError: null });
    return true;
  },
  setConnection: (connection) => set({ connection }),
  setOnline: (onlinePlayerIds) => set({ onlinePlayerIds }),
  setPending: (pendingAction) => set({ pendingAction }),
  setLoadError: (loadError) => set({ loadError }),
  notify: (kind, message) => set({ notice: { id: ++noticeId, kind, message } }),
  dismissNotice: () => set({ notice: null }),
}));
