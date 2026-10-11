import { useEffect } from 'react';
import { Image, Text, useWindowDimensions, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Button, Screen } from '@/components/ui';
import { APP_NAME } from '@/constants/app';
import { ProfileEntry } from '@/features/account/ProfileEntry';
import { detachFromGame } from '@/features/game/leaveGame';
import { PlayOnlineEntry } from '@/features/matchmaking/PlayOnlineView';
import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow';
import { FriendsEntry } from '@/features/social/FriendsEntry';
import { activeGameRoute } from '@/utils/navigation';
import { startupRouting } from '@/utils/startupRouting';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useGameStore } from '@/store/gameStore';
import { onboardingDecision, useOnboardingStore } from '@/store/onboardingStore';
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
  const onboarding = onboardingDecision({ status: useOnboardingStore((s) => s.status), sessionHydrated: hydrated, hasSession: !!session, pathname });
  const completeOnboarding = useOnboardingStore((s) => s.complete);
  const deferOnboarding = useOnboardingStore((s) => s.defer);
  // Sized to the screen, within limits: never tiny on a small phone, never a poster on a tablet.
  const { width, height } = useWindowDimensions();
  const logoSize = Math.round(Math.min(260, Math.max(128, Math.min(width * 0.6, height * 0.28))));

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

  // A first launch that opened an invite link, or has a game to go back to, goes there: the
  // introduction waits for a later launch instead of standing in the way.
  useEffect(() => {
    if (onboarding === 'defer') deferOnboarding();
  }, [onboarding, deferOnboarding]);

  // Until it is known whether this is a first launch, show the table and nothing on it — never Home for an instant.
  if (onboarding === 'wait') return <View className="flex-1 bg-felt" testID="home-loading" />;
  // First launch: the introduction is shown in Home's place, so finishing or skipping it needs no navigation.
  if (onboarding === 'show') return <OnboardingFlow onFinish={completeOnboarding} />;

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
          <PlayOnlineEntry />
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
        {/* The app icon's transparent variant, so the table shows through it. It carries the app's name, so it is the screen's heading; it gives way first on a short screen. */}
        <Image
          source={require('../assets/splash-icon.png')}
          style={{ width: logoSize, height: logoSize, flexShrink: 1 }}
          resizeMode="contain"
          testID="home-logo"
          accessible
          accessibilityRole="header"
          accessibilityLabel={APP_NAME}
        />
        <Text className="text-center text-lg font-semibold text-cream/80">Roll, buy, build and outbid your rivals.</Text>
        {!isSupabaseConfigured ? (
          <Text className="mt-4 rounded-xl bg-amber-300 px-4 py-2 text-center font-bold text-ink" accessibilityRole="alert">
            Server not configured — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
