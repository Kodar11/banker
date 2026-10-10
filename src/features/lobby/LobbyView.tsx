import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { BUSINESS_MVP_RULES } from '@/engine/index.ts';
import { Button, Card, ConnectionBanner, Label, Pill, PlayerBadge, Screen } from '@/components/ui';
import { joinLink } from '@/constants/app';
import { COLORS } from '@/constants/theme';
import type { GameView } from '@/features/game/useGameView';
import { LeaveGameDialog } from '@/features/game/LeaveGameDialog';
import { useGameAction } from '@/features/game/useGameAction';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

export function LobbyView({ view }: { view: GameView }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const online = useGameStore((s) => s.onlinePlayerIds);
  const { state } = view.snapshot;
  const me = view.me;
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Players who left the lobby keep a row on the server but are no longer at the table.
  const players = state.players.filter((p) => p.status !== 'LEFT');
  const enough = players.length >= BUSINESS_MVP_RULES.players.min;
  const code = state.code;

  return (
    <Screen
      scroll
      testID="lobby-screen"
      footer={
        view.isHost ? (
          <Button
            title={enough ? 'START GAME' : `Waiting for players (${players.length}/${BUSINESS_MVP_RULES.players.min})`}
            testID="start-game-button"
            disabled={!enough || !!pending}
            loading={pending === 'START_GAME'}
            onPress={() => send({ type: 'START_GAME' })}
          />
        ) : me ? (
          <Button
            title={me.ready ? "I'M READY ✓" : 'TAP WHEN READY'}
            variant={me.ready ? 'success' : 'primary'}
            testID="ready-button"
            loading={pending === 'SET_READY'}
            onPress={() => send({ type: 'SET_READY', ready: !me.ready })}
          />
        ) : null
      }
    >
      <ConnectionBanner />
      <Text className="mt-2 text-center text-sm font-bold uppercase tracking-[4px] text-cream/70">Business · Lobby</Text>
      <Card className="items-center">
        <Label>Game code</Label>
        <Text className="text-6xl font-black tracking-[10px] text-ink" testID="game-code" accessibilityLabel={`Game code ${code.split('').join(' ')}`}>
          {code}
        </Text>
        <View className="mt-4 rounded-2xl bg-white p-3">
          <QRCode value={joinLink(code)} size={180} color={COLORS.ink} backgroundColor="#ffffff" />
        </View>
        <Text className="mt-3 text-center text-sm text-stone-600">Friends scan this or type the code in “Join game”.</Text>
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          title="Share code"
          onPress={() => void Share.share({ message: `Join my Business game! Code ${code}\n${joinLink(code)}` })}
        />
      </Card>

      <Card testID="lobby-players">
        <Label>
          Players ({players.length}/{BUSINESS_MVP_RULES.players.max})
        </Label>
        <View className="mt-3 gap-2">
          {players.map((p) => (
            <View key={p.id} className="flex-row items-center justify-between rounded-xl bg-white px-4 py-3">
              <View className="flex-row items-center gap-2">
                <PlayerBadge player={p} size={24} testID={`player-badge-${p.name}`} />
                <View className={`h-2.5 w-2.5 rounded-full ${online.includes(p.id) || p.id === me?.id ? 'bg-green-500' : 'bg-stone-300'}`} />
                <Text className="text-lg font-bold text-ink">
                  {p.name}
                  {p.id === me?.id ? ' (you)' : ''}
                </Text>
              </View>
              {p.isHost ? <Pill tone="gold">Host</Pill> : p.ready ? <Pill tone="good">Ready</Pill> : <Pill>Not ready</Pill>}
            </View>
          ))}
        </View>
      </Card>
      <Text className="text-center text-sm text-cream/70">
        Everyone starts with {formatINR(BUSINESS_MVP_RULES.startingCash)}. Keep your tokens on the real board — the phone is just the bank.
      </Text>
      {me ? <Button size="sm" variant="ghost" title="Leave game" testID="lobby-leave" className="self-center" onPress={() => setConfirmLeave(true)} /> : null}
      <LeaveGameDialog visible={confirmLeave} onClose={() => setConfirmLeave(false)} />
    </Screen>
  );
}
