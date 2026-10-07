import { useState } from 'react';
import { Text, View } from 'react-native';
import { BUSINESS_MVP_RULES, loanTerms, nextInterestCircuit, outstandingPrincipal, type GameAction } from '@/engine/index.ts';
import { Button, Card, Label, Pill, Sheet, TextField } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

const RULES = BUSINESS_MVP_RULES.loans;
const QUICK = [1000, 2000, 5000, 10000];

interface LoanSheetProps {
  visible: boolean;
  onClose: () => void;
  view: GameView;
  send: (a: GameAction, opts?: { successMessage?: string }) => Promise<{ ok: boolean }>;
}

export function LoanSheet({ visible, onClose, view, send }: LoanSheetProps) {
  const [amount, setAmount] = useState(String(RULES.minAmount));
  const pending = useGameStore((s) => s.pendingAction);
  const me = view.me;
  if (!me) return null;
  const loans = view.snapshot.state.loans.filter((l) => l.playerId === me.id);
  const active = loans.filter((l) => l.status === 'ACTIVE');
  const room = Math.max(0, RULES.maxOutstandingPrincipal - outstandingPrincipal(view.snapshot.state.loans, me.id));
  const value = Number.parseInt(amount, 10) || 0;
  const terms = loanTerms(value);
  const error =
    value < RULES.minAmount
      ? `Minimum ${formatINR(RULES.minAmount)}`
      : value % RULES.step !== 0
        ? `Steps of ${formatINR(RULES.step)}`
        : value > room
          ? `You can borrow up to ${formatINR(room)}`
          : null;

  return (
    <Sheet visible={visible} onClose={onClose} title="Bank loan" testID="loan-sheet">
      <Text className="text-sm text-stone-600">
        You get the full amount now. {RULES.interestRatePercent}% interest is paid when you next reach or pass Start
        {RULES.interestEveryCircuit ? ', and again every Start while the loan is open' : ''}.
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {QUICK.filter((q) => q <= room).map((q) => (
          <Button key={q} size="sm" variant={value === q ? 'primary' : 'secondary'} title={formatINR(q)} onPress={() => setAmount(String(q))} />
        ))}
      </View>
      <View className="rounded-2xl bg-felt p-3">
        <TextField label="Borrow amount (₹)" keyboardType="number-pad" value={amount} onChangeText={setAmount} error={error} testID="loan-amount" />
      </View>
      <Card className="bg-white">
        <Row label="You receive now" value={formatINR(value)} />
        <Row label={`Interest at next Start (${RULES.interestRatePercent}%)`} value={formatINR(terms.interest)} />
        <Row label="Principal to repay" value={formatINR(terms.totalOwed)} bold />
      </Card>
      <Button
        title={`BORROW ${formatINR(value)}`}
        testID="loan-confirm"
        loading={pending === 'REQUEST_LOAN'}
        disabled={!!error || !!pending}
        onPress={async () => {
          const res = await send({ type: 'REQUEST_LOAN', amount: value }, { successMessage: `Borrowed ${formatINR(value)}` });
          if (res.ok) onClose();
        }}
      />

      {active.length ? <Label className="mt-2 text-stone-600">Your loans</Label> : null}
      {active.map((loan) => (
        <Card key={loan.id} className="gap-2 bg-white" testID="loan-row">
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-bold text-ink">Owed {formatINR(loan.outstanding)}</Text>
            <Pill tone="warn">Active</Pill>
          </View>
          <Text className="text-sm text-stone-500" testID="loan-interest-status">
            Borrowed {formatINR(loan.principal)} ·{' '}
            {nextInterestCircuit(loan) !== null
              ? `${formatINR(loan.interestAmount)} interest due at your next Start`
              : `interest paid ${formatINR(loan.interestPaid)}`}
          </Text>
          <View className="flex-row gap-2">
            {loan.outstanding > 1000 ? (
              <Button
                className="flex-1"
                size="sm"
                variant="secondary"
                title="Repay ₹1,000"
                disabled={me.balance < 1000 || !!pending}
                onPress={() => send({ type: 'REPAY_LOAN', loanId: loan.id, amount: 1000 })}
              />
            ) : null}
            <Button
              className="flex-1"
              size="sm"
              variant="success"
              title={`Repay all ${formatINR(loan.outstanding)}`}
              testID="loan-repay-all"
              disabled={me.balance < loan.outstanding || !!pending}
              onPress={() => send({ type: 'REPAY_LOAN', loanId: loan.id, amount: loan.outstanding }, { successMessage: 'Loan cleared!' })}
            />
          </View>
        </Card>
      ))}
    </Sheet>
  );
}

function Row({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className={`text-base text-stone-600 ${bold ? 'font-bold text-ink' : ''}`}>{label}</Text>
      <Text className={`text-base text-ink ${bold ? 'font-extrabold' : 'font-semibold'}`}>{value}</Text>
    </View>
  );
}
