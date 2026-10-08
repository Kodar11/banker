import { memo, useMemo } from 'react';
import { View } from 'react-native';
import type { GameState } from '@/engine/index.ts';
import { COLORS } from '@/constants/theme';
import { BoardCenter } from './BoardCenter';
import { bandThickness, buildBoardSpaces, calculateBoardLayout } from './boardModel';
import { BoardSquare, type SquareMetrics } from './BoardSquare';
import { BoardTokens } from './BoardTokens';

export const BOARD_FRAME = 5;
export const BOARD_BORDER = 2;
/** Below this there is no board to draw (e.g. a layout pass that has not measured the screen yet). */
export const MIN_DRAWABLE_BOARD = 120;

/**
 * The physical Business board, digitised. READ-ONLY: renders authoritative
 * state (ownership, buildings, mortgages, positions). The optional handlers only
 * open information (square / player details) — nothing on the board can change
 * game state. `size` is the outer side length; the board is always square.
 */
export const ClassicBoard = memo(function ClassicBoard({
  state,
  size,
  onSquarePress,
  onTokenPress,
}: {
  state: Pick<GameState, 'players' | 'properties' | 'turn'>;
  size: number;
  onSquarePress?: (index: number) => void;
  onTokenPress?: (playerId: string) => void;
}) {
  const drawable = Number.isFinite(size) && size >= MIN_DRAWABLE_BOARD;
  const inner = drawable ? size - 2 * (BOARD_FRAME + BOARD_BORDER) : MIN_DRAWABLE_BOARD;
  const geo = useMemo(() => calculateBoardLayout(inner), [inner]);
  const spaces = useMemo(() => buildBoardSpaces(state), [state]);
  const metrics: SquareMetrics = useMemo(() => {
    const nameFont = Math.min(10, Math.max(5.5, geo.cell * 0.21));
    return { band: bandThickness(geo), nameFont, priceFont: nameFont * 0.9, ownerStrip: Math.max(2, geo.cell * 0.07) };
  }, [geo]);

  // Never hand the native side negative sizes or fonts: reserve the space and draw when there is some.
  if (!drawable) return <View testID="classic-board" style={{ width: Math.max(0, size || 0), height: Math.max(0, size || 0) }} />;

  return (
    <View
      testID="classic-board"
      accessibilityLabel="Business board"
      style={{
        width: size,
        height: size,
        padding: BOARD_FRAME,
        borderRadius: 18,
        borderWidth: BOARD_BORDER,
        borderColor: COLORS.boardEdge,
        backgroundColor: COLORS.board,
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
      }}
    >
      <View style={{ width: inner, height: inner, borderRadius: 8, overflow: 'hidden', borderWidth: 0.5, borderColor: COLORS.boardLine }}>
        <BoardCenter x={geo.cell} size={inner - 2 * geo.cell} />
        {spaces.map((space) => (
          <BoardSquare key={space.index} space={space} slot={geo.slots[space.index]!} metrics={metrics} onPress={onSquarePress} />
        ))}
        <BoardTokens players={state.players} currentPlayerId={state.turn.playerId} geo={geo} onTokenPress={onTokenPress} />
      </View>
    </View>
  );
});
