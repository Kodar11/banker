import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui';
import { leaveGame } from './leaveGame';
import { useGameAction } from './useGameAction';
import { useGameView, type GameView } from './useGameView';

/** Refusals that mean there is nothing left to leave on the server: this phone can simply let go. */
const ALREADY_OUT: ReadonlySet<string> = new Set(['FORBIDDEN', 'NOT_FOUND', 'GAME_EXPIRED', 'GAME_FINISHED']);

/**
 * What leaving does, in the words of the confirmation — worked out from the same rules the server
 * applies (engine: leaveTable), so the dialog never promises more than will happen.
 */
export function leaveConsequence(view: Pick<GameView, 'snapshot' | 'me'> | null): { message: string; detail?: string } {
  const home = 'You’ll leave this game and return to the home screen.';
  if (!view?.me) return { message: home };
  const { state } = view.snapshot;
  const me = view.me;
  const others = state.players.filter((p) => p.id !== me.id && p.status === 'ACTIVE').sort((a, b) => a.seat - b.seat);
  const heir = me.isHost ? others[0] : undefined;
  const newHost = heir ? ` ${heir.name} becomes the host.` : '';
  if (state.status === 'WAITING') {
    return { message: 'You’ll leave this lobby and return to the home screen.', detail: others.length ? newHost.trim() || undefined : 'Nobody else is here, so the lobby closes.' };
  }
  if (me.status !== 'ACTIVE') return { message: home, detail: `The other players keep playing.${newHost}` };
  if (others.length < 2) {
    return { message: home, detail: others[0] ? `Only two players are left, so the game ends and ${others[0].name} wins.` : 'Nobody else is playing, so the game ends.' };
  }
  return { message: `${home} The other players keep playing.`, detail: `You can’t rejoin. Your cash and properties stay in your name.${newHost}` };
}

/**
 * "Leave this game?" for any player. The server is told first (LEAVE_GAME); only once it has
 * recorded the departure does this phone forget the game and go Home. If the request fails the
 * player is still in the game: the dialog stays open with the reason and can be retried.
 */
export function LeaveGameDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const send = useGameAction();
  const view = useGameView();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = leaveConsequence(view);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await send({ type: 'LEAVE_GAME' }, { silent: true });
    if (res.ok || ALREADY_OUT.has(res.error.code)) {
      leaveGame();
      return;
    }
    setBusy(false);
    setError(res.error.message);
  };

  return (
    <ConfirmDialog
      visible={visible}
      title="Leave this game?"
      message={copy.message}
      detail={copy.detail}
      confirmTitle="Leave Game"
      destructive
      loading={busy}
      error={error}
      testID="leave-dialog"
      onCancel={() => {
        setError(null);
        onClose();
      }}
      onConfirm={confirm}
    />
  );
}
