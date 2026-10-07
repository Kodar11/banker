import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { useGameStore } from '@/store/gameStore';

/** Toast for action results. Auto-dismisses; tap to dismiss. */
export function NoticeToast() {
  const notice = useGameStore((s) => s.notice);
  const dismiss = useGameStore((s) => s.dismissNotice);
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!notice) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 7 }).start();
    const t = setTimeout(dismiss, notice.kind === 'error' ? 4000 : 2500);
    return () => clearTimeout(t);
  }, [notice, anim, dismiss]);

  if (!notice) return null;
  const tone = notice.kind === 'error' ? 'bg-brick' : notice.kind === 'success' ? 'bg-green-600' : 'bg-ink';
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        top: 56,
        zIndex: 50,
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }],
      }}
    >
      <Pressable onPress={dismiss} accessibilityRole="alert" testID="notice-toast" className={`rounded-2xl px-5 py-4 shadow-lg ${tone}`}>
        <Text className="text-center text-base font-bold text-white">{notice.message}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Thin banner when realtime is not live. Gameplay still works via request/response. */
export function ConnectionBanner() {
  const connection = useGameStore((s) => s.connection);
  if (connection === 'live') return null;
  const text =
    connection === 'offline' ? 'Connection lost. Reconnecting…' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <View testID="connection-banner" accessibilityRole="alert" className="flex-row items-center justify-center gap-2 rounded-xl bg-amber-400/90 px-3 py-2">
      <ActivityIndicator size="small" color="#1F1B16" />
      <Text className="text-sm font-bold text-ink">{text}</Text>
    </View>
  );
}

export function LoadingState({ message = 'Loading game…' }: { message?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-felt" testID="loading-state">
      <ActivityIndicator size="large" color="#F59E0B" />
      <Text className="text-lg font-semibold text-cream">{message}</Text>
    </View>
  );
}

export function ErrorState({ title, message, action }: { title: string; message: string; action?: React.ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-felt px-8" testID="error-state">
      <Text className="text-5xl">😕</Text>
      <Text className="text-center text-2xl font-extrabold text-cream">{title}</Text>
      <Text className="text-center text-base text-cream/80">{message}</Text>
      {action}
    </View>
  );
}
