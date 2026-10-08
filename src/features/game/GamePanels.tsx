import { memo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { GameAction, GameEventRecord } from '@/engine/index.ts';
import { Button, Card, Label, PlayerBadge } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import type { GameView } from './useGameView';

/** What happened lately, newest first (the "Game log" sheet). */
export const EventFeed = memo(function EventFeed({ events, limit = 3 }: { events: GameEventRecord[]; limit?: number }) {
  const shown = events.slice(0, limit);
  if (!shown.length) return <Text className="text-base text-stone-500">Nothing has happened yet.</Text>;
  return (
    <View className="gap-2" testID="event-feed" accessibilityLiveRegion="polite">
      {shown.map((e, i) => (
        <Text key={e.id} className={i === 0 ? 'text-base font-bold text-ink' : 'text-sm text-stone-600'}>
          {i === 0 ? '• ' : ''}
          {e.message}
        </Text>
      ))}
    </View>
  );
});

/**
 * Everyone at the table, one compact chip each: colour + name, balance, whose
 * turn. Scrolls sideways when there are many players; never wraps into rows.
 */
export const PlayersStrip = memo(function PlayersStrip({ view, onSelect }: { view: GameView; onSelect?: (playerId: string) => void }) {
  const online = useGameStore((s) => s.onlinePlayerIds);
  const { state } = view.snapshot;
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  // Up to four players share the width equally; more than that scroll sideways.
  const fit = players.length <= 4;
  const Strip = fit ? View : ScrollView;
  const stripProps = fit
    ? { style: { flexDirection: 'row' as const, gap: 6 } }
    : { horizontal: true, showsHorizontalScrollIndicator: false, contentContainerStyle: { flexGrow: 1, gap: 6 }, style: { flexGrow: 0 } };
  return (
    <Strip testID="players-strip" {...stripProps}>
      {players.map((p) => {
        const isTurn = p.id === state.turn.playerId && state.status === 'ACTIVE';
        const isMe = p.id === view.me?.id;
        const isOnline = online.includes(p.id) || isMe;
        const status = p.status === 'BANKRUPT' ? null : p.inJail ? `In Jail · ${p.jailTurnsLeft} left` : p.skipTurns > 0 ? 'Resting' : null;
        const tag = p.status === 'BANKRUPT' ? null : p.inJail ? '🔒 Jail' : p.skipTurns > 0 ? '🛏️ Rest' : null;
        return (
          <Pressable
            key={p.id}
            onPress={() => (onSelect ? onSelect(p.id) : router.push(`/player/${p.id}`))}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}${isMe ? ' (you)' : ''}, ${p.status === 'BANKRUPT' ? 'bankrupt' : formatINR(p.balance)}${status ? `, ${status}` : ''}${isTurn ? ', current turn' : ''}${isOnline ? '' : ', offline'}`}
            testID={`player-chip-${p.id}`}
            style={fit ? { flex: 1, flexBasis: 0, minWidth: 0 } : { minWidth: 96, flexGrow: 1 }}
            className={`min-h-[44px] justify-center rounded-xl px-2.5 py-1 ${isTurn ? 'border-2 border-saffron bg-felt-light' : 'border-2 border-transparent bg-felt-dark'} ${p.status === 'BANKRUPT' ? 'opacity-40' : ''}`}
          >
            <View className="flex-row items-center gap-1.5">
              <PlayerBadge player={p} size={16} testID={`player-badge-${p.name}`} />
              <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className="shrink text-xs font-bold text-cream">
                {/* On my own phone my chip just says "You" — unmistakable, and it never truncates. */}
                {isMe ? 'You' : p.name}
              </Text>
              {isOnline ? null : <View className="h-1.5 w-1.5 rounded-full bg-stone-500" />}
            </View>
            <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className="text-[13px] font-extrabold text-cream">
              {p.status === 'BANKRUPT' ? 'Bankrupt' : formatINR(p.balance)}
              {tag ? <Text className="text-[10px] font-bold text-amber-300"> {tag}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </Strip>
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
