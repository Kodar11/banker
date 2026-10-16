import { router } from 'expo-router';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { discardSoloGame } from '@/features/solo/localGame';

/**
 * Forgets the game this phone is in: the stored session (which stops GameSyncHost's
 * realtime subscription and polling) and every piece of game state in the store.
 */
export function detachFromGame(): void {
  // A solo game exists only on this device: once the player has let go of it, it is gone.
  const session = useSessionStore.getState().session;
  if (session?.local) discardSoloGame(session.gameId);
  useGameStore.getState().reset(null);
  void useSessionStore.getState().clearSession();
}

/**
 * Leaves the current game for the game-entry flow: Home, optionally straight on to
 * Create / Join. The old game's screens are removed from the stack first, so Back
 * can never return to them.
 */
export function leaveGame(next?: '/create-game' | '/join-game'): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
  if (next) router.push(next);
  detachFromGame();
}
