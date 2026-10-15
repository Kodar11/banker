/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  BOARD_SIZE,
  buildSchedule,
  crisisCheckpointClock,
  gameClock,
  INTERMEDIATE_RULES,
  netWorth,
  positionOfProperty,
  totalDebt,
  type IntermediateState,
  type PropertyKey,
} from '@/engine/index.ts';
import { FinanceHub } from '@/features/finance/FinanceHub';
import { INTRO_SEEN_KEY } from '@/features/finance/IntermediateIntro';
import { OBJECTIVE_SEEN_KEY, objectiveSeenValue } from '@/features/objectives/ObjectiveReveal';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { PlayerView } from '@/features/player/PlayerView';
import { PropertyView } from '@/features/player/PropertyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import CreateGame from '../../app/create-game';
import Settings from '../../app/settings';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
/** Two starting players: one financial year = 72 spaces on the shared clock. */
const YEAR = 72;

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
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

const intermediate = (names = ['Asha', 'Bilal']) => new Fixture(names, { mode: 'intermediate' });
const eco = (f: Fixture): IntermediateState => f.state.intermediate!;
const currentName = (f: Fixture) => Object.keys(f.ids).find((n) => f.ids[n] === f.state.turn.playerId)!;

/** Moves the shared clock to `target` with one roll of 2 that lands on Start (test surgery on the stored movement). */
function jumpTo(f: Fixture, target: number): Fixture {
  const movement = eco(f).movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = target - 2;
  // The teleport is about loan dates and years. The crisis schedule moves along with it, so the checkpoints
  // it jumps over do not all fire on this one roll (crises have their own tests in insurance.test.tsx).
  const ins = eco(f).insurance!;
  while (crisisCheckpointClock(eco(f), ins.nextCheckpoint) <= target) ins.nextCheckpoint += 1;
  const name = currentName(f);
  f.state.players.find((p) => p.id === f.ids[name])!.position = BOARD_SIZE - 2;
  f.roll(name, 1, 1).act(name, { type: 'END_TURN' });
  expect(gameClock(eco(f))).toBe(target);
  return f;
}

function give(f: Fixture, name: string, key: PropertyKey) {
  f.state.properties[key] = { ...f.state.properties[key], ownerId: f.ids[name]! };
}

const borrowPersonal = (f: Fixture, amount = 15000) => f.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount, expectedRatePercent: 12 });

async function introSeen(seen: boolean) {
  if (seen) await SecureStore.setItemAsync(INTRO_SEEN_KEY, '1');
  else await SecureStore.deleteItemAsync(INTRO_SEEN_KEY);
}

async function renderGame(f: Fixture, name: string) {
  f.loadAs(name);
  // These players have already read their secret objective (its reveal is covered in customization.test.tsx).
  if (f.state.objectives) await SecureStore.setItemAsync(OBJECTIVE_SEEN_KEY, objectiveSeenValue(f.state.id, f.ids[name]!));
  const view = await render(<GameScreen view={viewFor(f, name)} />);
  await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  await introSeen(true);
});

// ---------------------------------------------------------------------------

describe('Create game: mode', () => {
  it('offers Classic and Capital, with Classic selected', async () => {
    await render(<CreateGame />);
    expect(screen.getByTestId('game-mode-classic').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('game-mode-intermediate').props.accessibilityState.selected).toBe(false);
    expect(within(screen.getByTestId('game-mode-classic')).getByText('Classic Mode')).toBeTruthy();
    expect(within(screen.getByTestId('game-mode-intermediate')).getByText(/Inflation, loans and credit scores/)).toBeTruthy();
  });

  it('a Classic game is created with the request Classic always sent', async () => {
    const f = new Fixture(['Tanmay'], { start: false });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]).toHaveLength(3);
  });

  it('choosing Capital creates a Capital game', async () => {
    const f = new Fixture(['Tanmay'], { start: false, mode: 'intermediate' });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await fireEvent.press(screen.getByTestId('game-mode-intermediate'));
    expect(screen.getByTestId('game-mode-intermediate').props.accessibilityState.selected).toBe(true);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${f.state.id}`));
    expect(api.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Tanmay', 'intermediate');
  });

  it('the lobby tells every player which mode the host picked', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, mode: 'intermediate' }).loadAs('Bilal');
    const lobby = await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('lobby-title')).toHaveTextContent(/^Clash of Capitals/);
    expect(screen.getByTestId('lobby-mode')).toHaveTextContent('Capital Mode');
    await lobby.unmount();
    const c = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Bilal');
    await render(<LobbyView view={viewFor(c, 'Bilal')} />);
    expect(screen.getByTestId('lobby-title')).toHaveTextContent(/^Clash of Capitals/);
    expect(screen.getByTestId('lobby-mode')).toHaveTextContent('Classic Mode');
  });
});

describe('Classic games show nothing of Capital Mode', () => {
  it('no year indicator, no introduction, no notices; Bank / Loan is the Classic loan sheet', async () => {
    await introSeen(false);
    const f = new Fixture();
    await renderGame(f, 'Asha');
    await act(async () => {});
    // Classic counts years only to know when the game is over: a plain readout, none of Capital's.
    expect(screen.getByTestId('duration-indicator')).toHaveTextContent('Classic · Year 1 of 5');
    for (const id of ['year-indicator', 'intermediate-intro', 'year-notice', 'payment-reminder', 'finance-hub']) expect(screen.queryByTestId(id)).toBeNull();
    expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith(INTRO_SEEN_KEY);
    await fireEvent.press(screen.getByTestId('open-loan'));
    expect(screen.getByTestId('loan-sheet')).toBeTruthy();
    expect(screen.queryByTestId('finance-tabs')).toBeNull();
    expect(screen.getByText(/10% interest is charged once/)).toBeTruthy();
  });

  it('the deed shows the printed price and no valuation block', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('property-price')).toHaveTextContent('₹8,500');
    expect(screen.getByText('Price')).toBeTruthy();
    expect(screen.queryByTestId('property-valuation')).toBeNull();
  });
});

describe('Capital: the game table', () => {
  it('shows a compact Year indicator and keeps the board and all six actions', async () => {
    const f = intermediate();
    await renderGame(f, 'Asha');
    expect(screen.getByTestId('year-indicator')).toHaveTextContent('Capital · Year 1 of 5');
    expect(screen.getByTestId('classic-board')).toBeTruthy();
    for (const id of ['open-properties', 'open-trade', 'open-chat', 'open-loan', 'open-auction', 'open-more']) expect(screen.getByTestId(id)).toBeTruthy();
  });

  it('the year indicator follows the server’s year', async () => {
    const f = jumpTo(intermediate(), YEAR * 2 + 4);
    await renderGame(f, 'Asha');
    expect(screen.getByTestId('year-indicator')).toHaveTextContent('Capital · Year 3 of 5');
  });

  it('board tiles and the buy decision use the current market price', async () => {
    const f = intermediate();
    eco(f).market.MUMBAI.value = 10200;
    f.state.players.find((p) => p.id === f.ids.Asha)!.position = positionOfProperty('MUMBAI') - 5 + BOARD_SIZE;
    f.roll('Asha', 2, 3);
    await renderGame(f, 'Asha');
    expect(screen.getByTestId('board-price-MUMBAI')).toHaveTextContent('₹10,200');
    expect(screen.getByTestId('context-title')).toHaveTextContent('Mumbai · ₹10,200');
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('buy-button')).toHaveTextContent(/BUY ₹10,200/);
    expect(screen.getByText(/Market price ₹10,200/)).toBeTruthy();
  });
});

describe('Capital: introduction', () => {
  it('appears once on a first Capital game, can be stepped through, and is remembered', async () => {
    await introSeen(false);
    const f = intermediate();
    const first = await renderGame(f, 'Asha');
    await waitFor(() => expect(screen.getByTestId('intermediate-intro')).toBeTruthy());
    expect(within(screen.getByTestId('intro-slide-1')).getByText('Financial years')).toBeTruthy();
    for (const title of ['Property values change', 'Inflation', 'Five kinds of loan', 'Credit score']) {
      await fireEvent.press(screen.getByTestId('intro-next'));
      expect(screen.getByText(title)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('intro-next'));
    expect(screen.queryByTestId('intermediate-intro')).toBeNull();
    expect(await SecureStore.getItemAsync(INTRO_SEEN_KEY)).toBe('1');
    // The game underneath was never blocked.
    expect(screen.getByTestId('classic-board')).toBeTruthy();
    await first.unmount();
    await renderGame(f, 'Asha');
    await act(async () => {});
    expect(screen.queryByTestId('intermediate-intro')).toBeNull();
  });

  it('can be skipped immediately', async () => {
    await introSeen(false);
    await renderGame(intermediate(), 'Asha');
    await waitFor(() => expect(screen.getByTestId('intermediate-intro')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('intro-skip'));
    expect(screen.queryByTestId('intermediate-intro')).toBeNull();
    expect(await SecureStore.getItemAsync(INTRO_SEEN_KEY)).toBe('1');
  });

  it('closes by itself after about thirty seconds', async () => {
    await introSeen(false);
    await renderGame(intermediate(), 'Asha');
    await waitFor(() => expect(screen.getByTestId('intermediate-intro')).toBeTruthy());
    jest.useFakeTimers();
    try {
      // Re-arm the timer under fake timers by stepping, then let the full interval pass.
      await fireEvent.press(screen.getByTestId('intro-next'));
      await fireEvent.press(screen.getByTestId('intro-back'));
      await act(async () => {
        jest.advanceTimersByTime(INTERMEDIATE_RULES.notifications.introAutoCloseSeconds * 1000 + 50);
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(screen.queryByTestId('intermediate-intro')).toBeNull(), { timeout: 35000 });
  }, 40000);
});

describe('Capital: the bank', () => {
  it('Bank / Loan opens the four-section bank instead of the Classic loan sheet', async () => {
    const f = intermediate();
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-loan'));
    expect(screen.getByTestId('finance-hub')).toBeTruthy();
    expect(screen.queryByTestId('loan-sheet')).toBeNull();
    for (const tab of ['overview', 'loans', 'borrow', 'credit']) expect(screen.getByTestId(`finance-tab-${tab}`)).toBeTruthy();
    const overview = screen.getByTestId('finance-overview');
    expect(within(overview).getByTestId('overview-cash')).toHaveTextContent(/₹25,000/);
    expect(within(overview).getByTestId('overview-net-worth')).toHaveTextContent(/₹25,000/);
    expect(within(overview).getByTestId('overview-credit')).toHaveTextContent(/700 · Good/);
    expect(within(overview).getByTestId('overview-debt-ratio')).toHaveTextContent(/0%/);
    expect(within(overview).getByTestId('overview-next-payment')).toHaveTextContent(/Nothing to pay/);
  });

  it('Borrow lists five offers at my credit-adjusted rate and explains an unavailable one', async () => {
    const f = intermediate().loadAs('Asha');
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} initialTab="borrow" />);
    expect(screen.getByTestId('offer-rate-EMERGENCY')).toHaveTextContent('17%');
    expect(screen.getByTestId('offer-rate-PERSONAL')).toHaveTextContent('12%');
    expect(screen.getByTestId('offer-rate-SECURED')).toHaveTextContent('6%');
    expect(screen.getByTestId('offer-rate-LONG_TERM')).toHaveTextContent('10%');
    expect(screen.getByTestId('offer-rate-FLEXIBLE')).toHaveTextContent('8%');
    // Each offer shows its range, and what this player can borrow on it now.
    expect(screen.getByTestId('offer-range-SECURED')).toHaveTextContent(/₹10,000 – ₹50,000/);
    expect(screen.getByTestId('offer-max-PERSONAL')).toHaveTextContent(/₹20,000/);
    expect(screen.getByTestId('borrow-affordability')).toHaveTextContent(/Room left: ₹26,500 a year/);
    expect(screen.getByTestId('offer-blocked-SECURED')).toHaveTextContent(/not mortgaged, not already pledged/);
    expect(screen.queryByTestId('offer-choose-SECURED')).toBeNull();
    expect(within(screen.getByTestId('offer-FLEXIBLE')).getByText(/can move by up to 2 points either way/)).toBeTruthy();
  });

  it('a loan is only taken after the full contract is shown and explicitly accepted', async () => {
    const f = intermediate().loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true as const }));
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="borrow" />);
    await fireEvent.press(screen.getByTestId('offer-choose-PERSONAL'));
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '10000');
    expect(within(screen.getByTestId('borrow-estimate')).getByText('₹4,163')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('borrow-review'));
    expect(send).not.toHaveBeenCalled();

    const lines = buildSchedule(10000, 12, 3);
    const total = lines.reduce((s, l) => s + l.principal + l.interest, 0);
    expect(screen.getByTestId('contract-principal')).toHaveTextContent(/₹10,000/);
    expect(screen.getByTestId('contract-rate')).toHaveTextContent(/12% fixed/);
    expect(screen.getByTestId('contract-fees')).toHaveTextContent(/None/);
    const schedule = screen.getByTestId('contract-schedule');
    expect(within(schedule).getByText(/Payment 1 · start of Year 2/)).toBeTruthy();
    expect(within(schedule).getByText(/Payment 3 · start of Year 4/)).toBeTruthy();
    expect(within(schedule).getByText(`₹${lines[0]!.principal.toLocaleString('en-IN')} principal + ₹${lines[0]!.interest.toLocaleString('en-IN')} interest`)).toBeTruthy();
    expect(screen.getByTestId('contract-total')).toHaveTextContent(new RegExp(`₹${total.toLocaleString('en-IN')}`));
    const terms = screen.getByTestId('contract-terms');
    for (const part of [/Early repayment/, /no penalty/, /Grace period/, /1 full financial year/, /Default/, /not bankruptcy/, /End of the game/]) expect(within(terms).getByText(part)).toBeTruthy();
    expect(screen.getByText(/Unsecured: no property is pledged/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('borrow-accept'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 10000, expectedRatePercent: 12 }, expect.anything());
  });

  it('refuses an amount over the limit before anything is sent', async () => {
    const f = intermediate().loadAs('Asha');
    const send = jest.fn();
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="borrow" />);
    await fireEvent.press(screen.getByTestId('offer-choose-EMERGENCY'));
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '20500');
    expect(screen.getByText(/go up to ₹20,000/)).toBeTruthy();
    expect(screen.getByTestId('borrow-review').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '10250');
    expect(screen.getByText(/steps of ₹500/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '5000');
    expect(screen.getByText(/Minimum loan is ₹10,000/)).toBeTruthy();
  });

  it('a secured loan pools the pledged properties, names them, and says what is at risk', async () => {
    const f = intermediate();
    give(f, 'Asha', 'MUMBAI');
    give(f, 'Asha', 'DELHI');
    f.loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true as const }));
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="borrow" />);
    expect(screen.getByTestId('offer-collateral-SECURED')).toHaveTextContent(/₹14,500 → up to ₹11,500/);
    await fireEvent.press(screen.getByTestId('offer-choose-SECURED'));
    // Neither property is enough alone, so both start selected.
    expect(screen.getByTestId('collateral-MUMBAI').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('collateral-DELHI').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('borrow-pledged-value')).toHaveTextContent(/₹14,500/);
    expect(screen.getByTestId('borrow-pledged-limit')).toHaveTextContent(/₹11,500/);
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '10000');
    // Unpledging Delhi leaves too little: the screen says so before anything is sent.
    await fireEvent.press(screen.getByTestId('collateral-DELHI'));
    expect(screen.getByText(/can secure up to ₹6,500/)).toBeTruthy();
    expect(screen.getByTestId('borrow-review').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('collateral-DELHI'));
    await fireEvent.press(screen.getByTestId('borrow-review'));
    expect(screen.getByTestId('contract-collateral')).toHaveTextContent(/Mumbai, Delhi/);
    expect(screen.getByTestId('contract-collateral')).toHaveTextContent(/the bank takes all of them/);
    expect(screen.getByTestId('contract-collateral')).toHaveTextContent(/Nothing else you own is taken/);
    await fireEvent.press(screen.getByTestId('borrow-accept'));
    expect(send).toHaveBeenCalledWith({ type: 'TAKE_INTERMEDIATE_LOAN', product: 'SECURED', amount: 10000, expectedRatePercent: 6, collateralKeys: ['MUMBAI', 'DELHI'] }, expect.anything());
  });

  it('the variable-rate contract warns that payments can change', async () => {
    const f = intermediate().loadAs('Asha');
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} initialTab="borrow" />);
    await fireEvent.press(screen.getByTestId('offer-choose-FLEXIBLE'));
    await fireEvent.press(screen.getByTestId('borrow-review'));
    expect(screen.getByTestId('contract-variable')).toHaveTextContent(/can go up or down/);
    expect(screen.getByTestId('contract-rate')).toHaveTextContent(/8% variable/);
  });

  it('My Loans shows the contract, and Pay now settles a due installment', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR).loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true as const }));
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="loans" />);
    const loan = eco(f).loans[0]!;
    const first = loan.installments[0]!;
    const card = screen.getByTestId('loan-card-PERSONAL');
    expect(within(card).getByTestId('loan-rate')).toHaveTextContent(/12% fixed/);
    expect(within(card).getByTestId('loan-principal-remaining')).toHaveTextContent(/₹15,000/);
    expect(within(card).getByTestId('loan-maturity')).toHaveTextContent(/start of Year 4/);
    // A payment is due: it must be paid before the loan can be refinanced.
    expect(within(card).queryByTestId('loan-refinance')).toBeNull();
    const payable = within(card).getByTestId('loan-payable');
    expect(within(payable).getByText(/Payment due · installment 1/)).toBeTruthy();
    expect(within(payable).getByText(/Pay by Year 2 · 25% through/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('loan-pay-now'));
    expect(send).toHaveBeenCalledWith({ type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id }, expect.anything());
    // No early repayment while a payment is due.
    expect(screen.queryByTestId('loan-early')).toBeNull();
    await fireEvent.press(screen.getByTestId('loan-details-toggle'));
    expect(within(screen.getByTestId('loan-installment-1')).getByText('Due now')).toBeTruthy();
    expect(within(screen.getByTestId('loan-installment-2')).getByText('Scheduled')).toBeTruthy();
    expect(first.principal + first.interest).toBeGreaterThan(0);
  });

  it('early repayment quotes principal and accrued interest separately', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, 36).loadAs('Asha');
    const send = jest.fn(async () => ({ ok: true as const }));
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="loans" />);
    // The payoff today: principal plus half a year of interest at 12%.
    expect(screen.getByTestId('loan-accrued')).toHaveTextContent(/₹900$/);
    expect(screen.getByTestId('loan-payoff')).toHaveTextContent(/₹15,900$/);
    expect(screen.getByTestId('loan-early-all')).toHaveTextContent('Repay all ₹15,900');
    await fireEvent.changeText(screen.getByTestId('loan-early-amount'), '5000');
    const quote = screen.getByTestId('loan-early-quote');
    expect(within(quote).getByText('₹300')).toBeTruthy();
    expect(within(quote).getByText('₹5,300')).toBeTruthy();
    expect(within(quote).getByText('₹10,000')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('loan-early-part'));
    expect(send).toHaveBeenCalledWith({ type: 'PREPAY_INTERMEDIATE_LOAN', loanId: eco(f).loans[0]!.id, amount: 5000 }, expect.anything());
  });

  it('refinancing starts from the loan card, shows the payoff, and sends one action naming the old loan', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, 36).loadAs('Asha');
    const loanId = eco(f).loans[0]!.id;
    const send = jest.fn(async () => ({ ok: true as const }));
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} initialTab="loans" />);
    await fireEvent.press(screen.getByTestId('loan-refinance'));
    expect(screen.getByTestId('refinance-banner')).toHaveTextContent(/pays off ₹15,900/);
    // The old loan's principal is freed for the replacement: ₹20,000 is open again, not ₹5,000.
    expect(screen.getByTestId('offer-max-LONG_TERM')).toHaveTextContent(/₹20,000/);
    await fireEvent.press(screen.getByTestId('offer-choose-LONG_TERM'));
    await fireEvent.changeText(screen.getByTestId('borrow-amount'), '20000');
    await fireEvent.press(screen.getByTestId('borrow-review'));
    expect(screen.getByTestId('contract-refinance-payoff')).toHaveTextContent(/−₹15,900/);
    expect(screen.getByTestId('contract-refinance-cash')).toHaveTextContent(/Paid to you now.*₹4,100/);
    expect(screen.getByTestId('borrow-accept')).toHaveTextContent(/REFINANCE WITH ₹20,000/);
    await fireEvent.press(screen.getByTestId('borrow-accept'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'REFINANCE_INTERMEDIATE_LOAN', loanId, product: 'LONG_TERM', amount: 20000, expectedRatePercent: 10 }, expect.anything());
  });

  it('Credit explains the score, every change, and the debt ratio', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR + 18).loadAs('Asha');
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} initialTab="credit" />);
    expect(screen.getByTestId('credit-score')).toHaveTextContent(/680/);
    const history = screen.getByTestId('credit-history');
    expect(within(history).getAllByTestId('credit-event')).toHaveLength(1);
    expect(within(history).getByText('An installment became overdue')).toBeTruthy();
    expect(within(history).getByText(/Year 2 · Personal Loan · 700 → 680/)).toBeTruthy();
    expect(within(history).getByText('-20')).toBeTruthy();
    expect(screen.getByTestId('credit-debt-ratio')).toBeTruthy();
    expect(screen.getAllByText(/Overdue: ₹/).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('credit-bands')).getByText('650–699 · Fair')).toBeTruthy();
  });

  it('an overdue payment blocks every offer, with the reason', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR + 18).loadAs('Asha');
    await render(<FinanceHub visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={jest.fn()} initialTab="borrow" />);
    expect(screen.getByTestId('offer-blocked-PERSONAL')).toHaveTextContent(/overdue payment/);
    expect(screen.queryByTestId('offer-choose-PERSONAL')).toBeNull();
  });

  it('the wallet lists Capital contracts and the credit score', async () => {
    const f = borrowPersonal(intermediate()).loadAs('Asha');
    await render(<PlayerView view={viewFor(f, 'Asha')} playerId={f.ids.Asha!} />);
    expect(within(screen.getByTestId('wallet-contract')).getByText(/Personal Loan · ₹15,000/)).toBeTruthy();
    expect(screen.getByText('Credit score')).toBeTruthy();
    expect(screen.getByText('700')).toBeTruthy();
  });
});

describe('Capital: notices', () => {
  it('announces a new financial year to a connected player, once, without blocking the table', async () => {
    const f = intermediate();
    give(f, 'Asha', 'MUMBAI');
    const view = await renderGame(f, 'Asha');
    expect(screen.queryByTestId('year-notice')).toBeNull();
    jumpTo(f, YEAR).loadAs('Asha');
    await view.rerender(<GameScreen view={viewFor(f, 'Asha')} />);
    const notice = screen.getByTestId('year-notice');
    expect(within(notice).getByText('Year 2 begins')).toBeTruthy();
    expect(within(notice).getByTestId('year-notice-summary')).toHaveTextContent(/26 went up · 0 went down/);
    expect(within(notice).getByTestId('year-mover-MUMBAI')).toHaveTextContent(/Mumbai \(yours\)/);
    expect(within(notice).getByText(/rose 5% again/)).toBeTruthy();
    expect(screen.getByTestId('year-indicator')).toHaveTextContent('Capital · Year 2 of 5');
    await fireEvent.press(screen.getByTestId('year-notice-dismiss'));
    expect(screen.queryByTestId('year-notice')).toBeNull();
    // The same year arriving again (a refetch) is not announced twice.
    await view.rerender(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.queryByTestId('year-notice')).toBeNull();
  });

  it('a device that opens the game mid-year does not replay the last announcement', async () => {
    const f = jumpTo(intermediate(), YEAR + 6);
    await renderGame(f, 'Bilal');
    expect(screen.queryByTestId('year-notice')).toBeNull();
    expect(screen.getByTestId('year-indicator')).toHaveTextContent('Capital · Year 2 of 5');
  });

  it('reminds only the borrower of a due payment; Later hides it but the obligation stays on the table', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR + 4);
    const first = eco(f).loans[0]!.installments[0]!;
    const amount = `₹${(first.principal + first.interest).toLocaleString('en-IN')}`;

    const asha = await renderGame(f, 'Asha');
    const reminder = screen.getByTestId('payment-reminder');
    expect(within(reminder).getByTestId('reminder-amount')).toHaveTextContent(amount);
    expect(within(reminder).getByTestId('reminder-deadline')).toHaveTextContent(/Pay by Year 2 · 25% through/);
    expect(within(reminder).getByTestId('reminder-cash')).toHaveTextContent(/Your cash: ₹/);
    for (const id of ['reminder-pay', 'reminder-review', 'reminder-later']) expect(within(reminder).getByTestId(id)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('reminder-later'));
    expect(screen.queryByTestId('payment-reminder')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
    // Still due: the board's card keeps saying so, and leads to the bank.
    expect(screen.getByTestId('context-label')).toHaveTextContent(/Loan payment due/);
    expect(screen.getByTestId('context-title')).toHaveTextContent(`${amount} · Personal Loan`);
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('finance-loans')).toBeTruthy();
    expect(screen.getByTestId('loan-pay-now')).toBeTruthy();
    await asha.unmount();

    await renderGame(f, 'Bilal');
    expect(screen.queryByTestId('payment-reminder')).toBeNull();
    expect(screen.getByTestId('context-label')).not.toHaveTextContent(/Loan payment/);
  });

  it('Pay now on the reminder opens the payment', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR + 4);
    await renderGame(f, 'Asha');
    await fireEvent.press(screen.getByTestId('reminder-pay'));
    expect(screen.queryByTestId('payment-reminder')).toBeNull();
    expect(screen.getByTestId('loan-pay-now')).toBeTruthy();
  });

  it('an overdue payment says when the loan defaults', async () => {
    const f = borrowPersonal(intermediate());
    jumpTo(f, YEAR + 20);
    await renderGame(f, 'Asha');
    expect(within(screen.getByTestId('payment-reminder')).getByText('Loan payment overdue')).toBeTruthy();
    expect(screen.getByTestId('reminder-deadline')).toHaveTextContent(/Pay before Year 3 · 25% through or the loan goes into default/);
  });
});

describe('Capital: property details', () => {
  it('shows original price, market value, the year’s change, trend, a labelled projection and purchasing power', async () => {
    const f = jumpTo(intermediate(), YEAR * 2);
    f.loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByText('Market price')).toBeTruthy();
    expect(screen.getByTestId('property-price')).toHaveTextContent('₹10,300');
    const v = screen.getByTestId('property-valuation');
    expect(within(v).getByTestId('valuation-original')).toHaveTextContent(/₹8,500/);
    expect(within(v).getByTestId('valuation-market')).toHaveTextContent(/₹10,300/);
    expect(within(v).getByTestId('valuation-change')).toHaveTextContent(/\+10%/);
    expect(within(v).getByTestId('valuation-trend')).toHaveTextContent(/\+5% a year/);
    expect(within(v).getByTestId('valuation-projection')).toHaveTextContent(/in 5 years.*₹13,100/);
    expect(within(v).getByTestId('valuation-real')).toHaveTextContent(/₹9,342/);
    // The explanations sit behind each label's ⓘ; the figures above stay in view without them.
    expect(screen.queryByText(/A projection, not a guaranteed price/)).toBeNull();
    await fireEvent.press(within(v).getByTestId('valuation-projection-info'));
    expect(screen.getByTestId('valuation-projection-info-text')).toHaveTextContent(/A projection, not a guaranteed price/);
    await fireEvent.press(screen.getByTestId('valuation-projection-info-close'));
    expect(screen.queryByTestId('valuation-projection-info-text')).toBeNull();
    await fireEvent.press(within(v).getByTestId('valuation-real-info'));
    expect(screen.getByTestId('valuation-real-info-text')).toHaveTextContent(/inflation/i);
    await fireEvent.press(screen.getByTestId('valuation-real-info-backdrop', { includeHiddenElements: true }));
    expect(screen.queryByTestId('valuation-real-info-text')).toBeNull();
    // The printed deed is unchanged underneath.
    expect(within(screen.getByTestId('rent-table')).getByText('₹1,200')).toBeTruthy();
    expect(screen.getAllByText('₹7,500').length).toBeGreaterThan(0); // house and hotel cost
    expect(screen.getByText('₹4,250')).toBeTruthy(); // mortgage value
  });

  it('a pledged property is labelled as loan collateral — not as mortgaged — and its actions are blocked with the reason', async () => {
    const f = intermediate();
    give(f, 'Asha', 'MUMBAI');
    give(f, 'Asha', 'DELHI');
    f.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'SECURED', amount: 10000, expectedRatePercent: 6, collateralKeys: ['MUMBAI', 'DELHI'] }).loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByText('Pledged as loan collateral')).toBeTruthy();
    expect(screen.queryByText(/Mortgaged — no rent/)).toBeNull();
    expect(screen.getByTestId('valuation-pledged')).toHaveTextContent(/secures a loan/);
    expect(screen.getByTestId('action-MORTGAGE_PROPERTY').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('action-note-MORTGAGE_PROPERTY')).toHaveTextContent(/can’t also be mortgaged/);
    expect(screen.getByTestId('action-SELL_PROPERTY').props.accessibilityState.disabled).toBe(true);
  });
});

describe('House rules', () => {
  it('a Capital game adds its rules after the Classic ones; a Classic game does not', async () => {
    intermediate().loadAs('Asha');
    const view = await render(<Settings />);
    expect(within(screen.getByTestId('rules-property-money')).getByText('Mortgages')).toBeTruthy();
    const rules = screen.getByTestId('rules-intermediate');
    for (const title of ['Financial years', 'Property values', 'Inflation', 'Loans', 'Credit score', 'Late payments and default', 'Net worth']) {
      expect(within(rules).getByText(title)).toBeTruthy();
    }
    expect(within(rules).getByText(/Emergency Loan: 18% fixed, 1 year, ₹10,000–₹20,000, no property needed/)).toBeTruthy();
    expect(within(rules).getByText(/Secured Loan: 7% fixed, 3 years, ₹10,000–₹50,000, secured on property/)).toBeTruthy();
    expect(within(rules).getByText(/no single loan above ₹50,000/)).toBeTruthy();
    await view.unmount();
    new Fixture().loadAs('Asha');
    await render(<Settings />);
    expect(screen.queryByTestId('rules-intermediate')).toBeNull();
  });
});
