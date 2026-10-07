import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import { DECK_LABELS, getDeed, BUSINESS_MVP_RULES, type GameAction } from '@/engine/index.ts';
import { Button, Card, Label, Pill, TextField } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { describeWaiting } from './describe';
import type { GameView } from './useGameView';

interface ActionPanelProps {
  view: GameView;
  send: (action: GameAction) => Promise<unknown>;
  onOpenLoan: () => void;
}

/** Shows exactly the next valid action for this player. Nothing else. */
export function ActionPanel({ view, send, onOpenLoan }: ActionPanelProps) {
  const pending = useGameStore((s) => s.pendingAction);
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
      if (turn.pending?.kind === 'TAX_ENTRY') return <TaxEntry view={view} send={send} label={turn.pending.label} />;
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
                  onPress={() =>
                    Alert.alert('Declare bankruptcy?', 'Your cash goes to the creditor and your properties return to the bank. You leave the game.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Declare', style: 'destructive', onPress: () => void send({ type: 'DECLARE_BANKRUPTCY' }) },
                    ])
                  }
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

const PAY_ACTION = {
  RENT: 'PAY_RENT',
  TAX: 'PAY_TAX',
  CARD: 'PAY_CARD',
  LOAN_INTEREST: 'PAY_INTEREST',
  CLUB: 'PAY_CLUB',
} as const;

const PAY_PILL = {
  RENT: 'Rent due',
  TAX: 'Tax due',
  CARD: 'Card',
  LOAN_INTEREST: 'Interest due at Start',
  CLUB: 'Club',
} as const;

/** Tax square with no configured amount (Wealth Taxes): enter the amount printed on the board. */
function TaxEntry({ view, send, label }: { view: GameView; send: ActionPanelProps['send']; label: string }) {
  const [amount, setAmount] = useState('');
  const pending = useGameStore((s) => s.pendingAction);
  const value = Number.parseInt(amount, 10);
  const valid = Number.isInteger(value) && value > 0 && value <= BUSINESS_MVP_RULES.cards.manualMaxAmount;
  return (
    <Card testID="tax-entry-card">
      <Pill tone="warn">Tax due</Pill>
      <Text className="mt-2 text-2xl font-black text-ink">{label}</Text>
      <Text className="mt-1 text-sm text-stone-600">Enter the amount printed on your board for {label}.</Text>
      <View className="mt-3 rounded-2xl bg-felt p-3">
        <TextField label="Amount (₹)" keyboardType="number-pad" value={amount} onChangeText={setAmount} testID="tax-amount" />
      </View>
      <Button
        className="mt-3"
        title={valid ? `PAY ${formatINR(value)}` : 'PAY'}
        testID="tax-pay"
        disabled={!valid || !!pending}
        loading={pending === 'PAY_TAX'}
        onPress={() => send({ type: 'PAY_TAX', amount: value })}
      />
      {view.me && valid && value > view.me.balance ? (
        <Text className="mt-2 text-center text-sm font-semibold text-brick">More than your cash — you’ll need to raise money.</Text>
      ) : null}
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
