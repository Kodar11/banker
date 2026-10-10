import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NoticeToast } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { AccountHost } from '@/features/account/AccountHost';
import { GameSyncHost } from '@/features/game/sync';
import { useLearningStore } from '@/store/learningStore';
import { useSessionStore } from '@/store/sessionStore';

/**
 * Home is the root of the stack. Without this, Expo Router orders explicitly
 * declared <Stack.Screen>s first — the old layout declared only property/[key],
 * so whenever the navigator had no URL-derived state (cold start, reload) its
 * first route was property/[key] with no key → "Unknown property".
 */
/** A screen that throws while rendering shows a recoverable error screen; the game session is kept. */
export { CrashScreen as ErrorBoundary } from '@/components/ui/CrashScreen';

export const unstable_settings = {
  anchor: 'index',
};

export default function RootLayout() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const hydrateLearning = useLearningStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    void hydrateLearning();
  }, [hydrate, hydrateLearning]);

  return (
    <SafeAreaProvider>
      <AccountHost />
      <GameSyncHost />
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.felt }, animation: 'fade_from_bottom' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="property/[key]" options={{ presentation: 'modal' }} />
      </Stack>
      <NoticeToast />
    </SafeAreaProvider>
  );
}
