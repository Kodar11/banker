/// <reference types="jest" />
import type { ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { creditScoreOf, netWorth, offeredRate, totalDebt, type GameAction, type GameMode, type PropertyKey } from '@/engine/index.ts';
import { auctionResult, auctionResultHeading, AuctionView, NEW_AUCTION } from '@/features/auction/AuctionView';
import { INTRO_SEEN_KEY } from '@/features/finance/IntermediateIntro';
import { GameScreen } from '@/features/game/GameScreen';
import { useGameView, type GameView } from '@/features/game/useGameView';
import { PropertyView } from '@/features/player/PropertyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const RESERVE = 5000;

const game = (mode: GameMode = 'intermediate', names = ['Asha', 'Bilal', 'Chitra']) =>
  new Fixture(names, { mode, config: mode === 'intermediate' ? { secretObjectives: false } : undefined });

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

/** Renders from the synced store, like a route does: a new snapshot (an answer, or realtime) re-renders it. */
function Live({ children }: { children: (view: GameView) => ReactNode }) {
  const view = useGameView();
  return view ? <>{children(view)}</> : null;
}

function give(f: Fixture, name: string, key: PropertyKey, patch: { mortgaged?: boolean; houses?: number; hotel?: boolean } = {}) {
  f.state.properties[key] = { ...f.state.properties[key], ownerId: f.ids[name]!, ...patch };
}

/** The server, played by the fixture: applies what the phone sends as `name` and answers with the new snapshot. */
function serveAs(f: Fixture, name: string) {
  api.action.mockImplementation(async (_session, _id, _version, action) => {
    f.act(name, action as GameAction);
    return ok(f.snapshot());
  });
}

/** Another device changed the game: the new snapshot arrives through sync. */
async function arrive(f: Fixture) {
  await act(async () => {
    useGameStore.getState().applySnapshot(f.snapshot());
  });
}

async function renderTable(f: Fixture, name: string) {
  f.loadAs(name);
  const view = await render(<Live>{(v) => <GameScreen view={v} />}</Live>);
  await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
  return view;
}

const renderAuction = (f: Fixture, name: string, auctionId: string) => {
  f.loadAs(name);
  return render(<Live>{(v) => <AuctionView view={v} auctionId={auctionId} />}</Live>);
};

const renderProperty = (f: Fixture, name: string, key: PropertyKey) => {
  f.loadAs(name);
  return render(<Live>{(v) => <PropertyView view={v} propertyKey={key} />}</Live>);
};

/** Test surgery: the auction's "get ready" is over. (The fixture runs on the real clock, which a test cannot move.) */
function openBidding(f: Fixture) {
  f.state.auction!.createdAt = new Date(Date.now() - 10_000).toISOString();
}

/** Asha owns Mumbai (with `patch`) and has listed it at the reserve; bidding is open unless `ready` is false. */
function listed(patch: { houses?: number; hotel?: boolean } = {}, reserve = RESERVE, ready = true) {
  const f = game();
  give(f, 'Asha', 'MUMBAI', patch);
  f.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: reserve });
  if (ready) openBidding(f);
  return { f, auctionId: f.state.auction!.id };
}

function bid(f: Fixture, name: string, amount: number) {
  openBidding(f);
  return f.act(name, { type: 'PLACE_BID', auctionId: f.state.auction!.id, amount });
}
const pass = (f: Fixture, name: string) => f.act(name, { type: 'PASS_AUCTION', auctionId: f.state.auction!.id });
const disabled = (testID: string) => screen.getByTestId(testID).props.accessibilityState.disabled;

beforeEach(async () => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  await SecureStore.setItemAsync(INTRO_SEEN_KEY, '1');
});

// ---------------------------------------------------------------------------

describe('Entry point: the game table’s Auction button', () => {
  it('Capital, no auction running: Auction is enabled and opens the auction screen to start one', async () => {
    const f = game();
    await renderTable(f, 'Asha');
    expect(disabled('open-auction')).toBe(false);
    await fireEvent.press(screen.getByTestId('open-auction'));
    expect(router.push).toHaveBeenCalledWith(`/auction/${NEW_AUCTION}`);

    await fireEvent.press(screen.getByTestId('open-more'));
    const item = screen.getByTestId('more-auction');
    expect(within(item).getByText('Auction one of your properties')).toBeTruthy();
    await fireEvent.press(item);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it('Classic: the Auction button is what it was — disabled until the bank’s auction starts', async () => {
    const f = game('classic');
    give(f, 'Asha', 'MUMBAI');
    await renderTable(f, 'Asha');
    expect(disabled('open-auction')).toBe(true);
    await fireEvent.press(screen.getByTestId('open-auction'));
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(disabled('more-auction')).toBe(true);
    expect(within(screen.getByTestId('more-auction')).getByText('No auction running')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a running resale is announced on the table and takes the bidders — not the seller — to it', async () => {
    const { f, auctionId } = listed({ houses: 2 });
    await renderTable(f, 'Bilal');
    expect(router.push).toHaveBeenCalledWith(`/auction/${auctionId}`);
    expect(screen.getByTestId('context-card')).toHaveTextContent(/sold by Asha/i);
    expect(screen.getByTestId('context-card')).toHaveTextContent(/Opening bid ₹5,000/);
  });
});

describe('Entry point: the auction screen', () => {
  it('lists my properties with what is built on them, and says why one can’t be auctioned', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI', { houses: 2 });
    give(f, 'Asha', 'AHMEDABAD', { mortgaged: true });
    give(f, 'Asha', 'CALCUTTA');
    give(f, 'Asha', 'MADRAS', { hotel: true });
    give(f, 'Bilal', 'RAILWAY');
    const rate = offeredRate('SECURED', creditScoreOf(f.state.intermediate!, f.ids.Asha!)).ratePercent;
    // Worth enough on its own to secure the smallest loan (80% of ₹13,000); pledged the way an older app sends one property.
    f.state.intermediate!.market.CALCUTTA.value = 13000;
    f.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'SECURED', amount: 10000, collateralKey: 'CALCUTTA', expectedRatePercent: rate });
    await renderAuction(f, 'Asha', NEW_AUCTION);

    // The page reads like the app's other screens: a way back, what is going on, then what I can do here.
    expect(screen.getByTestId('auction-back')).toBeTruthy();
    expect(screen.getByTestId('auction-idle-status')).toHaveTextContent(/No auction running/);
    expect(screen.getByTestId('auction-idle-status')).toHaveTextContent(/puts one of their own up for sale/);
    const picker = screen.getByTestId('resale-picker');
    expect(within(picker).getByText('Auction my property')).toBeTruthy();
    expect(screen.getByTestId('resale-steps')).toHaveTextContent(/Pick a property.*Set your reserve.*Highest bid wins/);
    expect(screen.getByTestId('resale-count')).toHaveTextContent('4');
    expect(screen.getByTestId('resale-pick-status-MUMBAI')).toHaveTextContent('Includes 2 houses');
    expect(screen.getByTestId('resale-pick-status-MADRAS')).toHaveTextContent('Includes the hotel');
    expect(disabled('resale-pick-MUMBAI')).toBe(false);
    expect(screen.queryByTestId('resale-pick-why-MUMBAI')).toBeNull();
    // Unavailable, visibly, with the reason.
    expect(disabled('resale-pick-AHMEDABAD')).toBe(true);
    expect(screen.getByTestId('resale-pick-status-AHMEDABAD')).toHaveTextContent('No buildings · Mortgaged');
    expect(screen.getByTestId('resale-pick-why-AHMEDABAD')).toHaveTextContent(/^Mortgaged/);
    expect(disabled('resale-pick-CALCUTTA')).toBe(true);
    expect(screen.getByTestId('resale-pick-why-CALCUTTA')).toHaveTextContent(/^Pledged as loan collateral/);
    // Never somebody else's property.
    expect(screen.queryByTestId('resale-pick-RAILWAY')).toBeNull();
  });

  it('with no property to sell, says so instead of showing an empty list', async () => {
    const f = game();
    await renderAuction(f, 'Asha', NEW_AUCTION);
    expect(screen.getByTestId('resale-picker-empty')).toHaveTextContent(/You don’t own a property yet/);
    expect(screen.queryByTestId('resale-sheet')).toBeNull();
  });

  it('outside my turn every property is unavailable, for one stated reason', async () => {
    const f = game();
    give(f, 'Bilal', 'MUMBAI');
    give(f, 'Bilal', 'MADRAS');
    await renderAuction(f, 'Bilal', NEW_AUCTION);
    expect(screen.getByTestId('resale-picker-blocked')).toHaveTextContent('You can auction a property during your own turn.');
    expect(disabled('resale-pick-MUMBAI')).toBe(true);
    await fireEvent.press(screen.getByTestId('resale-pick-MUMBAI'));
    expect(screen.queryByTestId('resale-sheet')).toBeNull();
  });

  it('pick → reserve price → review → start: one request, then straight to the auction it opened', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI', { houses: 2 });
    serveAs(f, 'Asha');
    await renderAuction(f, 'Asha', NEW_AUCTION);
    await fireEvent.press(screen.getByTestId('resale-pick-MUMBAI'));

    expect(screen.getByTestId('resale-bundle')).toHaveTextContent('Includes 2 houses');
    // No price, no listing.
    expect(disabled('resale-review')).toBe(true);
    expect(screen.getByTestId('resale-review')).toHaveTextContent('Enter a reserve price');
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '0');
    expect(disabled('resale-review')).toBe(true);
    expect(screen.getByText('Enter a reserve price in whole rupees.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '2000000');
    expect(disabled('resale-review')).toBe(true);
    expect(screen.getByText('The reserve price can be at most ₹10,00,000.')).toBeTruthy();
    // Letters, signs and decimals never get into the field.
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '-5,0a00.');
    expect(screen.getByTestId('resale-review')).toHaveTextContent('Review · reserve ₹5,000');
    expect(disabled('resale-review')).toBe(false);
    expect(api.action).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('resale-review'));
    expect(screen.getByTestId('resale-dialog-summary')).toHaveTextContent('Includes 2 houses · Reserve ₹5,000');
    await fireEvent.press(screen.getByTestId('resale-dialog-confirm'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 5000 });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/auction/${f.state.auction!.id}`));
    expect(f.state.auction).toMatchObject({ status: 'OPEN', resale: { sellerId: f.ids.Asha, reservePrice: 5000, houses: 2 } });
    expect(screen.queryByTestId('resale-sheet')).toBeNull();
  });
});

describe('Entry point: Auction Property on the property card', () => {
  it('my eligible property: the action is enabled and runs the same reserve-and-review flow', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI', { hotel: true });
    serveAs(f, 'Asha');
    await renderProperty(f, 'Asha', 'MUMBAI');
    expect(disabled('action-AUCTION_PROPERTY')).toBe(false);
    expect(screen.getByTestId('action-note-AUCTION_PROPERTY')).toHaveTextContent(/Sold with its hotel/);
    await fireEvent.press(screen.getByTestId('action-AUCTION_PROPERTY'));
    expect(screen.getByTestId('resale-bundle')).toHaveTextContent('Includes the hotel');
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '9000');
    await fireEvent.press(screen.getByTestId('resale-review'));
    await fireEvent.press(screen.getByTestId('resale-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 9000 }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/auction/${f.state.auction!.id}`));
    // The card now shows the listing, and offers the way to it — never a second listing.
    await waitFor(() => expect(screen.getByTestId('property-in-auction')).toBeTruthy());
    expect(screen.queryByTestId('action-AUCTION_PROPERTY')).toBeNull();
    expect(screen.getByTestId('property-auction-status')).toHaveTextContent(/Up for auction · reserve ₹9,000/);
    // Nothing was built, sold or removed by listing it.
    expect(screen.getByTestId('property-built')).toHaveTextContent(/Hotel$/);
  });

  it.each([
    ['mortgaged', (f: Fixture) => give(f, 'Asha', 'MUMBAI', { mortgaged: true }), /^Mortgaged — unmortgage it before auctioning it\.$/],
    [
      'pledged as loan collateral',
      (f: Fixture) => {
        give(f, 'Asha', 'MUMBAI');
        give(f, 'Asha', 'DELHI');
        const rate = offeredRate('SECURED', creditScoreOf(f.state.intermediate!, f.ids.Asha!)).ratePercent;
        f.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'SECURED', amount: 10000, collateralKeys: ['MUMBAI', 'DELHI'], expectedRatePercent: rate });
      },
      /^Pledged as loan collateral — repay that loan first\.$/,
    ],
  ] as [string, (f: Fixture) => void, RegExp][])('a %s property: the action is there, disabled, with the reason', async (_label, setup, reason) => {
    const f = game();
    setup(f);
    await renderProperty(f, 'Asha', 'MUMBAI');
    expect(disabled('action-AUCTION_PROPERTY')).toBe(true);
    expect(screen.getByTestId('action-note-AUCTION_PROPERTY')).toHaveTextContent(reason);
    await fireEvent.press(screen.getByTestId('action-AUCTION_PROPERTY'));
    expect(screen.queryByTestId('resale-sheet')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('not my turn: disabled, and the reason is mine to read', async () => {
    const f = game();
    give(f, 'Bilal', 'MUMBAI');
    await renderProperty(f, 'Bilal', 'MUMBAI');
    expect(disabled('action-AUCTION_PROPERTY')).toBe(true);
    expect(screen.getByTestId('action-note-AUCTION_PROPERTY')).toHaveTextContent('You can auction a property during your own turn.');
  });

  it('someone else’s property, an unowned one, and any property in a Classic game offer no auction action', async () => {
    const f = game();
    give(f, 'Bilal', 'MUMBAI');
    const other = await renderProperty(f, 'Asha', 'MUMBAI');
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Owned by Bilal');
    expect(screen.queryByTestId('action-AUCTION_PROPERTY')).toBeNull();
    await other.unmount();

    const bank = await renderProperty(f, 'Asha', 'RAILWAY');
    expect(screen.queryByTestId('action-AUCTION_PROPERTY')).toBeNull();
    await bank.unmount();

    const classic = game('classic');
    give(classic, 'Asha', 'MUMBAI');
    await renderProperty(classic, 'Asha', 'MUMBAI');
    expect(screen.getByTestId('action-MORTGAGE_PROPERTY')).toBeTruthy();
    expect(screen.queryByTestId('action-AUCTION_PROPERTY')).toBeNull();
    expect(screen.queryByTestId('property-auction-status')).toBeNull();
  });

  it('a refusal from the server stays in the dialog — nothing is shown as listed', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    api.action.mockResolvedValue({ ok: false, error: { code: 'AUCTION_NOT_ALLOWED', message: 'Mortgaged — unmortgage it before auctioning it.' } });
    await renderProperty(f, 'Asha', 'MUMBAI');
    await fireEvent.press(screen.getByTestId('action-AUCTION_PROPERTY'));
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '5000');
    await fireEvent.press(screen.getByTestId('resale-review'));
    await fireEvent.press(screen.getByTestId('resale-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('resale-dialog-error')).toHaveTextContent('Mortgaged — unmortgage it before auctioning it.'));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('property-in-auction')).toBeNull();
    expect(useGameStore.getState().snapshot!.state.auction).toBeNull();
  });

  it('a second tap while the request is in flight sends nothing more', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    let answer!: (value: ReturnType<typeof ok>) => void;
    api.action.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderProperty(f, 'Asha', 'MUMBAI');
    await fireEvent.press(screen.getByTestId('action-AUCTION_PROPERTY'));
    await fireEvent.changeText(screen.getByTestId('resale-reserve'), '5000');
    await fireEvent.press(screen.getByTestId('resale-review'));
    const confirm = () => screen.getByTestId('resale-dialog-confirm');
    // Not awaited: the press settles only when the request does.
    const first = fireEvent.press(confirm());
    await waitFor(() => expect(confirm().props.accessibilityState).toMatchObject({ busy: true }));
    await fireEvent.press(confirm());
    await fireEvent.press(confirm());
    await fireEvent.press(screen.getByTestId('resale-dialog-cancel'));
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('resale-dialog')).toBeTruthy(); // can't be dismissed mid-request
    f.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 5000 });
    await act(async () => answer(ok(f.snapshot())));
    await first;
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(api.action).toHaveBeenCalledTimes(1);
  });
});

describe('The auction screen during a resale', () => {
  it('a bidder sees the seller and the buildings that come with it, and the first bid is the reserve', async () => {
    const { f, auctionId } = listed({ houses: 2 });
    serveAs(f, 'Bilal');
    await renderAuction(f, 'Bilal', auctionId);
    expect(screen.getByTestId('auction-kind')).toHaveTextContent('Sold by Asha');
    expect(screen.getByTestId('auction-price-line')).toHaveTextContent('Bidding starts at ₹5,000');
    expect(screen.getByTestId('auction-bundle')).toHaveTextContent('Includes 2 houses');
    expect(screen.getByTestId('auction-resale')).toHaveTextContent(/Houses and hotel are included in the sale/);
    expect(screen.getByTestId('auction-countdown')).toBeTruthy();
    expect(screen.queryByTestId('auction-starting')).toBeNull();
    expect(screen.queryByTestId('cancel-auction')).toBeNull();
    // No ₹100 opening: bidding starts where the seller would actually sell.
    expect(screen.getByTestId('auction-minimum')).toHaveTextContent('Minimum next bid ₹5,000');
    expect(screen.queryByText('BID ₹100')).toBeNull();
    expect(screen.getByText('BID ₹5,000')).toBeTruthy();
    expect(screen.getByText('BID ₹5,500')).toBeTruthy();
    expect(screen.getByText('BID ₹6,000')).toBeTruthy();
    expect(disabled('bid-button')).toBe(false);
    expect(screen.getByTestId('pass-button')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('bid-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PLACE_BID', auctionId, amount: 5000 }));
    // The first bid already buys it unless someone outbids it.
    await waitFor(() => expect(screen.getByText('You’re winning! 🎉')).toBeTruthy());
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹5,000');
    expect(screen.queryByTestId('bid-button')).toBeNull();
  });

  it('get ready: a 3-2-1 before bidding opens — the buttons are in place but not live — then the usual countdown', async () => {
    const { f, auctionId } = listed({}, RESERVE, false);
    await renderAuction(f, 'Bilal', auctionId);
    expect(screen.getByTestId('auction-starting')).toHaveTextContent(/Get ready · bidding starts in/i);
    expect(screen.getByTestId('auction-starting-count')).toHaveTextContent(/^[123]$/);
    expect(screen.queryByTestId('auction-countdown')).toBeNull();
    expect(screen.getByTestId('auction-minimum')).toHaveTextContent('Bidding opens at ₹5,000');
    expect(disabled('bid-button')).toBe(true);
    expect(disabled('bid-button-1')).toBe(true);
    await fireEvent.press(screen.getByTestId('bid-button'));
    expect(api.action).not.toHaveBeenCalled();
    // Passing needs no countdown.
    expect(disabled('pass-button')).toBe(false);

    // The get-ready is over (a newer snapshot from the server shows it): the bidding clock and live buttons take its place.
    openBidding(f);
    pass(f, 'Chitra');
    await arrive(f);
    expect(screen.queryByTestId('auction-starting')).toBeNull();
    expect(screen.getByTestId('auction-countdown')).toBeTruthy();
    expect(screen.getByTestId('auction-minimum')).toHaveTextContent('Minimum next bid ₹5,000');
    expect(disabled('bid-button')).toBe(false);
  });

  it('the bank’s auction has no get-ready: bidding is live at once', async () => {
    const f = game();
    f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    await renderAuction(f, 'Bilal', f.state.auction!.id);
    expect(screen.queryByTestId('auction-starting')).toBeNull();
    expect(screen.getByTestId('auction-countdown')).toBeTruthy();
    expect(disabled('bid-button')).toBe(false);
  });

  it('the seller sees their own auction — no bid or pass buttons — and can cancel until the first bid', async () => {
    const { f, auctionId } = listed({ hotel: true });
    serveAs(f, 'Asha');
    await renderAuction(f, 'Asha', auctionId);
    expect(screen.getByTestId('auction-kind')).toHaveTextContent('Sold by you');
    expect(screen.getByTestId('auction-bundle')).toHaveTextContent('Includes the hotel');
    expect(screen.getByTestId('auction-seller-status')).toHaveTextContent(/Waiting for bids at ₹5,000/);
    expect(screen.queryByTestId('bid-button')).toBeNull();
    expect(screen.queryByTestId('pass-button')).toBeNull();
    expect(screen.queryByText('You passed. Watching…')).toBeNull();
    expect(disabled('cancel-auction')).toBe(false);
    await fireEvent.press(screen.getByTestId('cancel-auction'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'CANCEL_AUCTION', auctionId }));
    await waitFor(() => expect(screen.getByTestId('auction-result-text')).toHaveTextContent('Cancelled — stays with Asha'));
    expect(screen.getByText('CANCELLED')).toBeTruthy();
    expect(screen.queryByTestId('cancel-auction')).toBeNull();
    expect(f.state.properties.MUMBAI).toMatchObject({ ownerId: f.ids.Asha, hotel: true });
  });

  it('once a bid is in, the seller’s cancel is disabled and says why', async () => {
    const { f, auctionId } = listed();
    bid(f, 'Bilal', RESERVE);
    await renderAuction(f, 'Asha', auctionId);
    expect(disabled('cancel-auction')).toBe(true);
    expect(screen.getByTestId('cancel-auction-note')).toHaveTextContent('Bidding has started — the auction can no longer be cancelled.');
    expect(screen.getByTestId('auction-seller-status')).toHaveTextContent(/sells to the highest bidder/);
    await fireEvent.press(screen.getByTestId('cancel-auction'));
    expect(api.action).not.toHaveBeenCalled();
  });

  it('bids and the result arrive from the server and replace what is on screen', async () => {
    const { f, auctionId } = listed({ houses: 1 });
    await renderAuction(f, 'Chitra', auctionId);
    expect(screen.getByTestId('current-bid')).toHaveTextContent('—');
    bid(f, 'Bilal', 6000);
    await arrive(f);
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹6,000');
    expect(screen.getByText('BID ₹6,100')).toBeTruthy();
    pass(f, 'Chitra');
    await arrive(f);
    expect(screen.getByText('SOLD')).toBeTruthy();
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent('Sold to Bilal');
    expect(screen.getByTestId('auction-bundle')).toHaveTextContent('Includes 1 house');
    expect(screen.queryByTestId('bid-button')).toBeNull();
    // A watcher is not the buyer: no insurance is offered to them.
    expect(screen.queryByTestId('auction-insure-offer')).toBeNull();
  });

  it('the leader at or above the reserve is simply winning', async () => {
    const { f, auctionId } = listed();
    bid(f, 'Bilal', 6000);
    await renderAuction(f, 'Bilal', auctionId);
    expect(screen.getByText('You’re winning! 🎉')).toBeTruthy();
    expect(screen.queryByTestId('bid-button')).toBeNull();
    expect(screen.queryByTestId('raise-to-reserve')).toBeNull();
  });

  it('ends without a sale when nobody bids — by the deadline or by everyone passing — and says who keeps it', async () => {
    const timedOut = listed();
    // Nobody bid by the deadline: the server closes it unsold.
    timedOut.f.state.auction!.endsAt = new Date(Date.now() - 60_000).toISOString();
    timedOut.f.act('Chitra', { type: 'CLOSE_AUCTION', auctionId: timedOut.auctionId });
    const first = await renderAuction(timedOut.f, 'Bilal', timedOut.auctionId);
    expect(screen.getByText('NOT SOLD')).toBeTruthy();
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent('No sale — stays with Asha');
    await first.unmount();

    const none = listed();
    pass(none.f, 'Bilal');
    pass(none.f, 'Chitra');
    await renderAuction(none.f, 'Asha', none.auctionId);
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent('No sale — stays with Asha');
    expect(none.f.state.properties.MUMBAI.ownerId).toBe(none.f.ids.Asha);
  });

  it('the seller waits through the get-ready too, and can still cancel during it', async () => {
    const { f, auctionId } = listed({}, RESERVE, false);
    serveAs(f, 'Asha');
    await renderAuction(f, 'Asha', auctionId);
    expect(screen.getByTestId('auction-starting')).toBeTruthy();
    expect(screen.getByTestId('auction-seller-status')).toHaveTextContent(/Bidding is about to open at ₹5,000/);
    await fireEvent.press(screen.getByTestId('cancel-auction'));
    await waitFor(() => expect(screen.getByTestId('auction-result-text')).toHaveTextContent('Cancelled — stays with Asha'));
  });

  it('the buyer is offered insurance for their new property — optional, through the ordinary purchase', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI', { houses: 2 });
    f.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 });
    f.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    const auctionId = f.state.auction!.id;
    bid(f, 'Bilal', 6000);
    pass(f, 'Chitra');
    serveAs(f, 'Bilal');
    const result = await renderAuction(f, 'Bilal', auctionId);
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent('Sold to Bilal');
    expect(screen.getByTestId('auction-insure-offer')).toHaveTextContent(/The seller’s insurance ended with the sale/);
    // Nothing was bought for them, and nothing is required of them.
    expect(f.state.intermediate!.insurance!.policies.map((p) => p.status)).toEqual(['EXPIRED']);
    await fireEvent.press(screen.getByTestId('insure-MUMBAI'));
    await fireEvent.press(screen.getByTestId('insure-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 }));
    expect(f.state.intermediate!.insurance!.policies.at(-1)).toMatchObject({ ownerId: f.ids.Bilal, status: 'ACTIVE' });
    await result.unmount();

    // The same offer on the property card: the new owner's deed, with every house that came with it.
    await renderProperty(f, 'Bilal', 'MUMBAI');
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Owned by Bilal');
    expect(screen.getByTestId('property-built')).toHaveTextContent(/2 houses$/);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured');
  });

  it('the new owner who declines insurance just owns an uninsured property; the seller keeps nothing of it', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    f.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 });
    f.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: RESERVE });
    bid(f, 'Bilal', 6000);
    pass(f, 'Chitra');
    const buyer = await renderProperty(f, 'Bilal', 'MUMBAI');
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Not insured');
    expect(screen.getByTestId('insurance-policy-state')).toHaveTextContent(/None$/);
    expect(screen.getByTestId('insure-MUMBAI')).toBeTruthy();
    await buyer.unmount();
    await renderProperty(f, 'Asha', 'MUMBAI');
    expect(screen.getByTestId('property-owner')).toHaveTextContent('Owned by Bilal');
    expect(screen.queryByTestId('property-manage')).toBeNull();
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
  });

  it('a stale auction link in a Capital game offers the way to the running one, or to start one', async () => {
    const { f, auctionId } = listed();
    await renderAuction(f, 'Bilal', '00000000-0000-4000-8000-00000000dead');
    expect(screen.getByText('An auction is running')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('go-to-live-auction'));
    expect(router.replace).toHaveBeenCalledWith(`/auction/${auctionId}`);
  });
});

describe('No regressions for the bank’s auction', () => {
  it('an unowned property’s auction reads exactly as before, in both modes', async () => {
    for (const mode of ['classic', 'intermediate'] as const) {
      const f = game(mode);
      f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
      const view = await renderAuction(f, 'Bilal', f.state.auction!.id);
      expect(screen.getByTestId('auction-kind')).toHaveTextContent('Auction');
      expect(screen.getByTestId('auction-price-line')).toHaveTextContent(/^List price ₹/);
      expect(screen.queryByTestId('auction-resale')).toBeNull();
      expect(screen.queryByTestId('cancel-auction')).toBeNull();
      expect(screen.getByText('BID ₹100')).toBeTruthy();
      expect(screen.getByText('BID ₹600')).toBeTruthy();
      expect(screen.getByText('BID ₹1,100')).toBeTruthy();
      expect(screen.getByTestId('pass-button')).toBeTruthy();
      await view.unmount();
    }
  });

  it('a Classic game’s finished auction offers nothing new', async () => {
    const f = game('classic');
    f.loadAs('Asha');
    await render(<Live>{(v) => <AuctionView view={v} auctionId={NEW_AUCTION} />}</Live>);
    expect(screen.getByTestId('auction-back')).toBeTruthy();
    expect(screen.getByTestId('auction-idle-status')).toHaveTextContent(/No auction running/);
    expect(screen.getByTestId('auction-idle-status')).toHaveTextContent(/declines a property they land on\.$/);
    expect(screen.queryByTestId('resale-picker')).toBeNull();
    await fireEvent.press(screen.getByTestId('auction-back'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('the one result line: the bank’s auctions as before, a resale naming who keeps the property', () => {
    const players = [
      { id: 'a', name: 'Asha' },
      { id: 'b', name: 'Bilal' },
    ];
    const terms = { sellerId: 'a', reservePrice: 5000, houses: 0, hotel: false, resumePhase: 'AWAITING_ROLL' as const };
    expect(auctionResult({ winnerId: null }, players)).toEqual({ sold: false, text: 'Unsold — stays with the bank' });
    expect(auctionResult({ winnerId: 'b' }, players)).toEqual({ sold: true, text: 'Sold to Bilal' });
    expect(auctionResultHeading({ winnerId: null })).toBe('CLOSED');
    expect(auctionResultHeading({ winnerId: 'b' })).toBe('SOLD');
    expect(auctionResultHeading({ winnerId: null, resale: { ...terms, outcome: 'UNSOLD' } })).toBe('NOT SOLD');
    expect(auctionResult({ winnerId: 'zz' }, players)).toMatchObject({ sold: true, text: 'Property sold' });
    expect(auctionResult({ winnerId: 'b', highBid: 6000, resale: { ...terms, outcome: 'SOLD' } }, players).text).toBe('Sold to Bilal');
    expect(auctionResult({ winnerId: null, highBid: 4000, resale: { ...terms, outcome: 'UNSOLD' } }, players).text).toBe('Reserve not met — stays with Asha');
    expect(auctionResult({ winnerId: null, highBid: null, resale: { ...terms, outcome: 'UNSOLD' } }, players).text).toBe('No sale — stays with Asha');
    expect(auctionResult({ winnerId: null, highBid: null, resale: { ...terms, outcome: 'CANCELLED' } }, players).text).toBe('Cancelled — stays with Asha');
    expect(auctionResultHeading({ winnerId: null, resale: { ...terms, outcome: 'CANCELLED' } })).toBe('CANCELLED');
  });
});
