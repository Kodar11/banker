import { goBack } from '@/utils/navigation';
import { View } from 'react-native';
import {
  getDeed,
  mortgageResolution,
  propertyActionBlocker,
  sellBuildingRefund,
  unmortgageCost,
  type PropertyActionKind,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, Screen } from '@/components/ui';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { PropertyDeed } from './PropertyDeed';

export function PropertyView({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const { state } = view.snapshot;
  const deed = getDeed(propertyKey);
  const prop = state.properties[propertyKey];
  const me = view.me;

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
      <PropertyDeed state={state} propertyKey={propertyKey} playerName={view.playerName} />
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

