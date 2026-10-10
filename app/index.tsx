import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Button, Screen } from '@/components/ui';
import { ProfileEntry } from '@/features/account/ProfileEntry';
import { detachFromGame } from '@/features/game/leaveGame';
import { FriendsEntry } from '@/features/social/FriendsEntry';
import { activeGameRoute } from '@/utils/navigation';
import { startupRouting } from '@/utils/startupRouting';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

export default function Home() {
  const session = useSessionStore((s) => s.session);
  const hydrated = useSessionStore((s) => s.hydrated);
  const status = useGameStore((s) => (s.snapshot && s.snapshot.state.id === session?.gameId ? s.snapshot.state.status : null));
  const left = useGameStore((s) => !!session && s.snapshot?.state.id === session.gameId && s.snapshot.state.players.find((p) => p.id === session.playerId)?.status === 'LEFT');
  const loadError = useGameStore((s) => s.loadError);
  const gone = !!loadError && ['FORBIDDEN', 'NOT_FOUND', 'GAME_EXPIRED'].includes(loadError.code);
  const target = session && status ? activeGameRoute(session.gameId, status) : null;
  const pathname = usePathname();

  // Startup restoration: an active lobby/game opens directly; a game that is gone is forgotten.
  useEffect(() => {
    if (!hydrated || startupRouting.isDone()) return;
    // Opened via a deep link (e.g. a join QR code) on top of Home: respect it, don't redirect.
    if (pathname !== '/') {
      startupRouting.markDone();
      return;
    }
    if (!session) {
      startupRouting.markDone();
      return;
    }
    if (gone) {
      startupRouting.markDone();
      detachFromGame();
      return;
    }
    if (!status) return; // wait for the server snapshot (fetched by GameSyncHost)
    startupRouting.markDone();
    if (target) router.replace(target);
  }, [hydrated, session, status, gone, target, pathname]);

  // A finished game has nothing to go back to. Once the player is on Home, let go of it (session,
  // snapshot, realtime) so the next Create / Join starts from nothing. Only while Home is the screen
  // in front: it also sits underneath the game screen, where the final standings are still shown.
  useEffect(() => {
    if (pathname === '/' && session && (status === 'FINISHED' || left)) detachFromGame();
  }, [pathname, session, status, left]);

  return (
    <Screen
      testID="home-screen"
      footer={
        <>
          {target ? (
            <Button
              title={status === 'WAITING' ? 'BACK TO LOBBY' : 'RESUME GAME'}
              subtitle="Rejoin your table"
              testID="resume-game"
              variant="success"
              onPress={() => router.push(target)}
            />
          ) : null}
          <Button title="CREATE GAME" subtitle="You're the host" testID="create-game" onPress={() => router.push('/create-game')} />
          <Button title="JOIN GAME" subtitle="Scan QR or enter code" testID="join-game" variant="secondary" onPress={() => router.push('/join-game')} />
          <View className="flex-row gap-3">
            <FriendsEntry className="flex-1" />
            <Button className="flex-1" title="Financial Learning" size="sm" variant="ghost" testID="open-learning" onPress={() => router.push('/learning')} />
          </View>
          <Button title="How to play · House rules" size="sm" variant="ghost" testID="open-rules" onPress={() => router.push('/settings')} />
        </>
      }
    >
      <ProfileEntry />
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
