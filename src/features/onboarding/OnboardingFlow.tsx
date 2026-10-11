import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Easing, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { haptics } from '@/utils/haptics';
import { ONBOARDING_LABELS, ONBOARDING_PAGES } from './content';
import { OnboardingScene } from './scenes';
import { onboardingMotion, useSceneMotion } from './timeline';

const LAST = ONBOARDING_PAGES.length - 1;
/** Headlines and controls follow the phone's font setting, but not so far that they push the button away. */
const MAX_FONT_SCALE = 1.5;

/** A page's content arriving: a short fade and slide, or simply there when motion is off. */
function Arrive({ children }: { children: ReactNode }) {
  const animate = useSceneMotion();
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));
  useEffect(() => {
    if (!animate) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: onboardingMotion.useNativeDriver });
    anim.start();
    return () => anim.stop();
  }, [animate, progress]);
  return <Animated.View style={{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>{children}</Animated.View>;
}

function TopAction({ label, hint, testID, onPress }: { label: string; hint: string; testID: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={hint} testID={testID} hitSlop={8} className="min-h-[44px] justify-center px-3 active:opacity-70">
      <Text className="text-base font-extrabold text-cream" maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The first-launch introduction: three pages, each a short animated scene of the game with a
 * headline under it. It only ever shows pictures — it starts no game, reads no game and sends
 * nothing anywhere. `onFinish` is called exactly once, by Skip or by the last page's button;
 * what happens next (remembering it, where to go) is the caller's business.
 */
export function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  const finished = useRef(false);
  const lastMove = useRef(0);
  const page = ONBOARDING_PAGES[step]!;

  const move = useCallback((by: 1 | -1) => {
    // Two taps in quick succession are one tap: a page is never skipped by accident.
    const now = Date.now();
    if (finished.current || now - lastMove.current < onboardingMotion.tapGuardMs) return;
    lastMove.current = now;
    haptics.tap();
    setStep((s) => Math.min(LAST, Math.max(0, s + by)));
  }, []);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onFinish();
  }, [onFinish]);

  // Android's back button steps back through the pages before it leaves the introduction.
  useEffect(() => {
    if (step === 0) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setStep((s) => Math.max(0, s - 1));
      return true;
    });
    return () => sub.remove();
  }, [step]);

  // A new page is said once; the first is read by the screen reader landing on the screen.
  const announced = useRef(0);
  useEffect(() => {
    if (announced.current === step) return;
    announced.current = step;
    AccessibilityInfo.announceForAccessibility?.(`${ONBOARDING_LABELS.step(step + 1, ONBOARDING_PAGES.length)}. ${page.headline}`);
  }, [step, page.headline]);

  const measure = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setArea((now) => (now && now.width === width && now.height === height ? now : { width, height }));
  }, []);

  return (
    <SafeAreaView testID="onboarding-screen" className="flex-1 bg-felt" edges={['top', 'bottom', 'left', 'right']}>
      <View className="min-h-[52px] flex-row items-center px-2">
        <View className="flex-1 items-start">{step > 0 ? <TopAction label={`‹ ${ONBOARDING_LABELS.back}`} hint={ONBOARDING_LABELS.backHint} testID="onboarding-back" onPress={() => move(-1)} /> : null}</View>
        <View className="flex-row items-center gap-1.5 px-2" accessible accessibilityRole="text" accessibilityLabel={ONBOARDING_LABELS.step(step + 1, ONBOARDING_PAGES.length)} testID="onboarding-steps">
          {ONBOARDING_PAGES.map((p, i) => (
            <View key={p.scene} className={`h-2 rounded-full ${i === step ? 'w-6 bg-saffron' : 'w-2 bg-cream/40'}`} />
          ))}
        </View>
        <View className="flex-1 items-end">{step < LAST ? <TopAction label={ONBOARDING_LABELS.skip} hint={ONBOARDING_LABELS.skipHint} testID="onboarding-skip" onPress={finish} /> : null}</View>
      </View>

      {/* Scrolls only when the page cannot fit (a very short screen, a very large font); the button below never moves. */}
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }} bounces={false} showsVerticalScrollIndicator={false}>
        <View
          className="min-h-[150px] flex-1 items-center justify-center overflow-hidden px-5 py-2"
          onLayout={measure}
          testID="onboarding-art"
          accessible
          accessibilityRole="image"
          accessibilityLabel={page.sceneLabel}
        >
          {area ? (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {/* Keyed by page: only the scene on screen exists, and returning to a page plays it again. */}
              <OnboardingScene key={page.scene} scene={page.scene} width={area.width - 40} height={area.height - 16} />
            </View>
          ) : null}
        </View>
        <View className="px-6 pb-4 pt-3" testID={`onboarding-page-${step + 1}`}>
          <Arrive key={page.scene}>
            <View className="gap-2">
              <Text accessibilityRole="header" className="text-center text-3xl font-black text-cream" maxFontSizeMultiplier={MAX_FONT_SCALE} testID="onboarding-headline">
                {page.headline}
              </Text>
              <Text className="text-center text-base font-semibold leading-6 text-cream/90" maxFontSizeMultiplier={MAX_FONT_SCALE} testID="onboarding-description">
                {page.description}
              </Text>
            </View>
          </Arrive>
        </View>
      </ScrollView>

      <View className="px-5 pb-3 pt-2">
        <Button title={page.action} testID="onboarding-next" onPress={() => (step === LAST ? finish() : move(1))} />
      </View>
    </SafeAreaView>
  );
}
