import { useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  BUSINESS_MVP_RULES,
  configAmountLimits,
  defaultGameConfig,
  GAME_MODE_NAMES,
  isGameError,
  PlayerNameSchema,
  type BotDifficulty,
  type GameConfig,
  type GameMode,
} from '@/engine/index.ts';
import { Button, Card, Label, Screen, TextField } from '@/components/ui';
import { BotChoices, type PersonalityChoice } from '@/features/bots/BotSetup';
import { detachFromGame } from '@/features/game/leaveGame';
import { GameConfigEditor } from '@/features/lobby/GameConfigEditor';
import { createSoloGame, localState, soloBots } from '@/features/solo/localGame';
import { useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { goBack } from '@/utils/navigation';
import { haptics } from '@/utils/haptics';

const MAX_BOTS = BUSINESS_MVP_RULES.players.max - 1;

/**
 * Practice against bots on this phone. The game is created, played and kept on the device only: it uses the
 * same rules and the same bots as online games, but nothing is sent to a server, it counts for nothing,
 * and it is gone once you leave it (or the app is closed).
 */
export default function SoloGame() {
  const [name, setName] = useState(() => useAccountStore.getState().profile?.nickname ?? '');
  const [mode, setMode] = useState<GameMode>('classic');
  const [config, setConfig] = useState<GameConfig>(() => defaultGameConfig('classic'));
  const [bots, setBots] = useState(3);
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal');
  const [personality, setPersonality] = useState<PersonalityChoice>('mixed');
  const [error, setError] = useState<string | null>(null);

  const chooseMode = (next: GameMode) => {
    setMode(next);
    setConfig((c) => ({
      ...defaultGameConfig(next),
      startingCash: c.startingCash,
      loanLimit: Math.max(c.loanLimit, configAmountLimits(next, 'loanLimit').min),
      financialPrivacy: c.financialPrivacy,
      durationYears: c.durationYears,
    }));
  };

  const start = async () => {
    const parsed = PlayerNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    try {
      // One game per phone: whatever this phone was attached to is let go of first.
      detachFromGame();
      const credentials = createSoloGame({ name: parsed.data, mode, config, bots: soloBots(bots, difficulty, personality) });
      await useSessionStore.getState().setSession(credentials);
      const store = useGameStore.getState();
      store.reset(credentials.gameId);
      const first = localState(credentials);
      if (first.ok) store.applySnapshot(first.snapshot);
      haptics.success();
      if (router.canDismiss()) router.dismissAll();
      router.replace(`/game/${credentials.gameId}`);
    } catch (e) {
      haptics.error();
      setError(isGameError(e) ? e.message : 'Could not start the game.');
    }
  };

  return (
    <Screen scroll testID="solo-screen" footer={<Button title="START SOLO GAME" subtitle={`You + ${bots} ${bots === 1 ? 'bot' : 'bots'}`} testID="solo-start" onPress={() => void start()} />}>
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">Play vs bots</Text>
      <Text className="text-sm text-cream/70">Practice on this phone. Same rules as online games; nothing is ranked or saved.</Text>
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Tanmay"
        maxLength={20}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={Keyboard.dismiss}
        error={error}
        testID="solo-name"
      />
      <Label className="text-cream/70">Game mode</Label>
      <View className="flex-row gap-2" accessibilityRole="radiogroup" testID="solo-mode">
        {(['classic', 'intermediate'] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => chooseMode(m)}
            accessibilityRole="radio"
            accessibilityState={{ selected: m === mode }}
            testID={`solo-mode-${m}`}
            className={`min-h-[52px] flex-1 items-center justify-center rounded-2xl border-2 bg-cream px-2 active:opacity-70 ${m === mode ? 'border-saffron' : 'border-transparent opacity-80'}`}
          >
            <Text className="text-base font-black text-ink">{GAME_MODE_NAMES[m]}</Text>
          </Pressable>
        ))}
      </View>
      <Card testID="solo-bots">
        <Label>Bots</Label>
        <View className="mt-2 flex-row items-center justify-between">
          <Button size="sm" variant="secondary" title="−" testID="solo-bots-minus" disabled={bots <= 1} onPress={() => setBots((b) => Math.max(1, b - 1))} />
          <Text className="text-2xl font-black text-ink" testID="solo-bots-count" accessibilityLabel={`${bots} bots`}>
            {bots} {bots === 1 ? 'bot' : 'bots'}
          </Text>
          <Button size="sm" variant="secondary" title="+" testID="solo-bots-plus" disabled={bots >= MAX_BOTS} onPress={() => setBots((b) => Math.min(MAX_BOTS, b + 1))} />
        </View>
        <View className="mt-4">
          <BotChoices difficulty={difficulty} personality={personality} onDifficulty={setDifficulty} onPersonality={setPersonality} allowMixed testID="solo-bot" />
        </View>
      </Card>
      <Label className="text-cream/70">Game settings</Label>
      <Card testID="solo-settings">
        <GameConfigEditor mode={mode} value={config} onChange={setConfig} privacyEditable />
      </Card>
    </Screen>
  );
}
