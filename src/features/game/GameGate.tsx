import { useEffect, type ReactNode } from 'react';
import { router } from 'expo-router';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { leaveGame } from './leaveGame';
import { useGameView, type GameView } from './useGameView';

type Area = 'lobby' | 'game' | 'any';

/**
 * Wraps every in-game route: checks this device is in the game, renders
 * loading/error states, and moves players between lobby and game as the server
 * status changes. Syncing itself happens once, in GameSyncHost (root layout).
 */
export function GameGate({ gameId, area, children }: { gameId: string; area: Area; children: (view: GameView) => ReactNode }) {
  const session = useSessionStore((s) => s.session);
  const hydrated = useSessionStore((s) => s.hydrated);
  const loadError = useGameStore((s) => s.loadError);
  const belongs = !!session && session.gameId === gameId;
  const view = useGameView();
  const status = view?.snapshot.state.status;

  useEffect(() => {
    if (!status) return;
    if (area === 'lobby' && status !== 'WAITING') router.replace(`/game/${gameId}`);
    if (area === 'game' && status === 'WAITING') router.replace(`/lobby/${gameId}`);
  }, [area, status, gameId]);

  // A route left over from ANOTHER game (this phone played before, then joined a new table) must
  // never strand the player on "Not in this game": send it to the game this phone is actually in.
  const elsewhere = hydrated && !!session && session.gameId !== gameId ? session.gameId : null;
  useEffect(() => {
    if (elsewhere && area !== 'any') router.replace(area === 'lobby' ? `/lobby/${elsewhere}` : `/game/${elsewhere}`);
  }, [elsewhere, area]);

  if (!hydrated || (elsewhere && area !== 'any')) return <LoadingState message="Loading…" />;
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
        action={gone ? <Button title="Leave game" onPress={() => leaveGame()} /> : <Button title="Try again" onPress={() => useGameStore.getState().setLoadError(null)} />}
      />
    );
  }
  if (!view) return <LoadingState />;
  if (view.me?.status === 'LEFT') {
    // Taken out of the lobby by the host, as opposed to walking away.
    const removed = view.snapshot.events.some((e) => e.type === 'PLAYER_REMOVED' && e.payload.playerId === view.me?.id);
    return (
      <ErrorState
        title={removed ? 'You were removed from this game' : 'You left this game'}
        message={removed ? 'The host removed you from the lobby.' : 'This phone is no longer playing in it.'}
        action={<Button title="Home" onPress={() => leaveGame()} />}
      />
    );
  }
  return <>{children(view)}</>;
}
