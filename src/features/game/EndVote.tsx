import { useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import {
  durationLabel,
  durationLimit,
  earlyVotesRequired,
  END_VOTE_SECONDS,
  openEndVote,
  type EndVote,
  type EndVoteChoice,
  type EndVoteResult,
} from '@/engine/index.ts';
import { Button, ConfirmDialog } from '@/components/ui';
import { serverNow } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';
import { sendFailure, useGameAction } from './useGameAction';
import { useGameView, type GameView } from './useGameView';

const TICK_MS = 250;
const MAX_CLOSE_ATTEMPTS = 5;
/** How long the result stays up if nobody dismisses it. */
export const RESULT_SHOWN_MS = 6000;

/** What each vote asks, in the players' words. The two choices are the same two ballots in both. */
const COPY = {
  EARLY: { title: 'End this game early?', body: 'A strict majority must vote to end the game.', end: 'End Game', go: 'Continue Playing' },
  DURATION: { title: 'What should happen next?', body: 'Your selected game duration has ended.', end: 'End Game', go: 'Play One More Financial Year' },
} as const;

const RESULT_COPY: Record<EndVoteResult['outcome'], { icon: string; title: string }> = {
  ENDED: { icon: '🏁', title: 'Game ending approved' },
  CONTINUED: { icon: '▶️', title: 'Game will continue' },
  EXTENDED: { icon: '📅', title: 'The game will extend by one financial year' },
};

/**
 * Where the vote stands against its server deadline. Nothing counts ticks: both values are
 * recomputed from the stored deadline and the server clock every time, so a remount, a reconnect or
 * a restart of the app can't restart or shift the countdown. Display only — the server decides.
 */
function useVoteClock(endsAt: string | null): { secondsLeft: number; due: boolean } {
  const read = () => {
    const left = endsAt ? Date.parse(endsAt) - serverNow() : 0;
    return { secondsLeft: Math.max(0, Math.ceil(left / 1000)), due: !!endsAt && left <= 0 };
  };
  const [clock, setClock] = useState(read);
  const [seen, setSeen] = useState(endsAt);
  if (seen !== endsAt) {
    // A new deadline from the server (the game was resumed): show it at once, not at the next tick.
    setSeen(endsAt);
    setClock(read());
  }
  useEffect(() => {
    if (!endsAt) return;
    const timer = setInterval(() => {
      const next = read();
      setClock((prev) => (prev.secondsLeft === next.secondsLeft && prev.due === next.due ? prev : next));
    }, TICK_MS);
    return () => clearInterval(timer);
    // \`read\` only depends on endsAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt]);
  return clock;
}

/**
 * The vote on ending the game, as this player sees it: the question, the two choices, the time left
 * and — once cast — their own ballot. Nothing about anyone else's: this phone is never sent another
 * player's ballot, nor how many have voted. A temporary card over the table; the board is not replaced.
 */
function VoteCard({ view, vote }: { view: GameView; vote: EndVote }) {
  const send = useGameAction();
  const { state } = view.snapshot;
  const me = view.me;
  const paused = state.status === 'PAUSED';
  const { secondsLeft, due } = useVoteClock(paused ? null : vote.endsAt);
  const pending = useGameStore((s) => s.pendingAction);
  const [attempts, setAttempts] = useState<{ endsAt: string; n: number }>({ endsAt: vote.endsAt, n: 0 });
  const closeAttempt = attempts.endsAt === vote.endsAt ? attempts.n : 0;
  const canAct = me?.status === 'ACTIVE';

  // The server closes the vote itself when the deadline passes. As a backstop, any active player's
  // device showing it may also ask; the server checks its own clock and settles the vote exactly
  // once (the others are told it has closed). If it says "still open" (clock skew) or the request
  // didn't go through, try again shortly — until the update arrives.
  useEffect(() => {
    if (!due || paused || !canAct || closeAttempt >= MAX_CLOSE_ATTEMPTS) return;
    let cancelled = false;
    const delay = closeAttempt === 0 ? 300 + (me?.seat ?? 0) * 300 : 1000;
    const timer = setTimeout(async () => {
      const res = await send({ type: 'CLOSE_END_VOTE', voteId: vote.id }, { silent: true });
      if (!cancelled && !res.ok && res.error.code !== 'VOTE_CLOSED') setAttempts({ endsAt: vote.endsAt, n: closeAttempt + 1 });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [due, paused, canAct, closeAttempt, send, vote.id, vote.endsAt, me?.seat]);

  const copy = COPY[vote.kind];
  const mine: EndVoteChoice | undefined = me ? vote.ballots[me.id] : undefined;
  const elector = !!me && canAct && vote.electorate.includes(me.id);
  const cast = (choice: EndVoteChoice) => void send({ type: 'CAST_END_VOTE', voteId: vote.id, choice });
  const asker = vote.requestedBy ? (vote.requestedBy === me?.id ? 'You' : view.playerName(vote.requestedBy)) : null;
  const need = `${vote.required} of ${vote.electorate.length} players must vote to end.`;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => undefined}>
      <View className="flex-1 items-center justify-center bg-black/60 px-5">
        <View className="w-full max-w-[420px] gap-3 rounded-3xl bg-cream p-5" testID="end-vote" accessibilityViewIsModal>
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-extrabold uppercase tracking-[3px] text-stone-500">Vote</Text>
            <Text
              className="text-lg font-black text-ink"
              testID="end-vote-countdown"
              accessibilityRole="timer"
              accessibilityLabel={paused ? 'Paused' : `${secondsLeft} seconds left`}
            >
              {paused ? 'Paused' : `0:${String(secondsLeft).padStart(2, '0')}`}
            </Text>
          </View>
          <Text className="text-center text-2xl font-black text-ink" accessibilityRole="header" testID="end-vote-title">
            {copy.title}
          </Text>
          <Text className="text-center text-base font-semibold text-stone-700">{copy.body}</Text>
          <Text className="text-center text-xs text-stone-500" testID="end-vote-detail">
            {asker ? `${asker} asked for this vote. ` : ''}
            {need} Votes are secret.
          </Text>
          {mine ? (
            <View className="items-center gap-1 rounded-2xl bg-white px-4 py-3" testID="end-vote-mine" accessible accessibilityLabel={`Your vote: ${mine === 'END' ? copy.end : copy.go}`}>
              <Text className="text-xs font-extrabold uppercase tracking-[2px] text-stone-500">Your vote</Text>
              <Text className="text-center text-lg font-black text-ink">{mine === 'END' ? copy.end : copy.go}</Text>
              <Text className="text-center text-xs text-stone-500">Submitted. Waiting for the other players.</Text>
            </View>
          ) : elector ? (
            <View className="gap-2">
              <Button size="md" variant="danger" title={copy.end} testID="end-vote-end" disabled={paused || due} loading={pending === 'CAST_END_VOTE'} onPress={() => cast('END')} />
              <Button size="md" variant="secondary" title={copy.go} testID="end-vote-continue" disabled={paused || due || pending === 'CAST_END_VOTE'} onPress={() => cast('CONTINUE')} />
            </View>
          ) : (
            <Text className="text-center text-sm text-stone-600" testID="end-vote-watching">
              The active players are voting.
            </Text>
          )}
          {due && !paused ? <Text className="text-center text-xs text-stone-500">Voting has ended. Counting…</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

/** How the vote ended — the outcome only, never who voted for what. Goes away by itself. */
function ResultCard({ view, result, onDone }: { view: GameView; result: EndVoteResult; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, RESULT_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [onDone, result.id]);
  const copy = RESULT_COPY[result.outcome];
  const state = view.snapshot.state;
  const detail =
    result.outcome === 'ENDED'
      ? 'Highest net worth wins.'
      : result.outcome === 'EXTENDED'
        ? `The game now runs for ${durationLabel(durationLimit(state))}.`
        : 'Not enough players voted to end. Play goes on.';
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onDone}>
      <View className="flex-1 items-center justify-center bg-black/60 px-5">
        <View className="w-full max-w-[420px] items-center gap-3 rounded-3xl bg-cream p-5" testID="end-vote-result" accessibilityViewIsModal>
          <Text className="text-5xl">{copy.icon}</Text>
          <Text className="text-center text-2xl font-black text-ink" accessibilityRole="header" testID="end-vote-result-title">
            {copy.title}
          </Text>
          <Text className="text-center text-sm text-stone-600">{detail}</Text>
          <Button className="self-stretch" size="md" title="OK" testID="end-vote-result-ok" onPress={onDone} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * The vote overlay for the game this phone is in, mounted once above every screen (root layout), so
 * a vote reaches a player on the table, in their wallet or in the rulebook alike. What it shows comes
 * from the server's state alone: reopening the app in the middle of a vote shows the same vote, the
 * same deadline and the player's own ballot.
 */
export function EndVoteHost() {
  const view = useGameView();
  const state = view?.snapshot.state;
  const vote = state ? openEndVote(state) : null;
  const result = state?.endGame?.lastResult ?? null;
  /** The vote this phone has shown: its result is announced here once, and not to a phone that never saw it open. */
  const [shownId, setShownId] = useState<string | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  if (vote && shownId !== vote.id) setShownId(vote.id);

  if (!view || !view.me || !state || state.status === 'WAITING' || view.me.status === 'LEFT') return null;
  if (vote) return <VoteCard key={vote.id} view={view} vote={vote} />;
  if (result && result.id === shownId && dismissedId !== result.id) {
    return <ResultCard view={view} result={result} onDone={() => setDismissedId(result.id)} />;
  }
  return null;
}

/**
 * "Request an end-game vote?" — asked from the More sheet before anything is sent, because asking
 * uses up the player's one request for this financial year. If the server refuses (a move began
 * meanwhile, someone else just asked) the dialog stays open with its reason.
 */
export function RequestEndVoteDialog({ visible, players, onClose, onRequested }: { visible: boolean; players: number; onClose: () => void; onRequested: () => void }) {
  const send = useGameAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = sendFailure(await send({ type: 'REQUEST_END_VOTE' }, { silent: true }));
    setBusy(false);
    if (failure === null) onRequested();
    else setError(failure);
  };
  return (
    <ConfirmDialog
      visible={visible}
      icon="🗳️"
      title="Request an end-game vote?"
      message={`Every active player gets ${END_VOTE_SECONDS} seconds to vote. The game ends only if ${earlyVotesRequired(players)} of ${players} vote to end.`}
      detail="You can ask once per financial year. Asking counts as your own vote to end."
      confirmTitle="Start Vote"
      intent="warning"
      loading={busy}
      error={error}
      testID="end-vote-dialog"
      onCancel={() => {
        setError(null);
        onClose();
      }}
      onConfirm={confirm}
    />
  );
}
