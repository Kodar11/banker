import { useLocalSearchParams } from 'expo-router';
import { AuctionView } from '@/features/auction/AuctionView';
import { GameGate } from '@/features/game/GameGate';
import { useSessionStore } from '@/store/sessionStore';

export default function AuctionRoute() {
  const { auctionId } = useLocalSearchParams<{ auctionId: string }>();
  const gameId = useSessionStore((s) => s.session?.gameId ?? '');
  return (
    <GameGate gameId={gameId} area="any">
      {(view) => <AuctionView view={view} auctionId={auctionId} />}
    </GameGate>
  );
}
