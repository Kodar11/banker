import { useLocalSearchParams } from 'expo-router';
import { GameGate } from '@/features/game/GameGate';
import { PlayerView } from '@/features/player/PlayerView';
import { useSessionStore } from '@/store/sessionStore';

export default function PlayerRoute() {
  const { playerId } = useLocalSearchParams<{ playerId: string }>();
  const gameId = useSessionStore((s) => s.session?.gameId ?? '');
  return (
    <GameGate gameId={gameId} area="any">
      {(view) => <PlayerView view={view} playerId={playerId} />}
    </GameGate>
  );
}
