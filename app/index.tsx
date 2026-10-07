import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Screen } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useSessionStore } from '@/store/sessionStore';

export default function Home() {
  const session = useSessionStore((s) => s.session);
  const hydrated = useSessionStore((s) => s.hydrated);

  return (
    <Screen
      testID="home-screen"
      footer={
        <>
          {hydrated && session ? (
            <Button title="RESUME GAME" subtitle="Rejoin your table" testID="resume-game" variant="success" onPress={() => router.push(`/game/${session.gameId}`)} />
          ) : null}
          <Button title="CREATE GAME" subtitle="You're the host" testID="create-game" onPress={() => router.push('/create-game')} />
          <Button title="JOIN GAME" subtitle="Scan QR or enter code" testID="join-game" variant="secondary" onPress={() => router.push('/join-game')} />
          <Button title="House rules & settings" size="sm" variant="ghost" onPress={() => router.push('/settings')} />
        </>
      }
    >
      <View className="flex-1 items-center justify-center gap-3">
        <Text className="text-7xl">🏦</Text>
        <Text className="text-center text-5xl font-black text-cream">Business{'\n'}Banker</Text>
        <Text className="text-center text-lg font-semibold text-cream/80">The bank & referee for your Business board.{'\n'}Keep playing on the real board.</Text>
        {!isSupabaseConfigured ? (
          <Text className="mt-4 rounded-xl bg-amber-300 px-4 py-2 text-center font-bold text-ink" accessibilityRole="alert">
            Server not configured — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
