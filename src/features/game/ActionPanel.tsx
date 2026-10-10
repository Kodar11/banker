import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { DECK_LABELS, getDeed, BUSINESS_MVP_RULES, type GameAction } from '@/engine/index.ts';
import { Button, Card, ConfirmDialog, Label, Pill, TextField } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { describeWaiting } from './describe';
import { PAY_ACTION } from './gameFocus';
import { sendFailure } from './useGameAction';
import type { GameView } from './useGameView';

interface ActionPanelProps {
  view: GameView;
  send: (action: GameAction) => Promise<unknown>;
  onOpenLoan: () => void;
}

/** Shows exactly the next valid action for this player. Nothing else. */
export function ActionPanel({ view, send, onOpenLoan }: ActionPanelProps) {
  const pending = useGameStore((s) => s.pendingAction);
  const [bankruptcy, setBankruptcy] = useState<{ busy: boolean; error: string | null } | null>(null);
  const { snapshot, me, current, isMyTurn, playerName } = view;
  const { state } = snapshot;
  const { turn } = state;

  if (!me) return null;

  if (turn.phase === 'AUCTION' && state.auction?.status === 'OPEN') {
    return (
      <Card testID="auction-callout">
        <Pill tone="gold">Auction!</Pill>
        <Text className="mt-2 text-2xl font-extrabold text-ink">{getDeed(state.auction.propertyKey).name} is up for bids</Text>
        <Button
          className="mt-4"
          title="GO TO AUCTION"
          testID="go-to-auction"
          onPress={() => router.push(`/auction/${state.auction!.id}`)}
        />
      </Card>
    );
  }

  if (!isMyTurn) {
    return (
      <Card testID="waiting-card">
        <Label>Waiting</Label>
        <Text className="mt-1 text-xl font-bold text-ink">{describeWaiting(state, current?.name ?? 'Someone')}</Text>
        <Text className="mt-2 text-sm text-stone-500">Look up — the board is where the fun is. We’ll buzz you when it’s your turn.</Text>
      </Card>
    );
  }

  const busy = (type: GameAction['type']) => pending === type;

  switch (turn.phase) {
    case 'AWAITING_ROLL':
      if (me.inJail) return <JailChoice view={view} send={send} onOpenLoan={onOpenLoan} />;
      return (
        <Button
          title="ROLL DICE"
          subtitle="🎲 Server rolls for you"
          testID="roll-button"
          loading={busy('ROLL_DICE')}
          disabled={!!pending}
          onPress={() => send({ type: 'ROLL_DICE' })}
          className="min-h-[96px]"
        />
      );

    case 'AWAITING_DECISION': {
      if (turn.pending?.kind !== 'BUY') return null;
      const deed = getDeed(turn.pending.propertyKey);
      const canAfford = me.balance >= deed.price;
      return (
        <Card testID="buy-card">
          <Pill tone="good">Property available</Pill>
          <Text className="mt-2 text-3xl font-black text-ink">{deed.name}</Text>
          <Text className="text-base text-stone-600">Price {formatINR(deed.price)}</Text>
          <View className="mt-4 gap-3">
            <Button
              title={`BUY ${formatINR(deed.price)}`}
              testID="buy-button"
              variant="success"
              loading={busy('BUY_PROPERTY')}
              disabled={!!pending || !canAfford}
              onPress={() => send({ type: 'BUY_PROPERTY' })}
            />
            {!canAfford ? (
              <Text className="text-center text-sm font-semibold text-brick">Not enough money for this purchase.</Text>
            ) : null}
            <Button
              title={BUSINESS_MVP_RULES.auction.enabled ? 'DECLINE → AUCTION' : 'DECLINE'}
              variant="secondary"
              size="md"
              testID="decline-button"
              loading={busy('DECLINE_PROPERTY')}
              disabled={!!pending}
              onPress={() => send({ type: 'DECLINE_PROPERTY' })}
            />
          </View>
        </Card>
      );
    }

    case 'AWAITING_PAYMENT': {
      if (turn.pending?.kind !== 'PAYMENT') return null;
      const p = turn.pending;
      const type = PAY_ACTION[p.reason];
      const short = p.amount - me.balance;
      const heading =
        p.reason === 'RENT' ? `Owned by ${playerName(p.toPlayerId)}` : p.reason === 'TAX' ? p.label : p.reason === 'LOAN_INTEREST' ? 'Loan interest' : p.reason === 'CLUB' ? 'Club' : 'Card';
      return (
        <Card testID="payment-card">
          <Pill tone="warn">{PAY_PILL[p.reason]}</Pill>
          <Text className="mt-2 text-2xl font-black text-ink">{heading}</Text>
          {p.label !== heading ? <Text className="text-base text-stone-600">{p.label}</Text> : null}
          <View className="mt-4 gap-3">
            <Button
              title={`${p.reason === 'RENT' ? 'PAY RENT' : 'PAY'} ${formatINR(p.amount)}`}
              testID="pay-button"
              loading={busy(type)}
              disabled={!!pending || short > 0}
              onPress={() => send({ type })}
            />
            {short > 0 ? (
              <View className="gap-3 rounded-2xl bg-red-50 p-3">
                <Text className="text-center text-base font-bold text-brick">You’re {formatINR(short)} short.</Text>
                <View className="flex-row gap-3">
                  <Button className="flex-1" size="sm" variant="secondary" title="Take a loan" testID="raise-loan" onPress={onOpenLoan} />
                  <Button
                    className="flex-1"
                    size="sm"
                    variant="secondary"
                    title="Mortgage / sell"
                    onPress={() => router.push(`/player/${me.id}`)}
                  />
                </View>
                <Button
                  size="sm"
                  variant="danger"
                  title="Declare bankruptcy"
                  testID="bankrupt-button"
                  onPress={() => setBankruptcy({ busy: false, error: null })}
                />
                {/* Rendered inside the decision sheet, so it opens above it. */}
                <ConfirmDialog
                  visible={!!bankruptcy}
                  title="Declare bankruptcy?"
                  message="Your cash goes to the creditor and your properties return to the bank."
                  detail="You leave the game. This can’t be taken back."
                  confirmTitle="Declare"
                  destructive
                  loading={bankruptcy?.busy}
                  error={bankruptcy?.error}
                  testID="bankrupt-dialog"
                  onCancel={() => setBankruptcy(null)}
                  onConfirm={async () => {
                    if (bankruptcy?.busy) return;
                    setBankruptcy({ busy: true, error: null });
                    const failure = sendFailure(await send({ type: 'DECLARE_BANKRUPTCY' }));
                    setBankruptcy((now) => (now && failure !== null ? { busy: false, error: failure } : null));
                  }}
                />
              </View>
            ) : null}
          </View>
        </Card>
      );
    }

    case 'AWAITING_CARD':
      return <ManualCard view={view} send={send} />;

    case 'TURN_COMPLETE':
      return (
        <Button
          title="END TURN"
          subtitle="Pass the dice"
          testID="end-turn-button"
          variant="secondary"
          loading={busy('END_TURN')}
          disabled={!!pending}
          onPress={() => send({ type: 'END_TURN' })}
          className="min-h-[88px]"
        />
      );

    default:
      return null;
  }
}

const PAY_PILL = {
  RENT: 'Rent due',
  TAX: 'Tax due',
  CARD: 'Card',
  LOAN_INTEREST: 'Interest due at Start',
  CLUB: 'Club',
} as const;

/** In Jail at the start of my turn: pay the fine and play, or miss this turn. */
function JailChoice({ view, send, onOpenLoan }: ActionPanelProps) {
  const pending = useGameStore((s) => s.pendingAction);
  const me = view.me;
  if (!me) return null;
  const { fine, maxTurns } = BUSINESS_MVP_RULES.jail;
  const turnInJail = maxTurns - me.jailTurnsLeft + 1;
  const lastTurn = me.jailTurnsLeft <= 1;
  const short = fine - me.balance;
  return (
    <Card testID="jail-card">
      <Pill tone="bad">In Jail</Pill>
      <Text className="mt-2 text-3xl font-black text-ink">Jail · turn {turnInJail} of {maxTurns}</Text>
      <Text className="mt-1 text-base text-stone-600">
        {lastTurn ? 'Stay this turn and you’re free next turn.' : `Stay to miss this turn, or pay ${formatINR(fine)} to leave now.`}
      </Text>
      <View className="mt-4 gap-3">
        <Button
          title={`PAY ${formatINR(fine)} & ROLL`}
          subtitle="Leave Jail now"
          testID="jail-pay"
          loading={pending === 'PAY_JAIL_FINE'}
          disabled={!!pending || short > 0}
          onPress={() => send({ type: 'PAY_JAIL_FINE' })}
        />
        {short > 0 ? (
          <View className="flex-row items-center gap-3 rounded-2xl bg-red-50 p-3">
            <Text className="flex-1 text-sm font-bold text-brick">You’re {formatINR(short)} short.</Text>
            <Button size="sm" variant="secondary" title="Take a loan" onPress={onOpenLoan} />
          </View>
        ) : null}
        <Button
          title="STAY IN JAIL"
          subtitle={lastTurn ? 'Released after this turn' : `Miss this turn · ${me.jailTurnsLeft - 1} more after this`}
          variant="secondary"
          size="md"
          testID="jail-stay"
          loading={pending === 'STAY_IN_JAIL'}
          disabled={!!pending}
          onPress={() => send({ type: 'STAY_IN_JAIL' })}
        />
      </View>
    </Card>
  );
}

/** Card entry missing from the supplied data: the player reads the physical card and enters the money effect. */
function ManualCard({ view, send }: { view: GameView; send: ActionPanelProps['send'] }) {
  const [amount, setAmount] = useState('');
  const pending = useGameStore((s) => s.pendingAction);
  const card = view.snapshot.state.turn.card;
  const value = Number.parseInt(amount, 10);
  const valid = Number.isInteger(value) && value > 0 && value <= BUSINESS_MVP_RULES.cards.manualMaxAmount;
  if (!card) return null;
  return (
    <Card testID="manual-card">
      <Pill tone="gold">
        {DECK_LABELS[card.deck]} · {card.table.toLowerCase()} {card.rollTotal}
      </Pill>
      <Text className="mt-2 text-xl font-black text-ink">
        Read entry {card.rollTotal} on your physical {DECK_LABELS[card.deck]} card
      </Text>
      <Text className="mt-1 text-sm text-stone-600">This entry isn’t in the app’s card data, so enter what your card says.</Text>
      <View className="mt-3 gap-3 rounded-2xl bg-felt p-3">
        <TextField label="Amount on the card (₹)" keyboardType="number-pad" value={amount} onChangeText={setAmount} testID="card-amount" />
      </View>
      <View className="mt-3 flex-row gap-3">
        <Button
          className="flex-1"
          size="md"
          title="I pay"
          testID="card-pay"
          disabled={!valid || !!pending}
          onPress={() => send({ type: 'RESOLVE_CARD', resolution: 'PAY', amount: value })}
        />
        <Button
          className="flex-1"
          size="md"
          variant="success"
          title="I receive"
          testID="card-receive"
          disabled={!valid || !!pending}
          onPress={() => send({ type: 'RESOLVE_CARD', resolution: 'RECEIVE', amount: value })}
        />
      </View>
      <Button
        className="mt-3"
        size="sm"
        variant="secondary"
        title="No money on this card"
        testID="card-none"
        disabled={!!pending}
        onPress={() => send({ type: 'RESOLVE_CARD', resolution: 'NONE' })}
      />
    </Card>
  );
}
