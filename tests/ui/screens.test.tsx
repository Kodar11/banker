/// <reference types="jest" />
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Home from '../../app/index';
import CreateGame from '../../app/create-game';
import JoinGame from '../../app/join-game';
import { ConnectionBanner, ErrorState, NoticeToast } from '@/components/ui';
import { AuctionView } from '@/features/auction/AuctionView';
import { GameGate } from '@/features/game/GameGate';
import { GameScreen } from '@/features/game/GameScreen';
import { GameSyncHost } from '@/features/game/sync';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { PlayerView } from '@/features/player/PlayerView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
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

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Home', () => {
  it('offers create and join; resume only when a session exists', async () => {
    await render(<Home />);
    expect(screen.getByTestId('create-game')).toBeTruthy();
    expect(screen.getByTestId('join-game')).toBeTruthy();
    expect(screen.queryByTestId('resume-game')).toBeNull();
    await fireEvent.press(screen.getByTestId('create-game'));
    expect(router.push).toHaveBeenCalledWith('/create-game');

    await act(async () => useSessionStore.setState({ session: { gameId: 'g1', playerId: 'p1', token: 't' } }));
    await fireEvent.press(screen.getByTestId('resume-game'));
    expect(router.push).toHaveBeenCalledWith('/game/g1');
  });
});

describe('Create game', () => {
  it('validates the name before calling the server', async () => {
    await render(<CreateGame />);
    await fireEvent.press(screen.getByTestId('create-confirm'));
    expect(screen.getByText('Enter a name')).toBeTruthy();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('creates a Business game and opens the lobby', async () => {
    const f = new Fixture(['Tanmay'], { start: false });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    expect(screen.getByTestId('game-option-business')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${f.state.id}`));
    expect(api.create).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^[0-9a-f]{64}$/), 'Tanmay');
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
  });

  it('retries a timed-out create with the SAME action id (no duplicate games)', async () => {
    const f = new Fixture(['Tanmay'], { start: false });
    api.create.mockResolvedValueOnce({ ok: false, error: { code: 'TIMEOUT', message: 'slow' } }).mockResolvedValueOnce(ok(f.snapshot()));
    await render(<CreateGame />);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[0]![0]).toBe(api.create.mock.calls[1]![0]);
    expect(api.create.mock.calls[0]![1]).toBe(api.create.mock.calls[1]![1]);
  });
});

describe('Join game', () => {
  it('prefills code from a QR deep link, strips non-digits and shows server errors', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValue({ code: '123456' });
    api.join.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'No game with that code. Check the 6 digits.' } });
    await render(<JoinGame />);
    expect(screen.getByTestId('join-code').props.value).toBe('123456');
    await fireEvent.changeText(screen.getByTestId('join-code'), '65-43 21x9');
    expect(screen.getByTestId('join-code').props.value).toBe('654321');
    await fireEvent.changeText(screen.getByTestId('join-name'), 'Priya');
    await fireEvent.press(screen.getByTestId('join-confirm'));
    expect(await screen.findByText('No game with that code. Check the 6 digits.')).toBeTruthy();
    expect(api.join).toHaveBeenCalledWith(expect.any(String), expect.any(String), '654321', 'Priya');
  });
});

describe('Lobby', () => {
  it('shows the code and players; host can start only with enough players', async () => {
    const solo = new Fixture(['Asha'], { start: false }).loadAs('Asha');
    const { rerender } = await render(<LobbyView view={viewFor(solo, 'Asha')} />);
    expect(screen.getByTestId('game-code').props.children).toBe('482915');
    expect(screen.getByTestId('start-game-button').props.accessibilityState.disabled).toBe(true);

    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await rerender(<LobbyView view={viewFor(f, 'Asha')} />);
    expect(screen.getByText('Bilal')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('start-game-button'));
    await waitFor(() => expect(api.action).toHaveBeenCalled());
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'START_GAME' });
  });

  it('non-host sees a ready toggle', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false }).loadAs('Bilal');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<LobbyView view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('start-game-button')).toBeNull();
    await fireEvent.press(screen.getByTestId('ready-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'SET_READY', ready: true }));
  });
});

describe('Main game', () => {
  it('my turn: big ROLL DICE sends the action with the version I saw', async () => {
    const f = new Fixture().loadAs('Asha');
    const after = new Fixture();
    after.roll('Asha', 3, 2);
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByText('YOUR TURN')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('roll-button'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    const [, , expectedVersion, action] = api.action.mock.calls[0]!;
    expect(action).toEqual({ type: 'ROLL_DICE' });
    expect(expectedVersion).toBe(f.state.version);
  });

  it("other player's phone shows who we're waiting for, no roll button", async () => {
    const f = new Fixture().loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.queryByTestId('roll-button')).toBeNull();
    expect(screen.getByText('Asha is about to roll')).toBeTruthy();
  });

  it('after rolling: dice result, destination and BUY ₹9,500 / DECLINE', async () => {
    const f = new Fixture().roll('Asha', 3, 2).loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('destination')).toHaveTextContent(/Railway/);
    expect(screen.getByText('BUY ₹9,500')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('buy-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'BUY_PROPERTY' }));
    expect(screen.getByTestId('decline-button')).toBeTruthy();
  });

  it('double-tapping BUY sends only one request', async () => {
    const f = new Fixture().roll('Asha', 3, 2).loadAs('Asha');
    api.action.mockImplementation(() => new Promise((r) => setTimeout(() => r(ok(f.snapshot())), 20)));
    const { result } = await renderHook(() => useGameAction());
    await act(async () => {
      await Promise.all([result.current({ type: 'BUY_PROPERTY' }), result.current({ type: 'BUY_PROPERTY' })]);
    });
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('BUY is disabled while an action is in flight', async () => {
    const f = new Fixture().roll('Asha', 3, 2).loadAs('Asha');
    useGameStore.getState().setPending('BUY_PROPERTY');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('buy-button').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });

  it('pay rent: shows owner and amount; shortfall offers loan and bankruptcy', async () => {
    const f = new Fixture();
    f.roll('Asha', 3, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.roll('Bilal', 3, 2).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByText('Owned by Asha')).toBeTruthy();
    expect(screen.getByText('PAY RENT ₹1,000')).toBeTruthy();
    expect(screen.queryByTestId('bankrupt-button')).toBeNull();

    // Same situation, but Bilal is broke.
    const broke = new Fixture();
    broke.roll('Asha', 3, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    broke.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: broke.ids.Asha!, amount: 24500 });
    broke.roll('Bilal', 3, 2).loadAs('Bilal');
    await render(<GameScreen view={viewFor(broke, 'Bilal')} />);
    expect(screen.getByText('You’re ₹500 short.')).toBeTruthy();
    expect(screen.getByTestId('raise-loan')).toBeTruthy();
    expect(screen.getByTestId('bankrupt-button')).toBeTruthy();
    expect(screen.getByTestId('pay-button').props.accessibilityState.disabled).toBe(true);
  });

  it('income tax shows PAY ₹1,000 and END TURN appears after paying', async () => {
    const f = new Fixture().roll('Asha', 2, 2).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(within(screen.getByTestId('payment-card')).getByText('Income Tax')).toBeTruthy();
    expect(screen.getByText('PAY ₹1,000')).toBeTruthy();
    f.act('Asha', { type: 'PAY_TAX' });
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('end-turn-button')).toBeTruthy();
  });

  it('paused game hides actions and offers resume', async () => {
    const f = new Fixture().act('Bilal', { type: 'PAUSE_GAME' }).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    expect(screen.getByTestId('paused-card')).toBeTruthy();
    expect(screen.queryByTestId('roll-button')).toBeNull();
    expect(screen.getByTestId('resume-button')).toBeTruthy();
  });

  it('finished game shows the winner', async () => {
    const f = new Fixture().act('Asha', { type: 'END_GAME' }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('finished-card')).toBeTruthy();
    expect(within(screen.getByTestId('finished-card')).getByText(/wins!/)).toBeTruthy();
  });

  it('undo request asks the counterparty to approve', async () => {
    const f = new Fixture();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 500 });
    f.act('Asha', { type: 'REQUEST_UNDO', targetActionId: f.state.lastUndoable!.actionId }).loadAs('Bilal');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    expect(screen.getByTestId('undo-banner')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('undo-approve'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'APPROVE_UNDO', requestId: f.state.undoRequest!.id }));
  });
});

describe('Auction', () => {
  function auctionFixture(as: string) {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    f.roll('Asha', 3, 2).act('Asha', { type: 'DECLINE_PROPERTY' }).loadAs(as);
    return f;
  }

  it('shows property, minimum bid, BID and PASS', async () => {
    const f = auctionFixture('Bilal');
    api.action.mockResolvedValue(ok(f.snapshot()));
    const auctionId = f.state.auction!.id;
    await render(<AuctionView view={viewFor(f, 'Bilal')} auctionId={auctionId} />);
    expect(screen.getByText('Railway')).toBeTruthy();
    expect(screen.getByText('BID ₹100')).toBeTruthy();
    expect(screen.getByTestId('pass-button')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('bid-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'PLACE_BID', auctionId, amount: 100 }));
  });

  it('leading bidder sees "winning" instead of bid buttons', async () => {
    const f = auctionFixture('Bilal');
    f.act('Bilal', { type: 'PLACE_BID', auctionId: f.state.auction!.id, amount: 3000 }).loadAs('Bilal');
    await render(<AuctionView view={viewFor(f, 'Bilal')} auctionId={f.state.auction!.id} />);
    expect(screen.getByText('You’re winning! 🎉')).toBeTruthy();
    expect(screen.queryByTestId('bid-button')).toBeNull();
    expect(screen.getByTestId('current-bid')).toHaveTextContent('₹3,000');
  });

  it('closed auction shows the result', async () => {
    const f = auctionFixture('Asha');
    const id = f.state.auction!.id;
    f.act('Bilal', { type: 'PLACE_BID', auctionId: id, amount: 3000 });
    f.act('Asha', { type: 'PASS_AUCTION', auctionId: id }).act('Chitra', { type: 'PASS_AUCTION', auctionId: id }).loadAs('Asha');
    await render(<AuctionView view={viewFor(f, 'Asha')} auctionId={id} />);
    expect(screen.getByText('Sold to Bilal')).toBeTruthy();
  });
});

describe('Loan', () => {
  it('shows interest and total, then requests the loan', async () => {
    const f = new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    const send = jest.fn(async () => ({ ok: true }));
    await render(<LoanSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} />);
    await fireEvent.changeText(screen.getByTestId('loan-amount'), '5000');
    expect(screen.getByText('₹5,500')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('loan-confirm'));
    expect(send).toHaveBeenCalledWith({ type: 'REQUEST_LOAN', amount: 5000 }, expect.anything());
  });

  it('rejects amounts off the step before sending', async () => {
    const f = new Fixture().loadAs('Asha');
    const send = jest.fn();
    await render(<LoanSheet visible onClose={jest.fn()} view={viewFor(f, 'Asha')} send={send} />);
    await fireEvent.changeText(screen.getByTestId('loan-amount'), '1234');
    expect(screen.getByText('Steps of ₹500')).toBeTruthy();
    expect(screen.getByTestId('loan-confirm').props.accessibilityState.disabled).toBe(true);
  });
});

describe('Wallet', () => {
  it('shows balance, properties, loans and history in ₹', async () => {
    const f = new Fixture();
    f.roll('Asha', 3, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'REQUEST_LOAN', amount: 2000 }).loadAs('Asha');
    await render(<PlayerView view={viewFor(f, 'Asha')} playerId={f.ids.Asha!} />);
    expect(screen.getByTestId('wallet-balance')).toHaveTextContent('₹17,500');
    expect(screen.getByTestId('property-RAILWAY')).toBeTruthy();
    expect(screen.getByText('Borrowed ₹2,000')).toBeTruthy();
    expect(screen.getByText('Starting cash')).toBeTruthy();
    expect(screen.getByText('−₹9,500')).toBeTruthy();
  });
});

describe('Errors and reconnection', () => {
  it('a rejected action shows a human-readable toast', async () => {
    const f = new Fixture().roll('Asha', 3, 2).loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'ALREADY_OWNED', message: 'That property was already purchased.' } });
    await render(
      <>
        <GameScreen view={viewFor(f, 'Asha')} />
        <NoticeToast />
      </>,
    );
    await fireEvent.press(screen.getByTestId('buy-button'));
    expect(await screen.findByText('That property was already purchased.')).toBeTruthy();
  });

  it('a stale action refetches authoritative state', async () => {
    const f = new Fixture().roll('Asha', 3, 2).loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'STALE_STATE', message: 'The game just changed — check the screen and try again.' } });
    api.state.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('buy-button'));
    await waitFor(() => expect(api.state).toHaveBeenCalled());
  });

  it('network failure retries the same action id, then shows reconnecting', async () => {
    const f = new Fixture().loadAs('Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'Connection lost. Reconnecting…' } });
    await render(
      <>
        <ConnectionBanner />
        <GameScreen view={viewFor(f, 'Asha')} />
      </>,
    );
    await fireEvent.press(screen.getByTestId('roll-button'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(3), { timeout: 5000 });
    const ids = api.action.mock.calls.map((c) => c[1]);
    expect(new Set(ids).size).toBe(1);
    expect((await screen.findAllByText('Connection lost. Reconnecting…')).length).toBeGreaterThan(0);
  }, 10000);

  it('GameGate shows an error state when the game cannot be loaded', async () => {
    useSessionStore.setState({ session: { gameId: 'g-1', playerId: 'p-1', token: 'a'.repeat(64) }, hydrated: true });
    api.state.mockResolvedValue({ ok: false, error: { code: 'GAME_EXPIRED', message: 'This game has expired. Start a new one.' } });
    await render(
      <>
        <GameSyncHost />
        <GameGate gameId="g-1" area="game">
          {() => null}
        </GameGate>
      </>,
    );
    expect(await screen.findByText('This game has expired. Start a new one.')).toBeTruthy();
    expect(screen.getByText('Leave game')).toBeTruthy();
  });

  it('GameGate refuses a game this phone is not part of', async () => {
    await render(<GameGate gameId="other" area="game">{() => null}</GameGate>);
    expect(screen.getByText('Not in this game')).toBeTruthy();
  });

  it('ErrorState renders title and message', async () => {
    await render(<ErrorState title="Oops" message="Try again" />);
    expect(screen.getByText('Oops')).toBeTruthy();
  });
});
