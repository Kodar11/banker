import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceGrant, VoiceRoom } from '@/engine/index.ts';
import { MAX_AUTO_RESUMES, VoiceController, type VoiceEngine, type VoiceEngineEvents } from '@/features/voice/voiceController';
import type { VoiceApi } from '@/lib/voiceApi';

const CREDS = { gameId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222', token: 'a'.repeat(64) };
const OPEN: VoiceRoom = { enabled: true, available: true, reason: null, canConfigure: false };
const GRANT: VoiceGrant = { token: 'tok', channel: 'rr-x', uid: 2, expiresAt: new Date(Date.now() + 600_000).toISOString(), heartbeatSeconds: 30 };

function setup() {
  let events: VoiceEngineEvents | null = null;
  const engine: VoiceEngine = {
    join: (_params, e) => {
      events = e;
    },
    renewToken: () => undefined,
    setTransmitting: () => undefined,
    allowMic: () => undefined,
    muteRemote: () => undefined,
    setRemoteVolume: () => undefined,
    setMasterVolume: () => undefined,
    leave: () => undefined,
  };
  const api = {
    status: vi.fn(async () => ({ ok: true as const, room: OPEN })),
    enable: vi.fn(),
    join: vi.fn(async () => ({ ok: true as const, grant: GRANT })),
    renew: vi.fn(async () => ({ ok: true as const, grant: GRANT })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    leave: vi.fn(async () => ({ ok: true as const })),
  };
  /** What the permission prompt does to the app while it is open (nothing, unless a test says so). */
  let duringPrompt: () => void = () => undefined;
  const requestMic = vi.fn(async () => {
    duringPrompt();
    return 'granted' as const;
  });
  const voice = new VoiceController({ api: api as unknown as VoiceApi, createEngine: () => engine, requestMic, notify: () => undefined });
  const open = async () => {
    voice.attach(CREDS);
    voice.setGameLive(true);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { voice, api, requestMic, open, sdk: () => events!, onPrompt: (run: () => void) => (duringPrompt = run) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the foreground rejoin is capped', () => {
  /**
   * What an Android permission request does when it is not granted: the activity is paused and
   * resumed (with or without a visible dialog), which React Native reports as the app going to
   * the background and coming back.
   */
  const bounce = (voice: VoiceController) => {
    voice.appBackground();
    voice.appForeground();
  };

  it('a prompt that bounces the app on EVERY join cannot restart the join for ever', async () => {
    const t = setup();
    await t.open();
    t.onPrompt(() => bounce(t.voice));
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(1000);
    // The tap, then MAX_AUTO_RESUMES rejoins, each overtaken at the permission prompt; then it stops.
    expect(t.requestMic).toHaveBeenCalledTimes(1 + MAX_AUTO_RESUMES);
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.voice.store.getState().phase).toBe('idle_muted');
    // Coming to the foreground again starts nothing by itself…
    t.voice.appForeground();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.requestMic).toHaveBeenCalledTimes(1 + MAX_AUTO_RESUMES);
    // …and a tap starts again from zero.
    t.onPrompt(() => undefined);
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(0);
    t.sdk().onJoined();
    expect(t.voice.store.getState().phase).toBe('ready_muted');
  });

  it('the ordinary first use (one prompt, one bounce) still connects', async () => {
    const t = setup();
    await t.open();
    let prompts = 0;
    t.onPrompt(() => {
      prompts += 1;
      if (prompts === 1) bounce(t.voice);
    });
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(0);
    t.sdk().onJoined();
    expect(t.voice.store.getState().phase).toBe('ready_muted');
    expect(t.api.join).toHaveBeenCalledTimes(1);
  });

  it('backgrounding a connected call any number of times is not counted against the cap', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(0);
    t.sdk().onJoined();
    for (let i = 0; i < MAX_AUTO_RESUMES + 3; i += 1) {
      bounce(t.voice);
      await vi.advanceTimersByTimeAsync(0);
      t.sdk().onJoined();
      expect(t.voice.store.getState().phase).toBe('ready_muted');
    }
  });
});
