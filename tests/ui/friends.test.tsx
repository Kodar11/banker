/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AppState, Share, type AppStateStatus } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Home from '../../app/index';
import Friends from '../../app/friends';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
import type { Profile } from '@/features/account/types';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { PlayerDetailsActions } from '@/features/player/PlayerDetails';
import { SocialHost } from '@/features/social/SocialHost';
import { PRESENCE_OFFLINE_GRACE_MS } from '@/features/social/logic';
import type { Friend, FriendRequest, GameInvite, SeatProfile, SocialError, SocialNotification, SocialState } from '@/features/social/types';
import { gameApi } from '@/lib/gameApi';
import type { ChannelHealth } from '@/lib/realtime';
import { socialApi } from '@/lib/socialApi';
import { subscribeToSocialSync, trackOwnPresence, watchPresence, type PresenceEvent, type SocialSyncHandlers } from '@/lib/socialRealtime';
import { resetAccountStoreForTests, useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { resetSocialStoreForTests, useSocialStore } from '@/store/socialStore';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture, ok as okSnapshot } from './fixtures';

const api = socialApi as jest.Mocked<typeof socialApi>;
const game = gameApi as jest.Mocked<typeof gameApi>;
const syncMock = subscribeToSocialSync as jest.MockedFunction<typeof subscribeToSocialSync>;
const trackMock = trackOwnPresence as jest.MockedFunction<typeof trackOwnPresence>;
const watchMock = watchPresence as jest.MockedFunction<typeof watchPresence>;

const ME: Profile = { userId: 'user-me', playerId: 'RR-22222M', nickname: 'Me', googleLinked: false };
const OTHER_ACCOUNT: Profile = { userId: 'user-other', playerId: 'RR-33333N', nickname: 'Other', googleLinked: true };

const FARAH: Friend = { playerId: 'RR-FFFFF2', nickname: 'Farah', presenceKey: 'key-farah', since: '2026-10-01T00:00:00.000Z' };
const GAURI: Friend = { playerId: 'RR-GGGGG2', nickname: 'Gauri', presenceKey: 'key-gauri', since: '2026-10-02T00:00:00.000Z' };

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
const MINUTE = 60_000;
const DAY = 86_400_000;

const requestFrom = (playerId: string, nickname: string, id = `req-${playerId}`): FriendRequest => ({ id, playerId, nickname, createdAt: soon(-MINUTE), expiresAt: soon(30 * DAY) });
const BILAL = requestFrom('RR-BBBBB2', 'Bilal');
const ASHA = requestFrom('RR-AAAAA2', 'Asha');

const invite = (overrides: Partial<GameInvite> = {}): GameInvite => ({
  id: 'inv-1',
  state: 'open',
  mode: 'intermediate',
  players: 3,
  capacity: 8,
  inviter: { playerId: FARAH.playerId, nickname: FARAH.nickname },
  createdAt: soon(-MINUTE),
  expiresAt: soon(14 * MINUTE),
  ...overrides,
});

const note = (id: string, type: SocialNotification['type'], nickname = 'Farah', read = false): SocialNotification => ({
  id,
  type,
  actor: { playerId: FARAH.playerId, nickname },
  entityId: null,
  createdAt: soon(-1000),
  read,
});

let version = 1;
/** A server answer. Every one is newer than the last, as on the real server after a change. */
function serverState(overrides: Partial<SocialState> = {}): SocialState {
  version += 1;
  return {
    version,
    serverTime: new Date().toISOString(),
    me: { playerId: ME.playerId, presenceKey: 'key-me' },
    friends: [],
    incoming: [],
    outgoing: [],
    blocked: [],
    invites: [],
    sentInvites: [],
    notifications: [],
    unread: 0,
    ...overrides,
  };
}

const good = <T,>(value: T) => ({ ok: true as const, value });
const bad = (code: SocialError['code'], message: string) => ({ ok: false as const, error: { code, message } });
const OFFLINE = bad('NETWORK', 'No connection. Check your internet and try again.');
const DONE = good(true as const);

/** What the server will answer next time the phone asks for its social state. */
const serverHas = (overrides: Partial<SocialState> = {}) => api.state.mockResolvedValue(good(serverState(overrides)));

async function signIn(profile: Profile | null) {
  await act(async () => {
    useAccountStore.setState(profile ? { phase: 'ready', verified: true, profile, error: null } : { phase: 'signedOut', verified: false, profile: null });
  });
}

const social = () => useSocialStore.getState();

/** The account is signed in and its social data has loaded, as after app start. */
async function loaded(overrides: Partial<SocialState> = {}) {
  serverHas(overrides);
  useAccountStore.setState({ phase: 'ready', verified: true, profile: ME, error: null });
  social().attach(ME.userId);
  await act(() => social().refresh());
  expect(social().phase).toBe('ready');
}

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
  const current = snapshot.state.players.find((p) => p.id === snapshot.state.turn.playerId) ?? null;
  return {
    snapshot,
    me,
    current,
    isMyTurn: !!me && current?.id === me.id && snapshot.state.status === 'ACTIVE',
    isHost: !!me?.isHost,
    playerName: (id) => snapshot.state.players.find((p) => p.id === id)?.name ?? 'Bank',
    myNetWorth: me ? netWorth(snapshot.state, me.id) : 0,
    myDebt: me ? outstandingDebt(snapshot.state.loans, me.id) : 0,
  };
}

const seatOf = (f: Fixture, name: string, player: { playerId: string; nickname: string } | null): SeatProfile => ({ seatId: f.ids[name]!, unavailable: !player, player });

const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));

/** The app moving between foreground and background, as every mounted listener hears it. */
let appStateListeners: ((next: AppStateStatus) => void)[] = [];
const appState = (next: AppStateStatus) => act(async () => appStateListeners.forEach((listener) => listener(next)));
const disabled = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.disabled === true;

beforeEach(() => {
  jest.clearAllMocks();
  resetAccountStoreForTests();
  resetSocialStoreForTests();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  startupRouting.reset();
  version = 1;
  for (const call of Object.values(api)) (call as jest.Mock).mockResolvedValue(OFFLINE);
  syncMock.mockImplementation(() => () => undefined);
  trackMock.mockImplementation(() => () => undefined);
  watchMock.mockImplementation(() => () => undefined);
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    const listener = handler as (next: AppStateStatus) => void;
    appStateListeners.push(listener);
    return { remove: () => void (appStateListeners = appStateListeners.filter((l) => l !== listener)) } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// =============================================================================================
describe('Home', () => {
  it('has a Friends entry next to every existing action, and it opens Friends', async () => {
    await render(<Home />);
    for (const testID of ['create-game', 'join-game', 'open-learning', 'open-rules', 'open-friends']) expect(screen.getByTestId(testID)).toBeTruthy();
    expect(screen.queryByTestId('friends-badge')).toBeNull();
    await press('open-friends');
    expect(router.push).toHaveBeenLastCalledWith('/friends');
  });

  it('badge: requests to answer + invitations that can be joined + unseen news, each counted once', async () => {
    await loaded({
      incoming: [BILAL],
      invites: [invite(), invite({ id: 'inv-2', state: 'started' })],
      notifications: [note('n1', 'friend_request', 'Bilal'), note('n2', 'game_invite'), note('n3', 'friend_accepted'), note('n4', 'friends_matched', 'Farah', true)],
      unread: 3,
    });
    await render(<Home />);
    expect(screen.getByTestId('friends-badge')).toHaveTextContent('3');
    expect(screen.getByTestId('open-friends').props.accessibilityHint).toBe('1 friend request, 1 game invitation');
  });
});

// =============================================================================================
describe('Friends screen: loading, empty, error', () => {
  it('shows loading until the server answers, then the empty state — and asks the server on opening', async () => {
    let answer: (value: Awaited<ReturnType<typeof api.state>>) => void = () => undefined;
    api.state.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    useAccountStore.setState({ phase: 'ready', verified: true, profile: ME });
    social().attach(ME.userId);

    await render(<Friends />);
    expect(screen.getByTestId('friends-loading')).toBeTruthy();
    expect(screen.queryByTestId('friends-empty')).toBeNull();
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(disabled('friends-add')).toBe(true);

    await act(async () => answer(good(serverState())));
    expect(screen.getByTestId('friends-empty')).toHaveTextContent(/No friends yet/);
    expect(screen.queryByTestId('friends-loading')).toBeNull();
    for (const tab of ['friends', 'requests', 'invites']) expect(screen.getByTestId(`friends-tab-${tab}`)).toBeTruthy();

    await press('friends-tab-requests');
    expect(screen.getByTestId('requests-incoming-empty')).toBeTruthy();
    expect(screen.getByTestId('requests-outgoing-empty')).toBeTruthy();
    await press('friends-tab-invites');
    expect(screen.getByTestId('invites-empty')).toBeTruthy();
  });

  it('first load fails: an error with Retry, and Retry loads', async () => {
    useAccountStore.setState({ phase: 'ready', verified: true, profile: ME });
    social().attach(ME.userId);
    await render(<Friends />);
    await waitFor(() => expect(screen.getByTestId('friends-error')).toBeTruthy());
    expect(screen.getByTestId('friends-error')).toHaveTextContent(/No connection/);

    serverHas({ friends: [FARAH] });
    await press('friends-retry');
    await waitFor(() => expect(screen.getByTestId(`friend-row-${FARAH.playerId}`)).toBeTruthy());
    expect(screen.queryByTestId('friends-error')).toBeNull();
  });

  it('a later refresh that fails keeps what was loaded and says it may be out of date', async () => {
    await loaded({ friends: [FARAH] });
    api.state.mockResolvedValue(OFFLINE);
    await render(<Friends />);
    await waitFor(() => expect(screen.getByTestId('friends-stale')).toBeTruthy());
    expect(screen.getByTestId(`friend-row-${FARAH.playerId}`)).toBeTruthy();

    serverHas({ friends: [FARAH, GAURI] });
    await press('friends-stale-retry');
    await waitFor(() => expect(screen.getByTestId(`friend-row-${GAURI.playerId}`)).toBeTruthy());
    expect(screen.queryByTestId('friends-stale')).toBeNull();
  });

  it('pull to refresh asks the server again', async () => {
    await loaded({ friends: [FARAH] });
    await render(<Friends />);
    await waitFor(() => expect(api.state).toHaveBeenCalledTimes(2));
    serverHas({ friends: [FARAH, GAURI] });
    await act(async () => screen.getByTestId('friends-scroll').props.refreshControl.props.onRefresh());
    await waitFor(() => expect(screen.getByTestId(`friend-row-${GAURI.playerId}`)).toBeTruthy());
  });

  it('without a confirmed account there is nothing to show, and a way to fix it', async () => {
    await signIn(null);
    await render(<Friends />);
    expect(screen.getByTestId('friends-no-account')).toHaveTextContent(/signed out/);
    await press('friends-open-account');
    expect(router.push).toHaveBeenLastCalledWith('/account');
    expect(api.state).not.toHaveBeenCalled();
  });
});

// =============================================================================================
describe('Add Friend: Player ID lookup and requests', () => {
  const open = async (overrides: Partial<SocialState> = {}) => {
    await loaded(overrides);
    await render(<Friends />);
    await press('friends-add');
    expect(screen.getByTestId('add-friend-own-id')).toHaveTextContent(new RegExp(ME.playerId));
  };
  const type = (text: string) => fireEvent.changeText(screen.getByTestId('add-friend-input'), text);

  it('refuses an empty or malformed ID on the phone, without asking the server', async () => {
    await open();
    await press('add-friend-find');
    expect(screen.getByText('Enter a Player ID.')).toBeTruthy();
    await type('hello there');
    await press('add-friend-find');
    expect(screen.getByText('A Player ID looks like RR-7K4P9X.')).toBeTruthy();
    expect(api.lookup).not.toHaveBeenCalled();
    expect(screen.queryByTestId('add-friend-result')).toBeNull();
  });

  it('normalises what was typed, looks it up, and shows only the public profile', async () => {
    await open();
    api.lookup.mockResolvedValue(good({ player: { playerId: ASHA.playerId, nickname: 'Asha' }, relationship: 'none' }));
    await type('  rr aaaaa2 ');
    await press('add-friend-find');
    await waitFor(() => expect(screen.getByTestId('add-friend-result')).toBeTruthy());
    expect(api.lookup).toHaveBeenCalledWith(ASHA.playerId);
    expect(screen.getByTestId('add-friend-input').props.value).toBe(ASHA.playerId);
    expect(screen.getByTestId('add-friend-result')).toHaveTextContent(/Asha.*RR-AAAAA2/);
    expect(screen.getByTestId('add-friend-send')).toBeTruthy();
  });

  it('reports not found, a lost connection and a rate limit in plain words', async () => {
    await open();
    await type(ASHA.playerId);
    for (const failure of [
      bad('NOT_FOUND', 'No player has that Player ID. Check it and try again.'),
      OFFLINE,
      bad('RATE_LIMITED', 'Too many attempts. Try again in 42 seconds.'),
    ]) {
      api.lookup.mockResolvedValue(failure);
      await press('add-friend-find');
      await waitFor(() => expect(screen.getByText(failure.error.message)).toBeTruthy());
      expect(screen.queryByTestId('add-friend-result')).toBeNull();
    }
  });

  it('shows the right state for myself, a friend, a request either way and someone I blocked', async () => {
    await open({ friends: [FARAH], incoming: [BILAL], outgoing: [ASHA], blocked: [{ playerId: 'RR-CCCCC2', nickname: 'Chitra' }] });
    const find = async (playerId: string, nickname: string, relationship: 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none') => {
      api.lookup.mockResolvedValue(good({ player: { playerId, nickname }, relationship }));
      await type(playerId);
      await press('add-friend-find');
      await waitFor(() => expect(screen.getByTestId('add-friend-result')).toHaveTextContent(new RegExp(nickname)));
    };
    await find(ME.playerId, 'Me', 'self');
    expect(screen.getByTestId('add-friend-state')).toHaveTextContent(/your own Player ID/);
    await find(FARAH.playerId, 'Farah', 'friends');
    expect(screen.getByTestId('add-friend-state')).toHaveTextContent(/Friends/);
    await find(ASHA.playerId, 'Asha', 'outgoing');
    expect(screen.getByTestId('add-friend-state')).toHaveTextContent('Request Sent');
    expect(disabled('add-friend-state')).toBe(true);
    await find(BILAL.playerId, 'Bilal', 'incoming');
    expect(screen.getByTestId('add-friend-accept')).toBeTruthy();
    await find('RR-CCCCC2', 'Chitra', 'blocked');
    expect(screen.getByTestId('add-friend-unblock')).toBeTruthy();
    // Never two contradictory actions at once.
    expect(screen.queryByTestId('add-friend-send')).toBeNull();
  });

  it('sending: nothing is claimed until the server confirms; then "Request Sent" and the Sent list', async () => {
    await open();
    api.lookup.mockResolvedValue(good({ player: { playerId: ASHA.playerId, nickname: 'Asha' }, relationship: 'none' }));
    await type(ASHA.playerId);
    await press('add-friend-find');
    await waitFor(() => expect(screen.getByTestId('add-friend-send')).toBeTruthy());

    let confirm: (value: Awaited<ReturnType<typeof api.sendRequest>>) => void = () => undefined;
    api.sendRequest.mockReturnValue(new Promise((resolve) => (confirm = resolve)));
    await press('add-friend-send');
    // On its way: the button is busy, a second tap does nothing, and nothing says "sent".
    expect(screen.getByTestId('add-friend-send').props.accessibilityState).toMatchObject({ busy: true });
    await press('add-friend-send');
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
    expect(api.sendRequest).toHaveBeenCalledWith(ASHA.playerId);
    expect(screen.queryByTestId('add-friend-notice')).toBeNull();
    expect(screen.queryByText('Request Sent')).toBeNull();

    serverHas({ outgoing: [ASHA] });
    await act(async () => confirm(good({ relationship: 'outgoing', matched: false })));
    await waitFor(() => expect(screen.getByTestId('add-friend-notice')).toHaveTextContent('Friend request sent to Asha.'));
    expect(screen.getByTestId('add-friend-state')).toHaveTextContent('Request Sent');
    expect(social().data?.outgoing.map((r) => r.playerId)).toEqual([ASHA.playerId]);
  });

  it('a refused request changes nothing and says why', async () => {
    await open();
    api.lookup.mockResolvedValue(good({ player: { playerId: ASHA.playerId, nickname: 'Asha' }, relationship: 'none' }));
    await type(ASHA.playerId);
    await press('add-friend-find');
    await waitFor(() => expect(screen.getByTestId('add-friend-send')).toBeTruthy());
    serverHas();
    api.sendRequest.mockResolvedValue(bad('UNAVAILABLE', 'You can’t do that with this player right now.'));
    await press('add-friend-send');
    await waitFor(() => expect(screen.getByText('You can’t do that with this player right now.')).toBeTruthy());
    expect(screen.queryByTestId('add-friend-notice')).toBeNull();
    expect(screen.getByTestId('add-friend-send')).toBeTruthy();
  });

  it('reciprocal: they had already asked — sending makes us friends at once, with no accept step', async () => {
    await open();
    api.lookup.mockResolvedValue(good({ player: { playerId: BILAL.playerId, nickname: 'Bilal' }, relationship: 'none' }));
    await type(BILAL.playerId);
    await press('add-friend-find');
    await waitFor(() => expect(screen.getByTestId('add-friend-send')).toBeTruthy());

    const bilal: Friend = { playerId: BILAL.playerId, nickname: 'Bilal', presenceKey: 'key-bilal', since: soon(0) };
    serverHas({ friends: [bilal], notifications: [note('m1', 'friends_matched', 'Bilal')], unread: 1 });
    api.sendRequest.mockResolvedValue(good({ relationship: 'friends', matched: true }));
    await press('add-friend-send');
    await waitFor(() => expect(screen.getByTestId('add-friend-notice')).toHaveTextContent('You and Bilal are now friends.'));
    expect(screen.getByTestId('add-friend-state')).toHaveTextContent(/Friends/);
    expect(screen.queryByTestId('add-friend-accept')).toBeNull();
    expect(api.respondRequest).not.toHaveBeenCalled();
    expect(social().data).toMatchObject({ friends: [{ playerId: BILAL.playerId }], incoming: [], outgoing: [] });
  });
});

// =============================================================================================
describe('Requests tab', () => {
  const open = async (overrides: Partial<SocialState>) => {
    await loaded(overrides);
    await render(<Friends />);
    await press('friends-tab-requests');
  };

  it('shows received and sent requests separately, with the badge count', async () => {
    await open({ incoming: [BILAL], outgoing: [ASHA] });
    expect(screen.getByTestId('friends-tab-requests-badge')).toHaveTextContent('1');
    expect(within(screen.getByTestId('requests-incoming')).getByTestId(`request-in-${BILAL.playerId}`)).toHaveTextContent(/Bilal.*RR-BBBBB2/);
    expect(within(screen.getByTestId('requests-outgoing')).getByTestId(`request-out-${ASHA.playerId}`)).toHaveTextContent(/Asha.*Pending/);
    // Received: accept / decline, never cancel. Sent: cancel, never accept.
    expect(within(screen.getByTestId('requests-incoming')).queryByText('Cancel')).toBeNull();
    expect(within(screen.getByTestId('requests-outgoing')).queryByText('Accept')).toBeNull();
  });

  it('accept: the server is asked, then the friend is in My Friends', async () => {
    await open({ incoming: [BILAL] });
    const bilal: Friend = { playerId: BILAL.playerId, nickname: 'Bilal', presenceKey: 'key-bilal', since: soon(0) };
    serverHas({ friends: [bilal] });
    api.respondRequest.mockResolvedValue(good({ relationship: 'friends', matched: false }));
    await press(`request-accept-${BILAL.playerId}`);
    await waitFor(() => expect(screen.getByTestId('friends-notice')).toHaveTextContent('You and Bilal are now friends.'));
    expect(api.respondRequest).toHaveBeenCalledWith(BILAL.id, true);
    expect(screen.queryByTestId(`request-in-${BILAL.playerId}`)).toBeNull();
    expect(screen.queryByTestId('friends-tab-requests-badge')).toBeNull();
    await press('friends-tab-friends');
    expect(screen.getByTestId(`friend-row-${BILAL.playerId}`)).toBeTruthy();
  });

  it('decline: the request goes, nobody becomes a friend', async () => {
    await open({ incoming: [BILAL] });
    serverHas();
    api.respondRequest.mockResolvedValue(good({ relationship: 'none', matched: false }));
    await press(`request-decline-${BILAL.playerId}`);
    await waitFor(() => expect(screen.getByTestId('requests-incoming-empty')).toBeTruthy());
    expect(api.respondRequest).toHaveBeenCalledWith(BILAL.id, false);
    expect(social().data?.friends).toEqual([]);
  });

  it('a request that was withdrawn meanwhile: says so and drops it from the list', async () => {
    await open({ incoming: [BILAL] });
    serverHas();
    api.respondRequest.mockResolvedValue(bad('REQUEST_GONE', 'That friend request is no longer there.'));
    await press(`request-accept-${BILAL.playerId}`);
    await waitFor(() => expect(screen.getByTestId('friends-notice')).toHaveTextContent('That friend request is no longer there.'));
    expect(screen.queryByTestId(`request-in-${BILAL.playerId}`)).toBeNull();
  });

  it('cancel a sent request', async () => {
    await open({ outgoing: [ASHA] });
    serverHas();
    api.cancelRequest.mockResolvedValue(good({ relationship: 'none', matched: false }));
    await press(`request-cancel-${ASHA.playerId}`);
    await waitFor(() => expect(screen.getByTestId('requests-outgoing-empty')).toBeTruthy());
    expect(api.cancelRequest).toHaveBeenCalledWith(ASHA.id);
    expect(screen.getByTestId('friends-notice')).toHaveTextContent('Request cancelled.');
  });

  it('a sent request whose 30 days are up shows Expired and can be sent again', async () => {
    const stale = { ...ASHA, expiresAt: soon(-1000) };
    await open({ outgoing: [stale] });
    expect(screen.getByTestId(`request-out-${ASHA.playerId}`)).toHaveTextContent(/Expired/);
    expect(screen.queryByTestId(`request-cancel-${ASHA.playerId}`)).toBeNull();
    serverHas({ outgoing: [{ ...ASHA, id: 'req-new' }] });
    api.sendRequest.mockResolvedValue(good({ relationship: 'outgoing', matched: false }));
    await press(`request-resend-${ASHA.playerId}`);
    await waitFor(() => expect(screen.getByTestId(`request-out-${ASHA.playerId}`)).toHaveTextContent(/Pending/));
    expect(api.sendRequest).toHaveBeenCalledWith(ASHA.playerId);
  });

  it('an expired received request is not offered for an answer', async () => {
    await open({ incoming: [{ ...BILAL, expiresAt: soon(-1000) }] });
    expect(screen.getByTestId('requests-incoming-empty')).toBeTruthy();
    expect(screen.queryByTestId('friends-tab-requests-badge')).toBeNull();
  });
});

// =============================================================================================
describe('My Friends: profile, remove, block', () => {
  it('lists friends with nickname and Player ID, and nothing private', async () => {
    await loaded({ friends: [FARAH, GAURI] });
    await render(<Friends />);
    expect(screen.getByTestId('friends-list')).toHaveTextContent(/My friends \(2\)/);
    expect(screen.getByTestId(`friend-row-${FARAH.playerId}`)).toHaveTextContent(/Farah.*RR-FFFFF2/);
    expect(screen.getByTestId('friends-screen')).not.toHaveTextContent(/key-farah|user-/);
    // No lobby to invite into: no Invite buttons.
    expect(screen.queryByTestId(`friend-invite-${FARAH.playerId}`)).toBeNull();
  });

  it('opens a friend’s profile; Remove asks first, then removes on the server', async () => {
    await loaded({ friends: [FARAH] });
    await render(<Friends />);
    await press(`friend-open-${FARAH.playerId}`);
    expect(screen.getByTestId('profile-nickname')).toHaveTextContent('Farah');
    expect(screen.getByTestId('profile-player-id')).toHaveTextContent(FARAH.playerId);
    await press('profile-copy-id');
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(FARAH.playerId));

    await press('profile-remove');
    expect(api.removeFriend).not.toHaveBeenCalled();
    serverHas();
    api.removeFriend.mockResolvedValue(DONE);
    await press('profile-confirm-confirm');
    await waitFor(() => expect(screen.getByTestId('friends-empty')).toBeTruthy());
    expect(api.removeFriend).toHaveBeenCalledWith(FARAH.playerId);
    expect(screen.queryByTestId('player-profile-sheet')).toBeNull();
  });

  it('a failed removal keeps the friend and shows why', async () => {
    await loaded({ friends: [FARAH] });
    await render(<Friends />);
    await press(`friend-open-${FARAH.playerId}`);
    await press('profile-remove');
    await press('profile-confirm-confirm');
    await waitFor(() => expect(screen.getByTestId('profile-confirm-error')).toHaveTextContent(/No connection/));
    expect(screen.getByTestId(`friend-row-${FARAH.playerId}`)).toBeTruthy();
  });

  it('Block asks first; a blocked player is listed and can be unblocked', async () => {
    await loaded({ friends: [FARAH] });
    await render(<Friends />);
    await press(`friend-open-${FARAH.playerId}`);
    await press('profile-block');
    serverHas({ blocked: [{ playerId: FARAH.playerId, nickname: 'Farah' }] });
    api.block.mockResolvedValue(DONE);
    await press('profile-confirm-confirm');
    await waitFor(() => expect(screen.getByTestId('profile-message')).toHaveTextContent('Farah is blocked.'));
    expect(api.block).toHaveBeenCalledWith(FARAH.playerId);
    // Their profile now offers Unblock and nothing else.
    expect(screen.getByTestId('profile-unblock')).toBeTruthy();
    expect(screen.queryByTestId('profile-remove')).toBeNull();
    expect(screen.queryByTestId('profile-block')).toBeNull();
    expect(screen.getByTestId('blocked-list')).toHaveTextContent(/Farah/);

    serverHas();
    api.unblock.mockResolvedValue(DONE);
    await press(`unblock-${FARAH.playerId}`);
    await waitFor(() => expect(screen.queryByTestId('blocked-list')).toBeNull());
    expect(api.unblock).toHaveBeenCalledWith(FARAH.playerId);
  });
});

// =============================================================================================
describe('presence', () => {
  /** Captures the Friends screen's presence subscription. */
  function capture() {
    const stop = jest.fn();
    let emit: (event: PresenceEvent) => void = () => undefined;
    let keys: readonly string[] = [];
    watchMock.mockImplementation((presenceKeys, onEvent) => {
      keys = presenceKeys;
      emit = onEvent;
      return stop;
    });
    const say = (presenceKey: string, health: ChannelHealth, present: boolean) => act(async () => emit({ presenceKey, health, present, synced: health === 'live' }));
    return { stop, say, keys: () => keys };
  }
  const presenceOf = (friend: Friend) => screen.getByTestId(`friend-presence-${friend.playerId}`);

  it('subscribes to exactly the friends on screen, shows Online / Offline / Unknown, and cleans up', async () => {
    const channel = capture();
    await loaded({ friends: [FARAH, GAURI] });
    const view = await render(<Friends />);
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(channel.keys()).toEqual([FARAH.presenceKey, GAURI.presenceKey]);
    // Nothing heard yet: unknown, not offline.
    expect(presenceOf(FARAH)).toHaveTextContent('Unknown');
    expect(presenceOf(GAURI)).toHaveTextContent('Unknown');

    await channel.say(FARAH.presenceKey, 'live', true);
    await channel.say(GAURI.presenceKey, 'live', false);
    expect(presenceOf(FARAH)).toHaveTextContent('Online');
    expect(presenceOf(GAURI)).toHaveTextContent('Offline');

    // The status comes from the channel, never from polling the server.
    expect(api.state).toHaveBeenCalledTimes(2);

    await view.unmount();
    expect(channel.stop).toHaveBeenCalledTimes(1);
    expect(social().presence).toEqual({});
  });

  it('my own connection dropping never turns a friend offline; a friend’s short drop is not shown either', async () => {
    jest.useFakeTimers();
    try {
      const channel = capture();
      await loaded({ friends: [FARAH] });
      await render(<Friends />);
      await channel.say(FARAH.presenceKey, 'live', true);
      expect(presenceOf(FARAH)).toHaveTextContent('Online');

      // My channel goes down: I cannot tell any more.
      await channel.say(FARAH.presenceKey, 'down', false);
      expect(presenceOf(FARAH)).toHaveTextContent('Unknown');
      await channel.say(FARAH.presenceKey, 'live', true);
      expect(presenceOf(FARAH)).toHaveTextContent('Online');

      // Farah drops off and is back within the grace period: no flicker.
      await channel.say(FARAH.presenceKey, 'live', false);
      expect(presenceOf(FARAH)).toHaveTextContent('Online');
      await act(async () => jest.advanceTimersByTime(3000));
      expect(presenceOf(FARAH)).toHaveTextContent('Online');
      await channel.say(FARAH.presenceKey, 'live', true);

      // Farah really leaves: offline once the grace period is over.
      await channel.say(FARAH.presenceKey, 'live', false);
      await act(async () => jest.advanceTimersByTime(PRESENCE_OFFLINE_GRACE_MS + 1500));
      expect(presenceOf(FARAH)).toHaveTextContent('Offline');
    } finally {
      jest.useRealTimers();
    }
  });

  it('this player is shown online only while signed in and the app is in front', async () => {
    const stop = jest.fn();
    trackMock.mockImplementation(() => stop);
    {
      serverHas();
      await render(<SocialHost />);
      expect(trackMock).not.toHaveBeenCalled();
      await signIn(ME);
      await waitFor(() => expect(trackMock).toHaveBeenCalledTimes(1));
      // The server's presence key and a per-run session key — not the nickname, not the account id.
      const [presenceKey, sessionKey] = trackMock.mock.calls[0]!;
      expect(presenceKey).toBe('key-me');
      expect(sessionKey).not.toMatch(new RegExp(`${ME.nickname}|${ME.userId}|${ME.playerId}`));

      await appState('background');
      expect(stop).toHaveBeenCalledTimes(1);
      await appState('active');
      await waitFor(() => expect(trackMock).toHaveBeenCalledTimes(2));
      expect(trackMock.mock.calls[1]![1]).toBe(sessionKey);

      await signIn(null);
      expect(stop).toHaveBeenCalledTimes(2);
    }
  });
});

// =============================================================================================
describe('Game Invites tab', () => {
  const open = async (invites: GameInvite[]) => {
    await loaded({ invites });
    await render(<Friends />);
    await press('friends-tab-invites');
  };

  it('shows who invited, the mode, the lobby and the time left', async () => {
    await open([invite()]);
    expect(screen.getByTestId('friends-tab-invites-badge')).toHaveTextContent('1');
    expect(screen.getByTestId('invite-inv-1')).toHaveTextContent(/Farah.*RR-FFFFF2/);
    expect(screen.getByTestId('invite-detail-inv-1')).toHaveTextContent('Intermediate game · Lobby open · 3/8 players');
    expect(screen.getByTestId('invite-expiry-inv-1')).toHaveTextContent(/Expires in 1[34]:\d\d/);
  });

  it('Join re-checks on the server, then opens the normal join screen with the code', async () => {
    await open([invite()]);
    serverHas({ invites: [invite()] });
    api.openInvite.mockResolvedValue(good({ gameId: 'game-1', code: '482915', mode: 'intermediate' }));
    await press('invite-join-inv-1');
    await waitFor(() => expect(router.push).toHaveBeenLastCalledWith('/join-game?code=482915'));
    expect(api.openInvite).toHaveBeenCalledWith('inv-1');
    // Joining is the game's own join: the invitation itself puts nobody in a game.
    expect(game.join).not.toHaveBeenCalled();
  });

  it('Join refused (the lobby was locked a second ago): the reason, no navigation, and the list is refreshed', async () => {
    await open([invite()]);
    serverHas({ invites: [invite({ state: 'locked' })] });
    api.openInvite.mockResolvedValue(bad('LOBBY_LOCKED', 'The host has locked the lobby.'));
    await press('invite-join-inv-1');
    await waitFor(() => expect(screen.getByTestId('friends-notice')).toHaveTextContent('The host has locked the lobby.'));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('invite-join-inv-1')).toBeNull();
    expect(screen.getByTestId('invite-reason-inv-1')).toHaveTextContent('The host has locked the lobby.');
  });

  it('an invitation that can no longer be used leaves the active list and says why', async () => {
    await open([
      invite({ id: 'a', state: 'started' }),
      invite({ id: 'b', state: 'closed' }),
      invite({ id: 'c', state: 'full' }),
      invite({ id: 'd', state: 'locked' }),
      invite({ id: 'e', state: 'expired' }),
      // Still "open" in the last answer, but its 15 minutes have passed on the server's clock.
      invite({ id: 'f', state: 'open', expiresAt: soon(-1000) }),
    ]);
    expect(screen.getByTestId('invites-empty')).toBeTruthy();
    expect(screen.queryByTestId('friends-tab-invites-badge')).toBeNull();
    const reasons: Record<string, string> = {
      a: 'The game has already started.',
      b: 'This game has ended.',
      c: 'The lobby is full.',
      d: 'The host has locked the lobby.',
      e: 'This invitation has expired.',
      f: 'This invitation has expired.',
    };
    for (const [id, reason] of Object.entries(reasons)) {
      expect(screen.getByTestId(`invite-reason-${id}`)).toHaveTextContent(reason);
      expect(screen.queryByTestId(`invite-join-${id}`)).toBeNull();
    }
  });

  it('an invitation expires on screen when its time runs out', async () => {
    jest.useFakeTimers();
    try {
      await open([invite({ expiresAt: soon(4000) })]);
      expect(screen.getByTestId('invite-join-inv-1')).toBeTruthy();
      await act(async () => jest.advanceTimersByTime(6000));
      expect(screen.queryByTestId('invite-join-inv-1')).toBeNull();
      expect(screen.getByTestId('invite-reason-inv-1')).toHaveTextContent('This invitation has expired.');
    } finally {
      jest.useRealTimers();
    }
  });

  it('Decline removes it', async () => {
    await open([invite()]);
    serverHas();
    api.declineInvite.mockResolvedValue(DONE);
    await press('invite-decline-inv-1');
    await waitFor(() => expect(screen.getByTestId('invites-empty')).toBeTruthy());
    expect(api.declineInvite).toHaveBeenCalledWith('inv-1');
    expect(screen.getByTestId('friends-notice')).toHaveTextContent('Invitation declined.');
  });
});

// =============================================================================================
describe('lobby: code, share, invite, lock, remove', () => {
  const NAMES = ['Asha', 'Bilal', 'Chitra'];
  const lobbyFor = async (name: string, mutate?: (f: Fixture) => void) => {
    const f = new Fixture(NAMES, { start: false });
    mutate?.(f);
    f.loadAs(name);
    await render(<LobbyView view={viewFor(f, name)} />);
    return f;
  };

  it('shows the code, copies it, and shares the game through the system share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    try {
      const f = await lobbyFor('Bilal');
      expect(screen.getByTestId('game-code')).toHaveTextContent(f.state.code);
      await press('lobby-copy-code');
      await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(f.state.code));
      expect(screen.getByText('✓ Copied')).toBeTruthy();
      // Any participant can share — not only the host.
      await press('lobby-share');
      expect(share).toHaveBeenCalledWith({
        message: `Join my Business Banker Classic game! Code: ${f.state.code}. Open Business Banker and enter this code to join.\nbusinessbanker://join-game?code=${f.state.code}`,
      });
      // Sharing the code sends no friend request and no invitation.
      expect(api.sendRequest).not.toHaveBeenCalled();
      expect(api.sendInvite).not.toHaveBeenCalled();
    } finally {
      share.mockRestore();
    }
  });

  it('Invite Friends: empty state without friends, with the code as the way in', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    try {
      await loaded();
      await lobbyFor('Asha');
      await press('lobby-invite-friends');
      expect(screen.getByTestId('invite-empty')).toHaveTextContent(/anyone with it can join/);
      await press('invite-share-code');
      expect(share).toHaveBeenCalledTimes(1);
    } finally {
      share.mockRestore();
    }
  });

  it('Invite Friends: invites a friend; "Invited" appears only after the server confirms; it can be cancelled', async () => {
    await loaded({ friends: [FARAH, GAURI] });
    const f = await lobbyFor('Bilal'); // not the host
    await act(async () => void useSocialStore.setState({ seats: { [f.state.id]: [seatOf(f, 'Asha', { playerId: GAURI.playerId, nickname: 'Gauri' })] } }));
    await press('lobby-invite-friends');
    // Gauri already sits at this table.
    expect(screen.getByTestId(`invite-row-${GAURI.playerId}`)).toHaveTextContent(/In lobby/);
    expect(screen.queryByTestId(`invite-send-${GAURI.playerId}`)).toBeNull();

    let confirm: (value: Awaited<ReturnType<typeof api.sendInvite>>) => void = () => undefined;
    api.sendInvite.mockReturnValue(new Promise((resolve) => (confirm = resolve)));
    await press(`invite-send-${FARAH.playerId}`);
    expect(api.sendInvite).toHaveBeenCalledWith(f.state.id, FARAH.playerId);
    expect(screen.getByTestId(`invite-row-${FARAH.playerId}`)).not.toHaveTextContent(/Invited/);

    serverHas({ friends: [FARAH, GAURI], sentInvites: [{ id: 'sent-1', gameId: f.state.id, playerId: FARAH.playerId, expiresAt: soon(15 * MINUTE) }] });
    await act(async () => confirm(DONE));
    await waitFor(() => expect(screen.getByTestId(`invite-row-${FARAH.playerId}`)).toHaveTextContent(/Invited/));

    serverHas({ friends: [FARAH, GAURI] });
    api.revokeInvite.mockResolvedValue(DONE);
    await press(`invite-revoke-${FARAH.playerId}`);
    await waitFor(() => expect(screen.getByTestId(`invite-send-${FARAH.playerId}`)).toBeTruthy());
    expect(api.revokeInvite).toHaveBeenCalledWith('sent-1');
    // Inviting never touches the game.
    expect(game.action).not.toHaveBeenCalled();
  });

  it('a refused invitation says why and shows nothing as sent', async () => {
    await loaded({ friends: [FARAH] });
    await lobbyFor('Asha');
    await press('lobby-invite-friends');
    serverHas({ friends: [FARAH] });
    api.sendInvite.mockResolvedValue(bad('GAME_FULL', 'The lobby is full.'));
    await press(`invite-send-${FARAH.playerId}`);
    await waitFor(() => expect(screen.getByTestId(`invite-error-${FARAH.playerId}`)).toHaveTextContent('The lobby is full.'));
    expect(screen.getByTestId(`invite-row-${FARAH.playerId}`)).not.toHaveTextContent(/Invited/);
  });

  it('lock: only the host has the control; it asks the referee; a locked lobby says so and stops invitations', async () => {
    await loaded({ friends: [FARAH] });
    const guest = await lobbyFor('Bilal');
    expect(screen.queryByTestId('lobby-lock')).toBeNull();
    expect(screen.queryByTestId('lobby-locked')).toBeNull();
    await screen.unmount();

    const f = await lobbyFor('Asha');
    const locked = new Fixture(NAMES, { start: false });
    locked.act('Asha', { type: 'SET_LOBBY_LOCK', locked: true });
    game.action.mockResolvedValue(okSnapshot({ ...f.snapshot(), state: { ...f.state, lobbyLocked: true, version: f.state.version + 1 } }));
    await press('lobby-lock');
    await waitFor(() => expect(game.action).toHaveBeenCalledTimes(1));
    expect(game.action.mock.calls[0]![3]).toEqual({ type: 'SET_LOBBY_LOCK', locked: true });
    expect(guest.state.lobbyLocked).toBe(false);
    await screen.unmount();

    // What everyone sees once it is locked.
    locked.loadAs('Bilal');
    await render(<LobbyView view={viewFor(locked, 'Bilal')} />);
    expect(screen.getByTestId('lobby-locked')).toHaveTextContent(/Lobby locked/);
    await press('lobby-invite-friends');
    expect(screen.getByTestId('invite-closed')).toHaveTextContent(/locked/);
    expect(disabled(`invite-send-${FARAH.playerId}`)).toBe(true);
  });

  it('host removes a player from the lobby, after confirming; a guest has no such control', async () => {
    const f = await lobbyFor('Asha');
    await press('lobby-player-Bilal');
    expect(screen.getByTestId('lobby-player-sheet')).toBeTruthy();
    await press('lobby-remove-player');
    expect(game.action).not.toHaveBeenCalled();
    const after = new Fixture(NAMES, { start: false });
    game.action.mockResolvedValue(okSnapshot({ ...f.snapshot(), state: { ...f.state, version: f.state.version + 1 } }));
    await press('lobby-remove-confirm-confirm');
    await waitFor(() => expect(game.action).toHaveBeenCalledTimes(1));
    expect(game.action.mock.calls[0]![3]).toEqual({ type: 'REMOVE_PLAYER', playerId: f.ids.Bilal });
    await screen.unmount();

    after.loadAs('Bilal');
    await render(<LobbyView view={viewFor(after, 'Bilal')} />);
    await press('lobby-player-Chitra');
    expect(screen.queryByTestId('lobby-remove-player')).toBeNull();
    // My own row opens nothing.
    expect(screen.getByTestId('lobby-player-Bilal').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('says so when someone joins', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    f.loadAs('Asha');
    const view = await render(<LobbyView view={viewFor(f, 'Asha')} />);
    expect(useGameStore.getState().notice).toBeNull();
    const bigger = new Fixture(['Asha', 'Bilal', 'Chitra'], { start: false });
    // Same table, one more player (the fixture gives the newcomer a fresh id).
    const joined = { ...f.state, version: f.state.version + 1, players: [...f.state.players, { ...bigger.state.players[2]!, id: 'seat-chitra' }] };
    const snapshot = { ...f.snapshot(), state: joined };
    await view.rerender(<LobbyView view={{ ...viewFor(f, 'Asha'), snapshot }} />);
    expect(useGameStore.getState().notice).toMatchObject({ kind: 'info', message: 'Chitra joined' });
  });
});

// =============================================================================================
describe('Add Friend from a lobby or a running game', () => {
  const NAMES = ['Asha', 'Bilal', 'Chitra'];
  const BILAL_PROFILE = { playerId: BILAL.playerId, nickname: 'Bilal' };

  async function table(overrides: Partial<SocialState>, seats: (f: Fixture) => SeatProfile[], start = true) {
    await loaded(overrides);
    const f = new Fixture(NAMES, { start });
    f.loadAs('Asha');
    await act(async () => void useSocialStore.setState({ seats: { [f.state.id]: seats(f) } }));
    return f;
  }
  const actions = (f: Fixture, name: string) => <PlayerDetailsActions view={viewFor(f, 'Asha')} playerId={f.ids[name]!} onMakeOffer={jest.fn()} onPayMoney={jest.fn()} />;

  it('in a running game: Add Friend sends the request and leaves the game exactly as it was', async () => {
    const f = await table({}, (g) => [seatOf(g, 'Bilal', BILAL_PROFILE)]);
    const before = JSON.stringify(useGameStore.getState().snapshot);
    await render(actions(f, 'Bilal'));
    expect(screen.getByTestId('player-add-friend')).toHaveTextContent('Add Friend');
    // The game's own actions are still there.
    expect(screen.getByTestId('player-make-offer')).toBeTruthy();
    expect(screen.getByTestId('player-pay-money')).toBeTruthy();

    serverHas({ outgoing: [requestFrom(BILAL.playerId, 'Bilal')] });
    api.sendRequest.mockResolvedValue(good({ relationship: 'outgoing', matched: false }));
    await press('player-add-friend');
    await waitFor(() => expect(screen.getByTestId('player-friend-message')).toHaveTextContent('Friend request sent to Bilal.'));
    expect(api.sendRequest).toHaveBeenCalledWith(BILAL.playerId);
    expect(screen.getByTestId('player-add-friend')).toHaveTextContent('Request Sent');
    expect(disabled('player-add-friend')).toBe(true);

    // Not a game action: no call to the referee, same snapshot, same turn.
    expect(game.action).not.toHaveBeenCalled();
    expect(JSON.stringify(useGameStore.getState().snapshot)).toBe(before);
  });

  it('shows the state that matches the relationship: sent, respond, friends, unavailable', async () => {
    const f = await table(
      { friends: [{ ...FARAH, playerId: 'RR-CCCCC2', nickname: 'Chitra' }], incoming: [BILAL] },
      (g) => [seatOf(g, 'Bilal', BILAL_PROFILE), seatOf(g, 'Chitra', { playerId: 'RR-CCCCC2', nickname: 'Chitra' })],
    );
    const bilal = await render(actions(f, 'Bilal'));
    expect(screen.getByTestId('player-friend-state')).toHaveTextContent('Bilal sent you a friend request');
    expect(screen.getByTestId('player-friend-accept')).toBeTruthy();
    expect(screen.queryByTestId('player-add-friend')).toBeNull();
    await bilal.unmount();

    await render(actions(f, 'Chitra'));
    expect(screen.getByTestId('player-friend-state')).toHaveTextContent(/Friends/);
    expect(screen.queryByTestId('player-add-friend')).toBeNull();
  });

  it('a seat with no account behind it, or a player who can’t be added, is Unavailable', async () => {
    const f = await table({}, (g) => [seatOf(g, 'Chitra', null)]);
    const noSeat = await render(actions(f, 'Bilal')); // Bilal's seat is not in the server's list at all
    expect(screen.getByTestId('player-add-friend')).toHaveTextContent('Add Friend · Unavailable');
    expect(disabled('player-add-friend')).toBe(true);
    await noSeat.unmount();
    await render(actions(f, 'Chitra'));
    expect(disabled('player-add-friend')).toBe(true);
    await press('player-add-friend');
    expect(api.sendRequest).not.toHaveBeenCalled();
  });

  it('respond from the table; and reciprocal requests make friends at once', async () => {
    const f = await table({ incoming: [BILAL] }, (g) => [seatOf(g, 'Bilal', BILAL_PROFILE), seatOf(g, 'Chitra', { playerId: 'RR-CCCCC2', nickname: 'Chitra' })]);
    const bilalFriend: Friend = { playerId: BILAL.playerId, nickname: 'Bilal', presenceKey: 'key-bilal', since: soon(0) };
    const first = await render(actions(f, 'Bilal'));
    serverHas({ friends: [bilalFriend] });
    api.respondRequest.mockResolvedValue(good({ relationship: 'friends', matched: false }));
    await press('player-friend-accept');
    await waitFor(() => expect(screen.getByTestId('player-friend-message')).toHaveTextContent('You and Bilal are now friends.'));
    expect(api.respondRequest).toHaveBeenCalledWith(BILAL.id, true);
    expect(screen.getByTestId('player-friend-state')).toHaveTextContent(/Friends/);
    await first.unmount();

    // Chitra asked a moment ago (this phone has not heard yet): my Add Friend makes us friends.
    await render(actions(f, 'Chitra'));
    serverHas({ friends: [bilalFriend, { ...FARAH, playerId: 'RR-CCCCC2', nickname: 'Chitra' }] });
    api.sendRequest.mockResolvedValue(good({ relationship: 'friends', matched: true }));
    await press('player-add-friend');
    await waitFor(() => expect(screen.getByTestId('player-friend-message')).toHaveTextContent('You and Chitra are now friends.'));
    expect(screen.getByTestId('player-friend-state')).toHaveTextContent(/Friends/);
    expect(game.action).not.toHaveBeenCalled();
  });

  it('in the lobby: tapping a player opens their sheet with Add Friend', async () => {
    const f = await table({}, (g) => [seatOf(g, 'Bilal', BILAL_PROFILE)], false);
    await render(<LobbyView view={viewFor(f, 'Asha')} />);
    await press('lobby-player-Bilal');
    serverHas({ outgoing: [requestFrom(BILAL.playerId, 'Bilal')] });
    api.sendRequest.mockResolvedValue(good({ relationship: 'outgoing', matched: false }));
    await press('player-add-friend');
    await waitFor(() => expect(screen.getByTestId('player-add-friend')).toHaveTextContent('Request Sent'));
    expect(api.sendRequest).toHaveBeenCalledWith(BILAL.playerId);
    expect(game.action).not.toHaveBeenCalled();
  });

  it('nothing social is shown at a table until an account’s data has loaded', async () => {
    const f = new Fixture(NAMES);
    f.loadAs('Asha');
    await render(actions(f, 'Bilal'));
    expect(screen.getByTestId('player-make-offer')).toBeTruthy();
    expect(screen.queryByTestId('player-friend-action')).toBeNull();
  });
});

// =============================================================================================
describe('SocialHost: sync, notifications, account changes', () => {
  /** Captures the change-counter subscription. */
  function channel() {
    const stop = jest.fn();
    let handlers: SocialSyncHandlers | null = null;
    let userId: string | null = null;
    syncMock.mockImplementation((id, h) => {
      userId = id;
      handlers = h;
      return stop;
    });
    return {
      stop,
      userId: () => userId,
      version: (v: number) => act(async () => handlers!.onVersion(v)),
      health: (h: ChannelHealth) => act(async () => handlers!.onHealth(h)),
    };
  }
  const started = async (overrides: Partial<SocialState> = {}) => {
    serverHas(overrides);
    await signIn(ME);
    await render(<SocialHost />);
    await waitFor(() => expect(social().phase).toBe('ready'));
  };

  it('loads on sign-in and subscribes to this account’s change counter only', async () => {
    const ch = channel();
    await started({ friends: [FARAH] });
    expect(ch.userId()).toBe(ME.userId);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(social().data?.friends).toEqual([FARAH]);
  });

  it('refetches when Realtime announces a newer version; duplicates and late events do nothing', async () => {
    const ch = channel();
    await started();
    await ch.health('live');
    await waitFor(() => expect(api.state).toHaveBeenCalledTimes(2)); // reconcile once when first live
    const current = social().data!.version;

    await ch.version(current); // duplicate
    await ch.version(current - 1); // out of order
    expect(api.state).toHaveBeenCalledTimes(2);

    serverHas({ friends: [FARAH] });
    const next = version; // the version the server now has
    await ch.version(next);
    await waitFor(() => expect(social().data?.friends).toEqual([FARAH]));
    expect(api.state).toHaveBeenCalledTimes(3);
    // The same announcement again: already there.
    await ch.version(next);
    expect(api.state).toHaveBeenCalledTimes(3);
  });

  it('an older answer that arrives late never undoes a newer one', async () => {
    await started({ friends: [FARAH] });
    const stale = serverState({ friends: [FARAH, GAURI] });
    const fresh = serverState({ friends: [] }); // Gauri never was; Farah was removed
    api.state.mockResolvedValueOnce(good(fresh));
    await act(() => social().refresh());
    expect(social().data?.friends).toEqual([]);
    api.state.mockResolvedValueOnce(good(stale));
    await act(() => social().refresh());
    expect(social().data?.friends).toEqual([]);
    expect(social().data?.version).toBe(fresh.version);
  });

  it('reconnect and return to the foreground each fetch once; while Realtime is down it polls slowly, and stops when it is back', async () => {
    jest.useFakeTimers();
    try {
      const ch = channel();
      serverHas();
      await signIn(ME);
      await render(<SocialHost />);
      await act(async () => jest.advanceTimersByTime(0));
      expect(api.state).toHaveBeenCalledTimes(1);

      await ch.health('live');
      expect(api.state).toHaveBeenCalledTimes(2);
      // Healthy and idle: no polling at all.
      await act(async () => jest.advanceTimersByTime(5 * 60_000));
      expect(api.state).toHaveBeenCalledTimes(2);

      await ch.health('down');
      await act(async () => jest.advanceTimersByTime(30_000));
      expect(api.state).toHaveBeenCalledTimes(3);
      await act(async () => jest.advanceTimersByTime(30_000));
      expect(api.state).toHaveBeenCalledTimes(4);

      await ch.health('live'); // reconnected: one reconcile, polling stops
      expect(api.state).toHaveBeenCalledTimes(5);
      await act(async () => jest.advanceTimersByTime(5 * 60_000));
      expect(api.state).toHaveBeenCalledTimes(5);

      await appState('background');
      expect(api.state).toHaveBeenCalledTimes(5);
      await appState('active');
      expect(api.state).toHaveBeenCalledTimes(6);
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces a notification once when it arrives — not the backlog, not twice — and receiving it does not mark it read', async () => {
    const ch = channel();
    const old = note('old', 'friend_request', 'Bilal');
    await started({ notifications: [old], unread: 1 });
    // What was already there at sign-in is on the badge, not in a toast.
    expect(useGameStore.getState().notice).toBeNull();

    const fresh = note('new', 'game_invite', 'Farah');
    serverHas({ notifications: [fresh, old], unread: 2 });
    await ch.version(version);
    await waitFor(() => expect(useGameStore.getState().notice).toMatchObject({ kind: 'info', message: 'Farah invited you to a game' }));

    await act(async () => useGameStore.getState().dismissNotice());
    // The same state again (a duplicate event, a refetch): no second toast.
    serverHas({ notifications: [fresh, old], unread: 2 });
    await ch.version(version);
    await waitFor(() => expect(api.state).toHaveBeenCalledTimes(3));
    expect(useGameStore.getState().notice).toBeNull();
    // Arriving in the background is not reading.
    expect(api.markRead).not.toHaveBeenCalled();
    expect(social().data?.unread).toBe(2);
  });

  it('notifications are shown on the Friends screen and marked read on the server when it is left', async () => {
    await loaded({ notifications: [note('n1', 'friend_accepted'), note('n2', 'friends_matched', 'Gauri')], unread: 2 });
    const view = await render(<Friends />);
    expect(screen.getAllByTestId('friends-news-item').map((n) => n.props.children)).toEqual(['Farah accepted your friend request', 'You and Gauri are now friends']);
    expect(api.markRead).not.toHaveBeenCalled();

    api.markRead.mockResolvedValue(DONE);
    serverHas({ notifications: [note('n1', 'friend_accepted', 'Farah', true), note('n2', 'friends_matched', 'Gauri', true)], unread: 0 });
    await view.unmount();
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(social().data?.unread).toBe(0));
  });

  it('a failed "mark read" leaves them unread (the server is the record)', async () => {
    await loaded({ notifications: [note('n1', 'friend_accepted')], unread: 1 });
    const view = await render(<Friends />);
    await view.unmount();
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));
    expect(social().data?.notifications[0]).toMatchObject({ id: 'n1', read: false });
  });

  it('switching accounts wipes everything at once and loads the other player’s data', async () => {
    const ch = channel();
    await started({ friends: [FARAH], incoming: [BILAL] });
    await render(<Friends />);
    expect(screen.getByTestId(`friend-row-${FARAH.playerId}`)).toBeTruthy();

    // The other account's answer is still on its way.
    let answer: (value: Awaited<ReturnType<typeof api.state>>) => void = () => undefined;
    api.state.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await signIn(OTHER_ACCOUNT);
    expect(social().ownerUserId).toBe(OTHER_ACCOUNT.userId);
    expect(social().data).toBeNull();
    expect(screen.queryByTestId(`friend-row-${FARAH.playerId}`)).toBeNull();
    expect(screen.getByTestId('friends-screen')).not.toHaveTextContent(/Farah|Bilal/);
    expect(ch.stop).toHaveBeenCalledTimes(1);
    expect(ch.userId()).toBe(OTHER_ACCOUNT.userId);

    await act(async () => answer(good(serverState({ me: { playerId: OTHER_ACCOUNT.playerId, presenceKey: 'key-other' }, friends: [GAURI] }))));
    expect(screen.getByTestId(`friend-row-${GAURI.playerId}`)).toBeTruthy();
    expect(screen.queryByTestId(`friend-row-${FARAH.playerId}`)).toBeNull();
  });

  it('an answer for the previous account that arrives after the switch is dropped', async () => {
    channel();
    await started({ friends: [FARAH] });
    let late: (value: Awaited<ReturnType<typeof api.sendRequest>>) => void = () => undefined;
    api.sendRequest.mockReturnValue(new Promise((resolve) => (late = resolve)));
    const sending = social().sendRequest(ASHA.playerId);

    serverHas({ me: { playerId: OTHER_ACCOUNT.playerId, presenceKey: 'key-other' } });
    await signIn(OTHER_ACCOUNT);
    await waitFor(() => expect(social().phase).toBe('ready'));
    late(good({ relationship: 'outgoing', matched: false }));
    expect(await sending).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    expect(social().data?.friends).toEqual([]);
    expect(social().pending).toEqual({});
  });

  it('signing out clears the social data and stops listening', async () => {
    const ch = channel();
    await started({ friends: [FARAH] });
    await signIn(null);
    expect(social()).toMatchObject({ ownerUserId: null, phase: 'idle', data: null });
    expect(ch.stop).toHaveBeenCalledTimes(1);
    await render(<Home />);
    expect(screen.queryByTestId('friends-badge')).toBeNull();
  });

  it('ties the account to the seat this phone holds, then loads who is at the table', async () => {
    channel();
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    f.loadAs('Asha');
    const credentials = useSessionStore.getState().session!;
    api.claimSeat.mockResolvedValue(DONE);
    const profiles = [seatOf(f, 'Bilal', { playerId: BILAL.playerId, nickname: 'Bilal' })];
    api.seatProfiles.mockResolvedValue(good(profiles));
    await started();
    await waitFor(() => expect(social().seats[f.state.id]).toEqual(profiles));
    expect(api.claimSeat).toHaveBeenCalledTimes(1);
    expect(api.claimSeat).toHaveBeenCalledWith(credentials);
    expect(api.seatProfiles).toHaveBeenCalledWith(f.state.id);

    // Someone joins: the table is read again, the seat is not claimed again.
    const bigger = new Fixture(['Asha', 'Bilal', 'Chitra'], { start: false });
    await act(async () => {
      useGameStore.setState({ snapshot: { ...f.snapshot(), state: { ...f.state, version: f.state.version + 1, players: [...f.state.players, { ...bigger.state.players[2]!, id: 'seat-chitra' }] } } });
    });
    await waitFor(() => expect(api.seatProfiles).toHaveBeenCalledTimes(2));
    expect(api.claimSeat).toHaveBeenCalledTimes(1);
  });
});
