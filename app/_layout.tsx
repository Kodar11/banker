import '../global.css';
import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NoticeToast } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { AccountHost } from '@/features/account/AccountHost';
import { EndVoteHost } from '@/features/game/EndVote';
import { GameSyncHost } from '@/features/game/sync';
import { MatchmakingHost } from '@/features/matchmaking/MatchmakingHost';
import { SocialHost } from '@/features/social/SocialHost';
import { VoiceHost } from '@/features/voice/voice';
import { useLearningStore } from '@/store/learningStore';
import { useOnboardingStore } from '@/store/onboardingStore';
import { useSessionStore } from '@/store/sessionStore';
import { startupRouting } from '@/utils/startupRouting';

/**
 * Home is the root of the stack. Without this, Expo Router orders explicitly
 * declared <Stack.Screen>s first — the old layout declared only property/[key],
 * so whenever the navigator had no URL-derived state (cold start, reload) its
 * first route was property/[key] with no key → "Unknown property".
 */
/** A screen that throws while rendering shows a recoverable error screen; the game session is kept. */
export { CrashScreen as ErrorBoundary } from '@/components/ui/CrashScreen';

/**
 * The launch screen stays up until storage has said where this launch goes (introduction, Home or a
 * game), so the first thing seen after it is a real screen, not the empty table. It then fades out.
 */
const SPLASH_MAX_MS = 4000;
SplashScreen.setOptions({ duration: 300, fade: true });
SplashScreen.preventAutoHideAsync().catch(() => undefined);
// Whatever happens to storage or the first render, the launch screen never stays up for good.
setTimeout(() => SplashScreen.hide(), SPLASH_MAX_MS);

export const unstable_settings = {
  anchor: 'index',
};

export default function RootLayout() {
  // Every mount of the root is a launch of the screens, also when Android rebuilt the activity under a
  // running app: Home then takes the player back to their game again. Before the first child renders.
  useState(() => startupRouting.reset());
  const hydrate = useSessionStore((s) => s.hydrate);
  const hydrateLearning = useLearningStore((s) => s.hydrate);
  const hydrateOnboarding = useOnboardingStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    void hydrateLearning();
    void hydrateOnboarding();
  }, [hydrate, hydrateLearning, hydrateOnboarding]);

  const sessionHydrated = useSessionStore((s) => s.hydrated);
  const onboardingKnown = useOnboardingStore((s) => s.status !== 'unknown');
  const launchReady = sessionHydrated && onboardingKnown;
  useEffect(() => {
    if (launchReady) SplashScreen.hide();
  }, [launchReady]);

  return (
    <SafeAreaProvider>
      <AccountHost />
      <GameSyncHost />
      <VoiceHost />
      <SocialHost />
      <MatchmakingHost />
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.felt }, animation: 'fade_from_bottom' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="property/[key]" options={{ presentation: 'modal' }} />
      </Stack>
      {/* Above every screen: a vote on ending the game reaches a player wherever they are in the app. */}
      <EndVoteHost />
      <NoticeToast />
    </SafeAreaProvider>
  );
}
