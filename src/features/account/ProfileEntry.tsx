import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { COLORS, playerInitial } from '@/constants/theme';
import { useAccountStatus, useAccountStore } from '@/store/accountStore';

/** Compact "who am I" row at the top of Home. Opens Settings. */
export function ProfileEntry() {
  const phase = useAccountStore((s) => s.phase);
  const profile = useAccountStore((s) => s.profile);
  const status = useAccountStatus();

  const waiting = !profile && (phase === 'idle' || phase === 'loading');
  const title = profile ? profile.nickname : waiting ? 'Setting up your profile…' : phase === 'signedOut' ? 'Not signed in' : 'Profile unavailable';
  // The link status is shown only when the server has confirmed it in this app run.
  const detail = profile
    ? `${profile.playerId} · ${phase === 'signedOut' ? 'Signed out' : status === 'google' ? 'Google linked' : status === 'guest' ? 'Guest' : phase === 'loading' ? 'Checking…' : 'Offline'}`
    : waiting
      ? 'You can start playing right away'
      : 'Tap for details';

  return (
    <Pressable
      testID="profile-entry"
      onPress={() => router.push('/account')}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}. Open settings`}
      className="flex-row items-center gap-3 rounded-2xl border border-white/20 bg-white/10 px-3 py-2 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-saffron">
        {waiting ? <ActivityIndicator size="small" color={COLORS.ink} /> : <Text className="text-lg font-black text-ink">{profile ? playerInitial(profile.nickname) : '?'}</Text>}
      </View>
      <View className="flex-1">
        <Text testID="profile-entry-name" numberOfLines={1} className="text-base font-extrabold text-cream">
          {title}
        </Text>
        <Text testID="profile-entry-detail" numberOfLines={1} className="text-xs font-semibold text-cream/70">
          {detail}
        </Text>
      </View>
      <Text className="text-sm font-bold text-cream/70" accessibilityElementsHidden importantForAccessibility="no">
        Settings ›
      </Text>
    </Pressable>
  );
}
