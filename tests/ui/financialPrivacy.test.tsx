/// <reference types="jest" />
/** Open / Hidden finances on the phone: choosing it, reading it back, and what a player is shown of the others. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { netWorth, premiumForYear, redactFinances, redactObjectives, totalDebt, type GameMode, type GameSnapshot } from '@/engine/index.ts';
import { INTRO_SEEN_KEY } from '@/features/finance/IntermediateIntro';
import { GameScreen } from '@/features/game/GameScreen';
import { pickContext, turnStatus } from '@/features/game/gameFocus';
import type { GameView } from '@/features/game/useGameView';
import { InsuranceView } from '@/features/insurance/InsuranceView';
import { PropertyInsurance } from '@/features/insurance/PropertyInsurance';
import { LobbyView } from '@/features/lobby/LobbyView';
import { PlayerView } from '@/features/player/PlayerView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { formatINR } from '@/utils/currency';
import CreateGame from '../../app/create-game';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const HIDDEN = { financialPrivacy: 'hidden' } as const;

/** The snapshot exactly as the server sends it to `name` (db.loadSnapshot): objectives, then finances, cut to their view. */
function snapshotFor(f: Fixture, name: string): GameSnapshot {
  const snapshot = f.snapshot();
  return redactFinances({ ...snapshot, state: redactObjectives(snapshot.state, f.ids[name]!) }, f.ids[name]!);
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

/** Puts `name`'s own snapshot in the stores, as their phone holds it. */
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

/** Asha bought the Railway and took a ₹2,000 loan; it is still her turn. */
function played(mode: GameMode = 'classic', privacy: 'open' | 'hidden' = 'hidden') {
  const f = new Fixture(['Asha', 'Bilal'], { mode, config: { financialPrivacy: privacy, ...(mode === 'intermediate' ? { secretObjectives: false } : {}) } });
  f.roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' });
  if (mode === 'classic') f.act('Asha', { type: 'REQUEST_LOAN', amount: 2000 });
  return f;
}

beforeEach(async () => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  await SecureStore.setItemAsync(INTRO_SEEN_KEY, '1');
});

// ---------------------------------------------------------------------------

describe('Create game: financial privacy', () => {
  it('offers Open and Hidden finances, with Open selected', async () => {
    await render(<CreateGame />);
    expect(screen.getByTestId('config-privacy-open').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('config-privacy-hidden').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('config-privacy-hint')).toHaveTextContent(/Everyone can view every player’s financial information/);
    expect(screen.getByTestId('game-review')).toHaveTextContent(/Finances\s*Open/);
  });

  it.each(['classic', 'intermediate'] as const)('a %s game created with Hidden finances sends that choice to the server', async (mode) => {
    const f = new Fixture(['Tanmay'], { start: false, mode, config: HIDDEN });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await fireEvent.press(screen.getByTestId('config-privacy-hidden'));
    expect(screen.getByTestId('config-privacy-hint')).toHaveTextContent(/Each player sees their own finances/);
    // Choosing the mode afterwards keeps the choice.
    await fireEvent.press(screen.getByTestId(`game-mode-${mode}`));
    expect(screen.getByTestId('config-privacy-hidden').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('game-review')).toHaveTextContent(/Finances\s*Hidden/);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${f.state.id}`));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0]![3]).toBe(mode);
    expect(api.create.mock.calls[0]![4]).toMatchObject({ financialPrivacy: 'hidden' });
  });

  it('Restore defaults puts it back to Open', async () => {
    await render(<CreateGame />);
    await fireEvent.press(screen.getByTestId('config-privacy-hidden'));
    expect(screen.getByTestId('config-restore-defaults').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('config-restore-defaults'));
    expect(screen.getByTestId('config-privacy-open').props.accessibilityState.selected).toBe(true);
  });
});

describe('Lobby: the setting is the game’s, read from the server', () => {
  it('everyone reads it; a joiner cannot change anything', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, config: HIDDEN });
    loadAs(f, 'Bilal');
    await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('lobby-rules')).toHaveTextContent(/Finances\s*Hidden/);
    expect(screen.queryByTestId('lobby-edit-config')).toBeNull();
  });

  it('the host can still edit the other settings, but is not offered this one; saving keeps it', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, config: HIDDEN });
    loadAs(f, 'Asha');
    api.action.mockResolvedValue(ok({ ...f.snapshot(), state: { ...f.state, version: f.state.version + 1 } }));
    await render(<LobbyView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('lobby-rules')).toHaveTextContent(/Finances\s*Hidden/);
    await fireEvent.press(screen.getByTestId('lobby-edit-config'));
    expect(screen.queryByTestId('config-privacy')).toBeNull();
    // With nothing else changed there is nothing to restore - hidden finances is not a "changed setting" here.
    expect(screen.getByTestId('config-restore-defaults').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('config-startingCash-plus'));
    await fireEvent.press(screen.getByTestId('config-restore-defaults'));
    await fireEvent.press(screen.getByTestId('config-loanLimit-minus'));
    await fireEvent.press(screen.getByTestId('lobby-save-config'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({
      type: 'UPDATE_CONFIG',
      config: { startingCash: 25000, loanLimit: 15000, marketVolatility: 'balanced', secretObjectives: false, financialPrivacy: 'hidden' },
    });
  });

  it('a game restored from the server keeps what the host chose', async () => {
    const f = played();
    // What the phone gets when it reconnects: the server's snapshot, which carries the setting.
    loadAs(f, 'Bilal');
    expect(useGameStore.getState().snapshot!.state.config.financialPrivacy).toBe('hidden');
  });
});

describe('The table, with hidden finances', () => {
  it('my chip shows my cash; another player’s says Private, in the same place', async () => {
    const f = played();
    await renderGame(f, 'Bilal');
    const mine = screen.getByTestId(`player-chip-${f.ids.Bilal}`);
    const theirs = screen.getByTestId(`player-chip-${f.ids.Asha}`);
    expect(mine).toHaveTextContent(/₹25,000/);
    expect(theirs).toHaveTextContent(/Private/);
    expect(theirs).not.toHaveTextContent(/₹/);
    expect(theirs.props.accessibilityLabel).toMatch(/cash private/);
    expect(mine.props.accessibilityLabel).toMatch(/₹25,000/);
  });

  it('another player’s details: position and properties, no cash, net worth, loans or wallet', async () => {
    const f = played();
    await renderGame(f, 'Bilal');
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Asha}`));
    expect(screen.getByTestId('player-details-header')).toHaveTextContent(/Asha/);
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent('Private');
    expect(screen.getByTestId('player-details-location')).toBeTruthy();
    expect(screen.queryByTestId('player-details-net-worth')).toBeNull();
    expect(screen.queryByTestId('player-details-loans')).toBeNull();
    expect(screen.queryByTestId('player-open-wallet')).toBeNull();
    expect(screen.getByTestId('player-details-private')).toHaveTextContent(/hidden finances/);
    // What she owns is still there to inspect, and I can still deal with her.
    const owned = screen.getByTestId('player-details-properties');
    expect(within(owned).getByTestId('property-count')).toHaveTextContent('1');
    expect(within(owned).getByTestId('property-RAILWAY')).toBeTruthy();
    expect(screen.getByTestId('player-make-offer').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('player-pay-money').props.accessibilityState.disabled).toBe(false);
  });

  it('my own details are complete', async () => {
    const f = played();
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Asha}`));
    const cash = f.state.players.find((p) => p.name === 'Asha')!.balance;
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent(formatINR(cash));
    expect(screen.getByTestId('player-details-net-worth')).toHaveTextContent(formatINR(netWorth(f.state, f.ids.Asha!)), { exact: false });
    expect(screen.getByTestId('player-details-loans')).toHaveTextContent('₹2,000', { exact: false });
    expect(screen.getByTestId('player-open-wallet')).toBeTruthy();
    expect(screen.queryByTestId('player-details-private')).toBeNull();
  });

  it('rent owed is public, to everyone at the table; a tax bill is the payer’s alone', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra'], { config: HIDDEN });
    f.state.properties.RAILWAY.ownerId = f.ids.Bilal!;
    f.roll('Asha', 1, 2);
    expect(f.state.turn.phase).toBe('AWAITING_PAYMENT');
    expect(turnStatus(viewFor(f, 'Chitra')).detail).toMatch(/Asha owes ₹[\d,]+ \(Rent for Railway\)$/);
    expect(pickContext(viewFor(f, 'Bilal'))).toMatchObject({ label: 'Payment due to you' });
    expect(pickContext(viewFor(f, 'Bilal')).title).toMatch(/Asha owes you ₹/);

    // Income Tax (5 squares from Start), owning a property so that something is due.
    const t = new Fixture(['Asha', 'Bilal', 'Chitra'], { config: HIDDEN });
    t.state.properties.MUMBAI.ownerId = t.ids.Asha!;
    t.roll('Asha', 2, 3);
    expect(t.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'TAX' });
    const chitra = viewFor(t, 'Chitra');
    expect(turnStatus(chitra).detail).toMatch(/Asha is paying$/);
    expect(turnStatus(chitra).detail).not.toMatch(/₹/);
    expect(JSON.stringify(pickContext(chitra))).not.toMatch(/owes/);
    expect(turnStatus(viewFor(t, 'Asha')).primary).toMatchObject({ kind: 'pay' });
  });
});

describe('Wallet screen', () => {
  it('another player’s wallet shows their properties and says the rest is private', async () => {
    const f = played();
    loadAs(f, 'Bilal');
    await render(<PlayerView view={viewFor(f, 'Bilal')} playerId={f.ids.Asha!} />);
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Private');
    expect(screen.getByTestId('property-RAILWAY')).toBeTruthy();
    expect(screen.getByTestId('wallet-private')).toHaveTextContent(/Asha’s cash, loans and history are private/);
    expect(screen.queryByText(/Net worth|Loans owed|Credit score/i)).toBeNull();
    expect(screen.queryByText(/Borrowed/)).toBeNull();
    expect(screen.queryByText('History')).toBeNull();
    expect(screen.queryByText(/₹2,000|₹17,500/)).toBeNull();
  });

  it('my own wallet is complete: balance, loans and history', async () => {
    const f = played();
    loadAs(f, 'Asha');
    await render(<PlayerView view={viewFor(f, 'Asha')} playerId={f.ids.Asha!} />);
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('₹17,500');
    expect(screen.getByText('Borrowed ₹2,000')).toBeTruthy();
    expect(screen.getByText('Starting cash')).toBeTruthy();
    expect(screen.queryByTestId('wallet-private')).toBeNull();
  });

  it('Capital: another player’s credit score is not shown either', async () => {
    const f = played('intermediate');
    loadAs(f, 'Bilal');
    await render(<PlayerView view={viewFor(f, 'Bilal')} playerId={f.ids.Asha!} />);
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('Private');
    expect(screen.queryByText(/Credit score/)).toBeNull();
    expect(screen.getByTestId('wallet-private')).toBeTruthy();
  });
});

describe('Insurance, with hidden finances (Capital)', () => {
  function insured() {
    const f = played('intermediate');
    f.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'RAILWAY', expectedPremium: premiumForYear(f.state.intermediate!.year) });
    return f;
  }

  it('whether another player’s property is insured is not shown on the property', async () => {
    const f = insured();
    loadAs(f, 'Bilal');
    expect(snapshotFor(f, 'Bilal').state.intermediate!.insurance!.policies).toEqual([]);
    await render(<PropertyInsurance view={viewFor(f, 'Bilal')} propertyKey="RAILWAY" />);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Private');
    expect(screen.queryByText(/^Insured$|^Not insured$/)).toBeNull();
  });

  it('the insurance screen lists nobody else’s cover, and still lists the crises', async () => {
    const f = insured();
    loadAs(f, 'Bilal');
    await render(<InsuranceView view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('insurance-others')).toBeNull();
    expect(screen.getByTestId('insurance-crises')).toBeTruthy();
  });

  it('my own policy is shown to me in full', async () => {
    const f = insured();
    loadAs(f, 'Asha');
    await render(<PropertyInsurance view={viewFor(f, 'Asha')} propertyKey="RAILWAY" />);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured');
    expect(screen.getByTestId('insurance-policy-state')).toHaveTextContent(/Active/);
  });

  it('with open finances the table still sees who is insured', async () => {
    const f = played('intermediate', 'open');
    f.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'RAILWAY', expectedPremium: premiumForYear(f.state.intermediate!.year) });
    loadAs(f, 'Bilal');
    await render(<InsuranceView view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('insurance-other-RAILWAY')).toHaveTextContent(/Insured/);
  });
});

describe('Open finances: as it has always been', () => {
  it.each(['classic', 'intermediate'] as const)('%s: everyone’s cash, net worth and wallet are shown', async (mode) => {
    const f = played(mode, 'open');
    // Nothing is cut from the snapshot.
    expect(snapshotFor(f, 'Bilal').state.players).toEqual(f.state.players);
    expect(snapshotFor(f, 'Bilal').events).toEqual(f.events);
    expect(snapshotFor(f, 'Bilal').transactions).toEqual(f.transactions);
    await renderGame(f, 'Bilal');
    const cash = f.state.players.find((p) => p.name === 'Asha')!.balance;
    expect(screen.getByTestId(`player-chip-${f.ids.Asha}`)).toHaveTextContent(formatINR(cash), { exact: false });
    await fireEvent.press(screen.getByTestId(`player-chip-${f.ids.Asha}`));
    expect(screen.getByTestId('player-details-balance')).toHaveTextContent(formatINR(cash));
    expect(screen.getByTestId('player-details-net-worth')).toBeTruthy();
    expect(screen.getByTestId('player-details-loans')).toBeTruthy();
    expect(screen.getByTestId('player-open-wallet')).toBeTruthy();
    expect(screen.queryByTestId('player-details-private')).toBeNull();
  });
});
