/**
 * Main game screen layout, planned from MEASURED space — never from a list of
 * device sizes. The board gets the largest square that fits; the action area
 * adapts around it (six in a row → 2×3 grid → compact + More) before the board
 * is allowed to shrink.
 */

/** Board is never drawn smaller than this (names stop being readable), nor larger than this (tablets). */
export const MIN_BOARD = 280;
export const MAX_BOARD = 640;

/**
 * Fixed-height sections around the board. "dense" is used only when the normal
 * sizes would push the board below MIN_BOARD (short phones).
 */
export const SECTION_GAP = { normal: 8, dense: 6 } as const;
export const TURN_BAR_HEIGHT = { normal: 68, dense: 56 } as const;
export const CONTEXT_CARD_HEIGHT = { normal: 76, dense: 62 } as const;
export const SCREEN_PADDING = { top: 4, bottom: 8 } as const;
/** Gap between action buttons. */
export const ACTION_GAP = 6;

export type ActionLayout = 'row' | 'grid' | 'compact';

/** Height of the action area in each layout (buttons are drawn at exactly these heights). */
export const ACTION_BUTTON_HEIGHT = { row: 60, grid: 46, compact: 48 } as const;
export const ACTION_AREA_HEIGHT: Record<ActionLayout, number> = {
  row: ACTION_BUTTON_HEIGHT.row,
  grid: 2 * ACTION_BUTTON_HEIGHT.grid + ACTION_GAP,
  compact: ACTION_BUTTON_HEIGHT.compact,
};

/** Narrowest button that still fits an icon over a two-line label ("My / Properties"). */
export const MIN_ROW_BUTTON = 58;
/** The board may give up this much to show every action instead of hiding some in More. */
const BOARD_SLACK = 8;

export function screenGutter(width: number): number {
  return width < 360 ? 8 : 12;
}

export interface GameLayoutInput {
  /** Measured width of the screen content area. */
  width: number;
  /** Measured height left for board + action area (everything else already laid out). */
  free: number;
  /** Force one action layout (e.g. 'compact' when only "More" is shown). */
  only?: ActionLayout;
}

export interface GameLayoutPlan {
  board: number;
  actions: ActionLayout;
  /** false = even the compact layout can't fit a readable board; the screen scrolls. */
  fits: boolean;
}

export function planGameLayout({ width, free, only }: GameLayoutInput): GameLayoutPlan {
  const inner = width - 2 * screenGutter(width);
  const full = Math.floor(Math.max(0, Math.min(inner, MAX_BOARD)));
  const boardWith = (mode: ActionLayout) => Math.floor(Math.min(full, free - ACTION_AREA_HEIGHT[mode]));
  const rowFits = (inner - 5 * ACTION_GAP) / 6 >= MIN_ROW_BUTTON;
  const candidates: ActionLayout[] = only ? [] : rowFits ? ['row', 'grid'] : ['grid'];
  for (const mode of candidates) {
    if (boardWith(mode) >= full - BOARD_SLACK) return { board: boardWith(mode), actions: mode, fits: true };
  }
  // Constrained: secondary actions collapse into More before the board shrinks below readable.
  const mode = only ?? 'compact';
  const floor = Math.min(MIN_BOARD, full);
  return { board: Math.max(floor, boardWith(mode)), actions: mode, fits: boardWith(mode) >= floor };
}

export interface ScreenLayoutInput {
  /** Measured content area (inside safe-area insets). */
  width: number;
  height: number;
  /** Measured height of the header + player strip (+ connection banner). */
  topHeight: number;
  only?: ActionLayout;
}

export interface ScreenLayoutPlan extends GameLayoutPlan {
  dense: boolean;
  gap: number;
  turnBarHeight: number;
  contextHeight: number;
}

/**
 * The whole main-screen composition. Priority when space runs out:
 * header/players → turn bar → board → contextual card → action area. The
 * action area collapses first; then the turn bar and card go dense; only then
 * does the screen scroll (the board never drops below MIN_BOARD).
 */
export function planScreenLayout({ width, height, topHeight, only }: ScreenLayoutInput): ScreenLayoutPlan {
  const variant = (dense: boolean) => {
    const k = dense ? 'dense' : 'normal';
    const free = height - SCREEN_PADDING.top - SCREEN_PADDING.bottom - topHeight - TURN_BAR_HEIGHT[k] - CONTEXT_CARD_HEIGHT[k] - 4 * SECTION_GAP[k];
    return { ...planGameLayout({ width, free, only }), dense, gap: SECTION_GAP[k], turnBarHeight: TURN_BAR_HEIGHT[k], contextHeight: CONTEXT_CARD_HEIGHT[k] };
  };
  const normal = variant(false);
  return normal.fits ? normal : variant(true);
}
