/// <reference types="jest" />
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { netWorth, outstandingDebt, RULE_SECTIONS, TOP_RULES } from '@/engine/index.ts';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { PropertyView } from '@/features/player/PropertyView';
import { TradeSheet } from '@/features/trade/TradeSheet';
import { PayPlayerSheet } from '@/features/transactions/PayPlayerSheet';
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

/** Fixture where Asha owns Railway (bought on the first roll) and it is Bilal's turn. */
function withRailway() {
  return new Fixture().roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Adaptive action bar + More', () => {
  it('all six actions when there is room: vector icon + short label, no emoji; every button a ≥44px target', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
    expect(screen.getByTestId('action-bar-grid')).toBeTruthy();
    const ids = ['open-properties', 'open-trade', 'open-pay', 'open-loan', 'open-auction', 'open-more'];
    const labels = ['My Properties', 'Transfer', 'Pay Money', 'Bank / Loan', 'Auction', 'More'];
    const icons = ['properties', 'transfer', 'pay', 'bank', 'auction', 'more'];
    ids.forEach((id, i) => {
      const button = screen.getByTestId(id);
      expect(StyleSheet.flatten(button.props.style).height).toBeGreaterThanOrEqual(44);
      // The only text in a button is its label; the icon is drawn, not typed.
      expect(within(button).getAllByText(/\S/).map((t) => String(t.props.children))).toEqual([labels[i]]);
      expect(within(button).getByTestId(`action-icon-${icons[i]}`)).toBeTruthy();
    });
    for (const label of ['My Properties', 'Transfer', 'Pay Money', 'Bank / Loan', 'Auction', 'More']) {
      expect(screen.getByText(label).props.numberOfLines).toBeLessThanOrEqual(2);
    }
    // Auction only works while one is running (auctions start when a property is declined).
    expect(screen.getByTestId('open-auction').props.accessibilityState.disabled).toBe(true);
    // No traditional tab bar: these are actions, not navigation.
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('each action opens its existing flow (no duplicate implementations)', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-pay'));
    expect(screen.getByTestId('pay-sheet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('open-loan'));
    expect(screen.queryByTestId('pay-sheet')).toBeNull(); // one sheet at a time
    expect(screen.getByTestId('loan-sheet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('open-trade'));
    expect(screen.getByTestId('trade-sheet')).toBeTruthy();
    // My Properties goes straight to the full wallet page: no sheet in between.
    await fireEvent.press(screen.getByTestId('open-properties'));
    expect(router.push).toHaveBeenCalledWith(`/player/${f.ids.Asha}`);
    expect(screen.queryByTestId(`player-details-${f.ids.Asha}`)).toBeNull();
    await fireEvent.press(screen.getByTestId('open-more'));
    const more = screen.getByTestId('more-actions');
    for (const id of ['more-properties', 'more-trade', 'more-pay', 'more-loan', 'more-auction', 'more-manage', 'request-undo', 'pause-button', 'open-log', 'open-rules', 'end-game-button']) {
      expect(within(more).getByTestId(id)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('open-rules'));
    expect(router.push).toHaveBeenCalledWith('/settings');
    expect(api.action).not.toHaveBeenCalled();
  });

  it('Undo (in More) is visible but disabled until there is something this player may undo', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('request-undo').props.accessibilityState.disabled).toBe(true);

    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 500 }).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('request-undo').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('request-undo'));
    await fireEvent.press(screen.getByTestId('undo-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'REQUEST_UNDO', targetActionId: f.state.undoStack.at(-1)!.actionId }));
  });

  it('after undoing the newest entry, Undo targets the previous one (multi-undo)', async () => {
    const f = new Fixture();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 100 });
    const first = f.state.undoStack.at(-1)!.actionId;
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 200 });
    f.act('Asha', { type: 'REQUEST_UNDO', targetActionId: f.state.undoStack.at(-1)!.actionId });
    f.act('Bilal', { type: 'APPROVE_UNDO', requestId: f.state.undoRequest!.id }).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('request-undo'));
    await fireEvent.press(screen.getByTestId('undo-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'REQUEST_UNDO', targetActionId: first }));
  });
});

describe('Pay a player sheet', () => {
  it('the button says what is missing, then exactly what it will do; the amount is grouped as typed', async () => {
    const f = new Fixture().loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true }));
    const onClose = jest.fn();
    await render(<PayPlayerSheet visible onClose={onClose} view={viewFor(f, 'Asha')} send={send} />);
    const button = () => screen.getByTestId('pay-confirm');
    expect(button()).toHaveTextContent('Choose a player');
    expect(button().props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Pay to')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('pay-to-Bilal'));
    expect(screen.getByTestId('pay-to-Bilal').props.accessibilityState.selected).toBe(true);
    expect(button()).toHaveTextContent('Enter amount');
    await fireEvent.changeText(screen.getByTestId('pay-amount'), '0');
    expect(button()).toHaveTextContent('Enter a valid amount');
    // More than I have: said in plain words, with what is available.
    await fireEvent.changeText(screen.getByTestId('pay-amount'), '9999999');
    expect(button()).toHaveTextContent('Insufficient funds');
    expect(button().props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Insufficient funds. You have ₹25,000 available.')).toBeTruthy();
    // Only digits count, and they are shown grouped.
    await fireEvent.changeText(screen.getByTestId('pay-amount'), '5,0a00');
    expect(screen.getByTestId('pay-amount').props.value).toBe('5,000');
    expect(screen.queryByText(/Insufficient funds/)).toBeNull();
    expect(button()).toHaveTextContent('Pay ₹5,000 to Bilal');
    expect(button().props.accessibilityState.disabled).toBe(false);
    await fireEvent.changeText(screen.getByTestId('pay-note'), ' deal for Delhi ');
    await fireEvent.press(button());
    expect(send).toHaveBeenCalledWith({ type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal, amount: 5000, memo: 'deal for Delhi' }, expect.anything());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('Trading UI', () => {
  it('guides instead of scolding: the helper and the button follow what is still missing', async () => {
    const f = withRailway().loadAs('Asha');
    await render(<TradeSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn(async () => ({ ok: true }))} />);
    const button = () => screen.getByTestId('trade-send');
    expect(button()).toHaveTextContent('Choose a player');
    expect(screen.queryByTestId('trade-problem')).toBeNull();
    expect(screen.queryByTestId('trade-want')).toBeNull();
    await fireEvent.press(screen.getByTestId('trade-with-Bilal'));
    expect(screen.getByTestId('trade-with-Bilal').props.accessibilityState.selected).toBe(true);
    // Two sides, each with its own properties and money.
    expect(screen.getByTestId('trade-give')).toHaveTextContent(/You give.*Railway.*Plus money you give/);
    expect(screen.getByTestId('trade-want')).toHaveTextContent(/You get from Bilal.*No properties available.*Plus money you get/);
    expect(button()).toHaveTextContent('Add something to trade');
    expect(screen.getByTestId('trade-problem')).toHaveTextContent('Add at least one property to the trade.');
    await fireEvent.changeText(screen.getByTestId('trade-give-money'), '2000');
    expect(screen.getByTestId('trade-give-money').props.value).toBe('2,000');
    expect(button()).toHaveTextContent('Complete the trade');
    expect(screen.getByTestId('trade-problem')).toHaveTextContent('Add at least one property to the trade.');
    await fireEvent.press(screen.getByTestId('trade-give-RAILWAY'));
    expect(screen.getByTestId('trade-give-RAILWAY').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('trade-give-RAILWAY')).toHaveTextContent(/Railway.*✓/);
    expect(button()).toHaveTextContent('Complete the trade');
    expect(button().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('trade-want-money'), '5000');
    expect(screen.queryByTestId('trade-problem')).toBeNull();
    expect(button()).toHaveTextContent('Send offer to Bilal');
    expect(button().props.accessibilityState.disabled).toBe(false);
    // A real obstacle is still the engine's own message.
    await fireEvent.changeText(screen.getByTestId('trade-want-money'), '999999');
    expect(screen.getByTestId('trade-problem')).toHaveTextContent(/Bilal doesn.t have the requested money/);
    expect(button().props.accessibilityState.disabled).toBe(true);
  });

  it('builds an offer: my property ⇄ custom money, sends CREATE_TRADE', async () => {
    const f = withRailway().loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true }));
    await render(<TradeSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} />);
    expect(screen.getByTestId('trade-send').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('trade-with-Bilal'));
    await fireEvent.press(screen.getByTestId('trade-give-RAILWAY'));
    // Nothing asked in return yet → explained, still disabled.
    expect(screen.getByTestId('trade-problem')).toHaveTextContent('Ask for something in return.');
    await fireEvent.changeText(screen.getByTestId('trade-want-money'), '5000');
    await fireEvent.press(screen.getByTestId('trade-send'));
    expect(send).toHaveBeenCalledWith(
      {
        type: 'CREATE_TRADE',
        toPlayerId: f.ids.Bilal,
        offeredPropertyKeys: ['RAILWAY'],
        requestedPropertyKeys: [],
        offeredMoney: 0,
        requestedMoney: 5000,
      },
      expect.anything(),
    );
  });

  it('can request the other player’s property and add money', async () => {
    const f = withRailway();
    f.roll('Bilal', 2, 4).act('Bilal', { type: 'BUY_PROPERTY' }).loadAs('Asha'); // Bilal buys Indore (square 6)
    const send = jest.fn(async () => ({ ok: true }));
    await render(<TradeSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} />);
    await fireEvent.press(screen.getByTestId('trade-with-Bilal'));
    await fireEvent.press(screen.getByTestId('trade-give-RAILWAY'));
    await fireEvent.changeText(screen.getByTestId('trade-give-money'), '2000');
    await fireEvent.press(screen.getByTestId('trade-want-INDORE'));
    await fireEvent.press(screen.getByTestId('trade-send'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ offeredPropertyKeys: ['RAILWAY'], offeredMoney: 2000, requestedPropertyKeys: ['INDORE'], requestedMoney: 0 }),
      expect.anything(),
    );
  });

  it('recipient sees the offer from their side and accepts it (with confirmation)', async () => {
    const f = withRailway();
    f.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: f.ids.Bilal!,
      offeredPropertyKeys: ['RAILWAY'],
      requestedPropertyKeys: [],
      offeredMoney: 0,
      requestedMoney: 6000,
    }).loadAs('Bilal');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('context-offer')).toBeTruthy();
    expect(screen.getByTestId('context-card')).toHaveTextContent(/Asha wants to trade/);
    await fireEvent.press(screen.getByTestId('context-cta')); // Review Offer
    const card = screen.getByTestId('trade-incoming');
    expect(within(card).getByText(/Trade offer from Asha/)).toBeTruthy();
    expect(card).toHaveTextContent(/You get: Railway/);
    expect(card).toHaveTextContent(/You give: ₹6,000/);
    await fireEvent.press(screen.getByTestId('trade-accept'));
    await fireEvent.press(screen.getByTestId('trade-accept-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'ACCEPT_TRADE', tradeId: f.state.trades[0]!.id }));
  });

  it('a mortgaged property in an offer says so, with what unmortgaging costs, before anyone accepts', async () => {
    const f = withRailway();
    f.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'RAILWAY' });
    f.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: f.ids.Bilal!,
      offeredPropertyKeys: ['RAILWAY'],
      requestedPropertyKeys: [],
      offeredMoney: 0,
      requestedMoney: 6000,
    }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('context-cta'));
    // Railway: mortgage value 4,750 + 10%.
    const note = 'Railway is mortgaged and stays mortgaged — ₹5,225 to unmortgage.';
    expect(within(screen.getByTestId('trade-incoming')).getByTestId('trade-mortgage-note')).toHaveTextContent(note);
    await fireEvent.press(screen.getByTestId('trade-accept'));
    expect(screen.getByTestId('trade-accept-dialog')).toHaveTextContent(note, { exact: false });
    expect(api.action).not.toHaveBeenCalled();
  });

  it('the trade builder marks a mortgaged property and what it will cost its new owner', async () => {
    const f = withRailway();
    f.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'RAILWAY' }).loadAs('Asha');
    await render(<TradeSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} initialPlayerId={f.ids.Bilal!} />);
    expect(screen.queryByTestId('trade-give-mortgage-note')).toBeNull();
    expect(screen.getByTestId('trade-give-RAILWAY').props.accessibilityLabel).toMatch(/Railway, mortgaged/);
    await fireEvent.press(screen.getByTestId('trade-give-RAILWAY'));
    expect(screen.getByTestId('trade-give-mortgage-note')).toHaveTextContent('Railway is mortgaged and stays mortgaged — ₹5,225 to unmortgage.');
  });

  it('a property with buildings can be picked in the trade builder, and the chip says what is built on it', async () => {
    const f = withRailway();
    Object.assign(f.state.properties.SHIMLA, { ownerId: f.ids.Asha!, houses: 2 });
    Object.assign(f.state.properties.AGRA, { ownerId: f.ids.Bilal!, hotel: true });
    f.loadAs('Asha');
    const send = jest.fn().mockResolvedValue({ ok: true });
    await render(<TradeSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialPlayerId={f.ids.Bilal!} />);
    const shimla = screen.getByTestId('trade-give-SHIMLA');
    expect(shimla.props.accessibilityState.disabled).toBe(false);
    expect(shimla.props.accessibilityLabel).toBe('Shimla, with 2 houses');
    expect(screen.getByTestId('trade-give-SHIMLA-built')).toHaveTextContent('· 2 houses');
    expect(screen.getByTestId('trade-want-AGRA-built')).toHaveTextContent('· hotel');
    // A property with nothing on it carries no such mark.
    expect(screen.queryByTestId('trade-give-RAILWAY-built')).toBeNull();
    await fireEvent.press(shimla);
    await fireEvent.press(screen.getByTestId('trade-want-AGRA'));
    await fireEvent.press(screen.getByTestId('trade-send'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ offeredPropertyKeys: ['SHIMLA'], requestedPropertyKeys: ['AGRA'] }), expect.anything());
  });

  it('an offer names the buildings on both sides, on the card and in the confirmation', async () => {
    const f = withRailway();
    Object.assign(f.state.properties.SHIMLA, { ownerId: f.ids.Asha!, houses: 2 });
    Object.assign(f.state.properties.AGRA, { ownerId: f.ids.Bilal!, houses: 1 });
    f.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: f.ids.Bilal!,
      offeredPropertyKeys: ['SHIMLA'],
      requestedPropertyKeys: ['AGRA'],
      offeredMoney: 0,
      requestedMoney: 500,
    }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('context-card')).toHaveTextContent(/You get Shimla \(2 houses\) ↔ you give Agra \(1 house\) \+ ₹500/);
    await fireEvent.press(screen.getByTestId('context-cta'));
    const card = screen.getByTestId('trade-incoming');
    expect(card).toHaveTextContent(/You get: Shimla \(2 houses\)/);
    expect(card).toHaveTextContent(/You give: Agra \(1 house\) \+ ₹500/);
    await fireEvent.press(screen.getByTestId('trade-accept'));
    expect(screen.getByTestId('trade-accept-dialog-summary')).toHaveTextContent(/You get Shimla \(2 houses\).*You give Agra \(1 house\) \+ ₹500/s);
  });

  it('recipient can reject; creator can cancel', async () => {
    const f = withRailway();
    f.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: f.ids.Bilal!,
      offeredPropertyKeys: ['RAILWAY'],
      requestedPropertyKeys: [],
      offeredMoney: 0,
      requestedMoney: 6000,
    });
    const tradeId = f.state.trades[0]!.id;
    f.loadAs('Bilal');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('context-cta'));
    await fireEvent.press(screen.getByTestId('trade-reject'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'REJECT_TRADE', tradeId }));

    jest.clearAllMocks();
    f.loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('context-card')).toHaveTextContent(/Waiting for Bilal/);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('trade-outgoing')).toBeTruthy();
    expect(screen.queryByTestId('trade-accept')).toBeNull();
    await fireEvent.press(screen.getByTestId('trade-cancel'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'CANCEL_TRADE', tradeId }));
  });

  it('an offer that became invalid cannot be accepted', async () => {
    const f = withRailway();
    f.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: f.ids.Bilal!,
      offeredPropertyKeys: ['RAILWAY'],
      requestedPropertyKeys: [],
      offeredMoney: 0,
      requestedMoney: 6000,
    });
    f.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'RAILWAY' }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByText('Railway no longer belongs to that player.')).toBeTruthy();
    expect(screen.getByTestId('trade-accept').props.accessibilityState.disabled).toBe(true);
  });
});

describe('Mortgage UI', () => {
  it('a developed site can be mortgaged; the button shows the deed mortgage value only, and says the buildings stay', async () => {
    const f = new Fixture().roll('Asha', 2, 4).act('Asha', { type: 'BUY_PROPERTY' }); // Indore
    f.state.properties.INDORE.houses = 2;
    f.loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="INDORE" />);
    // Indore: mortgage value 750. Nothing is added for the 2 houses.
    expect(screen.getByText('Mortgage · +₹750')).toBeTruthy();
    expect(screen.getByTestId('action-note-MORTGAGE_PROPERTY')).toHaveTextContent('Your buildings stay, but earn no rent until you unmortgage.');
    await fireEvent.press(screen.getByTestId('action-MORTGAGE_PROPERTY'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }));
  });

  it('a mortgaged site keeps showing its buildings; building and selling them wait for the unmortgage', async () => {
    const f = new Fixture().roll('Asha', 2, 4).act('Asha', { type: 'BUY_PROPERTY' });
    f.state.properties.INDORE.houses = 2;
    f.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }).loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="INDORE" />);
    expect(screen.getByText('Mortgaged — no rent')).toBeTruthy();
    expect(screen.getByTestId('current-rent')).toHaveTextContent('₹0');
    expect(screen.getByTestId('property-built')).toHaveTextContent(/2 houses/);
    // 750 + 10%.
    expect(screen.getByTestId('action-UNMORTGAGE_PROPERTY')).toHaveTextContent('Unmortgage · ₹825');
    expect(screen.getByTestId('action-note-UNMORTGAGE_PROPERTY')).toHaveTextContent('Mortgage value + 10%. Your buildings earn rent again.');
    for (const kind of ['BUILD_HOUSE', 'SELL_BUILDING']) {
      expect(screen.getByTestId(`action-${kind}`).props.accessibilityState.disabled).toBe(true);
      expect(screen.getByTestId(`action-note-${kind}`)).toHaveTextContent('Unmortgage this property first.');
    }
  });

  it('building works with a single property of a colour: Build House is enabled', async () => {
    const f = new Fixture().roll('Asha', 2, 4).act('Asha', { type: 'BUY_PROPERTY' }).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="INDORE" />);
    expect(screen.getByTestId('action-BUILD_HOUSE').props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByTestId('action-note-BUILD_HOUSE')).toBeNull();
    await fireEvent.press(screen.getByTestId('action-BUILD_HOUSE'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'BUILD_HOUSE', propertyKey: 'INDORE' }));
  });

  it('a mortgaged property shows no rent and offers unmortgage', async () => {
    const f = new Fixture().roll('Asha', 2, 4).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }).loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="INDORE" />);
    expect(screen.getByText('Mortgaged — no rent')).toBeTruthy();
    expect(screen.getByTestId('current-rent')).toHaveTextContent('₹0');
    expect(screen.getByTestId('action-UNMORTGAGE_PROPERTY')).toBeTruthy();
    expect(screen.queryByTestId('action-MORTGAGE_PROPERTY')).toBeNull();
  });
});

describe('Property details', () => {
  it('shows the doubled rent when the owner has 3+ of the colour', async () => {
    const f = new Fixture();
    for (const key of ['MUMBAI', 'AHMEDABAD', 'CALCUTTA'] as const) f.state.properties[key] = { ...f.state.properties[key], ownerId: f.ids.Asha! };
    f.loadAs('Bilal');
    await render(<PropertyView view={viewFor(f, 'Bilal')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('current-rent')).toHaveTextContent('₹2,400');
    expect(screen.getByTestId('rent-doubled')).toBeTruthy();
  });
});

describe('Loans UI', () => {
  it('an open loan shows its interest as due at the next Start', async () => {
    const f = new Fixture().act('Asha', { type: 'REQUEST_LOAN', amount: 5000 }).loadAs('Asha');
    await render(<LoanSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} />);
    expect(screen.getByTestId('loan-interest-status')).toHaveTextContent(/₹500 interest due at your next Start/);
    expect(screen.getByText('Owed ₹5,000')).toBeTruthy();
  });

  it('interest due at Start with too little cash: PAY INTEREST disabled, loan / bankruptcy offered', async () => {
    const f = new Fixture();
    f.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 44900 });
    f.state.players.find((p) => p.name === 'Asha')!.position = 34;
    f.roll('Asha', 2, 3).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('turn-choose')).toHaveTextContent('Raise cash');
    await fireEvent.press(screen.getByTestId('turn-choose'));
    expect(screen.getByText('Interest due at Start')).toBeTruthy();
    expect(screen.getByText('PAY ₹2,000')).toBeTruthy();
    expect(screen.getByTestId('pay-button').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('bankrupt-button')).toBeTruthy();
  });
});

describe('Special squares & cards', () => {
  it('Wealth Taxes shows the computed amount and what was counted', async () => {
    const f = new Fixture();
    f.state.properties.MUMBAI = { ...f.state.properties.MUMBAI, ownerId: f.ids.Asha!, hotel: true };
    f.state.properties.DELHI = { ...f.state.properties.DELHI, ownerId: f.ids.Asha!, houses: 2 };
    f.state.players.find((p) => p.name === 'Asha')!.position = 27;
    f.roll('Asha', 2, 2).loadAs('Asha'); // 27 + 4 = 31 Wealth Taxes
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('context-cta')); // View Payment
    expect(screen.getByTestId('payment-card')).toHaveTextContent(/Wealth Taxes — 2 houses × ₹100 \+ 1 hotel × ₹200/);
    expect(screen.getByText('PAY ₹400')).toBeTruthy();
    expect(screen.queryByTestId('tax-amount')).toBeNull(); // nothing to type in any more
    await fireEvent.press(screen.getByTestId('pay-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PAY_TAX' }));
  });

  it('card payment shows the exact card text (Chance even 8 — fire in godown ₹3,000)', async () => {
    const f = new Fixture();
    f.state.players.find((p) => p.name === 'Asha')!.position = 12;
    f.roll('Asha', 4, 4).loadAs('Asha'); // 12 + 8 = 20 Chance
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByText('PAY ₹3,000')).toBeTruthy();
    expect(screen.getAllByText(/Loss due to fire in godown/).length).toBeGreaterThan(0);
  });
});

describe('Settings', () => {
  it('one rulebook: the five rules to know first, then every other rule once, with no confirmed / assumed split', async () => {
    await render(<Settings />);
    const top = screen.getByTestId('top-rules');
    expect(within(top).getByText('The 5 rules to know')).toBeTruthy();
    TOP_RULES.forEach((rule, i) => {
      const row = within(top).getByTestId(`top-rules-${i + 1}`);
      expect(row).toHaveTextContent(new RegExp(`^${i + 1}`));
      expect(within(row).getByText(rule.title)).toBeTruthy();
      for (const line of rule.lines) expect(within(row).getByText(line)).toBeTruthy();
    });
    expect(within(top).queryByTestId('top-rules-6')).toBeNull();
    for (const section of RULE_SECTIONS) {
      const card = screen.getByTestId(`rules-${section.id}`);
      expect(within(card).getByText(section.title)).toBeTruthy();
      section.rules.forEach((rule, i) => {
        const row = within(card).getByTestId(`rules-${section.id}-${i + 1}`);
        expect(within(row).getByText(rule.title)).toBeTruthy();
        for (const line of rule.lines) expect(within(row).getByText(line)).toBeTruthy();
        if (rule.example) expect(row).toHaveTextContent(rule.example, { exact: false });
      });
    }
    // The old two-part page is gone, and so is its wording.
    expect(screen.queryByTestId('confirmed-rules')).toBeNull();
    expect(screen.queryByTestId('assumptions-list')).toBeNull();
    expect(screen.getByTestId('settings-screen')).not.toHaveTextContent(/confirmed|assum|verify|MVP/i);
  });

  it('shows the amounts the game uses', async () => {
    await render(<Settings />);
    const page = screen.getByTestId('settings-screen');
    for (const amount of ['₹25,000', '₹1,500', '₹4,250', '₹4,675']) expect(page).toHaveTextContent(amount, { exact: false });
    expect(within(screen.getByTestId('rules-property-money')).getByText(/You keep Mumbai and both houses, but collect no rent/)).toBeTruthy();
  });
});

describe('Realtime state update after undo', () => {
  it('a newer snapshot (from the realtime-triggered refetch) replaces the screen state', async () => {
    const f = new Fixture();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 500 }).loadAs('Bilal');
    f.act('Asha', { type: 'REQUEST_UNDO', targetActionId: f.state.undoStack.at(-1)!.actionId });
    f.act('Bilal', { type: 'APPROVE_UNDO', requestId: f.state.undoRequest!.id });
    await act(async () => {
      expect(useGameStore.getState().applySnapshot(f.snapshot())).toBe(true);
    });
    expect(useGameStore.getState().snapshot!.state.players.map((p) => p.balance)).toEqual([25000, 25000]);
  });
});
