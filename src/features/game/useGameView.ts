import { useMemo } from 'react';
import { netWorth, totalDebt, type GameSnapshot, type PlayerState } from '@/engine/index.ts';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

export interface GameView {
  snapshot: GameSnapshot;
  me: PlayerState | null;
  current: PlayerState | null;
  isMyTurn: boolean;
  isHost: boolean;
  playerName: (id: string | null) => string;
  myNetWorth: number;
  myDebt: number;
}

/** Derived, memoized view of the snapshot for the local player. */
export function useGameView(): GameView | null {
  const snapshot = useGameStore((s) => s.snapshot);
  const playerId = useSessionStore((s) => s.session?.playerId ?? null);

  return useMemo(() => {
    if (!snapshot) return null;
    const { state } = snapshot;
    const me = state.players.find((p) => p.id === playerId) ?? null;
    const current = state.players.find((p) => p.id === state.turn.playerId) ?? null;
    const names = new Map(state.players.map((p) => [p.id, p.name]));
    return {
      snapshot,
      me,
      current,
      isMyTurn: !!me && current?.id === me.id && state.status === 'ACTIVE',
      isHost: !!me?.isHost,
      playerName: (id) => (id === null ? 'Bank' : (names.get(id) ?? 'Unknown')),
      myNetWorth: me ? netWorth(state, me.id) : 0,
      myDebt: me ? totalDebt(state, me.id) : 0,
    };
  }, [snapshot, playerId]);
}
