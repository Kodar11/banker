import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { computeRent, getDeed, GROUP_LABELS, isIntermediate, purchasePrice, rentMultiplier, rentTable, type GameState, type PropertyKey } from '@/engine/index.ts';
import { Button, Card, Label, Pill, PlayerBadge } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { PropertyValuation } from '@/features/finance/PropertyValuation';
import { formatINR } from '@/utils/currency';

interface PropertyDeedProps {
  state: GameState;
  propertyKey: PropertyKey;
  playerName: (id: string | null) => string;
  /** When set, the owner gets a "View <name>" button (read-only navigation). */
  onOwnerPress?: (playerId: string) => void;
  /** Continues the same card under the deed (the owner's manage section). */
  children?: ReactNode;
}

/**
 * The title deed: price, owner, rent table, buildings and mortgage state.
 * Informational itself — shared by the property screen and the board's details sheet;
 * anything the owner can do is passed in as children.
 */
export function PropertyDeed({ state, propertyKey, playerName, onOwnerPress, children }: PropertyDeedProps) {
  const deed = getDeed(propertyKey);
  const prop = state.properties[propertyKey];
  const lastDice = state.turn.roll?.total ?? 7;
  const currentRent = prop.ownerId ? computeRent(state, propertyKey, lastDice) : 0;
  const level = prop.hotel ? 4 : prop.houses;
  const groupTheme = PROPERTY_GROUP_THEME[deed.group];
  const owner = prop.ownerId ? state.players.find((p) => p.id === prop.ownerId) : undefined;

  return (
    <Card className="overflow-hidden p-0" testID="property-deed">
      <View style={{ backgroundColor: groupTheme.color }} className="items-center px-4 py-5" testID="property-deed-header">
        <Text style={{ color: groupTheme.onColor }} className="text-xs font-extrabold uppercase tracking-[4px] opacity-80">
          {GROUP_LABELS[deed.group]}
        </Text>
        <Text style={{ color: groupTheme.onColor }} className="text-3xl font-black">
          {deed.name}
        </Text>
      </View>
      <View className="gap-3 p-5">
        <View className="flex-row justify-between">
          <View className="flex-1">
            <Label>Owner</Label>
            <View className="flex-row items-center gap-2">
              {owner ? <PlayerBadge player={owner} size={20} plain testID="property-owner-badge" /> : null}
              <Text className="text-lg font-bold text-ink" testID="property-owner">
                {prop.ownerId ? `Owned by ${playerName(prop.ownerId)}` : 'Available · Bank'}
              </Text>
            </View>
          </View>
          <View className="items-end">
            <Label>{isIntermediate(state) ? 'Market price' : 'Price'}</Label>
            <Text className="text-lg font-bold text-ink" testID="property-price">
              {formatINR(purchasePrice(state, propertyKey))}
            </Text>
          </View>
        </View>
        {owner && onOwnerPress ? (
          <Button size="sm" variant="secondary" title={`View ${owner.name}`} testID="property-view-owner" onPress={() => onOwnerPress(owner.id)} />
        ) : null}
        {prop.mortgaged ? <Pill tone="bad">Mortgaged — no rent</Pill> : null}
        <PropertyValuation state={state} propertyKey={propertyKey} />
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
        <View className="gap-1 rounded-2xl bg-white p-3" testID="rent-table">
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
              <Info label="Built" value={prop.hotel ? 'Hotel' : `${prop.houses} house${prop.houses === 1 ? '' : 's'}`} testID="property-built" />
            </>
          ) : null}
          <Info label="Mortgage value" value={formatINR(deed.mortgageValue)} />
        </View>
        {children}
      </View>
    </Card>
  );
}

function Info({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View testID={testID}>
      <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</Text>
      <Text className="text-base font-bold text-ink">{value}</Text>
    </View>
  );
}
