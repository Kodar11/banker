import { Pressable, Text, View } from 'react-native';

export interface MoreItem {
  key: string;
  icon: string;
  label: string;
  hint?: string;
  testID: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** The "More" sheet: every secondary action, each opening an existing flow. */
export function MoreActions({ items }: { items: MoreItem[] }) {
  return (
    <View className="gap-2" testID="more-actions">
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={item.onPress}
          disabled={item.disabled}
          testID={item.testID}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityHint={item.hint}
          accessibilityState={{ disabled: !!item.disabled }}
          className={`min-h-[52px] flex-row items-center gap-3 rounded-2xl bg-white px-4 py-2 ${item.disabled ? 'opacity-40' : ''}`}
        >
          <Text className="w-7 text-center text-xl">{item.icon}</Text>
          <View className="flex-1">
            <Text className={`text-base font-bold ${item.destructive ? 'text-brick' : 'text-ink'}`}>{item.label}</Text>
            {item.hint ? (
              <Text className="text-xs text-stone-500" numberOfLines={1}>
                {item.hint}
              </Text>
            ) : null}
          </View>
          <Text className="text-lg text-stone-400">›</Text>
        </Pressable>
      ))}
    </View>
  );
}
