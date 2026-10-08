/// <reference types="jest" />
/** The main game screen as a digital game table: interactive read-only board, turn + primary action, contextual card, adaptive actions. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { BOARD_SIZE, netWorth, outstandingDebt, positionOfProperty, positionOfSpecial, positionsOfSpecial } from '@/engine/index.ts';
import { GameScreen } from '@/features/game/GameScreen';
import { pickContext, turnStatus } from '@/features/game/gameFocus';
import {
  ACTION_AREA_HEIGHT,
  MIN_BOARD,
  planScreenLayout,
  SCREEN_PADDING,
  screenGutter,
} from '@/features/game/layout';
import type { GameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
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

const player = (f: Fixture, name: string) => f.state.players.find((p) => p.name === name)!;

/** Tanmay (host, seat 0) and Shamin; Shamin owns Mumbai with 2 houses and stands on Jail. */
function table() {
  const f = new Fixture(['Tanmay', 'Shamin']);
  Object.assign(f.state.properties.MUMBAI, { ownerId: f.ids.Shamin!, houses: 2 });
  player(f, 'Shamin').position = positionOfSpecial('JAIL');
  return f;
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('main screen hierarchy', () => {
  it('header → players → turn + primary action → board → contextual card → actions; no View-board button, no permanent log', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('game-header')).toHaveTextContent(/BUSINESS.*Classic · India/);
    expect(screen.getByTestId('players-strip')).toBeTruthy();
    expect(screen.getByTestId('turn-bar')).toBeTruthy();
    expect(screen.getByTestId('classic-board')).toBeTruthy();
    expect(screen.getByTestId('context-card')).toBeTruthy();
    expect(screen.getByTestId('action-bar')).toBeTruthy();
    // The board IS the main screen now; secondary surfaces are one tap away, not permanent.
    expect(screen.queryByTestId('open-board')).toBeNull();
    expect(screen.queryByTestId('event-feed')).toBeNull();
    expect(screen.queryByText(/^Log$|^Rules$/)).toBeNull();
    expect(within(screen.getByTestId('turn-bar')).queryByText(/Log|Rules/)).toBeNull();
  });

  it('player strip: colour badge, name, balance, "You" for this phone, current turn highlighted', async () => {
    const f = table().loadAs('Shamin');
    await render(<GameScreen view={viewFor(f, 'Shamin')} />);
    const mine = screen.getByTestId(`player-chip-${f.ids.Shamin}`);
    expect(mine).toHaveTextContent(/You.*₹25,000/);
    expect(mine.props.accessibilityLabel).toMatch(/^Shamin \(you\), ₹25,000/);
    const tanmay = screen.getByTestId(`player-chip-${f.ids.Tanmay}`);
    expect(tanmay).toHaveTextContent(/Tanmay.*₹25,000/);
    expect(tanmay.props.accessibilityLabel).toMatch(/current turn/);
    expect(mine.props.accessibilityLabel).not.toMatch(/current turn/);
  });
});

describe('interactive, read-only board', () => {
  it('every one of the 36 squares opens details, and no tap ever sends an action or changes state', async () => {
    const f = table().loadAs('Tanmay');
    const before = useGameStore.getState().snapshot;
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    for (let i = 0; i < BOARD_SIZE; i++) {
      await fireEvent.press(screen.getByTestId(`board-square-${i}`));
      expect(screen.getByTestId(`square-details-${i}`)).toBeTruthy();
      // Nothing that mutates lives in the board sheet.
      for (const id of ['buy-button', 'pay-button', 'decline-button', 'trade-send', 'pay-confirm', 'loan-confirm']) expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.queryByTestId(/^action-[A-Z_]+$/)).toBeNull();
    }
    expect(api.action).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
    expect(useGameStore.getState().snapshot).toBe(before);
  });

  it('an unowned property shows its deed: price, availability, rent, mortgage value', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('AHMEDABAD')}`));
    const sheet = screen.getByTestId(`square-details-${positionOfProperty('AHMEDABAD')}`);
    expect(within(sheet).getByTestId('property-deed-header')).toHaveTextContent(/Ahmedabad/);
    expect(within(sheet).getByTestId('property-owner')).toHaveTextContent('Available · Bank');
    expect(sheet).toHaveTextContent(/₹4,000/);
    expect(within(sheet).getByTestId('rent-table')).toHaveTextContent(/Site only.*1 house.*Hotel/);
    expect(sheet).toHaveTextContent(/Mortgage value/);
    expect(within(sheet).queryByTestId('property-view-owner')).toBeNull();
  });

  it('owned property → owner → player details → Make Offer / Pay Money open the existing sheets prefilled', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`));
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Owned by Shamin');
    expect(screen.getByTestId('property-built')).toHaveTextContent(/2 houses/);
    expect(screen.getByTestId('current-rent')).toHaveTextContent('₹5,500');
    await fireEvent.press(screen.getByTestId('property-view-owner'));
    const details = screen.getByTestId(`player-details-${f.ids.Shamin}`);
    expect(details).toHaveTextContent(/Shamin/);
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent('₹25,000');
    expect(screen.getByTestId('player-details-location')).toHaveTextContent(/Jail/);
    expect(screen.getByTestId('player-details-loans')).toHaveTextContent(/₹0/);
    expect(within(details).getByTestId('property-MUMBAI')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('player-make-offer'));
    expect(screen.getByTestId('trade-sheet')).toBeTruthy();
    expect(screen.getByTestId('trade-with-Shamin').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('trade-want-MUMBAI')).toBeTruthy(); // their properties are listed for the offer

    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`));
    await fireEvent.press(screen.getByTestId('property-view-owner'));
    await fireEvent.press(screen.getByTestId('player-pay-money'));
    expect(screen.getByTestId('pay-sheet')).toBeTruthy();
    expect(screen.getByTestId('pay-to-Shamin').props.accessibilityState.selected).toBe(true);
    expect(api.action).not.toHaveBeenCalled();
  });

  it('my own property links to the existing property screen to build / mortgage / sell', async () => {
    const f = table();
    f.state.properties.DELHI.ownerId = f.ids.Tanmay!;
    f.loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('DELHI')}`));
    await fireEvent.press(screen.getByTestId('square-manage-property'));
    expect(router.push).toHaveBeenCalledWith('/property/DELHI');
    expect(api.action).not.toHaveBeenCalled();
  });

  it('tapping a token opens that player; my own details offer no deal with myself', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-token-press-${f.ids.Shamin}`));
    expect(screen.getByTestId(`player-details-${f.ids.Shamin}`)).toBeTruthy();
    expect(screen.getByTestId('player-make-offer')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`board-token-press-${f.ids.Tanmay}`));
    expect(screen.getByTestId(`player-details-${f.ids.Tanmay}`)).toHaveTextContent(/\(You\)/);
    expect(screen.queryByTestId('player-make-offer')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it.each([
    ['START', /Collect ₹1,500 every time you pass or land on Start/],
    ['JAIL', /pay ₹500 to leave and roll, or stay and miss the turn/],
    ['CLUB', /Pay ₹100 to every other player.*cost you ₹100/],
    ['REST_HOUSE', /Collect ₹100 from every other player, then miss your next turn/],
    ['INCOME_TAX', /₹50 for every property you own.*You would pay ₹0 now/],
    ['WEALTH_TAX', /₹100 per house and ₹200 per hotel.*You would pay/],
    ['CHANCE', /Draw a Chance card/],
    ['COMMUNITY_CHEST', /Draw a Community Chest card/],
  ] as const)('special square %s opens its information', async (type, text) => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionsOfSpecial(type)[0]}`));
    expect(screen.getByTestId('special-square-info')).toHaveTextContent(text);
  });

  it('Jail shows who is in it; Chance shows the card just drawn there', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    player(f, 'Asha').position = 12;
    f.roll('Asha', 4, 4).loadAs('Bilal'); // 12 + 8 = 20 Chance
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('board-square-20'));
    expect(screen.getByTestId('special-square-current-card')).toHaveTextContent(/Loss due to fire in godown/);
    expect(screen.getByTestId(`square-player-${f.ids.Asha}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`square-player-${f.ids.Asha}`));
    expect(screen.getByTestId(`player-details-${f.ids.Asha}`)).toBeTruthy();
  });
});

describe('turn + primary action', () => {
  it('my turn: YOUR TURN · Roll the dice to move, with ROLL DICE as the primary action', async () => {
    const f = table().loadAs('Tanmay');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('turn-title')).toHaveTextContent('YOUR TURN');
    expect(screen.getByTestId('turn-detail')).toHaveTextContent('Turn 1 · Roll the dice to move');
    await fireEvent.press(within(screen.getByTestId('turn-bar')).getByTestId('roll-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'ROLL_DICE' }));
  });

  it("someone else's turn: their name and what they're doing; no action for me", () => {
    const f = table();
    expect(turnStatus(viewFor(f, 'Shamin'))).toEqual({
      title: "TANMAY'S TURN",
      detail: 'Turn 1 · Tanmay is about to roll',
      primary: { kind: 'waiting', label: 'Rolling…' },
    });
  });

  it('the primary action follows the phase: Choose → End Turn; Pay ₹X pays in one tap', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2);
    expect(turnStatus(viewFor(f, 'Asha')).primary).toEqual({ kind: 'choose', label: 'Choose' });
    f.act('Asha', { type: 'BUY_PROPERTY' });
    expect(turnStatus(viewFor(f, 'Asha')).primary).toEqual({ kind: 'end-turn' });
    f.act('Asha', { type: 'END_TURN' }).roll('Bilal', 1, 2).loadAs('Bilal'); // Bilal lands on Asha's Railway
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('roll-button')).toBeNull();
    await fireEvent.press(screen.getByTestId('turn-pay'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PAY_RENT' }));
  });

  it('during an auction the primary action is the minimum bid', () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    const auction = f.state.auction!;
    expect(turnStatus(viewFor(f, 'Bilal')).primary).toEqual({ kind: 'bid', auctionId: auction.id, amount: 100 });
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ kind: 'auction', title: 'Railway is up for bids' });
  });
});

describe('contextual card', () => {
  it('falls back to where I stand, with a read-only link to the square', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('context-position')).toBeTruthy();
    expect(screen.getByTestId('context-card')).toHaveTextContent(/You are on.*Start/);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId(`square-details-${positionOfSpecial('START')}`)).toBeTruthy();
  });

  it("while someone else moves, it shows where they landed (property, price, owner)", () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2);
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ kind: 'position', label: 'Asha is on', title: 'Railway', detail: '₹9,500 · Not owned' });
  });

  it('an incoming offer takes priority; resolving it reveals the next item, and dismissing that reveals the position', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.act('Asha', { type: 'CREATE_TRADE', toPlayerId: f.ids.Bilal!, offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 6000 });
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ kind: 'offer', title: 'Asha wants to trade', detail: 'You get Railway ↔ you give ₹6,000' });
    f.act('Bilal', { type: 'REJECT_TRADE', tradeId: f.state.trades[0]!.id }).loadAs('Bilal');
    const ui = await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('context-news')).toBeTruthy();
    expect(screen.getByTestId('context-card')).toHaveTextContent(/Bilal rejected a trade offer/);
    await fireEvent.press(screen.getByTestId('context-dismiss'));
    expect(screen.getByTestId('context-position')).toBeTruthy();
    await ui.rerender(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('context-position')).toBeTruthy(); // stays dismissed
  });

  it('a payment I owe beats news; a payment owed to me is shown too', () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.roll('Bilal', 1, 2);
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ kind: 'payment', title: 'You owe ₹1,000', detail: 'to Asha · Rent for Railway', cta: { label: 'View Payment' } });
    expect(pickContext(viewFor(f, 'Asha'))).toMatchObject({ kind: 'payment', label: 'Payment due to you', title: 'Bilal owes you ₹1,000' });
  });

  it('an offer outranks my own pending payment; big moments outrank news', () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.act('Asha', { type: 'CREATE_TRADE', toPlayerId: f.ids.Bilal!, offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
    f.roll('Bilal', 1, 2);
    expect(pickContext(viewFor(f, 'Bilal')).kind).toBe('offer');

    const card = new Fixture(['Asha', 'Bilal']);
    player(card, 'Asha').position = 12;
    card.roll('Asha', 4, 4); // Chance: card drawn
    expect(pickContext(viewFor(card, 'Bilal'))).toMatchObject({ kind: 'event', icon: '🃏', label: 'Card drawn' });
  });

  it('a decision I must make shows what is at stake and opens the decision sheet', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('context-card')).toHaveTextContent(/For sale.*Railway · ₹9,500/);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('buy-card')).toBeTruthy();
    expect(screen.getByTestId('property-deed')).toHaveTextContent(/Railway/); // decide with the full deed in view
  });
});

describe('responsive layout (measured, not device presets)', () => {
  const TOP = 80; // measured header + player strip
  const cases: [number, number, 'row' | 'grid' | 'compact'][] = [
    [412, 840, 'row'],
    [390, 763, 'grid'],
    [360, 730, 'grid'],
    [360, 640, 'compact'],
    [360, 568, 'compact'],
    [320, 548, 'compact'],
  ];

  it.each(cases)('%ix%i → %s actions; board square, never wider than the screen, never below readable', (width, height, mode) => {
    const plan = planScreenLayout({ width, height, topHeight: TOP });
    expect(plan.actions).toBe(mode);
    const gutter = screenGutter(width);
    expect(plan.board + 2 * gutter).toBeLessThanOrEqual(width); // no horizontal scrolling
    expect(plan.board).toBeGreaterThanOrEqual(Math.min(MIN_BOARD, width - 2 * gutter));
    const content = SCREEN_PADDING.top + SCREEN_PADDING.bottom + TOP + plan.turnBarHeight + plan.board + plan.contextHeight + ACTION_AREA_HEIGHT[plan.actions] + 4 * plan.gap;
    if (plan.fits) expect(content).toBeLessThanOrEqual(height); // no clipping, actions on screen
    if (mode !== 'compact') expect(plan.board).toBeGreaterThanOrEqual(width - 2 * gutter - 8); // full-width board with all six actions
  });

  it('short phones go dense before the board shrinks; only a 320×548 screen needs a little scrolling', () => {
    expect(planScreenLayout({ width: 360, height: 640, topHeight: TOP })).toMatchObject({ dense: false, fits: true });
    expect(planScreenLayout({ width: 360, height: 568, topHeight: TOP })).toMatchObject({ dense: true, fits: true });
    expect(planScreenLayout({ width: 320, height: 548, topHeight: TOP })).toMatchObject({ dense: true, fits: false, board: MIN_BOARD });
  });

  it.each([
    [412, 840, 'row', 388],
    [390, 763, 'grid', 366],
    [360, 568, 'compact', 286],
  ] as const)('the screen uses its measured size: %ix%i shows the %s bar and a %ipx board', async (width, height, mode, board) => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent(screen.getByTestId('game-top'), 'layout', { nativeEvent: { layout: { width: width - 24, height: TOP } } });
    await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width, height } } });
    expect(screen.getByTestId(`action-bar-${mode}`)).toBeTruthy();
    const style = StyleSheet.flatten(screen.getByTestId('classic-board').props.style);
    expect(style.width).toBe(board);
    expect(style.height).toBe(board);
    if (mode === 'compact') {
      // Only the most used actions stay; the rest are in More.
      // Transfer + Bank / Loan + More stay; the rest (Pay Money included) are in More.
      expect(screen.getByTestId('open-trade')).toBeTruthy();
      expect(screen.getByTestId('open-loan')).toBeTruthy();
      expect(screen.queryByTestId('open-pay')).toBeNull();
      expect(screen.queryByTestId('open-properties')).toBeNull();
      await fireEvent.press(screen.getByTestId('open-more'));
      for (const id of ['more-properties', 'more-pay', 'more-auction']) expect(screen.getByTestId(id)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('more-pay'));
      expect(screen.getByTestId('pay-sheet')).toBeTruthy();
    } else {
      for (const id of ['open-properties', 'open-trade', 'open-pay', 'open-loan', 'open-auction', 'open-more']) expect(screen.getByTestId(id)).toBeTruthy();
    }
  });
});
