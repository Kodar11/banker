/// <reference types="jest" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import { router, useLocalSearchParams, usePathname } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import Home from '../../app/index';
import JoinGame from '../../app/join-game';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { joinLink, parseJoinCode } from '@/utils/links';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture } from './fixtures';

jest.mock('react-native-qrcode-svg', () => jest.fn(() => null));

const api = gameApi as jest.Mocked<typeof gameApi>;
const qr = QRCode as unknown as jest.Mock;
const params = useLocalSearchParams as jest.Mock;
const pathname = usePathname as jest.Mock;

const entered = (f: Fixture, name: string) => ({ ok: true as const, gameId: f.state.id, playerId: f.ids[name]!, snapshot: f.snapshot() });

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
  return { snapshot, me, isHost: !!me?.isHost } as GameView;
}

beforeEach(() => {
  jest.clearAllMocks();
  startupRouting.reset();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  params.mockReturnValue({});
  pathname.mockReturnValue('/');
});

describe('the lobby hands out one link', () => {
  it('the QR code, the share sheet and the code on screen all name the same game', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    try {
      const f = new Fixture(['Asha', 'Bilal'], { start: false });
      f.loadAs('Asha');
      await render(<LobbyView view={viewFor(f, 'Asha')} />);

      const payload = qr.mock.calls.at(-1)![0].value as string;
      expect(payload).toBe(`clashofcapitals://join-game?code=${f.state.code}`);
      expect(payload).toBe(joinLink(f.state.code));
      expect(parseJoinCode(payload)).toBe(f.state.code);
      expect(screen.getByTestId('game-code')).toHaveTextContent(f.state.code);

      await fireEvent.press(screen.getByTestId('lobby-share'));
      const message = (share.mock.calls[0]![0] as { message: string }).message;
      expect(message.split('\n').pop()).toBe(payload);
      expect(message).toContain(`Code: ${f.state.code}.`);
    } finally {
      share.mockRestore();
    }
  });
});

describe('opening a join link', () => {
  it('fills in the code and waits for the player: the link itself never joins', async () => {
    params.mockReturnValue({ code: '482915' });
    await render(<JoinGame />);
    expect(screen.getByTestId('join-code').props.value).toBe('482915');
    // The launch link and the link event both end here; however often it renders, nothing is sent.
    await screen.rerender(<JoinGame />);
    expect(api.join).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('a cold start on the link keeps the join screen: Home does not send the player elsewhere', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Bilal');
    pathname.mockReturnValue('/join-game');
    params.mockReturnValue({ code: '482915' });
    await render(
      <>
        <Home />
        <JoinGame />
      </>,
    );
    // Even with a lobby this phone could go back to, the opened link wins this launch.
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
    expect(router.replace).not.toHaveBeenCalled();
    expect(startupRouting.isDone()).toBe(true);
    expect(screen.getByTestId('join-code').props.value).toBe('482915');
  });

  it('a second link opened while the screen is up replaces the code', async () => {
    params.mockReturnValue({ code: '482915' });
    await render(<JoinGame />);
    params.mockReturnValue({ code: '100200' });
    await screen.rerender(<JoinGame />);
    expect(screen.getByTestId('join-code').props.value).toBe('100200');
  });

  it('a typed code is not overwritten when the screen renders again', async () => {
    params.mockReturnValue({ code: '482915' });
    await render(<JoinGame />);
    await fireEvent.changeText(screen.getByTestId('join-code'), '777777');
    await screen.rerender(<JoinGame />);
    expect(screen.getByTestId('join-code').props.value).toBe('777777');
  });

  it.each([[{ code: 'abcdef' }], [{ code: '48291' }], [{ code: '4829150' }], [{ code: ['482915', '100200'] }], [{}]])('a link without one well-formed code fills in nothing: %j', async (value) => {
    params.mockReturnValue(value);
    await render(<JoinGame />);
    expect(screen.getByTestId('join-code').props.value).toBe('');
    await fireEvent.changeText(screen.getByTestId('join-name'), 'Bilal');
    await fireEvent.press(screen.getByTestId('join-confirm'));
    expect(await screen.findByText('Game code is 6 digits')).toBeTruthy();
    expect(api.join).not.toHaveBeenCalled();
  });

  it('joins the game the link named, once, however fast the button is tapped', async () => {
    const other = new Fixture(['Chitra', 'Bilal'], { start: false });
    api.join.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(entered(other, 'Bilal')), 20)));
    params.mockReturnValue({ code: other.state.code });
    await render(<JoinGame />);
    await fireEvent.changeText(screen.getByTestId('join-name'), 'Bilal');
    await fireEvent.press(screen.getByTestId('join-confirm'));
    await fireEvent.press(screen.getByTestId('join-confirm'));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${other.state.id}`));
    expect(api.join).toHaveBeenCalledTimes(1);
    expect(api.join).toHaveBeenCalledWith(expect.any(String), expect.any(String), other.state.code, 'Bilal');
    expect(useSessionStore.getState().session).toMatchObject({ gameId: other.state.id, playerId: other.ids.Bilal });
  });

  it.each([
    ['NOT_FOUND', 'No game with that code.'],
    ['GAME_EXPIRED', 'This game has expired.'],
    ['LOBBY_LOCKED', 'The host has locked this lobby.'],
    ['GAME_FULL', 'This game is full.'],
  ])('the server’s refusal (%s) is shown and nothing is entered', async (code, message) => {
    api.join.mockResolvedValue({ ok: false, error: { code, message } } as never);
    params.mockReturnValue({ code: '482915' });
    await render(<JoinGame />);
    await fireEvent.changeText(screen.getByTestId('join-name'), 'Bilal');
    await fireEvent.press(screen.getByTestId('join-confirm'));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(api.join).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(useSessionStore.getState().session).toBeNull();
  });
});
