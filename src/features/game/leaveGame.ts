import { router } from 'expo-router';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

/**
 * Forgets the game this phone is in: the stored session (which stops GameSyncHost's
 * realtime subscription and polling) and every piece of game state in the store.
 */
export function detachFromGame(): void {
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
