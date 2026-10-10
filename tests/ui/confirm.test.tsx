/// <reference types="jest" />
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
import { ConfirmDialog } from '@/components/ui';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import Settings from '../../app/settings';
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

/** The Modal a dialog lives in (the Android back button reaches it as onRequestClose). */
function modalOf(testID: string) {
  let node = screen.getByTestId(testID).parent;
  while (node && node.type !== 'Modal') node = node.parent;
  return node!;
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('ConfirmDialog', () => {
  const base = { visible: true, title: 'Request undo?', message: 'Another player must approve this request.', confirmTitle: 'Request undo', testID: 'dlg' };

  it('shows title, summary, message, detail and both actions; each button calls only its own handler', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await render(<ConfirmDialog {...base} summary="Asha paid Bilal ₹500" detail="Nothing changes until then." onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByTestId('dlg');
    expect(within(dialog).getByRole('header')).toHaveTextContent('Request undo?');
    expect(screen.getByTestId('dlg-summary')).toHaveTextContent('Asha paid Bilal ₹500');
    expect(within(dialog).getByText('Another player must approve this request.')).toBeTruthy();
    expect(within(dialog).getByText('Nothing changes until then.')).toBeTruthy();
    expect(screen.getByTestId('dlg-cancel')).toHaveTextContent('Cancel');
    expect(screen.getByTestId('dlg-confirm')).toHaveTextContent('Request undo');
    await fireEvent.press(screen.getByTestId('dlg-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('dlg-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('backdrop and Android back cancel; nothing renders when not visible', async () => {
    const onCancel = jest.fn();
    const view = await render(<ConfirmDialog {...base} onConfirm={jest.fn()} onCancel={onCancel} />);
    await fireEvent.press(screen.getByTestId('dlg-backdrop', { includeHiddenElements: true }));
    await fireEvent(modalOf('dlg'), 'requestClose');
    expect(onCancel).toHaveBeenCalledTimes(2);
    await view.rerender(<ConfirmDialog {...base} visible={false} onConfirm={jest.fn()} onCancel={onCancel} />);
    expect(screen.queryByTestId('dlg')).toBeNull();
  });

  it('while loading: confirm is busy, and no button, backdrop or back press does anything', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await render(<ConfirmDialog {...base} loading onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByTestId('dlg-confirm').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(screen.getByTestId('dlg-cancel').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByTestId('dlg-confirm'));
    await fireEvent.press(screen.getByTestId('dlg-cancel'));
    await fireEvent.press(screen.getByTestId('dlg-backdrop', { includeHiddenElements: true }));
    await fireEvent(modalOf('dlg'), 'requestClose');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('an error is announced inside the dialog; long text is never cut', async () => {
    const long = 'A very long explanation of what will happen. '.repeat(12).trim();
    await render(<ConfirmDialog {...base} destructive summary={long} message={long} error="That action can no longer be undone." onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('That action can no longer be undone.');
    for (const text of screen.getAllByText(long)) expect(text.props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('dlg-confirm').props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe('Undo request confirmation (More sheet)', () => {
  async function setup() {
    const f = new Fixture();
    f.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal!, amount: 500 }).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('request-undo'));
    return f;
  }

  it('shows the real transaction and an accurate explanation; Cancel asks nothing and returns to the same More sheet', async () => {
    const f = await setup();
    const dialog = screen.getByTestId('undo-dialog');
    expect(within(dialog).getByText('Request undo?')).toBeTruthy();
    expect(screen.getByTestId('undo-dialog-summary')).toHaveTextContent(f.state.undoStack.at(-1)!.description);
    expect(screen.getByTestId('undo-dialog-summary')).toHaveTextContent(/Asha.*Bilal.*₹500/);
    expect(dialog).toHaveTextContent(/Another player must approve this request\./);
    expect(dialog).toHaveTextContent(/If approved, it is reversed with a new transaction\. Nothing changes until then\./);
    expect(screen.getByTestId('undo-dialog-confirm')).toHaveTextContent('Request undo');
    await fireEvent.press(screen.getByTestId('undo-dialog-cancel'));
    expect(screen.queryByTestId('undo-dialog')).toBeNull();
    expect(screen.getByTestId('sheet-more')).toBeTruthy();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
    // Android back on the dialog closes the dialog only.
    await fireEvent.press(screen.getByTestId('request-undo'));
    await fireEvent(modalOf('undo-dialog'), 'requestClose');
    expect(screen.queryByTestId('undo-dialog')).toBeNull();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
  });

  it('rapid taps send exactly one request; it spins while sending, then closes back to the table', async () => {
    const f = await setup();
    const target = f.state.undoStack.at(-1)!.actionId;
    f.act('Asha', { type: 'REQUEST_UNDO', targetActionId: target });
    let finish!: (v: ReturnType<typeof ok>) => void;
    api.action.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const confirm = () => screen.getByTestId('undo-dialog-confirm');
    // Not awaited: the press settles only when the request does.
    const first = fireEvent.press(confirm());
    await waitFor(() => expect(confirm().props.accessibilityState).toMatchObject({ busy: true }));
    await fireEvent.press(confirm());
    await fireEvent.press(confirm());
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'REQUEST_UNDO', targetActionId: target });
    expect(confirm().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    await fireEvent.press(screen.getByTestId('undo-dialog-cancel'));
    expect(screen.getByTestId('undo-dialog')).toBeTruthy(); // can't be dismissed mid-request
    await act(async () => finish(ok(f.snapshot())));
    await first;
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(screen.queryByTestId('sheet-more')).toBeNull();
    expect(api.action).toHaveBeenCalledTimes(1);
    // Asked, not undone: the money has not moved back.
    expect(useGameStore.getState().snapshot!.state.undoRequest).toMatchObject({ targetActionId: target });
    expect(useGameStore.getState().snapshot!.state.players.map((p) => p.balance)).toEqual([24500, 25500]);
  });

  it('a refused request keeps the dialog open with the reason, and can be retried', async () => {
    const f = await setup();
    api.action.mockResolvedValueOnce({ ok: false, error: { code: 'UNDO_NOT_ALLOWED', message: 'Nobody is available to approve.' } });
    await fireEvent.press(screen.getByTestId('undo-dialog-confirm'));
    expect(await screen.findByTestId('undo-dialog-error')).toHaveTextContent('Nobody is available to approve.');
    expect(screen.getByTestId('undo-dialog')).toBeTruthy();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
    expect(screen.getByTestId('undo-dialog-confirm').props.accessibilityState).toMatchObject({ disabled: false });

    f.act('Asha', { type: 'REQUEST_UNDO', targetActionId: f.state.undoStack.at(-1)!.actionId });
    api.action.mockResolvedValueOnce(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('undo-dialog-confirm'));
    await waitFor(() => expect(screen.queryByTestId('undo-dialog')).toBeNull());
    expect(api.action).toHaveBeenCalledTimes(2);
  });

  it('closing the More sheet drops the confirmation: it does not come back when More is reopened', async () => {
    await setup();
    await fireEvent.press(within(screen.getByTestId('sheet-more')).getAllByLabelText('Close')[0]!);
    expect(screen.queryByTestId('undo-dialog')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.getByTestId('more-actions')).toBeTruthy();
    expect(screen.queryByTestId('undo-dialog')).toBeNull();
  });
});

describe('Other confirmations use the same dialog', () => {
  function broke() {
    const f = new Fixture();
    f.roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: f.ids.Asha!, amount: 24500 });
    return f.roll('Bilal', 1, 2).loadAs('Bilal');
  }

  it('bankruptcy: Cancel declares nothing; Declare sends DECLARE_BANKRUPTCY once', async () => {
    const f = broke();
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('turn-choose'));
    await fireEvent.press(screen.getByTestId('bankrupt-button'));
    const dialog = screen.getByTestId('bankrupt-dialog');
    expect(dialog).toHaveTextContent(/Declare bankruptcy\?.*Your cash goes to the creditor and your properties return to the bank\..*You leave the game\./);
    await fireEvent.press(screen.getByTestId('bankrupt-dialog-cancel'));
    expect(screen.queryByTestId('bankrupt-dialog')).toBeNull();
    expect(screen.getByTestId('bankrupt-button')).toBeTruthy(); // still on the same decision sheet
    expect(api.action).not.toHaveBeenCalled();

    f.act('Bilal', { type: 'DECLARE_BANKRUPTCY' });
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('bankrupt-button'));
    await fireEvent.press(screen.getByTestId('bankrupt-dialog-confirm'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'DECLARE_BANKRUPTCY' }));
    await waitFor(() => expect(screen.queryByTestId('bankrupt-dialog')).toBeNull());
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('accepting a trade: the dialog repeats both sides; Cancel accepts nothing and keeps the offer', async () => {
    const f = new Fixture().roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' }).act('Asha', { type: 'END_TURN' });
    f.act('Asha', { type: 'CREATE_TRADE', toPlayerId: f.ids.Bilal!, offeredPropertyKeys: ['RAILWAY'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 6000 }).loadAs('Bilal');
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    await fireEvent.press(screen.getByTestId('context-cta'));
    await fireEvent.press(screen.getByTestId('trade-accept'));
    expect(screen.getByTestId('trade-accept-dialog-summary')).toHaveTextContent(/You get Railway.*You give ₹6,000/s);
    await fireEvent.press(screen.getByTestId('trade-accept-dialog-cancel'));
    expect(screen.queryByTestId('trade-accept-dialog')).toBeNull();
    expect(screen.getByTestId('trade-incoming')).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('leaving a game: Cancel keeps the session; Leave game forgets it and goes home', async () => {
    new Fixture().loadAs('Asha');
    await render(<Settings />);
    expect(screen.queryByTestId('leave-dialog')).toBeNull();
    await fireEvent.press(screen.getByTestId('leave-game'));
    expect(screen.getByTestId('leave-dialog')).toHaveTextContent(/Leave game\?.*This phone will forget the game\..*You can’t rejoin as the same player\./);
    await fireEvent.press(screen.getByTestId('leave-dialog-cancel'));
    expect(screen.queryByTestId('leave-dialog')).toBeNull();
    expect(useSessionStore.getState().session).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('leave-game'));
    await fireEvent.press(screen.getByTestId('leave-dialog-confirm'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(useSessionStore.getState().session).toBeNull();
    expect(useGameStore.getState().snapshot).toBeNull();
  });
});
