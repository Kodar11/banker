import { Text, View } from 'react-native';
import { formatINR } from '@/utils/currency';
import { repaymentSchedule, totalRepaid, type RepaymentYear } from '../calc';
import { GrowBar, Reveal } from '../motion';
import type { LoanComparisonScene as LoanComparisonData } from '../types';
import { Panel, Tag } from './parts';

interface RowProps {
  title: string;
  rates: string;
  schedule: RepaymentYear[];
  top: number;
  index: number;
  chosen?: boolean;
  hypothetical?: boolean;
  /** Total repaid on the fixed loan, to state the difference in words. */
  against?: number;
}

function LoanRow({ title, rates, schedule, top, index, chosen, hypothetical, against }: RowProps) {
  const total = totalRepaid(schedule);
  const diff = against === undefined ? 0 : total - against;
  return (
    <Reveal index={index}>
      <View className={`gap-1.5 rounded-xl border px-2.5 py-2 ${chosen ? 'border-saffron bg-amber-50' : 'border-stone-200 bg-stone-50'}`} testID={`scene-loan-row-${index}`}>
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text className="text-sm font-extrabold text-ink">{title}</Text>
          {hypothetical ? <Tag tone="warn">Hypothetical</Tag> : null}
          {chosen ? <Tag tone="gold">Your choice</Tag> : null}
        </View>
        <Text className="text-xs text-stone-600">Rate: {rates}</Text>
        <View className="flex-row gap-2">
          {schedule.map((line) => (
            <View key={line.year} className="flex-1" accessible accessibilityLabel={`Year ${line.year}: ${formatINR(line.payment)} at ${line.ratePercent} percent`}>
              <Text className="text-[11px] text-stone-500">Year {line.year}</Text>
              <Text className="text-sm font-bold text-ink">{formatINR(line.payment)}</Text>
            </View>
          ))}
        </View>
        <View className="gap-1">
          <View className="flex-row items-baseline justify-between gap-2">
            <Text className="text-xs font-bold text-stone-600">Total repaid</Text>
            <Text className="text-base font-black text-ink">{formatINR(total)}</Text>
          </View>
          <GrowBar fraction={total / top} index={index} height={6} color={hypothetical ? '#F59E0B' : '#1B7A4D'} />
          {against !== undefined ? (
            <Text className="text-xs font-semibold text-stone-700">
              {diff === 0 ? 'The same as the fixed loan' : `${formatINR(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the fixed loan`}
            </Text>
          ) : null}
        </View>
      </View>
    </Reveal>
  );
}

/**
 * A fixed-rate loan beside a variable-rate one. The fixed schedule never changes; the variable
 * loan is shown under each labelled, hypothetical rate path the lesson defines.
 */
export function LoanComparisonScene({ scene }: { scene: LoanComparisonData }) {
  const fixed = repaymentSchedule(scene.principal, Array.from({ length: scene.years }, () => scene.fixedRatePercent));
  const fixedTotal = totalRepaid(fixed);
  const paths = scene.variablePaths.map((path) => ({ ...path, schedule: repaymentSchedule(scene.principal, path.ratesByYear) }));
  const top = Math.max(fixedTotal, ...paths.map((p) => totalRepaid(p.schedule)));
  return (
    <Panel title={`${formatINR(scene.principal)} over ${scene.years} years`} testID="scene-loan-comparison">
      <LoanRow title="Fixed rate" rates={`${scene.fixedRatePercent}% every year`} schedule={fixed} top={top} index={0} chosen={scene.focus === 'fixed'} />
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[11px] font-extrabold uppercase tracking-wider text-stone-500">Variable rate — example paths</Text>
        {scene.focus === 'variable' ? <Tag tone="gold">Your choice</Tag> : null}
      </View>
      {paths.map((path, i) => (
        <LoanRow key={path.label} title={path.label} rates={path.ratesByYear.map((r) => `${r}%`).join(' → ')} schedule={path.schedule} top={top} index={i + 1} hypothetical against={fixedTotal} />
      ))}
    </Panel>
  );
}
