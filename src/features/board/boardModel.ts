import {
  BOARD_CORNERS,
  BOARD_CYCLE,
  BOARD_LAYOUT,
  BOARD_ROWS,
  BOARD_SIZE,
  getDeed,
  spaceName,
  spaceTypeOf,
  type GameState,
  type PlayerState,
  type PropertyGroup,
  type PropertyKey,
  type SpaceType,
  type SpecialSpaceType,
  type SquareId,
} from '@/engine/index.ts';

/**
 * Read-only presentation model of one board square, derived from the
 * authoritative game state + the engine's canonical board (BOARD_LAYOUT, which
 * is itself derived from the physical BOARD_ROWS). Never stored, never sent.
 */
export interface BoardSpaceViewModel {
  index: number;
  squareId: SquareId;
  name: string;
  type: SpaceType;
  /** Set for start/jail/club/rest-house/tax/card squares. */
  specialType: SpecialSpaceType | null;
  isCorner: boolean;
  propertyKey: PropertyKey | null;
  propertyGroup: PropertyGroup | null;
  purchasePrice: number | null;
  owner: Pick<PlayerState, 'id' | 'name' | 'seat'> | null;
  houses: number;
  hotel: boolean;
  mortgaged: boolean;
  /** Players standing here (not bankrupt), in seat order. */
  playerIds: string[];
}

const CORNER_SET: ReadonlySet<SquareId> = new Set(BOARD_CORNERS);

export function buildBoardSpaces(state: Pick<GameState, 'players' | 'properties'>): BoardSpaceViewModel[] {
  const players = new Map(state.players.map((p) => [p.id, p]));
  const onBoard = state.players.filter((p) => p.status !== 'BANKRUPT').sort((a, b) => a.seat - b.seat);
  return BOARD_LAYOUT.map((space, index) => {
    const squareId = BOARD_CYCLE[index]!;
    const playerIds = onBoard.filter((p) => p.position === index).map((p) => p.id);
    const base = { index, squareId, name: spaceName(index), type: spaceTypeOf(space), isCorner: CORNER_SET.has(squareId), playerIds };
    if (space.kind === 'SPECIAL') {
      return { ...base, specialType: space.type, propertyKey: null, propertyGroup: null, purchasePrice: null, owner: null, houses: 0, hotel: false, mortgaged: false };
    }
    const deed = getDeed(space.propertyKey);
    const prop = state.properties[space.propertyKey];
    const owner = prop?.ownerId ? (players.get(prop.ownerId) ?? null) : null;
    return {
      ...base,
      specialType: null,
      propertyKey: space.propertyKey,
      propertyGroup: deed.group,
      purchasePrice: deed.price,
      owner: owner ? { id: owner.id, name: owner.name, seat: owner.seat } : null,
      houses: prop?.hotel ? 0 : (prop?.houses ?? 0),
      hotel: !!prop?.hotel,
      mortgaged: !!prop?.mortgaged,
    };
  });
}

// ---------------------------------------------------------------------------
// Geometry — a deterministic 10 × 10 grid.
//
// The board is GRID × GRID equal cells; the 36 squares are the cells on its
// perimeter (10 along the top, 10 along the bottom, 8 on each side between
// them). Every square is exactly cell × cell and its place comes ONLY from its
// canonical index — never from flex, percentages or its content.
//
// Canonical order (the engine's BOARD_CYCLE, untouched) → visual place, as on
// the physical board: Start in the bottom-right corner, row 1 runs left along
// the bottom to Jail, row 2 up the left side to the Club, row 3 right along the
// top to the Rest House, row 4 down the right side back to Start.
// ---------------------------------------------------------------------------

export type BoardSide = 'bottom' | 'left' | 'top' | 'right';

/** Squares between two corners on each side (derived from BOARD_ROWS; every side must match for a square board). */
export const SQUARES_PER_SIDE = (() => {
  const lengths = new Set(BOARD_ROWS.map((r) => r.length - 2));
  if (lengths.size !== 1 || BOARD_ROWS.length !== 4) throw new Error('Board View needs four equal sides');
  return [...lengths][0]!;
})();

/** Cells along one edge of the board, corners included. */
export const GRID = SQUARES_PER_SIDE + 2;

/** Grid cell (column, row; 0,0 = top-left) of a canonical board index. Pure renderer mapping. */
export function gridCellOf(index: number): { col: number; row: number; side: BoardSide } {
  const last = GRID - 1;
  const i = ((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
  if (i <= last) return { col: last - i, row: last, side: 'bottom' }; // Start … Jail
  if (i < 2 * last) return { col: 0, row: last - (i - last), side: 'left' };
  if (i <= 3 * last) return { col: i - 2 * last, row: 0, side: 'top' }; // Club … Rest House
  return { col: last, row: i - 3 * last, side: 'right' };
}

export interface SquareSlot {
  index: number;
  /** The board edge this cell lies on (corners belong to the bottom / top rows). */
  side: BoardSide;
  isCorner: boolean;
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardGeometry {
  size: number;
  /** Side of every cell: size / GRID. */
  cell: number;
  slots: SquareSlot[];
}

/**
 * THE board layout: canonical index → an absolutely positioned cell × cell
 * square inside a `size` × `size` board. Pure; everything on the board (squares,
 * centre, tokens) is placed from this and nothing else.
 */
export function calculateBoardLayout(size: number): BoardGeometry {
  if (BOARD_SIZE !== 4 * (GRID - 1)) throw new Error(`A ${GRID}×${GRID} grid has ${4 * (GRID - 1)} perimeter cells, the board has ${BOARD_SIZE}`);
  const cell = size / GRID;
  const last = GRID - 1;
  const slots: SquareSlot[] = Array.from({ length: BOARD_SIZE }, (_, index) => {
    const { col, row, side } = gridCellOf(index);
    const isCorner = (col === 0 || col === last) && (row === 0 || row === last);
    return { index, side, isCorner, col, row, x: col * cell, y: row * cell, width: cell, height: cell };
  });
  return { size, cell, slots };
}

/** @deprecated name kept for existing callers — same function. */
export const boardGeometry = calculateBoardLayout;

/** Thickness of the colour band on a property square's inner edge. */
export function bandThickness(geo: BoardGeometry): number {
  return Math.max(4, geo.cell * 0.16);
}

/** Where tokens stand: the centre of the square's cell. */
export function squareCenter(geo: BoardGeometry, index: number): { x: number; y: number } {
  const s = geo.slots[((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE]!;
  return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
}

/** Offsets that keep up to 8 tokens on one square readable (never fully overlapping). */
export function clusterOffsets(count: number, token: number): { x: number; y: number }[] {
  const d = token * 0.5;
  switch (count) {
    case 0:
      return [];
    case 1:
      return [{ x: 0, y: 0 }];
    case 2:
      return [
        { x: -d, y: 0 },
        { x: d, y: 0 },
      ];
    case 3:
      return [
        { x: -d, y: d * 0.9 },
        { x: d, y: d * 0.9 },
        { x: 0, y: -d * 0.95 },
      ];
    case 4:
      return [
        { x: -d, y: -d },
        { x: d, y: -d },
        { x: -d, y: d },
        { x: d, y: d },
      ];
    default: {
      const step = token * 0.62;
      const rows = Math.ceil(count / 3);
      return Array.from({ length: count }, (_, i) => ({ x: ((i % 3) - 1) * step, y: (Math.floor(i / 3) - (rows - 1) / 2) * step }));
    }
  }
}

/** Forward squares from `from` to `to` (0 = same square). */
export function forwardSteps(from: number, to: number): number {
  return (((to - from) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
}
