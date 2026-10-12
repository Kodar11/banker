/// <reference types="jest" />
/**
 * A bid the server refused because someone else's got in first (STALE_STATE). The phone never shows
 * it as placed: it reads the game again, shows what the server holds — the other player's bid, under
 * their name — says so in words, and leaves the buttons ready for the next bid.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { NoticeToast } from '@/components/ui';
import { AuctionView, staleBidMessage } from '@/features/auction/AuctionView';
import { useGameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const STALE = { ok: false as const, error: { code: 'STALE_STATE' as const, message: 'The game just changed — check the screen and try again.' } };

/** The auction screen as the app mounts it: the view comes from the stores, so a refreshed snapshot shows. */
function Auction({ auctionId }: { auctionId: string }) {
  const view = useGameView();
  return view ? (
    <>
      <AuctionView view={view} auctionId={auctionId} />
      <NoticeToast />
    </>
  ) : null;
}

/** Asha declined Railway: an auction both may bid in, as seen from Bilal's phone. */
function openAuction(names = ['Asha', 'Bilal']) {
  const f = new Fixture(names);
  f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' }).loadAs('Bilal');
  return { f, auctionId: f.state.auction!.id };
}

const balanceOf = (f: Fixture, name: string) => f.state.players.find((p) => p.name === name)!.balance;

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('a bid that lost the race', () => {
  it('is not shown as placed: the screen shows the other player’s bid under their name, says so, and the next bid goes through', async () => {
    const { f, auctionId } = openAuction();
    const seen = f.state.version;
    await render(<Auction auctionId={auctionId} />);
    expect(screen.getByText('BID ₹100')).toBeTruthy();

    // Asha's ₹100 reaches the server first; Bilal's phone has not heard of it when he taps.
    f.act('Asha', { type: 'PLACE_BID', auctionId, amount: 100 });
    api.action.mockResolvedValueOnce(STALE);
    api.state.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('bid-button'));

    expect(await screen.findByText('Asha bid ₹100 first, so your bid was not placed. Bid ₹200 or more to lead.')).toBeTruthy();
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![2]).toBe(seen);
    // Reconciled with the server, not with the tap.
    expect(api.state).toHaveBeenCalled();
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹100');
    expect(screen.getByText('Highest bid · Asha')).toBeTruthy();
    expect(screen.queryByText('You’re winning! 🎉')).toBeNull();
    expect(screen.queryByText(STALE.error.message)).toBeNull();

    // Still in the auction, with the buttons at the new minimum.
    expect(screen.getByTestId('auction-minimum')).toHaveTextContent('Minimum next bid ₹200');
    f.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 200 });
    api.action.mockResolvedValueOnce(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('bid-button'));
    await waitFor(() => expect(screen.getByText('You’re winning! 🎉')).toBeTruthy());
    expect(api.action).toHaveBeenCalledTimes(2);
    expect(api.action.mock.calls[1]![2]).toBe(seen + 1);
    expect(api.action.mock.calls[1]![3]).toEqual({ type: 'PLACE_BID', auctionId, amount: 200 });
    expect(api.action.mock.calls[1]![1]).not.toBe(api.action.mock.calls[0]![1]); // a new action, not a resend
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹200');
    expect(screen.getByText('Highest bid · Bilal')).toBeTruthy();
  });

  it('an accepted bid is shown under the bidder’s own name', async () => {
    const { f, auctionId } = openAuction();
    await render(<Auction auctionId={auctionId} />);
    f.act('Bilal', { type: 'PLACE_BID', auctionId, amount: 100 });
    api.action.mockResolvedValueOnce(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('bid-button'));
    await waitFor(() => expect(screen.getByText('Highest bid · Bilal')).toBeTruthy());
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹100');
    expect(api.state).not.toHaveBeenCalled();
  });

  it('refused after the auction ended: the result is the server’s, and the late bidder paid nothing', async () => {
    const { f, auctionId } = openAuction();
    const before = balanceOf(f, 'Bilal');
    await render(<Auction auctionId={auctionId} />);

    // Asha bids, the countdown runs out and the server closes — all before Bilal's tap arrives.
    f.act('Asha', { type: 'PLACE_BID', auctionId, amount: 100 });
    f.state.auction!.endsAt = new Date(Date.now() - 10_000).toISOString();
    f.act('Asha', { type: 'CLOSE_AUCTION', auctionId });
    api.action.mockResolvedValueOnce(STALE);
    api.state.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('bid-button'));

    expect(await screen.findByText('The auction ended before your bid was accepted. Sold to Asha.')).toBeTruthy();
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent('Sold to Asha');
    expect(screen.queryByTestId('bid-button')).toBeNull();
    expect(f.state.auction).toMatchObject({ status: 'CLOSED', winnerId: f.ids.Asha, highBid: 100 });
    expect(balanceOf(f, 'Bilal')).toBe(before);
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('other refusals keep the server’s own words', async () => {
    const { auctionId } = openAuction();
    await render(<Auction auctionId={auctionId} />);
    api.action.mockResolvedValueOnce({ ok: false, error: { code: 'AUCTION_CLOSED', message: 'Bidding has ended.' } });
    await fireEvent.press(screen.getByTestId('bid-button'));
    expect(await screen.findByText('Bidding has ended.')).toBeTruthy();
    expect(api.state).not.toHaveBeenCalled();
  });
});

describe('staleBidMessage says only what the state shows', () => {
  it('names the bid that got in first and the next minimum', () => {
    const { f, auctionId } = openAuction();
    f.act('Asha', { type: 'PLACE_BID', auctionId, amount: 600 });
    expect(staleBidMessage(f.state, auctionId, f.ids.Bilal!)).toBe('Asha bid ₹600 first, so your bid was not placed. Bid ₹700 or more to lead.');
  });

  it('offers no next bid to a player who cannot make one', () => {
    const { f, auctionId } = openAuction();
    f.act('Asha', { type: 'PLACE_BID', auctionId, amount: 600 });
    f.state.players.find((p) => p.name === 'Bilal')!.balance = 650;
    expect(staleBidMessage(f.state, auctionId, f.ids.Bilal!)).toBe('Asha bid ₹600 first, so your bid was not placed.');
  });

  it('names nobody when the game changed for another reason', () => {
    const { f, auctionId } = openAuction(['Asha', 'Bilal', 'Chitra']);
    f.act('Chitra', { type: 'PASS_AUCTION', auctionId });
    expect(staleBidMessage(f.state, auctionId, f.ids.Bilal!)).toBe('The auction changed before your bid was accepted, so it was not placed. Check the screen and bid again.');
  });

  it('claims no winner for an auction that closed unsold, or that is gone', () => {
    const { f, auctionId } = openAuction();
    f.state.auction!.endsAt = new Date(Date.now() - 10_000).toISOString();
    f.act('Asha', { type: 'CLOSE_AUCTION', auctionId });
    expect(staleBidMessage(f.state, auctionId, f.ids.Bilal!)).toBe('The auction ended before your bid was accepted. Unsold — stays with the bank.');
    expect(staleBidMessage({ ...f.state, auction: null }, auctionId, f.ids.Bilal!)).toBe('The auction ended before your bid was accepted.');
  });
});
