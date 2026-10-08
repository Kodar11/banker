import { Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { Button } from './Button';

/**
 * Shown by Expo Router when a screen throws while rendering. The game lives on
 * the server and the session stays on this phone, so nothing is lost: the
 * player sees what went wrong and can carry on, instead of being dropped out.
 */
export function CrashScreen({ error, retry }: ErrorBoundaryProps) {
  // Keep the real cause visible to developers; never swallow it.
  console.error('[screen crashed]', error);
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-felt px-8" testID="crash-screen" accessibilityRole="alert">
      <Text className="text-5xl">🛠️</Text>
      <Text className="text-center text-2xl font-extrabold text-cream">This screen hit a problem</Text>
      <Text className="text-center text-base text-cream/80">Your game is safe on the server. Tap below to reload this screen.</Text>
      <Text className="text-center text-xs text-cream/60" selectable numberOfLines={4} testID="crash-message">
        {error.message}
      </Text>
      <Button title="Try again" testID="crash-retry" onPress={() => void retry()} />
    </View>
  );
}
