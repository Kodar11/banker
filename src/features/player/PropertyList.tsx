import { Text, View } from 'react-native';
import type { GameState, PropertyState } from '@/engine/index.ts';
import { Label } from '@/components/ui';
import { PropertyRow } from './PropertyRow';

interface PropertyListProps {
  /** Exactly the properties to list (one player's, in board order). */
  properties: PropertyState[];
  /** Overrides where a row goes; by default a row opens the property screen. */
  onPropertyPress?: (key: string) => void;
  /** One line under the heading, e.g. what tapping a row does. Hidden while the list is empty. */
  hint?: string;
  testID?: string;
  /** The game, so a row can show Intermediate Mode's market value and collateral status. */
  state?: GameState;
}

/** A player's properties: heading with the count, then one row each, or a compact empty state. */
export function PropertyList({ properties, onPropertyPress, hint, testID, state }: PropertyListProps) {
  return (
    <View className="gap-2" testID={testID}>
      <View className="flex-row items-center justify-between">
        <Label>Properties</Label>
        <View className="min-w-[28px] items-center rounded-full bg-stone-200 px-2 py-0.5" testID="property-count" accessibilityLabel={`${properties.length} owned`}>
          <Text className="text-xs font-extrabold text-stone-700">{properties.length}</Text>
        </View>
      </View>
      {properties.length ? (
        <>
          {hint ? <Text className="text-xs text-stone-500">{hint}</Text> : null}
          {properties.map((p) => (
            <PropertyRow key={p.key} prop={p} state={state} onPress={onPropertyPress ? () => onPropertyPress(p.key) : undefined} />
          ))}
        </>
      ) : (
        <View className="rounded-2xl border border-dashed border-stone-300 px-4 py-3" testID="property-list-empty">
          <Text className="text-center text-sm font-semibold text-stone-500">No properties yet</Text>
        </View>
      )}
    </View>
  );
}
