import { goBack } from '@/utils/navigation';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { auctionAcceptUntil, getDeed, minimumNextBid, type AuctionState, type PlayerState } from '@/engine/index.ts';
import { Button, Card, ConnectionBanner, Label, Screen } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { serverNow } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

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
 * sale is still reported, without a name.
 */
export function auctionResult(auction: Pick<AuctionState, 'winnerId'>, players: readonly Pick<PlayerState, 'id' | 'name'>[]): { sold: boolean; text: string } {
  if (auction.winnerId === null) return { sold: false, text: 'Unsold — stays with the bank' };
  const name = players.find((p) => p.id === auction.winnerId)?.name.trim();
  return { sold: true, text: name ? `Sold to ${name}` : 'Property sold' };
}

export function AuctionView({ view, auctionId }: { view: GameView; auctionId: string }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const { state } = view.snapshot;
  const auction = state.auction?.id === auctionId ? state.auction : null;
  const endsAt = auction?.endsAt ?? null;
  const liveAuctionId = auction?.id ?? null;
  const open = auction?.status === 'OPEN' && state.status === 'ACTIVE';
  // When the server will agree to close: a moment after the countdown ends. Never shown.
  const { secondsLeft, closeDue } = useAuctionClock(open ? endsAt : null, open && auction ? auctionAcceptUntil(auction) : null);
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
    if (auction && auction.status === 'CLOSED') {
      // Go BACK to the game screen that opened this auction. Replacing this route with a new
      // /game screen left the old one mounted underneath: every auction added another live game
      // screen (board, animations, and its own "open the auction" push).
      const t = setTimeout(() => goBack(`/game/${state.id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [auction, state.id]);

  if (!auction) {
    return (
      <Screen>
        <Card className="mt-10 items-center">
          <Text className="text-2xl font-bold text-ink">This auction is over.</Text>
          <Button className="mt-4 self-stretch" title="Back to game" onPress={() => goBack(`/game/${state.id}`)} />
        </Card>
      </Screen>
    );
  }

  const deed = getDeed(auction.propertyKey);
  const me = view.me;
  const min = minimumNextBid(auction);
  const amIn = !!me && auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id);
  const leading = !!me && auction.highBidderId === me.id;
  const groupTheme = PROPERTY_GROUP_THEME[deed.group];
  const bids = [min, min + 500, min + 1000].filter((b) => !!me && b <= me.balance);
  const result = auctionResult(auction, state.players);

  return (
    <Screen scroll testID="auction-screen">
      <ConnectionBanner />
      <Card className="overflow-hidden p-0">
        <View style={{ backgroundColor: groupTheme.color }} className="items-center px-4 py-4" testID="auction-deed-header">
          <Text style={{ color: groupTheme.onColor }} className="text-xs font-extrabold uppercase tracking-[4px] opacity-80">Auction</Text>
          <Text style={{ color: groupTheme.onColor }} className="text-3xl font-black">{deed.name}</Text>
          <Text style={{ color: groupTheme.onColor }} className="text-sm font-semibold opacity-80">List price {formatINR(deed.price)}</Text>
        </View>
        <View className="items-center gap-1 p-5">
          <Label className="self-stretch text-center">{auction.highBid === null ? 'No bids yet' : `Highest bid · ${view.playerName(auction.highBidderId)}`}</Label>
          <Text className="text-hero text-ink" testID="current-bid">
            {auction.highBid === null ? '—' : formatINR(auction.highBid)}
          </Text>
          {open ? (
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
              <Text className={`text-4xl font-black ${result.sold ? 'text-green-700' : 'text-stone-600'}`}>{result.sold ? 'SOLD' : 'CLOSED'}</Text>
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

      {open && !expired && amIn && !leading ? (
        <View className="gap-3">
          <Text className="text-center text-sm font-semibold text-cream/80">Minimum next bid {formatINR(min)}</Text>
          {bids.length === 0 ? <Text className="text-center text-base font-bold text-amber-300">Not enough money to bid.</Text> : null}
          {bids.map((amount, i) => (
            <Button
              key={amount}
              title={`BID ${formatINR(amount)}`}
              size={i === 0 ? 'lg' : 'md'}
              variant={i === 0 ? 'primary' : 'secondary'}
              testID={i === 0 ? 'bid-button' : `bid-button-${i}`}
              disabled={!!pending}
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
      {open && !amIn && !leading ? (
        <Card className="items-center">
          <Text className="text-lg font-bold text-ink">You passed. Watching…</Text>
        </Card>
      ) : null}
      <Button variant="ghost" size="sm" title="Back to game" onPress={() => goBack(`/game/${state.id}`)} />
    </Screen>
  );
}
