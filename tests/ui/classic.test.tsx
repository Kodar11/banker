/// <reference types="jest" />
/** UI for the finalized Classic rules: Jail choice, Club / Rest House, End Game dialog, 5-second auction countdown. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { netWorth, outstandingDebt, positionOfSpecial } from '@/engine/index.ts';
import { AuctionView } from '@/features/auction/AuctionView';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;

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
    myDebt: me ? outstandingDebt(snapshot.state.loans, me.id) : 0,
  };
}

/** Bilal takes a turn that moves no money: Start + 5 = Income Tax while owning nothing. */
function quietBilal(f: Fixture) {
  f.state.players.find((p) => p.name === 'Bilal')!.position = 0;
  return f.roll('Bilal', 2, 3).act('Bilal', { type: 'END_TURN' });
}

/** Asha lands on Jail, then Bilal takes a quiet turn → Asha's turn, in Jail. */
function jailedAsha() {
  const f = new Fixture();
  f.state.players.find((p) => p.name === 'Asha')!.position = 5;
  f.roll('Asha', 2, 2).act('Asha', { type: 'END_TURN' }); // 5 + 4 = Jail
  return quietBilal(f);
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Jail', () => {
  it('my Jail turn offers PAY ₹500 & ROLL or STAY — no roll button', async () => {
    const f = jailedAsha().loadAs('Asha');
    expect(f.state.players.find((p) => p.name === 'Asha')!.position).toBe(positionOfSpecial('JAIL'));
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    const card = screen.getByTestId('jail-card');
    expect(card).toHaveTextContent(/Jail · turn 1 of 3/);
    expect(screen.queryByTestId('roll-button')).toBeNull();
    expect(screen.getByText('PAY ₹500 & ROLL')).toBeTruthy();
    expect(screen.getByTestId('jail-stay')).toHaveTextContent(/Miss this turn · 2 more after this/);
    await fireEvent.press(screen.getByTestId('jail-pay'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PAY_JAIL_FINE' }));
  });

  it('STAY IN JAIL sends STAY_IN_JAIL; the last Jail turn says you are released after it', async () => {
    const f = jailedAsha();
    quietBilal(f.act('Asha', { type: 'STAY_IN_JAIL' }));
    quietBilal(f.act('Asha', { type: 'STAY_IN_JAIL' })).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('jail-card')).toHaveTextContent(/turn 3 of 3/);
    expect(screen.getByTestId('jail-stay')).toHaveTextContent(/Released after this turn/);
    await fireEvent.press(screen.getByTestId('jail-stay'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'STAY_IN_JAIL' }));
  });

  it('not enough cash: paying is disabled, a loan is offered, staying is still possible', async () => {
    const f = jailedAsha();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 24800 }).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('jail-pay').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('You’re ₹300 short.')).toBeTruthy();
    expect(screen.getByTestId('jail-stay').props.accessibilityState.disabled).toBe(false);
  });

  it('other players see the Jail state', async () => {
    const f = jailedAsha().loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('waiting-card')).toHaveTextContent(/Asha is in Jail — pay or stay\?/);
    expect(screen.getByTestId('players-strip')).toHaveTextContent(/In Jail · 3 left/);
  });
});

describe('Club and Rest House', () => {
  it('Club asks for ₹100 per other player', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    f.state.players.find((p) => p.name === 'Asha')!.position = 13;
    f.roll('Asha', 2, 3).loadAs('Asha'); // 13 + 5 = Club
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('payment-card')).toHaveTextContent(/Club — ₹100 to each player/);
    expect(screen.getByText('PAY ₹200')).toBeTruthy();
  });

  it('Rest House: the event says how much was collected; others see "Resting"', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    f.state.players.find((p) => p.name === 'Asha')!.position = 21;
    f.roll('Asha', 3, 3).loadAs('Bilal'); // 21 + 6 = Rest House
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('event-feed')).toHaveTextContent(/Asha rests at the Rest House: collects ₹200 and skips the next turn/);
    expect(screen.getByTestId('players-strip')).toHaveTextContent(/Resting/);
  });
});

describe('End Game confirmation', () => {
  it('opens an in-app dialog; Cancel does not end the game', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.queryByTestId('end-game-dialog')).toBeNull();
    await fireEvent.press(screen.getByTestId('end-game-button'));
    const dialog = screen.getByTestId('end-game-dialog');
    expect(within(dialog).getByText('🏆')).toBeTruthy();
    expect(within(dialog).getByText('End Game?')).toBeTruthy();
    expect(within(dialog).getByText('Are you sure you want to finish this game?')).toBeTruthy();
    expect(within(dialog).getByText('Highest net worth wins.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('end-game-dialog-cancel'));
    expect(screen.queryByTestId('end-game-dialog')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('Android back / backdrop tap cancels', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('end-game-button'));
    // The hardware back button reaches a Modal as onRequestClose.
    let modal = screen.getByTestId('end-game-dialog').parent;
    while (modal && modal.type !== 'Modal') modal = modal.parent;
    await fireEvent(modal!, 'requestClose');
    expect(screen.queryByTestId('end-game-dialog')).toBeNull();
    await fireEvent.press(screen.getByTestId('end-game-button'));
    expect(screen.getByTestId('end-game-dialog')).toBeTruthy();
    // Hidden from screen readers (the card is accessibilityViewIsModal) but tappable.
    await fireEvent.press(screen.getByTestId('end-game-dialog-backdrop', { includeHiddenElements: true }));
    expect(screen.queryByTestId('end-game-dialog')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('End Game sends END_GAME (destructive styling) and closes', async () => {
    const f = new Fixture().loadAs('Asha');
    const finished = new Fixture().act('Asha', { type: 'END_GAME' });
    api.action.mockResolvedValue(ok({ ...finished.snapshot(), state: { ...finished.state, id: f.state.id, version: f.state.version + 1 } }));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('end-game-button'));
    const confirm = screen.getByTestId('end-game-dialog-confirm');
    expect(confirm).toHaveTextContent('End Game');
    await fireEvent.press(confirm);
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'END_GAME' }));
    await waitFor(() => expect(screen.queryByTestId('end-game-dialog')).toBeNull());
  });

  it('only the host sees End Game; the paused screen uses the same confirmation', async () => {
    const f = new Fixture().loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('end-game-button')).toBeNull();
    const paused = new Fixture().act('Bilal', { type: 'PAUSE_GAME' }).loadAs('Asha');
    await render(<GameScreen view={viewFor(paused, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('end-game-button'));
    expect(screen.getByTestId('end-game-dialog')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
  });
});

describe('auction countdown (5 seconds, display only)', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-01-01T10:00:00.000Z'), doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('counts 5 → 4 → 3 → 2 → 1, then CLOSING… and asks the server to close; late bid buttons disappear', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' }).loadAs('Asha'); // seat 0: no close jitter
    const auctionId = f.state.auction!.id;
    api.action.mockResolvedValue({ ok: false, error: { code: 'AUCTION_CLOSED', message: 'That auction has finished.' } });
    await render(<AuctionView view={viewFor(f, 'Asha')} auctionId={auctionId} />);
    const countdown = () => screen.getByTestId('auction-countdown');
    expect(countdown()).toHaveTextContent('5');
    for (const n of ['4', '3', '2', '1']) {
      await act(async () => jest.advanceTimersByTime(1000));
      expect(countdown()).toHaveTextContent(n);
    }
    expect(screen.getByTestId('bid-button')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(1000));
    expect(countdown()).toHaveTextContent('CLOSING…');
    expect(screen.queryByTestId('bid-button')).toBeNull();
    await act(async () => jest.advanceTimersByTime(10));
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'CLOSE_AUCTION', auctionId });
    // AUCTION_CLOSED = someone else closed it: no retries.
    await act(async () => jest.advanceTimersByTime(5000));
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('retries the close if the server says the auction is still running (clock skew)', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' }).loadAs('Asha');
    const auctionId = f.state.auction!.id;
    api.action.mockResolvedValueOnce({ ok: false, error: { code: 'INVALID_PHASE', message: 'The auction is still running.' } });
    api.action.mockResolvedValue({ ok: false, error: { code: 'AUCTION_CLOSED', message: 'That auction has finished.' } });
    await render(<AuctionView view={viewFor(f, 'Asha')} auctionId={auctionId} />);
    await act(async () => jest.advanceTimersByTime(5000));
    await act(async () => jest.advanceTimersByTime(10));
    expect(api.action).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1100));
    expect(api.action).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(5000));
    expect(api.action).toHaveBeenCalledTimes(2);
  });

  it('shows SOLD with the winner, or CLOSED when unsold', async () => {
    const sold = new Fixture(['Asha', 'Bilal']);
    sold.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    const id = sold.state.auction!.id;
    sold.act('Bilal', { type: 'PLACE_BID', auctionId: id, amount: 500 }).act('Asha', { type: 'PASS_AUCTION', auctionId: id }).loadAs('Asha');
    await render(<AuctionView view={viewFor(sold, 'Asha')} auctionId={id} />);
    expect(screen.getByTestId('auction-result')).toHaveTextContent(/SOLD.*Sold to Bilal/);
    expect(screen.queryByTestId('auction-countdown')).toBeNull();

    const unsold = new Fixture(['Asha', 'Bilal']);
    unsold.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    const id2 = unsold.state.auction!.id;
    unsold.act('Bilal', { type: 'PASS_AUCTION', auctionId: id2 }).act('Asha', { type: 'PASS_AUCTION', auctionId: id2 }).loadAs('Asha');
    await render(<AuctionView view={viewFor(unsold, 'Asha')} auctionId={id2} />);
    expect(screen.getByTestId('auction-result')).toHaveTextContent(/CLOSED.*Unsold/);
  });
});
