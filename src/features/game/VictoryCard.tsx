import { Animated, Pressable, Text, View } from 'react-native';
import { formatINR } from '@/utils/currency';
import { finalResult } from './finalResult';
import type { GameView } from './useGameView';
import { SPARKLES, useVictoryClock, VICTORY_TRACKS } from './victoryMoment';

/**
 * The card grows with its text instead of cutting it off, so its text may follow the phone's
 * font-size setting further than the fixed-height sections do.
 */
const FONT_SCALE = 1.3;

interface VictoryCardProps {
  view: GameView;
  /** From the screen layout plan. A floor, not a box: a long name or large text makes the card taller. */
  height: number;
  dense: boolean;
  onStandings: () => void;
}

/**
 * The finished game's result, where the contextual card sits during play: who won, their final net
 * worth and their lead over second place — everything a screenshot needs, in one card. All of it is
 * the server's published result (see finalResult); the celebration around it is decoration only.
 */
export function VictoryCard({ view, height, dense, onStandings }: VictoryCardProps) {
  const { state } = view.snapshot;
  const result = finalResult(view.snapshot);
  const won = result.winnerId !== null;
  const clock = useVictoryClock(won ? state.id : null);
  const tied = result.tiedWithIds.length > 0;
  const winner = view.playerName(result.winnerId);
  const worth = result.winnerNetWorth === null ? null : formatINR(result.winnerNetWorth);

  const label = !won ? 'Game over' : tied ? 'Game over · Tied finish' : 'Game over · Victory';
  const title = won ? `${winner} wins!` : 'Game over';
  /** The second line of figures: the lead, the tie, or how the game ended. Null when there is nothing true to add. */
  const second: { label: string; value: string } | null = !won
    ? { label: 'Result', value: 'No winner was declared' }
    : tied
      ? { label: 'Tied on net worth', value: `Level with ${result.tiedWithIds.length === 1 ? view.playerName(result.tiedWithIds[0]!) : `${result.tiedWithIds.length} players`}` }
      : result.lead !== null
        ? { label: 'Lead over second place', value: formatINR(result.lead) }
        : result.lastPlayerStanding
          ? { label: 'Result', value: 'Last player standing' }
          : null;
  const spoken = [title, worth ? `Final net worth ${worth}` : null, second ? `${second.label}: ${second.value}` : null].filter(Boolean).join('. ');

  const trophySize = dense ? 44 : 52;
  return (
    <View
      testID="context-card"
      accessibilityLiveRegion="polite"
      style={{ minHeight: height }}
      className={`justify-center rounded-2xl border-b-4 bg-cream px-3 ${dense ? 'gap-1.5 py-2' : 'gap-2 py-2.5'} ${won ? 'border-saffron-dark' : 'border-stone-300'}`}
    >
      {/* Styled inline: an animated view takes no NativeWind classes. */}
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 16, backgroundColor: '#FDE7B0', opacity: clock.interpolate(VICTORY_TRACKS.glow) }}
      />
      <View className="flex-row items-center gap-3">
        <View style={{ width: trophySize, height: trophySize }} className="items-center justify-center">
          <Animated.View
            testID="victory-trophy"
            style={{ width: trophySize, height: trophySize, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: won ? '#FDE7B0' : '#E7E5E4', transform: [{ scale: clock.interpolate(VICTORY_TRACKS.trophy) }] }}
          >
            <Text className={dense ? 'text-2xl' : 'text-3xl'} allowFontScaling={false}>
              {won ? '🏆' : '🏁'}
            </Text>
          </Animated.View>
          {won
            ? SPARKLES.map((s, i) => (
                <Animated.View
                  key={i}
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{
                    position: 'absolute',
                    width: 6,
                    height: 6,
                    borderRadius: i % 2 ? 3 : 1,
                    backgroundColor: s.color,
                    opacity: clock.interpolate(VICTORY_TRACKS.sparkleOpacity),
                    transform: [
                      { translateX: clock.interpolate(VICTORY_TRACKS.sparkleTravel).interpolate({ inputRange: [0, 1], outputRange: [0, s.x] }) },
                      { translateY: clock.interpolate(VICTORY_TRACKS.sparkleTravel).interpolate({ inputRange: [0, 1], outputRange: [0, s.y] }) },
                      { rotate: '45deg' },
                    ],
                  }}
                />
              ))
            : null}
        </View>
        <View className="flex-1" accessible accessibilityLabel={spoken}>
          <Text className="text-[10px] font-extrabold uppercase tracking-[2px] text-stone-500" numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE} testID="context-label">
            {label}
          </Text>
          <Text className={`font-black text-ink ${dense ? 'text-lg leading-6' : 'text-xl leading-7'}`} numberOfLines={2} maxFontSizeMultiplier={FONT_SCALE} testID="context-title">
            {title}
          </Text>
        </View>
        <Pressable
          onPress={onStandings}
          accessibilityRole="button"
          accessibilityLabel="Standings"
          accessibilityHint="Opens the final standings"
          testID="context-cta"
          className="min-h-[44px] items-center justify-center rounded-xl bg-felt px-3 active:bg-felt-dark"
        >
          <Text className="text-center text-[13px] font-extrabold text-cream" numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE}>
            Standings
          </Text>
        </Pressable>
      </View>
      {worth || second ? (
        // The figures, side by side under the name. Hidden from the screen reader: the name above already reads them out.
        <View className={`flex-row items-start gap-4 border-t border-stone-200 ${dense ? 'pt-1.5' : 'pt-2'}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {worth ? (
            <View>
              <Text className="text-[10px] font-extrabold uppercase tracking-[1.5px] text-stone-500" maxFontSizeMultiplier={FONT_SCALE}>
                Final net worth
              </Text>
              <Animated.View style={{ alignSelf: 'flex-start', transform: [{ scale: clock.interpolate(VICTORY_TRACKS.figure) }] }}>
                <Text className={`font-black text-felt ${dense ? 'text-lg leading-6' : 'text-xl leading-7'}`} maxFontSizeMultiplier={FONT_SCALE} testID="victory-net-worth">
                  {worth}
                </Text>
              </Animated.View>
            </View>
          ) : null}
          {second ? (
            // The narrower a phone, the more of this column wraps: the net worth beside it keeps its full width.
            <View className="flex-1">
              <Text className="text-[10px] font-extrabold uppercase tracking-[1.5px] text-stone-500" numberOfLines={2} maxFontSizeMultiplier={FONT_SCALE} testID="victory-second-label">
                {second.label}
              </Text>
              <Text className={`font-extrabold text-ink ${dense ? 'text-base leading-6' : 'text-lg leading-7'}`} numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE} testID="victory-lead">
                {second.value}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
