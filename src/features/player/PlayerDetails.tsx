import { Pressable, Text, View } from 'react-native';
import { netWorth, outstandingDebt, ownedBy, spaceName } from '@/engine/index.ts';
import { Button, Pill, PlayerBadge } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { ActionIcon } from '@/features/game/ActionIcon';
import type { GameView } from '@/features/game/useGameView';
import { formatINR } from '@/utils/currency';
import { PropertyList } from './PropertyList';

/**
 * One player's financial sheet, in three parts that share the same data:
 * header (who) · details (cash, summary, properties, wallet link) · actions.
 * "My Properties" is this sheet for me; "Player details" is it for anyone else.
 */

function findPlayer(view: GameView, playerId: string) {
  const { state } = view.snapshot;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;
  return { state, player, me: view.me, isMe: view.me?.id === player.id };
}

/** Who this is and how they stand: colour token, name, status badges. Sits in the sheet's fixed header. */
export function PlayerDetailsHeader({ view, playerId }: { view: GameView; playerId: string }) {
  const found = findPlayer(view, playerId);
  if (!found) return <Text className="text-2xl font-extrabold text-ink">Player</Text>;
  const { state, player, isMe } = found;
  const isTurn = state.status === 'ACTIVE' && state.turn.playerId === player.id;
  const status =
    player.status === 'BANKRUPT'
      ? { tone: 'bad' as const, text: 'Bankrupt' }
      : player.status === 'LEFT'
        ? { tone: 'neutral' as const, text: 'Left the game' }
        : player.inJail
        ? { tone: 'warn' as const, text: `In Jail · ${player.jailTurnsLeft} left` }
        : player.skipTurns > 0
          ? { tone: 'warn' as const, text: 'Resting' }
          : { tone: 'good' as const, text: 'Active' };
  return (
    <View className="flex-row items-start gap-3" testID="player-details-header" accessibilityRole="header">
      {/* A plain colour token, like the piece on the board. */}
      <View className="h-11 justify-center">
        <PlayerBadge player={player} size={32} plain testID="player-details-badge" />
      </View>
      <View className="flex-1 gap-1.5">
        <View className="min-h-[44px] flex-row items-center gap-2">
          <Text className="shrink text-2xl font-black text-ink" numberOfLines={1}>
            {player.name}
          </Text>
          {isMe ? <Text className="text-base font-bold text-stone-500">(You)</Text> : null}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Pill tone={status.tone}>{status.text}</Pill>
          {isTurn ? <Pill tone="gold">{isMe ? 'Your turn' : 'Their turn'}</Pill> : null}
        </View>
      </View>
    </View>
  );
}

interface PlayerDetailsProps {
  view: GameView;
  playerId: string;
  onPropertyPress: (key: string) => void;
  /** Opens the full wallet screen (loans, history). */
  onOpenWallet: (playerId: string) => void;
}

/** Cash, the financial summary, what they own and the way into their wallet. Read-only. */
export function PlayerDetails({ view, playerId, onPropertyPress, onOpenWallet }: PlayerDetailsProps) {
  const found = findPlayer(view, playerId);
  if (!found) return <Text className="text-base text-stone-600">Player not found.</Text>;
  const { state, player, isMe } = found;
  const debt = outstandingDebt(state.loans, player.id);
  const canManage = isMe && state.status === 'ACTIVE' && player.status === 'ACTIVE';

  return (
    <View className="gap-4" testID={`player-details-${player.id}`}>
      <View className="rounded-3xl bg-felt p-5" testID="player-details-summary">
        <Text className="text-xs font-bold uppercase tracking-widest text-cream/70">Cash</Text>
        <Text className="text-4xl font-black text-cream" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} testID="player-details-balance">
          {formatINR(player.balance)}
        </Text>
        {/* Label left, value right: stays aligned on a narrow phone, and a long square name wraps instead of squeezing. */}
        <View className="mt-4 gap-2.5 rounded-2xl bg-felt-dark px-4 py-3">
          <SummaryRow label="Location" value={player.status !== 'ACTIVE' ? 'Off the board' : spaceName(player.position)} testID="player-details-location" />
          <SummaryRow label="Net worth" value={formatINR(netWorth(state, player.id))} testID="player-details-net-worth" />
          <SummaryRow label="Loans owed" value={formatINR(debt)} warn={debt > 0} testID="player-details-loans" />
        </View>
      </View>

      <PropertyList
        testID="player-details-properties"
        properties={ownedBy(state, player.id).map((k) => state.properties[k])}
        onPropertyPress={onPropertyPress}
        hint={canManage ? 'Tap a property to build, mortgage or sell.' : undefined}
      />

      <Pressable
        onPress={() => onOpenWallet(player.id)}
        accessibilityRole="button"
        accessibilityLabel="Wallet and history"
        accessibilityHint="Opens transactions, loans and financial history"
        testID="player-open-wallet"
        className="min-h-[60px] flex-row items-center gap-3 rounded-2xl border border-stone-300 px-4 py-2.5 active:opacity-80"
      >
        <View className="h-9 w-9 items-center justify-center rounded-full bg-felt">
          <ActionIcon name="bank" size={18} color={COLORS.cream} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-bold text-ink">Wallet & History</Text>
          <Text className="text-xs text-stone-500">Transactions, loans and financial history</Text>
        </View>
        <Text className="text-lg text-stone-400">›</Text>
      </Pressable>
    </View>
  );
}

interface PlayerDetailsActionsProps {
  view: GameView;
  playerId: string;
  /** Existing flows, prefilled with this player. */
  onMakeOffer: (playerId: string) => void;
  onPayMoney: (playerId: string) => void;
}

/**
 * What I can do with another player. Shown disabled, with the reason, when the
 * server would refuse (game not running, either of us bankrupt). Nothing for
 * my own sheet or for a spectator.
 */
export function PlayerDetailsActions({ view, playerId, onMakeOffer, onPayMoney }: PlayerDetailsActionsProps) {
  const found = findPlayer(view, playerId);
  if (!found || !found.me || found.isMe) return null;
  const { state, player, me } = found;
  const blocked =
    state.status === 'PAUSED'
      ? 'The game is paused.'
      : state.status !== 'ACTIVE'
        ? 'The game is not running.'
        : me.status !== 'ACTIVE'
          ? 'You are out of the game.'
          : player.status !== 'ACTIVE'
            ? 'This player is out of the game.'
            : null;
  return (
    <View className="gap-2" testID="player-details-actions">
      <View className="flex-row gap-3">
        <Button className="flex-1" size="md" variant="primary" title="Make Offer" testID="player-make-offer" disabled={!!blocked} onPress={() => onMakeOffer(player.id)} />
        <Button className="flex-1" size="md" variant="secondary" title="Pay Money" testID="player-pay-money" disabled={!!blocked} onPress={() => onPayMoney(player.id)} />
      </View>
      {blocked ? (
        <Text className="text-center text-xs font-semibold text-stone-500" testID="player-actions-blocked">
          {blocked}
        </Text>
      ) : null}
    </View>
  );
}

function SummaryRow({ label, value, warn = false, testID }: { label: string; value: string; warn?: boolean; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-4" testID={testID}>
      <Text className="text-sm font-semibold text-cream/70">{label}</Text>
      <Text className={`flex-1 text-right text-base font-extrabold ${warn ? 'text-amber-300' : 'text-cream'}`}>{value}</Text>
    </View>
  );
}
