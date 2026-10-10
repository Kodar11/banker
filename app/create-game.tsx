import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BUSINESS_MVP_RULES, PROPERTY_KEYS, type GameMode } from '@/engine/index.ts';
import { Button, Card, Label, Pill, Screen, TextField } from '@/components/ui';
import { useEnterGame } from '@/features/lobby/useEnterGame';
import { formatINR } from '@/utils/currency';

const MODES: { mode: GameMode; title: string; points: string[] }[] = [
  { mode: 'classic', title: 'Classic Mode', points: ['Original rules', 'Original gameplay', 'No additional financial features'] },
  {
    mode: 'intermediate',
    title: 'Intermediate Mode',
    points: ['Same board and core gameplay', 'Financial years and changing property values', 'Inflation, loans and credit scores', 'Automatic repayment schedules and financial notifications'],
  },
];

export default function CreateGame() {
  const [name, setName] = useState('');
  const [gameMode, setGameMode] = useState<GameMode>('classic');
  const { submit, busy, error } = useEnterGame();
  const create = () => submit({ kind: 'create', gameMode }, name);

  return (
    <Screen
      scroll
      testID="create-game-screen"
      footer={<Button title="CREATE GAME" testID="create-confirm" loading={busy} onPress={create} />}
    >
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">New game</Text>
      <Label className="text-cream/70">Board</Label>
      <Card testID="game-option-business" className="border-2 border-saffron">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-black text-ink">Business</Text>
          <Pill tone="gold">Selected</Pill>
        </View>
        <Text className="mt-1 text-sm text-stone-600">
          Indian edition · {PROPERTY_KEYS.length} properties · start with {formatINR(BUSINESS_MVP_RULES.startingCash)} · {BUSINESS_MVP_RULES.players.min}–
          {BUSINESS_MVP_RULES.players.max} players
        </Text>
      </Card>
      <Label className="text-cream/70">Game mode</Label>
      <View className="gap-2" accessibilityRole="radiogroup" testID="game-mode-options">
        {MODES.map((m) => {
          const selected = m.mode === gameMode;
          return (
            <Pressable
              key={m.mode}
              onPress={() => setGameMode(m.mode)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${m.title}. ${m.points.join('. ')}`}
              testID={`game-mode-${m.mode}`}
              className={`rounded-3xl border-2 bg-cream p-4 ${selected ? 'border-saffron' : 'border-transparent opacity-80'}`}
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-xl font-black text-ink">{m.title}</Text>
                {selected ? <Pill tone="gold">Selected</Pill> : null}
              </View>
              {m.points.map((point) => (
                <Text key={point} className="mt-0.5 text-sm text-stone-600">
                  · {point}
                </Text>
              ))}
            </Pressable>
          );
        })}
      </View>
      <Text className="text-xs text-cream/60">Everyone who joins plays the mode you pick. It can’t be changed after the game is created.</Text>
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Tanmay"
        autoFocus
        maxLength={20}
        returnKeyType="go"
        onSubmitEditing={create}
        error={error}
        testID="host-name"
      />
    </Screen>
  );
}
