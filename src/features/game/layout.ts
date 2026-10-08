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
/**
 * The turn bar, contextual card and action buttons have fixed heights (so the
 * board never jumps). Their text may follow the phone's font-size setting only
 * this far — beyond it the text would be cut off or collide inside the fixed box.
 */
export const FIXED_HEIGHT_FONT_SCALE = 1.15;
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

/** Kept slim: the board is as wide as the screen minus this, and every pixel of board is name room. */
export function screenGutter(width: number): number {
  return width < 360 ? 6 : 8;
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
  // The 2×3 grid (one-line labels) is preferred; the single row is its shorter fallback.
  const candidates: ActionLayout[] = only ? [] : rowFits ? ['grid', 'row'] : ['grid'];
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
  /** Height of one action button (at least ACTION_BUTTON_HEIGHT for the layout). */
  actionButtonHeight: number;
}

/** Rows of buttons in each action layout. */
const ACTION_ROWS: Record<ActionLayout, number> = { row: 1, grid: 2, compact: 1 };
/** The most a tall screen's spare height may add: to each gap, the card, each action row and the turn bar. */
const ROOMY = { gap: 4, context: 20, actionRow: 8, turnBar: 6 } as const;

/**
 * The whole main-screen composition. Priority when space runs out:
 * header/players → turn bar → board → contextual card → action area. The
 * action area collapses first; then the turn bar and card go dense; only then
 * does the screen scroll (the board never drops below MIN_BOARD).
 *
 * When there is height to SPARE (tall phones: the board is as wide as the
 * screen and cannot grow), it goes into the sections themselves — never into
 * empty bands above and below the board. Whatever is still left sits above the
 * action area, which stays at the bottom of the screen.
 */
export function planScreenLayout({ width, height, topHeight, only }: ScreenLayoutInput): ScreenLayoutPlan {
  const variant = (dense: boolean) => {
    const k = dense ? 'dense' : 'normal';
    const free = height - SCREEN_PADDING.top - SCREEN_PADDING.bottom - topHeight - TURN_BAR_HEIGHT[k] - CONTEXT_CARD_HEIGHT[k] - 4 * SECTION_GAP[k];
    return { ...planGameLayout({ width, free, only }), dense, gap: SECTION_GAP[k], turnBarHeight: TURN_BAR_HEIGHT[k], contextHeight: CONTEXT_CARD_HEIGHT[k] };
  };
  const normal = variant(false);
  const plan = normal.fits ? normal : variant(true);
  const rows = ACTION_ROWS[plan.actions];
  let spare = Math.max(
    0,
    height - SCREEN_PADDING.top - SCREEN_PADDING.bottom - topHeight - plan.turnBarHeight - plan.board - plan.contextHeight - ACTION_AREA_HEIGHT[plan.actions] - 4 * plan.gap,
  );
  /** Takes up to `max` per unit for `units` equal units out of the spare height. */
  const take = (max: number, units = 1) => {
    const each = Math.floor(Math.min(max, spare / units));
    spare -= each * units;
    return each;
  };
  const gap = plan.gap + take(ROOMY.gap, 4);
  const contextHeight = plan.contextHeight + take(ROOMY.context);
  const actionButtonHeight = ACTION_BUTTON_HEIGHT[plan.actions] + take(ROOMY.actionRow, rows);
  const turnBarHeight = plan.turnBarHeight + take(ROOMY.turnBar);
  return { ...plan, gap: gap + take(ROOMY.gap, 4), contextHeight, actionButtonHeight, turnBarHeight };
}
