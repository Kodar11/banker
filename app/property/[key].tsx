import { goBack } from '@/utils/navigation';
import { useLocalSearchParams } from 'expo-router';
import { isPropertyKey } from '@/engine/index.ts';
import { Button, ErrorState } from '@/components/ui';
import { GameGate } from '@/features/game/GameGate';
import { PropertyView } from '@/features/player/PropertyView';
import { useSessionStore } from '@/store/sessionStore';

export default function PropertyRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const gameId = useSessionStore((s) => s.session?.gameId ?? '');
  if (!key || !isPropertyKey(key)) {
    return <ErrorState title="Unknown property" message="That property isn't on this board." action={<Button title="Back" onPress={() => goBack('/')} />} />;
  }
  return (
    <GameGate gameId={gameId} area="any">
      {(view) => <PropertyView view={view} propertyKey={key} />}
    </GameGate>
  );
}
