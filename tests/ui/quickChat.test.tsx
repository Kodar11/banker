/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { GameScreen } from '@/features/game/GameScreen';
import { leaveGame } from '@/features/game/leaveGame';
import { GameSyncHost } from '@/features/game/sync';
import type { GameView } from '@/features/game/useGameView';
import { clearQuickChat, QUICK_CHAT_VISIBLE_MS, receiveQuickChat, useQuickChatStore } from '@/features/quickChat/quickChatStore';
import { gameApi } from '@/lib/gameApi';
import type { GameChannelHandlers } from '@/lib/realtime';
import { subscribeToGame } from '@/lib/realtime';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import {
  netWorth,
  outstandingDebt,
  QUICK_CHAT_COOLDOWN_MS,
  QUICK_MESSAGE_GROUPS,
  QUICK_MESSAGES,
  QUICK_REACTIONS,
  QuickChatEventSchema,
  QuickChatRequestSchema,
  type QuickChatEvent,
  type QuickChatItem,
} from '@/engine/index.ts';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const subscribe = subscribeToGame as jest.Mock;

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

let n = 0;
const eventId = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** An event as the server broadcasts it. */
function eventFrom(f: Fixture, name: string, item: QuickChatItem, over: Partial<QuickChatEvent> = {}): QuickChatEvent {
  return { v: 1, id: eventId(), gameId: f.state.id, playerId: f.ids[name]!, ...item, at: new Date().toISOString(), ...over } as QuickChatEvent;
}

/** The server accepts whatever this phone sends, and answers with the event it broadcast. */
function serverAccepts(f: Fixture) {
  api.chat.mockImplementation(async (c, id, item) => ({ ok: true, event: { v: 1, id, gameId: f.state.id, playerId: c.playerId, ...item, at: new Date().toISOString() } as QuickChatEvent }));
}

/** Every host element type under `node` (the sheet's own tree). */
function typesUnder(node: { type?: unknown; children?: unknown[] }): string[] {
  return [String(node.type), ...(node.children ?? []).flatMap((c) => (typeof c === 'object' && c !== null ? typesUnder(c as { type?: unknown; children?: unknown[] }) : []))];
}

const grid = () => fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });

beforeEach(() => {
  jest.clearAllMocks();
  clearQuickChat();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the catalogue', () => {
  it('is exactly eight reactions and twelve messages in three groups, each with its own id', () => {
    expect(QUICK_REACTIONS.map((r) => `${r.emoji} ${r.label}`)).toEqual(['😂 Funny', '😏 Sneaky move', '😮 Unexpected', '😭 Unlucky', '🔥 Great move', '👏 Respect', '🤝 Deal?', '💸 Money gone']);
    expect(QUICK_MESSAGE_GROUPS.map((g) => [g.title, g.messages.map((m) => m.text)])).toEqual([
      ['😈 Teasing', ['Bro is broke 💸', 'Skill issue 😂', 'Nice try! 😏', 'RIP your wallet 💀']],
      ['💰 Deals & negotiation', ['Deal or no deal? 🤝', 'Make me an offer!', "That's too expensive!", 'Come on, help me out 😂']],
      ['🎲 Game moments', ["I'm coming for you 😈", 'Lucky roll! 🍀', 'You got lucky! 🙄', "It's over for you 💀"]],
    ]);
    expect(new Set([...QUICK_REACTIONS, ...QUICK_MESSAGES].map((i) => i.key)).size).toBe(20);
  });

  it('the wire format takes catalogue ids only: no text, no extra fields, no id of the other kind', () => {
    const base = { op: 'chat', gameId: eventId(), playerId: eventId(), token: 'a'.repeat(64), eventId: eventId() };
    expect(QuickChatRequestSchema.safeParse({ ...base, kind: 'reaction', key: 'funny' }).success).toBe(true);
    expect(QuickChatRequestSchema.safeParse({ ...base, kind: 'preset_message', key: 'skill_issue' }).success).toBe(true);
    for (const bad of [
      { ...base, kind: 'reaction', key: 'skill_issue' },
      { ...base, kind: 'preset_message', key: 'funny' },
      { ...base, kind: 'preset_message', key: 'hello there' },
      { ...base, kind: 'text', key: 'funny' },
      { ...base, kind: 'reaction', key: 'funny', text: 'anything I like' },
      { ...base, kind: 'reaction', key: 'funny', senderId: eventId() },
      { ...base, kind: 'reaction' },
    ]) {
      expect(QuickChatRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(QuickChatEventSchema.safeParse({ v: 2, id: eventId(), gameId: eventId(), playerId: eventId(), kind: 'reaction', key: 'funny', at: 'now' }).success).toBe(false);
  });
});

describe('Chat / React button', () => {
  it('sits where Pay Money was: third in the top row, with its own icon; Transfer and Auction are untouched', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await grid();
    const buttons = within(screen.getByTestId('action-bar-grid')).getAllByRole('button');
    expect(buttons.map((b) => b.props.testID)).toEqual(['open-properties', 'open-trade', 'open-chat', 'open-loan', 'open-auction', 'open-more']);
    expect(buttons.map((b) => b.props.accessibilityLabel)).toEqual(['My Properties', 'Transfer', 'Chat / React', 'Bank / Loan', 'Auction', 'More']);
    expect(within(screen.getByTestId('open-chat')).getByTestId('action-icon-chat')).toBeTruthy();
    expect(screen.queryByTestId('open-pay')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-trade'));
    expect(screen.getByTestId('trade-sheet')).toBeTruthy();
  });

  it('Pay Money is still there — in More, and on another player’s sheet — and still pays', async () => {
    const f = new Fixture().loadAs('Asha');
    api.action.mockResolvedValue(ok(f.snapshot()));
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await grid();
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('more-pay'));
    expect(screen.getByTestId('pay-sheet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('pay-to-Bilal'));
    await fireEvent.changeText(screen.getByTestId('pay-amount'), '500');
    await fireEvent.press(screen.getByTestId('pay-confirm'));
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'TRANSFER_MONEY', toPlayerId: f.ids.Bilal, amount: 500 });
    expect(api.chat).not.toHaveBeenCalled();
  });

  it('on a screen too short for the grid it is in More, and opens the same sheet', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 360, height: 568 } } });
    expect(screen.getByTestId('action-bar-compact')).toBeTruthy();
    expect(screen.queryByTestId('open-chat')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-more'));
    await fireEvent.press(screen.getByTestId('more-chat'));
    expect(screen.getByTestId('chat-sheet')).toBeTruthy();
    expect(screen.queryByTestId('sheet-more')).toBeNull();
    expect(screen.getAllByTestId(/^chat-(reaction|message)-/)).toHaveLength(20);
  });

  it('is not offered when there is nothing to play: a paused game and a finished one show no chat button', async () => {
    const paused = new Fixture().act('Bilal', { type: 'PAUSE_GAME' }).loadAs('Asha');
    const first = await render(<GameScreen view={viewFor(paused, 'Asha')} />);
    expect(screen.queryByTestId('open-chat')).toBeNull();
    await first.unmount();
    const over = new Fixture().act('Asha', { type: 'END_GAME' }).loadAs('Asha');
    await render(<GameScreen view={viewFor(over, 'Asha')} />);
    expect(screen.queryByTestId('open-chat')).toBeNull();
  });
});

describe('the sheet', () => {
  async function openSheet(name = 'Asha', names?: string[]) {
    const f = new Fixture(names).loadAs(name);
    serverAccepts(f);
    await render(<GameScreen view={viewFor(f, name)} />);
    await grid();
    await fireEvent.press(screen.getByTestId('open-chat'));
    return f;
  }

  it('opening it sends nothing; reactions and messages are both there at once, with no tabs and nowhere to type', async () => {
    await openSheet();
    const sheet = screen.getByTestId('chat-sheet');
    expect(api.chat).not.toHaveBeenCalled();
    expect(within(sheet).getByText('Chat & React')).toBeTruthy();
    expect(within(sheet).getByText('Quick Reactions')).toBeTruthy();
    expect(within(sheet).getByText('Quick Messages')).toBeTruthy();
    for (const r of QUICK_REACTIONS) {
      const button = within(sheet).getByTestId(`chat-reaction-${r.key}`);
      // The emoji, and what it means underneath.
      expect(button).toHaveTextContent(`${r.emoji}${r.label}`);
      expect(button.props.accessibilityLabel).toBe(`${r.label} reaction`);
    }
    for (const g of QUICK_MESSAGE_GROUPS) {
      const group = within(sheet).getByTestId(`chat-group-${g.key}`);
      expect(within(group).getByText(g.title)).toBeTruthy();
      // Whole messages: the text is never cut to one line.
      for (const m of g.messages) expect(within(group).getByText(m.text).props.numberOfLines).toBeUndefined();
    }
    expect(within(sheet).queryAllByRole('tab')).toHaveLength(0);
    expect(within(sheet).queryByRole('tablist')).toBeNull();
    expect(typesUnder(sheet)).not.toContain('TextInput');
    expect(screen.queryByTestId('chat-cooldown')).toBeNull();
  });

  it('fits a small screen: capped height, scrolling content, bottom safe area, touch targets of 44px or more', async () => {
    await openSheet();
    const sheet = screen.getByTestId('chat-sheet');
    expect(sheet.props.className).toMatch(/max-h-\[85%\]/);
    expect(sheet.props.edges).toMatchObject({ bottom: 'additive' });
    expect(typesUnder(sheet).some((t) => t.includes('ScrollView'))).toBe(true);
    for (const r of QUICK_REACTIONS) expect(screen.getByTestId(`chat-reaction-${r.key}`).props.className.split(' ')).toContain('h-16');
    for (const m of QUICK_MESSAGES) expect(screen.getByTestId(`chat-message-${m.key}`).props.className.split(' ')).toContain('min-h-[48px]');
  });

  it('one tap on a reaction sends it — as this player, to this game, by id — and closes the sheet', async () => {
    const f = await openSheet();
    await fireEvent.press(screen.getByTestId('chat-reaction-great_move'));
    expect(api.chat).toHaveBeenCalledTimes(1);
    const [credentials, id, item] = api.chat.mock.calls[0]!;
    expect(credentials).toMatchObject({ gameId: f.state.id, playerId: f.ids.Asha });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item).toEqual({ kind: 'reaction', key: 'great_move' });
    expect(screen.queryByTestId('chat-sheet')).toBeNull();
    // On my own chip straight away, from the server's answer.
    expect(await screen.findByTestId(`chip-reaction-${f.ids.Asha}`)).toHaveTextContent('🔥');
  });

  it('one tap on a message sends it and closes the sheet; it shows as a bubble with my name on it', async () => {
    const f = await openSheet();
    await fireEvent.press(screen.getByTestId('chat-message-too_expensive'));
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(api.chat.mock.calls[0]![2]).toEqual({ kind: 'preset_message', key: 'too_expensive' });
    expect(screen.queryByTestId('chat-sheet')).toBeNull();
    expect(await screen.findByTestId(`chat-bubble-${f.ids.Asha}`)).toHaveTextContent("You: That's too expensive!");
  });

  it('closing it — the ✕, the backdrop or Android back — sends nothing, and it opens again as new', async () => {
    await openSheet();
    await fireEvent.press(screen.getAllByLabelText('Close')[0]!);
    expect(screen.queryByTestId('chat-sheet')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-chat'));
    await fireEvent.press(screen.getAllByLabelText('Close')[1]!);
    expect(screen.queryByTestId('chat-sheet')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-chat'));
    // Android back: the event reaches the sheet's Modal.
    await fireEvent(screen.getByTestId('chat-sheet'), 'requestClose');
    expect(screen.queryByTestId('chat-sheet')).toBeNull();
    expect(api.chat).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('open-chat'));
    expect(screen.getAllByTestId(/^chat-(reaction|message)-/)).toHaveLength(20);
    expect(screen.queryByTestId('chat-cooldown')).toBeNull();
  });

  it('two seconds between sends, reactions and messages alike: a tap inside them is not sent and says why', async () => {
    jest.useFakeTimers();
    await openSheet();
    await fireEvent.press(screen.getByTestId('chat-reaction-funny'));
    expect(api.chat).toHaveBeenCalledTimes(1);
    // Straight back in, and a message this time: the same cooldown.
    await fireEvent.press(screen.getByTestId('open-chat'));
    expect(screen.queryByTestId('chat-cooldown')).toBeNull();
    await fireEvent.press(screen.getByTestId('chat-message-nice_try'));
    await fireEvent.press(screen.getByTestId('chat-reaction-respect'));
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-cooldown')).toHaveTextContent(/One at a time/);
    // The sheet is not frozen: it still closes and reopens.
    expect(screen.getByTestId('chat-sheet')).toBeTruthy();
    await act(async () => void jest.advanceTimersByTime(QUICK_CHAT_COOLDOWN_MS));
    expect(screen.queryByTestId('chat-cooldown')).toBeNull();
    await fireEvent.press(screen.getByTestId('chat-message-nice_try'));
    expect(api.chat).toHaveBeenCalledTimes(2);
    expect(api.chat.mock.calls[1]![2]).toEqual({ kind: 'preset_message', key: 'nice_try' });
  });

  it('the server has the last word on the cooldown: its refusal is a quiet note, and nothing is shown', async () => {
    const f = await openSheet();
    api.chat.mockResolvedValue({ ok: false, error: { code: 'COOLDOWN', message: 'One at a time. Try again in a moment.', retryAfterMs: 1500 } });
    await fireEvent.press(screen.getByTestId('chat-reaction-funny'));
    await waitFor(() => expect(useGameStore.getState().notice).toMatchObject({ kind: 'info', message: 'One at a time. Try again in a moment.' }));
    expect(useQuickChatStore.getState().shown).toEqual({});
    expect(useGameStore.getState().snapshot!.state.version).toBe(f.state.version);
  });

  it('a send that fails (no connection) is a quiet note; the game is untouched and still playable', async () => {
    const f = await openSheet();
    const before = useGameStore.getState().snapshot;
    api.chat.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'Connection lost. Reconnecting…' } });
    await fireEvent.press(screen.getByTestId('chat-message-lucky_roll'));
    await waitFor(() => expect(useGameStore.getState().notice).toMatchObject({ kind: 'info', message: 'That could not be sent. The game carries on.' }));
    expect(useGameStore.getState().snapshot).toBe(before);
    expect(useGameStore.getState().pendingAction).toBeNull();
    expect(api.state).not.toHaveBeenCalled();
    api.action.mockResolvedValue(ok(f.snapshot()));
    await fireEvent.press(screen.getByTestId('roll-button'));
    await waitFor(() => expect(api.action.mock.calls[0]![3]).toEqual({ type: 'ROLL_DICE' }));
  });
});

describe('what the table shows', () => {
  it('a reaction pops on its sender’s chip and is gone in under three seconds; players react independently', async () => {
    jest.useFakeTimers();
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await act(async () => void receiveQuickChat(f.state.id, eventFrom(f, 'Bilal', { kind: 'reaction', key: 'funny' })));
    await act(async () => void jest.advanceTimersByTime(1000));
    await act(async () => void receiveQuickChat(f.state.id, eventFrom(f, 'Chitra', { kind: 'reaction', key: 'unlucky' })));
    const bilal = screen.getByTestId(`chip-reaction-${f.ids.Bilal}`);
    expect(bilal).toHaveTextContent('😂');
    expect(bilal.props.pointerEvents).toBe('none');
    // Inside the chip: nothing is added to the board, and the chip still opens the player.
    expect(within(screen.getByTestId(`player-chip-${f.ids.Bilal}`)).getByTestId(`chip-reaction-${f.ids.Bilal}`)).toBeTruthy();
    expect(within(screen.getByTestId('classic-board')).queryAllByTestId(/^chip-reaction-|^chat-bubble-/)).toHaveLength(0);
    expect(screen.getByTestId(`chip-reaction-${f.ids.Chitra}`)).toHaveTextContent('😭');
    expect(screen.queryByTestId(`chip-reaction-${f.ids.Asha}`)).toBeNull();
    expect(QUICK_CHAT_VISIBLE_MS).toBeGreaterThanOrEqual(2000);
    expect(QUICK_CHAT_VISIBLE_MS).toBeLessThanOrEqual(3000);
    await act(async () => void jest.advanceTimersByTime(QUICK_CHAT_VISIBLE_MS - 1000));
    expect(screen.queryByTestId(`chip-reaction-${f.ids.Bilal}`)).toBeNull();
    expect(screen.getByTestId(`chip-reaction-${f.ids.Chitra}`)).toBeTruthy();
    await act(async () => void jest.advanceTimersByTime(1000));
    expect(screen.queryByTestId(`chip-reaction-${f.ids.Chitra}`)).toBeNull();
    expect(useQuickChatStore.getState().shown).toEqual({});
  });

  it('a message is a bubble above the player strip, naming its sender; never more than two at once, and none takes a touch', async () => {
    jest.useFakeTimers();
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    await act(async () => {
      receiveQuickChat(f.state.id, eventFrom(f, 'Asha', { kind: 'preset_message', key: 'make_an_offer' }, { at: at(-30) }));
      receiveQuickChat(f.state.id, eventFrom(f, 'Bilal', { kind: 'preset_message', key: 'help_me_out' }, { at: at(-20) }));
      receiveQuickChat(f.state.id, eventFrom(f, 'Chitra', { kind: 'preset_message', key: 'its_over' }, { at: at(-10) }));
    });
    const layer = screen.getByTestId('chat-bubbles');
    expect(layer.props.pointerEvents).toBe('none');
    expect(layer.props.style).toMatchObject({ position: 'absolute', bottom: '100%' });
    // Anchored to the strip, not the board.
    expect(within(screen.getByTestId('game-top')).getByTestId('chat-bubbles')).toBeTruthy();
    expect(screen.queryByTestId(`chat-bubble-${f.ids.Asha}`)).toBeNull(); // the oldest gave way
    expect(screen.getByTestId(`chat-bubble-${f.ids.Bilal}`)).toHaveTextContent('Bilal: Come on, help me out 😂');
    expect(screen.getByTestId(`chat-bubble-${f.ids.Chitra}`)).toHaveTextContent("Chitra: It's over for you 💀");
    // Every sender's chip still says they spoke.
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(screen.getByTestId(`chip-reaction-${f.ids[name]}`)).toHaveTextContent('💬');
    await act(async () => void jest.advanceTimersByTime(QUICK_CHAT_VISIBLE_MS));
    expect(screen.queryByTestId('chat-bubbles')).toBeNull();
  });
});

describe('what a phone accepts', () => {
  const funny: QuickChatItem = { kind: 'reaction', key: 'funny' };

  it('only well-formed events from the catalogue, for this game, from a player at this table', () => {
    const f = new Fixture().loadAs('Asha');
    const other = new Fixture(['Dev', 'Esha']);
    const good = eventFrom(f, 'Bilal', funny);
    for (const bad of [
      null,
      'hello',
      {},
      { ...good, id: 'not-a-uuid' },
      { ...good, key: 'made_up' },
      { ...good, kind: 'text', key: 'anything' },
      { ...good, kind: 'preset_message' }, // a reaction's id sent as a message
      { ...good, v: 2 },
      { ...good, text: 'free text' },
      { ...good, at: 'yesterday' },
      { ...good, gameId: other.state.id }, // another game's event on this channel
      eventFrom(other, 'Dev', funny), // …and a player who is not here
      { ...good, playerId: other.ids.Dev },
    ]) {
      expect(receiveQuickChat(f.state.id, bad)).toBe(false);
    }
    // An event for a game this phone is not attached to (a channel of a game it left).
    expect(receiveQuickChat(other.state.id, eventFrom(other, 'Dev', funny))).toBe(false);
    expect(useQuickChatStore.getState().shown).toEqual({});
    expect(receiveQuickChat(f.state.id, good)).toBe(true);
  });

  it('the same event is shown once — my own echo and the broadcast of it, or a repeat delivery', () => {
    jest.useFakeTimers();
    const f = new Fixture().loadAs('Asha');
    const event = eventFrom(f, 'Bilal', funny);
    expect(receiveQuickChat(f.state.id, event)).toBe(true);
    jest.advanceTimersByTime(QUICK_CHAT_VISIBLE_MS - 100);
    expect(receiveQuickChat(f.state.id, { ...event })).toBe(false);
    // The repeat did not restart its time on screen.
    jest.advanceTimersByTime(100);
    expect(useQuickChatStore.getState().shown).toEqual({});
    expect(receiveQuickChat(f.state.id, { ...event })).toBe(false);
  });

  it('old events are not replayed: one that arrives long after it was sent is dropped', () => {
    const f = new Fixture().loadAs('Asha');
    expect(receiveQuickChat(f.state.id, eventFrom(f, 'Bilal', funny, { at: new Date(Date.now() - 60_000).toISOString() }))).toBe(false);
    expect(useQuickChatStore.getState().shown).toEqual({});
  });

  it('a busy table stays bounded: one slot per player, whatever arrives', () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']).loadAs('Asha');
    for (let i = 0; i < 200; i += 1) receiveQuickChat(f.state.id, eventFrom(f, ['Asha', 'Bilal', 'Chitra'][i % 3]!, funny));
    expect(Object.keys(useQuickChatStore.getState().shown)).toHaveLength(3);
  });
});

describe('realtime and lifecycle', () => {
  const channel = () => subscribe.mock.calls.at(-1)![2] as GameChannelHandlers;

  beforeEach(() => {
    api.state.mockResolvedValue({ ok: false, error: { code: 'NETWORK', message: 'offline' } });
  });

  it('events arrive on the game’s one channel; they never touch the snapshot, the version or the server', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(
      <>
        <GameSyncHost />
        <GameScreen view={viewFor(f, 'Asha')} />
      </>,
    );
    expect(subscribe).toHaveBeenCalledTimes(1); // no second subscription for chat
    expect(subscribe.mock.calls[0]![0]).toBe(f.state.id);
    const before = useGameStore.getState().snapshot;
    const calls = api.state.mock.calls.length;
    await act(async () => channel().onChat!(eventFrom(f, 'Bilal', { kind: 'reaction', key: 'respect' })));
    expect(screen.getByTestId(`chip-reaction-${f.ids.Bilal}`)).toHaveTextContent('👏');
    expect(useGameStore.getState().snapshot).toBe(before);
    expect(api.state.mock.calls.length).toBe(calls);
    expect(api.action).not.toHaveBeenCalled();
    // Rubbish on the channel is ignored, and the state pings beside it still work.
    await act(async () => channel().onChat!({ nonsense: true }));
    expect(Object.keys(useQuickChatStore.getState().shown)).toEqual([f.ids.Bilal]);
  });

  it('my own send and the broadcast of it show one reaction, not two', async () => {
    const f = new Fixture().loadAs('Asha');
    serverAccepts(f);
    await render(
      <>
        <GameSyncHost />
        <GameScreen view={viewFor(f, 'Asha')} />
      </>,
    );
    await grid();
    await fireEvent.press(screen.getByTestId('open-chat'));
    await fireEvent.press(screen.getByTestId('chat-reaction-deal'));
    await screen.findByTestId(`chip-reaction-${f.ids.Asha}`);
    const mine = useQuickChatStore.getState().shown[f.ids.Asha!]!;
    let shownAgain = true;
    await act(async () => {
      shownAgain = receiveQuickChat(f.state.id, { ...mine });
      channel().onChat!({ ...mine });
    });
    expect(shownAgain).toBe(false);
    expect(screen.getAllByTestId(`chip-reaction-${f.ids.Asha}`)).toHaveLength(1);
  });

  it('leaving the game clears what was on screen, and a late event from the old game shows nowhere', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameSyncHost />);
    const old = channel();
    await act(async () => old.onChat!(eventFrom(f, 'Bilal', { kind: 'preset_message', key: 'skill_issue' })));
    expect(Object.keys(useQuickChatStore.getState().shown)).toEqual([f.ids.Bilal]);
    await act(async () => leaveGame());
    expect(useQuickChatStore.getState().shown).toEqual({});
    // A new game on this phone; the old channel's handler fires late.
    const next = new Fixture(['Asha', 'Dev']).loadAs('Asha');
    await act(async () => old.onChat!(eventFrom(f, 'Bilal', { kind: 'reaction', key: 'funny' })));
    await act(async () => void receiveQuickChat(f.state.id, eventFrom(f, 'Bilal', { kind: 'reaction', key: 'funny' })));
    expect(useQuickChatStore.getState().shown).toEqual({});
    expect(useGameStore.getState().gameId).toBe(next.state.id);
  });

  it('the game screen going away clears it too, with nothing left pending', async () => {
    jest.useFakeTimers();
    /** Timers still pending after the screen has come and gone. */
    const leftBehind = async (withChat: boolean) => {
      const f = new Fixture().loadAs('Asha');
      const view = await render(<GameScreen view={viewFor(f, 'Asha')} />);
      if (withChat) {
        await act(async () => void receiveQuickChat(f.state.id, eventFrom(f, 'Bilal', { kind: 'reaction', key: 'funny' })));
        await act(async () => void receiveQuickChat(f.state.id, eventFrom(f, 'Asha', { kind: 'preset_message', key: 'nice_try' })));
        expect(Object.keys(useQuickChatStore.getState().shown)).toHaveLength(2);
      }
      await view.unmount();
      expect(useQuickChatStore.getState().shown).toEqual({});
      // Let zero-delay housekeeping (stopped animations releasing their handles) run.
      await act(async () => void jest.advanceTimersByTime(50));
      const count = jest.getTimerCount();
      jest.clearAllTimers();
      return count;
    };
    // Whatever the screen itself leaves, chat adds nothing to it: no expiry, no animation.
    await leftBehind(false); // the first render of a file leaves its own one-off timers
    const base = await leftBehind(false);
    expect(await leftBehind(true)).toBe(base);
    expect(await leftBehind(false)).toBe(base);
  });

  it.each(['classic', 'intermediate'] as const)('works the same in a %s game', async (mode) => {
    const f = new Fixture(['Asha', 'Bilal'], { mode }).loadAs('Asha');
    serverAccepts(f);
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await grid();
    // Capital opens with its introduction; the bar underneath is the same.
    const intro = screen.queryByTestId('intro-skip');
    if (intro) await fireEvent.press(intro);
    await fireEvent.press(screen.getByTestId('open-chat'));
    await fireEvent.press(screen.getByTestId('chat-message-coming_for_you'));
    expect(api.chat.mock.calls[0]![2]).toEqual({ kind: 'preset_message', key: 'coming_for_you' });
    expect(await screen.findByTestId(`chat-bubble-${f.ids.Asha}`)).toHaveTextContent("You: I'm coming for you 😈");
  });
});
