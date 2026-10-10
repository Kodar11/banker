import { GameGate } from '@/features/game/GameGate';
import { InsuranceView } from '@/features/insurance/InsuranceView';
import { useSessionStore } from '@/store/sessionStore';

/** More → Property Insurance (Intermediate Mode). */
export default function InsuranceRoute() {
  const gameId = useSessionStore((s) => s.session?.gameId ?? '');
  return (
    <GameGate gameId={gameId} area="any">
      {(view) => <InsuranceView view={view} />}
    </GameGate>
  );
}
