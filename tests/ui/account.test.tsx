/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import Home from '../../app/index';
import Account from '../../app/account';
import CreateGame from '../../app/create-game';
import { GUEST_WARNING } from '@/features/account/AccountView';
import { fail, ok, type Profile } from '@/features/account/types';
import { accountApi, type SessionInfo } from '@/lib/accountApi';
import { PENDING_DELETE_KEY, PROFILE_CACHE_KEY, resetAccountStoreForTests, useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { LEARNING_STORAGE_KEY } from '@/store/learningStore';
import { useSessionStore } from '@/store/sessionStore';
import { startupRouting } from '@/utils/startupRouting';

const api = accountApi as jest.Mocked<typeof accountApi>;

const GUEST: Profile = { userId: 'user-guest', playerId: 'RR-7K4P9X', nickname: 'Player4827', googleLinked: false };
const LINKED: Profile = { userId: 'user-linked', playerId: 'RR-M3HQ8Z', nickname: 'Asha', googleLinked: true };
const session = (userId: string): SessionInfo => ({ userId, accessToken: `access-${userId}`, refreshToken: `refresh-${userId}` });
const OFFLINE = fail('NETWORK', 'No connection. Check your internet and try again.');

const store = () => useAccountStore.getState();
const cached = async () => JSON.parse((await SecureStore.getItemAsync(PROFILE_CACHE_KEY)) ?? 'null') as Partial<Profile> | null;

/** A phone already signed in as `profile`, confirmed by the server. */
async function signedIn(profile: Profile) {
  api.restoreSession.mockResolvedValue(ok(session(profile.userId)));
  api.initProfile.mockResolvedValue(ok({ profile, created: false }));
  await act(() => store().initialize());
  expect(store().phase).toBe('ready');
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetAccountStoreForTests();
  for (const key of [PROFILE_CACHE_KEY, PENDING_DELETE_KEY, LEARNING_STORAGE_KEY]) await SecureStore.deleteItemAsync(key);
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  startupRouting.reset();
  // A phone with no network unless a test says otherwise.
  api.restoreSession.mockResolvedValue(OFFLINE);
  api.signInAnonymously.mockResolvedValue(OFFLINE);
  api.initProfile.mockResolvedValue(OFFLINE);
  api.verifyUser.mockResolvedValue(OFFLINE);
  api.updateNickname.mockResolvedValue(OFFLINE);
  api.linkGoogle.mockResolvedValue(OFFLINE);
  api.signInWithGoogle.mockResolvedValue(OFFLINE);
  api.restoreTokens.mockResolvedValue(OFFLINE);
  api.deleteAccount.mockResolvedValue(OFFLINE);
  api.signOutLocal.mockResolvedValue(undefined);
});

describe('account initialisation', () => {
  it('first launch: creates one guest account and its profile', async () => {
    api.restoreSession.mockResolvedValue(ok(null));
    api.signInAnonymously.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: true }));

    await store().initialize();

    expect(store()).toMatchObject({ phase: 'ready', verified: true, profile: GUEST, error: null });
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(await cached()).toEqual({ userId: GUEST.userId, playerId: GUEST.playerId, nickname: GUEST.nickname });
  });

  it('is idempotent: overlapping and repeated launches never create a second account', async () => {
    api.restoreSession.mockResolvedValueOnce(ok(null));
    api.signInAnonymously.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: true }));

    await Promise.all([store().initialize(), store().initialize(), store().initialize()]);
    expect(api.restoreSession).toHaveBeenCalledTimes(1);
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);

    // Every later launch finds the stored session.
    api.restoreSession.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: false }));
    await store().initialize();
    await store().initialize();
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(store().profile).toEqual(GUEST);
  });

  it('first launch without a network: nothing is created; a retry sets the account up', async () => {
    await store().initialize();
    expect(store()).toMatchObject({ phase: 'unavailable', profile: null, error: { code: 'NETWORK' } });
    expect(api.signInAnonymously).not.toHaveBeenCalled();

    // The session check works but creating the guest fails: still no account, still retryable.
    api.restoreSession.mockResolvedValue(ok(null));
    await store().initialize();
    expect(store().phase).toBe('unavailable');
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);

    api.signInAnonymously.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: true }));
    await store().initialize();
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST });
  });

  it('a returning player whose profile cannot be loaded keeps their account — no new guest', async () => {
    await signedIn(GUEST);
    resetAccountStoreForTests(); // app restart; the phone still remembers nickname + Player ID

    api.initProfile.mockResolvedValue(OFFLINE);
    await store().initialize();

    expect(store()).toMatchObject({ phase: 'unavailable', verified: false });
    expect(store().profile).toMatchObject({ nickname: GUEST.nickname, playerId: GUEST.playerId });
    expect(api.signInAnonymously).not.toHaveBeenCalled();
    expect(api.signOutLocal).not.toHaveBeenCalled();

    // A server error on the profile is treated the same way.
    api.initProfile.mockResolvedValue(fail('SERVER', 'The server had a problem.'));
    await store().initialize();
    expect(store().phase).toBe('unavailable');
    expect(api.signInAnonymously).not.toHaveBeenCalled();

    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: false }));
    await store().initialize();
    expect(store()).toMatchObject({ phase: 'ready', verified: true, profile: GUEST });
  });

  it('a refused token ends the session only when Supabase Auth confirms the account is gone', async () => {
    await signedIn(GUEST);
    resetAccountStoreForTests();
    api.initProfile.mockResolvedValue(fail('SESSION_INVALID', 'ended'));

    // Not confirmed (offline, or Auth says the session is fine): keep everything.
    api.verifyUser.mockResolvedValue(OFFLINE);
    await store().initialize();
    expect(store().phase).toBe('unavailable');
    api.verifyUser.mockResolvedValue(ok('valid'));
    await store().initialize();
    expect(store().phase).toBe('unavailable');
    expect(api.signOutLocal).not.toHaveBeenCalled();

    // Confirmed: signed out — and the player decides what happens next.
    api.verifyUser.mockResolvedValue(ok('gone'));
    await store().initialize();
    expect(store()).toMatchObject({ phase: 'signedOut', verified: false });
    expect(api.signOutLocal).toHaveBeenCalledTimes(1);
    expect(api.signInAnonymously).not.toHaveBeenCalled();
  });

  it('a phone that had an account and lost its session asks before starting a new guest', async () => {
    await signedIn(GUEST);
    resetAccountStoreForTests();
    api.restoreSession.mockResolvedValue(ok(null));

    await store().initialize();
    expect(store().phase).toBe('signedOut');
    expect(api.signInAnonymously).not.toHaveBeenCalled();

    const fresh: Profile = { userId: 'user-new', playerId: 'RR-NEW234', nickname: 'Player1111', googleLinked: false };
    api.signInAnonymously.mockResolvedValue(ok(session(fresh.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: fresh, created: true }));
    await store().startNewGuest();
    expect(store()).toMatchObject({ phase: 'ready', profile: fresh });
    expect((await cached())?.playerId).toBe(fresh.playerId);
  });

  it('Supabase Auth ending the session while the app is open signs the player out, nothing more', async () => {
    await signedIn(LINKED);
    await act(async () => store().handleSignedOut());
    expect(store()).toMatchObject({ phase: 'signedOut', verified: false });
    expect(api.signInAnonymously).not.toHaveBeenCalled();
  });
});

describe('nickname', () => {
  beforeEach(() => signedIn(GUEST));

  it('saves a valid change and updates the profile everywhere', async () => {
    api.updateNickname.mockResolvedValue(ok({ ...GUEST, nickname: 'Asha Rao' }));
    const result = await store().updateNickname('  Asha   Rao ');
    expect(result.ok).toBe(true);
    expect(api.updateNickname).toHaveBeenCalledWith('Asha Rao');
    expect(store().profile?.nickname).toBe('Asha Rao');
    expect((await cached())?.nickname).toBe('Asha Rao');
  });

  it('validates before sending, and an unchanged nickname is not sent', async () => {
    expect(await store().updateNickname('ab')).toMatchObject({ ok: false, error: { code: 'NICKNAME_TOO_SHORT' } });
    expect(await store().updateNickname('   ')).toMatchObject({ ok: false, error: { code: 'NICKNAME_EMPTY' } });
    expect(await store().updateNickname(` ${GUEST.nickname} `)).toMatchObject({ ok: true });
    expect(api.updateNickname).not.toHaveBeenCalled();
  });

  it('a second submission while one is on its way is refused', async () => {
    let finish!: (value: Awaited<ReturnType<typeof accountApi.updateNickname>>) => void;
    api.updateNickname.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = store().updateNickname('First Name');
    expect(store().saving).toBe(true);
    expect(await store().updateNickname('Second Name')).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    finish(ok({ ...GUEST, nickname: 'First Name' }));
    await first;
    expect(api.updateNickname).toHaveBeenCalledTimes(1);
    expect(store()).toMatchObject({ saving: false, profile: { nickname: 'First Name' } });
  });

  it('a failed or rejected save keeps the original nickname', async () => {
    expect(await store().updateNickname('New Name')).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
    api.updateNickname.mockResolvedValue(fail('NICKNAME_NOT_ALLOWED', 'NICKNAME_NOT_ALLOWED'));
    expect(await store().updateNickname('New Name')).toMatchObject({ ok: false, error: { code: 'NICKNAME_NOT_ALLOWED', message: expect.stringMatching(/isn’t allowed/) } });
    api.updateNickname.mockResolvedValue(fail('RATE_LIMITED', 'Too many changes', 3600));
    expect(await store().updateNickname('New Name')).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfterSeconds: 3600 } });
    expect(store().profile?.nickname).toBe(GUEST.nickname);
    expect(store().saving).toBe(false);
    // After the timeout, the same save can simply be tried again.
    api.updateNickname.mockResolvedValue(ok({ ...GUEST, nickname: 'New Name' }));
    expect((await store().updateNickname('New Name')).ok).toBe(true);
  });

  it('an answer that arrives after the account changed is dropped', async () => {
    let finish!: (value: Awaited<ReturnType<typeof accountApi.updateNickname>>) => void;
    api.updateNickname.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const saving = store().updateNickname('Late Answer');
    await act(async () => store().handleSignedOut());
    finish(ok({ ...GUEST, nickname: 'Late Answer' }));
    expect((await saving).ok).toBe(false);
    expect(store().phase).toBe('signedOut');
    expect(store().profile?.nickname).toBe(GUEST.nickname);
  });

  it('a realtime game update during a save touches neither store', async () => {
    useSessionStore.setState({ session: { gameId: 'g1', playerId: 'p1', token: 'a'.repeat(64) }, hydrated: true });
    useGameStore.getState().reset('g1');
    api.updateNickname.mockResolvedValue(ok({ ...GUEST, nickname: 'Mid Game' }));
    const saving = store().updateNickname('Mid Game');
    await act(async () => useGameStore.getState().setConnection('live'));
    await saving;
    expect(store().profile?.nickname).toBe('Mid Game');
    expect(useGameStore.getState()).toMatchObject({ gameId: 'g1', connection: 'live' });
    expect(useSessionStore.getState().session?.gameId).toBe('g1');
  });
});

describe('linking Google', () => {
  beforeEach(async () => {
    await signedIn(GUEST);
    api.restoreSession.mockResolvedValue(ok(session(GUEST.userId)));
  });

  it('links to the same player: same Player ID and nickname, status from the server', async () => {
    api.linkGoogle.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: { ...GUEST, googleLinked: true }, created: false }));
    const result = await store().linkGoogle();
    expect(result).toMatchObject({ ok: true, value: { playerId: GUEST.playerId, nickname: GUEST.nickname, googleLinked: true } });
    expect(store()).toMatchObject({ phase: 'ready', busy: null, profile: { userId: GUEST.userId, googleLinked: true } });
    expect(api.signInWithGoogle).not.toHaveBeenCalled();
  });

  it('works the same while a game is in progress, and leaves the game alone', async () => {
    useSessionStore.setState({ session: { gameId: 'g1', playerId: 'p1', token: 'a'.repeat(64) }, hydrated: true });
    useGameStore.getState().reset('g1');
    api.linkGoogle.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: { ...GUEST, googleLinked: true }, created: false }));
    expect((await store().linkGoogle()).ok).toBe(true);
    expect(useSessionStore.getState().session).toEqual({ gameId: 'g1', playerId: 'p1', token: 'a'.repeat(64) });
    expect(useGameStore.getState().gameId).toBe('g1');
  });

  it.each([
    ['cancelled', fail('CANCELLED', 'Google sign-in was cancelled.')],
    ['Google not configured', fail('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now.')],
    ['offline', OFFLINE],
    ['invalid token', fail('OAUTH', 'Google sign-in did not complete.')],
    ['Google account belongs to another player', fail('IDENTITY_IN_USE', 'That Google account is already linked to another player. Nothing was changed.')],
  ])('%s: the guest account is exactly as it was', async (_name, failure) => {
    api.linkGoogle.mockResolvedValue(failure);
    const result = await store().linkGoogle();
    expect(result).toEqual(failure);
    expect(store()).toMatchObject({ phase: 'ready', verified: true, busy: null, profile: GUEST });
    expect(api.signOutLocal).not.toHaveBeenCalled();
    expect(api.restoreTokens).not.toHaveBeenCalled();
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(api.signInWithGoogle).not.toHaveBeenCalled();
  });

  it('does not show "linked" until the server has confirmed it', async () => {
    api.linkGoogle.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(OFFLINE);
    expect(await store().linkGoogle()).toMatchObject({ ok: false, error: { code: 'CONFIRM_PENDING' } });
    expect(store().profile?.googleLinked).toBe(false);
    // The server still reports no Google identity: also not linked.
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: false }));
    expect(await store().linkGoogle()).toMatchObject({ ok: false, error: { code: 'CONFIRM_PENDING' } });
    expect(store().profile?.googleLinked).toBe(false);
  });

  it('a second tap while linking is in progress is refused; an already linked account is not linked again', async () => {
    let finish!: (value: Awaited<ReturnType<typeof accountApi.linkGoogle>>) => void;
    api.linkGoogle.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = store().linkGoogle();
    await waitFor(() => expect(api.linkGoogle).toHaveBeenCalledTimes(1));
    expect(await store().linkGoogle()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    api.initProfile.mockResolvedValue(ok({ profile: { ...GUEST, googleLinked: true }, created: false }));
    finish(ok(session(GUEST.userId)));
    expect((await first).ok).toBe(true);
    expect((await store().linkGoogle()).ok).toBe(true);
    expect(api.linkGoogle).toHaveBeenCalledTimes(1);
  });
});

describe('restoring with Google', () => {
  it('on a new phone: the linked player comes back with the same Player ID', async () => {
    await signedIn(GUEST); // the guest a fresh install starts with
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: LINKED, created: false }));

    const result = await store().restoreWithGoogle();

    expect(result).toMatchObject({ ok: true, value: { profile: LINKED, startedNew: false } });
    expect(store()).toMatchObject({ phase: 'ready', verified: true, profile: LINKED });
    expect((await cached())?.playerId).toBe(LINKED.playerId);
    expect(api.signInAnonymously).not.toHaveBeenCalled();
    expect(api.restoreTokens).not.toHaveBeenCalled();
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it('a Google account nobody linked: the current account is kept and the empty new one removed', async () => {
    await signedIn(GUEST);
    const stray: Profile = { userId: 'user-stray', playerId: 'RR-STRAY2', nickname: 'Player2222', googleLinked: true };
    api.signInWithGoogle.mockResolvedValue(ok(session(stray.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: stray, created: true }));
    api.restoreTokens.mockResolvedValue(ok(session(GUEST.userId)));
    api.deleteAccount.mockResolvedValue(ok(true));

    const result = await store().restoreWithGoogle();

    expect(result).toMatchObject({ ok: false, error: { code: 'NO_LINKED_ACCOUNT' } });
    expect(api.restoreTokens).toHaveBeenCalledWith(session(GUEST.userId));
    expect(api.deleteAccount).toHaveBeenCalledWith(session(stray.userId).accessToken);
    expect(store()).toMatchObject({ phase: 'ready', verified: true, profile: GUEST });
    expect((await cached())?.playerId).toBe(GUEST.playerId);
  });

  it('cancelling, or a failed sign-in, changes nothing', async () => {
    await signedIn(GUEST);
    api.signInWithGoogle.mockResolvedValue(fail('CANCELLED', 'Google sign-in was cancelled.'));
    expect(await store().restoreWithGoogle()).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST, busy: null });
    expect(api.restoreTokens).not.toHaveBeenCalled();
  });

  it('if the restored profile cannot be loaded, the previous session is put back', async () => {
    await signedIn(GUEST);
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    api.initProfile.mockResolvedValue(OFFLINE);
    api.restoreTokens.mockResolvedValue(ok(session(GUEST.userId)));
    expect((await store().restoreWithGoogle()).ok).toBe(false);
    expect(api.restoreTokens).toHaveBeenCalledWith(session(GUEST.userId));
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST });
  });

  it('a previous session that could not be put back is retried before anything else', async () => {
    await signedIn(GUEST);
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    api.initProfile.mockResolvedValue(OFFLINE);
    await store().restoreWithGoogle(); // restoreTokens fails (offline) every time
    expect(store().phase).toBe('unavailable');

    api.restoreTokens.mockClear().mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: GUEST, created: false }));
    await store().initialize();
    expect(api.restoreTokens).toHaveBeenCalledWith(session(GUEST.userId));
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST });
  });

  it('from a signed-out phone, the restored player becomes the account', async () => {
    await signedIn(LINKED);
    await act(async () => store().handleSignedOut());
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    const result = await store().restoreWithGoogle();
    expect(result).toMatchObject({ ok: true, value: { profile: LINKED, startedNew: false } });
    expect(store()).toMatchObject({ phase: 'ready', verified: true });
  });
});

describe('deleting the account', () => {
  it('clears the phone only after the server confirms', async () => {
    await signedIn(GUEST);
    useSessionStore.setState({ session: { gameId: 'g1', playerId: 'p1', token: 'a'.repeat(64) }, hydrated: true });
    useGameStore.getState().reset('g1');
    await SecureStore.setItemAsync(LEARNING_STORAGE_KEY, '{"completed":["l1"],"inProgress":{}}');

    let confirm!: (value: Awaited<ReturnType<typeof accountApi.deleteAccount>>) => void;
    api.deleteAccount.mockReturnValue(new Promise((resolve) => (confirm = resolve)));
    const deleting = store().deleteAccount();
    await waitFor(() => expect(api.deleteAccount).toHaveBeenCalledTimes(1));
    // Still waiting for the server: nothing has been cleared.
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST, busy: 'delete' });
    expect(api.signOutLocal).not.toHaveBeenCalled();
    expect(await cached()).not.toBeNull();
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBe(GUEST.userId);

    confirm(ok(true));
    expect((await deleting).ok).toBe(true);
    expect(api.signOutLocal).toHaveBeenCalledTimes(1);
    expect(store()).toMatchObject({ phase: 'idle', profile: null, verified: false, busy: null });
    expect(await cached()).toBeNull();
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBeNull();
    // Not account data: the game seat and lesson progress stay.
    expect(useSessionStore.getState().session?.gameId).toBe('g1');
    expect(useGameStore.getState().gameId).toBe('g1');
    expect(await SecureStore.getItemAsync(LEARNING_STORAGE_KEY)).toContain('l1');
  });

  it('a failed deletion deletes nothing and reports the failure', async () => {
    await signedIn(GUEST);
    api.deleteAccount.mockResolvedValue(fail('SERVER', 'Your account was not deleted.'));
    api.verifyUser.mockResolvedValue(ok('valid'));
    expect(await store().deleteAccount()).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not deleted/) } });
    expect(store()).toMatchObject({ phase: 'ready', verified: true, profile: GUEST, busy: null });
    expect(api.signOutLocal).not.toHaveBeenCalled();
    expect(await cached()).not.toBeNull();
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBeNull();
  });

  it('a lost answer is settled by asking Supabase Auth whether the account still exists', async () => {
    await signedIn(GUEST);
    // Unknown outcome and Auth unreachable: keep everything, remember to check at the next launch.
    expect((await store().deleteAccount()).ok).toBe(false);
    expect(store().profile).toEqual(GUEST);
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBe(GUEST.userId);
    // The retry: the request fails again, but Auth says the account is gone → it was deleted.
    api.verifyUser.mockResolvedValue(ok('gone'));
    expect((await store().deleteAccount()).ok).toBe(true);
    expect(store()).toMatchObject({ phase: 'idle', profile: null });
    expect(await cached()).toBeNull();
  });

  it('app closed during deletion: the next launch finishes it and only then starts a new guest', async () => {
    await signedIn(GUEST);
    await SecureStore.setItemAsync(PENDING_DELETE_KEY, GUEST.userId);
    resetAccountStoreForTests();

    api.initProfile.mockResolvedValueOnce(fail('SESSION_INVALID', 'ended'));
    api.verifyUser.mockResolvedValue(ok('gone'));
    const fresh: Profile = { userId: 'user-new', playerId: 'RR-NEW234', nickname: 'Player1111', googleLinked: false };
    api.signInAnonymously.mockResolvedValue(ok(session(fresh.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: fresh, created: true }));

    await store().initialize();

    expect(api.signOutLocal).toHaveBeenCalledTimes(1);
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(store()).toMatchObject({ phase: 'ready', profile: fresh });
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBeNull();
  });

  it('app closed before the deletion reached the server: the account is intact', async () => {
    await signedIn(GUEST);
    await SecureStore.setItemAsync(PENDING_DELETE_KEY, GUEST.userId);
    resetAccountStoreForTests();
    await store().initialize();
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST });
    expect(api.signInAnonymously).not.toHaveBeenCalled();
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBeNull();
  });

  it('a linked account must confirm with the SAME Google account first', async () => {
    await signedIn(LINKED);
    api.restoreSession.mockResolvedValue(ok(session(LINKED.userId)));
    api.deleteAccount.mockResolvedValue(fail('REAUTH_REQUIRED', 'Confirm with Google to delete this account.'));
    expect(await store().deleteAccount()).toMatchObject({ ok: false, error: { code: 'REAUTH_REQUIRED' } });
    expect(store().profile).toEqual(LINKED);
    expect(await SecureStore.getItemAsync(PENDING_DELETE_KEY)).toBeNull();

    // A different Google account: undone, nothing deleted.
    api.signInWithGoogle.mockResolvedValue(ok(session('user-other')));
    api.initProfile.mockResolvedValue(ok({ profile: { ...GUEST, userId: 'user-other' }, created: false }));
    api.restoreTokens.mockResolvedValue(ok(session(LINKED.userId)));
    expect(await store().reauthenticate()).toMatchObject({ ok: false, error: { code: 'WRONG_GOOGLE_ACCOUNT' } });
    expect(api.restoreTokens).toHaveBeenCalledWith(session(LINKED.userId));
    expect(store()).toMatchObject({ phase: 'ready', profile: LINKED });

    // The right one: confirmed.
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    expect(await store().reauthenticate()).toEqual(ok(true));
  });
});

describe('Home', () => {
  it('shows the compact profile entry and opens Settings', async () => {
    await signedIn(GUEST);
    await render(<Home />);
    expect(screen.getByTestId('profile-entry-name')).toHaveTextContent('Player4827');
    expect(screen.getByTestId('profile-entry-detail')).toHaveTextContent('RR-7K4P9X · Guest');
    await fireEvent.press(screen.getByTestId('profile-entry'));
    expect(router.push).toHaveBeenCalledWith('/account');
  });

  it('shows a linked account as linked — and never from memory alone', async () => {
    await signedIn(LINKED);
    const view = await render(<Home />);
    expect(screen.getByTestId('profile-entry-detail')).toHaveTextContent('RR-M3HQ8Z · Google linked');
    await view.unmount();

    // Next launch, offline: the nickname is remembered, the link status is not claimed.
    resetAccountStoreForTests();
    api.initProfile.mockResolvedValue(OFFLINE);
    await act(() => store().initialize());
    await render(<Home />);
    expect(screen.getByTestId('profile-entry-name')).toHaveTextContent('Asha');
    expect(screen.getByTestId('profile-entry-detail')).toHaveTextContent('RR-M3HQ8Z · Offline');
    expect(screen.getByTestId('profile-entry-detail')).not.toHaveTextContent(/linked/i);
  });

  it('never blocks playing: every existing action is there and navigates, whatever the account state', async () => {
    await render(<Home />); // no account at all yet
    expect(screen.getByTestId('profile-entry-name')).toHaveTextContent('Setting up your profile…');
    const routes: [string, string][] = [
      ['create-game', '/create-game'],
      ['join-game', '/join-game'],
      ['open-learning', '/learning'],
      ['open-rules', '/settings'],
    ];
    for (const [testID, route] of routes) {
      await fireEvent.press(screen.getByTestId(testID));
      expect(router.push).toHaveBeenLastCalledWith(route);
    }
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('the name for a new game starts from the nickname', async () => {
    await signedIn({ ...GUEST, nickname: 'Asha Rao' });
    await render(<CreateGame />);
    expect(screen.getByTestId('host-name').props.value).toBe('Asha Rao');
  });
});

describe('Settings screen', () => {
  it('guest: profile, status, the recovery warning and the link action', async () => {
    await signedIn(GUEST);
    await render(<Account />);
    expect(screen.getByTestId('nickname-input').props.value).toBe('Player4827');
    expect(screen.getByTestId('player-id')).toHaveTextContent('RR-7K4P9X');
    expect(screen.getByTestId('account-status')).toHaveTextContent('Guest account — not linked');
    expect(screen.getByTestId('guest-warning')).toHaveTextContent(GUEST_WARNING);
    expect(screen.getByTestId('link-google')).toBeTruthy();
    expect(screen.getByTestId('delete-account')).toBeTruthy();
    expect(screen.queryByTestId('recovery-info')).toBeNull();
  });

  it('linked: no warning, no link action, recovery information instead', async () => {
    await signedIn(LINKED);
    await render(<Account />);
    expect(screen.getByTestId('account-status')).toHaveTextContent('Google account linked');
    expect(screen.queryByTestId('guest-warning')).toBeNull();
    expect(screen.queryByTestId('link-google')).toBeNull();
    expect(screen.getByTestId('recovery-info')).toBeTruthy();
  });

  it('loading, offline and signed-out states are stated plainly', async () => {
    const view = await render(<Account />);
    expect(screen.getByTestId('account-loading')).toBeTruthy();
    await view.unmount();

    // Offline with a remembered profile: shown, but not editable and not claimed as linked.
    await signedIn(LINKED);
    resetAccountStoreForTests();
    api.initProfile.mockResolvedValue(OFFLINE);
    await act(() => store().initialize());
    const offline = await render(<Account />);
    expect(screen.getByTestId('account-unavailable')).toHaveTextContent(/Nothing has been lost/);
    expect(screen.getByTestId('account-status')).toHaveTextContent(/unknown/i);
    expect(screen.getByTestId('account-status')).not.toHaveTextContent(/Google account linked/);
    expect(screen.getByTestId('nickname-input').props.editable).toBe(false);
    expect(screen.getByTestId('delete-account')).toBeDisabled();
    api.initProfile.mockResolvedValue(ok({ profile: LINKED, created: false }));
    await fireEvent.press(screen.getByTestId('account-retry'));
    await waitFor(() => expect(screen.getByTestId('account-status')).toHaveTextContent('Google account linked'));
    await offline.unmount();

    await act(async () => store().handleSignedOut());
    await render(<Account />);
    expect(screen.getByTestId('account-signed-out')).toHaveTextContent(/cannot be recovered/);
    expect(screen.getByTestId('restore-google')).toBeTruthy();
    expect(screen.getByTestId('new-guest')).toBeTruthy();
    expect(screen.queryByTestId('delete-account')).toBeNull();
  });

  it('nickname: counter, validation beside the field, Save only for a valid change', async () => {
    await signedIn(GUEST);
    await render(<Account />);
    expect(screen.getByTestId('nickname-counter')).toHaveTextContent('10/20');
    expect(screen.getByTestId('nickname-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('nickname-input'), 'ab');
    expect(screen.getByTestId('nickname-counter')).toHaveTextContent('2/20');
    expect(screen.getByText('Use at least 3 characters.')).toBeTruthy();
    expect(screen.getByTestId('nickname-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('nickname-input'), 'x'.repeat(21));
    expect(screen.getByText('Use 20 characters or fewer.')).toBeTruthy();
    expect(screen.getByTestId('nickname-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('nickname-input'), '  Player4827 ');
    expect(screen.getByTestId('nickname-save')).toBeDisabled(); // the same nickname is not a change

    await fireEvent.changeText(screen.getByTestId('nickname-input'), 'Asha Rao');
    expect(screen.getByTestId('nickname-save')).not.toBeDisabled();
    expect(api.updateNickname).not.toHaveBeenCalled();
  });

  it('nickname: saving confirms after the server does; a failure keeps the old nickname', async () => {
    await signedIn(GUEST);
    await render(<Account />);

    api.updateNickname.mockResolvedValue(fail('NICKNAME_NOT_ALLOWED', 'NICKNAME_NOT_ALLOWED'));
    await fireEvent.changeText(screen.getByTestId('nickname-input'), 'Rude Name');
    await fireEvent.press(screen.getByTestId('nickname-save'));
    await waitFor(() => expect(screen.getByText(/isn’t allowed/)).toBeTruthy());
    expect(screen.queryByTestId('nickname-saved')).toBeNull();
    expect(store().profile?.nickname).toBe('Player4827');

    let finish!: (value: Awaited<ReturnType<typeof accountApi.updateNickname>>) => void;
    api.updateNickname.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await fireEvent.changeText(screen.getByTestId('nickname-input'), ' Asha  Rao ');
    await fireEvent.press(screen.getByTestId('nickname-save'));
    // On its way: the button is busy and a second tap sends nothing.
    await waitFor(() => expect(screen.getByTestId('nickname-save')).toBeDisabled());
    await fireEvent.press(screen.getByTestId('nickname-save'));
    expect(api.updateNickname).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('nickname-saved')).toBeNull();

    await act(async () => finish(ok({ ...GUEST, nickname: 'Asha Rao' })));
    await waitFor(() => expect(screen.getByTestId('nickname-saved')).toBeTruthy());
    expect(api.updateNickname).toHaveBeenLastCalledWith('Asha Rao');
    expect(screen.getByTestId('nickname-input').props.value).toBe('Asha Rao');
    expect(store().profile?.nickname).toBe('Asha Rao');
  });

  it('copies the Player ID', async () => {
    await signedIn(GUEST);
    await render(<Account />);
    await fireEvent.press(screen.getByTestId('copy-player-id'));
    await waitFor(() => expect(screen.getByText('✓ Copied')).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('RR-7K4P9X');
  });

  it('linking Google: success and failure are both shown, and failure changes nothing', async () => {
    await signedIn(GUEST);
    api.restoreSession.mockResolvedValue(ok(session(GUEST.userId)));
    await render(<Account />);

    api.linkGoogle.mockResolvedValue(fail('IDENTITY_IN_USE', 'That Google account is already linked to another player. Nothing was changed.'));
    await fireEvent.press(screen.getByTestId('link-google'));
    await waitFor(() => expect(screen.getByTestId('link-error')).toHaveTextContent(/already linked to another player/));
    expect(screen.getByTestId('account-status')).toHaveTextContent('Guest account — not linked');
    expect(screen.getByTestId('guest-warning')).toBeTruthy();

    // Cancelling is not an error worth a message.
    api.linkGoogle.mockResolvedValue(fail('CANCELLED', 'Google sign-in was cancelled.'));
    await fireEvent.press(screen.getByTestId('link-google'));
    await waitFor(() => expect(screen.queryByTestId('link-error')).toBeNull());

    api.linkGoogle.mockResolvedValue(ok(session(GUEST.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: { ...GUEST, googleLinked: true }, created: false }));
    await fireEvent.press(screen.getByTestId('link-google'));
    await waitFor(() => expect(screen.getByTestId('link-success')).toHaveTextContent(/Player ID and nickname are unchanged/));
    expect(screen.getByTestId('account-status')).toHaveTextContent('Google account linked');
    expect(screen.getByTestId('player-id')).toHaveTextContent('RR-7K4P9X');
    expect(screen.queryByTestId('guest-warning')).toBeNull();
    expect(screen.queryByTestId('link-google')).toBeNull();
  });

  it('restoring another account asks first, and says what a guest would lose', async () => {
    await signedIn(GUEST);
    await render(<Account />);
    await fireEvent.press(screen.getByTestId('restore-google'));
    expect(screen.getByTestId('restore-dialog')).toHaveTextContent(/permanently lose access/);
    expect(screen.getByTestId('restore-dialog')).toHaveTextContent(/never merged/);
    await fireEvent.press(screen.getByTestId('restore-dialog-cancel'));
    expect(api.signInWithGoogle).not.toHaveBeenCalled();
    expect(store().profile).toEqual(GUEST);

    api.restoreSession.mockResolvedValue(ok(session(GUEST.userId)));
    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: LINKED, created: false }));
    await fireEvent.press(screen.getByTestId('restore-google'));
    await fireEvent.press(screen.getByTestId('restore-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('player-id')).toHaveTextContent('RR-M3HQ8Z'));
    expect(screen.getByTestId('nickname-input').props.value).toBe('Asha');
    expect(screen.getByTestId('account-status')).toHaveTextContent('Google account linked');
  });

  it('deleting: explained, cancellable, and needs the typed word', async () => {
    await signedIn(GUEST);
    await render(<Account />);

    await fireEvent.press(screen.getByTestId('delete-account'));
    const explanation = screen.getByTestId('delete-explanation');
    expect(explanation).toHaveTextContent(/permanent/i);
    expect(explanation).toHaveTextContent(/RR-7K4P9X/);
    expect(explanation).toHaveTextContent(/not the same as uninstalling/);
    await fireEvent.press(screen.getByTestId('delete-cancel'));
    expect(screen.queryByTestId('delete-explanation')).toBeNull();

    await fireEvent.press(screen.getByTestId('delete-account'));
    await fireEvent.press(screen.getByTestId('delete-continue'));
    expect(screen.getByTestId('delete-final')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'delet');
    expect(screen.getByTestId('delete-final')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('delete-final'));
    await fireEvent.press(screen.getByTestId('delete-cancel'));

    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(store()).toMatchObject({ phase: 'ready', profile: GUEST });
  });

  it('deleting: a failure is shown and nothing is cleared; success returns to the start', async () => {
    await signedIn(GUEST);
    await render(<Account />);
    await fireEvent.press(screen.getByTestId('delete-account'));
    await fireEvent.press(screen.getByTestId('delete-continue'));
    await fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'DELETE');

    api.deleteAccount.mockResolvedValue(fail('SERVER', 'Your account was not deleted.'));
    api.verifyUser.mockResolvedValue(ok('valid'));
    await fireEvent.press(screen.getByTestId('delete-final'));
    await waitFor(() => expect(screen.getByTestId('delete-error')).toHaveTextContent(/not deleted/));
    expect(router.replace).not.toHaveBeenCalled();
    expect(store().profile).toEqual(GUEST);

    // Second attempt succeeds; only then does the phone start over as a new guest.
    api.deleteAccount.mockResolvedValue(ok(true));
    const fresh: Profile = { userId: 'user-new', playerId: 'RR-NEW234', nickname: 'Player1111', googleLinked: false };
    api.restoreSession.mockResolvedValue(ok(null));
    api.signInAnonymously.mockResolvedValue(ok(session(fresh.userId)));
    api.initProfile.mockResolvedValue(ok({ profile: fresh, created: true }));
    await fireEvent.press(screen.getByTestId('delete-final'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.signOutLocal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store().profile).toEqual(fresh));
    expect(api.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().notice?.message).toMatch(/deleted/);
  });

  it('deleting a linked account: asks for Google when the server requires it', async () => {
    await signedIn(LINKED);
    api.restoreSession.mockResolvedValue(ok(session(LINKED.userId)));
    await render(<Account />);
    await fireEvent.press(screen.getByTestId('delete-account'));
    expect(screen.getByTestId('delete-explanation')).toHaveTextContent(/Google account is disconnected/);
    await fireEvent.press(screen.getByTestId('delete-continue'));
    await fireEvent.changeText(screen.getByTestId('delete-confirm-input'), 'delete');

    api.deleteAccount.mockResolvedValueOnce(fail('REAUTH_REQUIRED', 'Confirm with Google to delete this account.'));
    await fireEvent.press(screen.getByTestId('delete-final'));
    await waitFor(() => expect(screen.getByTestId('delete-reauth')).toBeTruthy());
    expect(store().profile).toEqual(LINKED);

    api.signInWithGoogle.mockResolvedValue(ok(session(LINKED.userId)));
    api.deleteAccount.mockResolvedValue(ok(true));
    await fireEvent.press(screen.getByTestId('delete-reauth'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(api.deleteAccount).toHaveBeenCalledTimes(2);
  });
});
