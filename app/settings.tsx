import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BUSINESS_MVP_RULES, MVP_ASSUMPTIONS, RULES_VERSION } from '@/engine/index.ts';
import { Button, Card, Label, Screen } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

export default function Settings() {
  const session = useSessionStore((s) => s.session);
  const clearSession = useSessionStore((s) => s.clearSession);

  return (
    <Screen scroll testID="settings-screen">
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => router.back()} />
      <Text className="text-4xl font-black text-cream">House rules</Text>
      <Card className="border-2 border-amber-400">
        <Text className="text-base font-bold text-ink">⚠️ These are configured MVP assumptions — verify against your physical rulebook.</Text>
        <Text className="mt-1 text-sm text-stone-600">
          Property prices, rents, building costs, mortgage values and the known Chance / Community Chest entries come from your
          photographed cards. Everything below is a default the app uses until the real rules are confirmed.
        </Text>
      </Card>
      <Card testID="assumptions-list">
        <View className="gap-3">
          {MVP_ASSUMPTIONS.map((a) => (
            <View key={a.title}>
              <Text className="text-base font-extrabold text-ink">{a.title}</Text>
              <Text className="text-sm text-stone-600">{a.detail}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Card>
        <Label>Version</Label>
        <Text className="text-base text-ink">
          {RULES_VERSION} · assumptions {BUSINESS_MVP_RULES.assumptionsVersion}
        </Text>
      </Card>
      {session ? (
        <Button
          variant="danger"
          size="md"
          title="Leave this game on this phone"
          testID="leave-game"
          onPress={() =>
            Alert.alert('Leave game?', "This phone will forget the game. You can't rejoin as the same player.", [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Leave',
                style: 'destructive',
                onPress: async () => {
                  await clearSession();
                  useGameStore.getState().reset(null);
                  router.replace('/');
                },
              },
            ])
          }
        />
      ) : null}
    </Screen>
  );
}
