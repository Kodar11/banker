/// <reference types="jest" />
/** The board is a deterministic 10 × 10 grid: 36 cells on its perimeter, placed only from the canonical index. */
import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { BOARD_CYCLE, BOARD_LAYOUT, BOARD_SIZE, positionOfProperty, positionOfSpecial, spaceName } from '@/engine/index.ts';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { BOARD_BORDER, BOARD_FRAME, ClassicBoard } from '@/features/board/ClassicBoard';
import { fitName, HOUSE_ICON, SPECIAL_ICONS, textEms } from '@/features/board/BoardSquare';
import { tokenSize } from '@/features/board/BoardTokens';
import { calculateBoardLayout, clusterOffsets, DEPTH_RATIO, GRID, gridCellOf, tokenAnchor, type BoardSide, type Rect } from '@/features/board/boardModel';
import { screenGutter } from '@/features/game/layout';
import { Fixture } from './fixtures';

type Box = Rect & Record<string, unknown>;
const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style) as Box;
const SIZES = [280, 306, 320, 346, 360, 366, 390, 412, 640];
/** The board a phone of each width gets: the screen minus its gutters. */
const PHONE_BOARDS = [320, 360, 390, 412].map((w) => w - 2 * screenGutter(w));
const inner = (size: number) => size - 2 * (BOARD_FRAME + BOARD_BORDER);
const EPS = 1e-6;
const overlap = (a: Rect, b: Rect) => a.left < b.left + b.width - EPS && b.left < a.left + a.width - EPS && a.top < b.top + b.height - EPS && b.top < a.top + a.height - EPS;
const inside = (r: Rect, w: number, h: number) => r.left >= -EPS && r.top >= -EPS && r.left + r.width <= w + EPS && r.top + r.height <= h + EPS;
const isProperty = (i: number) => BOARD_LAYOUT[i]!.kind === 'PROPERTY';
/** Every text drawn in a square's content box, as { text, style }. */
const contentTexts = (i: number) =>
  within(screen.getByTestId(`board-content-${i}`))
    .getAllByText(/\S/)
    .map((t) => ({ text: String(t.props.children), props: t.props, style: StyleSheet.flatten(t.props.style) as { fontSize: number; lineHeight?: number; width?: number } }));

describe('calculateBoardLayout (pure)', () => {
  it('is a 10 × 10 grid whose perimeter is exactly the 36 squares', () => {
    expect(GRID).toBe(10);
    expect(BOARD_SIZE).toBe(36);
    expect(calculateBoardLayout(360).slots).toHaveLength(36);
  });

  it.each(SIZES)('at %ipx: 10 top, 8 right, 10 bottom, 8 left; deeper than wide; corners square; tiles the perimeter exactly', (size) => {
    const { slots, cell, depth } = calculateBoardLayout(size);
    expect(depth).toBeCloseTo(cell * DEPTH_RATIO, 10);
    expect(2 * depth + 8 * cell).toBeCloseTo(size, 8); // the board stays square: both axes use the same tracks
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
    expect(new Set(slots.map((s) => `${s.col},${s.row}`)).size).toBe(36);
    for (const s of slots) {
      expect(s.col === 0 || s.col === 9 || s.row === 0 || s.row === 9).toBe(true);
      // Along its edge a square is `cell`, towards the centre it is `depth`.
      const acrossTopOrBottom = s.side === 'top' || s.side === 'bottom';
      expect(s.width).toBeCloseTo(s.isCorner || !acrossTopOrBottom ? depth : cell, 10);
      expect(s.height).toBeCloseTo(s.isCorner || acrossTopOrBottom ? depth : cell, 10);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(size + 1e-9);
      expect(s.y + s.height).toBeLessThanOrEqual(size + 1e-9);
    }
    // No two squares overlap, and each touches the board's edge on its own side.
    for (const a of slots) for (const b of slots) if (a.index < b.index) expect(overlap({ left: a.x, top: a.y, width: a.width, height: a.height }, { left: b.x, top: b.y, width: b.width, height: b.height })).toBe(false);
    for (const s of slots) {
      if (s.side === 'top') expect(s.y).toBe(0);
      if (s.side === 'bottom') expect(s.y + s.height).toBeCloseTo(size, 8);
      if (s.side === 'left') expect(s.x).toBe(0);
      if (s.side === 'right') expect(s.x + s.width).toBeCloseTo(size, 8);
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
    // Each side holds the squares the canonical order puts there.
    const sideOf = (name: string) => slots[Array.from({ length: 36 }, (_, i) => spaceName(i)).indexOf(name)]!.side;
    const sides: Record<BoardSide, string[]> = {
      bottom: ['Mumbai', 'Water Works', 'Railway', 'Ahmedabad', 'Indore', 'Jaipur'],
      left: ['Delhi', 'Chandigarh', 'Electric Company', 'BEST', 'Shimla', 'Amritsar', 'Srinagar'],
      top: ['Agra', 'Kanpur', 'Patna', 'Darjeeling', 'Air India', 'Calcutta', 'Hyderabad'],
      right: ['Madras', 'Bangalore', 'Ootacamund', 'Cochin', 'Motor Boat', 'Margao'],
    };
    for (const [side, names] of Object.entries(sides)) for (const name of names) expect(`${name}: ${sideOf(name)}`).toBe(`${name}: ${side}`);
    // Consecutive squares are always edge-neighbours: a token walking the board never jumps.
    for (let i = 0; i < 36; i++) {
      const a = slots[i]!;
      const b = slots[(i + 1) % 36]!;
      expect(Math.abs(a.col - b.col) + Math.abs(a.row - b.row)).toBe(1);
    }
    expect(gridCellOf(36)).toEqual(gridCellOf(0));
    expect(gridCellOf(-1)).toEqual(gridCellOf(35));
  });

  it.each(SIZES)('at %ipx: every square has its zones — building strip on the INNER edge of its side (top row → bottom, right column → left, bottom row → top, left column → right), owner accent on the OPPOSITE (outer) edge', (size) => {
    const { slots, metrics } = calculateBoardLayout(size);
    for (const s of slots) {
      const { band, owner, content, tokens } = s.parts;
      const zones = [band, owner, content, tokens].filter((z): z is Rect => !!z);
      for (const z of zones) {
        expect(inside(z, s.width, s.height)).toBe(true);
        expect(z.width).toBeGreaterThan(0);
        expect(z.height).toBeGreaterThan(0);
      }
      // Only the owner accent overlaps anything: a line along the whole outer edge, over the margin of the text (and the end of the token lane on the side columns) — never over the strip.
      for (const a of zones) for (const b of zones) if (a !== b && a !== owner && b !== owner) expect(overlap(a, b)).toBe(false);
      if (band && owner) expect(overlap(band, owner)).toBe(false);
      // A token fits its lane.
      expect(tokens.height).toBeGreaterThanOrEqual(metrics.token);
      expect(tokens.width).toBeGreaterThanOrEqual(2 * metrics.token);
      if (!isProperty(s.index)) {
        expect(band).toBeNull();
        expect(owner).toBeNull();
        continue;
      }
      // Orientation comes from the square's board side: the strip lies on the edge facing the board centre and runs along it.
      const strip = metrics.band + metrics.ownerStrip;
      const expected: Record<BoardSide, [Rect, Rect]> = {
        top: [
          { left: 0, top: s.height - strip, width: s.width, height: strip },
          { left: 0, top: 0, width: s.width, height: metrics.ownerStrip },
        ],
        bottom: [
          { left: 0, top: 0, width: s.width, height: strip },
          { left: 0, top: s.height - metrics.ownerStrip, width: s.width, height: metrics.ownerStrip },
        ],
        left: [
          { left: s.width - strip, top: 0, width: strip, height: s.height },
          { left: 0, top: 0, width: metrics.ownerStrip, height: s.height },
        ],
        right: [
          { left: 0, top: 0, width: strip, height: s.height },
          { left: s.width - metrics.ownerStrip, top: 0, width: metrics.ownerStrip, height: s.height },
        ],
      };
      expect(band).toEqual(expected[s.side][0]);
      expect(owner).toEqual(expected[s.side][1]);
      // The accent is thin: a line, not a block.
      expect(metrics.ownerStrip).toBeLessThan(metrics.band / 2);
    }
  });

  it.each(SIZES)('at %ipx: tokens stand in their square’s token lane; up to four sharing a square stay inside it, eight stay on the board', (size) => {
    const geo = calculateBoardLayout(size);
    const token = tokenSize(geo);
    for (const s of geo.slots) {
      const lane = s.parts.tokens;
      const c = tokenAnchor(geo, s.index);
      expect(c).toEqual({ x: s.x + lane.left + lane.width / 2, y: s.y + lane.top + lane.height / 2 });
      for (let n = 1; n <= 8; n++) {
        const offsets = clusterOffsets(n, token, lane.width);
        expect(offsets).toHaveLength(n);
        for (const o of offsets) {
          expect(c.x + o.x - token / 2).toBeGreaterThanOrEqual(0);
          expect(c.y + o.y - token / 2).toBeGreaterThanOrEqual(0);
          expect(c.x + o.x + token / 2).toBeLessThanOrEqual(size + 1e-9);
          expect(c.y + o.y + token / 2).toBeLessThanOrEqual(size + 1e-9);
          if (n <= 4) {
            // Fully inside the lane: never on the building strip, the name or the price.
            expect(Math.abs(o.x) + token / 2).toBeLessThanOrEqual(lane.width / 2 + 1e-9);
            expect(Math.abs(o.y) + token / 2).toBeLessThanOrEqual(lane.height / 2 + 1e-9);
          }
        }
        // Never completely on top of each other.
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) expect(Math.hypot(offsets[i]!.x - offsets[j]!.x, offsets[i]!.y - offsets[j]!.y)).toBeGreaterThanOrEqual(token * 0.4 - 1e-9);
      }
    }
  });
});

describe('rendered board', () => {
  it.each(PHONE_BOARDS)('a %ipx board draws 36 absolutely placed, non-overlapping cells — with and without tap handlers', async (size) => {
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
        expect(cell.width).toBeCloseTo(slot.width, 6);
        expect(cell.height).toBeCloseTo(slot.height, 6);
        for (const k of ['flex', 'flexGrow', 'flexBasis', 'transform', 'aspectRatio']) expect(cell[k]).toBeUndefined();
        seen.add(`${Math.round(cell.left * 100)},${Math.round(cell.top * 100)}`);

        // Everything a square says stays inside its content zone, in rows whose heights add up.
        const content = flat(`board-content-${i}`);
        expect(content.overflow).toBe('hidden');
        expect(content).toMatchObject(slot.parts.content);
        // An icon is a row above the name, or (wide shallow squares) a column beside it.
        const beside = content.flexDirection === 'row';
        let rows = 0;
        let iconBox = 0;
        let lineWidth = 0;
        for (const { text, props, style } of contentTexts(i)) {
          expect(props.numberOfLines).toBe(1);
          expect(props.allowFontScaling).toBe(false);
          expect(style.fontSize).toBeGreaterThanOrEqual(4.5);
          if (style.width !== undefined) {
            // A name / price line: its estimated ink width fits the row it is clipped to.
            expect(style.width).toBeLessThanOrEqual(content.width);
            expect(textEms(text) * style.fontSize).toBeLessThanOrEqual(style.width + 1e-6);
            rows += style.lineHeight!;
            lineWidth = style.width;
          } else {
            iconBox = style.fontSize / 0.68;
          }
        }
        expect(beside ? Math.max(rows, iconBox) : rows + iconBox).toBeLessThanOrEqual(content.height + 1e-6);
        // Beside the name, icon + gap + name never exceed the square, so they cannot overlap.
        if (beside) expect(iconBox + (content.gap as number) + lineWidth).toBeLessThanOrEqual(content.width + 1e-6);
      }
      expect(seen.size).toBe(36);
      // The centre is exactly the hole the squares leave.
      const centre = StyleSheet.flatten(screen.getByTestId('board-center', { includeHiddenElements: true }).props.style) as Rect;
      expect(centre.left).toBeCloseTo(geo.depth, 6);
      expect(centre.width).toBeCloseTo(8 * geo.cell, 6);
      await ui.unmount();
    }
  });

  it.each(PHONE_BOARDS)('at %ipx: every name is whole — no hyphen, no broken word, one line per single-word name — and every price is shown', async (size) => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={size} />);
    for (let i = 0; i < BOARD_SIZE; i++) {
      const name = spaceName(i);
      const lines = contentTexts(i)
        .filter((t) => /[A-Za-z]/.test(t.text))
        .map((t) => t.text);
      expect(lines.join(' ')).toBe(name);
      for (const line of lines) expect(line).not.toMatch(/-/);
      if (!name.includes(' ')) expect(lines).toEqual([name]);
    }
    for (const whole of ['Srinagar', 'Darjeeling', 'Ahmedabad', 'Chandigarh', 'Ootacamund']) expect(screen.getByText(whole)).toBeTruthy();
    expect(screen.getAllByTestId(/^board-price-/)).toHaveLength(26);
  });

  it('fitName never breaks a word: long names shrink, two-word names take one line or two, whichever is larger', () => {
    expect(fitName('Ootacamund', 30, 20, 7).lines).toEqual(['Ootacamund']);
    expect(fitName('Ootacamund', 30, 20, 7).font).toBeLessThan(7);
    expect(fitName('Ootacamund', 62, 20, 7)).toEqual({ lines: ['Ootacamund'], font: 7 });
    expect(fitName('Mumbai', 30, 20, 7)).toEqual({ lines: ['Mumbai'], font: 7 });
    expect(fitName('Electric Company', 30, 20, 7).lines).toEqual(['Electric', 'Company']); // too long for one line
    expect(fitName('Rest House', 60, 9, 7).lines).toEqual(['Rest House']); // wide and short: one line is larger
    // Room is kept under the name for a price line.
    expect(fitName('Mumbai', 30, 10, 7, 1).font).toBeLessThan(fitName('Mumbai', 30, 10, 7).font);
    for (const name of Array.from({ length: BOARD_SIZE }, (_, i) => spaceName(i))) {
      for (const width of [20, 26, 30, 40]) expect(fitName(name, width, 18, 7).lines.join(' ')).toBe(name);
    }
  });

  it.each(PHONE_BOARDS)('at %ipx: houses and hotels sit in the inner-edge building strip, clear of the owner accent, the name, the price and the tokens', async (size) => {
    const f = new Fixture(['Tanmay', 'Guru']);
    // One built property on every side of the board.
    const built = { MUMBAI: 'bottom', DELHI: 'left', CALCUTTA: 'top', MADRAS: 'right' } as const;
    Object.assign(f.state.properties.MUMBAI, { ownerId: f.ids.Tanmay!, houses: 4 });
    Object.assign(f.state.properties.DELHI, { ownerId: f.ids.Tanmay!, houses: 3 });
    Object.assign(f.state.properties.CALCUTTA, { ownerId: f.ids.Guru!, hotel: true });
    Object.assign(f.state.properties.MADRAS, { ownerId: f.ids.Guru!, houses: 4 });
    await render(<ClassicBoard state={f.state} size={size} />);
    const geo = calculateBoardLayout(inner(size));
    for (const [key, side] of Object.entries(built) as [keyof typeof built, BoardSide][]) {
      const index = positionOfProperty(key);
      const slot = geo.slots[index]!;
      expect(slot.side).toBe(side);
      const strip = flat(`board-band-${key}`);
      expect(strip).toMatchObject(slot.parts.band!);
      expect(strip.overflow).toBe('hidden');
      expect(strip.flexDirection).toBe(side === 'left' || side === 'right' ? 'column' : 'row');
      // On the square's inner edge: NORTH → bottom, EAST → left, SOUTH → top, WEST → right.
      if (side === 'top') expect(strip.top + strip.height).toBeCloseTo(slot.height, 6);
      if (side === 'right') expect(strip.left).toBe(0);
      if (side === 'bottom') expect(strip.top).toBe(0);
      if (side === 'left') expect(strip.left + strip.width).toBeCloseTo(slot.width, 6);
      // The owner accent is on the opposite (outer) edge: NORTH → top, EAST → right, SOUTH → bottom, WEST → left. It never touches the strip.
      const accent = flat(`board-owner-strip-${key}`);
      expect(accent).toMatchObject(slot.parts.owner!);
      if (side === 'top') expect(accent.top).toBe(0);
      if (side === 'right') expect(accent.left + accent.width).toBeCloseTo(slot.width, 6);
      if (side === 'bottom') expect(accent.top + accent.height).toBeCloseTo(slot.height, 6);
      if (side === 'left') expect(accent.left).toBe(0);
      expect(overlap(strip, accent)).toBe(false);
      const pad = { top: 'paddingBottom', right: 'paddingLeft', bottom: 'paddingTop', left: 'paddingRight' }[side];
      expect(strip[pad]).toBe(geo.metrics.ownerStrip);
      // Clear of the text and of the token lane.
      expect(overlap(strip, flat(`board-content-${index}`))).toBe(false);
      expect(overlap(strip, slot.parts.tokens)).toBe(false);
      // The pieces are inside the strip (never anywhere else in the square), and fit along it.
      const band = within(screen.getByTestId(`board-band-${key}`));
      const pieces = [...band.queryAllByTestId(`board-house-${key}`), ...band.queryAllByTestId(`board-hotel-${key}`)];
      expect(pieces).toHaveLength(screen.queryAllByTestId(new RegExp(`^board-(house|hotel)-${key}$`)).length);
      const along = side === 'left' || side === 'right' ? 'height' : 'width';
      const across = along === 'height' ? 'width' : 'height';
      let used = 0;
      for (const p of pieces) {
        const s = StyleSheet.flatten(p.props.style) as Rect;
        expect(s[across]).toBeLessThanOrEqual(strip[across] - geo.metrics.ownerStrip + 1e-6);
        used += s[along] + 1;
      }
      expect(used).toBeLessThanOrEqual(strip[along] + 1e-6);
      // Neutral pieces: the only text in the strip is the house emoji, one per house; nothing of the owner's colour.
      expect(band.queryAllByText(/\S/).map((t) => String(t.props.children))).toEqual(band.queryAllByTestId(`board-house-${key}`).map(() => HOUSE_ICON));
    }
  });

  it.each(PHONE_BOARDS)('at %ipx: every Community Chest square shows its icon, the same way, without shrinking the name much', async (size) => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={size} />);
    const chests = BOARD_LAYOUT.flatMap((s, i) => (s.kind === 'SPECIAL' && s.type === 'COMMUNITY_CHEST' ? [i] : []));
    expect(chests).toHaveLength(2);
    const drawn = chests.map((i) => {
      const texts = contentTexts(i);
      const icons = texts.filter((t) => t.style.width === undefined);
      const name = texts.filter((t) => t.style.width !== undefined);
      expect(icons.map((t) => t.text)).toEqual([SPECIAL_ICONS.COMMUNITY_CHEST]);
      expect(name.map((t) => t.text)).toEqual(['Community', 'Chest']); // the text is unchanged
      // The icon supports the name: never larger than it, and the name stays close to the board's lettering size.
      expect(icons[0]!.style.fontSize).toBeLessThanOrEqual(name[0]!.style.fontSize);
      expect(icons[0]!.style.fontSize).toBeGreaterThanOrEqual(4.5);
      expect(name[0]!.style.fontSize).toBeGreaterThanOrEqual(calculateBoardLayout(inner(size)).metrics.nameFont * 0.8);
      return { icon: icons[0]!.style.fontSize, name: name[0]!.style.fontSize, direction: flat(`board-content-${i}`).flexDirection };
    });
    expect(drawn[1]).toEqual(drawn[0]);
    expect(SPECIAL_ICONS.COMMUNITY_CHEST).toBe('📦');
  });

  it('neutral cards stay plain (name and price only); only true special squares carry a pictogram', async () => {
    const f = new Fixture();
    await render(<ClassicBoard state={f.state} size={396} />);
    const icons = (i: number) => contentTexts(i).filter((t) => t.style.width === undefined).map((t) => t.text);
    for (const key of ['RAILWAY', 'WATER_WORKS', 'BEST', 'ELECTRIC_COMPANY', 'AIR_INDIA', 'MOTOR_BOAT', 'MUMBAI', 'SRINAGAR'] as const) {
      const index = positionOfProperty(key);
      expect(icons(index)).toEqual([]);
      expect(contentTexts(index).map((t) => t.text).join(' ')).toMatch(/^[A-Za-z ]+ ₹[\d,]+$/);
    }
    const neutral = positionOfProperty('RAILWAY');
    expect(flat(`board-square-${neutral}`).backgroundColor).toBe(PROPERTY_GROUP_THEME.TRANSPORT_UTILITY.tint);
    expect(flat('board-band-RAILWAY').backgroundColor).toBe(PROPERTY_GROUP_THEME.TRANSPORT_UTILITY.color);
    for (const corner of ['CLUB', 'JAIL', 'REST_HOUSE'] as const) expect(icons(positionOfSpecial(corner))).toEqual([SPECIAL_ICONS[corner]]);
    expect([SPECIAL_ICONS.CLUB, SPECIAL_ICONS.JAIL, SPECIAL_ICONS.REST_HOUSE]).toEqual(['🥂', '🔒', '🛏️']);
  });
});
