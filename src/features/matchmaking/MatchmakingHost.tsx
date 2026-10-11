import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { router, usePathname } from 'expo-router';
import { matchmakingApi } from '@/lib/matchmakingApi';
import { subscribeToMatchmakingSync } from '@/lib/socialRealtime';
import { useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { clearReadyToken, readReadyToken, useMatchmakingStore } from '@/store/matchmakingStore';
import { useSessionStore } from '@/store/sessionStore';
import { haptics } from '@/utils/haptics';
import { nextHeartbeatMs, phaseOf, resultMessage, takeNew } from './logic';
import type { MatchedGame } from './types';

export const PLAY_ONLINE_ROUTE = '/play-online';

/** While the change-counter channel is not live, look again this often (and never while it is). */
export const MATCHMAKING_POLL_MS_DEGRADED = 15_000;
/** A searching phone asks the worker to look at most this often, however many reasons it has. */
const NUDGE_MIN_INTERVAL_MS = 4000;
/** After a deadline the server should have acted on: look again at these delays, then stop (bounded). */
const OVERDUE_CHECKS_MS = [1500, 3000, 5000, 8000, 13000, 21000];

/** In front of the player. (The state is briefly unknown while the app launches: that counts as in front.) */
const isForeground = (state: AppStateStatus | null | undefined) => state !== 'background' && state !== 'inactive';

let lastNudgeAt = 0;
function nudge(): void {
  const now = Date.now();
  // (A phone clock that was set back must not silence the nudge for good.)
  if (now >= lastNudgeAt && now - lastNudgeAt < NUDGE_MIN_INTERVAL_MS) return;
  lastNudgeAt = now;
  void matchmakingApi.nudge();
}

/**
 * Takes this phone to the game its match became: the seat is opened with the device token the phone
 * confirmed with, exactly like a seat it created or joined. Returns false when another device of
 * this account holds the seat.
 */
async function enterMatchedGame(userId: string, game: MatchedGame): Promise<boolean> {
  const sessions = useSessionStore.getState();
  if (sessions.session?.gameId !== game.gameId) {
    const stored = await readReadyToken();
    if (!stored || stored.userId !== userId || stored.matchId !== game.matchId) return false;
    await sessions.setSession({ gameId: game.gameId, playerId: game.seatId, token: stored.token });
    useGameStore.getState().reset(game.gameId);
    haptics.success();
  }
  // The session holds the token now; the copy kept for the countdown has done its job.
  void clearReadyToken();
  return true;
}

/**
 * Random matchmaking's lifecycle, mounted once in the root layout. Renders nothing.
 *
 *  - Binds the matchmaking store to the signed-in account and wipes it the moment the account
 *    changes, so one player's party or search is never shown to another.
 *  - The server is the only source of truth: state is fetched on sign-in (which is also app start —
 *    nothing about a queue is remembered on the phone), when the app returns to the foreground,
 *    when Realtime announces a change and when Realtime reconnects; it polls slowly only while
 *    Realtime is down.
 *  - While the player is searching, in a countdown or in a party, and the app is in front, sends a
 *    heartbeat (the server's sign that this phone is still there), backing off with jitter when it
 *    fails. The heartbeat also carries the change counter, so a missed Realtime event is noticed.
 *  - Brings the player to the Match Found screen wherever they are in the app, and into the game
 *    once the server has started it.
 */
export function MatchmakingHost() {
  const userId = useAccountStore((s) => (s.phase === 'ready' && s.verified ? (s.profile?.userId ?? null) : null));
  const [active, setActive] = useState(() => isForeground(AppState.currentState));
  const pathname = usePathname();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(isForeground(next)));
    return () => sub.remove();
  }, []);

  // Account binding + change-counter subscription.
  useEffect(() => {
    const store = useMatchmakingStore.getState();
    store.attach(userId);
    if (!userId) return;
    void store.refresh();

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
        if (isForeground(AppState.currentState)) void useMatchmakingStore.getState().refresh();
      }, MATCHMAKING_POLL_MS_DEGRADED);
    };

    const unsubscribe = subscribeToMatchmakingSync(userId, {
      onVersion: (version) => useMatchmakingStore.getState().noteVersion(version),
      onHealth: (health) => {
        if (health === 'live') {
          live = true;
          stopPolling();
          // Changes made while the channel was joining or down were not announced: reconcile once.
          if (!everLive || wasDown) void useMatchmakingStore.getState().refresh();
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
    if (active && !wasActive.current && userId) void useMatchmakingStore.getState().refresh();
    wasActive.current = active;
  }, [active, userId]);

  const mine = useMatchmakingStore((s) => (s.ownerUserId === userId ? s.data : null));
  const engaged = !!mine && (!!mine.ticket || !!mine.party);
  const heartbeatSeconds = mine?.settings.heartbeatSeconds ?? 10;

  // Heartbeat: only while there is something to keep alive, and only in front.
  useEffect(() => {
    if (!userId || !engaged || !active) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const beat = async () => {
      const res = await matchmakingApi.heartbeat();
      if (stopped) return;
      const store = useMatchmakingStore.getState();
      if (res.ok) {
        failures = 0;
        store.setReconnecting(false);
        store.noteVersion(res.value.version);
        if (res.value.tickDue) nudge();
      } else if (res.error.code === 'NETWORK' || res.error.code === 'SERVER') {
        failures += 1;
        // One missed heartbeat is nothing; the server allows a grace period much longer than one.
        if (failures >= 2) store.setReconnecting(true);
      } else {
        // The session ended or the server is not configured: the account layer shows that. Stop asking.
        return;
      }
      timer = setTimeout(beat, nextHeartbeatMs(heartbeatSeconds, failures, Math.random()));
    };
    timer = setTimeout(beat, nextHeartbeatMs(heartbeatSeconds, 0, Math.random()));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      useMatchmakingStore.getState().setReconnecting(false);
    };
  }, [userId, engaged, active, heartbeatSeconds]);

  // A countdown that ran out, or a start that is taking long: the server should have moved on. If no
  // event said so, ask — a few times, further and further apart, then leave it to the heartbeat.
  const match = mine?.match ?? null;
  const overdueKey = match && (match.status === 'READY_UP' || match.status === 'STARTING') ? `${match.id}:${match.status}:${match.readyDeadline}` : null;
  useEffect(() => {
    if (!overdueKey || !userId || !active) return;
    const current = useMatchmakingStore.getState().data?.match;
    if (!current) return;
    const deadline = Date.parse(current.readyDeadline);
    const waitFor = current.status === 'READY_UP' && Number.isFinite(deadline) ? Math.max(0, deadline - Date.parse(useMatchmakingStore.getState().data!.serverTime)) : 0;
    const timers = OVERDUE_CHECKS_MS.map((delay) =>
      setTimeout(() => {
        nudge();
        void useMatchmakingStore.getState().refresh();
      }, waitFor + delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [overdueKey, userId, active]);

  // Match found: bring the player to it from wherever they are. The countdown is short.
  const phase = phaseOf(mine);
  const matchId = match?.id ?? null;
  const shownMatch = useRef<string | null>(null);
  useEffect(() => {
    if (!matchId || phase !== 'matchFound' || shownMatch.current === matchId) return;
    shownMatch.current = matchId;
    haptics.heavy();
    if (pathname !== PLAY_ONLINE_ROUTE) {
      useGameStore.getState().notify('success', 'Match found! Confirm that you’re ready.');
      router.push(PLAY_ONLINE_ROUTE);
    }
  }, [matchId, phase, pathname]);

  // The game exists: open this phone's seat and go there.
  const game = mine?.game ?? null;
  const gameKey = game ? `${game.matchId}:${game.gameId}` : null;
  const entered = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !game || !gameKey) {
      useMatchmakingStore.getState().setSeatElsewhere(null);
      return;
    }
    // Only ever acted on once per game, and only when this screen flow brought the player here:
    // a game opened earlier (and perhaps left for Home) is not re-entered by itself.
    if (entered.current === gameKey) return;
    entered.current = gameKey;
    let cancelled = false;
    void (async () => {
      const hadSession = useSessionStore.getState().session?.gameId === game.gameId;
      const mineHere = await enterMatchedGame(userId, game);
      if (cancelled) return;
      useMatchmakingStore.getState().setSeatElsewhere(mineHere ? null : game.gameId);
      if (!mineHere || hadSession) return;
      if (router.canDismiss()) router.dismissAll();
      router.replace(`/game/${game.gameId}`);
    })();
    return () => {
      cancelled = true;
    };
    // `game` is read through gameKey: a new object for the same game must not run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, gameKey]);

  // Say once why a search ended, and once who invited me to a party.
  const lastResult = mine?.lastResult ?? null;
  const invites = mine?.partyInvites ?? null;
  const told = useRef<{ userId: string | null; results: Set<string>; invites: Set<string>; primed: boolean }>({ userId: null, results: new Set(), invites: new Set(), primed: false });
  useEffect(() => {
    if (told.current.userId !== userId) told.current = { userId, results: new Set(), invites: new Set(), primed: false };
    if (!mine) return;
    const freshResults = lastResult ? takeNew([lastResult.ticketId], told.current.results) : [];
    const freshInvites = takeNew((invites ?? []).map((i) => i.id), told.current.invites);
    // The first answer after signing in is history, not news.
    if (!told.current.primed) {
      told.current.primed = true;
      return;
    }
    const outcome = freshResults.length ? resultMessage(lastResult) : null;
    if (outcome) {
      useGameStore.getState().notify(outcome.kind, outcome.message);
      return;
    }
    const invite = invites?.find((i) => i.id === freshInvites[0]);
    if (invite) useGameStore.getState().notify('info', `${invite.inviter.nickname} invited you to their party`);
  }, [mine, lastResult, invites, userId]);

  return null;
}
