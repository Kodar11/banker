import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  BUSINESS_MVP_RULES,
  getDeed,
  mortgageResolution,
  propertyActionBlocker,
  sellBuildingRefund,
  unmortgageCost,
  type PropertyActionKind,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, Label } from '@/components/ui';
import type { ButtonProps } from '@/components/ui/Button';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

interface ManageAction {
  kind: PropertyActionKind;
  title: string;
  variant: NonNullable<ButtonProps['variant']>;
  note?: string;
  /** Why the referee would refuse it right now (propertyActionBlocker), or null. */
  why: string | null;
}

/**
 * "Manage property": build, mortgage and sell for a property I own, placed inside its deed.
 * Renders nothing for anyone else's (or the bank's) property. Which actions apply and whether
 * they are allowed comes from the engine; every tap is still decided by the server.
 */
export function PropertyManage({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  /** The last refusal, kept next to the buttons (a toast can sit behind the sheet). */
  const [failure, setFailure] = useState<{ key: PropertyKey; message: string } | null>(null);
  const { state } = view.snapshot;
  const me = view.me;
  const prop = state.properties[propertyKey];
  if (!me || prop.ownerId !== me.id) return null;

  const deed = getDeed(propertyKey);
  const why = (kind: PropertyActionKind) => propertyActionBlocker(state, me.id, propertyKey, kind);
  const actions: ManageAction[] = [];
  if (deed.kind === 'CITY') {
    const built = prop.hotel || prop.houses > 0;
    if (!prop.hotel) {
      const housesFull = prop.houses >= BUSINESS_MVP_RULES.building.maxHouses;
      if (!housesFull) actions.push({ kind: 'BUILD_HOUSE', title: `Build House · ${formatINR(deed.houseCost)}`, variant: 'primary', why: why('BUILD_HOUSE') });
      if (housesFull || why('BUILD_HOTEL') === null) {
        actions.push({ kind: 'BUILD_HOTEL', title: `Build Hotel · ${formatINR(deed.hotelCost)}`, variant: 'primary', why: why('BUILD_HOTEL') });
      }
    }
    if (built) {
      actions.push({
        kind: 'SELL_BUILDING',
        title: `Sell ${prop.hotel ? 'Hotel' : 'House'} · +${formatINR(sellBuildingRefund(propertyKey, prop))}`,
        variant: 'secondary',
        why: why('SELL_BUILDING'),
      });
    }
  }
  if (prop.mortgaged) {
    actions.push({ kind: 'UNMORTGAGE_PROPERTY', title: `Unmortgage · ${formatINR(unmortgageCost(propertyKey))}`, variant: 'primary', why: why('UNMORTGAGE_PROPERTY') });
  } else {
    const mortgage = mortgageResolution(prop);
    actions.push({
      kind: 'MORTGAGE_PROPERTY',
      title: `Mortgage · +${formatINR(mortgage.payout)}`,
      variant: 'secondary',
      note: mortgage.buildingValue > 0 ? 'Includes the buildings, which go back to the bank.' : undefined,
      why: why('MORTGAGE_PROPERTY'),
    });
  }
  actions.push({ kind: 'SELL_PROPERTY', title: `Sell to Bank · +${formatINR(deed.mortgageValue)}`, variant: 'outline', why: why('SELL_PROPERTY') });

  // One reason for everything (paused, auction running, out of the game) is said once, not under every button.
  const shared = actions.every((a) => a.why !== null && a.why === actions[0]!.why) ? actions[0]!.why : null;

  return (
    <View className="mt-1 gap-3 border-t border-stone-200 pt-4" testID="property-manage">
      <Label>Manage property</Label>
      {shared ? (
        <Text className="text-sm font-semibold text-stone-600" testID="property-manage-blocked">
          {shared}
        </Text>
      ) : null}
      {actions.map((a) => {
        const caption = shared ? null : (a.why ?? a.note ?? null);
        return (
          <View key={a.kind} className="gap-1">
            <Button
              title={a.title}
              size="md"
              variant={a.variant}
              testID={`action-${a.kind}`}
              disabled={!!a.why || !!pending}
              loading={pending === a.kind}
              onPress={async () => {
                setFailure(null);
                const res = await send({ type: a.kind, propertyKey });
                if (!res.ok) setFailure({ key: propertyKey, message: res.error.message });
              }}
            />
            {caption ? (
              <Text className="text-center text-xs font-semibold text-stone-600" testID={`action-note-${a.kind}`}>
                {caption}
              </Text>
            ) : null}
          </View>
        );
      })}
      {failure && failure.key === propertyKey ? (
        <Text className="text-center text-sm font-bold text-brick" accessibilityRole="alert" testID="property-manage-error">
          {failure.message}
        </Text>
      ) : null}
    </View>
  );
}
