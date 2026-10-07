import { Alert, Text, View } from 'react-native';
import { tradeBlocker, type GameAction } from '@/engine/index.ts';
import { Button, Card, Label } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { describeTradeSide } from './TradeSheet';

/** Open trade offers that involve this player: accept/reject incoming, cancel outgoing. */
export function TradeOffers({ view, send }: { view: GameView; send: (a: GameAction) => Promise<unknown> }) {
  const pending = useGameStore((s) => s.pendingAction);
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
        const youGet = incoming ? describeTradeSide(t.offeredPropertyKeys, t.offeredMoney) : describeTradeSide(t.requestedPropertyKeys, t.requestedMoney);
        const youGive = incoming ? describeTradeSide(t.requestedPropertyKeys, t.requestedMoney) : describeTradeSide(t.offeredPropertyKeys, t.offeredMoney);
        const problem = tradeBlocker(state, t);
        return (
          <Card key={t.id} testID={incoming ? 'trade-incoming' : 'trade-outgoing'} className="border-saffron bg-amber-50">
            <Label>{incoming ? `Trade offer from ${other}` : `Your offer to ${other}`}</Label>
            <Text className="mt-1 text-base text-ink">
              <Text className="font-extrabold">You get: </Text>
              {youGet}
            </Text>
            <Text className="text-base text-ink">
              <Text className="font-extrabold">You give: </Text>
              {youGive}
            </Text>
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
                    onPress={() =>
                      Alert.alert('Accept this trade?', `You get ${youGet}.\nYou give ${youGive}.`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Accept', onPress: () => void send({ type: 'ACCEPT_TRADE', tradeId: t.id }) },
                      ])
                    }
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
