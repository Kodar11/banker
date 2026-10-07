import { router, type Href } from 'expo-router';
import { isPropertyKey, type GameStatus } from '@/engine/index.ts';

/** Go back only when there is history; otherwise navigate explicitly (e.g. after a reload/deep link). */
export function goBack(fallback: Href = '/'): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** Where a device that is part of a game belongs: its lobby or its game screen. null = nowhere (finished). */
export function activeGameRoute(gameId: string, status: GameStatus): Href | null {
  if (status === 'WAITING') return `/lobby/${gameId}`;
  if (status === 'ACTIVE' || status === 'PAUSED') return `/game/${gameId}`;
  return null;
}

/** The only way the app opens a property screen: with a key that exists on the board. */
export function openProperty(key: string): void {
  if (!isPropertyKey(key)) return;
  router.push(`/property/${key}`);
}
