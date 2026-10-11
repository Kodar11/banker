/// <reference types="jest" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { createAgoraVoiceEngine } from '@/features/voice/agoraEngine';
import { voice, VoiceHost } from '@/features/voice/voice';
import { HOLD_TO_TALK_MS, type VoiceEngine, type VoiceEngineEvents } from '@/features/voice/voiceController';
import { gameApi } from '@/lib/gameApi';
import { voiceApi } from '@/lib/voiceApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { netWorth, outstandingDebt, voiceUidForSeat, type VoiceDenial, type VoiceRoom } from '@/engine/index.ts';
import { Fixture } from './fixtures';

jest.mock('@/features/voice/agoraEngine', () => ({ createAgoraVoiceEngine: jest.fn() }));

const api = voiceApi as jest.Mocked<typeof voiceApi>;
const game = gameApi as jest.Mocked<typeof gameApi>;
const createEngine = createAgoraVoiceEngine as jest.Mock;

/** What the audio SDK was asked to do; the test plays the SDK's side through `events`. */
interface FakeEngine extends VoiceEngine {
  calls: string[];
  events: VoiceEngineEvents | null;
  transmitting: boolean;
  left: boolean;
}
let engines: FakeEngine[] = [];
const engine = () => engines[engines.length - 1]!;

function fakeEngine(): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    events: null,
    transmitting: false,
    left: false,
    join: (_params, events) => {
      e.events = events;
    },
    renewToken: () => undefined,
    setTransmitting: (on) => {
      e.transmitting = on;
      e.calls.push(`tx:${on}`);
    },
    allowMic: () => undefined,
    muteRemote: (uid, muted) => void e.calls.push(`mute:${uid}:${muted}`),
    setRemoteVolume: (uid, volume) => void e.calls.push(`vol:${uid}:${volume}`),
    setMasterVolume: (volume) => void e.calls.push(`master:${volume}`),
    leave: () => {
      e.left = true;
      e.transmitting = false;
    },
  };
  engines.push(e);
  return e;
}

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

const OPEN: VoiceRoom = { enabled: true, available: true, reason: null, canConfigure: false };
const room = (r: Partial<VoiceRoom>) => api.status.mockResolvedValue({ ok: true, room: { ...OPEN, ...r } });
const deny = (code: VoiceDenial) => ({ ok: false as const, error: { code, message: code } });
const uidOf = (f: Fixture, name: string) => voiceUidForSeat(f.state.players.find((p) => p.id === f.ids[name])!.seat);
const grid = () => fireEvent(screen.getByTestId('game-scroll'), 'layout', { nativeEvent: { layout: { width: 412, height: 840 } } });
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const label = () => screen.getByTestId('push-to-talk-label').props.children as string;

/** The table as `name` sees it, with the voice host that the root layout mounts. */
async function table(f: Fixture, name: string) {
  f.loadAs(name);
  await render(
    <>
      <VoiceHost />
      <GameScreen view={viewFor(f, name)} />
    </>,
  );
  await grid();
  await waitFor(() => expect(voice.store.getState().room).not.toBeNull());
}

/** Taps the mic and lets the (fake) SDK connect. */
async function joinVoice() {
  await fireEvent.press(screen.getByTestId('push-to-talk'));
  await waitFor(() => expect(engine()?.events).toBeTruthy());
  await act(async () => engine().events!.onJoined());
}

beforeEach(() => {
  jest.clearAllMocks();
  engines = [];
  voice.detach();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  createEngine.mockImplementation(fakeEngine);
  room({});
  api.join.mockResolvedValue({ ok: true, grant: { token: 't', channel: 'rr-x', uid: 1, expiresAt: new Date(Date.now() + 600_000).toISOString(), heartbeatSeconds: 30 } });
  api.heartbeat.mockResolvedValue({ ok: true });
  api.leave.mockResolvedValue({ ok: true });
});

afterEach(() => {
  voice.detach();
});

describe('the action grid', () => {
  it('a game without voice keeps Auction in the grid and shows no microphone anywhere', async () => {
    room({ enabled: false, available: false, reason: 'ROOM_VOICE_OFF' });
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    const buttons = within(screen.getByTestId('action-bar-grid')).getAllByRole('button');
    expect(buttons.map((b) => b.props.testID)).toEqual(['open-properties', 'open-trade', 'open-chat', 'open-loan', 'open-auction', 'open-more']);
    expect(screen.queryByTestId('push-to-talk')).toBeNull();
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.queryByTestId('voice-section')).toBeNull();
    expect(api.join).not.toHaveBeenCalled();
  });

  it('a public game (the server says so) is voice-free', async () => {
    room({ enabled: false, available: false, reason: 'PUBLIC_GAME' });
    await table(new Fixture(['Asha', 'Bilal']), 'Asha');
    expect(screen.queryByTestId('push-to-talk')).toBeNull();
    expect(screen.getByTestId('open-auction')).toBeTruthy();
  });

  it('a voice room has Push-to-Talk where Auction was: still six buttons, same places, same size', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    const buttons = within(screen.getByTestId('action-bar-grid')).getAllByRole('button');
    expect(buttons.map((b) => b.props.testID)).toEqual(['open-properties', 'open-trade', 'open-chat', 'open-loan', 'push-to-talk', 'open-more']);
    expect(screen.queryByTestId('open-auction')).toBeNull();
    expect(within(screen.getByTestId('push-to-talk')).getByTestId('action-icon-mic')).toBeTruthy();
    const heights = buttons.map((b) => (b.props.style as { height: number }).height);
    expect(new Set(heights).size).toBe(1);
    expect(label()).toBe('Join voice');
  });

  it('Auction is in More, and the other actions still open what they opened', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    await fireEvent.press(screen.getByTestId('open-more'));
    const auction = screen.getByTestId('more-auction');
    expect(auction.props.accessibilityState.disabled).toBe(true); // no auction running
    for (const id of ['more-properties', 'more-trade', 'more-pay', 'more-chat', 'more-loan', 'voice-section']) expect(screen.getByTestId(id)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-chat'));
    expect(screen.getByTestId('chat-sheet')).toBeTruthy();
  });

  it('shows a disabled microphone, with the reason, when the monthly limit is reached', async () => {
    room({ available: false, reason: 'LIMIT_REACHED' });
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    const mic = screen.getByTestId('push-to-talk');
    expect(label()).toBe('Voice off');
    expect(mic.props.accessibilityState.disabled).toBe(true);
    expect(mic.props.accessibilityHint).toMatch(/this month’s limit/);
    expect(within(mic).getByTestId('action-icon-mic-off')).toBeTruthy();
    await fireEvent.press(mic);
    expect(api.join).not.toHaveBeenCalled();
    expect(useGameStore.getState().notice?.message).toMatch(/this month’s limit/);
    // The board game is untouched and playable.
    expect(screen.getByTestId('roll-button')).toBeTruthy();
  });
});

describe('push-to-talk', () => {
  it('a tap joins muted; holding talks; releasing mutes; no sheet opens', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    const mic = () => screen.getByTestId('push-to-talk');
    await fireEvent.press(mic());
    expect(label()).toBe('Connecting…');
    await waitFor(() => expect(engine()?.events).toBeTruthy());
    await act(async () => engine().events!.onJoined());
    expect(label()).toBe('Hold to talk');
    expect(engine().transmitting).toBe(false);

    await fireEvent(mic(), 'pressIn');
    expect(label()).toBe('Hold to talk'); // not before the hold threshold
    await wait(HOLD_TO_TALK_MS + 40);
    expect(label()).toBe('Talking');
    expect(engine().transmitting).toBe(true);
    expect(mic().props.accessibilityState.selected).toBe(true);
    // My own chip shows that I am the one talking.
    expect(screen.getByTestId(`voice-speaking-${f.ids.Asha}`)).toBeTruthy();

    await fireEvent(mic(), 'pressOut');
    expect(label()).toBe('Hold to talk');
    expect(engine().transmitting).toBe(false);
    expect(screen.queryByTestId(`voice-speaking-${f.ids.Asha}`)).toBeNull();
    for (const sheet of ['sheet-more', 'chat-sheet', 'trade-sheet']) expect(screen.queryByTestId(sheet)).toBeNull();
    // Voice never goes through the game.
    expect(game.action).not.toHaveBeenCalled();
    expect(game.chat).not.toHaveBeenCalled();
  });

  it('a quick tap after joining does not transmit', async () => {
    await table(new Fixture(['Asha', 'Bilal']), 'Asha');
    await joinVoice();
    const mic = screen.getByTestId('push-to-talk');
    await fireEvent(mic, 'pressIn');
    await fireEvent(mic, 'pressOut');
    await fireEvent.press(mic);
    await wait(HOLD_TO_TALK_MS + 40);
    expect(engine().calls.filter((c) => c === 'tx:true')).toEqual([]);
    expect(label()).toBe('Hold to talk');
  });

  it('another screen covering the table while the button is held stops transmission', async () => {
    const focus = jest.requireMock('expo-router').useIsFocused as jest.Mock;
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    await joinVoice();
    await fireEvent(screen.getByTestId('push-to-talk'), 'pressIn');
    await wait(HOLD_TO_TALK_MS + 40);
    expect(engine().transmitting).toBe(true);
    focus.mockReturnValue(false);
    await screen.rerender(
      <>
        <VoiceHost />
        <GameScreen view={viewFor(f, 'Asha')} />
      </>,
    );
    expect(engine().transmitting).toBe(false);
    focus.mockReturnValue(true);
  });

  it('leaving the game screen while held stops transmission and leaves the channel', async () => {
    await table(new Fixture(['Asha', 'Bilal']), 'Asha');
    await joinVoice();
    await fireEvent(screen.getByTestId('push-to-talk'), 'pressIn');
    await wait(HOLD_TO_TALK_MS + 40);
    const e = engine();
    expect(e.transmitting).toBe(true);
    await act(async () => useSessionStore.setState({ session: null }));
    expect(e.transmitting).toBe(false);
    expect(e.left).toBe(true);
  });

  it('a failed connection says so, shows no talking state, and a tap retries', async () => {
    api.join.mockResolvedValueOnce(deny('NETWORK') as never);
    await table(new Fixture(['Asha', 'Bilal']), 'Asha');
    await fireEvent.press(screen.getByTestId('push-to-talk'));
    await waitFor(() => expect(label()).toBe('Retry voice'));
    expect(useGameStore.getState().notice?.message).toMatch(/Couldn’t connect to voice/);
    expect(screen.getByTestId('roll-button')).toBeTruthy();
    await joinVoice();
    expect(label()).toBe('Hold to talk');
  });

  it('the game ending takes the player out of voice', async () => {
    const f = new Fixture(['Asha', 'Bilal']);
    await table(f, 'Asha');
    await joinVoice();
    const e = engine();
    f.act('Asha', { type: 'END_GAME' });
    await act(async () => void useGameStore.getState().applySnapshot(f.snapshot()));
    expect(e.left).toBe(true);
    expect(voice.store.getState().phase).toBe('unavailable');
  });
});

describe('speaking indicators', () => {
  it('show on the chip of the player whose uid the SDK reports, and nowhere else', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await table(f, 'Asha');
    await joinVoice();
    const events = engine().events!;
    await act(async () => {
      events.onUserJoined(uidOf(f, 'Bilal'));
      events.onUserJoined(uidOf(f, 'Chitra'));
    });
    expect(screen.getByTestId(`voice-listening-${f.ids.Bilal}`)).toBeTruthy();
    expect(screen.getByTestId(`voice-listening-${f.ids.Chitra}`)).toBeTruthy();

    await act(async () => events.onUserSpeaking(uidOf(f, 'Chitra'), true));
    expect(screen.getByTestId(`voice-speaking-${f.ids.Chitra}`)).toBeTruthy();
    expect(screen.queryByTestId(`voice-speaking-${f.ids.Bilal}`)).toBeNull();
    expect(screen.getByTestId(`player-chip-${f.ids.Chitra}`).props.accessibilityLabel).toMatch(/, speaking$/);

    await act(async () => events.onUserSpeaking(uidOf(f, 'Chitra'), false));
    expect(screen.queryByTestId(`voice-speaking-${f.ids.Chitra}`)).toBeNull();
    await act(async () => events.onUserLeft(uidOf(f, 'Bilal')));
    expect(screen.queryByTestId(`voice-listening-${f.ids.Bilal}`)).toBeNull();
    // The strip did not grow a row: still one strip, three chips.
    expect(within(screen.getByTestId('players-strip')).getAllByRole('button')).toHaveLength(3);
  });
});

describe('More → Voice', () => {
  async function openVoice(f: Fixture) {
    await table(f, 'Asha');
    await joinVoice();
    await act(async () => {
      engine().events!.onUserJoined(uidOf(f, 'Bilal'));
      engine().events!.onUserJoined(uidOf(f, 'Chitra'));
    });
    await fireEvent.press(screen.getByTestId('open-more'));
    expect(screen.queryByTestId('voice-controls')).toBeNull(); // collapsed: More is as short as before
    await fireEvent.press(screen.getByTestId('voice-section-toggle'));
    engine().calls.length = 0;
  }

  it('lists the other players with mute and volume, and muting one is local to this phone', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await openVoice(f);
    expect(screen.getByTestId('voice-status').props.children).toBe('Connected · mic off');
    expect(screen.queryByTestId(`voice-player-${f.ids.Asha}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`voice-mute-${f.ids.Bilal}`));
    expect(engine().calls).toEqual([`mute:${uidOf(f, 'Bilal')}:true`]);
    expect(screen.getByTestId(`voice-player-state-${f.ids.Bilal}`).props.children).toBe('Muted by you');
    expect(screen.getByTestId(`voice-player-state-${f.ids.Chitra}`).props.children).toBe('Listening');
    // Nothing about it reaches the game or the voice server.
    expect(game.action).not.toHaveBeenCalled();
    expect(api.enable).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`voice-mute-${f.ids.Bilal}`));
    expect(engine().calls).toContain(`mute:${uidOf(f, 'Bilal')}:false`);
  });

  it('Mute everyone / Unmute everyone keeps a player muted one by one muted, and my microphone untouched', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await openVoice(f);
    await fireEvent.press(screen.getByTestId(`voice-mute-${f.ids.Chitra}`));
    engine().calls.length = 0;
    await fireEvent.press(screen.getByTestId('voice-mute-all'));
    expect(engine().calls.sort()).toEqual([`mute:${uidOf(f, 'Bilal')}:true`, `mute:${uidOf(f, 'Chitra')}:true`].sort());
    expect(within(screen.getByTestId('voice-mute-all')).getByText('Unmute everyone')).toBeTruthy();
    engine().calls.length = 0;
    await fireEvent.press(screen.getByTestId('voice-mute-all'));
    expect(engine().calls.sort()).toEqual([`mute:${uidOf(f, 'Bilal')}:false`, `mute:${uidOf(f, 'Chitra')}:true`].sort());
    expect(engine().calls.some((c) => c.startsWith('tx:'))).toBe(false);
  });

  it('per-player and master volume adjust locally, within 0–100', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await openVoice(f);
    const step = (id: string, actionName: string) => fireEvent(screen.getByTestId(id), 'accessibilityAction', { nativeEvent: { actionName } });
    await step(`voice-volume-${f.ids.Bilal}`, 'decrement');
    expect(engine().calls).toEqual([`vol:${uidOf(f, 'Bilal')}:90`]);
    await step(`voice-volume-${f.ids.Bilal}`, 'increment');
    await step(`voice-volume-${f.ids.Bilal}`, 'increment');
    expect(engine().calls[engine().calls.length - 1]).toBe(`vol:${uidOf(f, 'Bilal')}:100`);
    // Dragging the track.
    const master = screen.getByTestId('voice-master-volume');
    await fireEvent(master, 'layout', { nativeEvent: { layout: { width: 200, height: 32 } } });
    await fireEvent(master, 'responderGrant', { nativeEvent: { locationX: 50 } });
    expect(engine().calls[engine().calls.length - 1]).toBe('master:25');
    expect(screen.getByTestId('voice-master-value').props.children).toEqual([25, '%']);
    await fireEvent(master, 'responderMove', { nativeEvent: { locationX: -40 } });
    expect(engine().calls[engine().calls.length - 1]).toBe('master:0');
    expect(screen.getByTestId('voice-master-volume').props.accessibilityValue.now).toBe(0);
  });

  it('Leave voice disconnects from voice only: still seated, the game untouched, and joining again works', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await openVoice(f);
    const first = engine();
    const before = useGameStore.getState().snapshot;
    await fireEvent.press(screen.getByTestId('voice-leave'));
    expect(first.left).toBe(true);
    expect(api.leave).toHaveBeenCalledTimes(1);
    expect(game.action).not.toHaveBeenCalled();
    expect(useGameStore.getState().snapshot).toBe(before);
    expect(useSessionStore.getState().session?.gameId).toBe(f.state.id);
    expect(screen.getByTestId('voice-status').props.children).toBe('Not joined');
    expect(screen.queryByTestId('leave-dialog')).toBeNull();

    await fireEvent.press(screen.getByTestId('voice-join'));
    await waitFor(() => expect(engines).toHaveLength(2));
    await act(async () => engine().events!.onJoined());
    expect(screen.getByTestId('voice-status').props.children).toBe('Connected · mic off');
  });

  it('a blocked microphone is explained, with a way to system settings', async () => {
    const camera = jest.requireMock('expo-camera').Camera as { getMicrophonePermissionsAsync: jest.Mock };
    camera.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    await openVoice(f);
    expect(screen.getByTestId('voice-problem').props.children).toMatch(/blocked/);
    expect(screen.getByTestId('voice-open-settings')).toBeTruthy();
    // Holding the button cannot open the microphone.
    await fireEvent.press(screen.getByTestId('voice-section-toggle'));
    camera.getMicrophonePermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  });
});

describe('the lobby', () => {
  function lobbyView(f: Fixture, name: string) {
    f.loadAs(name);
    return render(
      <>
        <VoiceHost />
        <LobbyView view={viewFor(f, name)} />
      </>,
    );
  }

  it('the host of a private room can turn voice on; the server’s refusal is shown and nothing changes', async () => {
    room({ enabled: false, available: false, reason: 'GAME_NOT_ACTIVE', canConfigure: true });
    api.enable.mockResolvedValueOnce(deny('NOT_ENTITLED') as never);
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    await lobbyView(f, 'Asha');
    const toggle = await screen.findByTestId('lobby-voice-toggle');
    expect(within(toggle).getByText('Turn on voice chat')).toBeTruthy();
    await fireEvent.press(toggle);
    await waitFor(() => expect(useGameStore.getState().notice?.message).toMatch(/can’t host voice chat/));
    expect(screen.queryByTestId('lobby-voice-on')).toBeNull();

    api.enable.mockResolvedValueOnce({ ok: true, room: { enabled: true, available: false, reason: 'GAME_NOT_ACTIVE', canConfigure: true } });
    await fireEvent.press(screen.getByTestId('lobby-voice-toggle'));
    await screen.findByTestId('lobby-voice-on');
    expect(api.enable).toHaveBeenLastCalledWith(expect.objectContaining({ gameId: f.state.id }), true);
    expect(within(screen.getByTestId('lobby-voice-toggle')).getByText('Turn off voice chat')).toBeTruthy();
    // Nobody is connected to anything by this.
    expect(api.join).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
  });

  it('a guest sees that the room has voice, and has no switch', async () => {
    room({ enabled: true, available: false, reason: 'GAME_NOT_ACTIVE', canConfigure: false });
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    await lobbyView(f, 'Bilal');
    await screen.findByTestId('lobby-voice-on');
    expect(screen.queryByTestId('lobby-voice-toggle')).toBeNull();
  });

  it('a lobby without voice shows nothing about it to a guest', async () => {
    room({ enabled: false, available: false, reason: 'ROOM_VOICE_OFF', canConfigure: false });
    const f = new Fixture(['Asha', 'Bilal'], { start: false });
    await lobbyView(f, 'Bilal');
    await waitFor(() => expect(voice.store.getState().room).not.toBeNull());
    expect(screen.queryByTestId('lobby-voice-on')).toBeNull();
    expect(screen.queryByTestId('lobby-voice-toggle')).toBeNull();
  });
});
