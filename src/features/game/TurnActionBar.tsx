import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { GameAction } from '@/engine/index.ts';
import { Button, PlayerBadge } from '@/components/ui';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { turnStatus } from './gameFocus';
import type { GameView } from './useGameView';

interface TurnActionBarProps {
  view: GameView;
  send: (action: GameAction) => Promise<unknown>;
  /** Opens the decision sheet (buy / jail / card / payment details). */
  onChoose: () => void;
  /** Fixed height from the screen layout plan (dense on short phones). */
  height: number;
  dense?: boolean;
}

/**
 * Whose turn it is + THE one thing to do now, side by side. Fixed height so the
 * board below never jumps when the phase changes.
 */
export const TurnActionBar = memo(function TurnActionBar({ view, send, onChoose, height, dense = false }: TurnActionBarProps) {
  const pending = useGameStore((s) => s.pendingAction);
  const { title, detail, primary } = turnStatus(view);
  const mine = view.isMyTurn;
  const current = view.snapshot.state.status === 'ACTIVE' ? view.current : null;

  let action: ReactNode = null;
  if (primary) {
    const common = { size: 'sm' as const, className: 'min-w-[104px] px-3', disabled: !!pending };
    switch (primary.kind) {
      case 'roll':
        action = <Button {...common} title="🎲 Roll Dice" testID="roll-button" loading={pending === 'ROLL_DICE'} onPress={() => send({ type: 'ROLL_DICE' })} />;
        break;
      case 'choose':
        action = <Button {...common} disabled={false} title={primary.label} testID="turn-choose" onPress={onChoose} />;
        break;
      case 'pay':
        action = (
          <Button {...common} title={`Pay ${formatINR(primary.amount)}`} testID="turn-pay" loading={pending === primary.action} onPress={() => send({ type: primary.action })} />
        );
        break;
      case 'end-turn':
        action = <Button {...common} variant="secondary" title="End Turn" testID="end-turn-button" loading={pending === 'END_TURN'} onPress={() => send({ type: 'END_TURN' })} />;
        break;
      case 'bid':
        action = (
          <Button
            {...common}
            title={`Bid ${formatINR(primary.amount)}`}
            testID="turn-bid"
            loading={pending === 'PLACE_BID'}
            onPress={() => send({ type: 'PLACE_BID', auctionId: primary.auctionId, amount: primary.amount })}
          />
        );
        break;
      case 'auction':
        action = <Button {...common} disabled={false} variant="secondary" title="View auction" testID="turn-auction" onPress={() => router.push(`/auction/${primary.auctionId}`)} />;
        break;
      case 'resume':
        action = <Button {...common} title="Resume" testID="resume-button" loading={pending === 'RESUME_GAME'} onPress={() => send({ type: 'RESUME_GAME' })} />;
        break;
      case 'waiting':
        action = (
          <View className="min-h-[44px] min-w-[96px] items-center justify-center rounded-2xl border border-white/15 px-3" testID="turn-waiting">
            <Text className="text-sm font-bold text-cream/80" numberOfLines={1}>
              {primary.label}
            </Text>
          </View>
        );
        break;
    }
  }

  return (
    <View
      testID="turn-bar"
      style={{ height }}
      className={`flex-row items-center gap-2.5 rounded-2xl px-3 ${mine ? 'border-2 border-saffron bg-felt-light' : 'border-2 border-transparent bg-felt-dark'}`}
    >
      {current ? <PlayerBadge player={current} size={28} /> : null}
      <View className="flex-1" accessible accessibilityRole="header" accessibilityLabel={`${title}. ${detail}`}>
        <Text className={`text-base font-black tracking-[2px] ${mine ? 'text-saffron' : 'text-cream'}`} numberOfLines={1} testID="turn-title">
          {title}
        </Text>
        <Text className="text-xs font-semibold leading-4 text-cream/75" numberOfLines={dense ? 1 : 2} testID="turn-detail">
          {detail}
        </Text>
      </View>
      {action}
    </View>
  );
});
