import { useEffect, useState } from 'react';
import type { GameMode } from '@/engine/index.ts';
import { serverNow } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { lobbyClosedReason } from './logic';

export interface InvitableLobby {
  gameId: string;
  code: string;
  mode: GameMode;
}

/** The lobby this phone sits in, when friends can be invited into it. */
export function useInvitableLobby(): InvitableLobby | null {
  const session = useSessionStore((s) => s.session);
  const state = useGameStore((s) => (session && s.snapshot?.state.id === session.gameId ? s.snapshot.state : null));
  if (!session || !state || lobbyClosedReason(state, session.playerId)) return null;
  return { gameId: state.id, code: state.code, mode: state.mode };
}

/** The server's clock, re-read on an interval: countdowns and expiry follow it without a refetch. */
export function useServerNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
