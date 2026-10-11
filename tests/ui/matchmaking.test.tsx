/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { router, usePathname } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import Home from '../../app/index';
import PlayOnline from '../../app/play-online';
import type { Profile } from '@/features/account/types';
import { MatchmakingHost } from '@/features/matchmaking/MatchmakingHost';
import type { Match, MatchmakingError, MatchmakingState, MatchPlayer, Party, PartyMember, Ticket } from '@/features/matchmaking/types';
import type { SocialState } from '@/features/social/types';
import { matchmakingApi } from '@/lib/matchmakingApi';
import type { ChannelHealth } from '@/lib/realtime';
import { subscribeToMatchmakingSync, type MatchmakingSyncHandlers } from '@/lib/socialRealtime';
import { resetAccountStoreForTests, useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { READY_TOKEN_KEY, resetMatchmakingStoreForTests, useMatchmakingStore } from '@/store/matchmakingStore';
import { useSessionStore } from '@/store/sessionStore';
import { resetSocialStoreForTests, useSocialStore } from '@/store/socialStore';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture } from './fixtures';

const api = matchmakingApi as jest.Mocked<typeof matchmakingApi>;
const syncMock = subscribeToMatchmakingSync as jest.MockedFunction<typeof subscribeToMatchmakingSync>;
const pathname = usePathname as jest.Mock;

const ME: Profile = { userId: 'user-me', playerId: 'RR-22222M', nickname: 'Me', googleLinked: false };
const OTHER_ACCOUNT: Profile = { userId: 'user-other', playerId: 'RR-33333N', nickname: 'Other', googleLinked: true };

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

const SETTINGS: MatchmakingState['settings'] = {
  enabled: true,
  readySeconds: 20,
  heartbeatSeconds: 10,
  preferTargetSeconds: 30,
  relaxSeconds: 60,
  targetPlayers: 4,
  minPlayers: 2,
  maxPlayers: 8,
  partyMaxMembers: 8,
};

let version = 1;
/** A server answer. Every one is newer than the last, as on the real server after a change. */
function serverState(overrides: Partial<MatchmakingState> = {}): MatchmakingState {
  version += 1;
  return {
    version,
    serverTime: new Date().toISOString(),
    settings: SETTINGS,
    cooldownUntilMs: 0,
    liveGame: null,
    party: null,
    partyInvites: [],
    ticket: null,
    match: null,
    game: null,
    lastResult: null,
    ...overrides,
  };
}

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 'ticket-1', kind: 'solo', mode: 'classic', playerCount: 1, status: 'QUEUED', queuedAt: soon(-7000), requeueCount: 0, ...overrides });

const seat = (playerId: string, nickname: string, overrides: Partial<MatchPlayer> = {}): MatchPlayer => ({ playerId, nickname, group: 1, party: false, ready: false, isMe: false, ...overrides });
const match = (overrides: Partial<Match> = {}): Match => ({
  id: 'match-1',
  mode: 'classic',
  status: 'READY_UP',
  playerCount: 4,
  readyDeadline: soon(15_000),
  players: [
    seat(ME.playerId, 'Me', { group: 1, isMe: true }),
    seat('RR-AAAAA2', 'Asha', { group: 2 }),
    seat('RR-BBBBB2', 'Bilal', { group: 3, party: true, ready: true }),
    seat('RR-CCCCC2', 'Chitra', { group: 3, party: true }),
  ],
  ...overrides,
});
const reserved = (m: Match = match()) => ({ ticket: ticket({ status: 'RESERVED' as const }), match: m });

const member = (playerId: string, nickname: string, overrides: Partial<PartyMember> = {}): PartyMember => ({ playerId, nickname, isLeader: false, isMe: false, ready: false, online: true, ...overrides });
const party = (overrides: Partial<Party> = {}): Party => ({
  id: 'party-1',
  mode: 'classic',
  isLeader: true,
  locked: false,
  members: [member(ME.playerId, 'Me', { isLeader: true, isMe: true, ready: true }), member('RR-FFFFF2', 'Farah')],
  invites: [],
  ...overrides,
});

const good = <T,>(value: T) => ({ ok: true as const, value });
const bad = (code: MatchmakingError['code'], message: string) => ({ ok: false as const, error: { code, message } });
const OFFLINE = bad('NETWORK', 'No connection. Check your internet and try again.');
const DONE = good(true as const);

/** What the server will answer next time the phone asks for its matchmaking state. */
const serverHas = (overrides: Partial<MatchmakingState> = {}) => api.state.mockResolvedValue(good(serverState(overrides)));

const mm = () => useMatchmakingStore.getState();
const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));
const disabled = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.disabled === true;

async function signIn(profile: Profile | null) {
  await act(async () => {
    useAccountStore.setState(profile ? { phase: 'ready', verified: true, profile, error: null } : { phase: 'signedOut', verified: false, profile: null });
  });
}

/** The account is signed in and the server has answered, as after app start. */
async function loaded(overrides: Partial<MatchmakingState> = {}) {
  serverHas(overrides);
  useAccountStore.setState({ phase: 'ready', verified: true, profile: ME, error: null });
  mm().attach(ME.userId);
  await act(() => mm().refresh());
  expect(mm().phase).toBe('ready');
}

/** A change on the server, announced the way Realtime announces it. */
async function serverChanges(overrides: Partial<MatchmakingState>) {
  const next = serverState(overrides);
  api.state.mockResolvedValue(good(next));
  await act(async () => mm().noteVersion(next.version));
}

let appStateListeners: ((next: AppStateStatus) => void)[] = [];
const appState = (next: AppStateStatus) => act(async () => appStateListeners.forEach((listener) => listener(next)));
let sync: MatchmakingSyncHandlers | null = null;
const realtime = (health: ChannelHealth) => act(async () => sync?.onHealth(health));
const storedToken = async () => JSON.parse((await SecureStore.getItemAsync(READY_TOKEN_KEY)) ?? 'null') as { userId: string; matchId: string; token: string } | null;

beforeEach(async () => {
  jest.clearAllMocks();
  resetAccountStoreForTests();
  resetSocialStoreForTests();
  resetMatchmakingStoreForTests();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  startupRouting.reset();
  await SecureStore.deleteItemAsync(READY_TOKEN_KEY);
  version = 1;
  for (const [name, call] of Object.entries(api)) (call as jest.Mock).mockResolvedValue(name === 'nudge' ? undefined : OFFLINE);
  pathname.mockReturnValue('/play-online');
  sync = null;
  syncMock.mockImplementation((_userId, handlers) => {
    sync = handlers;
    return () => void (sync = null);
  });
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    const listener = handler as (next: AppStateStatus) => void;
    appStateListeners.push(listener);
    return { remove: () => void (appStateListeners = appStateListeners.filter((l) => l !== listener)) } as never;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// =============================================================================================
describe('Home', () => {
  it('has Play Online next to every existing action, and it opens the matchmaking screen', async () => {
    pathname.mockReturnValue('/');
    await render(<Home />);
    for (const testID of ['create-game', 'join-game', 'open-friends', 'open-learning', 'open-rules', 'play-online']) expect(screen.getByTestId(testID)).toBeTruthy();
    expect(screen.getByTestId('play-online')).toHaveTextContent(/PLAY ONLINE.*Random match/);
    await press('play-online');
    expect(router.push).toHaveBeenLastCalledWith('/play-online');
  });

  it('says what is going on: an invitation, a party, a search, a match to confirm', async () => {
    pathname.mockReturnValue('/');
    await loaded({ partyInvites: [{ id: 'pi-1', mode: 'classic', size: 2, inviter: { playerId: 'RR-FFFFF2', nickname: 'Farah' }, expiresAt: soon(600_000) }] });
    await render(<Home />);
    expect(screen.getByTestId('play-online')).toHaveTextContent(/1 party invitation/);
    expect(screen.getByTestId('play-online-badge')).toHaveTextContent('1');
    await serverChanges({ party: party() });
    expect(screen.getByTestId('play-online')).toHaveTextContent(/In a party · 2 players/);
    await serverChanges({ ticket: ticket() });
    expect(screen.getByTestId('play-online')).toHaveTextContent(/Searching for a match/);
    await serverChanges(reserved());
    expect(screen.getByTestId('play-online')).toHaveTextContent(/Match found/);
  });
});

// =============================================================================================
describe('entering the queue', () => {
  it('shows nothing about a queue until the server has answered — the phone remembers none of it', async () => {
    let answer!: (value: unknown) => void;
    api.state.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    await signIn(ME);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    expect(screen.getByTestId('online-loading')).toBeTruthy();
    expect(screen.queryByTestId('online-solo')).toBeNull();
    expect(screen.queryByTestId('search-status')).toBeNull();
    // The server says this account is searching (it was, before the app was closed).
    await act(async () => answer(good(serverState({ ticket: ticket({ mode: 'intermediate' }) }))));
    expect(screen.getByTestId('search-status')).toBeTruthy();
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Capital · Solo/);
  });

  it('a first load that fails says so and can be retried', async () => {
    api.state.mockResolvedValue(OFFLINE);
    await signIn(ME);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('online-load-error')).toBeTruthy());
    expect(screen.getByTestId('online-load-error')).toHaveTextContent(/Queue state could not be refreshed.*No connection/);
    serverHas();
    await press('online-retry');
    await waitFor(() => expect(screen.getByTestId('online-solo')).toBeTruthy());
  });

  it('without a confirmed profile there is nothing to queue with', async () => {
    await signIn(null);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    expect(screen.getByTestId('online-loading')).toHaveTextContent(/profile isn’t ready/);
    expect(api.state).not.toHaveBeenCalled();
    expect(screen.queryByTestId('online-solo')).toBeNull();
  });

  it('solo: choose a mode, search — the screen changes only when the server says the ticket exists', async () => {
    await loaded();
    await render(<PlayOnline />);
    expect(screen.getByTestId('online-mode-classic').props.accessibilityState.selected).toBe(true);
    await press('online-mode-intermediate');
    expect(screen.getByTestId('online-solo')).toHaveTextContent(/Play solo · Capital/);

    let answer!: (value: unknown) => void;
    api.enqueue.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    await press('online-solo');
    expect(api.enqueue).toHaveBeenCalledWith('intermediate', expect.any(String));
    // Sent, not yet confirmed: still the entry screen, with a spinner. A second tap sends nothing.
    expect(screen.queryByTestId('search-status')).toBeNull();
    await press('online-solo');
    expect(api.enqueue).toHaveBeenCalledTimes(1);

    serverHas({ ticket: ticket({ mode: 'intermediate', queuedAt: soon(-65_000) }) });
    await act(async () => answer(DONE));
    expect(screen.getByTestId('search-status')).toBeTruthy();
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Searching….*Capital · Solo/);
    expect(screen.getByTestId('search-elapsed')).toHaveTextContent(/^1:0[4-6]$/);
    expect(screen.getByTestId('search-cancel')).toBeTruthy();
    // The worker is asked to look now rather than at its next run.
    expect(api.nudge).toHaveBeenCalled();
  });

  it('a request that never got an answer: the state is fetched first, and a retry is the SAME request', async () => {
    await loaded();
    await render(<PlayOnline />);
    api.enqueue.mockResolvedValueOnce(OFFLINE);
    api.state.mockClear();
    await press('online-solo');
    await waitFor(() => expect(screen.getByTestId('online-error')).toHaveTextContent(/couldn’t tell whether that went through/));
    // Unknown outcome: the phone asked the server what is true before offering anything else.
    expect(api.state).toHaveBeenCalled();
    const firstKey = api.enqueue.mock.calls[0]![1];
    api.enqueue.mockResolvedValueOnce(DONE);
    serverHas({ ticket: ticket() });
    await press('online-solo');
    await waitFor(() => expect(screen.getByTestId('search-status')).toBeTruthy());
    expect(api.enqueue.mock.calls[1]![1]).toBe(firstKey);
    // The ticket turned out to exist: no second one was asked for under a new key.
    expect(api.enqueue).toHaveBeenCalledTimes(2);
  });

  it('the lost request did reach the server: the fetched state shows the search, and nothing is sent again', async () => {
    await loaded();
    await render(<PlayOnline />);
    api.enqueue.mockResolvedValueOnce(OFFLINE);
    serverHas({ ticket: ticket() });
    await press('online-solo');
    await waitFor(() => expect(screen.getByTestId('search-status')).toBeTruthy());
    expect(api.enqueue).toHaveBeenCalledTimes(1);
  });

  it('says why matchmaking cannot start: maintenance, a cooldown, a game or a lobby this player is in', async () => {
    await loaded({ settings: { ...SETTINGS, enabled: false } });
    await render(<PlayOnline />);
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/closed for maintenance/);
    expect(disabled('online-solo')).toBe(true);
    expect(disabled('online-party')).toBe(true);

    await serverChanges({ cooldownUntilMs: Date.now() + 25_000 });
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/missed a match.*2[4-6] seconds/);
    expect(disabled('online-solo')).toBe(true);

    await serverChanges({ liveGame: { gameId: 'game-9', status: 'ACTIVE', matchmade: true } });
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/already in a game/);

    await serverChanges({ liveGame: { gameId: 'game-9', status: 'WAITING', matchmade: false } });
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/private lobby. Leave it/);
    await press('online-solo');
    expect(api.enqueue).not.toHaveBeenCalled();

    await serverChanges({});
    expect(screen.queryByTestId('online-blocker')).toBeNull();
    expect(disabled('online-solo')).toBe(false);
  });

  it('a lobby this phone joined by code blocks queueing even if the account does not know of it', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    f.loadAs('Asha');
    await loaded();
    await render(<PlayOnline />);
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/private lobby/);
    expect(disabled('online-solo')).toBe(true);
    await press('online-resume');
    expect(router.push).toHaveBeenLastCalledWith(`/lobby/${f.state.id}`);
  });

  it('what the server refuses is said in plain words, never as a code', async () => {
    await loaded();
    await render(<PlayOnline />);
    api.enqueue.mockResolvedValueOnce(bad('ALREADY_IN_GAME', 'You’re already in a game. Finish or leave it before playing online.'));
    await press('online-solo');
    await waitFor(() => expect(screen.getByTestId('online-error')).toHaveTextContent('You’re already in a game. Finish or leave it before playing online.'));
    expect(screen.getByTestId('play-online-screen')).not.toHaveTextContent(/ALREADY_IN_GAME|SQL|stack/i);
  });

  it('Back goes Home and keeps the search running', async () => {
    await loaded({ ticket: ticket() });
    await render(<PlayOnline />);
    await press('search-home');
    expect(router.back).toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });
});

// =============================================================================================
describe('searching and cancelling', () => {
  it('shows the mode, the party size, the time waited and what the queue is doing', async () => {
    await loaded({ ticket: ticket({ queuedAt: soon(-5000) }) });
    await render(<PlayOnline />);
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Classic · Solo/);
    expect(screen.getByTestId('search-elapsed')).toHaveTextContent(/^0:0[4-6]$/);
    expect(screen.getByTestId('search-hint')).toHaveTextContent(/table of 4/);
    await serverChanges({ ticket: ticket({ queuedAt: soon(-40_000) }) });
    expect(screen.getByTestId('search-hint')).toHaveTextContent(/any table of two or more/);
    await serverChanges({ ticket: ticket({ queuedAt: soon(-90_000) }) });
    expect(screen.getByTestId('search-hint')).toHaveTextContent(/as soon as another player arrives/);
    await serverChanges({ ticket: ticket({ queuedAt: soon(-90_000), requeueCount: 1 }) });
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/kept your place in the queue/);
  });

  it('cancel: the screen says "cancelled" only after the server has said so', async () => {
    await loaded({ ticket: ticket() });
    await render(<PlayOnline />);
    let answer!: (value: unknown) => void;
    api.cancel.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    await press('search-cancel');
    // Still searching on screen; tapping again and again sends one request.
    expect(screen.getByTestId('search-status')).toBeTruthy();
    await press('search-cancel');
    await press('search-cancel');
    expect(api.cancel).toHaveBeenCalledTimes(1);
    serverHas({ lastResult: { ticketId: 'ticket-1', status: 'CANCELLED', reason: 'CANCELLED_BY_PLAYER', at: soon(0) } });
    await act(async () => answer(good({ cancelled: true, status: 'CANCELLED' })));
    expect(screen.getByTestId('online-solo')).toBeTruthy();
    // Stopping your own search is not an error to be told about.
    expect(screen.queryByTestId('online-last-result')).toBeNull();
  });

  it('cancel against a reservation: the server reserved first, so the player is taken to the match — not told "cancelled"', async () => {
    await loaded({ ticket: ticket() });
    await render(<PlayOnline />);
    api.cancel.mockResolvedValueOnce(good({ cancelled: false, status: 'RESERVED' }));
    serverHas(reserved());
    await press('search-cancel');
    await waitFor(() => expect(screen.getByTestId('match-countdown')).toBeTruthy());
    expect(screen.queryByTestId('online-solo')).toBeNull();
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Match found!/);
  });

  it('a cancel whose answer was lost: the server is asked what happened', async () => {
    await loaded({ ticket: ticket() });
    await render(<PlayOnline />);
    api.cancel.mockResolvedValueOnce(OFFLINE);
    api.state.mockClear();
    await press('search-cancel');
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    // The server still has the ticket: still searching, and the player is told the outcome was unclear.
    expect(screen.getByTestId('search-status')).toBeTruthy();
    expect(screen.getByTestId('online-error')).toHaveTextContent(/couldn’t tell/);
  });

  it('why a search ended is explained once the server reports it', async () => {
    await loaded({ lastResult: { ticketId: 't-9', status: 'CANCELLED', reason: 'READY_TIMEOUT', at: soon(-1000) } });
    await render(<PlayOnline />);
    expect(screen.getByTestId('online-last-result')).toHaveTextContent(/Ready-up timed out/);
    await serverChanges({ lastResult: { ticketId: 't-10', status: 'EXPIRED', reason: 'DISCONNECTED', at: soon(-1000) } });
    expect(screen.getByTestId('online-last-result')).toHaveTextContent(/disconnected for too long/);
  });
});

// =============================================================================================
describe('match found and ready-up', () => {
  it('shows the mode, every assigned player, who queued together, who has confirmed, and the server’s countdown', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    const screenText = screen.getByTestId('play-online-screen');
    expect(screenText).toHaveTextContent(/Match found!.*Classic mode/);
    expect(Number(screen.getByTestId('match-countdown').props.children)).toBeGreaterThanOrEqual(14);
    expect(Number(screen.getByTestId('match-countdown').props.children)).toBeLessThanOrEqual(15);
    expect(screen.getByTestId('match-players')).toHaveTextContent(/Classic · 4 players/);
    expect(screen.getByTestId(`match-player-${ME.playerId}`)).toHaveTextContent(/Me \(you\).*Waiting/);
    expect(screen.getByTestId('match-player-RR-BBBBB2')).toHaveTextContent(/Bilal.*Ready/);
    // The two who queued together are shown as a party; solo players are not.
    expect(screen.getByTestId('match-group-3')).toHaveTextContent(/Party of 2.*Bilal.*Chitra/);
    expect(within(screen.getByTestId('match-group-2')).queryByText(/Party of/)).toBeNull();
    // Nothing private: Player IDs and nicknames only.
    expect(screenText).not.toHaveTextContent(/user-|@|token/i);
  });

  it('the countdown follows the server’s deadline, not a timer started on the phone', async () => {
    jest.useFakeTimers();
    await loaded(reserved(match({ readyDeadline: soon(12_000) })));
    await render(<PlayOnline />);
    expect(screen.getByTestId('match-countdown')).toHaveTextContent('12');
    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.getByTestId('match-countdown')).toHaveTextContent('7');
    // Reconnecting brings the same deadline: the count does not start over.
    await serverChanges(reserved(match({ readyDeadline: new Date(Date.now() + 7000).toISOString() })));
    expect(screen.getByTestId('match-countdown')).toHaveTextContent('7');
    await act(async () => jest.advanceTimersByTime(8000));
    expect(screen.getByTestId('match-countdown')).toHaveTextContent('0');
    expect(disabled('match-ready')).toBe(true);
    expect(disabled('match-decline')).toBe(true);
  });

  it('Ready: the seat token is stored on the phone first, sent once, and the same one is sent on a retry', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    api.ready.mockResolvedValueOnce(OFFLINE);
    await press('match-ready');
    await waitFor(() => expect(api.ready).toHaveBeenCalledTimes(1));
    const kept = (await storedToken())!;
    expect(kept).toMatchObject({ userId: ME.userId, matchId: 'match-1' });
    expect(kept.token).toMatch(/^[0-9a-f]{64}$/);
    expect(api.ready).toHaveBeenLastCalledWith('match-1', kept.token);

    api.ready.mockResolvedValueOnce(good({ allReady: false }));
    const me = { ...match().players[0]!, ready: true };
    serverHas(reserved(match({ players: [me, ...match().players.slice(1)] })));
    await press('match-ready');
    await waitFor(() => expect(screen.getByTestId('match-ready')).toHaveTextContent(/YOU’RE READY.*Waiting for 2 more/));
    expect(api.ready).toHaveBeenLastCalledWith('match-1', kept.token);
    expect(disabled('match-ready')).toBe(true);
  });

  it('the phone never declares the match ready: "starting" appears only when the server says everyone confirmed', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    api.ready.mockResolvedValueOnce(good({ allReady: true }));
    // The answer says all ready, but the state the server sends is what the screen shows.
    serverHas(reserved(match({ status: 'STARTING', players: match().players.map((p) => ({ ...p, ready: true })) })));
    await press('match-ready');
    await waitFor(() => expect(screen.getByTestId('online-starting')).toHaveTextContent(/Everyone is ready.*setting up the game/));
    expect(api.nudge).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(useSessionStore.getState().session).toBeNull();
  });

  it('declining waits for the server and then explains what happened', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    api.decline.mockResolvedValueOnce(DONE);
    serverHas({ cooldownUntilMs: Date.now() + 30_000, lastResult: { ticketId: 'ticket-1', status: 'CANCELLED', reason: 'DECLINED', at: soon(0) } });
    await press('match-decline');
    await waitFor(() => expect(screen.getByTestId('online-last-result')).toHaveTextContent(/Match declined/));
    expect(api.decline).toHaveBeenCalledWith('match-1');
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/search again in/);
  });

  it('a confirmation the server refused (too late, or made on another device) is said plainly', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    api.ready.mockResolvedValueOnce(bad('READY_TIMEOUT', 'Ready-up timed out. The match was cancelled.'));
    await press('match-ready');
    await waitFor(() => expect(screen.getByTestId('online-error')).toHaveTextContent(/Ready-up timed out/));
    api.ready.mockResolvedValueOnce(bad('SEAT_ON_OTHER_DEVICE', 'You confirmed this match on another device. Continue there.'));
    await press('match-ready');
    await waitFor(() => expect(screen.getByTestId('online-error')).toHaveTextContent(/another device/));
  });

  it('a match that fell through because someone else did not confirm: searching again, place kept', async () => {
    await loaded(reserved());
    await render(<PlayOnline />);
    await serverChanges({ ticket: ticket({ requeueCount: 1 }) });
    expect(screen.getByTestId('search-status')).toBeTruthy();
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/someone didn’t confirm.*kept your place/);
  });
});

// =============================================================================================
describe('the lifecycle host', () => {
  const mount = () => render(<MatchmakingHost />);

  it('fetches on sign-in, listens on ONE channel for the account, and closes it on sign-out', async () => {
    serverHas();
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(ME.userId, expect.anything());
    // Queueing, a party, a match: still the one channel.
    await serverChanges({ ticket: ticket(), party: party({ locked: true }) });
    await serverChanges(reserved());
    expect(syncMock).toHaveBeenCalledTimes(1);
    await signIn(null);
    expect(sync).toBeNull();
    expect(mm().data).toBeNull();
  });

  it('a Realtime ping refetches only when it announces something newer; duplicates and late events do nothing', async () => {
    serverHas();
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    const known = mm().data!.version;
    api.state.mockClear();
    await act(async () => sync!.onVersion(known));
    await act(async () => sync!.onVersion(known - 1));
    expect(api.state).not.toHaveBeenCalled();
    serverHas({ ticket: ticket() });
    await act(async () => sync!.onVersion(known + 1));
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(mm().data!.ticket).not.toBeNull();
    // An event that carries no version means "look".
    await act(async () => sync!.onVersion(Number.NaN));
    expect(api.state).toHaveBeenCalledTimes(2);
  });

  it('an older answer that arrives late never replaces a newer one', async () => {
    await loaded({ ticket: ticket() });
    const newer = mm().data!;
    const stale = { ...serverState(), version: newer.version - 1 };
    api.state.mockResolvedValue(good(stale));
    await act(() => mm().refresh());
    expect(mm().data).toBe(newer);
  });

  it('refetches when the app comes back to the foreground and when Realtime reconnects; polls only while Realtime is down', async () => {
    jest.useFakeTimers();
    serverHas();
    await signIn(ME);
    await mount();
    await act(async () => jest.advanceTimersByTime(0));
    await realtime('live');
    api.state.mockClear();
    await act(async () => jest.advanceTimersByTime(5 * 60_000));
    expect(api.state).not.toHaveBeenCalled();

    await appState('background');
    await appState('active');
    expect(api.state).toHaveBeenCalledTimes(1);

    await realtime('down');
    await act(async () => jest.advanceTimersByTime(15_000));
    expect(api.state).toHaveBeenCalledTimes(2);
    await realtime('live');
    expect(api.state).toHaveBeenCalledTimes(3);
    await act(async () => jest.advanceTimersByTime(5 * 60_000));
    expect(api.state).toHaveBeenCalledTimes(3);
  });

  it('heartbeat: only while searching or in a party, only in front; it notices a missed event and nudges the worker when due', async () => {
    jest.useFakeTimers();
    serverHas();
    await signIn(ME);
    await mount();
    await act(async () => jest.advanceTimersByTime(0));
    await realtime('live');
    // Nothing to keep alive: no heartbeat at all, however long the app sits there.
    await act(async () => jest.advanceTimersByTime(120_000));
    expect(api.heartbeat).not.toHaveBeenCalled();

    await serverChanges({ ticket: ticket() });
    api.heartbeat.mockResolvedValue(good({ version: mm().data!.version, tickDue: false }));
    await act(async () => jest.advanceTimersByTime(11_500));
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.nudge).not.toHaveBeenCalled();

    // The server has moved on and no event said so: the heartbeat's version shows it.
    const next = serverState(reserved());
    api.state.mockResolvedValue(good(next));
    api.heartbeat.mockResolvedValue(good({ version: next.version, tickDue: true }));
    await act(async () => jest.advanceTimersByTime(11_500));
    expect(mm().data!.match).not.toBeNull();
    expect(api.nudge).toHaveBeenCalledTimes(1);

    // In the background nothing is sent; the server's grace period covers a short absence.
    const sent = api.heartbeat.mock.calls.length;
    await appState('background');
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(api.heartbeat).toHaveBeenCalledTimes(sent);
    await appState('active');
    await act(async () => jest.advanceTimersByTime(11_500));
    expect(api.heartbeat.mock.calls.length).toBeGreaterThan(sent);
  });

  it('heartbeats that fail: one miss is nothing, then "Reconnecting…" with a growing, bounded wait — never a tight loop', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    serverHas({ ticket: ticket() });
    await signIn(ME);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    await act(async () => jest.advanceTimersByTime(0));
    await realtime('live');
    api.heartbeat.mockResolvedValue(OFFLINE);
    await act(async () => jest.advanceTimersByTime(10_500));
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('online-reconnecting')).toBeNull();
    await act(async () => jest.advanceTimersByTime(16_000));
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('online-reconnecting')).toHaveTextContent(/place in the queue is kept/);
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Reconnecting…/);
    // Ten minutes without a server: a handful of attempts, not hundreds.
    await act(async () => jest.advanceTimersByTime(10 * 60_000));
    expect(api.heartbeat.mock.calls.length).toBeLessThan(25);
    // The connection returns: the banner goes, the normal rhythm resumes.
    api.heartbeat.mockResolvedValue(good({ version: mm().data!.version, tickDue: false }));
    await act(async () => jest.advanceTimersByTime(61_000));
    expect(screen.queryByTestId('online-reconnecting')).toBeNull();
  });

  it('a countdown that ran out with no word from the server: the phone asks, a few times, then stops', async () => {
    jest.useFakeTimers();
    serverHas(reserved(match({ readyDeadline: soon(3000) })));
    await signIn(ME);
    await mount();
    await act(async () => jest.advanceTimersByTime(0));
    await realtime('live');
    api.heartbeat.mockResolvedValue(good({ version: mm().data!.version, tickDue: false }));
    api.state.mockClear();
    await act(async () => jest.advanceTimersByTime(3000 + 1600));
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(api.nudge).toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(10 * 60_000));
    // Six checks spread over about twenty seconds, then nothing more from this path.
    expect(api.state.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('a match found while the player is elsewhere in the app brings them to it, once', async () => {
    pathname.mockReturnValue('/friends');
    serverHas({ ticket: ticket() });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    expect(router.push).not.toHaveBeenCalled();
    await serverChanges(reserved());
    expect(router.push).toHaveBeenCalledWith('/play-online');
    expect(useGameStore.getState().notice?.message).toMatch(/Match found/);
    // The same match announced again (a duplicate event, a refresh) does not navigate again.
    await serverChanges(reserved());
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('the game starts: the phone opens its seat with the token it confirmed with and goes to the game', async () => {
    await SecureStore.setItemAsync(READY_TOKEN_KEY, JSON.stringify({ userId: ME.userId, matchId: 'match-1', token: 'c'.repeat(64) }));
    serverHas(reserved(match({ status: 'STARTING' })));
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    await serverChanges({ game: { matchId: 'match-1', gameId: 'game-7', seatId: 'seat-3', mode: 'classic' } });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/game/game-7'));
    expect(useSessionStore.getState().session).toEqual({ gameId: 'game-7', playerId: 'seat-3', token: 'c'.repeat(64) });
    expect(useGameStore.getState().gameId).toBe('game-7');
    expect(await storedToken()).toBeNull();
    // Told again (a duplicate event): no second navigation, the same session.
    await serverChanges({ game: { matchId: 'match-1', gameId: 'game-7', seatId: 'seat-3', mode: 'classic' } });
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('the game-start news arrives before the phone ever saw the reservation: it still ends up in the right game', async () => {
    await SecureStore.setItemAsync(READY_TOKEN_KEY, JSON.stringify({ userId: ME.userId, matchId: 'match-1', token: 'd'.repeat(64) }));
    serverHas({ ticket: ticket() });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    // Straight from "searching" to "playing": the events in between were missed.
    await serverChanges({ game: { matchId: 'match-1', gameId: 'game-8', seatId: 'seat-1', mode: 'intermediate' } });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/game/game-8'));
    expect(useSessionStore.getState().session).toMatchObject({ gameId: 'game-8', playerId: 'seat-1' });
  });

  it('after a restart during the countdown the server names the game, and the stored token opens the same seat', async () => {
    await SecureStore.setItemAsync(READY_TOKEN_KEY, JSON.stringify({ userId: ME.userId, matchId: 'match-1', token: 'e'.repeat(64) }));
    serverHas({ game: { matchId: 'match-1', gameId: 'game-9', seatId: 'seat-2', mode: 'classic' }, liveGame: { gameId: 'game-9', status: 'ACTIVE', matchmade: true } });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/game/game-9'));
    expect(useSessionStore.getState().session).toEqual({ gameId: 'game-9', playerId: 'seat-2', token: 'e'.repeat(64) });
  });

  it('a phone that already holds the seat is not sent anywhere, and its session is left alone', async () => {
    useSessionStore.setState({ session: { gameId: 'game-9', playerId: 'seat-2', token: 'f'.repeat(64) }, hydrated: true });
    serverHas({ game: { matchId: 'match-1', gameId: 'game-9', seatId: 'seat-2', mode: 'classic' } });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    await act(async () => undefined);
    expect(router.replace).not.toHaveBeenCalled();
    expect(useSessionStore.getState().session!.token).toBe('f'.repeat(64));
  });

  it('a second device of the same account, which did not confirm, gets no seat and says where the game is', async () => {
    serverHas({ game: { matchId: 'match-1', gameId: 'game-7', seatId: 'seat-3', mode: 'classic' } });
    await signIn(ME);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('online-seat-elsewhere')).toBeTruthy());
    expect(screen.getByTestId('online-seat-elsewhere')).toHaveTextContent(/another device/);
    expect(useSessionStore.getState().session).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('a token kept for another account is never used', async () => {
    await SecureStore.setItemAsync(READY_TOKEN_KEY, JSON.stringify({ userId: OTHER_ACCOUNT.userId, matchId: 'match-1', token: 'c'.repeat(64) }));
    serverHas({ game: { matchId: 'match-1', gameId: 'game-7', seatId: 'seat-3', mode: 'classic' } });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().seatElsewhere).toBe('game-7'));
    expect(useSessionStore.getState().session).toBeNull();
  });

  it('switching accounts wipes everything at once: the other player’s search is never shown, and a late answer is dropped', async () => {
    serverHas({ ticket: ticket(), party: party({ locked: true }) });
    await signIn(ME);
    await render(
      <>
        <MatchmakingHost />
        <PlayOnline />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('search-status')).toBeTruthy());

    // A refresh for the first account is still on its way when the account changes.
    let lateAnswer!: (value: unknown) => void;
    api.state.mockReturnValueOnce(new Promise((resolve) => (lateAnswer = resolve)) as never);
    void mm().refresh();
    let otherAnswer!: (value: unknown) => void;
    api.state.mockReturnValue(new Promise((resolve) => (otherAnswer = resolve)) as never);
    await signIn(OTHER_ACCOUNT);
    expect(mm().ownerUserId).toBe(OTHER_ACCOUNT.userId);
    expect(mm().data).toBeNull();
    expect(screen.queryByTestId('search-status')).toBeNull();
    expect(screen.queryByTestId('party-members')).toBeNull();
    expect(screen.getByTestId('online-loading')).toBeTruthy();
    expect(syncMock).toHaveBeenLastCalledWith(OTHER_ACCOUNT.userId, expect.anything());

    await act(async () => lateAnswer(good(serverState({ ticket: ticket({ id: 'ticket-of-me' }) }))));
    expect(mm().data).toBeNull();
    await act(async () => otherAnswer(good(serverState())));
    expect(screen.getByTestId('online-solo')).toBeTruthy();
    expect(mm().data!.ticket).toBeNull();
  });

  it('a request sent for one account never reports its outcome to the next', async () => {
    await loaded();
    let answer!: (value: unknown) => void;
    api.enqueue.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    const sent = mm().enqueue('classic');
    mm().attach(OTHER_ACCOUNT.userId);
    await act(async () => answer(DONE));
    expect(await sent).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    expect(mm().pending).toEqual({});
  });

  it('news is told once: why a search ended, and who sent a party invitation', async () => {
    pathname.mockReturnValue('/');
    // What was already there at sign-in is history, not news.
    serverHas({ lastResult: { ticketId: 't-1', status: 'EXPIRED', reason: 'DISCONNECTED', at: soon(-60_000) } });
    await signIn(ME);
    await mount();
    await waitFor(() => expect(mm().phase).toBe('ready'));
    expect(useGameStore.getState().notice).toBeNull();

    await serverChanges({ lastResult: { ticketId: 't-2', status: 'CANCELLED', reason: 'READY_TIMEOUT', at: soon(0) } });
    expect(useGameStore.getState().notice).toMatchObject({ kind: 'error', message: expect.stringMatching(/Ready-up timed out/) });
    useGameStore.getState().dismissNotice();
    await serverChanges({ lastResult: { ticketId: 't-2', status: 'CANCELLED', reason: 'READY_TIMEOUT', at: soon(0) } });
    expect(useGameStore.getState().notice).toBeNull();

    const invite = { id: 'pi-1', mode: 'classic' as const, size: 2, inviter: { playerId: 'RR-FFFFF2', nickname: 'Farah' }, expiresAt: soon(600_000) };
    await serverChanges({ partyInvites: [invite] });
    expect(useGameStore.getState().notice).toMatchObject({ kind: 'info', message: 'Farah invited you to their party' });
    useGameStore.getState().dismissNotice();
    await serverChanges({ partyInvites: [invite] });
    expect(useGameStore.getState().notice).toBeNull();
    // Stopping your own search is not announced.
    await serverChanges({ lastResult: { ticketId: 't-3', status: 'CANCELLED', reason: 'CANCELLED_BY_PLAYER', at: soon(0) } });
    expect(useGameStore.getState().notice).toBeNull();
  });
});

// =============================================================================================
describe('parties', () => {
  const FARAH = { playerId: 'RR-FFFFF2', nickname: 'Farah', presenceKey: 'key-farah', since: '2026-10-01T00:00:00.000Z' };
  const GAURI = { playerId: 'RR-GGGGG2', nickname: 'Gauri', presenceKey: 'key-gauri', since: '2026-10-02T00:00:00.000Z' };

  function friendsLoaded() {
    const social: SocialState = {
      version: 2,
      serverTime: new Date().toISOString(),
      me: { playerId: ME.playerId, presenceKey: 'key-me' },
      friends: [FARAH, GAURI],
      incoming: [],
      outgoing: [],
      blocked: [],
      invites: [],
      sentInvites: [],
      notifications: [],
      unread: 0,
    };
    useSocialStore.setState({ ownerUserId: ME.userId, phase: 'ready', data: social });
  }

  it('"Play with friends" makes a party in the chosen mode — and queues nobody', async () => {
    await loaded();
    await render(<PlayOnline />);
    await press('online-mode-intermediate');
    api.createParty.mockResolvedValueOnce(DONE);
    serverHas({ party: party({ mode: 'intermediate', members: [member(ME.playerId, 'Me', { isLeader: true, isMe: true, ready: true })] }) });
    await press('online-party');
    await waitFor(() => expect(screen.getByTestId('party-members')).toBeTruthy());
    expect(api.createParty).toHaveBeenCalledWith('intermediate');
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(screen.getByTestId('online-mode-intermediate').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('party-start')).toHaveTextContent(/FIND MATCH.*Capital · just you/);
  });

  it('an invitation into a party is shown for what it is, and accepting it joins the party — nothing else', async () => {
    await loaded({ partyInvites: [{ id: 'pi-1', mode: 'intermediate', size: 3, inviter: { playerId: FARAH.playerId, nickname: 'Farah' }, expiresAt: soon(9 * 60_000) }] });
    await render(<PlayOnline />);
    const card = screen.getByTestId('party-invite-pi-1');
    expect(card).toHaveTextContent(/Party invitation.*Farah invited you to their party.*Capital · 3 players so far.*expires in [89]:\d\d/);
    expect(card).toHaveTextContent(/doesn’t start anything/);
    api.respondInvite.mockResolvedValueOnce(DONE);
    serverHas({ party: party({ isLeader: false, mode: 'intermediate', members: [member(FARAH.playerId, 'Farah', { isLeader: true, ready: true }), member(ME.playerId, 'Me', { isMe: true })] }) });
    await press('party-invite-accept-pi-1');
    await waitFor(() => expect(screen.getByTestId('party-ready')).toBeTruthy());
    expect(api.respondInvite).toHaveBeenCalledWith('pi-1', true);
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(api.setReady).not.toHaveBeenCalled();
  });

  it('declining an invitation sends exactly that', async () => {
    await loaded({ partyInvites: [{ id: 'pi-1', mode: 'classic', size: 2, inviter: { playerId: FARAH.playerId, nickname: 'Farah' }, expiresAt: soon(600_000) }] });
    await render(<PlayOnline />);
    api.respondInvite.mockResolvedValueOnce(DONE);
    serverHas();
    await press('party-invite-decline-pi-1');
    await waitFor(() => expect(screen.queryByTestId('party-invite-pi-1')).toBeNull());
    expect(api.respondInvite).toHaveBeenCalledWith('pi-1', false);
  });

  it('the leader sees who is ready, cannot start for someone who is not, and is told who', async () => {
    await loaded({ party: party() });
    await render(<PlayOnline />);
    expect(screen.getByTestId(`party-member-${ME.playerId}`)).toHaveTextContent(/Me \(you\).*Leader/);
    expect(screen.getByTestId('party-member-RR-FFFFF2')).toHaveTextContent(/Farah.*Not ready/);
    expect(screen.getByTestId('online-blocker')).toHaveTextContent('Waiting for Farah to be ready.');
    expect(disabled('party-start')).toBe(true);
    await press('party-start');
    expect(api.enqueue).not.toHaveBeenCalled();

    await serverChanges({ party: party({ members: [party().members[0]!, member('RR-FFFFF2', 'Farah', { ready: true, online: false })] }) });
    expect(screen.getByTestId('online-blocker')).toHaveTextContent(/Farah isn’t connected/);
    expect(disabled('party-start')).toBe(true);

    await serverChanges({ party: party({ members: [party().members[0]!, member('RR-FFFFF2', 'Farah', { ready: true })] }) });
    expect(screen.queryByTestId('online-blocker')).toBeNull();
    expect(screen.getByTestId('party-all-ready')).toHaveTextContent(/Everyone is ready/);
    api.enqueue.mockResolvedValueOnce(DONE);
    serverHas({ party: party({ locked: true, members: [party().members[0]!, member('RR-FFFFF2', 'Farah', { ready: true })] }), ticket: ticket({ kind: 'party', playerCount: 2 }) });
    await press('party-start');
    // The party's own mode is used: the phone names none.
    expect(api.enqueue).toHaveBeenCalledWith(null, expect.any(String));
    await waitFor(() => expect(screen.getByTestId('search-status')).toBeTruthy());
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Classic · 2 players/);
    expect(screen.getByTestId('party-members')).toBeTruthy();
  });

  it('a member confirms for themselves, sees the leader’s mode but cannot change it, and cannot start or stop the search', async () => {
    const asMember = party({ isLeader: false, mode: 'intermediate', members: [member('RR-FFFFF2', 'Farah', { isLeader: true, ready: true }), member(ME.playerId, 'Me', { isMe: true })] });
    await loaded({ party: asMember });
    await render(<PlayOnline />);
    expect(screen.queryByTestId('party-start')).toBeNull();
    expect(screen.queryByTestId('party-invite')).toBeNull();
    expect(screen.queryByTestId('party-kick-RR-FFFFF2')).toBeNull();
    expect(screen.getByTestId('online-mode-intermediate').props.accessibilityState).toMatchObject({ selected: true, disabled: true });
    await press('online-mode-classic');
    expect(api.setMode).not.toHaveBeenCalled();

    api.setReady.mockResolvedValueOnce(DONE);
    serverHas({ party: { ...asMember, members: [asMember.members[0]!, member(ME.playerId, 'Me', { isMe: true, ready: true })] } });
    await press('party-ready');
    expect(api.setReady).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('party-ready')).toHaveTextContent(/NOT READY/));
    expect(screen.getByTestId('party-all-ready')).toHaveTextContent(/Waiting for the leader/);

    // Queued by the leader: the member can leave the party, not cancel the party's search.
    await serverChanges({ party: { ...asMember, locked: true }, ticket: ticket({ kind: 'party', mode: 'intermediate', playerCount: 2 }) });
    expect(screen.queryByTestId('search-cancel')).toBeNull();
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Only the party leader can stop the search/);
    api.leaveParty.mockResolvedValueOnce(DONE);
    serverHas();
    await press('party-leave');
    await waitFor(() => expect(screen.getByTestId('online-solo')).toBeTruthy());
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('the leader changes the mode; the server’s answer shows that everyone must confirm again', async () => {
    const ready = party({ members: [party().members[0]!, member('RR-FFFFF2', 'Farah', { ready: true })] });
    await loaded({ party: ready });
    await render(<PlayOnline />);
    api.setMode.mockResolvedValueOnce(DONE);
    serverHas({ party: party({ mode: 'intermediate' }) });
    await press('online-mode-intermediate');
    expect(api.setMode).toHaveBeenCalledWith('intermediate');
    await waitFor(() => expect(screen.getByTestId('party-member-RR-FFFFF2')).toHaveTextContent(/Not ready/));
    expect(disabled('party-start')).toBe(true);
    // Tapping the mode that is already selected sends nothing.
    await press('online-mode-intermediate');
    expect(api.setMode).toHaveBeenCalledTimes(1);
  });

  it('the leader invites friends from the Friends list; "Invited" appears only once the server has confirmed it', async () => {
    friendsLoaded();
    await loaded({ party: party() });
    await render(<PlayOnline />);
    await press('party-invite');
    const sheet = screen.getByTestId('party-invite-sheet');
    expect(within(sheet).getByTestId('party-invite-row-RR-FFFFF2')).toHaveTextContent(/Farah.*In party/);
    let answer!: (value: unknown) => void;
    api.invite.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    await press('party-invite-send-RR-GGGGG2');
    expect(api.invite).toHaveBeenCalledWith('RR-GGGGG2');
    expect(within(sheet).getByTestId('party-invite-row-RR-GGGGG2')).not.toHaveTextContent(/Invited/);
    serverHas({ party: party({ invites: [{ id: 'pi-9', playerId: 'RR-GGGGG2', nickname: 'Gauri', expiresAt: soon(900_000) }] }) });
    await act(async () => answer(DONE));
    expect(within(screen.getByTestId('party-invite-sheet')).getByTestId('party-invite-row-RR-GGGGG2')).toHaveTextContent(/Gauri.*Invited/);
    expect(screen.getByTestId('party-pending-invites')).toHaveTextContent(/Gauri/);

    api.revokeInvite.mockResolvedValueOnce(DONE);
    serverHas({ party: party() });
    await press('party-invite-revoke-RR-GGGGG2');
    await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith('pi-9'));
  });

  it('an invitation the server refuses says why, next to that friend', async () => {
    friendsLoaded();
    await loaded({ party: party() });
    await render(<PlayOnline />);
    await press('party-invite');
    api.invite.mockResolvedValueOnce(bad('PARTY_FULL', 'The party is full.'));
    await press('party-invite-send-RR-GGGGG2');
    await waitFor(() => expect(screen.getByTestId('party-invite-error-RR-GGGGG2')).toHaveTextContent('The party is full.'));
  });

  it('with no friends yet, the sheet points to Friends instead of an empty list', async () => {
    useSocialStore.setState({ ownerUserId: ME.userId, phase: 'ready', data: { version: 2, serverTime: new Date().toISOString(), me: { playerId: ME.playerId, presenceKey: 'k' }, friends: [], incoming: [], outgoing: [], blocked: [], invites: [], sentInvites: [], notifications: [], unread: 0 } });
    await loaded({ party: party({ members: [party().members[0]!] }) });
    await render(<PlayOnline />);
    await press('party-invite');
    expect(screen.getByTestId('party-invite-empty')).toBeTruthy();
    await press('party-invite-open-friends');
    expect(router.push).toHaveBeenLastCalledWith('/friends');
  });

  it('the leader removes a member and leaves the party through the server', async () => {
    await loaded({ party: party() });
    await render(<PlayOnline />);
    api.kick.mockResolvedValueOnce(DONE);
    serverHas({ party: party({ members: [party().members[0]!] }) });
    await press('party-kick-RR-FFFFF2');
    expect(api.kick).toHaveBeenCalledWith('RR-FFFFF2');
    await waitFor(() => expect(screen.queryByTestId('party-member-RR-FFFFF2')).toBeNull());
    api.leaveParty.mockResolvedValueOnce(DONE);
    serverHas();
    await press('party-leave');
    await waitFor(() => expect(screen.getByTestId('online-solo')).toBeTruthy());
  });

  it('leadership handed to me while I watch: the screen becomes the leader’s', async () => {
    const asMember = party({ isLeader: false, members: [member('RR-FFFFF2', 'Farah', { isLeader: true, ready: true }), member(ME.playerId, 'Me', { isMe: true, ready: true })] });
    await loaded({ party: asMember });
    await render(<PlayOnline />);
    expect(screen.queryByTestId('party-start')).toBeNull();
    await serverChanges({ party: party({ members: [member(ME.playerId, 'Me', { isLeader: true, isMe: true, ready: true })] }) });
    expect(screen.getByTestId('party-start')).toBeTruthy();
    expect(screen.getByTestId('party-invite')).toBeTruthy();
  });

  it('a party of eight that fills a table says so while searching', async () => {
    const members = Array.from({ length: 8 }, (_, i) => member(i === 0 ? ME.playerId : `RR-${String(i).repeat(5)}Z`.slice(0, 9), i === 0 ? 'Me' : `P${i}`, { isLeader: i === 0, isMe: i === 0, ready: true }));
    await loaded({ party: party({ locked: true, members }), ticket: ticket({ kind: 'party', playerCount: 8 }) });
    await render(<PlayOnline />);
    expect(screen.getByTestId('search-hint')).toHaveTextContent(/fills a table/);
    expect(screen.getByTestId('play-online-screen')).toHaveTextContent(/Classic · 8 players/);
  });
});
