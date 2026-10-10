import { Text, View } from 'react-native';
import { getDeed, INTERMEDIATE_RULES, pledgedLoan, propertyValuation, type GameState, type PropertyKey } from '@/engine/index.ts';
import { Label, Pill } from '@/components/ui';
import { formatINR } from '@/utils/currency';

const IR = INTERMEDIATE_RULES;

function Line({ label, value, tone, testID }: { label: string; value: string; tone?: 'up' | 'down'; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-0.5" testID={testID}>
      <Text className="flex-1 text-sm text-stone-600">{label}</Text>
      <Text className={`text-right text-base font-bold ${tone === 'up' ? 'text-green-700' : tone === 'down' ? 'text-brick' : 'text-ink'}`}>{value}</Text>
    </View>
  );
}

const percent = (n: number) => `${n > 0 ? '+' : ''}${n}%`;

/**
 * Intermediate Mode's valuation block on the title deed: what the property cost originally, what
 * the market says today, where its trend points, and what that is worth after inflation.
 * Renders nothing in a Classic game. All figures are the server's.
 */
export function PropertyValuation({ state, propertyKey }: { state: GameState; propertyKey: PropertyKey }) {
  const v = propertyValuation(state, propertyKey);
  if (!v) return null;
  const pledged = pledgedLoan(state, propertyKey);
  const change = v.lastChangePercent;
  const sinceStart = v.marketValue - v.originalPrice;
  return (
    <View className="gap-1 rounded-2xl bg-white p-3" testID="property-valuation">
      <View className="flex-row items-center justify-between">
        <Label>Market value</Label>
        {pledged ? <Pill tone="warn">Pledged as loan collateral</Pill> : null}
      </View>
      <Line label="Original price" value={formatINR(v.originalPrice)} testID="valuation-original" />
      <Line label="Current market value" value={formatINR(v.marketValue)} tone={sinceStart > 0 ? 'up' : sinceStart < 0 ? 'down' : undefined} testID="valuation-market" />
      <Line
        label="This year’s change"
        value={change === null ? 'None yet (Year 1)' : percent(change)}
        tone={change !== null && change > 0 ? 'up' : change !== null && change < 0 ? 'down' : undefined}
        testID="valuation-change"
      />
      <Line label="Expected trend" value={`${percent(v.trendPercent)} a year`} testID="valuation-trend" />
      <Line label={`Projected value in ${v.projectionYears} years`} value={formatINR(v.projectedValue)} testID="valuation-projection" />
      <Text className="text-xs text-stone-500" testID="valuation-projection-note">
        A projection, not a guaranteed price: today’s value growing at the expected trend. Each year’s real market change is unknown until it happens.
      </Text>
      <Line
        label={v.inflationYears > 0 ? 'Value in Year-1 money' : 'Value in today’s money'}
        value={formatINR(v.realValue)}
        tone={v.inflationYears > 0 ? (v.realValue >= v.originalPrice ? 'up' : 'down') : undefined}
        testID="valuation-real"
      />
      <Text className="text-xs text-stone-500">
        {v.inflationYears > 0
          ? `After ${v.inflationYears} year${v.inflationYears === 1 ? '' : 's'} of ${IR.inflation.ratePercent}% inflation, ${formatINR(v.marketValue)} buys what ${formatINR(v.realValue)} did in Year 1. ${
              v.realValue >= v.originalPrice ? 'It has kept ahead of inflation.' : 'It has not kept up with inflation.'
            }`
          : `Inflation is ${IR.inflation.ratePercent}% a year: a value has to grow that fast just to keep its buying power.`}
      </Text>
      {pledged ? (
        <Text className="text-xs font-semibold text-amber-800" testID="valuation-pledged">
          {getDeed(propertyKey).name} secures a loan. It still earns rent, but can’t be mortgaged, sold, traded or built on until that loan is repaid.
        </Text>
      ) : null}
    </View>
  );
}
