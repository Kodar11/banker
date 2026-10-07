import { goBack } from '@/utils/navigation';
import { Text, View } from 'react-native';
import {
  computeRent,
  getDeed,
  GROUP_LABELS,
  mortgageResolution,
  propertyActionBlocker,
  rentMultiplier,
  rentTable,
  sellBuildingRefund,
  unmortgageCost,
  type PropertyActionKind,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, Card, Label, Pill, PlayerBadge, Screen } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

export function PropertyView({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const { state } = view.snapshot;
  const deed = getDeed(propertyKey);
  const prop = state.properties[propertyKey];
  const me = view.me;
  const lastDice = state.turn.roll?.total ?? 7;
  const currentRent = prop.ownerId ? computeRent(state, propertyKey, lastDice) : 0;
  const level = prop.hotel ? 4 : prop.houses;
  const groupTheme = PROPERTY_GROUP_THEME[deed.group];
  const owner = prop.ownerId ? state.players.find((p) => p.id === prop.ownerId) : undefined;

  const actions: { kind: PropertyActionKind; title: string; variant: 'primary' | 'secondary' | 'success' | 'danger' }[] = [];
  if (me && deed.kind === 'CITY') {
    actions.push({ kind: 'BUILD_HOUSE', title: `Build house ${formatINR(deed.houseCost)}`, variant: 'success' });
    actions.push({ kind: 'BUILD_HOTEL', title: `Build hotel ${formatINR(deed.hotelCost)}`, variant: 'success' });
    actions.push({ kind: 'SELL_BUILDING', title: `Sell ${prop.hotel ? 'hotel' : 'house'} +${formatINR(sellBuildingRefund(propertyKey, prop))}`, variant: 'secondary' });
  }
  const mortgage = mortgageResolution(prop);
  actions.push({
    kind: 'MORTGAGE_PROPERTY',
    title: mortgage.buildingValue > 0 ? `Mortgage +${formatINR(mortgage.payout)} (buildings returned)` : `Mortgage +${formatINR(mortgage.payout)}`,
    variant: 'secondary',
  });
  actions.push({ kind: 'UNMORTGAGE_PROPERTY', title: `Unmortgage ${formatINR(unmortgageCost(propertyKey))}`, variant: 'primary' });
  actions.push({ kind: 'SELL_PROPERTY', title: `Sell to bank +${formatINR(deed.mortgageValue)}`, variant: 'danger' });
  // Only show what the player can actually do right now.
  const allowed = me ? actions.filter((a) => propertyActionBlocker(state, me.id, propertyKey, a.kind) === null) : [];

  return (
    <Screen scroll testID="property-screen">
      <Button size="sm" variant="ghost" title="‹ Back" onPress={() => goBack(`/game/${view.snapshot.state.id}`)} className="self-start" />
      <Card className="overflow-hidden p-0">
        <View style={{ backgroundColor: groupTheme.color }} className="items-center px-4 py-5" testID="property-deed-header">
          <Text style={{ color: groupTheme.onColor }} className="text-xs font-extrabold uppercase tracking-[4px] opacity-80">{GROUP_LABELS[deed.group]}</Text>
          <Text style={{ color: groupTheme.onColor }} className="text-3xl font-black">{deed.name}</Text>
        </View>
        <View className="gap-3 p-5">
          <View className="flex-row justify-between">
            <View>
              <Label>Owner</Label>
              <View className="flex-row items-center gap-2">
                {owner ? <PlayerBadge player={owner} size={20} testID="property-owner-badge" /> : null}
                <Text className="text-lg font-bold text-ink">{prop.ownerId ? view.playerName(prop.ownerId) : 'Bank (unowned)'}</Text>
              </View>
            </View>
            <View className="items-end">
              <Label>Price</Label>
              <Text className="text-lg font-bold text-ink">{formatINR(deed.price)}</Text>
            </View>
          </View>
          {prop.mortgaged ? <Pill tone="bad">Mortgaged — no rent</Pill> : null}
          {prop.ownerId ? (
            <View>
              <Label>Current rent</Label>
              <Text className="text-2xl font-black text-ink" testID="current-rent">
                {deed.kind === 'TRANSPORT_UTILITY' && deed.rent.type === 'DICE_MULTIPLIER' ? `${formatINR(currentRent)} on a ${lastDice}` : formatINR(currentRent)}
              </Text>
              {rentMultiplier(state, propertyKey) > 1 && currentRent > 0 ? (
                <Text className="text-sm font-bold text-green-700" testID="rent-doubled">
                  ×2 — owner has 3+ {GROUP_LABELS[deed.group]} properties
                </Text>
              ) : null}
            </View>
          ) : null}
          <View className="gap-1 rounded-2xl bg-white p-3">
            {rentTable(propertyKey).map((row, i) => {
              const active = prop.ownerId && deed.kind === 'CITY' && i === level;
              const amount = /^\d+$/.test(row.amount) ? formatINR(Number(row.amount)) : row.amount;
              return (
                <View key={row.label} className={`flex-row justify-between rounded-lg px-2 py-1 ${active ? 'bg-amber-100' : ''}`}>
                  <Text className="text-base text-stone-700">{row.label}</Text>
                  <Text className="text-base font-bold text-ink">{amount}</Text>
                </View>
              );
            })}
          </View>
          <View className="flex-row flex-wrap gap-x-6 gap-y-2">
            {deed.kind === 'CITY' ? (
              <>
                <Info label="House cost" value={formatINR(deed.houseCost)} />
                <Info label="Hotel cost" value={formatINR(deed.hotelCost)} />
                <Info label="Built" value={prop.hotel ? 'Hotel' : `${prop.houses} house${prop.houses === 1 ? '' : 's'}`} />
              </>
            ) : null}
            <Info label="Mortgage value" value={formatINR(deed.mortgageValue)} />
          </View>
        </View>
      </Card>
      {allowed.length ? (
        <View className="gap-3">
          {allowed.map((a) => (
            <Button
              key={a.kind}
              title={a.title}
              size="md"
              variant={a.variant}
              testID={`action-${a.kind}`}
              disabled={!!pending}
              loading={pending === a.kind}
              onPress={() => send({ type: a.kind, propertyKey })}
            />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</Text>
      <Text className="text-base font-bold text-ink">{value}</Text>
    </View>
  );
}
