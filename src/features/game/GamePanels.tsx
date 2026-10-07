import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { GameAction, GameEventRecord } from '@/engine/index.ts';
import { Button, Card, Label } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import type { GameView } from './useGameView';

/** Latest few things that happened — one glance, then back to the board. */
export const EventFeed = memo(function EventFeed({ events, limit = 3 }: { events: GameEventRecord[]; limit?: number }) {
  const shown = events.slice(0, limit);
  if (!shown.length) return null;
  return (
    <View className="gap-1 px-1" testID="event-feed" accessibilityLiveRegion="polite">
      {shown.map((e, i) => (
        <Text key={e.id} numberOfLines={2} className={i === 0 ? 'text-base font-bold text-cream' : 'text-sm text-cream/60'}>
          {i === 0 ? '• ' : ''}
          {e.message}
        </Text>
      ))}
    </View>
  );
});

/** Compact list of everyone: whose turn, balance, online. */
export const PlayersStrip = memo(function PlayersStrip({ view }: { view: GameView }) {
  const online = useGameStore((s) => s.onlinePlayerIds);
  const { state } = view.snapshot;
  return (
    <View className="flex-row flex-wrap gap-2" testID="players-strip">
      {state.players.map((p) => {
        const isTurn = p.id === state.turn.playerId;
        const isOnline = online.includes(p.id) || p.id === view.me?.id;
        return (
          <Pressable
            key={p.id}
            onPress={() => router.push(`/player/${p.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}, ${formatINR(p.balance)}${p.status === 'BANKRUPT' ? ', bankrupt' : ''}${isOnline ? '' : ', offline'}`}
            className={`min-w-[30%] flex-1 rounded-2xl px-3 py-2 ${isTurn ? 'border-2 border-saffron bg-felt-light' : 'bg-felt-dark'} ${p.status === 'BANKRUPT' ? 'opacity-40' : ''}`}
          >
            <View className="flex-row items-center gap-1">
              <View className={`h-2 w-2 rounded-full ${isOnline ? 'bg-green-400' : 'bg-stone-500'}`} />
              <Text numberOfLines={1} className="flex-1 text-sm font-bold text-cream">
                {p.name}
                {p.isHost ? ' ★' : ''}
              </Text>
            </View>
            <Text className="text-base font-extrabold text-cream">{p.status === 'BANKRUPT' ? 'Bankrupt' : formatINR(p.balance)}</Text>
            {p.skipTurns > 0 ? <Text className="text-xs text-amber-300">{p.inJail ? 'In Jail' : 'Resting'}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
});

/** Undo approval flow: compensating transactions only, never history rewrites. */
export function UndoBanner({ view, send }: { view: GameView; send: (a: GameAction) => Promise<unknown> }) {
  const { state } = view.snapshot;
  const req = state.undoRequest;
  const me = view.me;
  if (!req || !me) return null;
  const canAnswer = req.approverIds.includes(me.id);
  const mine = req.requestedBy === me.id;
  if (!canAnswer && !mine) return null;
  return (
    <Card testID="undo-banner" className="border-amber-400 bg-amber-50">
      <Label>Undo request</Label>
      <Text className="mt-1 text-lg font-bold text-ink">
        {mine ? 'You asked to undo:' : `${view.playerName(req.requestedBy)} wants to undo:`} {req.description}
      </Text>
      <View className="mt-3 flex-row gap-3">
        {canAnswer ? (
          <>
            <Button className="flex-1" size="md" variant="success" title="Approve" testID="undo-approve" onPress={() => send({ type: 'APPROVE_UNDO', requestId: req.id })} />
            <Button className="flex-1" size="md" variant="secondary" title="Reject" testID="undo-reject" onPress={() => send({ type: 'REJECT_UNDO', requestId: req.id })} />
          </>
        ) : (
          <Button className="flex-1" size="md" variant="secondary" title="Cancel request" onPress={() => send({ type: 'REJECT_UNDO', requestId: req.id })} />
        )}
      </View>
    </Card>
  );
}

export function PausedView({ view, send }: { view: GameView; send: (a: GameAction) => Promise<unknown> }) {
  const pending = useGameStore((s) => s.pendingAction);
  return (
    <Card testID="paused-card" className="items-center">
      <Text className="text-6xl">⏸️</Text>
      <Text className="mt-2 text-3xl font-black text-ink">Game paused</Text>
      <Text className="mt-1 text-center text-base text-stone-600">No dice, purchases or payments until someone resumes.</Text>
      <Button
        className="mt-4 self-stretch"
        title="RESUME GAME"
        testID="resume-button"
        loading={pending === 'RESUME_GAME'}
        onPress={() => send({ type: 'RESUME_GAME' })}
      />
      {view.isHost ? (
        <Button className="mt-3 self-stretch" size="sm" variant="secondary" title="End game now" testID="end-game-button" onPress={() => send({ type: 'END_GAME' })} />
      ) : null}
    </Card>
  );
}

export function FinishedView({ view }: { view: GameView }) {
  const { state, events } = view.snapshot;
  const finished = events.find((e) => e.type === 'GAME_FINISHED');
  const standings = (finished?.payload.standings as { playerId: string; netWorth: number }[] | undefined) ?? [];
  const winner = view.playerName(state.winnerId);
  return (
    <Card testID="finished-card" className="items-center">
      <Text className="text-6xl">🏆</Text>
      <Text className="mt-2 text-center text-3xl font-black text-ink">{state.winnerId ? `${winner} wins!` : 'Game over'}</Text>
      <View className="mt-4 gap-2 self-stretch">
        {standings.map((s, i) => (
          <View key={s.playerId} className="flex-row justify-between rounded-xl bg-white px-4 py-3">
            <Text className="text-lg font-bold text-ink">
              {i + 1}. {view.playerName(s.playerId)}
            </Text>
            <Text className="text-lg font-bold text-ink">{formatINR(s.netWorth)}</Text>
          </View>
        ))}
      </View>
      <Text className="mt-3 text-center text-xs text-stone-500">Net worth = cash + property at cost + buildings − loans owed</Text>
    </Card>
  );
}
