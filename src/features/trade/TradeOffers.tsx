import { useState } from 'react';
import { Text, View } from 'react-native';
import { tradeBlocker, type GameAction } from '@/engine/index.ts';
import { Button, Card, ConfirmDialog, Label } from '@/components/ui';
import { sendFailure } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { describeTradeSide, tradeMortgageNotes } from './TradeSheet';

/** Open trade offers that involve this player: accept/reject incoming, cancel outgoing. */
export function TradeOffers({ view, send }: { view: GameView; send: (a: GameAction) => Promise<unknown> }) {
  const pending = useGameStore((s) => s.pendingAction);
  /** The incoming offer being confirmed. */
  const [accepting, setAccepting] = useState<{ tradeId: string; busy: boolean; error: string | null } | null>(null);
  const me = view.me;
  const { state } = view.snapshot;
  if (!me) return null;
  const open = state.trades.filter((t) => t.status === 'PENDING' && (t.toPlayerId === me.id || t.fromPlayerId === me.id));
  if (!open.length) return null;

  return (
    <View className="gap-3" testID="trade-offers">
      {open.map((t) => {
        const incoming = t.toPlayerId === me.id;
        const other = view.playerName(incoming ? t.fromPlayerId : t.toPlayerId);
        // From my point of view: what I get / what I give.
        const youGet = incoming ? describeTradeSide(t.offeredPropertyKeys, t.offeredMoney, state) : describeTradeSide(t.requestedPropertyKeys, t.requestedMoney, state);
        const youGive = incoming ? describeTradeSide(t.requestedPropertyKeys, t.requestedMoney, state) : describeTradeSide(t.offeredPropertyKeys, t.offeredMoney, state);
        const problem = tradeBlocker(state, t);
        // Shown before anyone accepts: a mortgage travels with its property.
        const mortgageNotes = tradeMortgageNotes(state, [...t.offeredPropertyKeys, ...t.requestedPropertyKeys]);
        return (
          <Card key={t.id} testID={incoming ? 'trade-incoming' : 'trade-outgoing'} className="border-b-4 border-saffron bg-amber-50">
            <Label>{incoming ? `Trade offer from ${other}` : `Your offer to ${other}`}</Label>
            <Text className="mt-1 text-base text-ink">
              <Text className="font-extrabold">You get: </Text>
              {youGet}
            </Text>
            <Text className="text-base text-ink">
              <Text className="font-extrabold">You give: </Text>
              {youGive}
            </Text>
            {mortgageNotes.map((note) => (
              <Text key={note} className="mt-1 text-sm font-semibold text-stone-700" testID="trade-mortgage-note">
                {note}
              </Text>
            ))}
            {problem ? <Text className="mt-1 text-sm font-semibold text-brick">{problem}</Text> : null}
            <View className="mt-3 flex-row gap-3">
              {incoming ? (
                <>
                  <Button
                    className="flex-1"
                    size="sm"
                    variant="success"
                    title="Accept"
                    testID="trade-accept"
                    disabled={!!problem || !!pending}
                    loading={pending === 'ACCEPT_TRADE'}
                    onPress={() => setAccepting({ tradeId: t.id, busy: false, error: null })}
                  />
                  <ConfirmDialog
                    visible={accepting?.tradeId === t.id}
                    icon="🤝"
                    title="Accept this trade?"
                    summary={`You get ${youGet}
You give ${youGive}`}
                    message={`The trade with ${other} happens right away.`}
                    detail={mortgageNotes.length ? mortgageNotes.join('\n') : undefined}
                    confirmTitle="Accept trade"
                    loading={accepting?.busy}
                    error={accepting?.error}
                    testID="trade-accept-dialog"
                    onCancel={() => setAccepting(null)}
                    onConfirm={async () => {
                      if (accepting?.busy) return;
                      setAccepting({ tradeId: t.id, busy: true, error: null });
                      const failure = sendFailure(await send({ type: 'ACCEPT_TRADE', tradeId: t.id }));
                      setAccepting((now) => (now?.tradeId === t.id && failure !== null ? { tradeId: t.id, busy: false, error: failure } : null));
                    }}
                  />
                  <Button
                    className="flex-1"
                    size="sm"
                    variant="secondary"
                    title="Reject"
                    testID="trade-reject"
                    disabled={!!pending}
                    onPress={() => void send({ type: 'REJECT_TRADE', tradeId: t.id })}
                  />
                </>
              ) : (
                <Button
                  className="flex-1"
                  size="sm"
                  variant="secondary"
                  title="Cancel offer"
                  testID="trade-cancel"
                  disabled={!!pending}
                  onPress={() => void send({ type: 'CANCEL_TRADE', tradeId: t.id })}
                />
              )}
            </View>
          </Card>
        );
      })}
    </View>
  );
}
