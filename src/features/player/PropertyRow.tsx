import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getDeed, type PropertyState } from '@/engine/index.ts';
import { GROUP_COLORS } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import { openProperty } from '@/utils/navigation';

export const PropertyRow = memo(function PropertyRow({ prop }: { prop: PropertyState }) {
  const deed = getDeed(prop.key);
  const dev = prop.hotel ? '🏨 Hotel' : prop.houses > 0 ? '🏠'.repeat(prop.houses) : '';
  return (
    <Pressable
      onPress={() => openProperty(prop.key)}
      accessibilityRole="button"
      accessibilityLabel={`${deed.name}${prop.mortgaged ? ', mortgaged' : ''}`}
      testID={`property-${prop.key}`}
      className="flex-row items-center overflow-hidden rounded-xl bg-white"
    >
      <View style={{ backgroundColor: GROUP_COLORS[deed.group] }} className="w-2 self-stretch" />
      <View className="flex-1 px-4 py-3">
        <Text className="text-base font-bold text-ink">{deed.name}</Text>
        <Text className="text-xs text-stone-500">
          {formatINR(deed.price)}
          {prop.mortgaged ? ' · Mortgaged' : ''}
        </Text>
      </View>
      <Text className="pr-4 text-base">{dev}</Text>
      <Text className="pr-4 text-lg text-stone-400">›</Text>
    </Pressable>
  );
});
