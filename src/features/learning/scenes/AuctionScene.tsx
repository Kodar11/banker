import { Fragment } from 'react';
import { Text, View } from 'react-native';
import { playerColor } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import { GrowBar } from '../motion';
import type { AuctionScene as AuctionSceneData } from '../types';
import { CAST, Panel, StoryCardView, Tag, Who } from './parts';

/** The bids of a story auction in the order they were made, the learner's own limit, and how it ended. */
export function AuctionScene({ scene }: { scene: AuctionSceneData }) {
  const limit = scene.limit;
  const top = Math.max(...scene.bids.map((b) => b.amount), limit?.amount ?? 0);
  const last = scene.bids[scene.bids.length - 1];
  // The limit is drawn where it falls among the bids: after the last bid that stays within it.
  const limitAfter = limit ? scene.bids.reduce((at, bid, i) => (bid.amount <= limit.amount ? i : at), -1) : -2;
  const limitRow = limit ? (
    <View className="flex-row items-center gap-2" testID="scene-auction-limit" accessible accessibilityLabel={`${limit.label}: ${formatINR(limit.amount)}`}>
      <View className="h-px flex-1 bg-brick" />
      <Text className="text-[11px] font-extrabold uppercase tracking-wider text-brick">
        {limit.label} · {formatINR(limit.amount)}
      </Text>
      <View className="h-px flex-1 bg-brick" />
    </View>
  ) : null;
  const sold = formatINR(last?.amount ?? 0);
  const result = scene.open
    ? { tone: 'neutral' as const, text: 'Bidding is open' }
    : scene.winner === 'you'
      ? { tone: 'gold' as const, text: `🔨 You win at ${sold}` }
      : scene.winner
        ? { tone: 'neutral' as const, text: `🔨 Sold to ${CAST[scene.winner].name} for ${sold}` }
        : { tone: 'neutral' as const, text: 'Not sold' };
  return (
    <Panel title="Auction" testID="scene-auction">
      <View className="flex-row items-start gap-3">
        <StoryCardView card={scene.card} />
        <View className="flex-1 gap-2">
          {limitAfter === -1 ? limitRow : null}
          {scene.bids.map((bid, i) => {
            const seat = CAST[bid.who].seat;
            return (
              <Fragment key={`${bid.who}-${bid.amount}`}>
                <View className="gap-1">
                  <View className="flex-row items-center justify-between gap-2">
                    <Who who={bid.who} suffix={bid.who === 'you' ? 'bid' : 'bids'} />
                    <Text className="text-sm font-extrabold text-ink">{formatINR(bid.amount)}</Text>
                  </View>
                  <GrowBar fraction={bid.amount / top} index={i} height={6} color={seat === null ? '#78716C' : playerColor({ seat }).color} />
                </View>
                {limitAfter === i ? limitRow : null}
              </Fragment>
            );
          })}
        </View>
      </View>
      <View className="border-t border-stone-200 pt-2" testID="scene-auction-result">
        <Tag tone={result.tone}>{result.text}</Tag>
      </View>
    </Panel>
  );
}
