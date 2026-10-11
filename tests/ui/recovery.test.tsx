/// <reference types="jest" />
/**
 * What the phone does when it cannot tell what happened to an action: the request (and every retry
 * of it) was lost on the way, so the server may or may not have carried it out.
 */
import { act, renderHook } from '@testing-library/react-native';
import type { GameAction } from '@/engine/index.ts';
import { useGameAction, type SendResult } from '@/features/game/useGameAction';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;

const lost = (code: 'NETWORK' | 'TIMEOUT' = 'NETWORK') => ({ ok: false as const, error: { code, message: code === 'NETWORK' ? 'Connection lost. Reconnecting…' : 'The server is taking too long. Check your connection.' } });
const refused = (code: string, message = code) => ({ ok: false as const, error: { code, message } }) as never;

async function send(action: GameAction, options?: Parameters<ReturnType<typeof useGameAction>>[1]): Promise<SendResult> {
  const { result } = await renderHook(() => useGameAction());
  let out: SendResult | undefined;
  await act(async () => {
    out = await result.current(action, options);
  });
  return out!;
}

const actionIds = () => api.action.mock.calls.map((c) => c[1]);
const versions = () => api.action.mock.calls.map((c) => c[2]);

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('an action whose outcome is unknown', () => {
  it('committed on the server, response lost: the phone reads the game and shows the result, without sending it again', async () => {
    const f = new Fixture().loadAs('Asha');
    const seen = f.state.version;
    // The roll reaches the server and commits; no response ever comes back, for any of the attempts.
    api.action.mockResolvedValue(lost('TIMEOUT'));
    const after = f.roll('Asha', 1, 2).snapshot();
    api.state.mockResolvedValue(ok(after));

    const result = await send({ type: 'ROLL_DICE' });

    // Not "failed, try again": unknown.
    expect(result).toMatchObject({ ok: false, unknown: true, error: { code: 'TIMEOUT' } });
    // Three attempts, all the same request: one id, one version. The server can apply it at most once.
    expect(api.action).toHaveBeenCalledTimes(3);
    expect(new Set(actionIds()).size).toBe(1);
    expect(versions()).toEqual([seen, seen, seen]);
    // Then one read of the server's state, and the screen shows the committed roll.
    expect(api.state).toHaveBeenCalledTimes(1);
    const store = useGameStore.getState();
    expect(store.snapshot?.state.version).toBe(after.state.version);
    expect(store.snapshot?.state.turn.roll?.total).toBe(3);
    expect(store).toMatchObject({ pendingAction: null, outcomeUnknown: false });
    expect(store.notice).toMatchObject({ kind: 'info' });
    expect(store.notice!.message).toMatch(/up to date/);
  }, 20_000);

  it('while it stays unknown nothing else is sent: a second tap cannot become a second execution', async () => {
    const f = new Fixture().loadAs('Asha');
    const seen = f.state.version;
    const transfer: GameAction = { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 5000 };
    api.action.mockResolvedValue(lost());
    api.state.mockResolvedValue(lost());

    // The transfer commits on the server, but the phone hears nothing back, and cannot read the game either.
    const first = await send(transfer);
    expect(first).toMatchObject({ ok: false, unknown: true });
    expect(api.action).toHaveBeenCalledTimes(3);
    expect(useGameStore.getState()).toMatchObject({ pendingAction: null, outcomeUnknown: true, connection: 'offline' });
    expect(useGameStore.getState().notice).toMatchObject({ kind: 'error' });
    expect(useGameStore.getState().snapshot?.state.version).toBe(seen);

    // The player taps Pay again (and again). The screen is not to be trusted: no request leaves the phone.
    for (let i = 0; i < 3; i += 1) {
      const again = await send(transfer);
      expect(again).toMatchObject({ ok: false, unknown: true, error: { code: 'NETWORK' } });
    }
    expect(api.action).toHaveBeenCalledTimes(3);
    expect(useGameStore.getState()).toMatchObject({ pendingAction: null, outcomeUnknown: true });

    // The connection is back. The next tap first reads the game: the transfer DID go through...
    const committed = f.act('Asha', transfer).snapshot();
    api.state.mockResolvedValue(ok(committed));
    const next = f.roll('Asha', 1, 2).snapshot();
    api.action.mockResolvedValue(ok(next));
    const third = await send({ type: 'ROLL_DICE' });
    expect(third).toEqual({ ok: true });
    // ...and what is sent now is a new request, made against the game as it really stands.
    expect(api.action).toHaveBeenCalledTimes(4);
    expect(versions()[3]).toBe(committed.state.version);
    expect(actionIds()[3]).not.toBe(actionIds()[0]);
    expect(api.action.mock.calls[3]![3]).toEqual({ type: 'ROLL_DICE' });
    const store = useGameStore.getState();
    expect(store).toMatchObject({ pendingAction: null, outcomeUnknown: false });
    expect(store.snapshot?.state.players.find((p) => p.name === 'Asha')!.balance).toBe(20000);
  }, 20_000);

  it('the seat is gone when the phone looks again: a recoverable error, no loop, nothing more sent', async () => {
    new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(lost());
    api.state.mockResolvedValue(refused('FORBIDDEN', 'You are not a player in this game.'));

    const result = await send({ type: 'ROLL_DICE' });
    expect(result).toMatchObject({ ok: false, unknown: true });
    expect(api.action).toHaveBeenCalledTimes(3);
    expect(api.state).toHaveBeenCalledTimes(1);
    const store = useGameStore.getState();
    expect(store.loadError).toMatchObject({ code: 'FORBIDDEN' });
    expect(store).toMatchObject({ pendingAction: null, outcomeUnknown: true });
    // Tapping again asks once more whether the seat is there, and sends no action.
    await send({ type: 'ROLL_DICE' });
    expect(api.action).toHaveBeenCalledTimes(3);
    expect(api.state).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('a silent action (the automatic auction close) recovers the same way without a toast', async () => {
    const f = new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(lost());
    api.state.mockResolvedValue(ok(f.roll('Asha', 1, 2).snapshot()));
    const result = await send({ type: 'ROLL_DICE' }, { silent: true });
    expect(result).toMatchObject({ ok: false, unknown: true });
    expect(useGameStore.getState()).toMatchObject({ notice: null, pendingAction: null, outcomeUnknown: false });
  }, 20_000);
});

describe('an action the server answered', () => {
  it('refused: it is a failure, not an unknown — the button is released and nothing is re-read or re-sent', async () => {
    new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(refused('INSUFFICIENT_FUNDS', 'Not enough money for this purchase.'));
    const result = await send({ type: 'BUY_PROPERTY' });
    expect(result).toEqual({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', message: 'Not enough money for this purchase.' } });
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.state).not.toHaveBeenCalled();
    expect(useGameStore.getState()).toMatchObject({ pendingAction: null, outcomeUnknown: false, notice: { kind: 'error', message: 'Not enough money for this purchase.' } });
  });

  it('stale: the game is read again, the screen is reconciled, and the player is asked to look', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']).loadAs('Asha');
    const seen = f.state.version;
    api.action.mockResolvedValue(refused('STALE_STATE', 'The game just changed — check the screen and try again.'));
    const moved = f.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Chitra!, amount: 10 }).snapshot();
    api.state.mockResolvedValue(ok(moved));
    const result = await send({ type: 'ROLL_DICE' });
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    expect((result as { unknown?: boolean }).unknown).toBeUndefined();
    expect(api.action).toHaveBeenCalledTimes(1);
    const store = useGameStore.getState();
    expect(store.snapshot?.state.version).toBe(moved.state.version);
    expect(store.snapshot?.state.version).toBeGreaterThan(seen);
    expect(store).toMatchObject({ pendingAction: null, outcomeUnknown: false, notice: { kind: 'info' } });
  });

  it('one lost attempt and then an answer is simply a success: one id, applied once', async () => {
    const f = new Fixture().loadAs('Asha');
    const after = f.roll('Asha', 1, 2).snapshot();
    api.action.mockResolvedValueOnce(lost()).mockResolvedValue({ ...ok(after), duplicate: true });
    const result = await send({ type: 'ROLL_DICE' });
    expect(result).toEqual({ ok: true });
    expect(api.action).toHaveBeenCalledTimes(2);
    expect(new Set(actionIds()).size).toBe(1);
    expect(api.state).not.toHaveBeenCalled();
    expect(useGameStore.getState()).toMatchObject({ pendingAction: null, outcomeUnknown: false });
    expect(useGameStore.getState().snapshot?.state.version).toBe(after.state.version);
  }, 20_000);

  it('repeated taps while a request is in flight send one request', async () => {
    const f = new Fixture().loadAs('Asha');
    let answer: (v: unknown) => void = () => undefined;
    api.action.mockReturnValue(new Promise((r) => (answer = r)) as never);
    const { result } = await renderHook(() => useGameAction());
    const taps: Promise<SendResult>[] = [];
    await act(async () => {
      for (let i = 0; i < 5; i += 1) taps.push(result.current({ type: 'ROLL_DICE' }));
    });
    expect(api.action).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(ok(f.roll('Asha', 1, 2).snapshot()));
      await Promise.all(taps);
    });
    const results = await Promise.all(taps);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().pendingAction).toBeNull();
  });

  it('leaving the game forgets an unknown outcome: the next game starts clean', async () => {
    new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(lost());
    api.state.mockResolvedValue(lost());
    await send({ type: 'ROLL_DICE' });
    expect(useGameStore.getState().outcomeUnknown).toBe(true);
    let nextId = '';
    await act(async () => {
      nextId = new Fixture(['Dev', 'Esha']).loadAs('Dev').state.id;
    });
    expect(useGameStore.getState()).toMatchObject({ gameId: nextId, outcomeUnknown: false, pendingAction: null });
  }, 20_000);
});
