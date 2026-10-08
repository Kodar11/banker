import { Text, View } from 'react-native';
import { netWorth, outstandingDebt, ownedBy, spaceName } from '@/engine/index.ts';
import { Button, Card, Label, Pill, PlayerBadge } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { formatINR } from '@/utils/currency';
import { PropertyRow } from './PropertyRow';

interface PlayerDetailsProps {
  view: GameView;
  playerId: string;
  onPropertyPress: (key: string) => void;
  /** Existing flows, prefilled with this player. Only offered when the server would allow them. */
  onMakeOffer: (playerId: string) => void;
  onPayMoney: (playerId: string) => void;
  /** Opens the full wallet screen (loans, history). */
  onOpenWallet: (playerId: string) => void;
}

/** Who a player is, where they stand and what they own. Read-only; actions open the existing sheets. */
export function PlayerDetails({ view, playerId, onPropertyPress, onMakeOffer, onPayMoney, onOpenWallet }: PlayerDetailsProps) {
  const { state } = view.snapshot;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return <Text className="text-base text-stone-600">Player not found.</Text>;
  const me = view.me;
  const isMe = me?.id === player.id;
  const keys = ownedBy(state, player.id);
  const debt = outstandingDebt(state.loans, player.id);
  const isTurn = state.status === 'ACTIVE' && state.turn.playerId === player.id;
  const status =
    player.status === 'BANKRUPT'
      ? { tone: 'bad' as const, text: 'Bankrupt' }
      : player.inJail
        ? { tone: 'warn' as const, text: `In Jail · ${player.jailTurnsLeft} left` }
        : player.skipTurns > 0
          ? { tone: 'warn' as const, text: 'Resting' }
          : { tone: 'good' as const, text: 'Active' };
  const canDeal = !isMe && !!me && me.status === 'ACTIVE' && player.status === 'ACTIVE' && state.status === 'ACTIVE';

  return (
    <View className="gap-4" testID={`player-details-${player.id}`}>
      <Card>
        <View className="flex-row items-center gap-3">
          <PlayerBadge player={player} size={40} testID="player-details-badge" />
          <View className="flex-1">
            <Text className="text-2xl font-black text-ink" numberOfLines={1}>
              {player.name}
              {isMe ? <Text className="text-lg font-bold text-stone-500"> (You)</Text> : null}
            </Text>
            <View className="mt-1 flex-row flex-wrap gap-2">
              <Pill tone={status.tone}>{status.text}</Pill>
              {isTurn ? <Pill tone="gold">Their turn</Pill> : null}
            </View>
          </View>
        </View>
        <Text className="mt-3 text-hero text-ink" testID="player-details-balance">
          {formatINR(player.balance)}
        </Text>
        <View className="mt-2 flex-row flex-wrap gap-x-6 gap-y-2">
          <Stat label="Location" value={player.status === 'BANKRUPT' ? 'Off the board' : spaceName(player.position)} testID="player-details-location" />
          <Stat label="Net worth" value={formatINR(netWorth(state, player.id))} />
          <Stat label="Loans owed" value={formatINR(debt)} warn={debt > 0} testID="player-details-loans" />
        </View>
      </Card>

      {canDeal ? (
        <View className="flex-row gap-3">
          <Button className="flex-1" size="md" variant="primary" title="Make Offer" testID="player-make-offer" onPress={() => onMakeOffer(player.id)} />
          <Button className="flex-1" size="md" variant="secondary" title="Pay Money" testID="player-pay-money" onPress={() => onPayMoney(player.id)} />
        </View>
      ) : null}

      <View className="gap-2" testID="player-details-properties">
        <Label>Properties ({keys.length})</Label>
        {keys.length ? (
          keys.map((k) => <PropertyRow key={k} prop={state.properties[k]} onPress={() => onPropertyPress(k)} />)
        ) : (
          <Text className="text-base text-stone-500">No properties yet.</Text>
        )}
      </View>

      <Button
        size="sm"
        variant="secondary"
        title={isMe ? 'Wallet, loans & history ›' : `${player.name}'s wallet & history ›`}
        testID="player-open-wallet"
        onPress={() => onOpenWallet(player.id)}
      />
    </View>
  );
}

function Stat({ label, value, warn = false, testID }: { label: string; value: string; warn?: boolean; testID?: string }) {
  return (
    <View testID={testID}>
      <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</Text>
      <Text className={`text-base font-extrabold ${warn ? 'text-brick' : 'text-ink'}`}>{value}</Text>
    </View>
  );
}
