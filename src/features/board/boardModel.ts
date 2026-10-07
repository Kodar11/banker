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
// Geometry — where each cyclic board index sits on the square board.
// Row 1 runs along the bottom (Start at bottom-right), row 2 up the left side,
// row 3 along the top, row 4 down the right side, like the physical board.
// ---------------------------------------------------------------------------

export type BoardSide = 'bottom' | 'left' | 'top' | 'right';
const SIDES: readonly BoardSide[] = ['bottom', 'left', 'top', 'right'];

/** Corner squares are this many times deeper than a side square is wide. */
export const CORNER_RATIO = 2.1;

export interface SquareSlot {
  index: number;
  side: BoardSide;
  isCorner: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardGeometry {
  size: number;
  /** Width of a side square along its edge. */
  unit: number;
  /** Corner size = depth of every side square. */
  corner: number;
  slots: SquareSlot[];
}

/** Squares between two corners on each side (derived from BOARD_ROWS; every side must match for a square board). */
export const SQUARES_PER_SIDE = (() => {
  const lengths = new Set(BOARD_ROWS.map((r) => r.length - 2));
  if (lengths.size !== 1 || BOARD_ROWS.length !== 4) throw new Error('Board View needs four equal sides');
  return [...lengths][0]!;
})();

export function boardGeometry(size: number): BoardGeometry {
  const n = SQUARES_PER_SIDE;
  const unit = size / (n + 2 * CORNER_RATIO);
  const c = unit * CORNER_RATIO;
  const far = size - c;
  const slots: SquareSlot[] = [];
  BOARD_ROWS.forEach((row, r) => {
    const side = SIDES[r]!;
    const first = r * (n + 1);
    // Corner that starts this row.
    const corner = { bottom: [far, far], left: [0, far], top: [0, 0], right: [far, 0] }[side] as [number, number];
    slots.push({ index: first, side, isCorner: true, x: corner[0], y: corner[1], width: c, height: c });
    for (let j = 0; j < row.length - 2; j++) {
      const index = first + 1 + j;
      if (side === 'bottom') slots.push({ index, side, isCorner: false, x: far - (j + 1) * unit, y: far, width: unit, height: c });
      if (side === 'left') slots.push({ index, side, isCorner: false, x: 0, y: far - (j + 1) * unit, width: c, height: unit });
      if (side === 'top') slots.push({ index, side, isCorner: false, x: c + j * unit, y: 0, width: unit, height: c });
      if (side === 'right') slots.push({ index, side, isCorner: false, x: far, y: c + j * unit, width: c, height: unit });
    }
  });
  if (slots.length !== BOARD_SIZE) throw new Error(`Board geometry has ${slots.length} squares, board has ${BOARD_SIZE}`);
  return { size, unit, corner: c, slots };
}

/** Thickness of the colour band on a property square's inner edge. */
export function bandThickness(geo: BoardGeometry): number {
  return Math.max(6, geo.corner * 0.18);
}

/** Where tokens stand on a square: the centre of its content area (the colour band excluded). */
export function squareCenter(geo: BoardGeometry, index: number): { x: number; y: number } {
  const s = geo.slots[((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE]!;
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  if (s.isCorner) return { x: cx, y: cy };
  const shift = bandThickness(geo) / 2;
  switch (s.side) {
    case 'bottom':
      return { x: cx, y: cy + shift };
    case 'top':
      return { x: cx, y: cy - shift };
    case 'left':
      return { x: cx - shift, y: cy };
    case 'right':
      return { x: cx + shift, y: cy };
  }
}

/** Offsets that keep up to 8 tokens on one square readable (never fully overlapping). */
export function clusterOffsets(count: number, token: number): { x: number; y: number }[] {
  const d = token * 0.55;
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
