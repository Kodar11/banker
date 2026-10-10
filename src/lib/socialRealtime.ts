import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ChannelHealth } from './realtime';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Realtime for the social feature, on the app's one Supabase client.
 *
 *  1. The change counter: Postgres changes of the signed-in player's own `social_sync` row (RLS lets
 *     them read no other). An event carries only a version number; the app refetches when it is behind.
 *  2. Presence: one topic per player, `presence:<key>`, where the key is an unguessable value the
 *     server gives only to that player and their friends. A player tracks themselves on their own
 *     topic while the app is in front; the Friends screen listens on its friends' topics while it is
 *     open. Presence is informational: nothing is ever authorised by it.
 *
 * As in realtime.ts, a channel that errors or times out is left alone (realtime-js rejoins it) and
 * is only recreated if it ends up closed without us asking.
 */

interface Managed {
  close: () => void;
}

/** Opens a channel and keeps it open until closed; `build` attaches the listeners and subscribes. */
function manage(topic: string, build: (channel: RealtimeChannel, isCurrent: () => boolean) => void, onHealth: (health: ChannelHealth) => void, config?: Record<string, unknown>): Managed {
  const supabase = getSupabase();
  let channel: RealtimeChannel | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const open = () => {
    if (closed) return;
    onHealth('connecting');
    const ch = supabase.channel(topic, config ? { config } : undefined);
    channel = ch;
    const isCurrent = () => !closed && channel === ch;
    build(ch, isCurrent);
    ch.subscribe((status) => {
      if (!isCurrent()) return;
      if (status === 'SUBSCRIBED') {
        attempt = 0;
        onHealth('live');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        onHealth('down');
      } else if (status === 'CLOSED') {
        onHealth('down');
        reopen();
      }
    });
  };

  const reopen = () => {
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

  // supabase-js hands back an existing channel for the same topic: clear a leftover first.
  const leftovers = supabase.getChannels().filter((c) => c.topic === `realtime:${topic}`);
  if (leftovers.length) void Promise.all(leftovers.map((c) => supabase.removeChannel(c))).then(open);
  else open();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const ch = channel;
      channel = null;
      if (ch) void supabase.removeChannel(ch);
    },
  };
}

export interface SocialSyncHandlers {
  /** The server's change counter moved to `version` (NaN when the event did not carry one). */
  onVersion: (version: number) => void;
  onHealth: (health: ChannelHealth) => void;
}

/** "Something of yours changed" pings for the signed-in player. */
export function subscribeToSocialSync(userId: string, handlers: SocialSyncHandlers): () => void {
  if (!isSupabaseConfigured) return () => undefined;
  const managed = manage(
    `social:${userId}`,
    (ch, isCurrent) => {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'social_sync', filter: `user_id=eq.${userId}` }, (payload) => {
        if (!isCurrent()) return;
        handlers.onVersion(Number((payload.new as { version?: unknown } | null)?.version));
      });
    },
    handlers.onHealth,
  );
  return managed.close;
}

const presenceTopic = (presenceKey: string) => `presence:${presenceKey}`;

/**
 * Marks the signed-in player as online on their own topic until the returned function is called.
 * `sessionKey` identifies this app run on this device (never a nickname or an account id).
 */
export function trackOwnPresence(presenceKey: string, sessionKey: string): () => void {
  if (!isSupabaseConfigured) return () => undefined;
  let current: RealtimeChannel | null = null;
  const managed = manage(
    presenceTopic(presenceKey),
    (ch) => {
      current = ch;
    },
    (health) => {
      if (health === 'live' && current) void current.track({ at: Date.now() }).catch(() => undefined);
    },
    { presence: { key: sessionKey } },
  );
  return managed.close;
}

export interface PresenceEvent {
  presenceKey: string;
  /** My subscription to this topic: `live` once joined; anything else means "cannot tell". */
  health: ChannelHealth;
  /** Whether anyone is on the topic. Only meaningful after the first sync of a live channel. */
  present: boolean;
  synced: boolean;
}

/** Listens on friends' presence topics (the caller bounds how many) until the returned function is called. */
export function watchPresence(presenceKeys: readonly string[], onEvent: (event: PresenceEvent) => void): () => void {
  if (!isSupabaseConfigured) return () => undefined;
  const channels = presenceKeys.map((presenceKey) => {
    let synced = false;
    let present = false;
    let health: ChannelHealth = 'connecting';
    const emit = () => onEvent({ presenceKey, health, present, synced: synced && health === 'live' });
    return manage(
      presenceTopic(presenceKey),
      (ch, isCurrent) => {
        synced = false;
        ch.on('presence', { event: 'sync' }, () => {
          if (!isCurrent()) return;
          synced = true;
          present = Object.keys(ch.presenceState()).length > 0;
          emit();
        });
      },
      (next) => {
        health = next;
        // A channel that is not live knows nothing: wait for its next sync before saying anything.
        if (next !== 'live') synced = false;
        emit();
      },
    );
  });
  return () => channels.forEach((c) => c.close());
}
