import { useEffect, type ReactNode } from 'react';
import { router } from 'expo-router';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { useGameSync } from './sync';
import { useGameView, type GameView } from './useGameView';

type Area = 'lobby' | 'game' | 'any';

/**
 * Wraps every in-game route: checks this device is in the game, keeps state
 * synced, renders loading/error states, and moves players between lobby and
 * game as the server status changes.
 */
export function GameGate({ gameId, area, children }: { gameId: string; area: Area; children: (view: GameView) => ReactNode }) {
  const session = useSessionStore((s) => s.session);
  const hydrated = useSessionStore((s) => s.hydrated);
  const clearSession = useSessionStore((s) => s.clearSession);
  const loadError = useGameStore((s) => s.loadError);
  const belongs = !!session && session.gameId === gameId;
  useGameSync(belongs ? session : null);
  const view = useGameView();
  const status = view?.snapshot.state.status;

  useEffect(() => {
    if (!status) return;
    if (area === 'lobby' && status !== 'WAITING') router.replace(`/game/${gameId}`);
    if (area === 'game' && status === 'WAITING') router.replace(`/lobby/${gameId}`);
  }, [area, status, gameId]);

  const leave = async () => {
    await clearSession();
    useGameStore.getState().reset(null);
    router.replace('/');
  };

  if (!hydrated) return <LoadingState message="Loading…" />;
  if (!belongs) {
    return (
      <ErrorState
        title="Not in this game"
        message="This phone isn't a player in that game. Join with the 6-digit code."
        action={<Button title="Home" onPress={() => router.replace('/')} />}
      />
    );
  }
  if (loadError && !view) {
    const gone = loadError.code === 'FORBIDDEN' || loadError.code === 'NOT_FOUND' || loadError.code === 'GAME_EXPIRED';
    return (
      <ErrorState
        title={gone ? 'Game unavailable' : "Couldn't load the game"}
        message={loadError.message}
        action={gone ? <Button title="Leave game" onPress={leave} /> : <Button title="Try again" onPress={() => useGameStore.getState().setLoadError(null)} />}
      />
    );
  }
  if (!view) return <LoadingState />;
  return <>{children(view)}</>;
}
