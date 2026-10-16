/// <reference types="jest" />
import { router } from 'expo-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BOT_NAMES, netWorth, totalDebt } from '@/engine/index.ts';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { discardSoloGame, localState } from '@/features/solo/localGame';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import SoloGame from '../../app/solo';
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
    myDebt: me ? totalDebt(snapshot.state, me.id) : 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('bots in a private lobby', () => {
  it('the host adds a bot with a chosen difficulty and personality; the server decides', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.act('Asha', { type: 'ADD_BOT', difficulty: 'hard', personality: 'banker' }).snapshot()));
    await render(<LobbyView view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('lobby-add-bot'));
    await fireEvent.press(screen.getByTestId('add-bot-difficulty-hard'));
    await fireEvent.press(screen.getByTestId('add-bot-personality-banker'));
    await fireEvent.press(screen.getByTestId('add-bot-confirm'));
    await waitFor(() => expect(api.action).toHaveBeenCalled());
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'ADD_BOT', difficulty: 'hard', personality: 'banker' });
  });

  it('a bot seat is labelled as a bot, with its difficulty and personality, for everyone', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    f.act('Asha', { type: 'ADD_BOT', difficulty: 'easy', personality: 'opportunist' }).loadAs('Bilal');
    await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId(`lobby-bot-${BOT_NAMES[0]}`)).toBeTruthy();
    expect(screen.getByLabelText('Bot · Easy · Opportunist')).toBeTruthy();
    // Only the host may add bots.
    expect(screen.queryByTestId('lobby-add-bot')).toBeNull();
  });
});

describe('solo play', () => {
  it('starts a game against bots on this phone, without asking any server', async () => {
    await render(<SoloGame />);
    await fireEvent.changeText(screen.getByTestId('solo-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('solo-bots-plus'));
    expect(screen.getByTestId('solo-bots-count')).toHaveTextContent('4 bots');
    await fireEvent.press(screen.getByTestId('solo-bot-difficulty-hard'));
    await fireEvent.press(screen.getByTestId('solo-start'));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    const session = useSessionStore.getState().session!;
    expect(session.local).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
    const res = localState(session);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.snapshot.state.players.filter((p) => p.bot).map((p) => p.bot!.difficulty)).toEqual(['hard', 'hard', 'hard', 'hard']);
    expect(res.snapshot.state.status).toBe('ACTIVE');
    discardSoloGame(session.gameId);
  });
});
