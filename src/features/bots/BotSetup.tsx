import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_LABELS,
  BOT_PERSONALITIES,
  BOT_PERSONALITY_LABELS,
  botSeatLabel,
  type BotDifficulty,
  type BotPersonality,
  type BotSeat,
} from '@/engine/index.ts';
import { Button, Label, Pill, Sheet } from '@/components/ui';
import { Choice } from '@/features/lobby/GameConfigEditor';

/** "Bot · Normal · Investor" next to a bot seat's name, so a bot is never taken for a person. */
export function BotPill({ bot, testID }: { bot: BotSeat; testID?: string }) {
  return (
    <View testID={testID} accessibilityLabel={botSeatLabel(bot)} className="self-center">
      <Pill tone="neutral" className="self-center">
        🤖 {BOT_DIFFICULTY_LABELS[bot.difficulty].label} · {BOT_PERSONALITY_LABELS[bot.personality].label}
      </Pill>
    </View>
  );
}

export type PersonalityChoice = BotPersonality | 'mixed';

/** Difficulty and personality pickers. `allowMixed`: a "Mixed" personality that gives each bot a different one. */
export function BotChoices({
  difficulty,
  personality,
  onDifficulty,
  onPersonality,
  allowMixed = false,
  testID = 'bot-choices',
}: {
  difficulty: BotDifficulty;
  personality: PersonalityChoice;
  onDifficulty: (d: BotDifficulty) => void;
  onPersonality: (p: PersonalityChoice) => void;
  allowMixed?: boolean;
  testID?: string;
}) {
  const personalities: PersonalityChoice[] = allowMixed ? ['mixed', ...BOT_PERSONALITIES] : [...BOT_PERSONALITIES];
  const hint = personality === 'mixed' ? 'Each bot gets a different personality.' : `${BOT_PERSONALITY_LABELS[personality].motto}: ${BOT_PERSONALITY_LABELS[personality].hint}`;
  return (
    <View className="gap-2" testID={testID}>
      <Label>Difficulty</Label>
      <Choice value={difficulty} options={BOT_DIFFICULTIES.map((d) => ({ value: d, label: BOT_DIFFICULTY_LABELS[d].label }))} onChange={onDifficulty} testID={`${testID}-difficulty`} />
      <Text className="text-xs text-stone-500">{BOT_DIFFICULTY_LABELS[difficulty].hint}</Text>
      <Label className="mt-2">Personality</Label>
      <View className="gap-2">
        <Choice
          value={personality}
          options={personalities.slice(0, 3).map((p) => ({ value: p, label: p === 'mixed' ? 'Mixed' : BOT_PERSONALITY_LABELS[p].label }))}
          onChange={onPersonality}
          testID={`${testID}-personality`}
        />
        <Choice
          value={personality}
          options={personalities.slice(3).map((p) => ({ value: p, label: p === 'mixed' ? 'Mixed' : BOT_PERSONALITY_LABELS[p].label }))}
          onChange={onPersonality}
          testID={`${testID}-personality-more`}
        />
      </View>
      <Text className="text-xs text-stone-500">{hint}</Text>
    </View>
  );
}

/** The host's "Add a bot" sheet in a private lobby. The server checks the host, the lobby and the table size. */
export function AddBotSheet({
  visible,
  onClose,
  onAdd,
  busy,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (bot: BotSeat) => void;
  busy: boolean;
  error: string | null;
}) {
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal');
  const [personality, setPersonality] = useState<PersonalityChoice>('investor');
  return (
    <Sheet
      visible={visible}
      title="Add a bot"
      onClose={onClose}
      testID="add-bot-sheet"
      footer={<Button title="ADD BOT" size="md" testID="add-bot-confirm" loading={busy} disabled={busy} onPress={() => onAdd({ difficulty, personality: personality === 'mixed' ? 'investor' : personality })} />}
    >
      <BotChoices difficulty={difficulty} personality={personality} onDifficulty={setDifficulty} onPersonality={setPersonality} testID="add-bot" />
      <Text className="text-xs text-stone-500">A bot plays by exactly the same rules as everyone else, sees only what any player sees, and is played by the game server.</Text>
      {error ? (
        <Text className="text-sm font-bold text-brick" accessibilityRole="alert" testID="add-bot-error">
          {error}
        </Text>
      ) : null}
    </Sheet>
  );
}
