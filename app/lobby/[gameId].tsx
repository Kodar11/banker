import { useLocalSearchParams } from 'expo-router';
import { GameGate } from '@/features/game/GameGate';
import { LobbyView } from '@/features/lobby/LobbyView';

export default function LobbyRoute() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  return (
    <GameGate gameId={gameId} area="lobby">
      {(view) => <LobbyView view={view} />}
    </GameGate>
  );
}
