import { Text, View } from 'react-native';
import { formatINR } from '@/utils/currency';
import { futureValue, presentValue } from '../calc';
import { GrowBar, Reveal } from '../motion';
import type { PresentValueScene } from '../types';
import { Panel, Tag } from './parts';

function Point({ when, amount, chosen }: { when: string; amount: number; chosen: boolean }) {
  return (
    <View className={`flex-1 items-center gap-1 rounded-xl border px-2 py-2 ${chosen ? 'border-saffron bg-amber-50' : 'border-stone-200 bg-stone-50'}`}>
      <Text className="text-[11px] font-extrabold uppercase tracking-wider text-stone-500">{when}</Text>
      <Text className="text-xl font-black text-ink">{formatINR(amount)}</Text>
      {chosen ? <Tag tone="gold">Your choice</Tag> : null}
    </View>
  );
}

/**
 * Today against later, on one timeline. The later payment is discounted back to today
 * (PV = FV / (1 + r)^n) so the two amounts can be compared on the same date.
 */
export function PresentValueTimeline({ scene }: { scene: PresentValueScene }) {
  const { today, future, years, ratePercent } = scene;
  const pv = presentValue(future, ratePercent, years);
  const grown = futureValue(today, ratePercent, years);
  const factor = `(${(1 + ratePercent / 100).toFixed(2)})^${years}`;
  const later = `in ${years} years`;
  return (
    <Panel title="Timeline" testID="scene-present-value">
      <View className="flex-row items-stretch gap-2">
        <Point when="Today" amount={today} chosen={!scene.hideDiscount && scene.taken === 'today'} />
        <View className="items-center justify-center" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text className="text-[11px] font-bold text-stone-500">{years} yrs</Text>
          <Text className="text-lg text-stone-400">⟶</Text>
        </View>
        <Point when={`In ${years} years`} amount={future} chosen={!scene.hideDiscount && scene.taken === 'future'} />
      </View>
      {scene.hideDiscount ? (
        <Text className="text-xs leading-5 text-stone-600">Assumed: the later payment is certain, and money in hand could earn {ratePercent}% a year.</Text>
      ) : (
        <>
          <Reveal index={1}>
            <View className="gap-1 rounded-xl bg-stone-50 px-3 py-2" testID="scene-present-value-discount">
              <Text className="text-[11px] font-extrabold uppercase tracking-wider text-stone-500">Bring the later payment back to today</Text>
              <Text className="text-xs text-stone-600">PV = FV / (1 + r)^n</Text>
              <Text className="text-base font-extrabold text-ink">
                {formatINR(future)} / {factor} ≈ {formatINR(pv)}
              </Text>
            </View>
          </Reveal>
          <Reveal index={2}>
            <View className="gap-1.5" testID="scene-present-value-compare">
              <Text className="text-[11px] font-extrabold uppercase tracking-wider text-stone-500">Both in today’s money</Text>
              <View className="gap-1">
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-sm text-stone-700">Paid today</Text>
                  <Text className="text-sm font-extrabold text-ink">{formatINR(today)}</Text>
                </View>
                <GrowBar fraction={today / Math.max(today, pv)} index={2} />
              </View>
              <View className="gap-1">
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-sm text-stone-700">
                    {formatINR(future)} {later}
                  </Text>
                  <Text className="text-sm font-extrabold text-ink">≈ {formatINR(pv)}</Text>
                </View>
                <GrowBar fraction={pv / Math.max(today, pv)} index={3} color="#F59E0B" />
              </View>
              <Text className="text-xs leading-5 text-stone-600">
                {today === pv
                  ? 'Under these assumptions the two are worth the same today.'
                  : `Under these assumptions, ${today > pv ? 'the payment today' : 'the later payment'} is worth ${formatINR(Math.abs(today - pv))} more in today’s money.`}
              </Text>
            </View>
          </Reveal>
          {scene.taken === 'today' ? (
            <Reveal index={3}>
              <Text className="text-xs leading-5 text-stone-600" testID="scene-present-value-grown">
                The other direction: {formatINR(today)} × {factor} = {formatINR(grown)} {later}, if it earns {ratePercent}% a year.
              </Text>
            </Reveal>
          ) : null}
        </>
      )}
    </Panel>
  );
}
