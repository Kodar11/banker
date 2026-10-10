import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { INTERMEDIATE_RULES } from '@/engine/index.ts';
import { Button } from '@/components/ui';

const IR = INTERMEDIATE_RULES;
/** Set once this device has seen the introduction; it is then never shown again. */
export const INTRO_SEEN_KEY = 'business-banker.intermediate-intro.v1';

const SLIDES: { icon: string; title: string; body: string }[] = [
  {
    icon: '📅',
    title: 'Financial years',
    body: `The table shares one calendar. Every time players have moved ${IR.year.spacesPerYear} spaces on average, a new financial year begins for everyone.`,
  },
  {
    icon: '🏘️',
    title: 'Property values change',
    body: 'Each new year, every property’s market value can rise, hold or fall. The bank sells at the current value. Property details show a five-year estimate — a projection, not a promise.',
  },
  {
    icon: '🛒',
    title: 'Inflation',
    body: `Prices rise ${IR.inflation.ratePercent}% a year, so the same cash buys a little less each year. Property details show what a value is worth in today’s money.`,
  },
  {
    icon: '🏦',
    title: 'Five kinds of loan',
    body: 'Bank / Loan now offers five loans with different rates and lengths. You see the full contract before you accept, and you repay once a year, starting a full year after borrowing.',
  },
  {
    icon: '📈',
    title: 'Credit score',
    body: `Everyone starts at ${IR.credit.start}. Paying on time raises it and makes new loans cheaper. Late payments lower it. Leave one unpaid for a year and the loan defaults — a secured loan then costs you the pledged property.`,
  },
];

/**
 * The short Intermediate Mode introduction, shown once per device when its first Intermediate
 * game starts. It can be skipped at any moment and closes by itself after about half a minute.
 * It is only this phone's overlay: the shared game never waits for it.
 */
export function IntermediateIntro() {
  const [visible, setVisible] = useState(false);
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(INTRO_SEEN_KEY)
      .then((seen) => {
        if (!cancelled && !seen) setVisible(true);
      })
      // Storage unavailable: better to skip the introduction than to show it every time.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(() => {
    setVisible(false);
    SecureStore.setItemAsync(INTRO_SEEN_KEY, '1').catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(finish, IR.notifications.introAutoCloseSeconds * 1000);
    return () => clearTimeout(timer);
  }, [visible, finish]);

  if (!visible) return null;
  const current = SLIDES[slide]!;
  const last = slide === SLIDES.length - 1;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={finish}>
      <View className="flex-1 items-center justify-center bg-black/60 px-5" testID="intermediate-intro">
        <View className="w-full max-w-[420px] gap-4 rounded-3xl bg-cream p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-extrabold uppercase tracking-[3px] text-stone-500">Intermediate Mode</Text>
            <Pressable onPress={finish} accessibilityRole="button" accessibilityLabel="Skip introduction" testID="intro-skip" className="min-h-[44px] justify-center px-2">
              <Text className="text-sm font-extrabold text-stone-600">Skip</Text>
            </Pressable>
          </View>
          <View className="items-center gap-2" testID={`intro-slide-${slide + 1}`}>
            <Text className="text-5xl">{current.icon}</Text>
            <Text className="text-center text-2xl font-black text-ink">{current.title}</Text>
            <Text className="text-center text-base text-stone-700">{current.body}</Text>
          </View>
          <View className="flex-row justify-center gap-1.5" accessibilityLabel={`Step ${slide + 1} of ${SLIDES.length}`}>
            {SLIDES.map((s, i) => (
              <View key={s.title} className={`h-2 rounded-full ${i === slide ? 'w-5 bg-felt' : 'w-2 bg-stone-300'}`} />
            ))}
          </View>
          <View className="flex-row gap-3">
            {slide > 0 ? <Button className="flex-1" size="md" variant="secondary" title="Back" testID="intro-back" onPress={() => setSlide((s) => s - 1)} /> : null}
            <Button className="flex-1" size="md" title={last ? 'Start playing' : 'Next'} testID="intro-next" onPress={() => (last ? finish() : setSlide((s) => s + 1))} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
