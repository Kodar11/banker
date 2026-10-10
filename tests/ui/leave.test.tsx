/// <reference types="jest" />
import { router } from 'expo-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
import { GameGate } from '@/features/game/GameGate';
import { PlayersStrip } from '@/features/game/GamePanels';
import { GameScreen } from '@/features/game/GameScreen';
import { leaveConsequence } from '@/features/game/LeaveGameDialog';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import Settings from '../../app/settings';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;

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

const NAMES = ['Asha', 'Bilal', 'Chitra']; // Asha hosts

/** Bilal's phone, More sheet open on "Leave game". */
async function openLeave(f = new Fixture(NAMES), who = 'Bilal') {
  f.loadAs(who);
  await render(<GameScreen view={viewFor(f, who)} />);
  await fireEvent.press(screen.getByTestId('open-more'));
  await fireEvent.press(screen.getByTestId('leave-game-button'));
  return f;
}

const expectStillInGame = (f: Fixture) => {
  expect(useSessionStore.getState().session).toMatchObject({ gameId: f.state.id });
  expect(useGameStore.getState().snapshot).not.toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
};

const expectHome = () => {
  expect(useSessionStore.getState().session).toBeNull();
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useGameStore.getState().gameId).toBeNull();
  expect(router.replace).toHaveBeenCalledWith('/');
};

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('More → Leave game', () => {
  it('every player has Leave game; only the host also has End game', async () => {
    const f = new Fixture(NAMES).loadAs('Bilal');
    const guest = await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('leave-game-button')).toHaveTextContent(/Leave game/);
    expect(screen.queryByTestId('end-game-button')).toBeNull();
    await guest.unmount();

    f.loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('leave-game-button')).toBeTruthy();
    expect(screen.getByTestId('end-game-button')).toBeTruthy();
  });

  it('asks first, in words that match what will happen; Cancel changes nothing', async () => {
    const f = await openLeave();
    const dialog = screen.getByTestId('leave-dialog');
    expect(dialog).toHaveTextContent(/Leave this game\?/);
    expect(dialog).toHaveTextContent(/You’ll leave this game and return to the home screen\. The other players keep playing\./);
    expect(dialog).toHaveTextContent(/You can’t rejoin\. Your cash and properties stay in your name\./);
    expect(screen.getByTestId('leave-dialog-confirm')).toHaveTextContent('Leave Game');
    await fireEvent.press(screen.getByTestId('leave-dialog-cancel'));
    expect(screen.queryByTestId('leave-dialog')).toBeNull();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
    expectStillInGame(f);
  });

  it('Leave Game tells the server once, and only then forgets the game and goes Home', async () => {
    const f = await openLeave();
    f.act('Bilal', { type: 'LEAVE_GAME' });
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'LEAVE_GAME' }); // never END_GAME, never a bankruptcy
    expectHome();
    // A late copy of the old game can no longer land on this phone.
    expect(useGameStore.getState().applySnapshot(f.snapshot())).toBe(false);
    expect(useGameStore.getState().snapshot).toBeNull();
  });

  it('a refusal keeps the player in the game with the reason shown, and a retry still works', async () => {
    const f = await openLeave();
    api.action.mockResolvedValueOnce({ ok: false, error: { code: 'VALIDATION', message: 'That request is not valid.' } });
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    expect(await screen.findByTestId('leave-dialog-error')).toHaveTextContent('That request is not valid.');
    expectStillInGame(f);
    expect(screen.getByTestId('leave-dialog-confirm').props.accessibilityState).toMatchObject({ disabled: false });

    f.act('Bilal', { type: 'LEAVE_GAME' });
    api.action.mockResolvedValueOnce(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.action).toHaveBeenCalledTimes(2);
    expectHome();
  });

  it('no network: nothing is claimed — still in the game, and every retry reused the same action id', async () => {
    const f = await openLeave();
    api.action.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'No connection. Check your internet.' } });
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    expect(await screen.findByTestId('leave-dialog-error', {}, { timeout: 8000 })).toHaveTextContent('No connection. Check your internet.');
    expectStillInGame(f);
    const ids = api.action.mock.calls.map((c) => c[1]);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  }, 15000);

  it('a game that is already over on the server has nothing to leave: the phone just lets go', async () => {
    await openLeave();
    api.action.mockResolvedValue({ ok: false, error: { code: 'GAME_FINISHED', message: 'This game has finished.' } });
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expectHome();
  });
});

describe('what the confirmation promises', () => {
  it('follows the server’s rules for host hand-over, the last two players, bankrupt players and the lobby', () => {
    const three = new Fixture(NAMES);
    expect(leaveConsequence(viewFor(three, 'Asha')).detail).toBe('You can’t rejoin. Your cash and properties stay in your name. Bilal becomes the host.');
    expect(leaveConsequence(viewFor(three, 'Chitra')).detail).toBe('You can’t rejoin. Your cash and properties stay in your name.');

    const two = new Fixture(['Asha', 'Bilal']);
    expect(leaveConsequence(viewFor(two, 'Bilal'))).toEqual({
      message: 'You’ll leave this game and return to the home screen.',
      detail: 'Only two players are left, so the game ends and Asha wins.',
    });
    // …and that is what the engine then does.
    two.act('Bilal', { type: 'LEAVE_GAME' });
    expect(two.state).toMatchObject({ status: 'FINISHED', winnerId: two.ids.Asha });

    const lobby = new Fixture(NAMES, { start: false });
    expect(leaveConsequence(viewFor(lobby, 'Asha'))).toEqual({ message: 'You’ll leave this lobby and return to the home screen.', detail: 'Bilal becomes the host.' });
    expect(leaveConsequence(viewFor(lobby, 'Chitra'))).toEqual({ message: 'You’ll leave this lobby and return to the home screen.', detail: undefined });
    expect(leaveConsequence(null)).toEqual({ message: 'You’ll leave this game and return to the home screen.' });
  });
});

describe('leaving from the lobby and from settings goes through the server too', () => {
  it('lobby: Leave game → LEAVE_GAME → Home', async () => {
    const f = new Fixture(NAMES, { start: false }).loadAs('Chitra');
    await render(<LobbyView view={viewFor(f, 'Chitra')} />);
    await fireEvent.press(screen.getByTestId('lobby-leave'));
    expect(screen.getByTestId('leave-dialog')).toHaveTextContent(/You’ll leave this lobby and return to the home screen\./);
    f.act('Chitra', { type: 'LEAVE_GAME' });
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'LEAVE_GAME' });
    expectHome();
  });

  it('settings: Cancel keeps the session; Leave Game asks the server before forgetting the game', async () => {
    const f = new Fixture(NAMES).loadAs('Bilal');
    await render(<Settings />);
    await fireEvent.press(screen.getByTestId('leave-game'));
    await fireEvent.press(screen.getByTestId('leave-dialog-cancel'));
    expectStillInGame(f);
    expect(api.action).not.toHaveBeenCalled();

    f.act('Bilal', { type: 'LEAVE_GAME' });
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('leave-game'));
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'LEAVE_GAME' });
    expectHome();
  });
});

describe('what the others see', () => {
  it('the departed player is marked Left, takes no turn, and the lobby no longer lists them', async () => {
    const f = new Fixture(NAMES);
    f.act('Asha', { type: 'LEAVE_GAME' }).loadAs('Chitra');
    const strip = await render(<PlayersStrip view={viewFor(f, 'Chitra')} />);
    expect(screen.getByTestId(`player-chip-${f.ids.Asha}`)).toHaveTextContent(/Asha.*Left/);
    expect(screen.getByTestId(`player-chip-${f.ids.Asha}`).props.accessibilityLabel).toMatch(/Asha, left/);
    expect(screen.getByTestId(`player-chip-${f.ids.Bilal}`).props.accessibilityLabel).toMatch(/current turn/);
    expect(viewFor(f, 'Bilal').isHost).toBe(true);
    await strip.unmount();

    const lobby = new Fixture(NAMES, { start: false });
    lobby.act('Bilal', { type: 'LEAVE_GAME' }).loadAs('Asha');
    await render(<LobbyView view={viewFor(lobby, 'Asha')} />);
    expect(screen.getByTestId('lobby-players')).toHaveTextContent(/Players \(2\/8\)/);
    expect(screen.getByTestId('lobby-players')).not.toHaveTextContent(/Bilal/);
    expect(screen.getByTestId('start-game-button').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('a phone still attached to a game its player has left is shown the way out, not the table', async () => {
    const f = new Fixture(NAMES);
    f.act('Bilal', { type: 'LEAVE_GAME' }).loadAs('Bilal');
    await render(<GameGate gameId={f.state.id} area="any">{() => null}</GameGate>);
    expect(screen.getByText('You left this game')).toBeTruthy();
    await fireEvent.press(screen.getByText('Home'));
    expectHome();
  });
});
