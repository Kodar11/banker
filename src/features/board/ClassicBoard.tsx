import { memo, useMemo } from 'react';
import { View } from 'react-native';
import type { GameState } from '@/engine/index.ts';
import { COLORS } from '@/constants/theme';
import { BoardCenter } from './BoardCenter';
import { buildBoardSpaces, calculateBoardLayout } from './boardModel';
import { BoardSquare } from './BoardSquare';
import { BoardTokens } from './BoardTokens';

/** The board's rim is kept slim: every pixel of it is a pixel the squares don't get. */
export const BOARD_FRAME = 3;
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
        borderRadius: 14,
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
        <BoardCenter x={geo.depth} size={inner - 2 * geo.depth} />
        {spaces.map((space) => (
          <BoardSquare key={space.index} space={space} slot={geo.slots[space.index]!} metrics={geo.metrics} onPress={onSquarePress} />
        ))}
        <BoardTokens players={state.players} currentPlayerId={state.turn.playerId} geo={geo} onTokenPress={onTokenPress} />
      </View>
    </View>
  );
});
