import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NoticeToast } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { useSessionStore } from '@/store/sessionStore';

export default function RootLayout() {
  const hydrate = useSessionStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.felt }, animation: 'fade_from_bottom' }}>
        <Stack.Screen name="property/[key]" options={{ presentation: 'modal' }} />
      </Stack>
      <NoticeToast />
    </SafeAreaProvider>
  );
}
