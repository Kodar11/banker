import { Text, View } from 'react-native';
import {
  averageSpaces,
  COVERED_CRISIS_LABELS,
  INTERMEDIATE_RULES,
  type IntermediateState,
  type PremiumBreakdown,
} from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';

const INS = INTERMEDIATE_RULES.insurance;

function Term({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-0.5" testID={testID}>
      <Text className="flex-1 text-sm text-stone-600">{label}</Text>
      <Text className="max-w-[60%] text-right text-sm font-bold text-ink">{value}</Text>
    </View>
  );
}

const percent = (p: number) => (p > 0 ? `−${p}%` : 'None');

/** How a renewal is priced, in one line. */
export const RENEWAL_RULE = `Optional, never automatic: from this period's crisis until ${INS.renewalGraceSpaces} spaces after cover ends, at that year's price less your discounts.`;
export const CANCELLATION_RULE = 'A policy runs to the end of its period: it cannot be cancelled, and unused cover is never refunded.';

/**
 * The terms of a policy before it is bought or renewed, as the server will charge and apply them:
 * the total and per-property premium, every discount, the period, what is covered, the payout limit,
 * the deductible, and how renewal and cancellation work. Every number comes from the engine's quote.
 */
export function PolicyTerms({
  eco,
  pricing,
  startClock,
  expiryClock,
  claimedBefore,
  testID = 'policy-terms',
}: {
  eco: IntermediateState;
  pricing: PremiumBreakdown;
  startClock: number;
  expiryClock: number;
  /** A renewal: what the period it renews paid out (the new period starts with the full limit). */
  claimedBefore?: number;
  testID?: string;
}) {
  const crises = INS.coveredCrises.map((t) => COVERED_CRISIS_LABELS[t]).join(', ');
  return (
    <View className="rounded-2xl bg-white p-3" testID={testID}>
      <Term label="Total premium" value={formatINR(pricing.premium)} testID={`${testID}-total`} />
      {pricing.properties > 1 ? (
        <Term label={`Per property (${pricing.properties})`} value={formatINR(Math.round(pricing.premium / pricing.properties))} testID={`${testID}-per-property`} />
      ) : null}
      <Term label={`Base · Year ${eco.year}`} value={`${pricing.properties} × ${formatINR(pricing.basePremium)}`} />
      <Term label="Portfolio discount" value={percent(pricing.portfolioPercent)} testID={`${testID}-portfolio`} />
      <Term label="Early-buyer discount" value={claimedBefore === undefined ? 'Renewals only' : percent(pricing.loyaltyPercent)} testID={`${testID}-loyalty`} />
      <Term label="No-claim discount" value={claimedBefore === undefined ? 'Renewals only' : percent(pricing.noClaimPercent)} testID={`${testID}-no-claim`} />
      {pricing.discountPercent > 0 ? <Term label={`Total discount (max ${INS.maxTotalDiscountPercent}%)`} value={`−${pricing.discountPercent}%`} /> : null}
      <Term label="Cover" value={`${averageSpaces(eco, startClock)} → ${averageSpaces(eco, expiryClock)} avg. spaces (${INS.coverageSpaces})`} testID={`${testID}-period`} />
      <Term label="Covers" value={crises} />
      <Term label="Maximum payout" value={`${formatINR(INS.payoutLimit)} per period`} testID={`${testID}-limit`} />
      {claimedBefore !== undefined ? (
        <Term label="Claimed this period" value={`${formatINR(claimedBefore)} · new period starts with the full ${formatINR(INS.payoutLimit)}`} testID={`${testID}-claimed`} />
      ) : null}
      <Term label="Deductible" value={formatINR(INS.deductible)} />
      <Text className="mt-1 text-xs text-stone-500">Renewal: {RENEWAL_RULE}</Text>
      <Text className="mt-1 text-xs text-stone-500">{CANCELLATION_RULE}</Text>
    </View>
  );
}
