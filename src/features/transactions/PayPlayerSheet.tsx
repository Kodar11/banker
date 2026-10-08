import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { GameAction } from '@/engine/index.ts';
import { Button, PlayerBadge, Sheet, TextField } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

interface PayPlayerSheetProps {
  visible: boolean;
  onClose: () => void;
  view: GameView;
  send: (a: GameAction, opts?: { successMessage?: string }) => Promise<{ ok: boolean }>;
  /** Preselects the other player (e.g. opened from that player's details). Remount (key) to change it. */
  initialPlayerId?: string | null;
}

/** Player-to-player payment (deals, side bets, settling up). */
export function PayPlayerSheet({ visible, onClose, view, send, initialPlayerId = null }: PayPlayerSheetProps) {
  const [to, setTo] = useState<string | null>(initialPlayerId);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const pending = useGameStore((s) => s.pendingAction);
  const me = view.me;
  if (!me) return null;
  const others = view.snapshot.state.players.filter((p) => p.id !== me.id && p.status === 'ACTIVE');
  const value = Number.parseInt(amount, 10) || 0;
  const error = value > me.balance ? 'Not enough money for this payment.' : null;
  const valid = !!to && value > 0 && !error;

  return (
    <Sheet visible={visible} onClose={onClose} title="Pay a player" testID="pay-sheet">
      <View className="flex-row flex-wrap gap-2">
        {others.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => setTo(p.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: to === p.id }}
            testID={`pay-to-${p.name}`}
            className={`min-h-[52px] min-w-[45%] flex-1 items-center justify-center rounded-2xl px-4 ${to === p.id ? 'bg-saffron' : 'bg-stone-200'}`}
          >
            <View className="flex-row items-center gap-2">
              <PlayerBadge player={p} size={20} />
              <Text className="text-lg font-bold text-ink">{p.name}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <View className="gap-3 rounded-2xl bg-felt p-3">
        <TextField label="Amount (₹)" keyboardType="number-pad" value={amount} onChangeText={setAmount} error={error} testID="pay-amount" />
        <TextField label="Note (optional)" value={memo} onChangeText={setMemo} maxLength={80} placeholder="e.g. deal for Delhi" />
      </View>
      <Button
        title={to ? `PAY ${view.playerName(to)} ${formatINR(value)}` : 'Choose a player'}
        testID="pay-confirm"
        disabled={!valid || !!pending}
        loading={pending === 'TRANSFER_MONEY'}
        onPress={async () => {
          if (!to) return;
          const res = await send(
            { type: 'TRANSFER_MONEY', toPlayerId: to, amount: value, ...(memo.trim() ? { memo: memo.trim() } : {}) },
            { successMessage: `Paid ${view.playerName(to)} ${formatINR(value)}` },
          );
          if (res.ok) {
            setAmount('');
            setMemo('');
            onClose();
          }
        }}
      />
    </Sheet>
  );
}
