import { memo, useEffect, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import type { GameState } from '@/engine/index.ts';
import { destinationLabel, dieFace } from './describe';

/** "Rolled 7 → Move to Mumbai". Bounces once when a new roll arrives. */
export const DiceResult = memo(function DiceResult({ state, playerName }: { state: GameState; playerName: string }) {
  const roll = state.turn.roll;
  const destination = destinationLabel(state);
  const [scale] = useState(() => new Animated.Value(1));
  const key = roll ? `${state.turn.number}:${roll.dice.join(',')}` : null;

  useEffect(() => {
    if (!key) return;
    scale.setValue(0.6);
    Animated.spring(scale, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
  }, [key, scale]);

  if (!roll) return null;
  return (
    <View className="items-center gap-1 rounded-3xl bg-felt-dark px-4 py-4" testID="dice-result" accessibilityLiveRegion="polite">
      <Animated.View style={{ transform: [{ scale }], flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {roll.dice.map((d, i) => (
          <Text key={i} className="text-6xl text-cream" accessibilityLabel={`Die ${d}`}>
            {dieFace(d)}
          </Text>
        ))}
        <Text className="text-5xl font-black text-saffron">{roll.total}</Text>
      </Animated.View>
      {destination ? (
        <Text className="text-center text-xl font-bold text-cream" testID="destination">
          {playerName} → move {roll.total} to <Text className="text-saffron">{destination}</Text>
        </Text>
      ) : null}
      {state.turn.passedStart ? <Text className="text-sm font-semibold text-green-300">Passed Start 🎉</Text> : null}
    </View>
  );
});
