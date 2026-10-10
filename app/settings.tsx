
import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { configOf, intermediateRuleEntries, ruleSections, topRules, type RuleEntry } from '@/engine/index.ts';
import { Button, Card, Screen } from '@/components/ui';
import { LeaveGameDialog } from '@/features/game/LeaveGameDialog';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

/** One rule: its rank, a title, short statements and (for the tricky ones) a worked example. */
function RuleRow({ rank, rule, testID }: { rank: number; rule: RuleEntry; testID: string }) {
  return (
    <View testID={testID} className="flex-row gap-3 border-t border-stone-200 px-5 py-3">
      <Text className="w-5 text-base font-extrabold text-stone-500" accessibilityElementsHidden importantForAccessibility="no">
        {rank}
      </Text>

      <View className="flex-1 gap-1">
        <Text accessibilityLabel={`${rank}. ${rule.title}`} className="text-base font-extrabold text-ink">
          {rule.title}
        </Text>

        {rule.lines.map((line) => (
          <Text key={line} className="text-sm leading-5 text-stone-600">
            {line}
          </Text>
        ))}

        {rule.example ? (
          <View className="mt-1 rounded-xl bg-white px-3 py-2">
            <Text className="text-sm leading-5 text-stone-700">
              <Text className="font-extrabold text-ink">Example: </Text>
              {rule.example}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

interface RuleSectionProps {
  testID: string;
  title: string;
  intro?: string;
  rules: readonly RuleEntry[];
}

/** One group of rules: a clean heading followed by divided, numbered rule rows. */
function RuleSection({ testID, title, intro, rules }: RuleSectionProps) {
  return (
    <Card testID={testID} className="overflow-hidden p-0">
      <View className="gap-1 px-5 pb-4 pt-5">
        <Text accessibilityRole="header" className="text-lg font-extrabold leading-6 text-ink">
          {title}
        </Text>

        {intro ? <Text className="text-sm leading-5 text-stone-600">{intro}</Text> : null}
      </View>

      {rules.map((rule, i) => (
        <RuleRow key={rule.title} rank={i + 1} rule={rule} testID={`${testID}-${i + 1}`} />
      ))}
    </Card>
  );
}

export default function Settings() {
  const session = useSessionStore((state) => state.session);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Only a game played in Intermediate Mode shows its extra rules; Classic games read exactly as before.
  const intermediate = useGameStore((state) => state.snapshot?.state.mode === 'intermediate');
  // In a game the rules quote that game's own settings (starting cash, loan limit, market); outside one, the standard values.
  const game = useGameStore((state) => state.snapshot?.state);
  const config = game ? configOf(game) : undefined;

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
        testID="top-rules"
        title="The 5 rules to know"
        intro="Read these and you can play. Everything after them is detail for when a question comes up."
        rules={topRules(config)}
      />

      {ruleSections(config).map((section) => (
        <RuleSection key={section.id} testID={`rules-${section.id}`} title={section.title} rules={section.rules} />
      ))}

      {intermediate ? (
        <RuleSection
          testID="rules-intermediate"
          title="Intermediate Mode"
          intro="This game adds a financial layer. Every Classic rule above still applies."
          rules={intermediateRuleEntries(config)}
        />
      ) : null}

      {session ? (
        <Button
          variant="danger"
          size="md"
          title="Leave game"
          testID="leave-game"
          onPress={() => setConfirmLeave(true)}
        />
      ) : null}
      <LeaveGameDialog visible={confirmLeave && !!session} onClose={() => setConfirmLeave(false)} />
    </Screen>
  );
}
