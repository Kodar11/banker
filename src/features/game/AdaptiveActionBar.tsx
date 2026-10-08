import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ACTION_BUTTON_HEIGHT, ACTION_GAP, type ActionLayout } from './layout';

export type BarActionKey = 'properties' | 'trade' | 'pay' | 'loan' | 'auction' | 'more';

export interface BarAction {
  key: BarActionKey;
  icon: string;
  label: string;
  testID: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}

/** Shown directly when space is tight; everything else lives in More. */
export const COMPACT_ACTIONS: readonly BarActionKey[] = ['pay', 'loan', 'more'];

/**
 * Secondary gameplay utilities — not app navigation. Six actions in one row on
 * roomy screens, a 2×3 grid when the row would be too narrow, and just the most
 * used ones + More when vertical space is tight (see planGameLayout).
 */
export const AdaptiveActionBar = memo(function AdaptiveActionBar({ layout, actions }: { layout: ActionLayout; actions: BarAction[] }) {
  const shown = layout === 'compact' ? actions.filter((a) => COMPACT_ACTIONS.includes(a.key)) : actions;
  const rows = layout === 'grid' ? [shown.slice(0, 3), shown.slice(3)] : [shown];
  return (
    <View testID="action-bar" style={{ gap: ACTION_GAP }}>
      <View testID={`action-bar-${layout}`} style={{ gap: ACTION_GAP }}>
        {rows.map((row, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: ACTION_GAP }}>
            {row.map((a) => (
              <ActionButton key={a.key} action={a} layout={layout} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
});

function ActionButton({ action, layout }: { action: BarAction; layout: ActionLayout }) {
  const twoLines = layout === 'row';
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        testID={action.testID}
        onPress={action.onPress}
        disabled={action.disabled}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityHint={action.hint}
        accessibilityState={{ disabled: !!action.disabled }}
        style={{ height: ACTION_BUTTON_HEIGHT[layout], gap: twoLines ? 1 : 0 }}
        className={`items-center justify-center rounded-xl border border-white/20 bg-white/10 px-0.5 active:bg-white/20 ${action.disabled ? 'opacity-40' : ''}`}
      >
        <Text className={twoLines ? 'text-lg leading-6' : 'text-base leading-5'} accessible={false}>
          {action.icon}
        </Text>
        <Text
          className={`text-center font-bold text-cream ${twoLines ? 'text-[10px] leading-[12px]' : 'text-xs leading-4'}`}
          numberOfLines={twoLines ? 2 : 1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {action.label}
        </Text>
      </Pressable>
    </View>
  );
}
