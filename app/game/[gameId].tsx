import { useLocalSearchParams } from 'expo-router';
import { GameGate } from '@/features/game/GameGate';
import { GameScreen } from '@/features/game/GameScreen';

export default function GameRoute() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  return (
    <GameGate gameId={gameId} area="game">
      {(view) => <GameScreen view={view} />}
    </GameGate>
  );
}
