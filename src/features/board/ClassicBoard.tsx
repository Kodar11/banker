import { memo, useMemo } from 'react';
import { View } from 'react-native';
import type { GameState } from '@/engine/index.ts';
import { COLORS } from '@/constants/theme';
import { BoardCenter } from './BoardCenter';
import { bandThickness, boardGeometry, buildBoardSpaces } from './boardModel';
import { BoardSquare, type SquareMetrics } from './BoardSquare';
import { BoardTokens } from './BoardTokens';

export const BOARD_FRAME = 5;
export const BOARD_BORDER = 2;

/**
 * The physical Business board, digitised. READ-ONLY: renders authoritative
 * state (ownership, buildings, mortgages, positions) and has no handlers.
 * `size` is the outer side length; the board is always square.
 */
export const ClassicBoard = memo(function ClassicBoard({ state, size }: { state: Pick<GameState, 'players' | 'properties' | 'turn'>; size: number }) {
  const inner = size - 2 * (BOARD_FRAME + BOARD_BORDER);
  const geo = useMemo(() => boardGeometry(inner), [inner]);
  const spaces = useMemo(() => buildBoardSpaces(state), [state]);
  const metrics: SquareMetrics = useMemo(() => {
    const nameFont = Math.min(10, Math.max(6, geo.unit * 0.25));
    return { band: bandThickness(geo), nameFont, priceFont: nameFont * 0.86, ownerStrip: Math.max(2, geo.unit * 0.09) };
  }, [geo]);

  return (
    <View
      testID="classic-board"
      accessibilityLabel="Business board"
      style={{
        width: size,
        height: size,
        aspectRatio: 1,
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
        <BoardCenter x={geo.corner} size={inner - 2 * geo.corner} />
        {spaces.map((space) => (
          <BoardSquare key={space.index} space={space} slot={geo.slots[space.index]!} metrics={metrics} />
        ))}
        <BoardTokens players={state.players} currentPlayerId={state.turn.playerId} geo={geo} />
      </View>
    </View>
  );
});
