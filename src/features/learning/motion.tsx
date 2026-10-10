import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, Text, View, type DimensionValue } from 'react-native';
import { useReduceMotion } from '@/utils/useReduceMotion';

/**
 * Lesson animation, in one place. Motion only ever decorates: every figure a scene animates is
 * also there as plain text, so a lesson reads the same with motion switched off.
 * Tests set `enabled` to false to see final values at once.
 */
export const learningMotion = { enabled: true, useNativeDriver: Platform.OS !== 'web' };

export const STAGGER_MS = 140;
/** How long a tapped choice stays highlighted before its consequence is shown. */
export const CHOICE_HOLD_MS = 380;

/** True when scenes may animate: not switched off, and the device does not ask for reduced motion. */
export function useMotion(): boolean {
  const reduce = useReduceMotion();
  return learningMotion.enabled && !reduce;
}

/** Fades and slides its children in. `index` staggers siblings; `from` is the side they arrive from. */
export function Reveal({ children, index = 0, from = 'below' }: { children: ReactNode; index?: number; from?: 'below' | 'left' | 'right' }) {
  const animate = useMotion();
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));
  /** Whether the value may still be short of its end (it started hidden); a value that began at its end is left alone. */
  const pending = useRef(animate);
  useEffect(() => {
    if (!animate) {
      if (pending.current) progress.setValue(1);
      pending.current = false;
      return;
    }
    const anim = Animated.timing(progress, { toValue: 1, duration: 320, delay: index * STAGGER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: learningMotion.useNativeDriver });
    anim.start();
    return () => anim.stop();
  }, [animate, index, progress]);
  const offset = progress.interpolate({ inputRange: [0, 1], outputRange: [from === 'left' ? -28 : from === 'right' ? 28 : 14, 0] });
  return <Animated.View style={{ opacity: progress, transform: [from === 'below' ? { translateY: offset } : { translateX: offset }] }}>{children}</Animated.View>;
}

interface CountUpProps {
  from: number;
  to: number;
  format: (value: number) => string;
  className?: string;
  testID?: string;
  delay?: number;
}

/** A number that counts from one value to another. Screen readers always get the final value. */
export function CountUp({ from, to, format, className, testID, delay = 0 }: CountUpProps) {
  const animate = useMotion() && from !== to;
  /** The value the running count has reached; null until it starts. */
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    if (!animate) return;
    const value = new Animated.Value(from);
    const id = value.addListener((v) => setLive(Math.round(v.value)));
    // Drives a text value, so it cannot use the native driver.
    const anim = Animated.timing(value, { toValue: to, duration: 700, delay, easing: Easing.out(Easing.quad), useNativeDriver: false });
    anim.start(({ finished }) => finished && setLive(to));
    return () => {
      anim.stop();
      value.removeListener(id);
    };
  }, [animate, from, to, delay]);
  return (
    <Text className={className} testID={testID} accessibilityLabel={format(to)}>
      {format(animate ? (live ?? from) : to)}
    </Text>
  );
}

/** A horizontal bar that grows to `fraction` (0–1) of its track. Decorative: the value is always printed beside it. */
export function GrowBar({ fraction, index = 0, color = '#1B7A4D', height = 8 }: { fraction: number; index?: number; color?: string; height?: number }) {
  const animate = useMotion();
  const target = Math.max(0.02, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));
  /** Whether the value may still be short of its end (it started hidden); a value that began at its end is left alone. */
  const pending = useRef(animate);
  useEffect(() => {
    if (!animate) {
      if (pending.current) progress.setValue(1);
      pending.current = false;
      return;
    }
    // Animates a width, which the native driver cannot do.
    const anim = Animated.timing(progress, { toValue: 1, duration: 450, delay: index * STAGGER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [animate, index, progress]);
  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${Math.round(target * 100)}%`] }) as unknown as DimensionValue;
  return (
    <View className="overflow-hidden rounded-full bg-stone-200" style={{ height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* Styled inline: an animated view takes no NativeWind classes. */}
      <Animated.View style={{ height, width, borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}
