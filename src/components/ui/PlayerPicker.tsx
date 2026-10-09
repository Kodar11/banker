import { Pressable, Text, View } from 'react-native';
import { Label } from './Card';
import { PlayerBadge } from './PlayerBadge';

interface PlayerPickerProps {
  /** What the choice is for: "Pay to", "Trade with". */
  label: string;
  players: { id: string; name: string; seat: number }[];
  selectedId: string | null;
  onSelect: (playerId: string) => void;
  /** Each option's testID is `${testIDPrefix}-${name}`. */
  testIDPrefix: string;
}

/** Choose the other player for an action sheet: one card each, the chosen one outlined and ticked. */
export function PlayerPicker({ label, players, selectedId, onSelect, testIDPrefix }: PlayerPickerProps) {
  return (
    <View className="gap-2">
      <Label className="text-stone-600">{label}</Label>
      {players.length ? (
        <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
          {players.map((p) => {
            const on = selectedId === p.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => onSelect(p.id)}
                accessibilityRole="radio"
                accessibilityLabel={p.name}
                accessibilityState={{ selected: on }}
                testID={`${testIDPrefix}-${p.name}`}
                className={`min-h-[52px] min-w-[45%] flex-1 flex-row items-center gap-2.5 rounded-2xl border-2 px-4 ${on ? 'border-felt bg-white' : 'border-transparent bg-stone-200'}`}
              >
                <PlayerBadge player={p} size={22} plain />
                <Text className="flex-1 text-lg font-bold text-ink" numberOfLines={1}>
                  {p.name}
                </Text>
                {on ? (
                  <View className="h-6 w-6 items-center justify-center rounded-full bg-felt">
                    <Text className="text-sm font-black text-cream">✓</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text className="text-sm font-semibold text-stone-500">No other players in the game.</Text>
      )}
    </View>
  );
}
