import { create } from 'zustand';
import { isBehind, shouldApply, type PresenceObservation } from '@/features/social/logic';
import type { PublicPlayer, Relationship, SeatProfile, SocialError, SocialResult, SocialState } from '@/features/social/types';
import type { Credentials } from '@/lib/gameApi';
import { socialApi, socialError, type OpenedInvite, type RelationshipChange } from '@/lib/socialApi';
import type { PresenceEvent } from '@/lib/socialRealtime';

/**
 *  idle     no account attached (signed out, or the profile is not confirmed yet)
 *  loading  first load for the attached account
 *  ready    `data` is the server's answer for the attached account
 *  error    the first load failed; `data` is null. Retry = refresh().
 * After a first successful load a failed refresh keeps `data` and sets `error` (the screen says it
 * may be out of date); nothing is ever shown that the server did not send for THIS account.
 */
export type SocialPhase = 'idle' | 'loading' | 'ready' | 'error';

interface SocialStoreState {
  /** The account everything below belongs to. */
  ownerUserId: string | null;
  phase: SocialPhase;
  data: SocialState | null;
  error: SocialError | null;
  /** A refresh is on its way (pull-to-refresh spinner). */
  refreshing: boolean;
  /** Mutations in flight, by key (e.g. `request:RR-7K4P9X`): drives button spinners, blocks double taps. */
  pending: Record<string, true>;
  /** What my presence channels last reported, by presence key. Never from the server's lists. */
  presence: Record<string, PresenceObservation>;
  /** The other players at my table, per game. */
  seats: Record<string, SeatProfile[]>;

  /** Binds the store to an account (or to none). A different account wipes everything first. */
  attach: (userId: string | null) => void;
  /** Fetches the authoritative state. Concurrent calls share one request; a ping during it triggers one more. */
  refresh: () => Promise<void>;
  /** Realtime announced a version of the change counter. */
  noteVersion: (version: number) => void;

  lookup: (playerId: string) => Promise<SocialResult<{ player: PublicPlayer; relationship: Relationship }>>;
  sendRequest: (playerId: string) => Promise<SocialResult<RelationshipChange>>;
  respondRequest: (requestId: string, accept: boolean) => Promise<SocialResult<RelationshipChange>>;
  cancelRequest: (requestId: string) => Promise<SocialResult<RelationshipChange>>;
  removeFriend: (playerId: string) => Promise<SocialResult<true>>;
  block: (playerId: string) => Promise<SocialResult<true>>;
  unblock: (playerId: string) => Promise<SocialResult<true>>;
  sendInvite: (gameId: string, playerId: string) => Promise<SocialResult<true>>;
  revokeInvite: (inviteId: string) => Promise<SocialResult<true>>;
  declineInvite: (inviteId: string) => Promise<SocialResult<true>>;
  /** Re-checks an invitation on the server just before joining. A refusal also refreshes the list. */
  openInvite: (inviteId: string) => Promise<SocialResult<OpenedInvite>>;
  markRead: (ids?: string[]) => Promise<void>;

  /** Ties this account to the seat this phone holds, then loads who else is at the table. */
  syncSeat: (credentials: Credentials) => Promise<void>;
  notePresence: (event: PresenceEvent, nowMs: number) => void;
  clearPresence: () => void;
}

const NOT_READY: { ok: false; error: SocialError } = { ok: false, error: socialError('NOT_READY') };
const BUSY: { ok: false; error: SocialError } = { ok: false, error: socialError('BUSY') };

/** Grows whenever the attached account changes, so a late answer for the previous one is dropped. */
let epoch = 0;
let flight: Promise<void> | null = null;
/** A ping arrived while a refresh was in flight: its answer may predate the change. */
let dirty = false;
/** Seats this account has claimed in this app run (`userId:gameId:seatId`). */
const claimed = new Set<string>();

const EMPTY = { phase: 'idle' as SocialPhase, data: null, error: null, refreshing: false, pending: {}, presence: {}, seats: {} };

export const useSocialStore = create<SocialStoreState>((set, get) => {
  /**
   * One mutation: refuse a double tap, call the server, and — whatever it answered — replace the
   * local lists with the server's. Nothing changes on screen before the server has confirmed it.
   */
  async function mutate<T>(key: string, call: () => Promise<SocialResult<T>>): Promise<SocialResult<T>> {
    if (!get().ownerUserId) return NOT_READY;
    if (get().pending[key]) return BUSY;
    const startedAt = epoch;
    set((s) => ({ pending: { ...s.pending, [key]: true } }));
    let result: SocialResult<T>;
    try {
      result = await call();
      // A refusal can mean the phone was out of date (expired, already answered): look again either way.
      if (startedAt === epoch && (result.ok || (result.error.code !== 'NETWORK' && result.error.code !== 'NOT_CONFIGURED'))) await get().refresh();
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
      const res = await socialApi.state();
      if (startedAt !== epoch) return;
      if (!res.ok) {
        set((s) => ({ refreshing: false, error: res.error, phase: s.data ? 'ready' : 'error' }));
        return;
      }
      if (shouldApply(get().data, res.value)) set({ data: res.value, phase: 'ready', error: null });
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

    lookup: async (playerId) => {
      if (!get().ownerUserId) return NOT_READY;
      const startedAt = epoch;
      const res = await socialApi.lookup(playerId);
      return startedAt === epoch ? res : NOT_READY;
    },
    sendRequest: (playerId) => mutate(`request:${playerId}`, () => socialApi.sendRequest(playerId)),
    respondRequest: (requestId, accept) => mutate(`respond:${requestId}`, () => socialApi.respondRequest(requestId, accept)),
    cancelRequest: (requestId) => mutate(`respond:${requestId}`, () => socialApi.cancelRequest(requestId)),
    removeFriend: (playerId) => mutate(`friend:${playerId}`, () => socialApi.removeFriend(playerId)),
    block: (playerId) => mutate(`friend:${playerId}`, () => socialApi.block(playerId)),
    unblock: (playerId) => mutate(`friend:${playerId}`, () => socialApi.unblock(playerId)),
    sendInvite: (gameId, playerId) => mutate(`invite:${gameId}:${playerId}`, () => socialApi.sendInvite(gameId, playerId)),
    revokeInvite: (inviteId) => mutate(`invitation:${inviteId}`, () => socialApi.revokeInvite(inviteId)),
    declineInvite: (inviteId) => mutate(`invitation:${inviteId}`, () => socialApi.declineInvite(inviteId)),
    openInvite: (inviteId) => mutate(`invitation:${inviteId}`, () => socialApi.openInvite(inviteId)),

    markRead: async (ids) => {
      const data = get().data;
      if (!get().ownerUserId || !data) return;
      const unread = data.notifications.filter((n) => !n.read && (!ids || ids.includes(n.id)));
      if (!unread.length && !(ids === undefined && data.unread > 0)) return;
      const startedAt = epoch;
      const res = await socialApi.markRead(ids);
      // Read state comes back from the server with the refresh; nothing is marked locally on a failure.
      if (res.ok && startedAt === epoch) await get().refresh();
    },

    syncSeat: async (credentials) => {
      const userId = get().ownerUserId;
      if (!userId) return;
      const startedAt = epoch;
      const key = `${userId}:${credentials.gameId}:${credentials.playerId}`;
      if (!claimed.has(key)) {
        const res = await socialApi.claimSeat(credentials);
        if (startedAt !== epoch) return;
        // Not claimed (an older server, no connection, the seat is another account's): the table simply
        // has no "Add Friend" until a later attempt succeeds.
        if (!res.ok) return;
        claimed.add(key);
      }
      const profiles = await socialApi.seatProfiles(credentials.gameId);
      if (startedAt !== epoch) return;
      if (profiles.ok) set((s) => ({ seats: { ...s.seats, [credentials.gameId]: profiles.value } }));
      else if (profiles.error.code === 'NOT_IN_GAME') claimed.delete(key);
    },

    notePresence: (event, nowMs) => {
      const previous = get().presence[event.presenceKey];
      const next: PresenceObservation = {
        synced: event.synced,
        present: event.synced ? event.present : (previous?.present ?? false),
        // The moment they were first seen gone. A channel that merely lost its own connection keeps
        // what it knew, so a network blip on this phone never turns a friend "offline".
        leftAt: !event.synced ? (previous?.leftAt ?? null) : event.present ? null : previous?.present ? nowMs : (previous?.leftAt ?? null),
      };
      if (previous && previous.synced === next.synced && previous.present === next.present && previous.leftAt === next.leftAt) return;
      set((s) => ({ presence: { ...s.presence, [event.presenceKey]: next } }));
    },

    clearPresence: () => {
      if (Object.keys(get().presence).length) set({ presence: {} });
    },
  };
});

/** Test helper: forget everything held in memory. */
export function resetSocialStoreForTests(): void {
  epoch += 1;
  flight = null;
  dirty = false;
  claimed.clear();
  useSocialStore.setState({ ownerUserId: null, ...EMPTY });
}
