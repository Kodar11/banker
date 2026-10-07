import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { BUSINESS_MVP_RULES, PROPERTY_KEYS } from '@/engine/index.ts';
import { Button, Card, Label, Pill, Screen, TextField } from '@/components/ui';
import { useEnterGame } from '@/features/lobby/useEnterGame';
import { formatINR } from '@/utils/currency';

export default function CreateGame() {
  const [name, setName] = useState('');
  const { submit, busy, error } = useEnterGame();

  return (
    <Screen
      scroll
      testID="create-game-screen"
      footer={<Button title="CREATE GAME" testID="create-confirm" loading={busy} onPress={() => submit({ kind: 'create' }, name)} />}
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
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Tanmay"
        autoFocus
        maxLength={20}
        returnKeyType="go"
        onSubmitEditing={() => submit({ kind: 'create' }, name)}
        error={error}
        testID="host-name"
      />
    </Screen>
  );
}
