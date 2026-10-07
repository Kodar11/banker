/**
 * Development counters for the sync lifecycle. Lets you confirm on a device
 * that an idle game does no refetch/poll work (see features/game/sync.ts).
 */
export const syncStats = {
  subscriptions: 0,
  refreshes: 0,
  pollTicks: 0,
  realtimeEvents: 0,
};

export function resetSyncStats(): void {
  syncStats.subscriptions = 0;
  syncStats.refreshes = 0;
  syncStats.pollTicks = 0;
  syncStats.realtimeEvents = 0;
}

const enabled = typeof __DEV__ !== 'undefined' && __DEV__ && process.env.NODE_ENV !== 'test';

export function syncLog(event: string, detail?: string | number): void {
  if (!enabled) return;
  console.log(`[sync] ${event}${detail === undefined ? '' : ` ${detail}`}`, { ...syncStats });
}
