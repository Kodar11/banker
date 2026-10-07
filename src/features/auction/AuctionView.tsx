import { goBack } from '@/utils/navigation';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { getDeed, minimumNextBid } from '@/engine/index.ts';
import { Button, Card, ConnectionBanner, Label, Pill, Screen } from '@/components/ui';
import { GROUP_COLORS } from '@/constants/theme';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

/** Current time on the server's clock (corrects phone clock skew), ticking 4×/s. Display only — the server decides. */
function useServerNow(serverTime: string): number {
  const offset = useRef(0);
  // Until the first tick, the snapshot's server time is the best estimate of "now".
  const [now, setNow] = useState(() => Date.parse(serverTime));
  useEffect(() => {
    offset.current = Date.parse(serverTime) - Date.now();
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => clearInterval(t);
  }, []);
  return now;
}

const MAX_CLOSE_ATTEMPTS = 5;

export function AuctionView({ view, auctionId }: { view: GameView; auctionId: string }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const { state, serverTime } = view.snapshot;
  const auction = state.auction?.id === auctionId ? state.auction : null;
  const now = useServerNow(serverTime);
  const endsAt = auction?.endsAt ?? null;
  const liveAuctionId = auction?.id ?? null;
  // Close attempts per deadline: a new deadline (someone bid) re-arms the automatic close.
  const [attempts, setAttempts] = useState<{ endsAt: string | null; n: number }>({ endsAt: null, n: 0 });
  const closeAttempt = attempts.endsAt === endsAt ? attempts.n : 0;

  const secondsLeft = endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000)) : 0;
  const open = auction?.status === 'OPEN' && state.status === 'ACTIVE';
  const expired = open && secondsLeft === 0;

  // When the countdown runs out, any device may ask the server to close; the server checks the
  // time and closes exactly once (others get AUCTION_CLOSED). If it says "still running" (clock
  // skew) or the request didn't go through, try again shortly — until the realtime update arrives.
  useEffect(() => {
    if (!expired || !liveAuctionId || closeAttempt >= MAX_CLOSE_ATTEMPTS) return;
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
  }, [expired, liveAuctionId, endsAt, closeAttempt, send, view.me?.seat]);

  useEffect(() => {
    if (auction && auction.status === 'CLOSED') {
      const t = setTimeout(() => router.replace(`/game/${state.id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [auction, state.id]);

  if (!auction) {
    return (
      <Screen>
        <Card className="mt-10 items-center">
          <Text className="text-2xl font-bold text-ink">This auction is over.</Text>
          <Button className="mt-4 self-stretch" title="Back to game" onPress={() => router.replace(`/game/${state.id}`)} />
        </Card>
      </Screen>
    );
  }

  const deed = getDeed(auction.propertyKey);
  const me = view.me;
  const min = minimumNextBid(auction);
  const amIn = !!me && auction.participantIds.includes(me.id) && !auction.passedIds.includes(me.id);
  const leading = !!me && auction.highBidderId === me.id;
  const bids = [min, min + 500, min + 1000].filter((b) => !!me && b <= me.balance);

  return (
    <Screen scroll testID="auction-screen">
      <ConnectionBanner />
      <Card className="overflow-hidden p-0">
        <View style={{ backgroundColor: GROUP_COLORS[deed.group] }} className="items-center px-4 py-4">
          <Text className="text-xs font-extrabold uppercase tracking-[4px] text-white/80">Auction</Text>
          <Text className="text-3xl font-black text-white">{deed.name}</Text>
          <Text className="text-sm font-semibold text-white/80">List price {formatINR(deed.price)}</Text>
        </View>
        <View className="items-center gap-1 p-5">
          <Label>{auction.highBid === null ? 'No bids yet' : `Highest bid · ${view.playerName(auction.highBidderId)}`}</Label>
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
            <View className="mt-2 items-center gap-2" testID="auction-result">
              <Text className={`text-4xl font-black ${auction.winnerId ? 'text-green-700' : 'text-stone-600'}`}>
                {auction.winnerId ? 'SOLD' : 'CLOSED'}
              </Text>
              <Pill tone={auction.winnerId ? 'good' : 'neutral'}>
                {auction.winnerId ? `Sold to ${view.playerName(auction.winnerId)}` : 'Unsold — stays with the bank'}
              </Pill>
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
