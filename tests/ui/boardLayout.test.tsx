/// <reference types="jest" />
/** The board is a deterministic 10 × 10 grid: 36 equal cells on its perimeter, placed only from the canonical index. */
import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { BOARD_CYCLE, BOARD_SIZE, positionOfSpecial, spaceName } from '@/engine/index.ts';
import { BOARD_BORDER, BOARD_FRAME, ClassicBoard } from '@/features/board/ClassicBoard';
import { nameLines } from '@/features/board/BoardSquare';
import { tokenSize } from '@/features/board/BoardTokens';
import { calculateBoardLayout, clusterOffsets, GRID, gridCellOf, squareCenter } from '@/features/board/boardModel';
import { Fixture } from './fixtures';

type Box = { left: number; top: number; width: number; height: number };
const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style) as Box & Record<string, unknown>;
const SIZES = [280, 306, 320, 346, 360, 366, 390, 412, 640];
const inner = (size: number) => size - 2 * (BOARD_FRAME + BOARD_BORDER);

describe('calculateBoardLayout (pure)', () => {
  it('is a 10 × 10 grid whose perimeter is exactly the 36 squares', () => {
    expect(GRID).toBe(10);
    expect(BOARD_SIZE).toBe(36);
    expect(calculateBoardLayout(360).slots).toHaveLength(36);
  });

  it.each(SIZES)('at %ipx: 10 top, 8 right, 10 bottom, 8 left; corners shared by the rows; no duplicates; nothing outside', (size) => {
    const { slots, cell } = calculateBoardLayout(size);
    expect(cell).toBeCloseTo(size / 10, 10);
    const rowOf = (r: number) => slots.filter((s) => s.row === r);
    const colOf = (c: number) => slots.filter((s) => s.col === c);
    expect(rowOf(0)).toHaveLength(10); // top, corners included
    expect(rowOf(9)).toHaveLength(10); // bottom, corners included
    expect(colOf(9).filter((s) => s.row > 0 && s.row < 9)).toHaveLength(8); // right, between the corners
    expect(colOf(0).filter((s) => s.row > 0 && s.row < 9)).toHaveLength(8); // left, between the corners
    expect(slots.filter((s) => s.side === 'top')).toHaveLength(10);
    expect(slots.filter((s) => s.side === 'bottom')).toHaveLength(10);
    expect(slots.filter((s) => s.side === 'left')).toHaveLength(8);
    expect(slots.filter((s) => s.side === 'right')).toHaveLength(8);
    // Every cell is on the perimeter, identical in size, at a unique grid position, inside the board.
    expect(new Set(slots.map((s) => `${s.col},${s.row}`)).size).toBe(36);
    for (const s of slots) {
      expect(s.col === 0 || s.col === 9 || s.row === 0 || s.row === 9).toBe(true);
      expect(s.width).toBe(cell);
      expect(s.height).toBe(cell);
      expect(s.x).toBeCloseTo(s.col * cell, 10);
      expect(s.y).toBeCloseTo(s.row * cell, 10);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(size + 1e-9);
      expect(s.y + s.height).toBeLessThanOrEqual(size + 1e-9);
    }
  });

  it('maps the canonical order (untouched) onto the physical board: Start bottom-right, then clockwise', () => {
    // The engine's order is not the renderer's business — it must be exactly what it was.
    expect(BOARD_CYCLE).toHaveLength(36);
    expect([0, 9, 18, 27].map(spaceName)).toEqual(['Start', 'Jail', 'Club', 'Rest House']);
    expect(gridCellOf(positionOfSpecial('START'))).toEqual({ col: 9, row: 9, side: 'bottom' });
    expect(gridCellOf(positionOfSpecial('JAIL'))).toEqual({ col: 0, row: 9, side: 'bottom' });
    expect(gridCellOf(positionOfSpecial('CLUB'))).toEqual({ col: 0, row: 0, side: 'top' });
    expect(gridCellOf(positionOfSpecial('REST_HOUSE'))).toEqual({ col: 9, row: 0, side: 'top' });
    const { slots } = calculateBoardLayout(400);
    expect(slots.filter((s) => s.isCorner).map((s) => s.index)).toEqual([0, 9, 18, 27]);
    // Consecutive squares are always edge-neighbours: a token walking the board never jumps.
    for (let i = 0; i < 36; i++) {
      const a = slots[i]!;
      const b = slots[(i + 1) % 36]!;
      expect(Math.abs(a.col - b.col) + Math.abs(a.row - b.row)).toBe(1);
    }
    expect(gridCellOf(36)).toEqual(gridCellOf(0));
    expect(gridCellOf(-1)).toEqual(gridCellOf(35));
  });

  it.each(SIZES)('at %ipx: tokens stand on cell centres and a full cluster of 8 stays inside the cell’s neighbourhood and the board', (size) => {
    const geo = calculateBoardLayout(size);
    const token = tokenSize(geo);
    for (const s of geo.slots) {
      expect(squareCenter(geo, s.index)).toEqual({ x: s.x + geo.cell / 2, y: s.y + geo.cell / 2 });
    }
    for (let n = 1; n <= 8; n++) {
      for (const s of geo.slots) {
        const c = squareCenter(geo, s.index);
        for (const o of clusterOffsets(n, token)) {
          // Inside the board, and (up to 4 players) fully inside the token's own cell.
          expect(c.x + o.x - token / 2).toBeGreaterThanOrEqual(0);
          expect(c.y + o.y - token / 2).toBeGreaterThanOrEqual(0);
          expect(c.x + o.x + token / 2).toBeLessThanOrEqual(size);
          expect(c.y + o.y + token / 2).toBeLessThanOrEqual(size);
          if (n <= 4) {
            expect(Math.abs(o.x) + token / 2).toBeLessThanOrEqual(geo.cell / 2 + 1e-9);
            expect(Math.abs(o.y) + token / 2).toBeLessThanOrEqual(geo.cell / 2 + 1e-9);
          }
        }
      }
    }
  });
});

describe('rendered board', () => {
  it.each([320, 360, 390, 412].map((w) => w - 24))('a %ipx board draws 36 absolutely placed, equal, non-overlapping cells — with and without tap handlers', async (size) => {
    const f = new Fixture(['Tanmay', 'Guru']);
    Object.assign(f.state.properties.MUMBAI, { ownerId: f.ids.Tanmay!, houses: 4 });
    Object.assign(f.state.properties.SHIMLA, { ownerId: f.ids.Guru!, mortgaged: true });
    const geo = calculateBoardLayout(inner(size));
    for (const handlers of [{}, { onSquarePress: jest.fn(), onTokenPress: jest.fn() }]) {
      const ui = await render(<ClassicBoard state={f.state} size={size} {...handlers} />);
      const board = flat('classic-board');
      expect(board.width).toBe(size);
      expect(board.height).toBe(size);
      const seen = new Set<string>();
      for (let i = 0; i < BOARD_SIZE; i++) {
        const el = screen.getByTestId(`board-square-${i}`);
        // A plain style object — the function form is dropped by NativeWind on native (the collapsed-board bug).
        expect(typeof el.props.style).not.toBe('function');
        const cell = flat(`board-square-${i}`);
        const slot = geo.slots[i]!;
        expect(cell.position).toBe('absolute');
        expect(cell.overflow).toBe('hidden');
        expect(cell.left).toBeCloseTo(slot.x, 6);
        expect(cell.top).toBeCloseTo(slot.y, 6);
        expect(cell.width).toBeCloseTo(geo.cell, 6);
        expect(cell.height).toBeCloseTo(geo.cell, 6);
        for (const k of ['flex', 'flexGrow', 'flexBasis', 'transform', 'aspectRatio']) expect(cell[k]).toBeUndefined();
        seen.add(`${Math.round(cell.left * 100)},${Math.round(cell.top * 100)}`);

        // Everything a square says stays inside its own cell, in rows whose heights add up.
        const content = flat(`board-content-${i}`);
        expect(content.overflow).toBe('hidden');
        expect(content.left).toBeGreaterThanOrEqual(0);
        expect(content.top).toBeGreaterThanOrEqual(0);
        expect(content.left + content.width).toBeLessThanOrEqual(geo.cell + 1e-6);
        expect(content.top + content.height).toBeLessThanOrEqual(geo.cell + 1e-6);
        let rows = 0;
        for (const text of within(screen.getByTestId(`board-content-${i}`)).getAllByText(/\S/)) {
          const style = StyleSheet.flatten(text.props.style) as { fontSize: number; lineHeight?: number; width?: number };
          expect(text.props.numberOfLines).toBe(1);
          expect(text.props.allowFontScaling).toBe(false);
          expect(style.fontSize).toBeGreaterThanOrEqual(4.5);
          if (style.width !== undefined) {
            // A name / price line: its estimated ink width fits the row it is clipped to.
            expect(style.width).toBeLessThanOrEqual(content.width);
            expect(String(text.props.children).length * style.fontSize * 0.6).toBeLessThanOrEqual(style.width + 1e-6);
            rows += style.lineHeight!;
          } else {
            rows += style.fontSize / 0.68; // an icon box
          }
        }
        expect(rows).toBeLessThanOrEqual(content.height + 1e-6);
      }
      expect(seen.size).toBe(36);
      // Bands and owner strips never leave their cell either.
      for (const id of ['board-band-MUMBAI', 'board-owner-strip-MUMBAI', 'board-band-SHIMLA']) {
        const b = flat(id);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.left + b.width).toBeLessThanOrEqual(geo.cell + 1e-6);
        expect(b.top + b.height).toBeLessThanOrEqual(geo.cell + 1e-6);
      }
      // The centre is exactly the 8 × 8 hole.
      const centre = StyleSheet.flatten(screen.getByTestId('board-center', { includeHiddenElements: true }).props.style) as Box;
      expect(centre.left).toBeCloseTo(geo.cell, 6);
      expect(centre.width).toBeCloseTo(8 * geo.cell, 6);
      await ui.unmount();
    }
  });

  it('every name and price is shown in full (hyphenated, never cut or dropped)', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={296} />);
    for (let i = 0; i < BOARD_SIZE; i++) {
      const shown = within(screen.getByTestId(`board-content-${i}`))
        .getAllByText(/[A-Za-z]/)
        .map((t) => String(t.props.children))
        .join(' ')
        .replace(/- /g, '');
      expect(shown).toBe(spaceName(i));
    }
    expect(screen.getAllByTestId(/^board-price-/)).toHaveLength(26);
  });

  it('nameLines: a line per word; long single words are hyphenated only when the cell is narrow', () => {
    expect(nameLines('Electric Company', 30, 7)).toEqual(['Electric', 'Company']);
    expect(nameLines('Ootacamund', 30, 7)).toEqual(['Ootac-', 'amund']);
    expect(nameLines('Ootacamund', 62, 7)).toEqual(['Ootacamund']);
    expect(nameLines('Mumbai', 20, 7)).toEqual(['Mumbai']);
  });
});
