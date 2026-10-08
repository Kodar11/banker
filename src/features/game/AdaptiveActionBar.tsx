import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ActionIcon, type ActionIconName } from './ActionIcon';
import { ACTION_BUTTON_HEIGHT, ACTION_GAP, FIXED_HEIGHT_FONT_SCALE, type ActionLayout } from './layout';

export type BarActionKey = 'properties' | 'trade' | 'pay' | 'loan' | 'auction' | 'more';

export interface BarAction {
  key: BarActionKey;
  icon: ActionIconName;
  label: string;
  testID: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}

/** Shown directly when space is tight; everything else lives in More. */
export const COMPACT_ACTIONS: readonly BarActionKey[] = ['trade', 'loan', 'more'];

/**
 * Secondary gameplay utilities — not app navigation. A 2×3 grid when there is
 * room, six in one row when there is a little less, and just the most used ones
 * + More when vertical space is tight (see planGameLayout).
 */
export const AdaptiveActionBar = memo(function AdaptiveActionBar({
  layout,
  actions,
  buttonHeight = ACTION_BUTTON_HEIGHT[layout],
}: {
  layout: ActionLayout;
  actions: BarAction[];
  /** From the screen layout plan: taller on screens with height to spare. */
  buttonHeight?: number;
}) {
  const shown = layout === 'compact' ? actions.filter((a) => COMPACT_ACTIONS.includes(a.key)) : actions;
  const rows = layout === 'grid' ? [shown.slice(0, 3), shown.slice(3)] : [shown];
  return (
    <View testID="action-bar" style={{ gap: ACTION_GAP }}>
      <View testID={`action-bar-${layout}`} style={{ gap: ACTION_GAP }}>
        {rows.map((row, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: ACTION_GAP }}>
            {row.map((a) => (
              <ActionButton key={a.key} action={a} layout={layout} height={buttonHeight} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
});

function ActionButton({ action, layout, height }: { action: BarAction; layout: ActionLayout; height: number }) {
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
        style={{ height, gap: 2 }}
        className={`items-center justify-center rounded-xl border border-white/20 bg-white/10 px-0.5 active:bg-white/20 ${action.disabled ? 'opacity-40' : ''}`}
      >
        <ActionIcon name={action.icon} size={twoLines ? 22 : 20} />
        <Text
          className={`text-center font-bold text-cream ${twoLines ? 'text-[10px] leading-[12px]' : 'text-xs leading-4'}`}
          numberOfLines={twoLines ? 2 : 1}
          maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE}
        >
          {action.label}
        </Text>
      </Pressable>
    </View>
  );
}
