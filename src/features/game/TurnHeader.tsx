import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { GameView } from './useGameView';
import { formatINR } from '@/utils/currency';

/** Who's turn it is + my balance, readable at a glance from across the table. */
export const TurnHeader = memo(function TurnHeader({ view }: { view: GameView }) {
  const { me, current, isMyTurn } = view;
  return (
    <View className="gap-3">
      <View
        className={`items-center rounded-3xl px-4 py-3 ${isMyTurn ? 'bg-saffron' : 'bg-felt-dark'}`}
        accessibilityRole="header"
        testID="turn-banner"
      >
        <Text className={`text-xs font-extrabold uppercase tracking-[4px] ${isMyTurn ? 'text-ink/70' : 'text-cream/60'}`}>
          Turn {view.snapshot.state.turn.number}
        </Text>
        <Text className={`text-3xl font-black ${isMyTurn ? 'text-ink' : 'text-cream'}`} numberOfLines={1}>
          {isMyTurn ? 'YOUR TURN' : `${current?.name ?? '—'}'s turn`}
        </Text>
      </View>
      {me ? (
        <Pressable
          onPress={() => router.push(`/player/${me.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`Your balance ${formatINR(me.balance)}. Open wallet`}
          className="flex-row items-end justify-between px-1"
          testID="my-balance"
        >
          <View>
            <Text className="text-xs font-bold uppercase tracking-widest text-cream/60">{me.name} · Balance</Text>
            <Text className="text-hero text-cream">{formatINR(me.balance)}</Text>
          </View>
          <Text className="pb-2 text-sm font-bold text-saffron">Wallet ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
});
