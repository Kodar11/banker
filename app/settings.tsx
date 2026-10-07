import { goBack } from '@/utils/navigation';
import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BUSINESS_MVP_RULES, CONFIRMED_RULES, MVP_ASSUMPTIONS, RULES_VERSION } from '@/engine/index.ts';
import { Button, Card, Label, Screen } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

export default function Settings() {
  const session = useSessionStore((s) => s.session);
  const clearSession = useSessionStore((s) => s.clearSession);

  return (
    <Screen scroll testID="settings-screen">
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">House rules</Text>
      <Card testID="confirmed-rules" className="border-2 border-green-600">
        <Text className="text-base font-bold text-ink">✅ Confirmed for your physical board</Text>
        <View className="mt-3 gap-3">
          {CONFIRMED_RULES.map((r) => (
            <View key={r.title}>
              <Text className="text-base font-extrabold text-ink">{r.title}</Text>
              <Text className="text-sm text-stone-600">{r.detail}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Card className="border-2 border-amber-400">
        <Text className="text-base font-bold text-ink">⚠️ Configured assumptions — verify against your physical rulebook.</Text>
        <Text className="mt-1 text-sm text-stone-600">
          Prices, rents, building costs and mortgage values come from your title deeds, and the board order and card tables are confirmed.
          Everything below is a default the app uses until the real rule is confirmed.
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
