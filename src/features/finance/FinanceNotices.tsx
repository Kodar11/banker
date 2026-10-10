import { useState } from 'react';
import { Text, View } from 'react-native';
import { clockLabel, getDeed, INTERMEDIATE_RULES, ownedBy, paymentsOwedNow, PROPERTY_KEYS, realValue, type IntermediateState, type PropertyKey } from '@/engine/index.ts';
import { Button, Card, Label, Sheet } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { formatINR } from '@/utils/currency';

const IR = INTERMEDIATE_RULES;

interface FinanceNoticesProps {
  view: GameView;
  eco: IntermediateState;
  /** Another sheet or screen has the player's attention: hold the notice back until it is gone. */
  suspended: boolean;
  /** Opens the bank on My Loans. */
  onOpenLoans: () => void;
}

/**
 * Intermediate Mode's two dismissible notices, one at a time:
 *   - to everyone, when a new financial year begins (read from the server's stored year report);
 *   - to the borrower only, while an installment of theirs is due or overdue.
 * Neither blocks the game — the turn carries on underneath — and dismissing a reminder changes
 * nothing about the payment: the deadline is the server's, and the amount stays on the board's
 * card and in the bank until it is paid.
 */
export function FinanceNotices({ view, eco, suspended, onOpenLoans }: FinanceNoticesProps) {
  const me = view.me;
  // The year this device has already announced. A device that opens (or reopens) the game mid-year
  // starts from the current year, so reconnecting never replays an old announcement.
  const [announcedYear, setAnnouncedYear] = useState(eco.year);
  const [dismissedReminder, setDismissedReminder] = useState<string | null>(null);

  const report = eco.lastReport;
  const showYear = !!report && eco.year > announcedYear;

  const owed = me && me.status === 'ACTIVE' ? paymentsOwedNow(eco, me.id) : [];
  const reminderKey = owed.map((o) => `${o.loan.id}:${o.installment.index}:${o.status}`).join('|');
  const showReminder = !showYear && owed.length > 0 && reminderKey !== dismissedReminder;

  if (suspended || (!showYear && !showReminder)) return null;

  if (showYear && report) {
    const mine = new Set<PropertyKey>(me ? ownedBy(view.snapshot.state, me.id) : []);
    const moves = PROPERTY_KEYS.map((key) => ({ key, ...report.changes[key]! })).filter((m) => m.to !== m.from);
    // My own properties first, then the biggest moves.
    const movers = [...moves]
      .sort((a, b) => Number(mine.has(b.key)) - Number(mine.has(a.key)) || Math.abs(b.percent) - Math.abs(a.percent))
      .slice(0, Math.max(IR.notifications.marketMoversShown, mine.size));
    const up = moves.filter((m) => m.to > m.from).length;
    const down = moves.filter((m) => m.to < m.from).length;
    const close = () => setAnnouncedYear(eco.year);
    return (
      <Sheet visible title={`Year ${report.year} begins`} onClose={close} testID="year-notice">
        <Text className="text-sm text-stone-600">A new financial year for everyone at the table. The game carries on — this is just the news.</Text>
        <Card className="bg-white">
          <Label>Property market</Label>
          <Text className="mt-1 text-base font-bold text-ink" testID="year-notice-summary">
            {up} went up · {down} went down · {PROPERTY_KEYS.length - up - down} unchanged
          </Text>
          <View className="mt-2 gap-1">
            {movers.map((m) => (
              <View key={m.key} className="flex-row items-center justify-between rounded-lg bg-stone-50 px-2 py-1.5" testID={`year-mover-${m.key}`}>
                <Text className="flex-1 text-sm font-bold text-ink">
                  {getDeed(m.key).name}
                  {mine.has(m.key) ? ' (yours)' : ''}
                </Text>
                <Text className={`text-sm font-extrabold ${m.percent > 0 ? 'text-green-700' : 'text-brick'}`}>
                  {m.percent > 0 ? '+' : ''}
                  {m.percent}% → {formatINR(m.to)}
                </Text>
              </View>
            ))}
          </View>
          <Text className="mt-2 text-xs text-stone-500">Open any property to see its new value. The bank now sells unowned properties at these prices.</Text>
        </Card>
        <Card className="bg-white">
          <Label>Inflation</Label>
          <Text className="mt-1 text-sm text-stone-700">
            Prices in general rose {IR.inflation.ratePercent}% again. Money buys a little less each year: ₹1,000 kept as cash since Year 1 now buys what{' '}
            {formatINR(realValue(1000, report.year - 1))} did then.
          </Text>
        </Card>
        <Button title="Got it" size="md" testID="year-notice-dismiss" onPress={close} />
      </Sheet>
    );
  }

  const worst = owed[0]!;
  const total = owed.reduce((sum, o) => sum + o.amount, 0);
  const overdue = worst.status === 'OVERDUE';
  const dismiss = () => setDismissedReminder(reminderKey);
  return (
    <Sheet visible title={overdue ? 'Loan payment overdue' : 'Loan payment due'} onClose={dismiss} testID="payment-reminder">
      <Card className={overdue ? 'bg-red-50' : 'bg-amber-50'}>
        <Label>{IR.loans.products[worst.loan.product].name}</Label>
        <Text className="mt-1 text-3xl font-black text-ink" testID="reminder-amount">
          {formatINR(total)}
        </Text>
        <Text className="mt-1 text-sm font-semibold text-stone-700" testID="reminder-deadline">
          {overdue
            ? `Overdue. Pay before ${clockLabel(eco, worst.deadline)} or the loan goes into default.`
            : `Pay by ${clockLabel(eco, worst.deadline)} to stay on time.`}
        </Text>
        <Text className="mt-2 text-sm text-stone-700" testID="reminder-cash">
          Your cash: {formatINR(me?.balance ?? 0)}
        </Text>
      </Card>
      <Button
        title="PAY NOW"
        testID="reminder-pay"
        onPress={() => {
          dismiss();
          onOpenLoans();
        }}
      />
      <View className="flex-row gap-3">
        <Button
          className="flex-1"
          size="md"
          variant="secondary"
          title="Review loan"
          testID="reminder-review"
          onPress={() => {
            dismiss();
            onOpenLoans();
          }}
        />
        <Button className="flex-1" size="md" variant="secondary" title="Later" testID="reminder-later" onPress={dismiss} />
      </View>
      <Text className="text-center text-xs text-stone-500">“Later” only hides this reminder. The deadline does not move.</Text>
    </Sheet>
  );
}
