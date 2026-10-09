import { useState } from 'react';
import { View } from 'react-native';
import type { GameAction } from '@/engine/index.ts';
import { Button, MoneyField, PlayerPicker, Sheet, TextField } from '@/components/ui';
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

/** Player-to-player payment (deals, side bets, settling up): who → how much → why (optional) → pay. */
export function PayPlayerSheet({ visible, onClose, view, send, initialPlayerId = null }: PayPlayerSheetProps) {
  const [to, setTo] = useState<string | null>(initialPlayerId);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const pending = useGameStore((s) => s.pendingAction);
  const me = view.me;
  if (!me) return null;
  const others = view.snapshot.state.players.filter((p) => p.id !== me.id && p.status === 'ACTIVE');
  const value = Number.parseInt(amount, 10) || 0;
  const short = value > me.balance;
  const valid = !!to && value > 0 && !short;
  // The button always says what is still missing, or exactly what it will do.
  const next = !to
    ? 'Choose a player'
    : amount === ''
      ? 'Enter amount'
      : value <= 0
        ? 'Enter a valid amount'
        : short
          ? 'Insufficient funds'
          : `Pay ${formatINR(value)} to ${view.playerName(to)}`;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Pay a player"
      testID="pay-sheet"
      footer={
        <Button
          title={next}
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
      }
    >
      <PlayerPicker label="Pay to" players={others} selectedId={to} onSelect={setTo} testIDPrefix="pay-to" />
      <View className="gap-3 rounded-2xl bg-felt p-3">
        <MoneyField
          label="Amount"
          emphasis="strong"
          value={amount}
          onChangeValue={setAmount}
          placeholder="0"
          error={short ? `Insufficient funds. You have ${formatINR(me.balance)} available.` : null}
          testID="pay-amount"
        />
        <TextField label="Note · optional" emphasis="quiet" value={memo} onChangeText={setMemo} maxLength={80} placeholder="e.g. deal for Delhi" testID="pay-note" />
      </View>
    </Sheet>
  );
}
