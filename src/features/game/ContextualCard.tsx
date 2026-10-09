import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { COLORS } from '@/constants/theme';
import type { ContextItem, ContextTarget } from './gameFocus';
import { CONTEXT_CARD_HEIGHT, FIXED_HEIGHT_FONT_SCALE } from './layout';

/** Tinted icon backgrounds that say "needs you" vs "for your information". */
const ICON_BG: Record<ContextItem['kind'], string> = {
  offer: '#FDE7B0',
  undo: '#FDE7B0',
  auction: '#FDE7B0',
  decision: '#FDE7B0',
  payment: '#FBD5C4',
  event: '#E7EFE4',
  news: '#ECE6D6',
  position: COLORS.boardCorner,
  paused: '#E7E5E4',
  finished: '#FDE7B0',
  neutral: COLORS.boardCorner,
};

interface ContextualCardProps {
  item: ContextItem;
  /** Fixed height from the screen layout plan, so the board never jumps when content changes. */
  height: number;
  onAction: (target: ContextTarget) => void;
}

/**
 * The game's attention surface: the single most relevant thing right now (an
 * offer, a payment, a big moment, the latest news, or where you stand). Fixed
 * height so the board above never jumps when the content changes. Part of the
 * table, not a popup: it has no close button — the next thing that matters
 * replaces it.
 */
export const ContextualCard = memo(function ContextualCard({ item, height, onAction }: ContextualCardProps) {
  const urgent = item.kind === 'offer' || item.kind === 'undo' || item.kind === 'decision' || item.kind === 'payment' || item.kind === 'auction';
  // A message with no detail line may use that room: two lines, or three when the card is tall enough for them.
  const titleLines = item.detail ? 1 : height >= CONTEXT_CARD_HEIGHT.normal + 8 ? 3 : 2;
  return (
    <View
      testID="context-card"
      accessibilityLiveRegion="polite"
      style={{ height }}
      className={`flex-row items-center gap-3 overflow-hidden rounded-2xl border-b-4 px-3 ${urgent ? 'border-saffron-dark bg-cream' : 'border-stone-300 bg-cream'}`}
    >
      <View testID={`context-${item.kind}`} style={{ backgroundColor: ICON_BG[item.kind] }} className="h-11 w-11 items-center justify-center rounded-xl">
        <Text className="text-2xl" allowFontScaling={false}>
          {item.icon}
        </Text>
      </View>
      <View className="flex-1" accessible accessibilityLabel={[item.label, item.title, item.detail].filter(Boolean).join('. ')}>
        <Text className="text-[10px] font-extrabold uppercase tracking-[2px] text-stone-500" numberOfLines={1} maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE} testID="context-label">
          {item.label}
        </Text>
        <Text className="text-[15px] font-extrabold leading-5 text-ink" numberOfLines={titleLines} maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE} testID="context-title">
          {item.title}
        </Text>
        {item.detail ? (
          <Text className="text-xs leading-4 text-stone-600" numberOfLines={height >= CONTEXT_CARD_HEIGHT.normal ? 2 : 1} maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE} testID="context-detail">
            {item.detail}
          </Text>
        ) : null}
      </View>
      {item.cta ? (
        <Pressable
          onPress={() => onAction(item.cta!.target)}
          accessibilityRole="button"
          accessibilityLabel={item.cta.label}
          testID="context-cta"
          className={`min-h-[44px] max-w-[100px] items-center justify-center rounded-xl px-2.5 ${urgent ? 'bg-saffron active:bg-saffron-dark' : 'bg-felt active:bg-felt-dark'}`}
        >
          <Text className={`text-center text-[13px] font-extrabold ${urgent ? 'text-ink' : 'text-cream'}`} numberOfLines={2} maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE}>
            {item.cta.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});
