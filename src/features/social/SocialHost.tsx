import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { newActionId } from '@/lib/device';
import { subscribeToSocialSync, trackOwnPresence } from '@/lib/socialRealtime';
import { useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSocialStore } from '@/store/socialStore';
import { notificationText, takeUnannounced } from './logic';

/** While the change-counter channel is not live, look again this often (and never while it is). */
export const SOCIAL_POLL_MS_DEGRADED = 30_000;

/** In front of the player. (The state is briefly unknown while the app launches: that counts as in front.) */
const isForeground = (state: AppStateStatus | null | undefined) => state !== 'background' && state !== 'inactive';

/** Identifies this app run on this device in Presence. Not a nickname, not an account id. */
let sessionKey: string | null = null;
const presenceSessionKey = () => (sessionKey ??= newActionId());

/**
 * The social feature's lifecycle, mounted once in the root layout. Renders nothing.
 *
 *  - Binds the social store to the signed-in account, and wipes it the moment the account changes
 *    (sign-out, restore with Google, deletion) so one player's friends are never shown to another.
 *  - Fetches on sign-in, when the app returns to the foreground, when Realtime announces a change
 *    and when Realtime reconnects; polls slowly only while Realtime is down.
 *  - Shows this player as online on their own presence topic while the app is in front.
 *  - Ties the account to the seat this phone holds in a game, so players at a table can befriend
 *    one another and invite their friends.
 *  - Announces a notification once, when it first arrives while the app is open. Announcing is not
 *    reading: it stays unread until the player has looked at the Friends screen.
 */
export function SocialHost() {
  const userId = useAccountStore((s) => (s.phase === 'ready' && s.verified ? (s.profile?.userId ?? null) : null));
  const presenceKey = useSocialStore((s) => (s.ownerUserId === userId ? (s.data?.me.presenceKey ?? null) : null));
  const [active, setActive] = useState(() => isForeground(AppState.currentState));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(isForeground(next)));
    return () => sub.remove();
  }, []);

  // Account binding + change-counter subscription.
  useEffect(() => {
    const social = useSocialStore.getState();
    social.attach(userId);
    if (!userId) return;
    void social.refresh();

    let live = false;
    let wasDown = false;
    let everLive = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const startPolling = () => {
      if (poll || live) return;
      poll = setInterval(() => {
        if (isForeground(AppState.currentState)) void useSocialStore.getState().refresh();
      }, SOCIAL_POLL_MS_DEGRADED);
    };

    const unsubscribe = subscribeToSocialSync(userId, {
      onVersion: (version) => useSocialStore.getState().noteVersion(version),
      onHealth: (health) => {
        if (health === 'live') {
          live = true;
          stopPolling();
          // Changes made while the channel was joining or down were not announced: reconcile once.
          if (!everLive || wasDown) void useSocialStore.getState().refresh();
          everLive = true;
          wasDown = false;
          return;
        }
        live = false;
        if (health === 'down') wasDown = true;
        startPolling();
      },
    });
    return () => {
      stopPolling();
      unsubscribe();
    };
  }, [userId]);

  // Back in front: whatever happened meanwhile is on the server.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && userId) void useSocialStore.getState().refresh();
    wasActive.current = active;
  }, [active, userId]);

  // My own presence: only while signed in and in front.
  useEffect(() => {
    if (!userId || !presenceKey || !active) return;
    return trackOwnPresence(presenceKey, presenceSessionKey());
  }, [userId, presenceKey, active]);

  // My seat at a table, and who else is there. Re-read when someone joins or leaves.
  const session = useSessionStore((s) => s.session);
  const table = useGameStore((s) =>
    session && s.snapshot?.state.id === session.gameId ? s.snapshot.state.players.map((p) => `${p.id}:${p.status}`).join(',') : null,
  );
  const socialVersion = useSocialStore((s) => (s.ownerUserId === userId ? (s.data?.version ?? 0) : 0));
  useEffect(() => {
    // Only once this account's social data is there: without it the table has nothing to show anyway.
    if (!userId || !session || !table || !socialVersion) return;
    void useSocialStore.getState().syncSeat(session);
    // socialVersion: a block or an unblock changes what a seat may show.
  }, [userId, session, table, socialVersion]);

  // Announce what is new, once.
  const notifications = useSocialStore((s) => (s.ownerUserId === userId ? (s.data?.notifications ?? null) : null));
  const announced = useRef<{ userId: string | null; ids: Set<string>; primed: boolean }>({ userId: null, ids: new Set(), primed: false });
  useEffect(() => {
    if (announced.current.userId !== userId) announced.current = { userId, ids: new Set(), primed: false };
    if (!notifications) return;
    const fresh = takeUnannounced(notifications, announced.current.ids);
    // The first answer after signing in is history (it is on the badge), not news.
    if (!announced.current.primed) {
      announced.current.primed = true;
      return;
    }
    const latest = fresh[0];
    if (latest) useGameStore.getState().notify('info', fresh.length > 1 ? `${notificationText(latest)} (+${fresh.length - 1} more)` : notificationText(latest));
  }, [notifications, userId]);

  return null;
}
