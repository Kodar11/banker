/// <reference types="jest" />
/** Board View: a read-only, data-driven map of the physical board + the shared property/player colour system. */
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { BOARD_SIZE, netWorth, outstandingDebt, positionOfProperty, positionOfSpecial, PROPERTY_KEYS, getDeed } from '@/engine/index.ts';
import {
  PLAYER_COLORS,
  PROPERTY_DARK_BLUE,
  PROPERTY_GREEN,
  PROPERTY_GROUP_THEME,
  PROPERTY_NEUTRAL,
  PROPERTY_PINK,
  PROPERTY_PURPLE,
  playerColor,
} from '@/constants/theme';
import { boardGeometry, buildBoardSpaces, clusterOffsets, squareCenter } from '@/features/board/boardModel';
import { BOARD_BORDER, BOARD_FRAME, ClassicBoard } from '@/features/board/ClassicBoard';
import { tokenAnimation, tokenSize } from '@/features/board/BoardTokens';
import { boardSizeFor, boardTurnStatus, BoardViewOverlay } from '@/features/board/BoardView';
import { PlayersStrip } from '@/features/game/GamePanels';
import { GameScreen } from '@/features/game/GameScreen';
import { PropertyView } from '@/features/player/PropertyView';
import type { GameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture } from './fixtures';

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

const player = (f: Fixture, name: string) => f.state.players.find((p) => p.name === name)!;

/** The physical board, as specified (unique cyclic order, corners once). */
const EXPECTED_ORDER = [
  'Start', 'Mumbai', 'Water Works', 'Railway', 'Ahmedabad', 'Income Tax', 'Indore', 'Chance', 'Jaipur',
  'Jail', 'Delhi', 'Chandigarh', 'Electric Company', 'BEST', 'Shimla', 'Amritsar', 'Community Chest', 'Srinagar',
  'Club', 'Agra', 'Chance', 'Kanpur', 'Patna', 'Darjeeling', 'Air India', 'Calcutta', 'Hyderabad',
  'Rest House', 'Madras', 'Community Chest', 'Bangalore', 'Wealth Taxes', 'Ootacamund', 'Cochin', 'Motor Boat', 'Margao',
];

const EXPECTED_GROUPS: Record<string, string[]> = {
  [PROPERTY_DARK_BLUE]: ['Mumbai', 'Ahmedabad', 'Darjeeling', 'Calcutta', 'Hyderabad'],
  [PROPERTY_PURPLE]: ['Srinagar', 'Amritsar', 'Shimla', 'Madras', 'Bangalore'],
  [PROPERTY_GREEN]: ['Indore', 'Jaipur', 'Agra', 'Kanpur', 'Patna'],
  [PROPERTY_PINK]: ['Delhi', 'Chandigarh', 'Cochin', 'Ootacamund', 'Margao'],
  [PROPERTY_NEUTRAL]: ['Water Works', 'Railway', 'Electric Company', 'BEST', 'Air India', 'Motor Boat'],
};

/** Current on-screen top-left of a token (its Animated translate values). */
function tokenXY(id: string) {
  const style = StyleSheet.flatten(screen.getByTestId(`board-token-${id}`).props.style) as { transform: Record<string, number>[] };
  const [tx, ty, lift] = style.transform;
  return { x: tx!.translateX!, y: ty!.translateY! + lift!.translateY! };
}

function expectedXY(boardSize: number, position: number, offset = { x: 0, y: 0 }) {
  const geo = boardGeometry(boardSize - 2 * (BOARD_FRAME + BOARD_BORDER));
  const t = tokenSize(geo);
  const c = squareCenter(geo, position);
  return { x: c.x + offset.x - t / 2, y: c.y + offset.y - t / 2 };
}

// The JS driver lets the test renderer observe token transforms (the app uses the native driver).
tokenAnimation.useNativeDriver = false;

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Board View overlay', () => {
  it('opens from the game screen over it and closes with ✕ or Close', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.queryByTestId('board-view')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.getByTestId('game-screen')).toBeTruthy(); // gameplay stays mounted underneath
    expect(screen.getByLabelText('Close board view')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('board-view-close'));
    expect(screen.queryByTestId('board-view')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-board'));
    await fireEvent.press(screen.getByTestId('board-view-close-x'));
    expect(screen.queryByTestId('board-view')).toBeNull();
  });

  it('is observational: no control other than Close, and nothing is ever sent to the server', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<BoardViewOverlay visible onClose={jest.fn()} view={viewFor(f, 'Asha')} />);
    const buttons = within(screen.getByTestId('board-view')).getAllByRole('button');
    expect(buttons.map((b) => b.props.testID).sort()).toEqual(['board-view-close', 'board-view-close-x']);
    for (let i = 0; i < BOARD_SIZE; i++) expect(screen.getByTestId(`board-square-${i}`).props.onPress).toBeUndefined();
    for (let i = 0; i < BOARD_SIZE; i++) fireEvent.press(screen.getByTestId(`board-square-${i}`));
    expect(api.action).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
  });
});

describe('board squares', () => {
  it('renders exactly 36 unique squares in the physical board order, corners once each', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={360} />);
    const names = Array.from({ length: BOARD_SIZE }, (_, i) => screen.getByTestId(`board-square-${i}`).props.accessibilityLabel.split(',')[0]);
    expect(BOARD_SIZE).toBe(36);
    expect(screen.getAllByTestId(/^board-square-\d+$/)).toHaveLength(36);
    expect(names).toEqual(EXPECTED_ORDER);
    for (const corner of ['Start', 'Jail', 'Club', 'Rest House']) expect(names.filter((n) => n === corner)).toHaveLength(1);
    expect(names.indexOf('Cochin')).toBeGreaterThan(-1);
    expect(names.indexOf('Margao')).toBeGreaterThan(-1);
    expect(names.some((n) => /Kochi|Goa|^Marg$/.test(n))).toBe(false);
  });

  it('shows prices from the canonical deeds on available properties', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={360} />);
    for (const key of PROPERTY_KEYS) {
      expect(screen.getByTestId(`board-price-${key}`)).toHaveTextContent(`₹${getDeed(key).price.toLocaleString('en-IN')}`);
    }
    expect(screen.getByTestId('board-price-MUMBAI')).toHaveTextContent('₹8,500');
    expect(screen.getByTestId('board-price-AIR_INDIA')).toHaveTextContent('₹10,500');
  });

  it('colours each property band with its fixed group colour', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={360} />);
    const spaces = buildBoardSpaces(f.state);
    for (const [color, members] of Object.entries(EXPECTED_GROUPS)) {
      for (const name of members) {
        const key = spaces.find((s) => s.name === name)!.propertyKey!;
        expect(StyleSheet.flatten(screen.getByTestId(`board-band-${key}`).props.style).backgroundColor).toBe(color);
      }
    }
    expect(spaces.filter((s) => s.propertyKey)).toHaveLength(26);
  });

  it('marks ownership with only a thin owner-colour strip (never the whole card), and nothing on available ones', async () => {
    const f = new Fixture(['Tanmay', 'Shamin']);
    f.state.properties.MUMBAI.ownerId = f.ids.Tanmay!;
    await render(<ClassicBoard state={f.state} size={360} />);
    const orange = playerColor(player(f, 'Tanmay')).color;
    expect(StyleSheet.flatten(screen.getByTestId('board-owner-strip-MUMBAI').props.style).backgroundColor).toBe(orange);
    // No owner stamp; name and price stay visible.
    expect(screen.queryByTestId('board-owner-MUMBAI')).toBeNull();
    expect(screen.getByTestId('board-price-MUMBAI')).toHaveTextContent('₹8,500');
    expect(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`)).toHaveTextContent(/Mumbai/);
    // Card keeps its group identity.
    expect(StyleSheet.flatten(screen.getByTestId('board-band-MUMBAI').props.style).backgroundColor).toBe(PROPERTY_DARK_BLUE);
    expect(StyleSheet.flatten(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`).props.style).backgroundColor).toBe(PROPERTY_GROUP_THEME.BLUE.tint);
    expect(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`).props.accessibilityLabel).toMatch(/owned by Tanmay/);
    // Available: no owner marks, price shown.
    expect(screen.queryByTestId('board-owner-AHMEDABAD')).toBeNull();
    expect(screen.queryByTestId('board-owner-strip-AHMEDABAD')).toBeNull();
    expect(screen.getByTestId('board-price-AHMEDABAD')).toBeTruthy();
    expect(screen.getByTestId(`board-square-${positionOfProperty('AHMEDABAD')}`).props.accessibilityLabel).toMatch(/available/);
  });

  it('renders houses, hotels and mortgages from authoritative property state', async () => {
    const f = new Fixture();
    Object.assign(f.state.properties.MUMBAI, { ownerId: f.ids.Asha!, houses: 3 });
    Object.assign(f.state.properties.DELHI, { ownerId: f.ids.Asha!, houses: 1 });
    Object.assign(f.state.properties.CALCUTTA, { ownerId: f.ids.Bilal!, hotel: true });
    Object.assign(f.state.properties.SHIMLA, { ownerId: f.ids.Bilal!, mortgaged: true });
    await render(<ClassicBoard state={f.state} size={360} />);
    expect(within(screen.getByTestId('board-band-MUMBAI')).getAllByTestId('board-house-MUMBAI')).toHaveLength(3);
    expect(screen.getAllByTestId('board-house-DELHI')).toHaveLength(1);
    expect(screen.getByTestId('board-hotel-CALCUTTA')).toBeTruthy();
    expect(screen.queryByTestId('board-house-CALCUTTA')).toBeNull();
    expect(screen.getByTestId('board-mortgage-SHIMLA')).toHaveTextContent('M');
    expect(screen.getByTestId(`board-square-${positionOfProperty('SHIMLA')}`).props.accessibilityLabel).toMatch(/mortgaged/);
    expect(screen.queryByTestId('board-mortgage-MUMBAI')).toBeNull();
    expect(screen.queryByTestId('board-hotel-MUMBAI')).toBeNull();
    expect(screen.queryByTestId('board-house-AGRA')).toBeNull();
  });
});

describe('colour system', () => {
  it('player colours are independent from property-group colours and stable per seat', () => {
    const groupColors = new Set(Object.values(PROPERTY_GROUP_THEME).flatMap((t) => [t.color, t.tint, t.mark]));
    for (const c of PLAYER_COLORS) expect(groupColors.has(c.color)).toBe(false);
    expect(new Set(PLAYER_COLORS.map((c) => c.color)).size).toBe(PLAYER_COLORS.length);
    expect(PLAYER_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(playerColor({ seat: 0 }).color).toBe('#F59E0B');
    expect(playerColor({ seat: 1 }).color).toBe('#EF5B63');
    expect(playerColor({ seat: 2 }).color).toBe('#18A6B8');
    expect(playerColor({ seat: 3 }).color).toBe('#64748B');
    expect(playerColor({ seat: 1 })).toBe(playerColor({ seat: 1 }));
  });
});

describe('player tokens', () => {
  it('stand on their authoritative squares; players sharing a square do not overlap', async () => {
    const f = new Fixture(['Tanmay', 'Shamin', 'Rohit', 'Aman']);
    player(f, 'Tanmay').position = positionOfProperty('MUMBAI');
    player(f, 'Shamin').position = positionOfSpecial('JAIL');
    player(f, 'Rohit').position = positionOfSpecial('JAIL');
    player(f, 'Aman').position = positionOfSpecial('JAIL');
    await render(<ClassicBoard state={f.state} size={360} />);
    const geo = boardGeometry(360 - 2 * (BOARD_FRAME + BOARD_BORDER));
    expect(tokenXY(f.ids.Tanmay!)).toEqual(expectedXY(360, positionOfProperty('MUMBAI')));
    const offsets = clusterOffsets(3, tokenSize(geo));
    const jailed = ['Shamin', 'Rohit', 'Aman'].map((n) => tokenXY(f.ids[n]!));
    jailed.forEach((xy, i) => expect(xy).toEqual(expectedXY(360, positionOfSpecial('JAIL'), offsets[i])));
    // Pairwise distinct positions, at least ~a token apart on one axis.
    for (let i = 0; i < jailed.length; i++)
      for (let j = i + 1; j < jailed.length; j++) {
        const d = Math.max(Math.abs(jailed[i]!.x - jailed[j]!.x), Math.abs(jailed[i]!.y - jailed[j]!.y));
        expect(d).toBeGreaterThan(tokenSize(geo) * 0.9);
      }
    // The current player gets a ring; others don't.
    expect(screen.getByTestId(`board-token-current-${f.state.turn.playerId}`)).toBeTruthy();
    expect(screen.queryByTestId(`board-token-current-${f.ids.Aman}`)).toBeNull();
  });

  it('cluster offsets keep up to 8 tokens apart', () => {
    for (let n = 1; n <= 8; n++) {
      const pts = clusterOffsets(n, 14);
      expect(pts).toHaveLength(n);
      expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(n);
    }
  });

  it('bankrupt players leave the board but stay in Player Locations', async () => {
    const f = new Fixture(['Tanmay', 'Shamin', 'Rohit']);
    player(f, 'Rohit').status = 'BANKRUPT';
    await render(<BoardViewOverlay visible onClose={jest.fn()} view={viewFor(f, 'Tanmay')} />);
    expect(screen.queryByTestId(`board-token-${f.ids.Rohit}`)).toBeNull();
    expect(screen.getByTestId(`player-location-square-${f.ids.Rohit}`)).toHaveTextContent(/Bankrupt/);
  });

  describe('movement animation', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('hops square by square and always ends on the authoritative position', async () => {
      const f = new Fixture();
      const id = f.ids.Asha!;
      player(f, 'Asha').position = 10;
      const ui = await render(<ClassicBoard state={structuredClone(f.state)} size={360} />);
      expect(tokenXY(id)).toEqual(expectedXY(360, 10));
      player(f, 'Asha').position = 15; // roll of 5
      await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
      await act(async () => void jest.advanceTimersByTime(200));
      const mid = tokenXY(id);
      expect(mid).not.toEqual(expectedXY(360, 15)); // still travelling
      await act(async () => void jest.advanceTimersByTime(5000));
      expect(tokenXY(id)).toEqual(expectedXY(360, 15));
    });

    it('an interrupted animation resolves to the newest authoritative position', async () => {
      const f = new Fixture();
      const id = f.ids.Asha!;
      player(f, 'Asha').position = 2;
      const ui = await render(<ClassicBoard state={structuredClone(f.state)} size={360} />);
      player(f, 'Asha').position = 8;
      await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
      await act(async () => void jest.advanceTimersByTime(250));
      player(f, 'Asha').position = positionOfSpecial('JAIL') + 3; // moved again (e.g. reconnect delivered a later state)
      await ui.rerender(<ClassicBoard state={structuredClone(f.state)} size={360} />);
      await act(async () => void jest.advanceTimersByTime(10000));
      expect(tokenXY(id)).toEqual(expectedXY(360, positionOfSpecial('JAIL') + 3));
    });

    it('opening the board renders the authoritative position immediately (no replay)', async () => {
      const f = new Fixture();
      player(f, 'Asha').position = 30;
      await render(<ClassicBoard state={f.state} size={360} />);
      expect(tokenXY(f.ids.Asha!)).toEqual(expectedXY(360, 30));
    });
  });
});

describe('Player Locations + turn status', () => {
  it('lists every player with colour badge, (You) and their current square', async () => {
    const f = new Fixture(['Tanmay', 'Shamin']);
    player(f, 'Tanmay').position = positionOfProperty('MUMBAI');
    Object.assign(player(f, 'Shamin'), { position: positionOfSpecial('JAIL'), inJail: true, jailTurnsLeft: 2 });
    await render(<BoardViewOverlay visible onClose={jest.fn()} view={viewFor(f, 'Tanmay')} />);
    const me = screen.getByTestId(`player-location-${f.ids.Tanmay}`);
    expect(me).toHaveTextContent(/Tanmay \(You\)/);
    expect(screen.getByTestId(`player-location-square-${f.ids.Tanmay}`)).toHaveTextContent('Mumbai');
    expect(screen.getByTestId(`player-location-square-${f.ids.Shamin}`)).toHaveTextContent('Jail · 2 turns left');
    expect(screen.getByTestId(`player-location-${f.ids.Shamin}`)).not.toHaveTextContent(/\(You\)/);
    expect(me.props.accessibilityLabel).toMatch(/Tanmay, you, Orange token, at Mumbai, current turn/);
  });

  it('says YOUR TURN above the board on my turn', async () => {
    const f = new Fixture(['Tanmay', 'Shamin']);
    await render(<BoardViewOverlay visible onClose={jest.fn()} view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('board-turn-title')).toHaveTextContent('YOUR TURN');
    expect(screen.getByTestId('board-turn-detail')).toHaveTextContent(`Turn ${f.state.turn.number} · Roll the dice on the main screen`);
  });

  it("says SHAMIN'S TURN to everyone else", () => {
    const f = new Fixture(['Shamin', 'Tanmay']);
    expect(boardTurnStatus(viewFor(f, 'Tanmay'))).toEqual({ title: "SHAMIN'S TURN", detail: `Turn ${f.state.turn.number} · Shamin is about to roll` });
  });
});

describe('responsive layout', () => {
  it.each([
    [320, 640],
    [360, 780],
    [412, 915],
    [800, 1280],
    [360, 560],
  ])('board stays square and fully on screen at %ix%i', async (w, h) => {
    const size = boardSizeFor(w, h);
    expect(size).toBeLessThanOrEqual(w - 2 * 10);
    expect(size).toBeGreaterThanOrEqual(Math.min(280, w - 20));
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={size} />);
    const style = StyleSheet.flatten(screen.getByTestId('classic-board').props.style);
    expect(style.width).toBe(style.height);
    const geo = boardGeometry(size);
    const right = Math.max(...geo.slots.map((s) => s.x + s.width));
    const bottom = Math.max(...geo.slots.map((s) => s.y + s.height));
    expect(right).toBeCloseTo(size, 5);
    expect(bottom).toBeCloseTo(size, 5);
  });
});

describe('app-wide colour tokens', () => {
  it('deed headers use the property-group token; player strips use the player token', async () => {
    const f = new Fixture(['Tanmay', 'Shamin']).loadAs('Tanmay');
    const view = viewFor(f, 'Tanmay');
    const ui = await render(<PropertyView view={view} propertyKey="COCHIN" />);
    expect(StyleSheet.flatten(screen.getByTestId('property-deed-header').props.style).backgroundColor).toBe(PROPERTY_PINK);
    await ui.rerender(<PropertyView view={view} propertyKey="RAILWAY" />);
    expect(StyleSheet.flatten(screen.getByTestId('property-deed-header').props.style).backgroundColor).toBe(PROPERTY_NEUTRAL);
    await ui.rerender(<PlayersStrip view={view} />);
    expect(StyleSheet.flatten(screen.getByTestId('player-badge-Shamin', { includeHiddenElements: true }).props.style).backgroundColor).toBe(playerColor(player(f, 'Shamin')).color);
  });
});
