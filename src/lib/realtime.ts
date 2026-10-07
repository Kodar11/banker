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
 * One realtime channel per game screen: broadcast "state changed" pings from the
 * server + presence (who has the app open). Broadcasts carry only a version
 * number; the client always refetches authoritative state from the server.
 */
export function subscribeToGame(gameId: string, playerId: string, handlers: GameChannelHandlers): () => void {
  const supabase = getSupabase();
  let channel: RealtimeChannel | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = () => {
    if (closed) return;
    handlers.onHealth('connecting');
    channel = supabase.channel(realtimeTopic(gameId), {
      config: { broadcast: { self: false }, presence: { key: playerId } },
    });
    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => handlers.onState(payload as StateBroadcast))
      .on('presence', { event: 'sync' }, () => {
        const state = channel?.presenceState() ?? {};
        handlers.onPresence(Object.keys(state));
      })
      .subscribe((status) => {
        if (closed) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          handlers.onHealth('live');
          void channel?.track({ playerId, at: Date.now() });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onHealth('down');
          scheduleReconnect();
        }
      });
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    const old = channel;
    channel = null;
    if (old) void supabase.removeChannel(old);
    const delay = Math.min(15_000, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (channel) void supabase.removeChannel(channel);
  };
}
