/// <reference types="jest" />
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import Home from '../../app/index';
import CreateGame from '../../app/create-game';
import JoinGame from '../../app/join-game';
import { GameScreen } from '@/features/game/GameScreen';
import { leaveGame } from '@/features/game/leaveGame';
import { GameSyncHost } from '@/features/game/sync';
import { useGameAction } from '@/features/game/useGameAction';
import { useGameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { subscribeToGame } from '@/lib/realtime';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const subscribe = subscribeToGame as jest.Mock;

/** The game screen as the app mounts it: view derived from the stores. */
function Table() {
  const view = useGameView();
  return view ? <GameScreen view={view} /> : null;
}

/** A game that Asha (host) ended, as seen from `name`'s phone. */
function finishedGame(name: string, names = ['Asha', 'Bilal']): Fixture {
  return new Fixture(names).act('Asha', { type: 'END_GAME' }).loadAs(name);
}

/** What the server answers to create/join: a brand-new lobby. */
function entered(f: Fixture, name: string) {
  return { ok: true as const, gameId: f.state.id, playerId: f.ids[name]!, snapshot: f.snapshot() };
}

beforeEach(() => {
  jest.clearAllMocks();
  startupRouting.reset();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  (router.canDismiss as jest.Mock).mockReturnValue(true);
  api.state.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'offline' } });
});

describe('Game Over is not a dead end', () => {
  it.each(['Asha', 'Bilal'])('%s (host or not) sees the result and a way to create or join another game', async (name) => {
    finishedGame(name);
    await render(<Table />);
    expect(screen.getByTestId('turn-title')).toHaveTextContent('GAME OVER');
    expect(screen.getByTestId('context-card')).toHaveTextContent(/wins!/);
    expect(screen.getByTestId('new-game-button')).toHaveTextContent('Create New Game');
    expect(screen.getByTestId('join-another-button')).toHaveTextContent('Join Game');
    expect(screen.getByTestId('open-more')).toBeTruthy(); // log and rules stay reachable
  });

  it('the exit is offered only once the game is over', async () => {
    const f = new Fixture().loadAs('Asha');
    const { rerender } = await render(<Table />);
    expect(screen.queryByTestId('game-over-actions')).toBeNull();
    await act(async () => void f.act('Bilal', { type: 'PAUSE_GAME' }).loadAs('Asha'));
    await rerender(<Table />);
    expect(screen.queryByTestId('game-over-actions')).toBeNull();
  });

  it('Create New Game: the finished game leaves the stack, the phone lets go of it, and Create opens over Home', async () => {
    finishedGame('Asha');
    await render(<Table />);
    await fireEvent.press(screen.getByTestId('new-game-button'));
    expect(router.dismissAll).toHaveBeenCalled();
    expect((router.replace as jest.Mock).mock.calls).toEqual([['/']]);
    expect((router.push as jest.Mock).mock.calls).toEqual([['/create-game']]);
    expect(useSessionStore.getState().session).toBeNull();
    expect(useGameStore.getState()).toMatchObject({ gameId: null, snapshot: null, pendingAction: null, onlinePlayerIds: [], loadError: null, notice: null });
  });

  it('Join Game does the same and opens Join', async () => {
    finishedGame('Bilal');
    await render(<Table />);
    await fireEvent.press(screen.getByTestId('join-another-button'));
    expect((router.replace as jest.Mock).mock.calls).toEqual([['/']]);
    expect((router.push as jest.Mock).mock.calls).toEqual([['/join-game']]);
    expect(useSessionStore.getState().session).toBeNull();
    expect(useGameStore.getState().snapshot).toBeNull();
  });

  it('reaching Home with a finished game (Android back, or reopening the app) lets go of it; Create and Join are there', async () => {
    finishedGame('Bilal');
    await render(<Home />);
    await waitFor(() => expect(useSessionStore.getState().session).toBeNull());
    expect(useGameStore.getState()).toMatchObject({ gameId: null, snapshot: null });
    expect(screen.getByTestId('create-game')).toBeTruthy();
    expect(screen.getByTestId('join-game')).toBeTruthy();
    expect(screen.queryByTestId('resume-game')).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('Home underneath the Game Over screen leaves the game alone (the standings are still being read)', async () => {
    const f = finishedGame('Bilal');
    (usePathname as jest.Mock).mockReturnValue(`/game/${f.state.id}`);
    await render(<Home />);
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
    expect(useGameStore.getState().snapshot?.state.id).toBe(f.state.id);
    (usePathname as jest.Mock).mockReturnValue('/');
  });
});

describe('nothing of the old game follows the player', () => {
  it('leaving ends the realtime subscription; entering a game subscribes to that game only', async () => {
    const stops: Record<string, jest.Mock> = {};
    subscribe.mockImplementation((gameId: string) => (stops[gameId] = jest.fn()));
    const old = finishedGame('Asha');
    await render(<GameSyncHost />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]![0]).toBe(old.state.id);

    await act(async () => leaveGame('/create-game'));
    expect(stops[old.state.id]).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1); // attached to nothing while on Home / Create

    const next = new Fixture(['Asha'], { start: false });
    await act(async () => {
      await useSessionStore.getState().setSession({ gameId: next.state.id, playerId: next.ids.Asha!, token: 'b'.repeat(64) });
      useGameStore.getState().reset(next.state.id);
      useGameStore.getState().applySnapshot(next.snapshot());
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls[1]![0]).toBe(next.state.id);
    expect(subscribe.mock.calls[1]![1]).toBe(next.ids.Asha);
    expect(stops[next.state.id]).not.toHaveBeenCalled();
    subscribe.mockImplementation(() => () => undefined);
  });

  it('a snapshot of the old game is refused after leaving, and after entering a new game', () => {
    const old = finishedGame('Asha');
    leaveGame();
    expect(useGameStore.getState().applySnapshot(old.snapshot())).toBe(false);
    expect(useGameStore.getState().snapshot).toBeNull();

    const next = new Fixture(['Asha'], { start: false }).loadAs('Asha');
    expect(useGameStore.getState().applySnapshot(old.snapshot())).toBe(false); // higher version, wrong game
    expect(useGameStore.getState().snapshot?.state).toMatchObject({ id: next.state.id, status: 'WAITING', version: next.state.version });
  });

  it('an action still in flight when the player leaves changes nothing afterwards', async () => {
    const f = new Fixture().loadAs('Asha');
    let answer: (v: unknown) => void = () => undefined;
    api.action.mockReturnValue(new Promise((r) => (answer = r)) as never);
    const { result } = await renderHook(() => useGameAction());
    let sent: Promise<unknown> = Promise.resolve();
    await act(async () => {
      sent = result.current({ type: 'ROLL_DICE' });
    });
    await act(async () => leaveGame());
    await act(async () => {
      answer({ ok: true, gameId: f.state.id, playerId: f.ids.Asha, snapshot: f.roll('Asha', 1, 2).snapshot() });
      await sent;
    });
    expect(await sent).toMatchObject({ ok: false });
    expect(useGameStore.getState()).toMatchObject({ gameId: null, snapshot: null, pendingAction: null, notice: null });
  });
});

describe('the next game starts from nothing', () => {
  it('Game Over → Create New Game → a brand-new lobby with none of the old state', async () => {
    const old = finishedGame('Asha');
    leaveGame('/create-game');
    jest.clearAllMocks();
    (router.canDismiss as jest.Mock).mockReturnValue(true);

    const next = new Fixture(['Asha'], { start: false });
    api.create.mockResolvedValue(entered(next, 'Asha'));
    await render(<CreateGame />);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Asha');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${next.state.id}`));
    expect(router.dismissAll).toHaveBeenCalled(); // Back cannot reach an older screen

    const session = useSessionStore.getState().session!;
    expect(session.gameId).toBe(next.state.id);
    expect(session.gameId).not.toBe(old.state.id);
    expect(session.playerId).toBe(next.ids.Asha);
    expect(session.playerId).not.toBe(old.ids.Asha);
    const { gameId, snapshot } = useGameStore.getState();
    expect(gameId).toBe(next.state.id);
    expect(snapshot!.state).toMatchObject({ id: next.state.id, status: 'WAITING', winnerId: null });
    expect(snapshot!.state.turn).toMatchObject({ playerId: null, number: 0 });
    expect(snapshot!.state.players.map((p) => p.name)).toEqual(['Asha']);
    expect(snapshot!.transactions).toHaveLength(0);
    expect(snapshot!.events.some((e) => e.type === 'GAME_FINISHED')).toBe(false);
  });

  it('Game Over → Join Game → the other game’s lobby, as a new player of that game', async () => {
    const old = finishedGame('Bilal');
    leaveGame('/join-game');
    jest.clearAllMocks();

    const other = new Fixture(['Chitra', 'Bilal'], { start: false });
    api.join.mockResolvedValue(entered(other, 'Bilal'));
    await render(<JoinGame />);
    await fireEvent.changeText(screen.getByTestId('join-code'), other.state.code);
    await fireEvent.changeText(screen.getByTestId('join-name'), 'Bilal');
    await fireEvent.press(screen.getByTestId('join-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${other.state.id}`));
    expect(api.join).toHaveBeenCalledWith(expect.any(String), expect.any(String), other.state.code, 'Bilal');

    expect(useSessionStore.getState().session).toMatchObject({ gameId: other.state.id, playerId: other.ids.Bilal });
    expect(useSessionStore.getState().session!.playerId).not.toBe(old.ids.Bilal);
    const state = useGameStore.getState().snapshot!.state;
    expect(state).toMatchObject({ id: other.state.id, status: 'WAITING' });
    expect(state.players.map((p) => p.name)).toEqual(['Chitra', 'Bilal']);
    expect(state.players.find((p) => p.name === 'Bilal')!.isHost).toBe(false);
  });

  it('game after game after game: each one replaces the last completely, under its own action id', async () => {
    const seen: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const next = new Fixture(['Asha'], { start: false });
      api.create.mockResolvedValue(entered(next, 'Asha'));
      const view = await render(<CreateGame />);
      await fireEvent.changeText(screen.getByTestId('host-name'), 'Asha');
      await fireEvent.press(screen.getByTestId('create-confirm'));
      await waitFor(() => expect(useSessionStore.getState().session?.gameId).toBe(next.state.id));
      expect(useGameStore.getState().snapshot!.state.id).toBe(next.state.id);
      seen.push(next.state.id);
      await view.unmount();
      // …the game is played and ends; the player takes the exit.
      await act(async () => {
        useGameStore.getState().applySnapshot({ ...next.snapshot(), state: { ...next.state, status: 'FINISHED', version: next.state.version + 1 } });
        leaveGame('/create-game');
      });
      expect(useSessionStore.getState().session).toBeNull();
    }
    expect(new Set(seen).size).toBe(3);
    const calls = api.create.mock.calls;
    expect(new Set(calls.map((c) => c[0])).size).toBe(3); // action ids
    expect(calls).toHaveLength(3);
  });
});

describe('turn order on screen', () => {
  it('whoever the server drew is shown as the first player, on every phone, with the same order', async () => {
    const f = new Fixture(['Tanmay', 'Shamin', 'Ram'], { start: false });
    f.start(['Shamin', 'Ram', 'Tanmay']); // Tanmay hosts; the draw puts him last

    f.loadAs('Tanmay');
    const host = await render(<Table />);
    expect(screen.getByTestId('turn-title')).toHaveTextContent("SHAMIN'S TURN");
    expect(screen.getByTestId('turn-detail')).toHaveTextContent(/^Turn 1 · /);
    expect(screen.queryByTestId('roll-button')).toBeNull();
    const chips = () => screen.getAllByTestId(/^player-chip-/).map((c) => c.props.testID);
    const order = ['Shamin', 'Ram', 'Tanmay'].map((n) => `player-chip-${f.ids[n]}`);
    expect(chips()).toEqual(order);
    await host.unmount();

    f.loadAs('Shamin');
    await render(<Table />);
    expect(screen.getByTestId('turn-title')).toHaveTextContent('YOUR TURN');
    expect(screen.getByTestId('turn-detail')).toHaveTextContent('Turn 1 · Roll the dice to move');
    expect(screen.getByTestId('roll-button')).toBeTruthy();
    expect(chips()).toEqual(order);
  });
});
