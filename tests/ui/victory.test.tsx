/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { router } from 'expo-router';
import { netWorth, totalDebt, type GameSnapshot, type ObjectiveId } from '@/engine/index.ts';
import { finalResult } from '@/features/game/finalResult';
import { GameScreen } from '@/features/game/GameScreen';
import { MIN_BOARD, planScreenLayout, VICTORY_CARD_HEIGHT } from '@/features/game/layout';
import type { GameView } from '@/features/game/useGameView';
import { VICTORY_MS, victoryMotion } from '@/features/game/victoryMoment';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { formatINR } from '@/utils/currency';
import { Fixture } from './fixtures';

function viewOf(snapshot: GameSnapshot, meId: string): GameView {
  const me = snapshot.state.players.find((p) => p.id === meId) ?? null;
  const current = snapshot.state.players.find((p) => p.id === snapshot.state.turn.playerId) ?? null;
  return {
    snapshot,
    me,
    current,
    isMyTurn: !!me && current?.id === me.id && snapshot.state.status === 'ACTIVE',
    isHost: !!me?.isHost,
    playerName: (id) => snapshot.state.players.find((p) => p.id === id)?.name ?? 'Bank',
    myNetWorth: me ? netWorth(snapshot.state, me.id) : 0,
    myDebt: me ? totalDebt(snapshot.state, me.id) : 0,
  };
}

const viewFor = (f: Fixture, name: string) => viewOf(f.snapshot(), f.ids[name]!);

/** A game Asha (host) ended after `extra` was added to each named player's cash. */
function endedGame(extra: Record<string, number> = {}, names = ['Asha', 'Bilal']): Fixture {
  const f = new Fixture(names);
  for (const [name, amount] of Object.entries(extra)) f.state.players.find((p) => p.id === f.ids[name])!.balance += amount;
  return f.act('Asha', { type: 'END_GAME' });
}

async function renderTable(f: Fixture, name = 'Asha', size = { width: 412, height: 840 }) {
  f.loadAs(name);
  const view = await render(<GameScreen view={viewFor(f, name)} />);
  await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: size } });
  return view;
}

/** Runs of the victory moment's clock started so far. */
const moments = (timing: jest.SpyInstance) => timing.mock.calls.filter(([, config]) => config.duration === VICTORY_MS).length;
const settled = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
});

describe('The final result is the server’s, read once', () => {
  it('winner, net worth and lead come from the published standings', () => {
    const f = endedGame({ Asha: 3700 });
    const result = finalResult(f.snapshot());
    expect(result.winnerId).toBe(f.ids.Asha);
    expect(result.standings.map((s) => s.playerId)).toEqual([f.ids.Asha, f.ids.Bilal]);
    // The same figure every other screen shows for that player.
    expect(result.winnerNetWorth).toBe(netWorth(f.state, f.ids.Asha!));
    expect(result.lead).toBe(netWorth(f.state, f.ids.Asha!) - netWorth(f.state, f.ids.Bilal!));
    expect(result.lead).toBe(3700);
    expect(result.tiedWithIds).toEqual([]);
  });

  it('a tie has a zero lead and names who is level', () => {
    const f = endedGame({}, ['Asha', 'Bilal', 'Chitra']);
    const result = finalResult(f.snapshot());
    expect(result.lead).toBe(0);
    expect(result.tiedWithIds).toHaveLength(2);
    expect(result.tiedWithIds).not.toContain(result.winnerId);
  });

  it('one ranked player has no lead; a game without its result has no figures at all', () => {
    const f = new Fixture(['Asha', 'Bilal']).act('Bilal', { type: 'LEAVE_GAME' });
    expect(f.state.status).toBe('FINISHED');
    expect(finalResult(f.snapshot())).toMatchObject({ winnerId: f.ids.Asha, lead: null, tiedWithIds: [], lastPlayerStanding: true });
    expect(finalResult(f.snapshot()).standings).toHaveLength(1);
    // The finishing event has not reached this phone: nothing is made up in its place.
    expect(finalResult({ state: f.state, events: [] })).toMatchObject({ standings: [], winnerNetWorth: null, lead: null });
    expect(finalResult({ state: { ...f.state, winnerId: null }, events: [] })).toMatchObject({ winnerId: null, winnerNetWorth: null, lead: null, lastPlayerStanding: false });
  });
});

describe('The result card', () => {
  it('shows the winner, their final net worth and the lead over second place — with the board and the way out unchanged', async () => {
    const f = endedGame({ Bilal: 3700 });
    await renderTable(f, 'Asha');
    const card = screen.getByTestId('context-card');
    expect(within(card).getByTestId('context-label')).toHaveTextContent('Game over · Victory');
    expect(within(card).getByTestId('context-title')).toHaveTextContent('Bilal wins!');
    expect(within(card).getByTestId('victory-net-worth', { includeHiddenElements: true })).toHaveTextContent(formatINR(netWorth(f.state, f.ids.Bilal!)));
    expect(within(card).getByTestId('victory-second-label', { includeHiddenElements: true })).toHaveTextContent('Lead over second place');
    expect(within(card).getByTestId('victory-lead', { includeHiddenElements: true })).toHaveTextContent('₹3,700');
    // One sentence for a screen reader, figures included.
    expect(within(card).getByLabelText(`Bilal wins!. Final net worth ${formatINR(netWorth(f.state, f.ids.Bilal!))}. Lead over second place: ₹3,700`)).toBeTruthy();
    expect(screen.getByTestId('board-area')).toBeTruthy();
    expect(screen.getByTestId('return-home-button')).toHaveTextContent('Return to Home');
    expect(screen.getByTestId('open-more')).toBeTruthy();
    expect(screen.queryByText(/Play again|Rematch|Share/i)).toBeNull();
  });

  it('a tie says so and shows no lead', async () => {
    const f = endedGame();
    await renderTable(f, 'Bilal');
    const card = screen.getByTestId('context-card');
    expect(within(card).getByTestId('context-label')).toHaveTextContent('Game over · Tied finish');
    expect(within(card).getByTestId('victory-second-label', { includeHiddenElements: true })).toHaveTextContent('Tied on net worth');
    const other = f.state.winnerId === f.ids.Asha ? 'Bilal' : 'Asha';
    expect(within(card).getByTestId('victory-lead', { includeHiddenElements: true })).toHaveTextContent(`Level with ${other}`);
    expect(card).not.toHaveTextContent(/Lead over second place/);
  });

  it('the last player standing has no lead to show', async () => {
    const f = new Fixture(['Asha', 'Bilal']).act('Bilal', { type: 'LEAVE_GAME' });
    await renderTable(f, 'Asha');
    const card = screen.getByTestId('context-card');
    expect(within(card).getByTestId('context-title')).toHaveTextContent('Asha wins!');
    expect(within(card).getByTestId('victory-lead', { includeHiddenElements: true })).toHaveTextContent('Last player standing');
    expect(card).not.toHaveTextContent(/Lead over second place/);
  });

  it('a game that ended without a winner claims no victory', async () => {
    const f = endedGame({ Asha: 500 });
    const snapshot: GameSnapshot = { ...f.snapshot(), state: { ...f.state, winnerId: null }, events: [] };
    f.loadAs('Asha');
    await render(<GameScreen view={viewOf(snapshot, f.ids.Asha!)} />);
    const card = screen.getByTestId('context-card');
    expect(within(card).getByTestId('context-title')).toHaveTextContent('Game over');
    expect(card).not.toHaveTextContent(/wins!|Victory|Lead over/);
    expect(within(card).queryByTestId('victory-net-worth', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('context-cta')).toBeTruthy();
  });

  it('Capital: the card’s figures include the objective bonus, exactly as the standings do', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    const objectives: Record<string, ObjectiveId> = { Asha: 'CASH_GUARDIAN', Bilal: 'DEAL_MAKER' };
    for (const [name, id] of Object.entries(objectives)) f.state.objectives!.assignments[f.ids[name]!] = id;
    f.act('Asha', { type: 'END_GAME' });
    await renderTable(f, 'Bilal');
    const card = screen.getByTestId('context-card');
    expect(within(card).getByTestId('context-title')).toHaveTextContent('Asha wins!');
    expect(within(card).getByTestId('victory-net-worth', { includeHiddenElements: true })).toHaveTextContent('₹29,000');
    expect(within(card).getByTestId('victory-lead', { includeHiddenElements: true })).toHaveTextContent('₹4,000');
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('finished-card')).toHaveTextContent(/1\. Asha\s*₹29,000/);
    expect(screen.getByTestId('finished-card')).toHaveTextContent(/2\. Bilal\s*₹25,000/);
    expect(screen.getByTestId('objective-results')).toBeTruthy();
  });

  it.each([
    [320, 548],
    [360, 640],
    [390, 763],
    [412, 915],
  ])('%ix%i: the taller card still leaves a readable board', (width, height) => {
    const plan = planScreenLayout({ width, height, topHeight: 82, only: 'compact', context: VICTORY_CARD_HEIGHT });
    expect(plan.board).toBeGreaterThanOrEqual(Math.min(MIN_BOARD, width - 16));
    expect(plan.board).toBeLessThanOrEqual(width);
    expect(plan.contextHeight).toBeGreaterThanOrEqual(VICTORY_CARD_HEIGHT.dense);
  });
});

describe('Final Standings', () => {
  it('lists everyone in ranked order, highlights the winner, and keeps the net-worth explanation behind an ⓘ', async () => {
    const f = endedGame({ Chitra: 2000, Asha: 500 }, ['Asha', 'Bilal', 'Chitra']);
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('context-cta'));
    const sheet = screen.getByTestId('sheet-standings');
    expect(within(sheet).getByText('Final Standings')).toBeTruthy();
    const card = within(sheet).getByTestId('finished-card');
    expect(card).toHaveTextContent(/Chitra wins!/);
    expect(within(card).getByTestId('finished-winner-worth')).toHaveTextContent(`Final net worth ${formatINR(netWorth(f.state, f.ids.Chitra!))}`);
    expect(card).toHaveTextContent(/1\. Chitra.*2\. Asha.*3\. Bilal/);
    expect(within(card).getByLabelText(new RegExp(`^1\\. Chitra, winner, `))).toBeTruthy();
    expect(within(card).getByLabelText(new RegExp(`^2\\. Asha, ₹`))).toBeTruthy();
    for (const name of ['Asha', 'Bilal', 'Chitra']) {
      expect(within(card).getByTestId(`standing-${f.ids[name]}`)).toHaveTextContent(new RegExp(`${name}\s*${formatINR(netWorth(f.state, f.ids[name]!))}$`));
    }
    // The formula is one tap away, not a paragraph under the list.
    expect(screen.queryByText(/Net worth = cash/)).toBeNull();
    await fireEvent.press(screen.getByTestId('net-worth-info'));
    expect(screen.getByTestId('net-worth-info-text')).toHaveTextContent('Net worth = cash + property at cost + buildings − loans owed. The highest net worth wins.');
    await fireEvent.press(screen.getByTestId('net-worth-info-close'));
    expect(screen.queryByText(/Net worth = cash/)).toBeNull();
    expect(screen.getByTestId('finished-card')).toBeTruthy();
  });

  it('Capital explains market value, mortgages and loans', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate', config: { secretObjectives: false } }).act('Asha', { type: 'END_GAME' });
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('context-cta'));
    await fireEvent.press(screen.getByTestId('net-worth-info'));
    expect(screen.getByTestId('net-worth-info-text')).toHaveTextContent(/cash \+ property at market value \+ buildings at cost − mortgages to redeem − loans owed/);
  });
});

describe('The victory moment', () => {
  let timing: jest.SpyInstance;
  beforeEach(() => {
    victoryMotion.enabled = true;
    timing = jest.spyOn(Animated, 'timing');
  });
  afterEach(() => timing.mockRestore());

  it('plays once for a finished game: not again on a re-render, after the standings sheet, or on a remount', async () => {
    const f = endedGame({ Asha: 3700 });
    const first = await renderTable(f, 'Asha');
    await waitFor(() => expect(moments(timing)).toBe(1));
    // The result and the way out are there while it plays.
    expect(screen.getByTestId('victory-net-worth', { includeHiddenElements: true })).toHaveTextContent(formatINR(netWorth(f.state, f.ids.Asha!)));
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('finished-card')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('sheet-standings')).getAllByLabelText('Close')[0]!);
    await first.rerender(<GameScreen view={viewFor(f, 'Asha')} />);
    await settled();
    expect(moments(timing)).toBe(1);
    await first.unmount();
    // Reconnected, or the table opened again: the same finished game.
    await renderTable(f, 'Asha');
    await settled();
    expect(moments(timing)).toBe(1);
    expect(victoryMotion.played.has(f.state.id)).toBe(true);
  });

  it('Return to Home works at once, without waiting for it', async () => {
    const f = endedGame({ Asha: 3700 });
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('return-home-button'));
    expect((router.replace as jest.Mock).mock.calls).toEqual([['/']]);
  });

  it('a game still being played, or one that ended with no winner, has none', async () => {
    const f = new Fixture();
    await renderTable(f, 'Asha');
    await settled();
    expect(moments(timing)).toBe(0);
    expect(victoryMotion.played.size).toBe(0);
  });

  it('with reduced motion the finished card is simply there', async () => {
    const reduce = AccessibilityInfo.isReduceMotionEnabled as jest.Mock;
    reduce.mockResolvedValue(true);
    const f = endedGame({ Asha: 3700 });
    await renderTable(f, 'Asha');
    await waitFor(() => expect(victoryMotion.played.has(f.state.id)).toBe(true));
    expect(moments(timing)).toBe(0);
    expect(screen.getByTestId('context-title')).toHaveTextContent('Asha wins!');
    expect(screen.getByTestId('victory-lead', { includeHiddenElements: true })).toHaveTextContent('₹3,700');
  });
});
