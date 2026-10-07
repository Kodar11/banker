import type { RealtimeChannel } from '@supabase/supabase-js';
import { realtimeTopic, type StateBroadcast } from '@/engine/index.ts';
import { syncLog, syncStats } from './syncStats';
import { getSupabase } from './supabase';

export type ChannelHealth = 'connecting' | 'live' | 'down';

export interface GameChannelHandlers {
  onState: (payload: StateBroadcast) => void;
  onPresence: (onlinePlayerIds: string[]) => void;
  onHealth: (health: ChannelHealth) => void;
}

/**
 * The app's single realtime channel for a game: broadcast "state changed" pings
 * from the server + presence (who has the app open). Broadcasts carry only a
 * version number; the client refetches authoritative state when it is behind.
 *
 * Reconnection: realtime-js (Phoenix) already rejoins a channel that errored or
 * timed out, and rejoins everything after the socket reconnects. We therefore
 * NEVER tear the channel down on CHANNEL_ERROR / TIMED_OUT — doing so raced the
 * library's own rejoin, could disconnect the shared socket (removing the last
 * channel disconnects it) and produced reconnect → refetch cycles while idle.
 * The channel is only recreated if it ends up CLOSED without us asking.
 */
export function subscribeToGame(gameId: string, playerId: string, handlers: GameChannelHandlers): () => void {
  const supabase = getSupabase();
  const topic = realtimeTopic(gameId);
  let channel: RealtimeChannel | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    handlers.onHealth('connecting');
    const ch = supabase.channel(topic, {
      config: { broadcast: { self: false }, presence: { key: playerId } },
    });
    channel = ch;
    syncStats.subscriptions += 1;
    syncLog('subscribe', topic);
    ch.on('broadcast', { event: 'state' }, ({ payload }) => {
      if (closed || channel !== ch) return;
      syncStats.realtimeEvents += 1;
      handlers.onState(payload as StateBroadcast);
    })
      .on('presence', { event: 'sync' }, () => {
        if (closed || channel !== ch) return;
        handlers.onPresence(Object.keys(ch.presenceState()));
      })
      .subscribe((status) => {
        if (closed || channel !== ch) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          handlers.onHealth('live');
          void ch.track({ playerId });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // realtime-js schedules the rejoin itself.
          handlers.onHealth('down');
        } else if (status === 'CLOSED') {
          handlers.onHealth('down');
          scheduleReopen();
        }
      });
  };

  const scheduleReopen = () => {
    if (closed || retryTimer) return;
    const stale = channel;
    channel = null;
    if (stale) void supabase.removeChannel(stale);
    const delay = Math.min(15_000, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  };

  // supabase-js returns an existing channel for the same topic, so make sure a
  // leftover from a previous mount (or Fast Refresh) is gone before opening ours.
  const leftovers = supabase.getChannels().filter((c) => c.topic === `realtime:${topic}`);
  if (leftovers.length) {
    void Promise.all(leftovers.map((c) => supabase.removeChannel(c))).then(open);
  } else {
    open();
  }

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    const ch = channel;
    channel = null;
    syncLog('unsubscribe', topic);
    if (ch) void supabase.removeChannel(ch);
  };
}
