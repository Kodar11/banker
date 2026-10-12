import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceGrant, VoiceRoom } from '@/engine/index.ts';
import { MAX_AUTO_RESUMES, VoiceController, type MicPermission, type VoiceEngine, type VoiceEngineEvents, type VoiceProblem } from '@/features/voice/voiceController';
import type { VoiceApi } from '@/lib/voiceApi';

/**
 * The permission prompt a join opens is reported by Android as the app going to the background and
 * coming back (once for the microphone, once more for Bluetooth on Android 12+). It is not the
 * player leaving: the join that opened it waits for the answer and then connects — once.
 */
const CREDS = { gameId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222', token: 'a'.repeat(64) };
const OPEN: VoiceRoom = { enabled: true, available: true, reason: null, canConfigure: false };
const GRANT: VoiceGrant = { token: 'tok', channel: 'rr-x', uid: 2, expiresAt: new Date(Date.now() + 600_000).toISOString(), heartbeatSeconds: 30 };

type Answer = Exclude<MicPermission, 'unknown'>;

function setup() {
  const engines: { events: VoiceEngineEvents; micAllowed: boolean; left: boolean; transmitting: boolean }[] = [];
  const notices: VoiceProblem[] = [];
  const api = {
    status: vi.fn(async () => ({ ok: true as const, room: OPEN })),
    enable: vi.fn(),
    join: vi.fn(async () => ({ ok: true as const, grant: GRANT })),
    renew: vi.fn(async () => ({ ok: true as const, grant: GRANT })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    leave: vi.fn(async () => ({ ok: true as const })),
  };
  /** The prompts that are open, oldest first; `answer` closes the oldest. */
  const prompts: ((a: Answer) => void)[] = [];
  const requestMic = vi.fn(() => new Promise<Answer>((resolve) => prompts.push(resolve)));
  const createEngine = vi.fn((): VoiceEngine => {
    const record = { events: null as unknown as VoiceEngineEvents, micAllowed: false, left: false, transmitting: false };
    engines.push(record);
    return {
      join: (params, events) => {
        record.events = events;
        record.micAllowed = params.micAllowed;
      },
      renewToken: () => undefined,
      setTransmitting: (on) => void (record.transmitting = on),
      allowMic: () => undefined,
      muteRemote: () => undefined,
      setRemoteVolume: () => undefined,
      setMasterVolume: () => undefined,
      leave: () => void (record.left = true),
    };
  });
  const voice = new VoiceController({ api: api as unknown as VoiceApi, createEngine, requestMic, notify: (_kind, problem) => void notices.push(problem) });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const open = async () => {
    voice.attach(CREDS);
    voice.setGameLive(true);
    await flush();
  };
  const answer = async (a: Answer) => {
    prompts.shift()!(a);
    await flush();
  };
  return { voice, api, requestMic, createEngine, engines, notices, open, answer, flush, phase: () => voice.store.getState().phase, state: () => voice.store.getState() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('granting the permission', () => {
  it('prompt → background → granted → foreground: one prompt, one token, one engine, connected', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    // Android shows the dialog: the activity is paused.
    t.voice.appBackground();
    expect(t.phase()).toBe('connecting');
    expect(t.api.join).not.toHaveBeenCalled();
    // Granted; the result arrives before the activity is resumed.
    await t.answer('granted');
    expect(t.api.join).not.toHaveBeenCalled(); // nothing is joined from the background
    t.voice.appForeground();
    await t.flush();
    t.engines[0]!.events.onJoined();

    expect(t.phase()).toBe('ready_muted');
    expect(t.state()).toMatchObject({ mic: 'granted', problem: null, gameId: CREDS.gameId });
    expect(t.requestMic).toHaveBeenCalledTimes(1);
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.api.leave).not.toHaveBeenCalled();
    expect(t.createEngine).toHaveBeenCalledTimes(1);
    expect(t.engines[0]).toMatchObject({ micAllowed: true, left: false });
    expect(t.notices).toEqual([]);
  });

  it('prompt → background → foreground → granted (the other order the two can arrive in): the same single join', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    t.voice.appForeground();
    await t.flush();
    expect(t.api.join).not.toHaveBeenCalled();
    await t.answer('granted');
    t.engines[0]!.events.onJoined();
    expect(t.phase()).toBe('ready_muted');
    expect(t.requestMic).toHaveBeenCalledTimes(1);
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.createEngine).toHaveBeenCalledTimes(1);
  });

  it('microphone, then Bluetooth (Android 12+): two dialogs inside one request are still one join, and use up no automatic rejoin', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    // Two dialogs, one after the other, before the request answers.
    for (let i = 0; i < 2; i += 1) {
      t.voice.appBackground();
      t.voice.appForeground();
      await t.flush();
    }
    t.voice.appBackground();
    await t.answer('granted');
    t.voice.appForeground();
    await t.flush();
    t.engines[0]!.events.onJoined();
    expect(t.phase()).toBe('ready_muted');
    expect(t.requestMic).toHaveBeenCalledTimes(1);
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.createEngine).toHaveBeenCalledTimes(1);

    // The cap on automatic rejoins is untouched: a connected call still comes back MAX_AUTO_RESUMES + more times.
    for (let i = 0; i < MAX_AUTO_RESUMES + 2; i += 1) {
      t.voice.appBackground();
      t.voice.appForeground();
      await t.flush();
      // The permission is granted by now: the request answers at once, without a dialog.
      await t.answer('granted');
      t.engines[t.engines.length - 1]!.events.onJoined();
      expect(t.phase()).toBe('ready_muted');
    }
  });

  it('a second tap while the prompt is open starts nothing', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    t.voice.tap();
    void t.voice.join();
    t.voice.appForeground();
    t.voice.tap();
    await t.flush();
    expect(t.requestMic).toHaveBeenCalledTimes(1);
    await t.answer('granted');
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.createEngine).toHaveBeenCalledTimes(1);
  });
});

describe('refusing the permission', () => {
  it.each([
    ['denied', 'MIC_DENIED'],
    ['blocked', 'MIC_BLOCKED'],
  ] as const)('%s: voice says so and can be listened to; nothing loops, and the game is not touched', async (mic, problem) => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    await t.answer(mic);
    t.voice.appForeground();
    await t.flush();
    t.engines[0]!.events.onJoined();
    // As before: in the channel to listen, microphone off, with the reason shown.
    expect(t.phase()).toBe('ready_muted');
    expect(t.state()).toMatchObject({ mic, problem, gameId: CREDS.gameId });
    expect(t.engines[0]).toMatchObject({ micAllowed: false, transmitting: false });
    // Coming back to the app again and again asks for nothing and joins nothing.
    for (let i = 0; i < 5; i += 1) {
      t.voice.appForeground();
      await t.flush();
    }
    expect(t.requestMic).toHaveBeenCalledTimes(1);
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.createEngine).toHaveBeenCalledTimes(1);
  });
});

describe('the prompt does not outlive what asked for it', () => {
  it('"Leave voice" while the prompt is open: the answer joins nothing', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    t.voice.appForeground();
    t.voice.leaveVoice();
    await t.answer('granted');
    expect(t.phase()).toBe('idle_muted');
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.createEngine).not.toHaveBeenCalled();
  });

  it('the game is gone (left, ended, another account) while the prompt is open: the answer and the return to the app join nothing', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    t.voice.detach();
    await t.answer('granted');
    t.voice.appForeground();
    await t.flush();
    expect(t.phase()).toBe('unavailable');
    expect(t.state().gameId).toBeNull();
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.createEngine).not.toHaveBeenCalled();
  });

  it('answered, but the game ended before the app was back in front: nothing is joined', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    await t.answer('granted');
    t.voice.setGameLive(false);
    t.voice.appForeground();
    await t.flush();
    expect(t.phase()).toBe('unavailable');
    expect(t.api.join).not.toHaveBeenCalled();
  });

  it('really leaving the app with the prompt unanswered connects nothing while away', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    t.voice.appBackground();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.createEngine).not.toHaveBeenCalled();
  });
});

describe('really going to the background still lets everything go', () => {
  it('connected and talking: the microphone closes and the channel is left; back in front it rejoins muted, on one new engine', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await t.flush();
    await t.answer('granted');
    t.engines[0]!.events.onJoined();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.phase()).toBe('transmitting');

    t.voice.appBackground();
    expect(t.engines[0]).toMatchObject({ transmitting: false, left: true });
    expect(t.phase()).toBe('idle_muted');

    t.voice.appForeground();
    await t.flush();
    await t.answer('granted');
    expect(t.createEngine).toHaveBeenCalledTimes(2);
    // A late event of the engine that was left changes nothing.
    t.engines[0]!.events.onConnection('failed');
    expect(t.phase()).toBe('connecting');
    t.engines[1]!.events.onJoined();
    expect(t.phase()).toBe('ready_muted');
    expect(t.engines[1]!.transmitting).toBe(false);
  });

  it('while the token is on its way (after the prompt): the join is dropped and the session it opened is closed', async () => {
    const t = setup();
    await t.open();
    let grant!: (v: { ok: true; grant: VoiceGrant }) => void;
    t.api.join.mockImplementationOnce(() => new Promise((r) => (grant = r)));
    t.voice.tap();
    await t.flush();
    await t.answer('granted');
    t.voice.appBackground();
    expect(t.phase()).toBe('idle_muted');
    grant({ ok: true, grant: GRANT });
    await t.flush();
    expect(t.createEngine).not.toHaveBeenCalled();
    expect(t.api.leave).toHaveBeenCalledTimes(1);
  });
});
