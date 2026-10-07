import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { Button, ConnectionBanner, Screen } from '@/components/ui';
import { topUndoable } from '@/engine/index.ts';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { TradeOffers } from '@/features/trade/TradeOffers';
import { TradeSheet } from '@/features/trade/TradeSheet';
import { PayPlayerSheet } from '@/features/transactions/PayPlayerSheet';
import { haptics } from '@/utils/haptics';
import { ActionPanel } from './ActionPanel';
import { DiceResult } from './DiceResult';
import { EventFeed, FinishedView, PausedView, PlayersStrip, UndoBanner } from './GamePanels';
import { TurnHeader } from './TurnHeader';
import { useGameAction } from './useGameAction';
import type { GameView } from './useGameView';

/**
 * Main game screen. Hierarchy: whose turn → my balance → dice/destination →
 * the ONE next action → latest event. Secondary tools live in a bottom
 * action bar: two rows of three equal-width buttons (never wraps text, ≥44px
 * touch targets, safe-area aware via Screen's footer).
 */
export function GameScreen({ view }: { view: GameView }) {
  const send = useGameAction();
  const [sheet, setSheet] = useState<'pay' | 'loan' | 'trade' | null>(null);
  const { state, events } = view.snapshot;
  const me = view.me;

  // Buzz when my turn starts so players can keep their eyes on the board.
  const wasMyTurn = useRef(view.isMyTurn);
  useEffect(() => {
    if (view.isMyTurn && !wasMyTurn.current) haptics.heavy();
    wasMyTurn.current = view.isMyTurn;
  }, [view.isMyTurn]);

  // Take everyone to the auction when one opens.
  const auctionId = state.auction?.status === 'OPEN' ? state.auction.id : null;
  const shownAuction = useRef<string | null>(null);
  useEffect(() => {
    if (auctionId && shownAuction.current !== auctionId && me && state.auction?.participantIds.includes(me.id)) {
      shownAuction.current = auctionId;
      haptics.warning();
      router.push(`/auction/${auctionId}`);
    }
  }, [auctionId, me, state.auction?.participantIds]);

  const last = topUndoable(state);
  const canRequestUndo =
    !!me && !!last && !state.undoRequest && (last.actorId === me.id || last.counterpartyIds.includes(me.id)) && state.status === 'ACTIVE';

  return (
    <Screen
      scroll
      testID="game-screen"
      footer={
        state.status === 'ACTIVE' && me?.status === 'ACTIVE' ? (
          <View className="gap-2" testID="action-bar">
            <View className="flex-row gap-2" testID="action-row-money">
              <Button className="flex-1" size="sm" variant="ghost" title="Pay" testID="open-pay" onPress={() => setSheet('pay')} />
              <Button className="flex-1" size="sm" variant="ghost" title="Loan" testID="open-loan" onPress={() => setSheet('loan')} />
              <Button className="flex-1" size="sm" variant="ghost" title="Trade" testID="open-trade" onPress={() => setSheet('trade')} />
            </View>
            <View className="flex-row gap-2" testID="action-row-game">
              <Button
                className="flex-1"
                size="sm"
                variant="ghost"
                title="Undo"
                testID="request-undo"
                disabled={!canRequestUndo}
                accessibilityHint={last ? `Ask to undo: ${last.description}` : 'Nothing to undo'}
                onPress={() =>
                  last &&
                  Alert.alert('Ask to undo?', `${last.description}\n\nAnother player must approve. Money is reversed with a new transaction.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Ask', onPress: () => void send({ type: 'REQUEST_UNDO', targetActionId: last.actionId }) },
                  ])
                }
              />
              <Button className="flex-1" size="sm" variant="ghost" title="Pause" testID="pause-button" onPress={() => send({ type: 'PAUSE_GAME' })} />
              <Button className="flex-1" size="sm" variant="ghost" title="More" testID="open-more" accessibilityHint="Settings and house rules" onPress={() => router.push('/settings')} />
            </View>
          </View>
        ) : (
          <Button size="sm" variant="ghost" title="Settings & house rules" onPress={() => router.push('/settings')} />
        )
      }
    >
      <ConnectionBanner />
      <TurnHeader view={view} />
      {state.status === 'PAUSED' ? <PausedView view={view} send={send} /> : null}
      {state.status === 'FINISHED' ? <FinishedView view={view} /> : null}
      {state.status === 'ACTIVE' ? (
        <>
          <UndoBanner view={view} send={send} />
          <TradeOffers view={view} send={send} />
          <DiceResult state={state} playerName={view.current?.name ?? ''} />
          {me?.status === 'BANKRUPT' ? null : <ActionPanel view={view} send={send} onOpenLoan={() => setSheet('loan')} />}
        </>
      ) : null}
      <EventFeed events={events} />
      <PlayersStrip view={view} />
      {view.isHost && state.status === 'ACTIVE' ? (
        <Button
          size="sm"
          variant="ghost"
          title="End game (host)"
          testID="end-game-button"
          onPress={() =>
            Alert.alert('End the game?', 'Highest net worth wins.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'End game', style: 'destructive', onPress: () => void send({ type: 'END_GAME' }) },
            ])
          }
        />
      ) : null}
      <PayPlayerSheet visible={sheet === 'pay'} onClose={() => setSheet(null)} view={view} send={send} />
      <LoanSheet visible={sheet === 'loan'} onClose={() => setSheet(null)} view={view} send={send} />
      <TradeSheet visible={sheet === 'trade'} onClose={() => setSheet(null)} view={view} send={send} />
    </Screen>
  );
}
