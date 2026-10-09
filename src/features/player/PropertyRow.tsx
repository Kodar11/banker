import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getDeed, type PropertyState } from '@/engine/index.ts';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import { openProperty } from '@/utils/navigation';

/** What stands on (or hangs over) a property, for the row's trailing tag. A mortgaged site has no buildings. */
function propertyStatus(prop: PropertyState): { text: string; spoken: string; warn: boolean } | null {
  if (prop.mortgaged) return { text: 'Mortgaged', spoken: 'mortgaged', warn: true };
  if (prop.hotel) return { text: '🏨 Hotel', spoken: 'hotel', warn: false };
  if (prop.houses > 0) return { text: `🏠 × ${prop.houses}`, spoken: `${prop.houses} house${prop.houses === 1 ? '' : 's'}`, warn: false };
  return null;
}

/** One owned property. Opens the property screen unless `onPress` says otherwise (e.g. the in-game details sheet). */
export const PropertyRow = memo(function PropertyRow({ prop, onPress }: { prop: PropertyState; onPress?: () => void }) {
  const deed = getDeed(prop.key);
  const status = propertyStatus(prop);
  return (
    <Pressable
      onPress={onPress ?? (() => openProperty(prop.key))}
      accessibilityRole="button"
      accessibilityLabel={`${deed.name}, ${formatINR(deed.price)}${status ? `, ${status.spoken}` : ''}`}
      testID={`property-${prop.key}`}
      className="min-h-[56px] flex-row items-center overflow-hidden rounded-2xl bg-white active:opacity-80"
    >
      <View style={{ backgroundColor: PROPERTY_GROUP_THEME[deed.group].mark }} className="w-1.5 self-stretch" />
      {/* The name wraps rather than clips; the tag and chevron keep their size. */}
      <View className="flex-1 py-2.5 pl-3.5 pr-2">
        <Text className={`text-base font-bold ${prop.mortgaged ? 'text-stone-500' : 'text-ink'}`}>{deed.name}</Text>
        <Text className="text-xs font-semibold text-stone-500">{formatINR(deed.price)}</Text>
      </View>
      {status ? (
        <View testID={`property-status-${prop.key}`} className={`rounded-full px-2.5 py-1 ${status.warn ? 'bg-amber-100' : 'bg-stone-100'}`}>
          <Text className={`text-xs font-bold ${status.warn ? 'text-amber-800' : 'text-stone-700'}`}>{status.text}</Text>
        </View>
      ) : null}
      <Text className="pl-2 pr-4 text-lg text-stone-400">›</Text>
    </Pressable>
  );
});
