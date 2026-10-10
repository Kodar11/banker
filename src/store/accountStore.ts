import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { checkNickname, NICKNAME_MESSAGES } from '@/features/account/nickname';
import { accountStatusOf, fail, ok, PLAYER_ID_PATTERN, type AccountError, type AccountStatus, type Profile, type Result } from '@/features/account/types';
import { accountApi, type SessionInfo } from '@/lib/accountApi';

/** Nickname + Player ID of the last confirmed profile, to show something while offline. Never the link status. */
export const PROFILE_CACHE_KEY = 'business-banker.profile.v1';
/** User id of an account whose deletion was requested but not yet confirmed (the app may have been killed). */
export const PENDING_DELETE_KEY = 'business-banker.account-delete.v1';

/**
 *  idle         nothing loaded yet (also: just after a confirmed deletion)
 *  loading      restoring the session / loading the profile
 *  ready        signed in, profile confirmed by the server in this app run
 *  unavailable  could not be checked (offline, server down). NOTHING was created or discarded;
 *               `profile` may hold the remembered nickname and Player ID. Retry = initialize().
 *  signedOut    this phone had an account, and Supabase Auth has ended its session. The player
 *               chooses: restore with Google, or start a new guest account. Never automatic.
 */
export type AccountPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'signedOut';

export type AccountTask = 'link' | 'restore' | 'reauth' | 'delete' | 'guest';

interface AccountState {
  phase: AccountPhase;
  profile: Profile | null;
  /** `profile` came from the server during this app run (not from the phone's memory). */
  verified: boolean;
  error: AccountError | null;
  /** A nickname save is on its way. */
  saving: boolean;
  /** The one account operation in progress, if any. */
  busy: AccountTask | null;
  /** Restore the stored session or, on a first launch, create the guest account. Safe to call repeatedly. */
  initialize: () => Promise<void>;
  updateNickname: (raw: string) => Promise<Result<Profile>>;
  /** Guest → Google-linked, same player. */
  linkGoogle: () => Promise<Result<Profile>>;
  /** Switch this phone to the player linked to a Google account. The caller has already confirmed the switch. */
  restoreWithGoogle: () => Promise<Result<{ profile: Profile; startedNew: boolean }>>;
  /** A fresh Google sign-in for the SAME account (required before deleting a linked account). */
  reauthenticate: () => Promise<Result<true>>;
  deleteAccount: () => Promise<Result<true>>;
  /** From `signedOut`: give up on the old account and start a new guest. */
  startNewGuest: () => Promise<void>;
  /** Supabase Auth reported that the session ended. */
  handleSignedOut: () => void;
}

const BUSY = fail('BUSY', 'Please wait for the current step to finish.');
const NOT_READY = fail('NOT_READY', 'Your profile isn’t loaded yet. Check your connection and try again.');

async function readStored(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeStored(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Best effort: the server stays the source of truth.
  }
}

async function readCachedProfile(): Promise<Profile | null> {
  try {
    const data = JSON.parse((await readStored(PROFILE_CACHE_KEY)) ?? 'null') as Partial<Profile> | null;
    if (!data || typeof data.userId !== 'string' || typeof data.nickname !== 'string' || typeof data.playerId !== 'string' || !PLAYER_ID_PATTERN.test(data.playerId)) return null;
    return { userId: data.userId, playerId: data.playerId, nickname: data.nickname, googleLinked: false };
  } catch {
    return null;
  }
}

/** One initialize() at a time; later callers share it. */
let flight: Promise<void> | null = null;
/** Grows whenever the signed-in account changes, so a late answer for the previous one is dropped. */
let epoch = 0;
/** True while this store itself is clearing the session (so the SIGNED_OUT event is not a surprise). */
let ownSignOut = false;
/** A session that must be put back (a mistaken Google sign-in replaced it and the first attempt failed). */
let pendingRestore: SessionInfo | null = null;

export const useAccountStore = create<AccountState>((set, get) => {
  const commit = (profile: Profile) => {
    set({ profile, verified: true, phase: 'ready', error: null });
    void writeStored(PROFILE_CACHE_KEY, JSON.stringify({ userId: profile.userId, playerId: profile.playerId, nickname: profile.nickname }));
  };

  const unavailable = (error: AccountError) => set({ phase: 'unavailable', verified: false, error });

  /** Removes every trace of the account from this phone's memory (not the Auth session). */
  const forgetAccount = async () => {
    epoch += 1;
    set({ profile: null, verified: false });
    await writeStored(PROFILE_CACHE_KEY, null);
    await writeStored(PENDING_DELETE_KEY, null);
  };

  const signOutLocal = async () => {
    ownSignOut = true;
    try {
      await accountApi.signOutLocal();
    } finally {
      ownSignOut = false;
    }
  };

  const loadProfile = async (session: SessionInfo, pendingDelete: string | null): Promise<void> => {
    const loaded = await accountApi.initProfile();
    if (loaded.ok) {
      // A deletion that was requested but never happened: the account is intact.
      if (pendingDelete) await writeStored(PENDING_DELETE_KEY, null);
      commit(loaded.value.profile);
      return;
    }
    if (loaded.error.code !== 'SESSION_INVALID') return unavailable(loaded.error);

    // The token was refused. Only Supabase Auth saying the account is gone ends the session here;
    // anything less certain keeps it.
    const verdict = await accountApi.verifyUser();
    if (!verdict.ok) return unavailable(verdict.error);
    if (verdict.value === 'valid') return unavailable({ code: 'SERVER', message: 'Your profile could not be loaded. Please try again.' });
    await signOutLocal();
    if (pendingDelete === session.userId) {
      // The deletion this phone asked for did go through.
      await forgetAccount();
      return createGuest();
    }
    epoch += 1;
    set({ phase: 'signedOut', verified: false, error: null });
  };

  const createGuest = async (): Promise<void> => {
    const created = await accountApi.signInAnonymously();
    if (!created.ok) return unavailable(created.error);
    epoch += 1;
    return loadProfile(created.value, null);
  };

  const run = async (): Promise<void> => {
    set({ phase: 'loading', error: null });
    if (pendingRestore) {
      const back = await accountApi.restoreTokens(pendingRestore);
      if (!back.ok) return unavailable(back.error);
      pendingRestore = null;
    }
    const cached = await readCachedProfile();
    if (cached && !get().profile) set({ profile: cached, verified: false });
    const pendingDelete = await readStored(PENDING_DELETE_KEY);

    const session = await accountApi.restoreSession();
    // Could not be checked: the stored session is untouched and no account is created.
    if (!session.ok) return unavailable(session.error);
    if (session.value) return loadProfile(session.value, pendingDelete);

    if (pendingDelete) {
      await forgetAccount();
      return createGuest();
    }
    if (cached) {
      // This phone had an account. Do not replace it silently — the player may be able to restore it.
      set({ phase: 'signedOut', verified: false, error: null });
      return;
    }
    return createGuest();
  };

  /**
   * After a Google sign-in that must not stand: put the previous session back and, when that
   * sign-in created a brand-new empty account, remove it so the Google account stays free to link.
   */
  const putBack = async (prior: SessionInfo, strayToken: string | null): Promise<void> => {
    let back = await accountApi.restoreTokens(prior);
    for (let i = 0; i < 2 && !back.ok; i += 1) back = await accountApi.restoreTokens(prior);
    if (strayToken) await accountApi.deleteAccount(strayToken);
    if (!back.ok) {
      // Still on the wrong session: keep trying on every initialize() until it is put back.
      pendingRestore = prior;
      unavailable(back.error);
    }
  };

  const begin = (task: AccountTask): boolean => {
    if (get().busy || get().saving) return false;
    set({ busy: task });
    return true;
  };

  return {
    phase: 'idle',
    profile: null,
    verified: false,
    error: null,
    saving: false,
    busy: null,

    initialize: () => {
      if (get().busy) return Promise.resolve();
      if (!flight) {
        flight = run()
          .catch(() => unavailable({ code: 'SERVER', message: 'Your profile could not be loaded. Please try again.' }))
          .finally(() => {
            flight = null;
          });
      }
      return flight;
    },

    updateNickname: async (raw) => {
      const state = get();
      if (state.saving || state.busy) return BUSY;
      if (state.phase !== 'ready' || !state.verified || !state.profile) return NOT_READY;
      const check = checkNickname(raw);
      if (!check.ok) return fail(check.problem, NICKNAME_MESSAGES[check.problem]);
      if (check.nickname === state.profile.nickname) return ok(state.profile);

      const startedAt = epoch;
      set({ saving: true });
      const saved = await accountApi.updateNickname(check.nickname);
      set({ saving: false });
      if (!saved.ok) {
        const code = saved.error.code;
        return code in NICKNAME_MESSAGES ? fail(code, NICKNAME_MESSAGES[code as keyof typeof NICKNAME_MESSAGES]) : saved;
      }
      // The account changed while the save was on its way: this answer is not for the current one.
      if (startedAt !== epoch || get().profile?.userId !== saved.value.userId) return NOT_READY;
      commit(saved.value);
      return saved;
    },

    linkGoogle: async () => {
      const { phase, verified, profile } = get();
      if (phase !== 'ready' || !verified || !profile) return NOT_READY;
      if (profile.googleLinked) return ok(profile);
      if (!begin('link')) return BUSY;
      try {
        const prior = await accountApi.restoreSession();
        if (!prior.ok) return prior;
        if (!prior.value) return NOT_READY;
        const linked = await accountApi.linkGoogle();
        if (!linked.ok) return linked;
        if (linked.value.userId !== profile.userId) {
          // Linking can never change the player. If it somehow did, undo it.
          await putBack(prior.value, null);
          return fail('OAUTH', 'Google sign-in did not complete. Nothing was changed.');
        }
        // The status changes only once the server says so.
        const confirmed = await accountApi.initProfile();
        if (!confirmed.ok || !confirmed.value.profile.googleLinked || confirmed.value.profile.userId !== profile.userId) {
          return fail('CONFIRM_PENDING', 'Google sign-in finished, but the link could not be confirmed yet. Check your connection and open Settings again.');
        }
        commit(confirmed.value.profile);
        return ok(confirmed.value.profile);
      } finally {
        set({ busy: null });
      }
    },

    restoreWithGoogle: async () => {
      const { phase, verified } = get();
      if (phase !== 'signedOut' && !(phase === 'ready' && verified)) return NOT_READY;
      if (!begin('restore')) return BUSY;
      try {
        const priorSession = phase === 'ready' ? await accountApi.restoreSession() : ok(null);
        if (!priorSession.ok) return priorSession;
        const prior = priorSession.value;

        const signedIn = await accountApi.signInWithGoogle();
        if (!signedIn.ok) return signedIn;
        const loaded = await accountApi.initProfile();
        if (!loaded.ok) {
          if (prior && prior.userId !== signedIn.value.userId) await putBack(prior, null);
          else if (!prior) {
            epoch += 1;
            unavailable(loaded.error);
          }
          return loaded;
        }
        if (prior && prior.userId !== signedIn.value.userId && loaded.value.created) {
          // Nobody was linked to that Google account: there is nothing to restore, and the
          // current account must not be traded for an empty one.
          await putBack(prior, signedIn.value.accessToken);
          return fail('NO_LINKED_ACCOUNT', 'No player is linked to that Google account. You’re still on your current account — use Link Google Account to protect it.');
        }
        if (!prior || prior.userId !== signedIn.value.userId) epoch += 1;
        commit(loaded.value.profile);
        return ok({ profile: loaded.value.profile, startedNew: loaded.value.created });
      } finally {
        set({ busy: null });
      }
    },

    reauthenticate: async () => {
      const { phase, verified, profile } = get();
      if (phase !== 'ready' || !verified || !profile) return NOT_READY;
      if (!begin('reauth')) return BUSY;
      try {
        const prior = await accountApi.restoreSession();
        if (!prior.ok) return prior;
        if (!prior.value) return NOT_READY;
        const signedIn = await accountApi.signInWithGoogle();
        if (!signedIn.ok) return signedIn;
        if (signedIn.value.userId === profile.userId) return ok(true);
        // A different Google account. Learn whether signing in created it, then undo everything.
        const other = await accountApi.initProfile();
        await putBack(prior.value, other.ok && other.value.created ? signedIn.value.accessToken : null);
        return fail('WRONG_GOOGLE_ACCOUNT', 'That isn’t the Google account linked to this player. Nothing was changed.');
      } finally {
        set({ busy: null });
      }
    },

    deleteAccount: async () => {
      const { phase, verified, profile } = get();
      if (phase !== 'ready' || !verified || !profile) return NOT_READY;
      if (!begin('delete')) return BUSY;
      try {
        // Written first: if the app is killed mid-request, the next launch knows to check.
        await writeStored(PENDING_DELETE_KEY, profile.userId);
        const deleted = await accountApi.deleteAccount();
        if (!deleted.ok) {
          if (deleted.error.code === 'REAUTH_REQUIRED') {
            await writeStored(PENDING_DELETE_KEY, null);
            return deleted;
          }
          // No clear answer. Only Supabase Auth saying the account is gone counts as deleted.
          const verdict = await accountApi.verifyUser();
          if (!(verdict.ok && verdict.value === 'gone')) {
            if (verdict.ok) await writeStored(PENDING_DELETE_KEY, null);
            return fail(deleted.error.code === 'SESSION_INVALID' ? 'SERVER' : deleted.error.code, 'Your account was not deleted. Please try again.');
          }
        }
        // Confirmed by the server. Only now is anything cleared on the phone.
        await signOutLocal();
        await forgetAccount();
        set({ phase: 'idle', error: null });
        return ok(true);
      } finally {
        set({ busy: null });
      }
    },

    startNewGuest: async () => {
      if (get().phase !== 'signedOut' || !begin('guest')) return;
      try {
        await forgetAccount();
        set({ phase: 'loading', error: null });
        await createGuest();
      } finally {
        set({ busy: null });
      }
    },

    handleSignedOut: () => {
      if (ownSignOut || get().busy) return;
      const { phase } = get();
      if (phase !== 'ready' && phase !== 'unavailable') return;
      epoch += 1;
      set({ phase: 'signedOut', verified: false, error: null });
    },
  };
});

/** Guest / Google-linked, or null while that is not known from the server. */
export function useAccountStatus(): AccountStatus | null {
  return useAccountStore((s) => accountStatusOf(s.profile, s.verified));
}

/** Test helper: forget everything held in memory (not the stored session). */
export function resetAccountStoreForTests(): void {
  flight = null;
  epoch = 0;
  ownSignOut = false;
  pendingRestore = null;
  useAccountStore.setState({ phase: 'idle', profile: null, verified: false, error: null, saving: false, busy: null });
}
