import { useEffect, useState } from 'react';
import { Animated, AppState, Easing, Platform } from 'react-native';
import { useReduceMotion } from '@/utils/useReduceMotion';

/**
 * Introduction animation, in one place. Tests set `enabled` to false to see every scene in its
 * final state at once, and `tapGuardMs` to 0 to step through without waiting.
 */
export const onboardingMotion = {
  enabled: true,
  useNativeDriver: Platform.OS !== 'web',
  /** Taps on Continue / Back closer together than this count as one. */
  tapGuardMs: 350,
};

/** True when scenes may animate: not switched off, and the device does not ask for reduced motion. */
export function useSceneMotion(): boolean {
  const reduce = useReduceMotion();
  return onboardingMotion.enabled && !reduce;
}

export type Ease = (x: number) => number;

export const ease = {
  linear: (x: number) => x,
  in: (x: number) => x * x * x,
  out: (x: number) => 1 - (1 - x) ** 3,
  inOut: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  /** Overshoots a little before settling: a piece popping into place. */
  pop: (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
} satisfies Record<string, Ease>;

/** One movement of a value: [starts at (ms), ends at (ms), value it reaches, easing]. */
export type Move = readonly [from: number, to: number, value: number, ease?: Ease];

export interface Track {
  inputRange: number[];
  outputRange: number[];
  extrapolate: 'clamp';
}

/** Points an eased movement is sampled at. The native driver only interpolates in straight lines. */
const SAMPLES = 6;
/** Keeps two keyframes from sharing an instant (ms). */
const EPSILON = 0.01;

/**
 * A value's whole life over a scene of `total` ms, as one interpolation of the scene's 0→1 clock:
 * it holds `initial`, then makes each move in turn and holds what it reached. Moves must be in
 * time order. Because everything hangs off one clock, a scene is a single animation to start,
 * stop or jump to its end.
 */
export function track(total: number, initial: number, moves: readonly Move[]): Track {
  const times = [0];
  const values = [initial];
  const push = (time: number, value: number) => {
    const last = times[times.length - 1]!;
    times.push(time > last ? time : last + EPSILON);
    values.push(value);
  };
  let current = initial;
  for (const [from, to, value, easing = ease.out] of moves) {
    push(from, current);
    const steps = easing === ease.linear ? 1 : SAMPLES;
    for (let i = 1; i <= steps; i++) push(from + (Math.max(to, from + 1) - from) * (i / steps), current + (value - current) * easing(i / steps));
    current = value;
  }
  push(Math.max(total, times[times.length - 1]! + 1), current);
  const end = times[times.length - 1]!;
  return { inputRange: times.map((time) => time / end), outputRange: values, extrapolate: 'clamp' };
}

/**
 * A scene's clock: runs once from 0 to 1 over `duration` ms and stays there. With motion off it
 * starts at 1 (the finished picture). Leaving the screen or the app stops it; a scene is mounted
 * only while it is the one on screen, so coming back to it plays it again from the start.
 */
export function useTimeline(duration: number): Animated.Value {
  const animate = useSceneMotion();
  const [clock] = useState(() => new Animated.Value(animate ? 0 : 1));
  useEffect(() => {
    if (!animate) {
      clock.setValue(1);
      return;
    }
    clock.setValue(0);
    const run = Animated.timing(clock, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: onboardingMotion.useNativeDriver });
    run.start();
    // Nothing decorative keeps running in the background: the scene is simply finished on return.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      run.stop();
      clock.setValue(1);
    });
    return () => {
      run.stop();
      appState.remove();
    };
  }, [animate, duration, clock]);
  return clock;
}
