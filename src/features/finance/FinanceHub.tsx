import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  borrowingCapacity,
  clockLabel,
  creditBand,
  economyOf,
  financialOverview,
  gameClock,
  getDeed,
  INTERMEDIATE_RULES,
  installmentDeadlines,
  loanOffers,
  loanOutstandingPrincipal,
  loanRequestBlocker,
  loansOf,
  nextScheduledInstallment,
  payableInstallment,
  prepaymentBlocker,
  prepaymentQuote,
  previewLoan,
  scheduledPrincipal,
  yearLength,
  yearProgressPercent,
  type GameAction,
  type Installment,
  type IntermediateLoan,
  type IntermediateState,
  type LoanOffer,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, Card, Label, MoneyField, Pill, Sheet } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

const IR = INTERMEDIATE_RULES;
const LOANS = IR.loans;

export type FinanceTab = 'overview' | 'loans' | 'borrow' | 'credit';

const TABS: { key: FinanceTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'loans', label: 'My Loans' },
  { key: 'borrow', label: 'Borrow' },
  { key: 'credit', label: 'Credit' },
];

type Send = (a: GameAction, opts?: { successMessage?: string; silent?: boolean }) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;

interface FinanceHubProps {
  visible: boolean;
  onClose: () => void;
  view: GameView;
  send: Send;
  /** The section to open on (e.g. a payment reminder opens My Loans). */
  initialTab?: FinanceTab;
}

/**
 * Intermediate Mode's bank: the Bank / Loan destination, in four sections. Everything shown is
 * read from the server's economy; every button sends an action the server decides on.
 * Classic games never render this — they keep the Classic loan sheet.
 */
export function FinanceHub({ visible, onClose, view, send, initialTab = 'overview' }: FinanceHubProps) {
  const [tab, setTab] = useState<FinanceTab>(initialTab);
  // Opening the bank again starts on the section it was asked for.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setTab(initialTab);
  }

  const { state } = view.snapshot;
  const eco = economyOf(state);
  const me = view.me;
  if (!eco || !me) return null;

  return (
    <Sheet visible={visible} onClose={onClose} title="Bank" testID="finance-hub">
      <View className="flex-row gap-1.5" accessibilityRole="tablist" testID="finance-tabs">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t.label}
              testID={`finance-tab-${t.key}`}
              className={`min-h-[44px] flex-1 items-center justify-center rounded-xl px-1 ${active ? 'bg-felt' : 'bg-stone-200'}`}
            >
              <Text className={`text-[13px] font-extrabold ${active ? 'text-cream' : 'text-stone-700'}`} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {tab === 'overview' ? <OverviewTab view={view} eco={eco} onOpen={setTab} /> : null}
      {tab === 'loans' ? <LoansTab view={view} eco={eco} send={send} onBorrow={() => setTab('borrow')} /> : null}
      {tab === 'borrow' ? <BorrowTab view={view} eco={eco} send={send} onDone={() => setTab('loans')} /> : null}
      {tab === 'credit' ? <CreditTab view={view} eco={eco} /> : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Row({ label, value, bold = false, warn = false, testID }: { label: string; value: string; bold?: boolean; warn?: boolean; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-1" testID={testID}>
      <Text className={`flex-1 text-sm ${bold ? 'font-bold text-ink' : 'text-stone-600'}`}>{label}</Text>
      <Text className={`text-right text-base ${bold ? 'font-extrabold' : 'font-semibold'} ${warn ? 'text-brick' : 'text-ink'}`}>{value}</Text>
    </View>
  );
}

function Note({ children, tone = 'info', testID }: { children: ReactNode; tone?: 'info' | 'warn' | 'bad'; testID?: string }) {
  const box = tone === 'bad' ? 'bg-red-50' : tone === 'warn' ? 'bg-amber-50' : 'bg-stone-100';
  const text = tone === 'bad' ? 'text-brick' : tone === 'warn' ? 'text-amber-900' : 'text-stone-700';
  return (
    <View className={`rounded-2xl px-3 py-2.5 ${box}`} testID={testID}>
      <Text className={`text-sm font-semibold ${text}`}>{children}</Text>
    </View>
  );
}

const rateType = (loan: { rateType: 'FIXED' | 'VARIABLE' }) => (loan.rateType === 'FIXED' ? 'fixed' : 'variable');
const ratioText = (ratio: number) => `${Math.round(ratio * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ view, eco, onOpen }: { view: GameView; eco: IntermediateState; onOpen: (tab: FinanceTab) => void }) {
  const o = financialOverview(view.snapshot.state, view.me!.id);
  if (!o) return null;
  const next = o.nextPayment;
  return (
    <View className="gap-3" testID="finance-overview">
      <Card className="bg-white">
        <Label>
          Year {eco.year} · {yearProgressPercent(eco)}% through
        </Label>
        <Row label="Cash available" value={formatINR(o.cash)} bold testID="overview-cash" />
        <Row label="Net worth" value={formatINR(o.netWorth)} bold testID="overview-net-worth" />
        <Row label="Outstanding loans" value={formatINR(o.loanPrincipal)} warn={o.loanPrincipal > 0} testID="overview-loans" />
        <Row label="Credit score" value={`${o.creditScore} · ${o.creditBand}`} testID="overview-credit" />
        <Row label="Debt-to-assets ratio" value={ratioText(o.debtRatio)} testID="overview-debt-ratio" />
      </Card>

      {o.defaultedAmount > 0 ? (
        <Note tone="bad" testID="overview-default">
          A loan is in default: {formatINR(o.defaultedAmount)} is owed. You can’t borrow until it is cleared.
        </Note>
      ) : null}
      {o.overdueAmount > 0 ? (
        <Note tone="bad" testID="overview-overdue">
          Overdue: {formatINR(o.overdueAmount)}. Pay it within the grace period or the loan defaults.
        </Note>
      ) : null}

      <Card className="bg-white" testID="overview-next-payment">
        <Label>Next payment</Label>
        {next ? (
          <>
            <Row label={LOANS.products[next.loan.product].name} value={formatINR(next.amount)} bold />
            <Row
              label={next.status === 'SCHEDULED' ? 'Falls due' : next.status === 'DUE' ? 'Pay by' : 'Loan defaults at'}
              value={clockLabel(eco, next.deadline)}
              warn={next.status === 'OVERDUE'}
            />
            <Row label="Cash left after paying it" value={formatINR(o.cashAfterNextPayment)} warn={o.cashAfterNextPayment < 0} testID="overview-cash-after" />
            {next.status !== 'SCHEDULED' ? <Button className="mt-2" size="md" title="Go to payment" testID="overview-pay" onPress={() => onOpen('loans')} /> : null}
          </>
        ) : (
          <Text className="mt-1 text-sm text-stone-600">Nothing to pay. You have no active loans.</Text>
        )}
      </Card>

      <Card className="bg-white">
        <Label>Where your net worth comes from</Label>
        <Row label="Cash" value={formatINR(o.cash)} />
        <Row label={`Property at market value (${o.propertyCount})`} value={formatINR(o.propertyValue)} />
        <Row label="Buildings, at cost" value={formatINR(o.buildingValue)} />
        <Row label={`Mortgages to redeem (${o.mortgagedCount})`} value={o.mortgageRedemption ? `−${formatINR(o.mortgageRedemption)}` : formatINR(0)} />
        <Row label="Loans owed" value={o.loanLiability ? `−${formatINR(o.loanLiability)}` : formatINR(0)} />
        <Row label="Net worth" value={formatINR(o.netWorth)} bold />
        <Text className="mt-2 text-xs text-stone-500">
          Net worth is not cash: property can’t pay an installment until you sell or mortgage it. Rent you might earn later is not counted.
        </Text>
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// My Loans
// ---------------------------------------------------------------------------

function LoansTab({ view, eco, send, onBorrow }: { view: GameView; eco: IntermediateState; send: Send; onBorrow: () => void }) {
  const me = view.me!;
  const loans = loansOf(eco, me.id);
  const open = loans.filter((l) => l.status === 'ACTIVE' || l.status === 'DEFAULTED');
  const closed = loans.filter((l) => l.status !== 'ACTIVE' && l.status !== 'DEFAULTED');
  const playing = view.snapshot.state.status === 'ACTIVE' && me.status === 'ACTIVE';
  return (
    <View className="gap-3" testID="finance-loans">
      {open.length === 0 ? (
        <Card className="items-center bg-white" testID="loans-empty">
          <Text className="text-base font-bold text-ink">No active loans</Text>
          <Text className="mt-1 text-center text-sm text-stone-600">Borrowing gives you cash now and a payment every financial year.</Text>
          <Button className="mt-3 self-stretch" size="md" variant="secondary" title="See loan offers" onPress={onBorrow} />
        </Card>
      ) : null}
      {open.map((loan) => (
        <LoanCard key={loan.id} loan={loan} eco={eco} cash={me.balance} playing={playing} send={send} />
      ))}
      {closed.length ? <Label className="mt-1 text-stone-600">Closed loans</Label> : null}
      {closed.map((loan) => (
        <LoanCard key={loan.id} loan={loan} eco={eco} cash={me.balance} playing={false} send={send} />
      ))}
    </View>
  );
}

const LOAN_PILL: Record<IntermediateLoan['status'], { tone: 'warn' | 'good' | 'bad' | 'neutral'; text: string }> = {
  ACTIVE: { tone: 'warn', text: 'Active' },
  REPAID: { tone: 'good', text: 'Repaid' },
  DEFAULTED: { tone: 'bad', text: 'In default' },
  SETTLED: { tone: 'neutral', text: 'Default settled' },
  WRITTEN_OFF: { tone: 'neutral', text: 'Written off' },
};

const INSTALLMENT_TEXT: Record<Installment['status'], string> = {
  SCHEDULED: 'Scheduled',
  DUE: 'Due now',
  PAID: 'Paid on time',
  OVERDUE: 'Overdue',
  CAUGHT_UP: 'Paid late',
  DEFAULTED: 'Defaulted',
};

function LoanCard({ loan, eco, cash, playing, send }: { loan: IntermediateLoan; eco: IntermediateState; cash: number; playing: boolean; send: Send }) {
  const pending = useGameStore((s) => s.pendingAction);
  const [details, setDetails] = useState(false);
  const [early, setEarly] = useState('');
  const [defaultPay, setDefaultPay] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const product = LOANS.products[loan.product];
  const payable = payableInstallment(loan);
  const next = nextScheduledInstallment(loan);
  const left = loan.installments.filter((i) => i.status === 'SCHEDULED' || i.status === 'DUE' || i.status === 'OVERDUE').length;
  const scheduled = scheduledPrincipal(loan);
  const pill = LOAN_PILL[loan.status];

  const act = async (action: GameAction, successMessage: string) => {
    setFailure(null);
    const res = await send(action, { successMessage });
    if (!res.ok) setFailure(res.error.message);
    return res.ok;
  };

  const earlyAmount = Number.parseInt(early, 10) || 0;
  const earlyWhy = earlyAmount > 0 ? prepaymentBlocker(loan, earlyAmount) : null;
  const quote = earlyAmount > 0 && !earlyWhy ? prepaymentQuote(eco, loan, earlyAmount) : null;
  const fullQuote = loan.status === 'ACTIVE' && !payable && scheduled > 0 ? prepaymentQuote(eco, loan, scheduled) : null;
  const defaultAmount = Number.parseInt(defaultPay, 10) || 0;

  return (
    <Card className="gap-2 bg-white" testID={`loan-card-${loan.product}`}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-lg font-black text-ink">{product.name}</Text>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </View>
      <View>
        <Row label="Borrowed" value={formatINR(loan.principal)} />
        <Row label="Principal remaining" value={formatINR(loanOutstandingPrincipal(loan))} bold testID="loan-principal-remaining" />
        <Row label="Annual rate" value={`${loan.ratePercent}% ${rateType(loan)}`} testID="loan-rate" />
        {loan.status === 'ACTIVE' ? <Row label="Payments left" value={String(left)} /> : null}
        {next ? <Row label="Next payment" value={`${formatINR(next.principal + next.interest)} · ${clockLabel(eco, next.dueAt)}`} testID="loan-next-due" /> : null}
        {loan.collateralKey ? <Row label="Pledged as collateral" value={getDeed(loan.collateralKey).name} testID="loan-collateral" /> : null}
        {loan.settlement ? (
          <Row label={`Bank took ${getDeed(loan.settlement.propertyKey).name}`} value={`${formatINR(loan.settlement.value)} against the debt`} />
        ) : null}
      </View>

      {payable ? (
        <View className={`gap-2 rounded-2xl p-3 ${payable.status === 'OVERDUE' ? 'bg-red-50' : 'bg-amber-50'}`} testID="loan-payable">
          <Text className={`text-sm font-extrabold uppercase tracking-wider ${payable.status === 'OVERDUE' ? 'text-brick' : 'text-amber-900'}`}>
            {payable.status === 'OVERDUE' ? 'Overdue payment' : 'Payment due'} · installment {payable.index}
          </Text>
          <Row label="Principal" value={formatINR(payable.principal)} />
          <Row label="Interest" value={formatINR(payable.interest)} />
          <Row label="Total" value={formatINR(payable.principal + payable.interest)} bold />
          <Row label="Your cash" value={formatINR(cash)} warn={cash < payable.principal + payable.interest} />
          <Text className="text-xs font-semibold text-stone-700">
            {payable.status === 'OVERDUE'
              ? `Pay before ${clockLabel(eco, installmentDeadlines(eco, payable).defaultAt)} or this loan defaults (−${Math.abs(IR.credit.events.LOAN_DEFAULT)} credit${loan.collateralKey ? `, and the bank takes ${getDeed(loan.collateralKey).name}` : ''}).`
              : `Pay by ${clockLabel(eco, installmentDeadlines(eco, payable).overdueAt)} to stay on time (${signed(IR.credit.events.ON_TIME_PAYMENT)} credit). After that it is overdue (${signed(IR.credit.events.INSTALLMENT_OVERDUE)}).`}
          </Text>
          <Button
            title={`PAY NOW ${formatINR(payable.principal + payable.interest)}`}
            size="md"
            testID="loan-pay-now"
            loading={pending === 'PAY_LOAN_INSTALLMENT'}
            disabled={!playing || !!pending || cash < payable.principal + payable.interest}
            onPress={() => act({ type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }, 'Installment paid')}
          />
          {cash < payable.principal + payable.interest ? (
            <Text className="text-center text-xs font-bold text-brick">Not enough cash. Mortgage or sell something first.</Text>
          ) : null}
        </View>
      ) : null}

      {loan.status === 'DEFAULTED' ? (
        <View className="gap-2 rounded-2xl bg-red-50 p-3" testID="loan-default">
          <Text className="text-sm font-extrabold uppercase tracking-wider text-brick">In default</Text>
          <Row label="Balance owed now" value={formatINR(loan.defaultBalance)} bold />
          <Text className="text-xs font-semibold text-stone-700">The whole balance is payable. No more interest is added. You can’t take a new loan until it is cleared.</Text>
          <View className="rounded-2xl bg-felt p-3">
            <MoneyField label="Pay towards the balance" value={defaultPay} onChangeValue={setDefaultPay} testID="loan-default-amount" />
          </View>
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              size="sm"
              variant="secondary"
              title={defaultAmount > 0 ? `Pay ${formatINR(defaultAmount)}` : 'Pay part'}
              testID="loan-default-pay-part"
              disabled={!playing || !!pending || defaultAmount <= 0 || defaultAmount > loan.defaultBalance || defaultAmount > cash}
              onPress={async () => {
                if (await act({ type: 'PAY_DEFAULTED_LOAN', loanId: loan.id, amount: defaultAmount }, 'Payment made')) setDefaultPay('');
              }}
            />
            <Button
              className="flex-1"
              size="sm"
              variant="success"
              title={`Clear ${formatINR(loan.defaultBalance)}`}
              testID="loan-default-pay-all"
              disabled={!playing || !!pending || cash < loan.defaultBalance}
              onPress={() => act({ type: 'PAY_DEFAULTED_LOAN', loanId: loan.id, amount: loan.defaultBalance }, 'Default cleared')}
            />
          </View>
        </View>
      ) : null}

      {fullQuote && playing ? (
        <View className="gap-2 rounded-2xl bg-stone-100 p-3" testID="loan-early">
          <Text className="text-sm font-extrabold uppercase tracking-wider text-stone-700">Repay early · no penalty</Text>
          <Text className="text-xs text-stone-600">You pay the principal you choose plus the interest built up on it so far this loan year. Later payments get smaller.</Text>
          <View className="rounded-2xl bg-felt p-3">
            <MoneyField label="Principal to repay" value={early} onChangeValue={setEarly} error={earlyWhy} testID="loan-early-amount" />
          </View>
          {quote ? (
            <View testID="loan-early-quote">
              <Row label="Principal" value={formatINR(quote.principal)} />
              <Row label="Interest accrued on it" value={formatINR(quote.accruedInterest)} />
              <Row label="You pay now" value={formatINR(quote.total)} bold />
              <Row label="Principal left afterwards" value={formatINR(quote.remainingPrincipal)} />
            </View>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              size="sm"
              variant="secondary"
              title={quote ? `Repay ${formatINR(quote.total)}` : 'Repay part'}
              testID="loan-early-part"
              disabled={!quote || !!pending || cash < (quote?.total ?? 0)}
              loading={pending === 'PREPAY_INTERMEDIATE_LOAN'}
              onPress={async () => {
                if (await act({ type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: earlyAmount }, 'Early repayment made')) setEarly('');
              }}
            />
            <Button
              className="flex-1"
              size="sm"
              variant="success"
              title={`Repay all ${formatINR(fullQuote.total)}`}
              testID="loan-early-all"
              disabled={!!pending || cash < fullQuote.total}
              onPress={() => act({ type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: scheduled }, 'Loan repaid')}
            />
          </View>
        </View>
      ) : null}

      {failure ? (
        <Text className="text-center text-sm font-bold text-brick" accessibilityRole="alert" testID="loan-error">
          {failure}
        </Text>
      ) : null}

      <Button size="sm" variant="secondary" title={details ? 'Hide contract & history' : 'Contract & payment history'} testID="loan-details-toggle" onPress={() => setDetails((d) => !d)} />
      {details ? (
        <View className="gap-1" testID="loan-details">
          <Row label="Signed" value={`Year ${loan.originYear} · ${formatINR(loan.principal)} over ${loan.tenureYears} year${loan.tenureYears === 1 ? '' : 's'}`} />
          <Row label="Rate" value={`${loan.marketRatePercent}% ${loan.rateType === 'FIXED' ? 'base' : 'market'} ${signed(loan.creditAdjustmentPercent)} credit = ${loan.ratePercent}%`} />
          {loan.installments.map((i) => (
            <View key={i.index} className="flex-row items-center justify-between gap-2 rounded-lg bg-stone-50 px-2 py-1.5" testID={`loan-installment-${i.index}`}>
              <View className="flex-1">
                <Text className="text-sm font-bold text-ink">
                  {i.index}. {formatINR(i.principal + i.interest)}
                </Text>
                <Text className="text-xs text-stone-500">
                  {formatINR(i.principal)} principal + {formatINR(i.interest)} interest · {clockLabel(eco, i.dueAt)}
                </Text>
              </View>
              <Text className={`text-xs font-extrabold ${i.status === 'OVERDUE' || i.status === 'DEFAULTED' ? 'text-brick' : i.status === 'PAID' ? 'text-green-700' : 'text-stone-600'}`}>
                {INSTALLMENT_TEXT[i.status]}
              </Text>
            </View>
          ))}
          {loan.prepayments.map((p, i) => (
            <Text key={`pre-${i}`} className="text-xs text-stone-600">
              Year {p.year}: repaid {formatINR(p.principal)} early (+ {formatINR(p.interest)} interest)
            </Text>
          ))}
          {loan.rateHistory.slice(1).map((r, i) => (
            <Text key={`rate-${i}`} className="text-xs text-stone-600">
              Year {r.year} review: {signed(r.movePercent)} point{Math.abs(r.movePercent) === 1 ? '' : 's'} → {r.ratePercent}%
            </Text>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Borrow
// ---------------------------------------------------------------------------

interface BorrowDraft {
  offer: LoanOffer;
  amount: string;
  collateralKey: PropertyKey | null;
  review: boolean;
}

function BorrowTab({ view, eco, send, onDone }: { view: GameView; eco: IntermediateState; send: Send; onDone: () => void }) {
  const pending = useGameStore((s) => s.pendingAction);
  const [draft, setDraft] = useState<BorrowDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { state } = view.snapshot;
  const me = view.me!;
  const offers = loanOffers(state, me.id);

  if (!draft) {
    return (
      <View className="gap-3" testID="finance-borrow">
        <Text className="text-sm text-stone-600">
          Your credit score is {eco.credit[me.id] ?? IR.credit.start} ({creditBand(eco.credit[me.id] ?? IR.credit.start).label}), so each rate below is already adjusted for you. You can
          borrow {formatINR(borrowingCapacity(eco, me.id))} more in total.
        </Text>
        {offers.map((o) => (
          <Card key={o.product} className="gap-1 bg-white" testID={`offer-${o.product}`}>
            <View className="flex-row items-start justify-between gap-2">
              <Text className="flex-1 text-lg font-black text-ink">{o.name}</Text>
              <View className="items-end">
                <Text className="text-2xl font-black text-ink" testID={`offer-rate-${o.product}`}>
                  {o.ratePercent}%
                </Text>
                <Text className="text-[11px] font-bold uppercase tracking-wider text-stone-500">a year · {rateType(o)}</Text>
              </View>
            </View>
            <Text className="text-sm text-stone-600">{o.summary}</Text>
            <Row label="Repaid over" value={`${o.tenureYears} year${o.tenureYears === 1 ? '' : 's'}, one payment a year`} />
            <Row label="Up to" value={formatINR(o.productLimit)} />
            <Row label="Security" value={o.secured ? `A property (max ${LOANS.collateralAdvancePercent}% of its value)` : 'None'} />
            <Row label="Rate" value={`${o.marketRatePercent}% base ${signed(o.creditAdjustmentPercent)} for your score`} />
            {o.rateType === 'VARIABLE' ? <Note tone="warn">The rate is reviewed every year and can move by up to 2 points either way, so later payments can change.</Note> : null}
            {o.blocked ? (
              <Note tone="bad" testID={`offer-blocked-${o.product}`}>
                {o.blocked}
              </Note>
            ) : (
              <Button
                className="mt-1"
                size="md"
                variant="secondary"
                title={`Choose amount · up to ${formatINR(o.maxAmount)}`}
                testID={`offer-choose-${o.product}`}
                onPress={() => {
                  setFailure(null);
                  setDraft({ offer: o, amount: String(Math.min(o.maxAmount, LOANS.minAmount)), collateralKey: o.collateral[0]?.key ?? null, review: false });
                }}
              />
            )}
          </Card>
        ))}
      </View>
    );
  }

  // Always the live offer: if the score or limits moved while this was open, the screen shows the new terms.
  const offer = offers.find((o) => o.product === draft.offer.product) ?? draft.offer;
  const amount = Number.parseInt(draft.amount, 10) || 0;
  const why = loanRequestBlocker(state, me.id, offer.product, amount, offer.secured ? draft.collateralKey : null);
  const preview = previewLoan(offer.product, amount, offer.ratePercent);
  const clock = gameClock(eco);
  const length = yearLength(eco);
  const pledge = offer.collateral.find((c) => c.key === draft.collateralKey) ?? null;
  const limit = Math.min(offer.maxAmount, pledge ? pledge.limit : offer.maxAmount);
  const quick = [1000, 2000, 5000, 10000, 15000].filter((q) => q <= limit);

  if (!draft.review) {
    return (
      <View className="gap-3" testID="borrow-configure">
        <Button size="sm" variant="secondary" title="‹ All offers" className="self-start" onPress={() => setDraft(null)} />
        <Text className="text-xl font-black text-ink">
          {offer.name} · {offer.ratePercent}% {rateType(offer)}
        </Text>
        {offer.secured ? (
          <View className="gap-2" testID="borrow-collateral">
            <Label>Property to pledge</Label>
            {offer.collateral.map((c) => {
              const active = c.key === draft.collateralKey;
              return (
                <Pressable
                  key={c.key}
                  onPress={() => setDraft({ ...draft, collateralKey: c.key })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`collateral-${c.key}`}
                  className={`min-h-[52px] flex-row items-center justify-between rounded-2xl border-2 px-4 py-2 ${active ? 'border-saffron bg-amber-50' : 'border-transparent bg-white'}`}
                >
                  <View>
                    <Text className="text-base font-bold text-ink">{getDeed(c.key).name}</Text>
                    <Text className="text-xs text-stone-500">Market value {formatINR(c.marketValue)}</Text>
                  </View>
                  <Text className="text-sm font-extrabold text-ink">up to {formatINR(c.limit)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {quick.map((q) => (
            <Button key={q} size="sm" variant={amount === q ? 'primary' : 'secondary'} title={formatINR(q)} onPress={() => setDraft({ ...draft, amount: String(q) })} />
          ))}
        </View>
        <View className="rounded-2xl bg-felt p-3">
          <MoneyField label="Borrow amount" value={draft.amount} onChangeValue={(amountText) => setDraft({ ...draft, amount: amountText })} error={why} testID="borrow-amount" />
        </View>
        {!why ? (
          <Card className="bg-white" testID="borrow-estimate">
            <Row label="You receive now" value={formatINR(amount)} />
            <Row label={offer.tenureYears === 1 ? 'One payment of' : `Payment each year${offer.rateType === 'VARIABLE' ? ' (first year)' : ''}`} value={formatINR((preview.lines[0]?.principal ?? 0) + (preview.lines[0]?.interest ?? 0))} bold />
            <Row label="Total you repay" value={`${formatINR(preview.total)}${offer.rateType === 'VARIABLE' ? ' at today’s rate' : ''}`} />
            <Row label="Of which interest" value={formatINR(preview.interest)} />
          </Card>
        ) : null}
        <Button title="REVIEW CONTRACT" testID="borrow-review" disabled={!!why} onPress={() => setDraft({ ...draft, review: true })} />
      </View>
    );
  }

  const grace = `${LOANS.graceYears} full financial year${LOANS.graceYears === 1 ? '' : 's'}`;
  return (
    <View className="gap-3" testID="borrow-contract">
      <Button size="sm" variant="secondary" title="‹ Change amount" className="self-start" onPress={() => setDraft({ ...draft, review: false })} />
      <Text className="text-xl font-black text-ink">Loan contract · {offer.name}</Text>
      <Card className="bg-white">
        <Row label="Principal (paid to you now)" value={formatINR(amount)} bold testID="contract-principal" />
        <Row label="Annual interest rate" value={`${offer.ratePercent}% ${rateType(offer)}`} bold testID="contract-rate" />
        <Row label="How the rate is made" value={`${offer.marketRatePercent}% base ${signed(offer.creditAdjustmentPercent)} credit adjustment`} />
        <Row label="Term" value={`${offer.tenureYears} financial year${offer.tenureYears === 1 ? '' : 's'}`} />
        <Row label="Fees" value="None" testID="contract-fees" />
      </Card>

      <Card className="bg-white" testID="contract-schedule">
        <Label>Payment schedule</Label>
        {preview.lines.map((line, i) => (
          <View key={i} className="mt-1 rounded-lg bg-stone-50 px-2 py-1.5">
            <View className="flex-row justify-between">
              <Text className="text-sm font-bold text-ink">
                Payment {i + 1} · {clockLabel(eco, clock + (i + 1) * length)}
              </Text>
              <Text className="text-sm font-extrabold text-ink">{formatINR(line.principal + line.interest)}</Text>
            </View>
            <Text className="text-xs text-stone-500">
              {formatINR(line.principal)} principal + {formatINR(line.interest)} interest
            </Text>
          </View>
        ))}
        <View className="mt-2">
          <Row label="Total interest" value={formatINR(preview.interest)} />
          <Row label="Total you repay" value={formatINR(preview.total)} bold testID="contract-total" />
        </View>
        <Text className="mt-1 text-xs text-stone-500">
          The first payment is due one full financial year from now — never sooner, even if the market year changes tomorrow. Interest is charged on the principal
          still owed, never on interest.
        </Text>
      </Card>

      {offer.rateType === 'VARIABLE' ? (
        <Note tone="warn" testID="contract-variable">
          Variable rate: on each anniversary the bank’s rate moves by −2, −1, 0, +1 or +2 points (kept between {IR.rates.minPercent}% and {IR.rates.maxPercent}%). Your credit
          adjustment of {signed(offer.creditAdjustmentPercent)} stays. Payments 2 onwards are recalculated, so the amounts above can go up or down.
        </Note>
      ) : (
        <Note>Fixed rate: {offer.ratePercent}% for the whole loan. It does not change if your credit score changes later.</Note>
      )}

      {offer.secured && pledge ? (
        <Note tone="bad" testID="contract-collateral">
          Collateral: {getDeed(pledge.key).name} (market value {formatINR(pledge.marketValue)}). It stays yours and keeps earning rent, but you can’t mortgage, sell, trade or
          build on it until the loan is repaid. If you default, the bank takes it at its market value that day, sets that against what you owe, pays you anything left
          over, and you still owe any shortfall.
        </Note>
      ) : (
        <Note>Unsecured: no property is pledged, and none is taken if you default.</Note>
      )}

      <Card className="bg-white" testID="contract-terms">
        <Label>If things change</Label>
        <Text className="mt-1 text-sm text-stone-700">
          <Text className="font-bold">Early repayment.</Text> Any time, in part or in full, with no penalty: you pay that principal plus the interest built up on it so far that
          loan year, and the remaining payments are recalculated.
        </Text>
        <Text className="mt-2 text-sm text-stone-700">
          <Text className="font-bold">Paying on time.</Text> Each payment can be made on time for a quarter of a financial year after it falls due ({signed(IR.credit.events.ON_TIME_PAYMENT)}{' '}
          credit). After that it is overdue ({signed(IR.credit.events.INSTALLMENT_OVERDUE)} credit) and you can’t take new loans until it is paid.
        </Text>
        <Text className="mt-2 text-sm text-stone-700">
          <Text className="font-bold">Grace period.</Text> An overdue payment can still be made for {grace}. Nothing is added to it.
        </Text>
        <Text className="mt-2 text-sm text-stone-700">
          <Text className="font-bold">Default.</Text> If it is still unpaid after that, the loan defaults ({signed(IR.credit.events.LOAN_DEFAULT)} credit): everything you still owe —
          payments already due, the remaining principal, and the interest built up so far that year — becomes payable at once, with no further interest, and you can’t
          borrow until it is cleared. Default is not bankruptcy.
        </Text>
      </Card>

      {why ? <Note tone="bad">{why}</Note> : null}
      {failure ? (
        <Text className="text-center text-sm font-bold text-brick" accessibilityRole="alert" testID="borrow-error">
          {failure}
        </Text>
      ) : null}
      <Button
        title={`I ACCEPT — BORROW ${formatINR(amount)}`}
        testID="borrow-accept"
        loading={pending === 'TAKE_INTERMEDIATE_LOAN'}
        disabled={!!why || !!pending}
        onPress={async () => {
          setFailure(null);
          const res = await send(
            {
              type: 'TAKE_INTERMEDIATE_LOAN',
              product: offer.product,
              amount,
              expectedRatePercent: offer.ratePercent,
              ...(offer.secured && draft.collateralKey ? { collateralKey: draft.collateralKey } : {}),
            },
            { successMessage: `Borrowed ${formatINR(amount)}` },
          );
          if (res.ok) {
            setDraft(null);
            onDone();
          } else {
            setFailure(res.error.message);
          }
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

function CreditTab({ view, eco }: { view: GameView; eco: IntermediateState }) {
  const me = view.me!;
  const o = financialOverview(view.snapshot.state, me.id);
  if (!o) return null;
  const band = creditBand(o.creditScore);
  const history = eco.creditEvents.filter((e) => e.playerId === me.id).reverse();
  const loanName = (id: string | null) => {
    const loan = id ? eco.loans.find((l) => l.id === id) : null;
    return loan ? LOANS.products[loan.product].name : null;
  };
  const fill = Math.round(((o.creditScore - IR.credit.min) * 100) / (IR.credit.max - IR.credit.min));
  return (
    <View className="gap-3" testID="finance-credit">
      <Card className="items-center bg-white">
        <Label>Credit score</Label>
        <Text className="text-5xl font-black text-ink" testID="credit-score" accessibilityLabel={`Credit score ${o.creditScore} out of ${IR.credit.max}`}>
          {o.creditScore}
          <Text className="text-xl font-bold text-stone-500"> / {IR.credit.max}</Text>
        </Text>
        <Pill tone={band.adjustPercent < 0 ? 'good' : band.adjustPercent === 0 ? 'neutral' : 'bad'}>{band.label}</Pill>
        <View className="mt-3 h-2.5 self-stretch overflow-hidden rounded-full bg-stone-200">
          <View className="h-2.5 rounded-full bg-felt" style={{ width: `${fill}%` }} />
        </View>
        <Text className="mt-2 text-center text-sm text-stone-600">
          New loan offers are {band.adjustPercent === 0 ? 'at the base rate' : `${Math.abs(band.adjustPercent)} point${Math.abs(band.adjustPercent) === 1 ? '' : 's'} ${band.adjustPercent < 0 ? 'cheaper' : 'dearer'} than the base rate`}{' '}
          for you. Loans you already signed keep their rate.
        </Text>
      </Card>

      {o.defaultedAmount > 0 ? <Note tone="bad">In default: {formatINR(o.defaultedAmount)} owed. No new loans until it is cleared.</Note> : null}
      {o.overdueAmount > 0 ? <Note tone="bad">Overdue: {formatINR(o.overdueAmount)}. No new loans until it is paid.</Note> : null}

      <Card className="bg-white">
        <Label>Your debt</Label>
        <Row label="Outstanding loan principal" value={formatINR(o.loanPrincipal)} />
        <Row label="Net assets" value={formatINR(o.netAssets)} />
        <Row label="Debt-to-assets ratio" value={ratioText(o.debtRatio)} bold testID="credit-debt-ratio" />
        <Text className="mt-1 text-xs text-stone-500">Loan principal ÷ (cash + property and buildings − mortgages to redeem). Lower is safer.</Text>
      </Card>

      <Card className="bg-white" testID="credit-bands">
        <Label>How the score sets new rates</Label>
        {IR.credit.bands.map((b) => (
          <View key={b.label} className={`mt-1 flex-row justify-between rounded-lg px-2 py-1 ${b.label === band.label ? 'bg-amber-100' : ''}`}>
            <Text className="text-sm text-stone-700">
              {b.min}–{b.max} · {b.label}
            </Text>
            <Text className="text-sm font-bold text-ink">{b.adjustPercent === 0 ? 'base rate' : `${signed(b.adjustPercent)} points`}</Text>
          </View>
        ))}
      </Card>

      <Card className="bg-white" testID="credit-history">
        <Label>Score history</Label>
        {history.length ? (
          history.map((e) => (
            <View key={e.id} className="mt-2 flex-row items-center justify-between gap-3" testID="credit-event">
              <View className="flex-1">
                <Text className="text-sm font-bold text-ink">{e.reason}</Text>
                <Text className="text-xs text-stone-500">
                  Year {e.year}
                  {loanName(e.loanId) ? ` · ${loanName(e.loanId)}` : ''} · {e.before} → {e.after}
                </Text>
              </View>
              <Text className={`text-base font-extrabold ${e.delta >= 0 ? 'text-green-700' : 'text-brick'}`}>{signed(e.delta)}</Text>
            </View>
          ))
        ) : (
          <Text className="mt-1 text-sm text-stone-600">No changes yet. Everyone starts at {IR.credit.start}.</Text>
        )}
      </Card>

      <Card className="bg-white">
        <Label>What moves it</Label>
        <Row label="Payment made on time" value={signed(IR.credit.events.ON_TIME_PAYMENT)} />
        <Row label="Payment becomes overdue" value={signed(IR.credit.events.INSTALLMENT_OVERDUE)} />
        <Row label="Overdue payment caught up" value={signed(IR.credit.events.CAUGHT_UP)} />
        <Row label="Loan goes into default" value={signed(IR.credit.events.LOAN_DEFAULT)} />
        <Row label="Loan fully repaid as agreed" value={signed(IR.credit.events.LOAN_REPAID)} />
        <Row label="A year with a loan and nothing overdue" value={signed(IR.credit.events.CLEAN_YEAR)} />
      </Card>
    </View>
  );
}
