/// <reference types="jest" />
import { router } from 'expo-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { netWorth, OBJECTIVE_IDS, OBJECTIVES, redactObjectives, totalDebt, type GameSnapshot, type ObjectiveId } from '@/engine/index.ts';
import { GameScreen } from '@/features/game/GameScreen';
import { FinishedView } from '@/features/game/GamePanels';
import type { GameView } from '@/features/game/useGameView';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { LobbyView } from '@/features/lobby/LobbyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import CreateGame from '../../app/create-game';
import Settings from '../../app/settings';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;

/** The snapshot as the server sends it to `name`: other players' objectives are not in it. */
function snapshotFor(f: Fixture, name: string): GameSnapshot {
  const snapshot = f.snapshot();
  return { ...snapshot, state: redactObjectives(snapshot.state, f.ids[name]!) };
}

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = snapshotFor(f, name);
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
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

/** Puts `name`'s own (redacted) snapshot in the stores, as their phone would hold it. */
function loadAs(f: Fixture, name: string) {
  f.loadAs(name);
  useGameStore.getState().reset(f.state.id);
  useGameStore.getState().applySnapshot(snapshotFor(f, name));
  useGameStore.getState().setConnection('live');
}

async function renderGame(f: Fixture, name: string) {
  loadAs(f, name);
  const view = await render(<GameScreen view={viewFor(f, name)} />);
  await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
  return view;
}

function assign(f: Fixture, objectives: Record<string, ObjectiveId>) {
  for (const [name, id] of Object.entries(objectives)) f.state.objectives!.assignments[f.ids[name]!] = id;
}

const press = async (testID: string, times = 1) => {
  for (let i = 0; i < times; i += 1) await fireEvent.press(screen.getByTestId(testID));
};

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

// ---------------------------------------------------------------------------

describe('Create game: settings', () => {
  it('opens on the standard rules, with nothing Intermediate offered for Classic', async () => {
    await render(<CreateGame />);
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹25,000');
    expect(screen.getByTestId('config-loanLimit-value')).toHaveTextContent('₹20,000');
    expect(screen.queryByTestId('config-volatility')).toBeNull();
    expect(screen.queryByTestId('config-objectives')).toBeNull();
    const review = screen.getByTestId('game-review');
    expect(review).toHaveTextContent(/Mode\s*Classic/);
    expect(review).toHaveTextContent(/Starting cash\s*₹25,000/);
    expect(review).toHaveTextContent(/Maximum outstanding loans\s*₹20,000/);
    expect(review).not.toHaveTextContent(/Market volatility|Secret objectives/);
    expect(screen.getByTestId('config-restore-defaults').props.accessibilityState.disabled).toBe(true);
  });

  it('steps both amounts in ₹5,000 and stops at the limits the server enforces', async () => {
    await render(<CreateGame />);
    await press('config-startingCash-plus', 5);
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹50,000');
    expect(screen.getByTestId('config-startingCash-plus').props.accessibilityState.disabled).toBe(true);
    await press('config-startingCash-minus', 8);
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹10,000');
    expect(screen.getByTestId('config-startingCash-minus').props.accessibilityState.disabled).toBe(true);
    await press('config-loanLimit-minus', 3);
    expect(screen.getByTestId('config-loanLimit-value')).toHaveTextContent('₹5,000');
    expect(screen.getByTestId('config-loanLimit-minus').props.accessibilityState.disabled).toBe(true);
    await press('config-loanLimit-plus', 9);
    expect(screen.getByTestId('config-loanLimit-value')).toHaveTextContent('₹50,000');
    expect(screen.getByTestId('config-loanLimit-plus').props.accessibilityState.disabled).toBe(true);
    // The review and the board card follow every change.
    expect(screen.getByTestId('game-review')).toHaveTextContent(/Starting cash\s*₹10,000/);
    expect(screen.getByTestId('game-review')).toHaveTextContent(/Maximum outstanding loans\s*₹50,000/);
    expect(screen.getByTestId('game-option-business')).toHaveTextContent(/start with ₹10,000/);
  });

  it('Intermediate adds the market and objectives, Balanced and on by default', async () => {
    await render(<CreateGame />);
    await press('game-mode-intermediate');
    expect(screen.getByTestId('config-volatility-balanced').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('config-objectives-on').props.accessibilityState.selected).toBe(true);
    const review = screen.getByTestId('game-review');
    expect(review).toHaveTextContent(/Mode\s*Intermediate/);
    expect(review).toHaveTextContent(/Market volatility\s*Balanced/);
    expect(review).toHaveTextContent(/Secret objectives\s*Enabled/);
    await press('config-volatility-volatile');
    await press('config-objectives-off');
    expect(screen.getByTestId('config-volatility-hint')).toHaveTextContent(/Big swings/);
    expect(review).toHaveTextContent(/Market volatility\s*Volatile/);
    expect(review).toHaveTextContent(/Secret objectives\s*Disabled/);
  });

  it('Restore defaults puts every setting back', async () => {
    await render(<CreateGame />);
    await press('game-mode-intermediate');
    await press('config-startingCash-plus', 2);
    await press('config-loanLimit-minus');
    await press('config-volatility-stable');
    await press('config-objectives-off');
    await press('config-restore-defaults');
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹25,000');
    expect(screen.getByTestId('config-loanLimit-value')).toHaveTextContent('₹20,000');
    expect(screen.getByTestId('config-volatility-balanced').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('config-objectives-on').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('config-restore-defaults').props.accessibilityState.disabled).toBe(true);
  });

  it('switching mode keeps the money settings and never carries Intermediate settings into Classic', async () => {
    await render(<CreateGame />);
    await press('config-startingCash-plus');
    await press('game-mode-intermediate');
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹30,000');
    await press('config-volatility-volatile');
    await press('game-mode-classic');
    expect(screen.getByTestId('config-startingCash-value')).toHaveTextContent('₹30,000');
    expect(screen.queryByTestId('config-volatility')).toBeNull();
    await press('game-mode-intermediate');
    expect(screen.getByTestId('config-volatility-balanced').props.accessibilityState.selected).toBe(true);
  });

  it('untouched settings send the request the app has always sent', async () => {
    const f = new Fixture(['Tanmay'], { start: false });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    // Changed and changed back: still the defaults.
    await press('config-startingCash-plus');
    await press('config-startingCash-minus');
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]).toEqual([expect.any(String), expect.any(String), 'Tanmay']);
  });

  it('a customised Classic game sends its settings with the request', async () => {
    const f = new Fixture(['Tanmay'], { start: false, config: { startingCash: 30000, loanLimit: 10000 } });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await press('config-startingCash-plus');
    await press('config-loanLimit-minus', 2);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${f.state.id}`));
    expect(api.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Tanmay', 'classic', {
      startingCash: 30000,
      loanLimit: 10000,
      marketVolatility: 'balanced',
      secretObjectives: false,
    });
  });

  it('a customised Intermediate game sends its mode and settings', async () => {
    const config = { startingCash: 25000, loanLimit: 20000, marketVolatility: 'stable', secretObjectives: false } as const;
    const f = new Fixture(['Tanmay'], { start: false, mode: 'intermediate', config });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await press('game-mode-intermediate');
    await press('config-volatility-stable');
    await press('config-objectives-off');
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Tanmay', 'intermediate', config);
  });

  it('shows the server’s reason when it refuses the settings', async () => {
    api.create.mockResolvedValue({ ok: false, error: { code: 'VALIDATION', message: 'Starting cash can be at most ₹50,000.' } });
    await render(<CreateGame />);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(screen.getByText('Starting cash can be at most ₹50,000.')).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('Lobby: the rules every player will play by', () => {
  const config = { startingCash: 30000, loanLimit: 25000, marketVolatility: 'balanced', secretObjectives: true } as const;

  it.each(['Asha', 'Bilal'])('%s sees the same mode and settings', async (name) => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, mode: 'intermediate', config }).loadAs(name);
    await render(<LobbyView view={viewFor(f, name)} />);
    const rules = screen.getByTestId('lobby-rules');
    expect(rules).toHaveTextContent(/Mode\s*Intermediate/);
    expect(rules).toHaveTextContent(/Starting cash\s*₹30,000/);
    expect(rules).toHaveTextContent(/Maximum outstanding loans\s*₹25,000/);
    expect(rules).toHaveTextContent(/Market volatility\s*Balanced/);
    expect(rules).toHaveTextContent(/Secret objectives\s*Enabled/);
    expect(screen.getByText(/Everyone starts with ₹30,000\./)).toBeTruthy();
  });

  it('a Classic lobby lists only the Classic settings', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Bilal');
    await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    const rules = screen.getByTestId('lobby-rules');
    expect(rules).toHaveTextContent(/Mode\s*Classic/);
    expect(rules).toHaveTextContent(/Starting cash\s*₹25,000/);
    expect(rules).not.toHaveTextContent(/Market volatility|Secret objectives/);
  });

  it('only the host can change them', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Bilal');
    await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('lobby-edit-config')).toBeNull();
    expect(screen.getByTestId('lobby-rules')).toHaveTextContent(/Set by the host/);
  });

  it('the host edits in a sheet and saves through the server', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, mode: 'intermediate' }).loadAs('Asha');
    const saved = new Fixture(['Asha', 'Bilal'], { start: false, mode: 'intermediate' });
    api.action.mockResolvedValue(ok({ ...saved.snapshot(), state: { ...f.state, version: f.state.version + 1 } }));
    await render(<LobbyView view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('lobby-edit-config'));
    const sheet = within(screen.getByTestId('lobby-config-sheet'));
    await fireEvent.press(sheet.getByTestId('config-startingCash-plus'));
    await fireEvent.press(sheet.getByTestId('config-volatility-volatile'));
    // Nothing is sent, and the lobby still shows the server's values, until Save.
    expect(api.action).not.toHaveBeenCalled();
    expect(screen.getByTestId('lobby-rules')).toHaveTextContent(/Starting cash\s*₹25,000/);
    await fireEvent.press(screen.getByTestId('lobby-save-config'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({
      type: 'UPDATE_CONFIG',
      config: { startingCash: 30000, loanLimit: 20000, marketVolatility: 'volatile', secretObjectives: true },
    });
  });

  it('a refused change stays in the sheet with the server’s reason', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'INVALID_PHASE', message: 'The game has started — its settings are locked.' } });
    await render(<LobbyView view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('lobby-edit-config'));
    await fireEvent.press(screen.getByTestId('lobby-save-config'));
    await waitFor(() => expect(screen.getByTestId('lobby-config-error')).toHaveTextContent('The game has started — its settings are locked.'));
    expect(screen.getByTestId('lobby-config-sheet')).toBeTruthy();
  });
});

describe('In the game: settings are shown, locked', () => {
  it('More → Game settings shows every player the same locked rules', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { config: { startingCash: 40000, loanLimit: 10000 } });
    for (const name of ['Asha', 'Bilal']) {
      const view = await renderGame(f, name);
      await fireEvent.press(screen.getByTestId('open-more'));
      await fireEvent.press(screen.getByTestId('open-config'));
      const summary = screen.getByTestId('config-summary');
      expect(summary).toHaveTextContent(/Mode\s*Classic/);
      expect(summary).toHaveTextContent(/Starting cash\s*₹40,000/);
      expect(summary).toHaveTextContent(/Maximum outstanding loans\s*₹10,000/);
      expect(summary).toHaveTextContent(/Locked when the game started/);
      // Read-only: there is nothing to edit here.
      expect(screen.queryByTestId('config-editor')).toBeNull();
      await view.unmount();
    }
  });

  it('the Classic loan sheet lends up to the game’s limit', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { config: { loanLimit: 5000 } }).loadAs('Asha');
    await render(<LoanSheet visible onClose={() => undefined} view={viewFor(f, 'Asha')} send={jest.fn()} />);
    await fireEvent.changeText(screen.getByTestId('loan-amount'), '6000');
    expect(screen.getByText('You can borrow up to ₹5,000')).toBeTruthy();
    expect(screen.getByTestId('loan-confirm').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('loan-amount'), '5000');
    expect(screen.getByTestId('loan-confirm').props.accessibilityState.disabled).toBe(false);
  });

  it('the rulebook quotes this game’s settings', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate', config: { startingCash: 40000, loanLimit: 30000, marketVolatility: 'stable' } });
    loadAs(f, 'Bilal');
    await render(<Settings />);
    expect(screen.getByText('Everyone starts with ₹40,000.')).toBeTruthy();
    expect(screen.getByText(/at most ₹30,000 owed in total/)).toBeTruthy();
    expect(screen.getByText(/This game's market is Stable\./)).toBeTruthy();
    expect(screen.getByText(/Property Mogul \(₹8,000 bonus\)/)).toBeTruthy();
  });
});

describe('Secret objective: a private entry point', () => {
  it('a Classic game has no objective anywhere', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.queryByTestId('open-objective')).toBeNull();
    expect(screen.getByTestId('open-config')).toBeTruthy();
  });

  it('none when the host turned objectives off', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate', config: { secretObjectives: false } });
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.queryByTestId('open-objective')).toBeNull();
  });

  it('each player opens their own from More, and it is not on the table itself', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'PROPERTY_MOGUL' });
    await renderGame(f, 'Asha');
    // Nothing on the shared table names an objective.
    for (const id of OBJECTIVE_IDS) expect(screen.queryByText(new RegExp(OBJECTIVES[id].name))).toBeNull();
    await fireEvent.press(screen.getByTestId('open-more'));
    // The entry itself gives nothing away.
    expect(screen.getByTestId('open-objective')).toHaveTextContent(/My secret objective/);
    expect(screen.getByTestId('open-objective')).not.toHaveTextContent(/Cash Guardian/);
    await fireEvent.press(screen.getByTestId('open-objective'));
    expect(screen.getByTestId('my-objective-name')).toHaveTextContent('Cash Guardian');
    expect(screen.getByTestId('my-objective')).toHaveTextContent(/₹4,000 bonus/);
    expect(screen.getByTestId('my-objective-description')).toHaveTextContent(/hold at least ₹12,000 in cash/);
    expect(screen.getByTestId('my-objective-progress')).toHaveTextContent('₹25,000 cash (needs ₹12,000)');
    expect(screen.getByTestId('my-objective')).toHaveTextContent(/Only you can see this/);
    expect(screen.queryByText(/Property Mogul/)).toBeNull();
  });

  it('the other player’s phone holds — and shows — only their own', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'PROPERTY_MOGUL' });
    await renderGame(f, 'Bilal');
    const held = useGameStore.getState().snapshot!.state.objectives!.assignments;
    expect(held).toEqual({ [f.ids.Bilal!]: 'PROPERTY_MOGUL' });
    expect(JSON.stringify(useGameStore.getState().snapshot)).not.toContain('CASH_GUARDIAN');
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('open-objective'));
    expect(screen.getByTestId('my-objective-name')).toHaveTextContent('Property Mogul');
    expect(screen.queryByText(/Cash Guardian/)).toBeNull();
  });

  it('shows this game’s scaled numbers', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate', config: { startingCash: 50000 } });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER' });
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('open-objective'));
    expect(screen.getByTestId('my-objective')).toHaveTextContent(/₹8,000 bonus/);
    expect(screen.getByTestId('my-objective-description')).toHaveTextContent(/at least ₹24,000 in cash/);
  });

  it('opening another player’s details never shows their objective', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'PROPERTY_MOGUL' });
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Bilal}`));
    expect(screen.getByTestId('sheet-player')).toBeTruthy();
    for (const id of OBJECTIVE_IDS) expect(screen.queryByText(new RegExp(OBJECTIVES[id].name))).toBeNull();
  });
});

describe('End of the game: the reveal', () => {
  it('shows every player’s objective, the outcome, the bonus and why', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'DEAL_MAKER' });
    f.act('Asha', { type: 'END_GAME' });
    loadAs(f, 'Bilal');
    await render(<FinishedView view={viewFor(f, 'Bilal')} />);
    const asha = screen.getByTestId(`objective-result-${f.ids.Asha}`);
    expect(asha).toHaveTextContent(/Asha · Cash Guardian/);
    expect(asha).toHaveTextContent(/Completed/);
    expect(asha).toHaveTextContent(/Bonus: \+₹4,000/);
    expect(asha).toHaveTextContent(/Finished with ₹25,000 cash \(needs ₹12,000\)\./);
    const bilal = screen.getByTestId(`objective-result-${f.ids.Bilal}`);
    expect(bilal).toHaveTextContent(/Bilal · Deal Maker/);
    expect(bilal).toHaveTextContent(/Not completed/);
    expect(bilal).not.toHaveTextContent(/Bonus/);
    // The standings above already include the bonus, and the winner matches them.
    expect(screen.getByTestId('finished-card')).toHaveTextContent(/Asha wins!/);
    expect(screen.getByTestId('finished-card')).toHaveTextContent(/1\. Asha\s*₹29,000/);
    expect(screen.getByTestId('finished-card')).toHaveTextContent(/2\. Bilal\s*₹25,000/);
  });

  it('the bonus appears in the winner’s history as its own entry', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' });
    assign(f, { Asha: 'CASH_GUARDIAN', Bilal: 'DEAL_MAKER' });
    f.act('Asha', { type: 'END_GAME' });
    const bonus = f.transactions.filter((t) => t.type === 'OBJECTIVE_REWARD');
    expect(bonus).toMatchObject([{ toPlayerId: f.ids.Asha, fromPlayerId: null, amount: 4000, memo: 'Secret objective bonus: Cash Guardian' }]);
  });

  it.each([
    ['a Classic game', {}],
    ['an Intermediate game with objectives off', { mode: 'intermediate' as const, config: { secretObjectives: false } }],
  ])('%s shows no objectives panel at all', async (_label, options) => {
    const f = new Fixture(['Asha', 'Bilal'], options);
    f.act('Asha', { type: 'END_GAME' });
    loadAs(f, 'Asha');
    await render(<FinishedView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('finished-card')).toBeTruthy();
    expect(screen.queryByTestId('objective-results')).toBeNull();
    expect(screen.queryByText(/Secret objectives/)).toBeNull();
  });
});
