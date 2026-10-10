import { Pressable, Text, View } from 'react-native';
import { DECK_LABELS, spaceAt, spaceName, type PlayerState } from '@/engine/index.ts';
import { Card, Label, PlayerBadge } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import type { GameView } from '@/features/game/useGameView';
import { PropertyInsurance } from '@/features/insurance/PropertyInsurance';
import { PropertyDeed } from '@/features/player/PropertyDeed';
import { PropertyManage } from '@/features/player/PropertyManage';
import { SPECIAL_ICONS } from './BoardSquare';
import { specialSquareInfo } from './squareInfo';

function statusOf(p: PlayerState): string | null {
  if (p.inJail) return `In Jail · ${p.jailTurnsLeft} turn${p.jailTurnsLeft === 1 ? '' : 's'} left`;
  if (p.skipTurns > 0) return 'Resting';
  return null;
}

function PlayersHere({ view, index, onPlayerPress }: { view: GameView; index: number; onPlayerPress: (id: string) => void }) {
  const here = view.snapshot.state.players.filter((p) => p.status === 'ACTIVE' && p.position === index).sort((a, b) => a.seat - b.seat);
  if (!here.length) return null;
  return (
    <View className="gap-2" testID="square-players">
      <Label>Here now</Label>
      <View className="flex-row flex-wrap gap-2">
        {here.map((p) => {
          const status = statusOf(p);
          return (
            <Pressable
              key={p.id}
              onPress={() => onPlayerPress(p.id)}
              accessibilityRole="button"
              accessibilityLabel={`${p.name}${status ? `, ${status}` : ''}. View player`}
              testID={`square-player-${p.id}`}
              className="min-h-[44px] flex-row items-center gap-2 rounded-xl bg-white px-3"
            >
              <PlayerBadge player={p} size={22} />
              <Text className="text-base font-bold text-ink">
                {p.name}
                {p.id === view.me?.id ? ' (You)' : ''}
              </Text>
              {status ? <Text className="text-xs font-semibold text-amber-700">{status}</Text> : null}
              <Text className="text-lg text-stone-400">›</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

interface SquareDetailsProps {
  view: GameView;
  index: number;
  onPlayerPress: (playerId: string) => void;
}

/**
 * Details for any board square. Read-only, except that a property I own carries its
 * insurance and manage sections (insure / build / mortgage / sell) in the same card.
 */
export function SquareDetails({ view, index, onPlayerPress }: SquareDetailsProps) {
  const { state } = view.snapshot;
  const space = spaceAt(index);

  if (space.kind === 'PROPERTY') {
    return (
      <View className="gap-4" testID={`square-details-${index}`}>
        <PropertyDeed state={state} propertyKey={space.propertyKey} playerName={view.playerName} onOwnerPress={onPlayerPress}>
          <PropertyInsurance view={view} propertyKey={space.propertyKey} />
          <PropertyManage view={view} propertyKey={space.propertyKey} />
        </PropertyDeed>
        <PlayersHere view={view} index={index} onPlayerPress={onPlayerPress} />
      </View>
    );
  }

  const card = state.turn.card;
  const currentHere = state.players.find((p) => p.id === state.turn.playerId)?.position === index;
  const showCard = !!card && card.deck === space.type && currentHere;
  return (
    <View className="gap-4" testID={`square-details-${index}`}>
      <Card className="items-center" testID="special-square-card">
        <View style={{ backgroundColor: COLORS.boardCorner }} className="h-16 w-16 items-center justify-center rounded-2xl">
          <Text className="text-4xl">{SPECIAL_ICONS[space.type]}</Text>
        </View>
        <Text className="mt-2 text-3xl font-black text-ink">{spaceName(index)}</Text>
        <View className="mt-3 gap-2 self-stretch" testID="special-square-info">
          {specialSquareInfo(space.type, state, view.me).map((line) => (
            <Text key={line} className="text-center text-base text-stone-700">
              {line}
            </Text>
          ))}
        </View>
      </Card>
      {showCard ? (
        <Card className="border-b-4 border-saffron bg-amber-50" testID="special-square-current-card">
          <Label>
            Current card · {DECK_LABELS[card.deck]} {card.table.toLowerCase()} {card.rollTotal}
          </Label>
          <Text className="mt-1 text-lg font-bold text-ink">{card.text}</Text>
        </Card>
      ) : null}
      <PlayersHere view={view} index={index} onPlayerPress={onPlayerPress} />
    </View>
  );
}
