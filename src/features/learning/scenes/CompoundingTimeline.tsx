import { Text, View } from 'react-native';
import { formatINR } from '@/utils/currency';
import { futureValue, growthSeries } from '../calc';
import { GrowBar, Reveal } from '../motion';
import type { GrowthScene } from '../types';
import { Panel, Tag } from './parts';

const factorOf = (ratePercent: number, years: number) => `(${(1 + ratePercent / 100).toFixed(2)})^${years}`;

/**
 * An amount growing year by year at a stated rate: the compounding story and the future-value
 * projection. Other outcomes, when a lesson gives them, are explicit predefined paths drawn
 * beside the main one — a projection is shown as one scenario among several.
 */
export function CompoundingTimeline({ scene }: { scene: GrowthScene }) {
  const { principal, ratePercent, years } = scene;
  const series = growthSeries(principal, ratePercent, years);
  const final = series[years]!;
  const alternatives = (scene.alternatives ?? []).map((a) => ({ ...a, value: futureValue(principal, a.ratePercent, years) }));
  const top = Math.max(final, ...alternatives.map((a) => a.value), principal);
  return (
    <Panel title={scene.title} testID="scene-growth">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-bold text-ink">{scene.subject}</Text>
        <Tag tone="warn">Hypothetical</Tag>
      </View>
      <View className="gap-1.5">
        {series.map((value, year) => (
          <View key={year} className="flex-row items-center gap-2" accessible accessibilityLabel={`${year === 0 ? 'Today' : `Year ${year}`}: ${formatINR(value)}`}>
            <Text className="w-[52px] text-xs font-bold text-stone-600">{year === 0 ? 'Today' : `Year ${year}`}</Text>
            <View className="flex-1">
              <GrowBar fraction={value / top} index={year} height={year === years ? 10 : 7} color={year === years ? '#F59E0B' : '#1B7A4D'} />
            </View>
            <Text className={`w-[64px] text-right text-sm text-ink ${year === years ? 'font-black' : 'font-bold'}`} testID={`scene-growth-year-${year}`}>
              {formatINR(value)}
            </Text>
          </View>
        ))}
      </View>
      <View className="gap-0.5 rounded-xl bg-stone-50 px-3 py-2" testID="scene-growth-formula">
        <Text className="text-xs text-stone-600">FV = PV × (1 + r)^n</Text>
        <Text className="text-base font-extrabold text-ink">
          {formatINR(principal)} × {factorOf(ratePercent, years)} ≈ {formatINR(final)}
        </Text>
      </View>
      {alternatives.length > 0 ? (
        <Reveal index={years + 1}>
          <View className="gap-1.5 border-t border-stone-200 pt-2" testID="scene-growth-alternatives">
            <Text className="text-[11px] font-extrabold uppercase tracking-wider text-stone-500">Other predefined paths, after {years} years</Text>
            {alternatives.map((a, i) => (
              <View key={a.label} className="gap-1" accessible accessibilityLabel={`${a.label}: about ${formatINR(a.value)}`}>
                <View className="flex-row items-baseline justify-between gap-2">
                  <Text className="flex-1 text-sm text-stone-700">{a.label}</Text>
                  <Text className="text-sm font-extrabold text-ink">≈ {formatINR(a.value)}</Text>
                </View>
                <GrowBar fraction={a.value / top} index={years + 1 + i} height={6} color="#78716C" />
              </View>
            ))}
            <Text className="text-xs leading-5 text-stone-600">Each path is an example fixed for this story. None is a prediction.</Text>
          </View>
        </Reveal>
      ) : null}
    </Panel>
  );
}
