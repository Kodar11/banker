import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { GameMode } from '@/engine/index.ts';
import { isBehind, shouldApply } from '@/features/matchmaking/logic';
import type { MatchmakingError, MatchmakingResult, MatchmakingState } from '@/features/matchmaking/types';
import { newActionId, newPlayerToken } from '@/lib/device';
import { matchmakingApi, matchmakingError, type CancelOutcome, type ReadyOutcome } from '@/lib/matchmakingApi';

/** The device token this phone confirmed a match with, until the game it opens is stored as the session. */
export const READY_TOKEN_KEY = 'business-banker.matchmaking.v1';

/**
 *  idle     no account attached (signed out, or the profile is not confirmed yet)
 *  loading  first load for the attached account
 *  ready    `data` is the server's answer for the attached account
 *  error    the first load failed; `data` is null. Retry = refresh().
 * After a first successful load a failed refresh keeps `data` and sets `error` (the screen says it
 * may be out of date). Nothing is ever shown that the server did not send for THIS account, and
 * nothing here is remembered between app runs: after a restart the phone knows nothing about a
 * queue until the server has answered.
 */
export type MatchmakingPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface ReadyToken {
  userId: string;
  matchId: string;
  token: string;
}

interface MatchmakingStoreState {
  /** The account everything below belongs to. */
  ownerUserId: string | null;
  phase: MatchmakingPhase;
  data: MatchmakingState | null;
  error: MatchmakingError | null;
  refreshing: boolean;
  /** Requests in flight, by key (e.g. `enqueue`, `invite:RR-7K4P9X`): drives spinners, blocks double taps. */
  pending: Record<string, true>;
  /** The last heartbeats failed: the screen says "Reconnecting…" instead of pretending all is well. */
  reconnecting: boolean;
  /** The game of my match is held by another device of this account (it confirmed there): its id. */
  seatElsewhere: string | null;

  /** Binds the store to an account (or to none). A different account wipes everything first. */
  attach: (userId: string | null) => void;
  /** Fetches the authoritative state. Concurrent calls share one request; a ping during it triggers one more. */
  refresh: () => Promise<void>;
  /** Realtime or a heartbeat announced a version of the change counter. */
  noteVersion: (version: number) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setSeatElsewhere: (gameId: string | null) => void;

  /** Search alone in `mode`; or, for a party's leader, with the whole party (`mode` null: the party's). */
  enqueue: (mode: GameMode | null) => Promise<MatchmakingResult<true>>;
  cancel: () => Promise<MatchmakingResult<CancelOutcome>>;
  /** Confirm the match on screen. The seat token is stored on the phone BEFORE the server hears of it. */
  confirmReady: (matchId: string) => Promise<MatchmakingResult<ReadyOutcome>>;
  decline: (matchId: string) => Promise<MatchmakingResult<true>>;

  createParty: (mode: GameMode) => Promise<MatchmakingResult<true>>;
  invite: (playerId: string) => Promise<MatchmakingResult<true>>;
  respondInvite: (inviteId: string, accept: boolean) => Promise<MatchmakingResult<true>>;
  revokeInvite: (inviteId: string) => Promise<MatchmakingResult<true>>;
  setMode: (mode: GameMode) => Promise<MatchmakingResult<true>>;
  setReady: (ready: boolean) => Promise<MatchmakingResult<true>>;
  leaveParty: () => Promise<MatchmakingResult<true>>;
  kick: (playerId: string) => Promise<MatchmakingResult<true>>;
}

const NOT_READY: { ok: false; error: MatchmakingError } = { ok: false, error: matchmakingError('NOT_READY') };
const BUSY: { ok: false; error: MatchmakingError } = { ok: false, error: matchmakingError('BUSY') };

/** Grows whenever the attached account changes, so a late answer for the previous one is dropped. */
let epoch = 0;
let flight: Promise<void> | null = null;
/** A ping arrived while a refresh was in flight: its answer may predate the change. */
let dirty = false;
/** One tap on "Find match": the same key is sent again on a retry, so a retry can never start a second search. */
let enqueueAttempt: { userId: string; mode: GameMode | null; key: string } | null = null;

const EMPTY = { phase: 'idle' as MatchmakingPhase, data: null, error: null, refreshing: false, pending: {}, reconnecting: false, seatElsewhere: null as string | null };

export async function readReadyToken(): Promise<ReadyToken | null> {
  try {
    const parsed = JSON.parse((await SecureStore.getItemAsync(READY_TOKEN_KEY)) ?? 'null') as Partial<ReadyToken> | null;
    if (!parsed || typeof parsed.userId !== 'string' || typeof parsed.matchId !== 'string' || typeof parsed.token !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.token)) return null;
    return { userId: parsed.userId, matchId: parsed.matchId, token: parsed.token };
  } catch {
    return null;
  }
}

async function writeReadyToken(value: ReadyToken): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(READY_TOKEN_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function clearReadyToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(READY_TOKEN_KEY);
  } catch {
    // It is useless without its match anyway.
  }
}

export const useMatchmakingStore = create<MatchmakingStoreState>((set, get) => {
  /**
   * One request: refuse a double tap, call the server, and — whatever it answered — replace what is
   * on screen with the server's state. Nothing changes on screen before the server has confirmed it,
   * and after an answer that never arrived (NETWORK) the state is fetched before anyone can retry.
   */
  async function mutate<T>(key: string, call: () => Promise<MatchmakingResult<T>>): Promise<MatchmakingResult<T>> {
    if (!get().ownerUserId) return NOT_READY;
    if (get().pending[key]) return BUSY;
    const startedAt = epoch;
    set((s) => ({ pending: { ...s.pending, [key]: true } }));
    let result: MatchmakingResult<T>;
    try {
      result = await call();
      if (startedAt === epoch && (result.ok || result.error.code !== 'NOT_CONFIGURED')) await get().refresh();
    } finally {
      if (startedAt === epoch) {
        set((s) => {
          const { [key]: _done, ...rest } = s.pending;
          return { pending: rest };
        });
      }
    }
    // The account changed while the request was on its way: its outcome belongs to no screen any more.
    return startedAt === epoch ? result : NOT_READY;
  }

  const run = async (): Promise<void> => {
    const startedAt = epoch;
    set((s) => ({ refreshing: true, phase: s.data ? s.phase : 'loading' }));
    for (let i = 0; i < 3; i += 1) {
      dirty = false;
      const res = await matchmakingApi.state();
      if (startedAt !== epoch) return;
      if (!res.ok) {
        set((s) => ({ refreshing: false, error: res.error, phase: s.data ? 'ready' : 'error' }));
        return;
      }
      if (shouldApply(get().data, res.value)) set({ data: res.value, phase: 'ready', error: null, reconnecting: false });
      else set({ phase: 'ready', error: null });
      if (!dirty) break;
    }
    set({ refreshing: false });
  };

  return {
    ownerUserId: null,
    ...EMPTY,

    attach: (userId) => {
      if (get().ownerUserId === userId) return;
      epoch += 1;
      flight = null;
      dirty = false;
      enqueueAttempt = null;
      // Nothing of the previous account may be rendered for the new one, not even for a frame.
      set({ ownerUserId: userId, ...EMPTY });
    },

    refresh: () => {
      if (!get().ownerUserId) return Promise.resolve();
      if (flight) {
        dirty = true;
        return flight;
      }
      const mine = (flight = run().finally(() => {
        if (flight === mine) flight = null;
      }));
      return mine;
    },

    noteVersion: (version) => {
      if (!get().ownerUserId) return;
      // Duplicate and late events announce a version the phone already has: nothing to do.
      if (isBehind(get().data, version)) void get().refresh();
    },

    setReconnecting: (reconnecting) => {
      if (get().reconnecting !== reconnecting) set({ reconnecting });
    },

    setSeatElsewhere: (gameId) => {
      if (get().seatElsewhere !== gameId) set({ seatElsewhere: gameId });
    },

    enqueue: (mode) =>
      mutate('enqueue', async () => {
        const userId = get().ownerUserId!;
        if (!enqueueAttempt || enqueueAttempt.userId !== userId || enqueueAttempt.mode !== mode) enqueueAttempt = { userId, mode, key: newActionId() };
        const attempt = enqueueAttempt;
        const res = await matchmakingApi.enqueue(mode, attempt.key);
        // Answered, one way or the other: the next tap is a new request. Unanswered: the same key goes again.
        if ((res.ok || res.error.code !== 'NETWORK') && enqueueAttempt === attempt) enqueueAttempt = null;
        if (res.ok) void matchmakingApi.nudge();
        return res;
      }),

    cancel: () => mutate('cancel', () => matchmakingApi.cancel()),

    confirmReady: (matchId) =>
      mutate('ready', async () => {
        const userId = get().ownerUserId!;
        // The same token for the same match, however often the button is pressed or the app restarted.
        const stored = await readReadyToken();
        const token = stored && stored.userId === userId && stored.matchId === matchId ? stored.token : newPlayerToken();
        // Kept first: a confirmation the server holds for a token this phone has lost would be a seat nobody can open.
        if (!(await writeReadyToken({ userId, matchId, token }))) return { ok: false, error: matchmakingError('SERVER') };
        const res = await matchmakingApi.ready(matchId, token);
        if (res.ok && res.value.allReady) void matchmakingApi.nudge();
        return res;
      }),

    decline: (matchId) => mutate('decline', () => matchmakingApi.decline(matchId)),

    createParty: (mode) => mutate('party', () => matchmakingApi.createParty(mode)),
    invite: (playerId) => mutate(`invite:${playerId}`, () => matchmakingApi.invite(playerId)),
    respondInvite: (inviteId, accept) => mutate(`invitation:${inviteId}`, () => matchmakingApi.respondInvite(inviteId, accept)),
    revokeInvite: (inviteId) => mutate(`invitation:${inviteId}`, () => matchmakingApi.revokeInvite(inviteId)),
    setMode: (mode) => mutate('mode', () => matchmakingApi.setMode(mode)),
    setReady: (ready) => mutate('partyReady', () => matchmakingApi.setReady(ready)),
    leaveParty: () => mutate('party', () => matchmakingApi.leaveParty()),
    kick: (playerId) => mutate(`member:${playerId}`, () => matchmakingApi.kick(playerId)),
  };
});

/** Test helper: forget everything held in memory. */
export function resetMatchmakingStoreForTests(): void {
  epoch += 1;
  flight = null;
  dirty = false;
  enqueueAttempt = null;
  useMatchmakingStore.setState({ ownerUserId: null, ...EMPTY });
}
