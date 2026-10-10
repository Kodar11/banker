
import { goBack } from '@/utils/navigation';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  BUSINESS_MVP_RULES,
  CONFIRMED_RULES,
  MVP_ASSUMPTIONS,
  RULES_VERSION,
} from '@/engine/index.ts';
import { Button, Card, ConfirmDialog, Label, Pill, Screen } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

interface RuleSectionProps {
  testID: string;
  badge: ReactNode;
  title: string;
  intro?: string;
  rules: readonly { title: string; detail: string }[];
}

/** One group of rules: a clean heading followed by divided rule rows. */
function RuleSection({
  testID,
  badge,
  title,
  intro,
  rules,
}: RuleSectionProps) {
  return (
    <Card testID={testID} className="overflow-hidden p-0">
      <View className="gap-3 px-5 pb-4 pt-5">
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text
            accessibilityRole="header"
            className="flex-1 text-lg font-extrabold leading-6 text-ink"
          >
            {title}
          </Text>

          {badge}
        </View>

        {intro ? (
          <Text className="text-sm leading-5 text-stone-600">
            {intro}
          </Text>
        ) : null}
      </View>

      {rules.map((rule) => (
        <View
          key={rule.title}
          className="gap-0.5 border-t border-stone-200 px-5 py-3"
        >
          <Text className="text-base font-extrabold text-ink">
            {rule.title}
          </Text>

          <Text className="text-sm leading-5 text-stone-600">
            {rule.detail}
          </Text>
        </View>
      ))}
    </Card>
  );
}

export default function Settings() {
  const session = useSessionStore((state) => state.session);
  const clearSession = useSessionStore((state) => state.clearSession);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  return (
    <Screen scroll testID="settings-screen">
      <Button
        size="sm"
        variant="ghost"
        title="‹ Back"
        className="self-start"
        onPress={() => goBack('/')}
      />

      <Text className="text-4xl font-black text-cream">
        House rules
      </Text>

      <RuleSection
        testID="confirmed-rules"
        badge={<Pill tone="good">Confirmed</Pill>}
        title="Confirmed for your physical board"
        rules={CONFIRMED_RULES}
      />

      <RuleSection
        testID="assumptions-list"
        badge={<Pill tone="warn">Verify</Pill>}
        title="Configured assumptions"
        intro="Verify these against your physical rulebook. Prices, rents, building costs, mortgage values, board order and card tables are confirmed. The rules below are defaults the app uses until the actual rule is confirmed."
        rules={MVP_ASSUMPTIONS}
      />


      {session ? (
        <Button
          variant="danger"
          size="md"
          title="Leave this game on this phone"
          testID="leave-game"
          onPress={() => setConfirmLeave(true)}
        />
      ) : null}
      <ConfirmDialog
        visible={confirmLeave && !!session}
        title="Leave game?"
        message="This phone will forget the game."
        detail="You can’t rejoin as the same player."
        confirmTitle="Leave game"
        destructive
        loading={leaving}
        testID="leave-dialog"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={async () => {
          if (leaving) return;
          setLeaving(true);
          await clearSession();
          useGameStore.getState().reset(null);
          router.replace('/');
        }}
      />
    </Screen>
  );
}
