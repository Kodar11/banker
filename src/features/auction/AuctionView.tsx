import { goBack } from '@/utils/navigation';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { auctionAcceptUntil, auctionOpensAt, getDeed, insuranceOf, isIntermediate, minimumNextBid, type AuctionState, type PlayerState } from '@/engine/index.ts';
import { Button, Card, ConnectionBanner, Label, Screen } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { InsureButton } from '@/features/insurance/PropertyInsurance';
import { serverNow } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { bundleLabel, ResalePicker } from './ResaleAuction';

/** The auction route opened with no auction in mind: the place a player starts one of their own (Intermediate Mode). */
export const NEW_AUCTION = 'new';

/** Longest the countdown goes without re-reading the clock (picks up a corrected server-clock estimate). */
const MAX_TICK_MS = 250;

/** Whole seconds shown for `ms` left: rounded up, so the last second reads 1 until the deadline itself. */
const wholeSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Where the auction stands against its server deadline. Nothing here counts ticks: both values are
 * recomputed from the persisted deadline and the server clock every time, so a remount, a
 * reconnect or a late update can't restart or shift the countdown. The timer only decides when to
 * look again, and wakes right on each whole-second boundary so every phone flips together.
 * Display only — the server decides.
 */
function useAuctionClock(endsAt: string | null, closeAt: number | null): { secondsLeft: number; closeDue: boolean } {
  const read = () => {
    const now = serverNow();
    return { secondsLeft: endsAt ? wholeSeconds(Date.parse(endsAt) - now) : 0, closeDue: closeAt !== null && now >= closeAt };
  };
  const [clock, setClock] = useState(read);
  const [seen, setSeen] = useState({ endsAt, closeAt });
  if (seen.endsAt !== endsAt || seen.closeAt !== closeAt) {
    // A new deadline from the server (a bid was accepted): show it at once, not at the next tick.
    setSeen({ endsAt, closeAt });
    setClock(read());
  }
  useEffect(() => {
    if (!endsAt) return;
    const deadline = Date.parse(endsAt);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = serverNow();
      const left = deadline - now;
      const secondsLeft = wholeSeconds(left);
      const closeDue = closeAt !== null && now >= closeAt;
      setClock((prev) => (prev.secondsLeft === secondsLeft && prev.closeDue === closeDue ? prev : { secondsLeft, closeDue }));
      if (closeDue) return;
      // Next change: the countdown's next whole second, or (once it shows zero) the close.
      const next = left > 0 ? left - (secondsLeft - 1) * 1000 : (closeAt ?? now) - now;
      timer = setTimeout(tick, Math.min(MAX_TICK_MS, Math.max(1, next)));
    };
    tick();
    return () => clearTimeout(timer);
  }, [endsAt, closeAt]);
  return clock;
}

const MAX_CLOSE_ATTEMPTS = 5;

/**
 * The one result line of a closed auction, the same on every phone: from the server's winner id and
 * the player list of the same snapshot. Never a local guess — if the winner can't be named yet, the
 * sale is still reported, without a name. A player's own auction (a resale) says who keeps the
 * property and why: cancelled, no bids, or the reserve was not reached.
 */
export function auctionResult(
  auction: Pick<AuctionState, 'winnerId'> & Partial<Pick<AuctionState, 'resale' | 'highBid'>>,
  players: readonly Pick<PlayerState, 'id' | 'name'>[],
): { sold: boolean; text: string } {
  const nameOf = (id: string | null) => players.find((p) => p.id === id)?.name.trim() || null;
  if (auction.winnerId !== null) {
    const name = nameOf(auction.winnerId);
    return { sold: true, text: name ? `Sold to ${name}` : 'Property sold' };
  }
  const resale = auction.resale;
  if (!resale) return { sold: false, text: 'Unsold — stays with the bank' };
  const keeper = `stays with ${nameOf(resale.sellerId) ?? 'its owner'}`;
  if (resale.outcome === 'CANCELLED') return { sold: false, text: `Cancelled — ${keeper}` };
  const short = auction.highBid != null && auction.highBid < resale.reservePrice;
  return { sold: false, text: `${short ? 'Reserve not met' : 'No sale'} — ${keeper}` };
}

/** The one big word over that line: SOLD or CLOSED as always; a player's own auction says CANCELLED or NOT SOLD. */
export function auctionResultHeading(auction: Pick<AuctionState, 'winnerId'> & Partial<Pick<AuctionState, 'resale'>>): string {
  if (auction.winnerId !== null) return 'SOLD';
  if (!auction.resale) return 'CLOSED';
  return auction.resale.outcome === 'CANCELLED' ? 'CANCELLED' : 'NOT SOLD';
}

/**
 * The auction screen with no auction on it: what is (not) happening, and — in Intermediate Mode —
 * the place a player puts one of their own properties up for sale. Laid out like the app's other
 * secondary screens: a quiet way back at the top, then cards.
 */
function AuctionIdle({ view, auctionId }: { view: GameView; auctionId: string }) {
  const { state } = view.snapshot;
  const running = state.auction?.status === 'OPEN' ? state.auction : null;
  const intermediate = isIntermediate(state);
  const canList = intermediate && state.status === 'ACTIVE' && view.me?.status === 'ACTIVE';
  const title = running ? 'An auction is running' : auctionId === NEW_AUCTION ? 'No auction running' : 'This auction is over.';
  const detail = running
    ? `${getDeed(running.propertyKey).name} is up for bids right now.`
    : intermediate
      ? 'One opens when a player declines a property they land on — or puts one of their own up for sale.'
      : 'One opens when a player declines a property they land on.';
  return (
    <Screen scroll testID="auction-idle">
      <Button size="sm" variant="ghost" title="‹ Back" testID="auction-back" onPress={() => goBack(`/game/${state.id}`)} className="self-start" />
      <Card testID="auction-idle-status">
        <Label>Auctions</Label>
        <View className="mt-2 flex-row items-center gap-3">
          <View className={`h-12 w-12 items-center justify-center rounded-2xl ${running ? 'bg-saffron' : 'bg-stone-200'}`}>
            <Text className="text-2xl">🔨</Text>
          </View>
          <View className="flex-1">
            <Text className="text-xl font-black text-ink">{title}</Text>
            <Text className="text-sm leading-5 text-stone-600">{detail}</Text>
          </View>
        </View>
        {running ? (
          <Button className="mt-4" size="md" title="Go to the auction" testID="go-to-live-auction" onPress={() => router.replace(`/auction/${running.id}`)} />
        ) : null}
      </Card>
      {canList ? <ResalePicker view={view} onCreated={(id) => router.replace(`/auction/${id}`)} /> : null}
    </Screen>
  );
}

export function AuctionView({ view, auctionId }: { view: GameView; auctionId: string }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const { state } = view.snapshot;
  const auction = state.auction?.id === auctionId ? state.auction : null;
  const resale = auction?.resale ?? null;
  // The buyer of a player's property is offered insurance for it here, so the result stays until they leave it.
  const offerInsurance =
    !!auction && auction.status === 'CLOSED' && resale?.outcome === 'SOLD' && auction.winnerId === view.me?.id && !!insuranceOf(state) && state.properties[auction.propertyKey].ownerId === view.me?.id;
  const endsAt = auction?.endsAt ?? null;
  const liveAuctionId = auction?.id ?? null;
  const open = auction?.status === 'OPEN' && state.status === 'ACTIVE';
  // When the server will agree to close: a moment after the countdown ends. Never shown.
  const { secondsLeft, closeDue } = useAuctionClock(open ? endsAt : null, open && auction ? auctionAcceptUntil(auction) : null);
  // A player's own auction opens with a short "get ready": no bid counts before this instant on the server's clock.
  const opensAt = open && auction && resale && auction.highBid === null ? auctionOpensAt(auction) : null;
  const startsIn = useAuctionClock(opensAt === null ? null : new Date(opensAt).toISOString(), opensAt).secondsLeft;
  const starting = opensAt !== null && startsIn > 0;
  // Close attempts per deadline: a new deadline (someone bid) re-arms the automatic close.
  const [attempts, setAttempts] = useState<{ endsAt: string | null; n: number }>({ endsAt: null, n: 0 });
  const closeAttempt = attempts.endsAt === endsAt ? attempts.n : 0;

  const expired = open && secondsLeft === 0;

  // The server closes the auction itself when the deadline passes. As a backstop, any device
  // watching may also ask; the server checks its own clock and closes exactly once (others get
  // AUCTION_CLOSED). If it says "still running" (clock skew, or a last-moment bid got in) or the
  // request didn't go through, try again shortly — until the realtime update arrives.
  useEffect(() => {
    if (!expired || !closeDue || !liveAuctionId || closeAttempt >= MAX_CLOSE_ATTEMPTS) return;
    let cancelled = false;
    const delay = closeAttempt === 0 ? (view.me?.seat ?? 0) * 300 : 1000;
    const t = setTimeout(async () => {
      const res = await send({ type: 'CLOSE_AUCTION', auctionId: liveAuctionId }, { silent: true });
      if (!cancelled && !res.ok && res.error.code !== 'AUCTION_CLOSED') setAttempts({ endsAt, n: closeAttempt + 1 });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [expired, closeDue, liveAuctionId, endsAt, closeAttempt, send, view.me?.seat]);

  useEffect(() => {
    if (auction && auction.status === 'CLOSED' && !offerInsurance) {
      // Go BACK to the game screen that opened this auction. Replacing this route with a new
      // /game screen left the old one mounted underneath: every auction added another live game
      // screen (board, animations, and its own "open the auction" push).
      const t = setTimeout(() => goBack(`/game/${state.id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [auction, state.id, offerInsurance]);

  if (!auction) return <AuctionIdle view={view} auctionId={auctionId} />;

  const deed = getDeed(auction.propertyKey);
  const me = view.me;
  const min = minimumNextBid(auction);
  const amIn = !!me && auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id);
  const leading = !!me && auction.highBidderId === me.id;
  const groupTheme = PROPERTY_GROUP_THEME[deed.group];
  const isSeller = !!me && resale?.sellerId === me.id;
  const bids = [min, min + 500, min + 1000].filter((b) => !!me && b <= me.balance);
  const result = auctionResult(auction, state.players);

  return (
    <Screen scroll testID="auction-screen">
      <ConnectionBanner />
      <Card className="overflow-hidden p-0">
        <View style={{ backgroundColor: groupTheme.color }} className="items-center px-4 py-4" testID="auction-deed-header">
          <Text style={{ color: groupTheme.onColor }} className="text-xs font-extrabold uppercase tracking-[4px] opacity-80" testID="auction-kind">
            {resale ? `Sold by ${isSeller ? 'you' : view.playerName(resale.sellerId)}` : 'Auction'}
          </Text>
          <Text style={{ color: groupTheme.onColor }} className="text-3xl font-black">{deed.name}</Text>
          <Text style={{ color: groupTheme.onColor }} className="text-sm font-semibold opacity-80" testID="auction-price-line">
            {resale ? `Bidding starts at ${formatINR(resale.reservePrice)}` : `List price ${formatINR(deed.price)}`}
          </Text>
        </View>
        {resale ? (
          <View className="gap-1 border-b border-stone-200 px-5 py-3" testID="auction-resale">
            {/* The property and what is built on it are one lot: what is listed here is what the winner gets. */}
            <Text className="text-base font-extrabold text-ink" testID="auction-bundle">
              {bundleLabel(resale)}
            </Text>
            {resale.hotel || resale.houses > 0 ? (
              <Text className="text-xs leading-4 text-stone-600">Houses and hotel are included in the sale — the winning bid is the whole price.</Text>
            ) : null}
          </View>
        ) : null}
        <View className="items-center gap-1 p-5">
          <Label className="self-stretch text-center">{auction.highBid === null ? 'No bids yet' : `Highest bid · ${view.playerName(auction.highBidderId)}`}</Label>
          <Text className="text-hero text-ink" testID="current-bid">
            {auction.highBid === null ? '—' : formatINR(auction.highBid)}
          </Text>
          {open && starting ? (
            <View className="mt-2 items-center" testID="auction-starting" accessibilityLiveRegion="polite" accessibilityLabel={`Bidding starts in ${startsIn} seconds`}>
              <Text className="text-xs font-extrabold uppercase tracking-widest text-stone-500">Get ready · bidding starts in</Text>
              <Text className="text-6xl font-black text-saffron-dark" testID="auction-starting-count">
                {startsIn}
              </Text>
            </View>
          ) : open ? (
            <View
              className="mt-2 items-center"
              testID="auction-timer"
              accessibilityLiveRegion="polite"
              accessibilityLabel={expired ? 'Bidding closed' : `${secondsLeft} seconds left`}
            >
              {expired ? (
                <Text className="text-4xl font-black text-brick" testID="auction-countdown">
                  CLOSING…
                </Text>
              ) : (
                <>
                  <Text className={`text-6xl font-black ${secondsLeft <= 3 ? 'text-brick' : 'text-ink'}`} testID="auction-countdown">
                    {secondsLeft}
                  </Text>
                  <Text className="text-xs font-extrabold uppercase tracking-widest text-stone-500">
                    {secondsLeft === 1 ? 'second left' : 'seconds left'}
                  </Text>
                </>
              )}
            </View>
          ) : (
            <View className="mt-2 items-center gap-2 self-stretch" testID="auction-result">
              <Text className={`text-4xl font-black ${result.sold ? 'text-green-700' : 'text-stone-600'}`}>{auctionResultHeading(auction)}</Text>
              {/* Full width, centred: a shrink-wrapped line can lose its last word (the name) on Android. */}
              <View className={`self-stretch rounded-full px-3 py-1.5 ${result.sold ? 'bg-green-100' : 'bg-stone-200'}`}>
                <Text testID="auction-result-text" className={`text-center text-sm font-extrabold ${result.sold ? 'text-green-800' : 'text-stone-700'}`}>
                  {result.text}
                </Text>
              </View>
            </View>
          )}
        </View>
      </Card>

      {offerInsurance ? (
        <Card className="gap-2" testID="auction-insure-offer">
          <Text className="text-lg font-extrabold text-ink">{deed.name} is yours</Text>
          <Text className="text-sm text-stone-600">
            The seller’s insurance ended with the sale and did not come with it. You can insure it now, or any time later from its property card — or not at all.
          </Text>
          <InsureButton view={view} propertyKey={auction.propertyKey} />
        </Card>
      ) : null}
      {open && isSeller ? (
        <Card className="gap-2" testID="auction-seller">
          <Text className="text-lg font-extrabold text-ink">Your auction</Text>
          <Text className="text-sm text-stone-600" testID="auction-seller-status">
            {auction.highBid === null
              ? `${starting ? 'Bidding is about to open' : 'Waiting for bids'} at ${formatINR(min)}. You can’t bid on your own property; you may cancel until the first bid arrives.`
              : 'It sells to the highest bidder when the countdown ends.'}
          </Text>
          <Button
            title="Cancel auction"
            variant="outline"
            size="md"
            testID="cancel-auction"
            disabled={auction.highBid !== null || !!pending}
            loading={pending === 'CANCEL_AUCTION'}
            onPress={() => send({ type: 'CANCEL_AUCTION', auctionId: auction.id })}
          />
          {auction.highBid !== null ? (
            <Text className="text-center text-xs font-semibold text-stone-600" testID="cancel-auction-note">
              Bidding has started — the auction can no longer be cancelled.
            </Text>
          ) : null}
        </Card>
      ) : null}
      {open && !expired && amIn && !leading ? (
        <View className="gap-3">
          <Text className="text-center text-sm font-semibold text-cream/80" testID="auction-minimum">
            {starting ? `Bidding opens at ${formatINR(min)}` : `Minimum next bid ${formatINR(min)}`}
          </Text>
          {bids.length === 0 ? <Text className="text-center text-base font-bold text-amber-300">Not enough money to bid.</Text> : null}
          {/* During the "get ready" the buttons are already in place — and not yet live. */}
          {bids.map((amount, i) => (
            <Button
              key={amount}
              title={`BID ${formatINR(amount)}`}
              size={i === 0 ? 'lg' : 'md'}
              variant={i === 0 ? 'primary' : 'secondary'}
              testID={i === 0 ? 'bid-button' : `bid-button-${i}`}
              disabled={!!pending || starting}
              loading={pending === 'PLACE_BID' && i === 0}
              onPress={() => send({ type: 'PLACE_BID', auctionId: auction.id, amount })}
            />
          ))}
          <Button
            title="PASS"
            variant="ghost"
            size="md"
            testID="pass-button"
            disabled={!!pending}
            onPress={() => send({ type: 'PASS_AUCTION', auctionId: auction.id })}
          />
        </View>
      ) : null}
      {open && leading ? (
        <Card className="items-center bg-green-50">
          <Text className="text-2xl font-black text-green-800">You’re winning! 🎉</Text>
          <Text className="text-sm text-stone-600">Wait for others to bid or pass.</Text>
        </Card>
      ) : null}
      {open && !amIn && !leading && !isSeller ? (
        <Card className="items-center">
          <Text className="text-lg font-bold text-ink">You passed. Watching…</Text>
        </Card>
      ) : null}
      <Button variant="ghost" size="sm" title="Back to game" onPress={() => goBack(`/game/${state.id}`)} />
    </Screen>
  );
}
