import { memo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { canSeeFinances, type GameAction, type PlayerState } from '@/engine/index.ts';
import { Button, Card, InfoTip, Label, PlayerBadge } from '@/components/ui';
import { ObjectiveResults } from '@/features/objectives/ObjectiveCard';
import { ChipReaction } from '@/features/quickChat/QuickChatOverlays';
import { useVoicePresence, VoiceIndicator, voicePresenceLabel } from '@/features/voice/VoiceIndicator';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { finalResult } from './finalResult';
import type { GameView } from './useGameView';

/**
 * Everyone at the table, one compact chip each: colour + name, balance (their own
 * only, in a game with hidden finances), whose turn. Scrolls sideways when there are many players; never wraps into rows.
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
        return <PlayerChip key={p.id} player={p} isTurn={isTurn} isMe={isMe} isOnline={isOnline} fit={fit} cashHidden={!canSeeFinances(state, view.me?.id, p.id)} onSelect={onSelect} />;
      })}
    </Strip>
  );
});

/** One player's chip. Its own component so that it alone redraws when that player starts or stops talking. */
function PlayerChip({ player: p, isTurn, isMe, isOnline, fit, cashHidden, onSelect }: { player: PlayerState; isTurn: boolean; isMe: boolean; isOnline: boolean; fit: boolean; cashHidden: boolean; onSelect?: (playerId: string) => void }) {
  // Empty for everyone in a game without voice.
  const voice = voicePresenceLabel(useVoicePresence(p.seat, isMe));
  const out = p.status === 'BANKRUPT' ? 'Bankrupt' : p.status === 'LEFT' ? 'Left' : null;
  const status = out ? null : p.inJail ? `In Jail · ${p.jailTurnsLeft} left` : p.skipTurns > 0 ? 'Resting' : null;
  const tag = out ? null : p.inJail ? '🔒 Jail' : p.skipTurns > 0 ? '🛏️ Rest' : null;
  // Hidden finances: the same line, in the same place, says so instead of a figure this phone was never sent.
  const cash = cashHidden ? 'Private' : formatINR(p.balance);
  return (
    <Pressable
      onPress={() => (onSelect ? onSelect(p.id) : router.push(`/player/${p.id}`))}
      accessibilityRole="button"
      accessibilityLabel={`${p.name}${isMe ? ' (you)' : ''}, ${out ? out.toLowerCase() : cashHidden ? 'cash private' : cash}${status ? `, ${status}` : ''}${isTurn ? ', current turn' : ''}${isOnline ? '' : ', offline'}${voice ? `, ${voice}` : ''}`}
      testID={`player-chip-${p.id}`}
      style={fit ? { flex: 1, flexBasis: 0, minWidth: 0 } : { minWidth: 96, flexGrow: 1 }}
      className={`min-h-[44px] justify-center rounded-xl px-2.5 py-1 ${isTurn ? 'border-2 border-saffron bg-felt-light' : 'border-2 border-transparent bg-felt-dark'} ${out ? 'opacity-40' : ''}`}
    >
      <View className="flex-row items-center gap-1.5">
        <PlayerBadge player={p} size={16} testID={`player-badge-${p.name}`} />
        <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className="shrink text-xs font-bold text-cream">
          {/* On my own phone my chip just says "You" — unmistakable, and it never truncates. */}
          {isMe ? 'You' : p.name}
        </Text>
        {isOnline ? null : <View className="h-1.5 w-1.5 rounded-full bg-stone-500" />}
        <VoiceIndicator playerId={p.id} seat={p.seat} isMe={isMe} />
      </View>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className="text-[13px] font-extrabold text-cream">
        {out ?? cash}
        {tag ? <Text className="text-[10px] font-bold text-amber-300"> {tag}</Text> : null}
      </Text>
      <ChipReaction playerId={p.id} />
    </Pressable>
  );
}

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
    <Card testID="undo-banner" className="border-b-4 border-amber-400 bg-amber-50">
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

/** The standings sheet of a finished game: the winner, everyone in the order the server ranked them, and (Capital) the objectives. */
export function FinishedView({ view }: { view: GameView }) {
  const { state } = view.snapshot;
  const result = finalResult(view.snapshot);
  const winner = view.playerName(result.winnerId);
  return (
    <>
      <Card testID="finished-card" className="gap-4">
        <View className="items-center">
          <Text className="text-5xl">{result.winnerId ? '🏆' : '🏁'}</Text>
          <Text className="mt-1 text-center text-3xl font-black text-ink" accessibilityRole="header">
            {result.winnerId ? `${winner} wins!` : 'Game over'}
          </Text>
          {result.winnerNetWorth === null ? null : (
            <Text className="mt-1 text-center text-base font-semibold text-stone-600" testID="finished-winner-worth">
              Final net worth <Text className="font-black text-felt">{formatINR(result.winnerNetWorth)}</Text>
            </Text>
          )}
        </View>
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Label>Ranked by net worth</Label>
            <InfoTip
              label="How net worth works"
              labelClassName="text-xs font-semibold text-stone-600"
              testID="net-worth-info"
              text={
                state.mode === 'intermediate'
                  ? 'Net worth = cash + property at market value + buildings at cost − mortgages to redeem − loans owed. The highest net worth wins.'
                  : 'Net worth = cash + property at cost + buildings − loans owed. The highest net worth wins.'
              }
            />
          </View>
          {result.standings.map((s, i) => {
            const won = s.playerId === result.winnerId;
            return (
              <View
                key={s.playerId}
                testID={`standing-${s.playerId}`}
                accessible
                accessibilityLabel={`${i + 1}. ${view.playerName(s.playerId)}${won ? ', winner' : ''}, ${formatINR(s.netWorth)}`}
                className={`flex-row items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 ${won ? 'border-saffron bg-amber-50' : 'border-transparent bg-white'}`}
              >
                <Text className={`flex-1 text-lg text-ink ${won ? 'font-black' : 'font-bold'}`} numberOfLines={2}>
                  {i + 1}. {view.playerName(s.playerId)}
                </Text>
                <Text className={`text-lg text-ink ${won ? 'font-black' : 'font-bold'}`}>{formatINR(s.netWorth)}</Text>
              </View>
            );
          })}
        </View>
      </Card>
      {/* Capital with secret objectives only: nothing is drawn when the game had none. */}
      <ObjectiveResults view={view} />
    </>
  );
}
