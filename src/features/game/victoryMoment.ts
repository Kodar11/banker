import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform } from 'react-native';
import { ease, track } from '@/features/onboarding/timeline';

/**
 * The victory moment, in one place. Motion only decorates: the result is drawn complete from the
 * first frame, and every animated value starts and ends at rest, so nothing is ever hidden or late.
 * Tests set `enabled` to false to see the finished card at once.
 */
export const victoryMotion = {
  enabled: true,
  useNativeDriver: Platform.OS !== 'web',
  /** Games whose victory this app has already celebrated: once each, however often the table is mounted. */
  played: new Set<string>(),
};

export const VICTORY_MS = 1400;

/** Where each sparkle flies to from the trophy's centre, and its colour. */
export const SPARKLES = [
  { x: -30, y: -24, color: '#F59E0B' },
  { x: 26, y: -30, color: '#1B7A4D' },
  { x: 38, y: -4, color: '#F59E0B' },
  { x: -38, y: 2, color: '#C2410C' },
  { x: -18, y: 30, color: '#1B7A4D' },
  { x: 22, y: 28, color: '#F59E0B' },
] as const;

/** Each part's life over the moment's 0→1 clock. All of them rest (1, or 0 for the fading ones) at both ends. */
export const VICTORY_TRACKS = {
  /** The trophy swells, then settles with a small overshoot. */
  trophy: track(VICTORY_MS, 1, [
    [0, 220, 1.32, ease.out],
    [220, 760, 1, ease.pop],
  ]),
  /** A warm wash over the card. */
  glow: track(VICTORY_MS, 0, [
    [0, 260, 1, ease.out],
    [520, 1300, 0, ease.inOut],
  ]),
  /** The winner's net worth takes a small bow after the trophy. */
  figure: track(VICTORY_MS, 1, [
    [240, 460, 1.07, ease.out],
    [460, 820, 1, ease.inOut],
  ]),
  sparkleTravel: track(VICTORY_MS, 0, [[120, 900, 1, ease.out]]),
  sparkleOpacity: track(VICTORY_MS, 0, [
    [120, 260, 1, ease.out],
    [560, 1000, 0, ease.in],
  ]),
} as const;

/**
 * The clock of one game's victory moment: 1 (at rest) except while the moment plays, when it runs
 * once from 0 to 1. It plays the first time this app shows `gameId` finished with a winner, and
 * never again for that game — not on a re-render, a remount, a reconnect or coming back from a sheet.
 * With reduced motion it does not play at all. Leaving the screen or the app ends it at rest.
 */
export function useVictoryClock(gameId: string | null): Animated.Value {
  const [clock] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!gameId || victoryMotion.played.has(gameId)) return;
    let run: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    const rest = () => {
      run?.stop();
      run = null;
      clock.setValue(1);
    };
    const start = (reduce: boolean) => {
      if (cancelled || victoryMotion.played.has(gameId)) return;
      victoryMotion.played.add(gameId);
      if (reduce || !victoryMotion.enabled || AppState.currentState === 'background') return;
      clock.setValue(0);
      run = Animated.timing(clock, { toValue: 1, duration: VICTORY_MS, easing: Easing.linear, useNativeDriver: victoryMotion.useNativeDriver });
      run.start();
    };
    // Asked before the first frame of motion, so a phone that wants none never sees any.
    (AccessibilityInfo.isReduceMotionEnabled?.() ?? Promise.resolve(false)).then(start).catch(() => start(false));
    // Nothing decorative keeps running in the background: the card is simply at rest on return.
    const appState = AppState.addEventListener('change', (next) => {
      if (next !== 'active') rest();
    });
    return () => {
      cancelled = true;
      rest();
      appState.remove();
    };
  }, [gameId, clock]);
  return clock;
}
