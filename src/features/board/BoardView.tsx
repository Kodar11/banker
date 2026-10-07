import { memo, useContext } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaInsetsContext, SafeAreaView } from 'react-native-safe-area-context';
import { spaceName, type GameState, type PlayerState } from '@/engine/index.ts';
import { Button, PlayerBadge } from '@/components/ui';
import { playerColor } from '@/constants/theme';
import { describeWaiting } from '@/features/game/describe';
import type { GameView } from '@/features/game/useGameView';
import { ClassicBoard } from './ClassicBoard';

/** Board is never drawn smaller than this (names stop being readable), nor larger than this (tablets). */
export const MIN_BOARD = 280;
export const MAX_BOARD = 640;
/** Vertical space kept for header, turn status, a few player rows and Close. */
const RESERVED_HEIGHT = 330;
const GUTTER = 16;
/** Narrow phones trade a little gutter for a bigger board. */
const NARROW_GUTTER = 10;

/** Square board side for a window: as large as fits, never distorted, never wider than the screen. */
export function boardSizeFor(width: number, height: number): number {
  const byWidth = width - 2 * (width < 360 ? NARROW_GUTTER : GUTTER);
  const byHeight = height - RESERVED_HEIGHT;
  return Math.floor(Math.max(Math.min(MIN_BOARD, byWidth), Math.min(byWidth, byHeight, MAX_BOARD)));
}

/** "YOUR TURN · Turn 32 · Roll the dice on the main screen" — what the overlay says above the board. */
export function boardTurnStatus(view: Pick<GameView, 'me' | 'current' | 'isMyTurn' | 'snapshot'>): { title: string; detail: string } {
  const { state } = view.snapshot;
  const turn = `Turn ${state.turn.number}`;
  if (state.status === 'PAUSED') return { title: 'GAME PAUSED', detail: `${turn} · Resume on the main screen` };
  if (state.status === 'FINISHED') return { title: 'GAME OVER', detail: `${turn} · Final positions` };
  if (state.status !== 'ACTIVE' || !view.current) return { title: 'WAITING TO START', detail: 'Players gather in the lobby' };
  if (view.isMyTurn) return { title: 'YOUR TURN', detail: `${turn} · ${myNextStep(state, view.me)}` };
  return { title: `${view.current.name.toUpperCase()}'S TURN`, detail: `${turn} · ${describeWaiting(state, view.current.name)}` };
}

function myNextStep(state: GameState, me: PlayerState | null): string {
  switch (state.turn.phase) {
    case 'AWAITING_ROLL':
      return me?.inJail ? 'Pay or stay on the main screen' : 'Roll the dice on the main screen';
    case 'AWAITING_DECISION':
      return 'Decide on the main screen';
    case 'AWAITING_PAYMENT':
      return 'Pay on the main screen';
    case 'AWAITING_CARD':
      return 'Read your card on the main screen';
    case 'AUCTION':
      return 'Auction in progress';
    case 'TURN_COMPLETE':
      return 'End your turn on the main screen';
    default:
      return 'Continue on the main screen';
  }
}

function locationOf(p: PlayerState): string {
  if (p.status === 'BANKRUPT') return 'Bankrupt · off the board';
  const where = spaceName(p.position);
  if (p.inJail) return `${where} · ${p.jailTurnsLeft} turn${p.jailTurnsLeft === 1 ? '' : 's'} left`;
  if (p.skipTurns > 0) return `${where} · resting`;
  return where;
}

const TurnStatus = memo(function TurnStatus({ view }: { view: GameView }) {
  const { title, detail } = boardTurnStatus(view);
  const current = view.snapshot.state.status === 'ACTIVE' ? view.current : null;
  return (
    <View className="flex-row items-center gap-3 px-1" testID="board-turn-status" accessibilityRole="header" accessibilityLabel={`${title}. ${detail}`}>
      {current ? <PlayerBadge player={current} size={26} /> : null}
      <View className="flex-1">
        <Text className={`text-base font-black tracking-[2px] ${view.isMyTurn ? 'text-saffron' : 'text-cream'}`} numberOfLines={1} testID="board-turn-title">
          {title}
        </Text>
        <Text className="text-sm text-cream/70" numberOfLines={1} testID="board-turn-detail">
          {detail}
        </Text>
      </View>
    </View>
  );
});

const PlayerLocations = memo(function PlayerLocations({ view }: { view: GameView }) {
  const { state } = view.snapshot;
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  return (
    <View className="gap-2" testID="player-locations">
      <Text className="px-1 text-xs font-extrabold uppercase tracking-[3px] text-cream/60">Player locations</Text>
      {players.map((p) => {
        const isMe = p.id === view.me?.id;
        const isTurn = p.id === state.turn.playerId && state.status === 'ACTIVE';
        const where = locationOf(p);
        return (
          <View
            key={p.id}
            testID={`player-location-${p.id}`}
            accessible
            accessibilityLabel={`${p.name}${isMe ? ', you' : ''}, ${playerColor(p).name} token, at ${where}${isTurn ? ', current turn' : ''}`}
            className={`min-h-[52px] flex-row items-center gap-3 rounded-2xl px-3 py-2 ${isTurn ? 'border border-saffron/70 bg-felt-light/60' : 'bg-white/5'} ${p.status === 'BANKRUPT' ? 'opacity-50' : ''}`}
          >
            <PlayerBadge player={p} size={30} />
            <View className="flex-1">
              <Text className="text-base font-bold text-cream" numberOfLines={1}>
                {p.name}
                {isMe ? <Text className="font-semibold text-cream/60"> (You)</Text> : null}
              </Text>
              <Text className="text-sm text-cream/70" numberOfLines={1} testID={`player-location-square-${p.id}`}>
                {where}
              </Text>
            </View>
            {isTurn ? <Text className="text-[10px] font-extrabold uppercase tracking-widest text-saffron">Turn</Text> : null}
            <Text className="text-lg text-cream/30">›</Text>
          </View>
        );
      })}
    </View>
  );
});

function BoardViewContent({ view, onClose }: { view: GameView; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, bottom: 0 };
  const size = boardSizeFor(width, height - insets.top - insets.bottom);
  return (
    <SafeAreaView className="flex-1 bg-felt-dark" edges={['top', 'bottom', 'left', 'right']} testID="board-view">
      <View className="flex-row items-center px-2 pt-1">
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close board view"
          testID="board-view-close-x"
          hitSlop={8}
          className="h-11 w-11 items-center justify-center rounded-full bg-white/10"
        >
          <Text className="text-xl font-bold text-cream">✕</Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-extrabold text-cream" accessibilityRole="header">
          Board View
        </Text>
        <View className="h-11 w-11" />
      </View>
      {height >= 700 ? <Text className="text-center text-xs text-cream/50">See where everyone is on the board</Text> : null}
      <View className={`gap-3 pt-3 ${width < 360 ? 'px-2.5' : 'px-4'}`}>
        <TurnStatus view={view} />
        <View className="items-center">
          <ClassicBoard state={view.snapshot.state} size={size} />
        </View>
      </View>
      <ScrollView className="mt-4 flex-1" contentContainerClassName="px-4 pb-2">
        <PlayerLocations view={view} />
      </ScrollView>
      <View className="px-4 pb-2 pt-2">
        <Button title="Close" size="md" variant="ghost" testID="board-view-close" onPress={onClose} />
      </View>
    </SafeAreaView>
  );
}

/**
 * Full-screen, read-only map of the physical board. Reads the already-synced
 * game view (no fetching, no subscriptions); the gameplay screen stays mounted
 * underneath and remains the only place actions happen.
 */
export function BoardViewOverlay({ visible, onClose, view }: { visible: boolean; onClose: () => void; view: GameView }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      {visible ? <BoardViewContent view={view} onClose={onClose} /> : null}
    </Modal>
  );
}

