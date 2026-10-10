/// <reference types="jest" />
/** The main game screen as a digital game table: interactive read-only board, turn + primary action, contextual card, adaptive actions. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  BOARD_SIZE,
  computeRent,
  getDeed,
  groupMembers,
  mortgagePayout,
  netWorth,
  outstandingDebt,
  positionOfProperty,
  positionOfSpecial,
  positionsOfSpecial,
  sellBuildingRefund,
  unmortgageCost,
} from '@/engine/index.ts';
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
import { formatINR } from '@/utils/currency';
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

/** Tanmay owns every Pink property (Delhi's colour): what building on Delhi requires. */
function givePink(f: Fixture) {
  for (const key of groupMembers('PINK')) f.state.properties[key].ownerId = f.ids.Tanmay!;
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
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Shamin/);
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

  it('my own property: details and Manage property share one sheet; building updates it in place, no navigation', async () => {
    const f = table();
    givePink(f);
    f.loadAs('Tanmay');
    const ui = await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    // My own sheet → the property.
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Tanmay}`));
    await fireEvent.press(screen.getByTestId('property-DELHI'));
    const sheet = screen.getByTestId(`square-details-${positionOfProperty('DELHI')}`);
    expect(within(sheet).getByTestId('property-deed-header')).toHaveTextContent(/Delhi/);
    expect(within(sheet).getByTestId('rent-table')).toBeTruthy();
    expect(within(sheet).getByTestId('property-built')).toHaveTextContent(/0 houses/);
    // The same card carries the actions, with the engine's amounts; the old hop to another screen is gone.
    const manage = within(within(sheet).getByTestId('property-deed')).getByTestId('property-manage');
    expect(screen.queryByTestId('square-manage-property')).toBeNull();
    const deed = getDeed('DELHI');
    if (deed.kind !== 'CITY') throw new Error('Delhi is a city site');
    expect(within(manage).getByTestId('action-BUILD_HOUSE')).toHaveTextContent(`Build House · ${formatINR(deed.houseCost)}`);
    expect(within(manage).getByTestId('action-MORTGAGE_PROPERTY')).toHaveTextContent(`Mortgage · +${formatINR(mortgagePayout('DELHI'))}`);
    expect(within(manage).getByTestId('action-SELL_PROPERTY')).toHaveTextContent(`Sell to Bank · +${formatINR(deed.mortgageValue)}`);
    for (const kind of ['BUILD_HOUSE', 'MORTGAGE_PROPERTY', 'SELL_PROPERTY']) expect(screen.getByTestId(`action-${kind}`).props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByTestId('action-SELL_BUILDING')).toBeNull();
    expect(screen.queryByTestId('action-UNMORTGAGE_PROPERTY')).toBeNull();

    // Build: one request to the referee, then the same sheet shows the new authoritative state.
    f.act('Tanmay', { type: 'BUILD_HOUSE', propertyKey: 'DELHI' }).loadAs('Tanmay');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('action-BUILD_HOUSE'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'BUILD_HOUSE', propertyKey: 'DELHI' });
    await ui.rerender(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId(`square-details-${positionOfProperty('DELHI')}`)).toBeTruthy();
    expect(screen.getByTestId('property-built')).toHaveTextContent(/1 house$/);
    expect(screen.getByTestId('current-rent')).toHaveTextContent(formatINR(computeRent(f.state, 'DELHI', 7)));
    expect(screen.getByTestId('action-SELL_BUILDING')).toHaveTextContent(/Sell House · \+₹/);
    expect(screen.getByTestId('action-SELL_PROPERTY').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('action-note-SELL_PROPERTY')).toHaveTextContent('Sell the buildings first.');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('mortgage and sell keep the sheet on the property and show its new state', async () => {
    const f = table();
    f.state.properties.DELHI.ownerId = f.ids.Tanmay!;
    f.loadAs('Tanmay');
    const ui = await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('DELHI')}`));

    const before = player(f, 'Tanmay').balance;
    const payout = mortgagePayout('DELHI');
    f.act('Tanmay', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' }).loadAs('Tanmay');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('action-MORTGAGE_PROPERTY'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    await ui.rerender(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(player(f, 'Tanmay').balance).toBe(before + payout);
    expect(screen.getByText('Mortgaged — no rent')).toBeTruthy();
    expect(screen.getByTestId('current-rent')).toHaveTextContent('₹0');
    // No second mortgage, nothing to build on or sell until it is unmortgaged.
    expect(screen.queryByTestId('action-MORTGAGE_PROPERTY')).toBeNull();
    expect(screen.getByTestId('action-UNMORTGAGE_PROPERTY')).toHaveTextContent(`Unmortgage · ${formatINR(unmortgageCost('DELHI'))}`);
    expect(screen.getByTestId('action-BUILD_HOUSE').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('action-note-BUILD_HOUSE')).toHaveTextContent('Unmortgage this property first.');
    expect(screen.getByTestId('action-SELL_PROPERTY').props.accessibilityState.disabled).toBe(true);

    f.act('Tanmay', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'DELHI' }).act('Tanmay', { type: 'SELL_PROPERTY', propertyKey: 'DELHI' }).loadAs('Tanmay');
    await ui.rerender(<GameScreen view={viewFor(f, 'Tanmay')} />);
    // Sold: still on the property, now the bank's, with nothing left to manage.
    expect(screen.getByTestId(`square-details-${positionOfProperty('DELHI')}`)).toBeTruthy();
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Available · Bank');
    expect(screen.queryByTestId('property-manage')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('someone else’s property and an unowned one are read-only: no manage section', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('MUMBAI')}`));
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Owned by Shamin');
    expect(within(screen.getByTestId('property-owner-badge', { includeHiddenElements: true })).queryByText(/./)).toBeNull();
    expect(screen.getByTestId('property-view-owner')).toBeTruthy();
    expect(screen.queryByTestId('property-manage')).toBeNull();
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('AHMEDABAD')}`));
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Available · Bank');
    expect(screen.queryByTestId('property-manage')).toBeNull();
    expect(screen.queryByTestId(/^action-[A-Z_]+$/)).toBeNull();
  });

  it('manage actions follow the engine: no cash, a hotel, a paused game, and a refusal from the server', async () => {
    const f = table();
    givePink(f);
    Object.assign(f.state.properties.MADRAS, { ownerId: f.ids.Tanmay!, houses: 0, hotel: true });
    player(f, 'Tanmay').balance = 100;
    f.loadAs('Tanmay');
    const ui = await render(<GameScreen view={viewFor(f, 'Tanmay')} />);

    // Not enough cash: Build House is shown, disabled, with the engine's reason; mortgaging still works.
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('DELHI')}`));
    expect(screen.getByTestId('action-BUILD_HOUSE').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('action-note-BUILD_HOUSE')).toHaveTextContent('Not enough money for a house.');
    expect(screen.getByTestId('action-MORTGAGE_PROPERTY').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('action-BUILD_HOUSE'));
    expect(api.action).not.toHaveBeenCalled();

    // A refusal is shown next to the buttons, and the sheet stays.
    api.action.mockResolvedValue({ ok: false, error: { code: 'INVALID_PHASE', message: 'Wait for the auction to finish.' } });
    await fireEvent.press(screen.getByTestId('action-MORTGAGE_PROPERTY'));
    await waitFor(() => expect(screen.getByTestId('property-manage-error')).toHaveTextContent('Wait for the auction to finish.'));
    expect(screen.getByTestId(`square-details-${positionOfProperty('DELHI')}`)).toBeTruthy();

    // A hotel: nothing more to build; sell the hotel before the site; mortgaging pays the deed value and keeps the hotel.
    await fireEvent.press(screen.getByTestId(`board-square-${positionOfProperty('MADRAS')}`));
    expect(screen.queryByTestId('property-manage-error')).toBeNull();
    expect(screen.getByTestId('property-built')).toHaveTextContent(/Hotel/);
    expect(screen.queryByTestId('action-BUILD_HOUSE')).toBeNull();
    expect(screen.queryByTestId('action-BUILD_HOTEL')).toBeNull();
    expect(screen.getByTestId('action-SELL_BUILDING')).toHaveTextContent(`Sell Hotel · +${formatINR(sellBuildingRefund('MADRAS', f.state.properties.MADRAS))}`);
    expect(screen.getByTestId('action-note-SELL_BUILDING')).toHaveTextContent('Sells the hotel and the 3 houses it replaced.');
    expect(screen.getByTestId('action-MORTGAGE_PROPERTY')).toHaveTextContent(`Mortgage · +${formatINR(getDeed('MADRAS').mortgageValue)}`);
    expect(screen.getByTestId('action-note-MORTGAGE_PROPERTY')).toHaveTextContent('Your buildings stay, but earn no rent until you unmortgage.');
    expect(screen.getByTestId('action-note-SELL_PROPERTY')).toHaveTextContent('Sell the buildings first.');

    // Paused: every action disabled, the reason said once.
    f.state.status = 'PAUSED';
    f.loadAs('Tanmay');
    await ui.rerender(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('property-manage-blocked')).toHaveTextContent('Game is paused.');
    for (const kind of ['SELL_BUILDING', 'MORTGAGE_PROPERTY', 'SELL_PROPERTY']) expect(screen.getByTestId(`action-${kind}`).props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId(/^action-note-/)).toBeNull();
  });

  it('My Properties opens the full wallet page directly — no sheet in between; another player still opens Player Details', async () => {
    const f = table();
    f.state.properties.DELHI.ownerId = f.ids.Tanmay!;
    f.loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId('open-properties'));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(`/player/${f.ids.Tanmay}`);
    expect(screen.queryByTestId('sheet-player')).toBeNull();
    expect(screen.queryByTestId(`player-details-${f.ids.Tanmay}`)).toBeNull();
    // The same from the More sheet, which closes behind the page.
    for (const id of ['more-properties', 'more-manage']) {
      await fireEvent.press(screen.getByTestId('open-more'));
      await fireEvent.press(screen.getByTestId(id));
      expect(router.push).toHaveBeenLastCalledWith(`/player/${f.ids.Tanmay}`);
      expect(screen.queryByTestId('more-actions')).toBeNull();
      expect(screen.queryByTestId('sheet-player')).toBeNull();
    }
    expect(router.push).toHaveBeenCalledTimes(3);
    // Someone else: Player Details, as before.
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Shamin}`));
    expect(screen.getByTestId(`player-details-${f.ids.Shamin}`)).toBeTruthy();
    expect(screen.getByTestId('player-make-offer')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('tapping a token opens that player; my own details offer no deal with myself', async () => {
    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`board-token-press-${f.ids.Shamin}`));
    expect(screen.getByTestId(`player-details-${f.ids.Shamin}`)).toBeTruthy();
    expect(screen.getByTestId('player-make-offer')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`board-token-press-${f.ids.Tanmay}`));
    expect(screen.getByTestId(`player-details-${f.ids.Tanmay}`)).toBeTruthy();
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Tanmay.*\(You\)/);
    expect(screen.queryByTestId('player-make-offer')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('My Properties and Player Details are one sheet: same structure, each with its own player’s data', async () => {
    const f = table();
    Object.assign(f.state.properties.DELHI, { ownerId: f.ids.Tanmay!, hotel: true });
    Object.assign(f.state.properties.RAILWAY, { ownerId: f.ids.Tanmay!, mortgaged: true });
    f.act('Tanmay', { type: 'REQUEST_LOAN', amount: 2000 }).loadAs('Tanmay');
    const view = viewFor(f, 'Tanmay');
    await render(<GameScreen view={view} />);
    const parts = ['player-details-header', 'player-details-balance', 'player-details-location', 'player-details-net-worth', 'player-details-loans', 'player-details-properties', 'player-open-wallet'];

    // Mine: my cash, net worth and loan; my two properties with their states; no deal with myself.
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Tanmay}`));
    for (const id of parts) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId('player-details-badge', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Tanmay.*\(You\).*Active.*Your turn/);
    // A plain colour token, as on the board: no initial inside.
    expect(within(screen.getByTestId('player-details-badge', { includeHiddenElements: true })).queryByText(/./)).toBeNull();
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent(formatINR(player(f, 'Tanmay').balance));
    expect(screen.getByTestId('player-details-net-worth')).toHaveTextContent(formatINR(netWorth(f.state, f.ids.Tanmay!)), { exact: false });
    expect(screen.getByTestId('player-details-loans')).toHaveTextContent(formatINR(outstandingDebt(f.state.loans, f.ids.Tanmay!)), { exact: false });
    const mine = screen.getByTestId('player-details-properties');
    expect(within(mine).getByTestId('property-count')).toHaveTextContent('2');
    expect(within(mine).getByTestId('property-status-DELHI')).toHaveTextContent(/Hotel/);
    expect(within(mine).getByTestId('property-status-RAILWAY')).toHaveTextContent('Mortgaged');
    expect(within(mine).queryByTestId('property-MUMBAI')).toBeNull();
    expect(mine).toHaveTextContent(/Tap a property to build, mortgage or sell/);
    expect(screen.queryByTestId('player-details-actions')).toBeNull();
    expect(screen.getByTestId('player-open-wallet')).toHaveTextContent(/Wallet & History.*Transactions, loans and financial history/);

    // Theirs: the same parts, their numbers, their property; in Jail and not their turn.
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Shamin}`));
    for (const id of parts) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId('player-details-badge', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Shamin/);
    expect(screen.getByTestId('player-details-header')).not.toHaveTextContent(/You|turn/);
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent('₹25,000');
    expect(screen.getByTestId('player-details-loans')).toHaveTextContent(/₹0$/);
    const theirs = screen.getByTestId('player-details-properties');
    expect(within(theirs).getByTestId('property-count')).toHaveTextContent('1');
    expect(within(theirs).getByTestId('property-status-MUMBAI')).toHaveTextContent(/× 2/);
    expect(within(theirs).queryByTestId('property-DELHI')).toBeNull();
    expect(theirs).not.toHaveTextContent(/Tap a property/);
    expect(screen.getByTestId('player-make-offer').props.accessibilityState.disabled).toBe(false);

    // A row opens the existing property details; the wallet row keeps its destination.
    await fireEvent.press(within(theirs).getByTestId('property-MUMBAI'));
    expect(screen.getByTestId(`square-details-${positionOfProperty('MUMBAI')}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('property-view-owner'));
    await fireEvent.press(screen.getByTestId('player-open-wallet'));
    expect(router.push).toHaveBeenCalledWith(`/player/${f.ids.Shamin}`);
    expect(api.action).not.toHaveBeenCalled();
  });

  it('player sheet: compact empty state, jail badge, a long name keeps (You) and the close button', async () => {
    const long = 'Maharaja Krishnadeva'; // the longest name the game accepts (20 characters)
    const f = new Fixture([long, 'Bilal']);
    Object.assign(player(f, 'Bilal'), { inJail: true, jailTurnsLeft: 2, position: positionOfSpecial('JAIL') });
    f.loadAs(long);
    await render(<GameScreen view={viewFor(f, long)} />);
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids[long]}`));
    expect(screen.getByText(long).props.numberOfLines).toBe(1);
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/\(You\)/);
    expect(within(screen.getByTestId('sheet-player')).getByLabelText('Close')).toBeTruthy();
    expect(screen.getByTestId('property-list-empty')).toHaveTextContent('No properties yet');
    expect(screen.getByTestId('player-details-properties')).not.toHaveTextContent(/Tap a property/);

    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Bilal}`));
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Bilal.*In Jail · 2 left/);
    expect(screen.getByTestId('player-details-location')).toHaveTextContent(/Jail/);
  });

  it('Make Offer / Pay Money stay visible but disabled, with the reason, when a deal is not allowed', async () => {
    const f = table();
    player(f, 'Shamin').status = 'BANKRUPT';
    f.loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Shamin}`));
    expect(screen.getByTestId('player-make-offer').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('player-pay-money').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('player-actions-blocked')).toHaveTextContent('This player is out of the game.');
    await fireEvent.press(screen.getByTestId('player-make-offer'));
    expect(screen.queryByTestId('trade-sheet')).toBeNull();
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

  it('an incoming offer takes priority; resolving it reveals the latest news, which has no close button and opens the game log', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.act('Asha', { type: 'CREATE_TRADE', toPlayerId: f.ids.Bilal!, offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 6000 });
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ kind: 'offer', title: 'Asha wants to trade', detail: 'You get Railway ↔ you give ₹6,000' });
    f.act('Bilal', { type: 'REJECT_TRADE', tradeId: f.state.trades[0]!.id }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('context-news')).toBeTruthy();
    const card = screen.getByTestId('context-card');
    expect(card).toHaveTextContent(/Latest.*Bilal rejected a trade offer/);
    // Not a popup: nothing to dismiss, and the only control is the card's one action.
    expect(screen.queryByTestId('context-dismiss')).toBeNull();
    expect(within(card).queryByLabelText('Dismiss')).toBeNull();
    expect(within(card).queryByText('✕')).toBeNull();
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    // The message gets the freed width and wraps instead of being cut after one line.
    expect(screen.getByTestId('context-title').props.numberOfLines).toBeGreaterThanOrEqual(2);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('event-feed')).toBeTruthy();
  });

  it('news about a property keeps View Property, which opens that property; no close button for any kind of item', async () => {
    const f = table();
    f.state.properties.DELHI.ownerId = f.ids.Tanmay!;
    f.act('Tanmay', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' }).loadAs('Tanmay');
    expect(pickContext(viewFor(f, 'Tanmay'))).toMatchObject({ kind: 'news', label: 'Latest', cta: { label: 'View Property', target: { kind: 'square', index: positionOfProperty('DELHI') } } });
    const ui = await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('context-title')).toHaveTextContent(/mortgaged Delhi/);
    expect(screen.queryByTestId('context-dismiss')).toBeNull();
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId(`square-details-${positionOfProperty('DELHI')}`)).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
    // Position and paused items never had one either.
    f.state.status = 'PAUSED';
    f.loadAs('Tanmay');
    await ui.rerender(<GameScreen view={viewFor(f, 'Tanmay')} />);
    expect(screen.getByTestId('context-paused')).toBeTruthy();
    expect(screen.queryByTestId('context-dismiss')).toBeNull();
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
    [412, 840, 'grid'],
    [412, 750, 'row'],
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

  it('a tall screen spends its spare height on the sections — the board slot never gets slack above or below it', async () => {
    const snug = planScreenLayout({ width: 412, height: 764, topHeight: TOP });
    const tall = planScreenLayout({ width: 412, height: 915, topHeight: TOP });
    expect(tall.board).toBe(snug.board); // already as wide as the screen
    expect(tall.actions).toBe('grid');
    expect(tall.contextHeight).toBeGreaterThan(snug.contextHeight);
    expect(tall.actionButtonHeight).toBeGreaterThan(snug.actionButtonHeight);
    expect(tall.gap).toBeGreaterThan(snug.gap);
    expect(tall.gap).toBeLessThanOrEqual(16); // comfortable, never a blank band
    const used = (p: typeof tall) => SCREEN_PADDING.top + SCREEN_PADDING.bottom + TOP + p.turnBarHeight + p.board + p.contextHeight + 2 * p.actionButtonHeight + 6 + 4 * p.gap;
    expect(used(tall)).toBeLessThanOrEqual(915);
    expect(used(snug)).toBeLessThanOrEqual(764);

    const f = table().loadAs('Tanmay');
    await render(<GameScreen view={viewFor(f, 'Tanmay')} />);
    await fireEvent(screen.getByTestId('game-top'), 'layout', { nativeEvent: { layout: { width: 396, height: TOP } } });
    await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 915 } } });
    const area = StyleSheet.flatten(screen.getByTestId('board-area').props.style);
    expect(area.height).toBe(tall.board);
    expect(area.flexGrow).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('context-card').props.style).height).toBe(tall.contextHeight);
    expect(StyleSheet.flatten(screen.getByTestId('open-pay').props.style).height).toBe(tall.actionButtonHeight);
    // Whatever is still left sits above the actions, which stay at the bottom of the screen.
    expect(StyleSheet.flatten(screen.getByTestId('action-area').props.style)).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end' });
  });

  it('short phones go dense before the board shrinks; only a 320×548 screen needs a little scrolling', () => {
    expect(planScreenLayout({ width: 360, height: 640, topHeight: TOP })).toMatchObject({ dense: false, fits: true });
    expect(planScreenLayout({ width: 360, height: 568, topHeight: TOP })).toMatchObject({ dense: true, fits: true });
    expect(planScreenLayout({ width: 320, height: 548, topHeight: TOP })).toMatchObject({ dense: true, fits: false, board: MIN_BOARD });
  });

  it.each([
    [412, 840, 'grid', 396],
    [412, 750, 'row', 396],
    [390, 763, 'grid', 374],
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
