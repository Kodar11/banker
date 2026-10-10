import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BUSINESS_MVP_RULES, defaultGameConfig, PROPERTY_KEYS, type GameConfig, type GameMode } from '@/engine/index.ts';
import { Button, Card, Label, Pill, Screen, TextField } from '@/components/ui';
import { GameConfigEditor, GameConfigSummary } from '@/features/lobby/GameConfigEditor';
import { useEnterGame } from '@/features/lobby/useEnterGame';
import { useAccountStore } from '@/store/accountStore';
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
  // Starts from the player's nickname; what they type here is only their name in this game.
  const [name, setName] = useState(() => useAccountStore.getState().profile?.nickname ?? '');
  const [gameMode, setGameMode] = useState<GameMode>('classic');
  const [config, setConfig] = useState<GameConfig>(() => defaultGameConfig('classic'));
  const { submit, busy, error } = useEnterGame();
  const create = () => submit({ kind: 'create', gameMode, config }, name);
  // The money settings are the host's own choices, so they follow them to the other mode; everything else takes that mode's default.
  const chooseMode = (mode: GameMode) => {
    setGameMode(mode);
    setConfig((c) => ({ ...defaultGameConfig(mode), startingCash: c.startingCash, loanLimit: c.loanLimit }));
  };

  return (
    <Screen
      scroll
      testID="create-game-screen"
      footer={<Button title="CREATE GAME" testID="create-confirm" loading={busy} onPress={create} />}
    >
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">New game</Text>
      {/* First on the screen: it has the focus (and the keyboard) when the screen opens, so it must not sit below the settings. */}
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
      <Label className="text-cream/70">Board</Label>
      <Card testID="game-option-business" className="border-2 border-saffron">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-black text-ink">Business</Text>
          <Pill tone="gold">Selected</Pill>
        </View>
        <Text className="mt-1 text-sm text-stone-600">
          Indian edition · {PROPERTY_KEYS.length} properties · start with {formatINR(config.startingCash)} · {BUSINESS_MVP_RULES.players.min}–
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
              onPress={() => chooseMode(m.mode)}
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
      <Label className="text-cream/70">Game settings</Label>
      <Card testID="game-settings">
        <GameConfigEditor mode={gameMode} value={config} onChange={setConfig} />
      </Card>
      <Card testID="game-review">
        <GameConfigSummary mode={gameMode} config={config} title="Review" note="You can still change these settings in the lobby, until you start the game." />
      </Card>
    </Screen>
  );
}
