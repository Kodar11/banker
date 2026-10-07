import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Button, Screen, TextField } from '@/components/ui';
import { parseJoinCode } from '@/constants/app';
import { QrScanner } from '@/features/lobby/QrScanner';
import { useEnterGame } from '@/features/lobby/useEnterGame';

export default function JoinGame() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState(() => parseJoinCode(params.code ?? '') ?? '');
  const [name, setName] = useState('');
  const [scanning, setScanning] = useState(false);
  const { submit, busy, error } = useEnterGame();

  return (
    <Screen
      scroll
      testID="join-game-screen"
      footer={<Button title="JOIN GAME" testID="join-confirm" loading={busy} onPress={() => submit({ kind: 'join', code }, name)} />}
    >
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">Join a game</Text>
      <TextField
        label="6-digit code"
        big
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        maxLength={6}
        placeholder="••••••"
        testID="join-code"
      />
      <Button title="📷  Scan QR code" variant="ghost" size="md" testID="scan-qr" onPress={() => setScanning(true)} />
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Priya"
        maxLength={20}
        returnKeyType="go"
        onSubmitEditing={() => submit({ kind: 'join', code }, name)}
        error={error}
        testID="join-name"
      />
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={(c) => {
          setCode(c);
          setScanning(false);
        }}
      />
    </Screen>
  );
}
