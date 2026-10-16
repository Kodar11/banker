/// <reference types="jest" />
import type { ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  BOARD_SIZE,
  formatINR,
  gameClock,
  netWorth,
  pendingCrisisOf,
  positionOfProperty,
  totalDebt,
  yearAt,
  type GameAction,
  type GameMode,
  type InsuranceState,
  type IntermediateState,
  type PropertyKey,
} from '@/engine/index.ts';
import { INTRO_SEEN_KEY } from '@/features/finance/IntermediateIntro';
import { GameScreen } from '@/features/game/GameScreen';
import { useGameView, type GameView } from '@/features/game/useGameView';
import { InsuranceView } from '@/features/insurance/InsuranceView';
import { PropertyView } from '@/features/player/PropertyView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
/** Two starting players: the first crisis checkpoint (18 average spaces) is 36 on the shared clock. */
const FIRST = 36;

const game = (mode: GameMode = 'intermediate', names = ['Asha', 'Bilal']) => new Fixture(names, { mode, config: mode === 'intermediate' ? { secretObjectives: false } : undefined });
const eco = (f: Fixture): IntermediateState => f.state.intermediate!;
const ins = (f: Fixture): InsuranceState => eco(f).insurance!;
const currentName = (f: Fixture) => Object.keys(f.ids).find((n) => f.ids[n] === f.state.turn.playerId)!;

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

/** Renders from the synced store, like a route does: a new snapshot (an answer, or realtime) re-renders it. */
function Live({ children }: { children: (view: GameView) => ReactNode }) {
  const view = useGameView();
  return view ? <>{children(view)}</> : null;
}

function give(f: Fixture, name: string, key: PropertyKey, patch: { mortgaged?: boolean } = {}) {
  f.state.properties[key] = { ...f.state.properties[key], ownerId: f.ids[name]!, ...patch };
}

/** The current player rolls 1+2 onto Start, taking the shared clock to `target` (test surgery on the stored movement). */
function rollTo(f: Fixture, target: number): Fixture {
  const e = eco(f);
  const ids = Object.keys(e.movement);
  for (const id of ids) e.movement[id] = 0;
  e.movement[ids[0]!] = target - 3;
  e.year = yearAt(e, target - 3);
  const name = currentName(f);
  f.state.players.find((p) => p.id === f.ids[name])!.position = BOARD_SIZE - 3;
  f.roll(name, 1, 2);
  expect(gameClock(eco(f))).toBe(target);
  return f;
}

const insure = (f: Fixture, name: string, propertyKey: PropertyKey) => f.act(name, { type: 'INSURE_PROPERTY', propertyKey, expectedPremium: 250 });

/** The server, played by the fixture: applies what the phone sends as `name` and answers with the new snapshot. */
function serveAs(f: Fixture, name: string) {
  api.action.mockImplementation(async (_session, _id, _version, action) => {
    f.act(name, action as GameAction);
    return ok(f.snapshot());
  });
}

async function renderTable(f: Fixture, name: string) {
  f.loadAs(name);
  const view = await render(<Live>{(v) => <GameScreen view={v} />}</Live>);
  await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
  return view;
}

/** Another device changed the game: the new snapshot arrives through sync. */
async function arrive(f: Fixture) {
  await act(async () => {
    useGameStore.getState().applySnapshot(f.snapshot());
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  await SecureStore.setItemAsync(INTRO_SEEN_KEY, '1');
});

// ---------------------------------------------------------------------------

describe('More → Property Insurance', () => {
  it('a Capital game lists it under More and opens the insurance screen', async () => {
    const f = game();
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    const item = screen.getByTestId('more-insurance');
    expect(within(item).getByText('Property Insurance')).toBeTruthy();
    await fireEvent.press(item);
    expect(router.push).toHaveBeenCalledWith('/insurance');
    expect(screen.queryByTestId('sheet-more')).toBeNull();
  });

  it('a Classic game shows no insurance anywhere: not under More, not on a deed, not as a screen', async () => {
    const f = game('classic');
    give(f, 'Asha', 'MUMBAI');
    const table = await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('more-loan')).toBeTruthy();
    expect(screen.queryByTestId('more-insurance')).toBeNull();
    expect(screen.queryByTestId('crisis-settlement')).toBeNull();
    await table.unmount();

    const deed = await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('property-manage')).toBeTruthy();
    expect(screen.queryByTestId('property-insurance')).toBeNull();
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
    await deed.unmount();

    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('insurance-unavailable')).toHaveTextContent(/part of Capital Mode/);
    expect(screen.queryByTestId('insurance-summary')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });
});

describe('Insurance screen', () => {
  it('shows the year, the premium and the risk, my properties, and my policies in detail', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    give(f, 'Asha', 'DELHI', { mortgaged: true });
    give(f, 'Bilal', 'AGRA');
    insure(f, 'Asha', 'MUMBAI');
    insure(f, 'Bilal', 'AGRA');
    f.loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('insurance-year')).toHaveTextContent('Year 1');
    expect(screen.getByTestId('insurance-current-premium')).toHaveTextContent('₹250');
    expect(screen.getByTestId('insurance-explainer')).toHaveTextContent(/owes ₹3,000 at once/);
    expect(screen.getByTestId('insurance-explainer')).toHaveTextContent(/up to ₹3,000 in total \(₹0 deductible\)/);
    expect(screen.getByTestId('insurance-explainer')).toHaveTextContent(/No cancellation, no refunds/);
    expect(screen.getByTestId('insurance-next-crisis')).toHaveTextContent(/18 avg\. spaces/);

    // My properties: what protects each, and the way to insure the one that is not.
    expect(screen.getByTestId('insurance-property-MUMBAI')).toHaveTextContent(/Covered for 36 more spaces · ₹3,000 payout left/);
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
    expect(screen.getByTestId('insurance-property-DELHI')).toHaveTextContent(/Not insured · ₹3,000 at risk · Mortgaged/);
    expect(screen.getByTestId('insure-DELHI')).toHaveTextContent('Insure property · ₹250');

    // My policy, in full.
    const mine = ins(f).policies.find((p) => p.ownerId === f.ids.Asha)!;
    const active = within(screen.getByTestId('policies-active'));
    const card = active.getByTestId(`policy-${mine.id}`);
    expect(card).toHaveTextContent(/Mumbai/);
    expect(card).toHaveTextContent(/Premium paid · Year 1\s*₹250/);
    expect(card).toHaveTextContent(/Discounts\s*none/);
    expect(card).toHaveTextContent(/Cover\s*0 → 36 avg\. spaces/);
    expect(screen.getByTestId(`policy-${mine.id}-claimed`)).toHaveTextContent(/Claimed\s*₹0 of ₹3,000/);
    expect(screen.getByTestId(`policy-${mine.id}-remaining`)).toHaveTextContent(/Payout left\s*₹3,000/);
    expect(card).toHaveTextContent(/Deductible\s*₹0/);
    // Renewal is not open yet: it opens once this period's crisis has passed.
    expect(screen.getByTestId(`renew-${mine.id}-timing`)).toHaveTextContent(/Renewal opens after this period's crisis, at 18 avg\. spaces/);
    expect(screen.queryByTestId(`renew-${mine.id}-button`)).toBeNull();
    expect(screen.getByTestId('policies-claimed')).toHaveTextContent('Paid out · 0');
    expect(screen.getByTestId('policies-expired')).toHaveTextContent('Expired or ended · 0');

    // Other players: whether a property is insured, and nothing more.
    const theirs = ins(f).policies.find((p) => p.ownerId === f.ids.Bilal)!;
    expect(screen.getByTestId('insurance-other-AGRA')).toHaveTextContent(/Agra · Bilal\s*Insured/);
    expect(screen.queryByTestId(`policy-${theirs.id}`)).toBeNull();
  });

  it('with no property it explains why and points back to the board', async () => {
    const f = game().loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('insurance-empty')).toHaveTextContent(/You don’t own a property yet/);
    expect(screen.getByTestId('insurance-no-policies')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('insurance-to-board'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('after a claim the policy shows what it paid and has left, the crisis is listed, and renewal opens', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    rollTo(f, FIRST).loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    const p = ins(f).policies[0]!;
    // Still in force for the rest of its period, with its limit used.
    const active = within(screen.getByTestId('policies-active'));
    expect(active.getByText('Mumbai')).toBeTruthy();
    expect(screen.getByTestId(`policy-${p.id}-claimed`)).toHaveTextContent(/Claimed\s*₹3,000 of ₹3,000 · 1 crisis/);
    expect(screen.getByTestId(`policy-${p.id}-remaining`)).toHaveTextContent(/Payout left\s*₹0/);
    expect(screen.getByTestId('crisis-row-1')).toHaveTextContent(/18 avg\. spaces · Mumbai \(Asha\)/);
    expect(screen.getByTestId('crisis-row-1')).toHaveTextContent(/Insured — paid in full by insurance/);
    // It can't be bought over while it runs; renewal is open, with the early-buyer discount and no no-claim discount.
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
    expect(screen.getByTestId(`renew-${p.id}-button`)).toHaveTextContent('Renew · ₹200');
  });
});

describe('Property details → Insure property', () => {
  it('shows status and this year’s premium; confirming shows price, term and the one-crisis limit; the deed then reads the server’s state', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    f.loadAs('Asha');
    serveAs(f, 'Asha');
    await render(<Live>{(v) => <PropertyView view={v} propertyKey="MUMBAI" />}</Live>);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Not insured');
    expect(screen.getByTestId('insurance-policy-state')).toHaveTextContent(/Policy\s*None/);
    expect(screen.getByTestId('insurance-premium')).toHaveTextContent(/Premium · Year 1\s*₹250/);
    expect(screen.getByTestId('insurance-mortgaged')).toHaveTextContent(/Mortgaged\s*No/);
    expect(screen.queryByTestId('insure-dialog')).toBeNull();

    await fireEvent.press(screen.getByTestId('insure-MUMBAI'));
    const dialog = screen.getByTestId('insure-dialog');
    expect(within(dialog).getByText('Insure Mumbai?')).toBeTruthy();
    expect(screen.getByTestId('insure-dialog-summary')).toHaveTextContent('Premium ₹250 · Year 1');
    expect(dialog).toHaveTextContent(/36 spaces of average movement/);
    expect(dialog).toHaveTextContent(/every crisis, up to ₹3,000 in total/);
    // The policy summary: price, discounts, period, cover, limit, deductible, renewal and cancellation.
    expect(screen.getByTestId('policy-terms-total')).toHaveTextContent(/Total premium\s*₹250/);
    expect(screen.getByTestId('policy-terms-loyalty')).toHaveTextContent(/Early-buyer discount\s*Renewals only/);
    expect(screen.getByTestId('policy-terms-no-claim')).toHaveTextContent(/No-claim discount\s*Renewals only/);
    expect(screen.getByTestId('policy-terms-period')).toHaveTextContent(/0 → 36 avg\. spaces/);
    expect(screen.getByTestId('policy-terms-limit')).toHaveTextContent(/₹3,000 per period/);
    expect(dialog).toHaveTextContent(/Property crisis/);
    expect(dialog).toHaveTextContent(/Deductible\s*₹0/);
    expect(dialog).toHaveTextContent(/Optional, never automatic/);
    expect(dialog).toHaveTextContent(/cannot be cancelled, and unused cover is never refunded/);
    // Nothing is sent until the player confirms.
    expect(api.action).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('insure-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured'));
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 250 });
    expect(screen.queryByTestId('insure-dialog')).toBeNull();
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
    expect(screen.getByTestId('insurance-policy-state')).toHaveTextContent(/Policy\s*Active/);
    expect(screen.getByTestId('insurance-expiry')).toHaveTextContent(/36 avg\. spaces/);
    expect(screen.getByTestId('insurance-left')).toHaveTextContent(/36 spaces/);
  });

  it('a refused purchase says why and never looks like a success', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    f.loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'STALE_STATE', message: 'The premium is now ₹600 (Year 2). Review it and confirm again.' } });
    api.state.mockResolvedValue(ok(f.snapshot()));
    await render(<Live>{(v) => <PropertyView view={v} propertyKey="MUMBAI" />}</Live>);
    await fireEvent.press(screen.getByTestId('insure-MUMBAI'));
    await fireEvent.press(screen.getByTestId('insure-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('insure-dialog-error')).toHaveTextContent(/The premium is now ₹600/));
    // The dialog is still open to retry or cancel, and the deed still says what the server last said.
    expect(screen.getByTestId('insure-dialog')).toBeTruthy();
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Not insured');
    expect(screen.queryByTestId('insurance-expiry')).toBeNull();
    await fireEvent.press(screen.getByTestId('insure-dialog-cancel'));
    expect(screen.queryByTestId('insure-dialog')).toBeNull();
    expect(screen.getByTestId('insure-MUMBAI')).toBeTruthy();
  });

  it('an unavailable purchase is disabled and explained, not silently ignored', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI', { mortgaged: true });
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 25000 - 200 });
    f.loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('insure-MUMBAI').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('insure-note-MUMBAI')).toHaveTextContent('Not enough money — the premium is ₹250.');
    expect(screen.getByTestId('insurance-mortgaged')).toHaveTextContent(/Mortgaged\s*Yes/);
    await fireEvent.press(screen.getByTestId('insure-MUMBAI'));
    expect(screen.queryByTestId('insure-dialog')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('someone else’s property shows only whether it is insured', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    f.loadAs('Bilal');
    await render(<PropertyView view={viewFor(f, 'Bilal')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured');
    expect(screen.queryByTestId('insurance-expiry')).toBeNull();
    expect(screen.queryByTestId('insurance-policy-state')).toBeNull();
    expect(screen.queryByTestId('insure-MUMBAI')).toBeNull();
  });

  it('a policy bought on another phone appears when the new state arrives', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    f.loadAs('Bilal');
    await render(<Live>{(v) => <PropertyView view={v} propertyKey="MUMBAI" />}</Live>);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Not insured');
    insure(f, 'Asha', 'MUMBAI');
    await arrive(f);
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured');
  });
});

describe('Crisis: the player who owes', () => {
  /** Asha owns Mumbai uninsured and her own roll reaches the first checkpoint. */
  function struck(cash?: number) {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    if (cash !== undefined) f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 25000 - cash });
    return rollTo(f, FIRST);
  }

  it('gets a settlement view in place of the table, with no way to dismiss it, until the server says it is paid', async () => {
    const f = struck();
    const crisis = pendingCrisisOf(f.state, f.ids.Asha!)!;
    serveAs(f, 'Asha');
    await renderTable(f, 'Asha');
    const bill = screen.getByTestId('crisis-settlement');
    expect(within(bill).getByText('Crisis at Mumbai')).toBeTruthy();
    expect(screen.getByTestId('crisis-checkpoint')).toHaveTextContent(/Checkpoint 1 · 18 spaces of average movement · Year 1/);
    expect(screen.getByTestId('crisis-amount')).toHaveTextContent('₹3,000');
    expect(screen.getByTestId('crisis-reason')).toHaveTextContent(/Mumbai was not insured/);
    expect(screen.getByTestId('crisis-status')).toHaveTextContent(/Pending/);
    // The table is not underneath it: there is nothing else to tap, and nothing closes it.
    for (const id of ['board-area', 'turn-bar', 'roll-button', 'end-turn-button', 'open-properties', 'open-trade', 'context-card', 'crisis-notice']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(within(bill).queryByLabelText('Close')).toBeNull();

    await fireEvent.press(screen.getByTestId('crisis-pay'));
    await waitFor(() => expect(screen.queryByTestId('crisis-settlement')).toBeNull());
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PAY_CRISIS_BILL', crisisId: crisis.id });
    // Settled: the table is back where the turn stopped.
    expect(screen.getByTestId('board-area')).toBeTruthy();
    expect(screen.getByTestId('end-turn-button')).toBeTruthy();
  });

  it('closing and reopening the game brings back the same bill', async () => {
    const f = struck();
    const first = await renderTable(f, 'Asha');
    expect(screen.getByTestId('crisis-amount')).toHaveTextContent('₹3,000');
    await first.unmount();
    useGameStore.getState().reset(null);
    await renderTable(f, 'Asha');
    expect(screen.getByTestId('crisis-settlement')).toBeTruthy();
    expect(screen.getByTestId('crisis-amount')).toHaveTextContent('₹3,000');
    expect(screen.queryByTestId('board-area')).toBeNull();
  });

  it('a payment the server refuses leaves the bill on screen with the reason', async () => {
    const f = struck();
    api.action.mockResolvedValue({ ok: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('crisis-pay'));
    await waitFor(() => expect(screen.getByTestId('crisis-error')).toHaveTextContent('Something went wrong. Please try again.'));
    expect(screen.getByTestId('crisis-settlement')).toBeTruthy();
    expect(screen.getByTestId('crisis-status')).toHaveTextContent(/Pending/);
  });

  it('short of cash: shows the shortfall and the ways to raise it; bankruptcy stays closed while any is left', async () => {
    const f = struck(200); // 200 + ₹1,500 for passing Start
    await renderTable(f, 'Asha');
    expect(screen.getByTestId('crisis-cash')).toHaveTextContent('Your cash: ₹1,700');
    expect(screen.getByTestId('crisis-short')).toHaveTextContent('You’re ₹1,300 short.');
    expect(screen.getByTestId('crisis-pay').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('crisis-options')).toHaveTextContent('You can still: mortgage a property, sell a property to the bank, take a loan (optional).');
    expect(screen.getByTestId('crisis-bankrupt').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('crisis-bankrupt-note')).toHaveTextContent(/Bankruptcy is only possible when even that would not be enough/);
    await fireEvent.press(screen.getByTestId('crisis-bankrupt'));
    expect(screen.queryByTestId('crisis-bankrupt-dialog')).toBeNull();

    // The existing ways of raising money open from here; the bill is still there afterwards.
    await fireEvent.press(screen.getByTestId('crisis-loan'));
    expect(screen.getByTestId('finance-hub')).toBeTruthy();
    expect(screen.getByTestId('finance-tab-borrow').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByTestId('crisis-properties'));
    expect(router.push).toHaveBeenCalledWith(`/player/${f.ids.Asha}`);
    expect(screen.getByTestId('crisis-settlement')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('money raised on the property screen shows up on the bill, which can then be paid', async () => {
    const f = struck(200);
    serveAs(f, 'Asha');
    await renderTable(f, 'Asha');
    expect(screen.getByTestId('crisis-pay').props.accessibilityState.disabled).toBe(true);
    f.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    await arrive(f);
    expect(screen.getByTestId('crisis-cash')).toHaveTextContent('Your cash: ₹5,950');
    expect(screen.queryByTestId('crisis-recovery')).toBeNull();
    expect(screen.getByTestId('crisis-pay').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('crisis-pay'));
    await waitFor(() => expect(screen.queryByTestId('crisis-settlement')).toBeNull());
    expect(f.state.properties.MUMBAI).toMatchObject({ ownerId: f.ids.Asha, mortgaged: true });
  });

  it('on a deed, building and unmortgaging are closed with the reason while the bill is open', async () => {
    const f = struck();
    f.loadAs('Asha');
    await render(<PropertyView view={viewFor(f, 'Asha')} propertyKey="MUMBAI" />);
    expect(screen.getByTestId('action-BUILD_HOUSE').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('action-note-BUILD_HOUSE')).toHaveTextContent('Settle your crisis bill first.');
    expect(screen.getByTestId('action-MORTGAGE_PROPERTY').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('insure-MUMBAI').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('insure-note-MUMBAI')).toHaveTextContent('Settle your crisis bill first.');
  });
});

describe('Crisis: everyone else', () => {
  it('is told what happened and sees a waiting table — until the bill is settled on the other phone', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    await renderTable(f, 'Bilal');
    expect(screen.queryByTestId('crisis-notice')).toBeNull();

    rollTo(f, FIRST);
    await arrive(f);
    const notice = await waitFor(() => screen.getByTestId('crisis-notice'));
    expect(within(notice).getByText('Crisis at Mumbai')).toBeTruthy();
    expect(screen.getByTestId('crisis-notice-property')).toHaveTextContent('Mumbai · owned by Asha');
    expect(screen.getByTestId('crisis-notice-bill')).toHaveTextContent('Crisis bill: ₹3,000');
    expect(screen.getByTestId('crisis-notice-outcome')).toHaveTextContent('Not insured: Asha owes the bank ₹3,000.');
    expect(screen.getByTestId('crisis-notice-status')).toHaveTextContent(/Pending — the game waits until Asha settles it/);
    // Dismissing the news does not dismiss the bill: the table keeps saying whom it waits for.
    await fireEvent.press(screen.getByTestId('crisis-notice-dismiss'));
    expect(screen.queryByTestId('crisis-notice')).toBeNull();
    expect(screen.queryByTestId('crisis-settlement')).toBeNull();
    expect(screen.getByTestId('turn-detail')).toHaveTextContent(/Crisis at Mumbai: Asha owes ₹3,000/);
    expect(screen.getByTestId('turn-waiting')).toHaveTextContent('Crisis…');
    expect(screen.getByTestId('context-title')).toHaveTextContent('Asha owes ₹3,000');
    expect(screen.getByTestId('context-detail')).toHaveTextContent(/the game waits until it is settled/);

    f.act('Asha', { type: 'PAY_CRISIS_BILL', crisisId: pendingCrisisOf(f.state, f.ids.Asha!)!.id });
    await arrive(f);
    expect(screen.getByTestId('turn-detail')).not.toHaveTextContent(/Crisis at/);
    expect(screen.getByTestId('context-title')).not.toHaveTextContent(/owes ₹3,000/);
    // The same crisis is not announced a second time.
    expect(screen.queryByTestId('crisis-notice')).toBeNull();
  });

  it('when it is their own turn they wait too: no roll or end-turn button while the bill is open', async () => {
    const f = game();
    give(f, 'Bilal', 'AGRA');
    rollTo(f, FIRST); // Asha's roll; Bilal owes
    await renderTable(f, 'Asha');
    expect(screen.getByTestId('turn-title')).toHaveTextContent('YOUR TURN');
    expect(screen.getByTestId('turn-detail')).toHaveTextContent(/Crisis at Agra: Bilal owes ₹3,000/);
    expect(screen.queryByTestId('end-turn-button')).toBeNull();
    expect(screen.queryByTestId('roll-button')).toBeNull();
    expect(screen.getByTestId('turn-waiting')).toBeTruthy();
  });

  it('an insured property: the owner is told the claim paid the bill and what cover is left, and nothing waits', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    await renderTable(f, 'Asha');
    rollTo(f, FIRST);
    await arrive(f);
    await waitFor(() => screen.getByTestId('crisis-notice'));
    expect(screen.getByTestId('crisis-notice-property')).toHaveTextContent('Mumbai · yours');
    expect(screen.getByTestId('crisis-notice-outcome')).toHaveTextContent('Covered: insurance paid the ₹3,000 bill. You pay nothing.');
    expect(screen.getByTestId('crisis-notice-remaining')).toHaveTextContent('Your policy has ₹0 of ₹3,000 left to pay this period.');
    expect(screen.getByTestId('crisis-notice-status')).toHaveTextContent('Settled by insurance.');
    expect(screen.queryByTestId('crisis-settlement')).toBeNull();
    await fireEvent.press(screen.getByTestId('crisis-notice-dismiss'));
    expect(screen.getByTestId('end-turn-button')).toBeTruthy();
  });

  it('a phone that opens the game after a crisis does not replay it', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    rollTo(f, FIRST);
    await renderTable(f, 'Bilal');
    await act(async () => {});
    expect(screen.queryByTestId('crisis-notice')).toBeNull();
  });
});

describe('Buying a property: buy and insure in one tap', () => {
  /** Asha's roll lands her on Agra, which nobody owns. */
  function onAgra(mode: GameMode = 'intermediate') {
    const f = game(mode);
    f.state.players.find((p) => p.id === f.ids.Asha)!.position = (positionOfProperty('AGRA') - 3 + BOARD_SIZE) % BOARD_SIZE;
    return f.roll('Asha', 1, 2);
  }

  it('the buy card offers the plain purchase and the insured one, with the exact total', async () => {
    const f = onAgra();
    const price = (f.state.turn.pending as { price: number }).price;
    serveAs(f, 'Asha');
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('turn-choose'));
    expect(screen.getByTestId('buy-button')).toHaveTextContent(`BUY ${formatINR(price)}`);
    expect(screen.getByTestId('buy-insured-button')).toHaveTextContent(`BUY + INSURE ${formatINR(price + 250)}🛡️ ${formatINR(price)} + ₹250 premium`);
    expect(screen.getByTestId('buy-insured-note')).toHaveTextContent(/pays its crisis bills for 36 spaces of average movement, up to ₹3,000/);
    expect(screen.getByTestId('buy-insured-note')).toHaveTextContent(/insure it later from its deed/);

    await fireEvent.press(screen.getByTestId('buy-insured-button'));
    await waitFor(() => expect(f.state.properties.AGRA.ownerId).toBe(f.ids.Asha));
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'BUY_PROPERTY', insurePremium: 250 });
    expect(ins(f).policies).toMatchObject([{ propertyKeys: ['AGRA'], status: 'ACTIVE' }]);
  });

  it('with money for the property but not the premium, only the plain purchase is open, and it says why', async () => {
    const f = onAgra();
    const price = (f.state.turn.pending as { price: number }).price;
    const asha = f.state.players.find((p) => p.id === f.ids.Asha)!;
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: asha.balance - price - 100 });
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('turn-choose'));
    expect(screen.getByTestId('buy-button').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('buy-insured-button').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('buy-insured-note')).toHaveTextContent('Not enough money to insure it as well (₹250).');
  });

  it('a property bought without insurance can be insured later from its card', async () => {
    const f = onAgra().act('Asha', { type: 'BUY_PROPERTY' });
    serveAs(f, 'Asha');
    await renderTable(f, 'Asha');
    // The board's square for Agra opens its deed, with the insurance section.
    await fireEvent.press(screen.getByTestId('context-cta'));
    expect(screen.getByTestId('insurance-status')).toHaveTextContent('Not insured');
    await fireEvent.press(screen.getByTestId('insure-AGRA'));
    await fireEvent.press(screen.getByTestId('insure-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('insurance-status')).toHaveTextContent('Insured'));
  });

  it('a Classic game keeps its buy card as it was', async () => {
    const f = onAgra('classic');
    await renderTable(f, 'Asha');
    await fireEvent.press(screen.getByTestId('turn-choose'));
    expect(screen.getByTestId('buy-button')).toBeTruthy();
    expect(screen.queryByTestId('buy-insured-button')).toBeNull();
    expect(screen.queryByTestId('buy-insured-note')).toBeNull();
  });
});

describe('Insurance screen: insure all', () => {
  function owning() {
    const f = game();
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) give(f, 'Asha', key);
    return f;
  }

  it('one button insures every uninsured property under one portfolio policy, after one confirmation showing the total', async () => {
    const f = owning();
    insure(f, 'Asha', 'DELHI');
    f.loadAs('Asha');
    serveAs(f, 'Asha');
    await render(<Live>{(v) => <InsuranceView view={v} />}</Live>);
    expect(screen.getByTestId('insure-all-button')).toHaveTextContent('Insure all 2 · ₹475');
    await fireEvent.press(screen.getByTestId('insure-all-button'));
    const dialog = screen.getByTestId('insure-all-dialog');
    expect(within(dialog).getByText('Insure 2 properties?')).toBeTruthy();
    expect(screen.getByTestId('insure-all-dialog-summary')).toHaveTextContent('₹475 for 2 · Year 1');
    expect(screen.getByTestId('insure-all-terms-per-property')).toHaveTextContent(/Per property \(2\)\s*₹238/);
    expect(screen.getByTestId('insure-all-terms-portfolio')).toHaveTextContent(/Portfolio discount\s*−5%/);
    expect(dialog).toHaveTextContent(/Separately they would cost ₹500/);
    expect(dialog).toHaveTextContent(/Mumbai/);
    expect(dialog).toHaveTextContent(/Agra/);
    expect(dialog).not.toHaveTextContent(/Delhi/);
    expect(api.action).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('insure-all-dialog-confirm'));
    await waitFor(() => expect(screen.queryByTestId('insure-all')).toBeNull());
    expect(api.action).toHaveBeenCalledTimes(1);
    const sent = api.action.mock.calls[0]![3] as { type: string; propertyKeys: string[]; expectedPremium: number };
    expect(sent).toMatchObject({ type: 'INSURE_PROPERTIES', expectedPremium: 475 });
    expect([...sent.propertyKeys].sort()).toEqual(['AGRA', 'MUMBAI']);
    expect(screen.getByTestId('policies-active')).toHaveTextContent(/Active · 2/);
    expect(ins(f).policies[1]).toMatchObject({ propertyKeys: ['MUMBAI', 'AGRA'], premiumPaid: 475 });
    for (const key of ['MUMBAI', 'DELHI', 'AGRA']) expect(screen.queryByTestId(`insure-${key}`)).toBeNull();
  });

  it('short of the total it is disabled with the reason; single properties can still be insured', async () => {
    const f = owning();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 25000 - 600 });
    f.loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('insure-all-button').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('insure-all-note')).toHaveTextContent('Not enough money — insuring 3 properties costs ₹675.');
    expect(screen.getByTestId('insure-MUMBAI').props.accessibilityState.disabled).toBe(false);
  });

  it('a refusal stays in the dialog and nothing looks insured', async () => {
    const f = owning().loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'STALE_STATE', message: 'The premium is now ₹600 (Year 2). Review it and confirm again.' } });
    api.state.mockResolvedValue(ok(f.snapshot()));
    await render(<Live>{(v) => <InsuranceView view={v} />}</Live>);
    await fireEvent.press(screen.getByTestId('insure-all-button'));
    await fireEvent.press(screen.getByTestId('insure-all-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('insure-all-dialog-error')).toHaveTextContent(/The premium is now ₹600/));
    expect(screen.getByTestId('insurance-no-policies')).toBeTruthy();
  });

  it('with one uninsured property there is just the button of that property', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    f.loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.queryByTestId('insure-all')).toBeNull();
    expect(screen.getByTestId('insure-MUMBAI')).toBeTruthy();
  });
});

describe('Insurance screen: renewal, partial claims and traded properties', () => {
  it('renewal opens after the period’s crisis, shows the price with its discounts and terms, and is sent only on confirmation', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    const p = ins(f).policies[0]!;
    // The period's checkpoint passed without striking Mumbai (test surgery on the schedule): a claim-free period.
    ins(f).nextCheckpoint = 2;
    rollTo(f, 40).loadAs('Asha');
    serveAs(f, 'Asha');
    await render(<Live>{(v) => <InsuranceView view={v} />}</Live>);
    expect(screen.getByTestId(`renew-${p.id}-timing`)).toHaveTextContent(/Renew by 48 avg\. spaces to keep your discounts/);
    expect(screen.getByTestId(`renew-${p.id}-button`)).toHaveTextContent('Renew · ₹175');
    await fireEvent.press(screen.getByTestId(`renew-${p.id}-button`));
    expect(screen.getByTestId('renew-dialog-summary')).toHaveTextContent('Renewal premium ₹175 · Year 1');
    expect(screen.getByTestId('renew-terms-loyalty')).toHaveTextContent(/Early-buyer discount\s*−20%/);
    expect(screen.getByTestId('renew-terms-no-claim')).toHaveTextContent(/No-claim discount\s*−10%/);
    expect(screen.getByTestId('renew-terms-period')).toHaveTextContent(/36 → 72 avg\. spaces/);
    expect(screen.getByTestId('renew-terms-claimed')).toHaveTextContent(/₹0 · new period starts with the full ₹3,000/);
    expect(api.action).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('renew-dialog-confirm'));
    await waitFor(() => expect(ins(f).policies).toHaveLength(2));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'RENEW_INSURANCE', policyId: p.id, expectedPremium: 175 });
    await waitFor(() => expect(screen.getByTestId('policies-active')).toHaveTextContent(/Active · 2/));
    expect(screen.getByTestId('policies-active')).toHaveTextContent(/Renewed · starts later/);
    expect(screen.queryByTestId(`renew-${p.id}`)).toBeNull();
  });

  it('a partly covered crisis: the bill shows what insurance paid and only the rest is owed', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    insure(f, 'Asha', 'MUMBAI');
    // Test surgery: only ₹1,000 of cover in this policy.
    ins(f).policies[0]!.payoutLimit = 1000;
    rollTo(f, FIRST);
    serveAs(f, 'Asha');
    await renderTable(f, 'Asha');
    expect(screen.getByTestId('crisis-amount')).toHaveTextContent('₹2,000');
    expect(screen.getByTestId('crisis-reason')).toHaveTextContent(/The bill is ₹3,000\. Your insurance paid ₹1,000/);
    await fireEvent.press(screen.getByTestId('crisis-pay'));
    await waitFor(() => expect(screen.queryByTestId('crisis-settlement')).toBeNull());
    expect(ins(f).crises[0]).toMatchObject({ status: 'PAID', covered: 1000, paid: 2000 });
  });

  it('a property traded away is shown as no longer insured on its portfolio policy', async () => {
    const f = game();
    give(f, 'Asha', 'MUMBAI');
    give(f, 'Asha', 'DELHI');
    f.act('Asha', { type: 'INSURE_PROPERTIES', propertyKeys: ['MUMBAI', 'DELHI'], expectedPremium: 475 });
    f.act('Asha', { type: 'CREATE_TRADE', toPlayerId: f.ids.Bilal!, offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
    f.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: f.state.trades[0]!.id });
    const p = ins(f).policies[0]!;
    f.loadAs('Asha');
    await render(<InsuranceView view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId(`policy-${p.id}-removed`)).toHaveTextContent(/No longer insured: Mumbai/);
    expect(screen.getByTestId('insurance-property-DELHI')).toHaveTextContent(/Covered for 36 more spaces/);
  });
});
