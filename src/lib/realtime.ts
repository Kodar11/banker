import type { RealtimeChannel } from '@supabase/supabase-js';
import { realtimeTopic, type StateBroadcast } from '@/engine/index.ts';
import { getSupabase } from './supabase';

export type ChannelHealth = 'connecting' | 'live' | 'down';

export interface GameChannelHandlers {
  onState: (payload: StateBroadcast) => void;
  onPresence: (onlinePlayerIds: string[]) => void;
  onHealth: (health: ChannelHealth) => void;
}

/**
 * The app's single realtime channel: broadcast "state changed" pings from the
 * server + presence (who has the app open). Broadcasts carry only a version
 * number; the client always refetches authoritative state from the server.
 */
export function subscribeToGame(gameId: string, playerId: string, handlers: GameChannelHandlers): () => void {
  const supabase = getSupabase();
  const topic = realtimeTopic(gameId);
  let channel: RealtimeChannel | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  /** supabase-js reuses channels by topic, so make sure no stale one is left behind. */
  const removeExisting = async () => {
    const stale = supabase.getChannels().filter((c) => c.topic === `realtime:${topic}` || c.topic === topic);
    await Promise.all(stale.map((c) => supabase.removeChannel(c)));
  };

  const connect = async () => {
    if (closed) return;
    handlers.onHealth('connecting');
    await removeExisting();
    if (closed) return;
    const ch = supabase.channel(topic, {
      config: { broadcast: { self: false }, presence: { key: playerId } },
    });
    channel = ch;
    ch.on('broadcast', { event: 'state' }, ({ payload }) => handlers.onState(payload as StateBroadcast))
      .on('presence', { event: 'sync' }, () => handlers.onPresence(Object.keys(ch.presenceState())))
      .subscribe((status) => {
        if (closed || channel !== ch) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          handlers.onHealth('live');
          void ch.track({ playerId, at: Date.now() });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onHealth('down');
          scheduleReconnect();
        }
      });
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    channel = null;
    const delay = Math.min(15_000, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  void connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    const ch = channel;
    channel = null;
    if (ch) void supabase.removeChannel(ch);
  };
}
