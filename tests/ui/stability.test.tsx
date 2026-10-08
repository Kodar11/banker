/// <reference types="jest" />
/** Regression tests for the Android stability audit: board sizing/text, token animation, navigation, sync ordering. */
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
import { CrashScreen } from '@/components/ui/CrashScreen';
import { AuctionView } from '@/features/auction/AuctionView';
import { ClassicBoard } from '@/features/board/ClassicBoard';
import { tokenAnimation } from '@/features/board/BoardTokens';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture } from './fixtures';

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

const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown>;

tokenAnimation.useNativeDriver = false;

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('board sizing', () => {
  it('the board slot is exactly as tall as the board: no slack around it, and no flex-basis 0 collapse on native', async () => {
    const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
    await render(<GameScreen view={viewFor(f, 'Guru')} />);
    await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 360, height: 568 } } });
    const area = flat('board-area');
    const board = flat('classic-board');
    expect(board.width).toBe(board.height);
    expect(area.height).toBe(board.height);
    expect(area.flexGrow).toBeUndefined();
    expect(area.flexShrink).toBe(0);
    expect(area.flex).toBeUndefined();
    expect(area.flexBasis).toBeUndefined();
    // The board itself has exactly one sizing rule.
    expect(board.flex).toBeUndefined();
    expect(board.aspectRatio).toBeUndefined();
  });

  it.each([0, -14, Number.NaN, 40])('a board with no usable size (%p) draws nothing instead of sending negative sizes to native', async (size) => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={size} />);
    const style = flat('classic-board');
    expect(style.width as number).toBeGreaterThanOrEqual(0);
    expect(screen.queryByTestId('board-square-0')).toBeNull();
    expect(screen.queryByTestId('board-tokens')).toBeNull();
  });

  it.each([280, 304, 336, 366, 388])('at %ipx every text on the board has a positive font and ignores the phone font-size setting', async (size) => {
    const f = new Fixture();
    Object.assign(f.state.properties.MUMBAI, { ownerId: f.ids.Asha!, houses: 4 });
    Object.assign(f.state.properties.DELHI, { ownerId: f.ids.Bilal!, hotel: true });
    Object.assign(f.state.properties.RAILWAY, { ownerId: f.ids.Bilal!, mortgaged: true });
    await render(<ClassicBoard state={f.state} size={size} />);
    const texts = within(screen.getByTestId('classic-board')).getAllByText(/\S/);
    expect(texts.length).toBeGreaterThan(60);
    for (const t of texts) {
      expect(t.props.allowFontScaling).toBe(false);
      expect(t.props.adjustsFontSizeToFit).toBeUndefined();
      const style = StyleSheet.flatten(t.props.style) as { fontSize: number };
      expect(style.fontSize).toBeGreaterThan(0);
      expect(Number.isFinite(style.fontSize)).toBe(true);
    }
    // Four houses fit inside the band of a narrow top/bottom square.
    const band = flat('board-band-MUMBAI') as { height: number };
    const houses = screen.getAllByTestId('board-house-MUMBAI');
    expect(houses).toHaveLength(4);
    const house = StyleSheet.flatten(houses[0]!.props.style) as { width: number; height: number };
    expect(house.height).toBeLessThanOrEqual(band.height);
    const squareWidth = (flat('board-square-1') as { width: number }).width;
    expect(4 * house.width + 3).toBeLessThanOrEqual(squareWidth);
  });
});

describe('token animation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('no view carries the same transform key twice', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={360} />);
    for (const id of Object.values(f.ids)) {
      for (const testID of [`board-token-${id}`, `board-token-lift-${id}`]) {
        const keys = (flat(testID).transform as Record<string, unknown>[]).flatMap((t) => Object.keys(t));
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  it.each([1, 5, 11, 12, 13, 35])('a %i-square move never throws and ends on the authoritative square', async (steps) => {
    const f = new Fixture();
    const asha = f.state.players.find((p) => p.name === 'Asha')!;
    asha.position = 30;
    const ui = await render(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    asha.position = (30 + steps) % 36;
    await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    const target = structuredClone(f.state);
    await act(async () => void jest.advanceTimersByTime(6000));
    // Rendering the same authoritative state on a fresh board gives the same place.
    const moved = flat(`board-token-${f.ids.Asha}`).transform;
    await ui.unmount();
    await render(<ClassicBoard state={target} size={360} />);
    expect(flat(`board-token-${f.ids.Asha}`).transform).toEqual(moved);
  });

  it('unmounting mid-hop (navigation, auction) is safe', async () => {
    const f = new Fixture();
    const asha = f.state.players.find((p) => p.name === 'Asha')!;
    const ui = await render(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    asha.position = 9;
    await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    await act(async () => void jest.advanceTimersByTime(300));
    await ui.unmount();
    await act(async () => void jest.advanceTimersByTime(6000));
  });

  it('a player going bankrupt mid-hop removes their token without disturbing the others', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    const [asha, bilal] = f.state.players;
    const ui = await render(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    asha!.position = 7;
    await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    await act(async () => void jest.advanceTimersByTime(200));
    asha!.status = 'BANKRUPT';
    bilal!.position = 4;
    await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
    await act(async () => void jest.advanceTimersByTime(6000));
    expect(screen.queryByTestId(`board-token-${asha!.id}`)).toBeNull();
    expect(screen.getByTestId(`board-token-${bilal!.id}`)).toBeTruthy();
  });
});

describe('auction navigation', () => {
  function closedAuction() {
    const f = new Fixture(['Tanmay', 'Guru']);
    f.roll('Tanmay', 1, 2); // Railway
    f.act('Tanmay', { type: 'DECLINE_PROPERTY' });
    const auctionId = f.state.auction!.id;
    return { f, auctionId };
  }

  it('a finished auction goes BACK to the game screen instead of stacking a second one', async () => {
    jest.useFakeTimers();
    try {
      const { f, auctionId } = closedAuction();
      f.state.auction = { ...f.state.auction!, status: 'CLOSED', closedAt: new Date().toISOString() };
      f.loadAs('Guru');
      await render(<AuctionView view={viewFor(f, 'Guru')} auctionId={auctionId} />);
      await act(async () => void jest.advanceTimersByTime(3000));
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(router.replace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an auction is opened once per device, however many game screens are mounted', async () => {
    const { f } = closedAuction();
    f.loadAs('Guru');
    await render(
      <>
        <GameScreen view={viewFor(f, 'Guru')} />
        <GameScreen view={viewFor(f, 'Guru')} />
      </>,
    );
    expect((router.push as jest.Mock).mock.calls.filter(([href]) => String(href).startsWith('/auction/'))).toHaveLength(1);
  });
});

describe('newer authoritative state wins', () => {
  it('an older snapshot never replaces a newer one, whichever arrives last (action response vs realtime refetch)', () => {
    const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
    const before = f.snapshot();
    f.roll('Tanmay', 1, 2);
    const afterRoll = f.snapshot();
    f.act('Tanmay', { type: 'BUY_PROPERTY' });
    const afterBuy = f.snapshot();
    const store = useGameStore.getState();
    expect(store.applySnapshot(afterBuy)).toBe(true); // realtime refetch lands first
    expect(store.applySnapshot(afterRoll)).toBe(false); // slower, older action response
    expect(store.applySnapshot(before)).toBe(false);
    expect(store.applySnapshot(afterBuy)).toBe(false); // duplicate realtime event
    expect(useGameStore.getState().snapshot).toBe(afterBuy);
    expect(useGameStore.getState().snapshot!.state.version).toBe(afterBuy.state.version);
  });

  it('a transient load error with a game on screen keeps the game and the session', () => {
    const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
    useGameStore.getState().setLoadError({ code: 'SERVER_ERROR', message: 'boom' });
    useGameStore.getState().setConnection('offline');
    expect(useGameStore.getState().snapshot!.state.id).toBe(f.state.id);
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
  });
});

describe('crash screen', () => {
  it('shows the real error and lets the player retry; the session is untouched', async () => {
    const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
    const retry = jest.fn(async () => undefined);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await render(<CrashScreen error={new Error('Invalid transform')} retry={retry} />);
    expect(screen.getByTestId('crash-message')).toHaveTextContent('Invalid transform');
    expect(spy).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('crash-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
    spy.mockRestore();
  });
});

describe('a route left over from another game', () => {
  it('redirects to the game this phone is in instead of stranding the player on "Not in this game"', async () => {
    const { GameGate } = require('@/features/game/GameGate') as typeof import('@/features/game/GameGate');
    const { Text } = require('react-native') as typeof import('react-native');
    const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
    await render(
      <GameGate gameId="00000000-0000-4000-8000-00000000dead" area="game">
        {() => <Text>old game</Text>}
      </GameGate>,
    );
    expect(router.replace).toHaveBeenCalledWith(`/game/${f.state.id}`);
    expect(screen.queryByText('Not in this game')).toBeNull();
    expect(screen.queryByText('old game')).toBeNull();
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
  });

  it('still says "Not in this game" when this phone has no game at all', async () => {
    const { GameGate } = require('@/features/game/GameGate') as typeof import('@/features/game/GameGate');
    await render(
      <GameGate gameId="00000000-0000-4000-8000-00000000dead" area="game">
        {() => null}
      </GameGate>,
    );
    expect(screen.getByText('Not in this game')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
