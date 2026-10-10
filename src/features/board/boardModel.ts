import {
  BOARD_CORNERS,
  BOARD_CYCLE,
  BOARD_LAYOUT,
  BOARD_ROWS,
  BOARD_SIZE,
  getDeed,
  purchasePrice,
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

export function buildBoardSpaces(state: Pick<GameState, 'players' | 'properties'> & Partial<Pick<GameState, 'mode' | 'intermediate'>>): BoardSpaceViewModel[] {
  const players = new Map(state.players.map((p) => [p.id, p]));
  const onBoard = state.players.filter((p) => p.status === 'ACTIVE').sort((a, b) => a.seat - b.seat);
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
      // Classic: the deed price. Intermediate: today's market value.
      purchasePrice: purchasePrice(state, space.propertyKey),
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
// The board is GRID × GRID tracks; the 36 squares are the cells on its
// perimeter (10 along the top, 10 along the bottom, 8 on each side between
// them). As on the physical board, the perimeter tracks are DEEPER than the
// tracks between them: a square is `cell` long along its edge and `depth` deep
// towards the centre, and a corner is depth × depth. That depth is what gives
// a square room for a building strip, an unbroken name, a price and a token.
// Every square's place and size come ONLY from its canonical index — never
// from flex, percentages or its content.
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

/** How much deeper (towards the centre) a square is than it is long along its edge. */
export const DEPTH_RATIO = 1.4;

/** Grid cell (column, row; 0,0 = top-left) of a canonical board index. Pure renderer mapping. */
export function gridCellOf(index: number): { col: number; row: number; side: BoardSide } {
  const last = GRID - 1;
  const i = ((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
  if (i <= last) return { col: last - i, row: last, side: 'bottom' }; // Start … Jail
  if (i < 2 * last) return { col: 0, row: last - (i - last), side: 'left' };
  if (i <= 3 * last) return { col: i - 2 * last, row: 0, side: 'top' }; // Club … Rest House
  return { col: last, row: i - 3 * last, side: 'right' };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Sizes shared by every square, all derived from the board's size. */
export interface BoardMetrics {
  /** Thickness of the group-colour band that holds a property's buildings. */
  band: number;
  /** Thickness of the owner's accent line along the square's outer edge. */
  ownerStrip: number;
  /** Diameter of a player token. */
  token: number;
  /** Depth of the lane reserved for tokens in every square. */
  tokenLane: number;
  nameFont: number;
  priceFont: number;
}

/**
 * The fixed zones of one square, in the square's own coordinates. Buildings,
 * text and tokens never overlap:
 *   outer edge of the board → [ name + price ] … [ building strip ] ← centre
 * with a token lane beside the text (towards the centre on the top and bottom
 * rows, along the bottom of the cell on the side columns and corners). The
 * owner accent is a thin line along the square's OUTER edge, opposite the
 * strip — the one deliberate overlap: it is drawn over the margin of the text.
 */
export interface SquareParts {
  /** Building strip, on the square's INNER edge (facing the board centre) — properties only. */
  band: Rect | null;
  /** Owner accent, on the square's OUTER edge (opposite the strip) — properties only (drawn when owned). */
  owner: Rect | null;
  content: Rect;
  tokens: Rect;
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
  parts: SquareParts;
}

export interface BoardGeometry {
  size: number;
  /** Length of a square along its edge. */
  cell: number;
  /** Depth of a square towards the centre; corners are depth × depth. */
  depth: number;
  metrics: BoardMetrics;
  slots: SquareSlot[];
}

function boardMetrics(cell: number): BoardMetrics {
  const token = Math.min(18, Math.max(8, cell * 0.3));
  const nameFont = Math.min(11, Math.max(5.5, cell * 0.235));
  return { band: Math.max(4, cell * 0.2), ownerStrip: Math.max(2, cell * 0.07), token, tokenLane: token + 1.5, nameFont, priceFont: nameFont * 0.9 };
}

/** Which board edge is "up" for a square decides where its zones go — its actual side, never a rotation. */
function squareParts(side: BoardSide, isCorner: boolean, isProperty: boolean, w: number, h: number, m: BoardMetrics): SquareParts {
  const o = isProperty ? m.ownerStrip : 0;
  // The strip is the colour band plus a sliver along its inner edge that stays clear of buildings.
  const b = isProperty ? m.band + o : 0;
  const t = m.tokenLane;
  const strips = (band: Rect, owner: Rect) => (isProperty ? { band, owner } : { band: null, owner: null });
  if (isCorner) return { band: null, owner: null, content: { left: 0, top: 0, width: w, height: h - t }, tokens: { left: 0, top: h - t, width: w, height: t } };
  switch (side) {
    case 'top':
      return {
        ...strips({ left: 0, top: h - b, width: w, height: b }, { left: 0, top: 0, width: w, height: o }),
        content: { left: 0, top: 0, width: w, height: h - b - t },
        tokens: { left: 0, top: h - b - t, width: w, height: t },
      };
    case 'bottom':
      return {
        ...strips({ left: 0, top: 0, width: w, height: b }, { left: 0, top: h - o, width: w, height: o }),
        content: { left: 0, top: b + t, width: w, height: h - b - t },
        tokens: { left: 0, top: b, width: w, height: t },
      };
    case 'left':
      return {
        ...strips({ left: w - b, top: 0, width: b, height: h }, { left: 0, top: 0, width: o, height: h }),
        content: { left: 0, top: 0, width: w - b, height: h - t },
        tokens: { left: 0, top: h - t, width: w - b, height: t },
      };
    case 'right':
      return {
        ...strips({ left: 0, top: 0, width: b, height: h }, { left: w - o, top: 0, width: o, height: h }),
        content: { left: b, top: 0, width: w - b, height: h - t },
        tokens: { left: b, top: h - t, width: w - b, height: t },
      };
  }
}

/**
 * THE board layout: canonical index → an absolutely positioned square inside a
 * `size` × `size` board, with its zones. Pure; everything on the board
 * (squares, centre, tokens) is placed from this and nothing else.
 */
export function calculateBoardLayout(size: number): BoardGeometry {
  if (BOARD_SIZE !== 4 * (GRID - 1)) throw new Error(`A ${GRID}×${GRID} grid has ${4 * (GRID - 1)} perimeter cells, the board has ${BOARD_SIZE}`);
  const cell = size / (SQUARES_PER_SIDE + 2 * DEPTH_RATIO);
  const depth = cell * DEPTH_RATIO;
  const last = GRID - 1;
  const metrics = boardMetrics(cell);
  const start = (track: number) => (track === 0 ? 0 : depth + (track - 1) * cell);
  const span = (track: number) => (track === 0 || track === last ? depth : cell);
  const slots: SquareSlot[] = Array.from({ length: BOARD_SIZE }, (_, index) => {
    const { col, row, side } = gridCellOf(index);
    const isCorner = (col === 0 || col === last) && (row === 0 || row === last);
    const width = span(col);
    const height = span(row);
    const parts = squareParts(side, isCorner, BOARD_LAYOUT[index]!.kind === 'PROPERTY', width, height, metrics);
    return { index, side, isCorner, col, row, x: start(col), y: start(row), width, height, parts };
  });
  return { size, cell, depth, metrics, slots };
}

/** @deprecated name kept for existing callers — same function. */
export const boardGeometry = calculateBoardLayout;

/** Where a token stands on a square: the middle of the square's token lane (board coordinates). */
export function tokenAnchor(geo: BoardGeometry, index: number): { x: number; y: number } {
  const s = geo.slots[((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE]!;
  const lane = s.parts.tokens;
  return { x: s.x + lane.left + lane.width / 2, y: s.y + lane.top + lane.height / 2 };
}

/**
 * Offsets (from the token anchor) for `count` tokens sharing a square whose
 * token lane is `laneWidth` wide. Up to four stand in one row, spread as far as
 * the lane allows; more form a second row above. Tokens may overlap when the
 * lane is crowded, but never completely.
 */
export function clusterOffsets(count: number, token: number, laneWidth: number): { x: number; y: number }[] {
  if (count <= 0) return [];
  const perRow = count <= 4 ? count : Math.ceil(count / 2);
  const stepX = perRow > 1 ? Math.min(token * 1.1, Math.max(token * 0.4, (laneWidth - token - 2) / (perRow - 1))) : 0;
  const stepY = token * 0.6;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, count - row * perRow);
    return { x: ((i % perRow) - (inRow - 1) / 2) * stepX, y: row === 0 ? 0 : -row * stepY };
  });
}

/** Forward squares from `from` to `to` (0 = same square). */
export function forwardSteps(from: number, to: number): number {
  return (((to - from) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
}
