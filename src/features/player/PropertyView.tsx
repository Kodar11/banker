import { goBack } from '@/utils/navigation';
import type { PropertyKey } from '@/engine/index.ts';
import { Button, Screen } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { PropertyDeed } from './PropertyDeed';
import { PropertyManage } from './PropertyManage';

/** The property as a full screen (from the wallet's list or a link): the same deed + manage section as the in-game sheet. */
export function PropertyView({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  return (
    <Screen scroll testID="property-screen">
      <Button size="sm" variant="ghost" title="‹ Back" onPress={() => goBack(`/game/${view.snapshot.state.id}`)} className="self-start" />
      <PropertyDeed state={view.snapshot.state} propertyKey={propertyKey} playerName={view.playerName}>
        <PropertyManage view={view} propertyKey={propertyKey} />
      </PropertyDeed>
    </Screen>
  );
}
