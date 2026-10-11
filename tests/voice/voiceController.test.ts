import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceDenial, VoiceGrant, VoiceRoom } from '@/engine/index.ts';
import { HOLD_TO_TALK_MS, VoiceController, type MicPermission, type VoiceEngine, type VoiceEngineEvents, type VoiceProblem } from '@/features/voice/voiceController';
import type { VoiceApi } from '@/lib/voiceApi';

const CREDS = { gameId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222', token: 'a'.repeat(64) };
const OPEN: VoiceRoom = { enabled: true, available: true, reason: null, canConfigure: false };
const GRANT: VoiceGrant = { token: 'tok-1', channel: 'rr-x', uid: 2, expiresAt: '2026-10-11T00:10:00.000Z', heartbeatSeconds: 30 };
const deny = (code: VoiceDenial) => ({ ok: false as const, error: { code, message: code } });

/** Records everything asked of the audio SDK; the test plays the SDK's side through `events`. */
class FakeEngine implements VoiceEngine {
  calls: string[] = [];
  events: VoiceEngineEvents | null = null;
  joinedWith: { token: string; channel: string; uid: number; micAllowed: boolean } | null = null;
  transmitting = false;
  left = false;
  throwOnJoin = false;
  join: VoiceEngine['join'] = (params, events) => {
    if (this.throwOnJoin) throw new Error('sdk refused');
    this.joinedWith = params;
    this.events = events;
    this.calls.push('join');
  };
  renewToken = (token: string) => void this.calls.push(`renew:${token}`);
  setTransmitting = (on: boolean) => {
    this.transmitting = on;
    this.calls.push(`tx:${on}`);
  };
  allowMic = () => void this.calls.push('allowMic');
  muteRemote = (uid: number, muted: boolean) => void this.calls.push(`mute:${uid}:${muted}`);
  setRemoteVolume = (uid: number, volume: number) => void this.calls.push(`vol:${uid}:${volume}`);
  setMasterVolume = (volume: number) => void this.calls.push(`master:${volume}`);
  leave = () => {
    this.left = true;
    this.transmitting = false;
    this.calls.push('leave');
  };
  /** How many times the microphone was opened. */
  get opened() {
    return this.calls.filter((c) => c === 'tx:true').length;
  }
}

function setup({ room = OPEN, mic = 'granted' as Exclude<MicPermission, 'unknown'>, native = true } = {}) {
  const engines: FakeEngine[] = [];
  const notices: VoiceProblem[] = [];
  let micAnswer = mic;
  const api = {
    status: vi.fn(async () => ({ ok: true as const, room })),
    enable: vi.fn(async (_c: unknown, enabled: boolean) => ({ ok: true as const, room: { ...room, enabled, available: enabled } })),
    join: vi.fn(async () => ({ ok: true as const, grant: GRANT })),
    renew: vi.fn(async () => ({ ok: true as const, grant: { ...GRANT, token: 'tok-2' } })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    leave: vi.fn(async () => ({ ok: true as const })),
  };
  const voice = new VoiceController({
    api: api as unknown as VoiceApi,
    createEngine: () => {
      if (!native) return null;
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    requestMic: vi.fn(async () => micAnswer),
    notify: (_kind, problem) => void notices.push(problem),
  });
  const phase = () => voice.store.getState().phase;
  const engine = () => engines[engines.length - 1]!;
  /** In a live game, room known. */
  const open = async () => {
    voice.attach(CREDS);
    voice.setGameLive(true);
    await vi.advanceTimersByTimeAsync(0);
  };
  /** Joined and connected: `ready_muted`. */
  const connect = async () => {
    await open();
    await voice.join();
    engine().events!.onJoined();
  };
  return { voice, api, engines, engine, notices, phase, open, connect, setMic: (m: Exclude<MicPermission, 'unknown'>) => (micAnswer = m) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('availability', () => {
  it('is unavailable until the server says the room has voice and the game is in play', async () => {
    const t = setup();
    expect(t.phase()).toBe('unavailable');
    t.voice.attach(CREDS);
    await vi.advanceTimersByTimeAsync(0);
    // The lobby: the room has voice, the game has not started.
    expect(t.voice.store.getState().room).toEqual(OPEN);
    expect(t.phase()).toBe('unavailable');
    t.voice.setGameLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.phase()).toBe('idle_muted');
  });

  it('never joins by itself: nobody is connected to a microphone unasked', async () => {
    const t = setup();
    await t.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.engines).toHaveLength(0);
  });

  it.each(['ROOM_VOICE_OFF', 'LIMIT_REACHED', 'VOICE_DISABLED', 'PUBLIC_GAME'] as const)('stays unavailable when the server says %s, and a tap only explains', async (reason) => {
    const t = setup({ room: { enabled: reason === 'LIMIT_REACHED' || reason === 'VOICE_DISABLED', available: false, reason, canConfigure: false } });
    await t.open();
    expect(t.phase()).toBe('unavailable');
    t.voice.tap();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.api.join).not.toHaveBeenCalled();
    expect(t.engines).toHaveLength(0);
    expect(t.notices).toEqual([reason]);
  });

  it('says so when the build has no native voice module, and gives the server its session back', async () => {
    const t = setup({ native: false });
    await t.open();
    await t.voice.join();
    expect(t.phase()).toBe('unavailable');
    expect(t.voice.store.getState().problem).toBe('NEEDS_DEV_BUILD');
    expect(t.api.leave).toHaveBeenCalledTimes(1);
  });
});

describe('joining', () => {
  it('a tap joins muted: connecting → ready_muted, microphone closed', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    expect(t.phase()).toBe('connecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engine().joinedWith).toEqual({ token: 'tok-1', channel: 'rr-x', uid: 2, micAllowed: true });
    expect(t.phase()).toBe('connecting');
    t.engine().events!.onJoined();
    expect(t.phase()).toBe('ready_muted');
    expect(t.engine().transmitting).toBe(false);
    expect(t.engine().opened).toBe(0);
  });

  it('repeated taps and joins make one request and one engine', async () => {
    const t = setup();
    await t.open();
    t.voice.tap();
    t.voice.tap();
    void t.voice.join();
    await vi.advanceTimersByTimeAsync(0);
    t.voice.tap();
    t.engine().events!.onJoined();
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.api.join).toHaveBeenCalledTimes(1);
    expect(t.engines).toHaveLength(1);
  });

  it('a join that never connects is a failure the player can retry', async () => {
    const t = setup();
    await t.open();
    await t.voice.join();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.phase()).toBe('error');
    expect(t.engine().left).toBe(true);
    expect(t.notices).toEqual(['CONNECT_FAILED']);
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engines).toHaveLength(2);
    t.engine().events!.onJoined();
    expect(t.phase()).toBe('ready_muted');
  });

  it('a network failure or an SDK refusal is an error, never a transmitting state', async () => {
    const t = setup();
    await t.open();
    t.api.join.mockResolvedValueOnce(deny('NETWORK') as never);
    t.voice.pressIn();
    await t.voice.join();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.phase()).toBe('error');
    expect(t.engines).toHaveLength(0);
  });

  it('a server denial makes voice unavailable with its reason', async () => {
    const t = setup();
    await t.open();
    t.api.join.mockResolvedValueOnce(deny('LIMIT_REACHED') as never);
    await t.voice.join();
    expect(t.phase()).toBe('unavailable');
    expect(t.voice.store.getState().problem).toBe('LIMIT_REACHED');
    expect(t.voice.store.getState().room).toMatchObject({ enabled: true, available: false, reason: 'LIMIT_REACHED' });
    expect(t.notices).toEqual(['LIMIT_REACHED']);
  });

  it('leaving while the token is on its way joins nothing and closes the server session', async () => {
    const t = setup();
    await t.open();
    let answer!: (v: unknown) => void;
    t.api.join.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    const joining = t.voice.join();
    await vi.advanceTimersByTimeAsync(0); // the microphone prompt is answered; the token request is out
    expect(t.api.join).toHaveBeenCalledTimes(1);
    t.voice.leaveVoice();
    answer({ ok: true, grant: GRANT });
    await joining;
    expect(t.engines).toHaveLength(0);
    expect(t.api.leave).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe('idle_muted');
  });
});

describe('push-to-talk', () => {
  it('press and hold transmits; release mutes at once', async () => {
    const t = await ready();
    t.voice.pressIn();
    expect(t.phase()).toBe('ready_muted');
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    expect(t.phase()).toBe('transmitting');
    expect(t.engine().transmitting).toBe(true);
    t.voice.pressOut();
    expect(t.phase()).toBe('ready_muted');
    expect(t.engine().transmitting).toBe(false);
  });

  it('a quick tap never opens the microphone', async () => {
    const t = await ready();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS - 1);
    t.voice.pressOut();
    t.voice.tap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.engine().opened).toBe(0);
    expect(t.phase()).toBe('ready_muted');
  });

  it('rapid press/release cycles leave the microphone closed and never double-open it', async () => {
    const t = await ready();
    for (let i = 0; i < 20; i += 1) {
      t.voice.pressIn();
      t.voice.pressIn();
      await vi.advanceTimersByTimeAsync(i % 2 ? HOLD_TO_TALK_MS : 10);
      t.voice.pressOut();
      t.voice.pressOut();
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.engine().transmitting).toBe(false);
    expect(t.phase()).toBe('ready_muted');
    // Every open was followed by a close, strictly alternating.
    const tx = t.engine().calls.filter((c) => c.startsWith('tx:')).slice(1); // the first is the muted join
    expect(tx.filter((c) => c === 'tx:true')).toHaveLength(10);
    tx.forEach((c, i) => expect(c).toBe(i % 2 ? 'tx:false' : 'tx:true'));
  });

  it('a cancelled touch, or a finger sliding off, stops transmission like a release', async () => {
    const t = await talking();
    t.voice.pressOut(); // Pressable reports both as a press-out
    expect(t.engine().transmitting).toBe(false);
    expect(t.phase()).toBe('ready_muted');
  });

  it('does nothing while connecting, and a press held through the join does not start talking', async () => {
    const t = setup();
    await t.open();
    void t.voice.join();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(1000);
    t.engine().events!.onJoined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.engine().opened).toBe(0);
    expect(t.phase()).toBe('ready_muted');
  });

  it('the app losing focus while held stops transmission', async () => {
    const t = await talking();
    t.voice.appInactive();
    expect(t.engine().transmitting).toBe(false);
    expect(t.phase()).toBe('ready_muted');
    // The finger is still down when the app comes back: nothing resumes without a new press.
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.engine().opened).toBe(1);
  });

  it('backgrounding while held closes the microphone and leaves the channel; the foreground rejoins muted', async () => {
    const t = await talking();
    const first = t.engine();
    t.voice.appBackground();
    expect(first.transmitting).toBe(false);
    expect(first.left).toBe(true);
    expect(t.api.leave).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe('idle_muted');
    t.voice.appForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engines).toHaveLength(2);
    t.engine().events!.onJoined();
    expect(t.phase()).toBe('ready_muted');
    expect(t.engine().opened).toBe(0);
  });

  it('a phone that never joined voice does not join it by coming to the foreground', async () => {
    const t = setup();
    await t.open();
    t.voice.appBackground();
    t.voice.appForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.api.join).not.toHaveBeenCalled();
  });

  it('leaving the game while held stops transmission and leaves the channel', async () => {
    const t = await talking();
    t.voice.detach();
    expect(t.engine().transmitting).toBe(false);
    expect(t.engine().left).toBe(true);
    expect(t.phase()).toBe('unavailable');
    expect(t.voice.store.getState().gameId).toBeNull();
  });

  it('the game ending while held stops transmission and leaves the channel', async () => {
    const t = await talking();
    t.voice.setGameLive(false);
    expect(t.engine().left).toBe(true);
    expect(t.phase()).toBe('unavailable');
    // Late SDK events of the dead connection change nothing.
    t.engine().events!.onConnection('connected');
    t.engine().events!.onJoined();
    expect(t.phase()).toBe('unavailable');
  });

  it('a disconnect while held shows reconnecting, not talking; after it, a NEW press is needed', async () => {
    const t = await talking();
    t.engine().events!.onConnection('reconnecting');
    expect(t.phase()).toBe('reconnecting');
    expect(t.engine().transmitting).toBe(false);
    t.voice.pressIn(); // pressing during the outage does nothing
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.engine().opened).toBe(1);
    t.engine().events!.onConnection('connected');
    expect(t.phase()).toBe('ready_muted');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.engine().opened).toBe(1); // still held from before: not resumed
    t.voice.pressOut();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    expect(t.phase()).toBe('transmitting');
  });

  it('a connection lost for good ends in error with the microphone closed', async () => {
    const t = await talking();
    t.engine().events!.onConnection('failed');
    expect(t.phase()).toBe('error');
    expect(t.engine().left).toBe(true);
    expect(t.engine().transmitting).toBe(false);
  });

  async function ready() {
    const t = setup();
    await t.connect();
    return t;
  }
  async function talking() {
    const t = await ready();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    expect(t.phase()).toBe('transmitting');
    return t;
  }
});

describe('microphone permission', () => {
  it('a denied permission still lets the player listen, and never opens the microphone', async () => {
    const t = setup({ mic: 'denied' });
    await t.connect();
    expect(t.engine().joinedWith!.micAllowed).toBe(false);
    expect(t.phase()).toBe('ready_muted');
    expect(t.voice.store.getState().problem).toBe('MIC_DENIED');
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(2000);
    t.voice.pressOut();
    expect(t.engine().opened).toBe(0);
    expect(t.phase()).toBe('ready_muted');
    expect(t.notices).toEqual(['MIC_DENIED']);
  });

  it('a blocked permission points at system settings', async () => {
    const t = setup({ mic: 'blocked' });
    await t.connect();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.notices).toEqual(['MIC_BLOCKED']);
    expect(t.engine().opened).toBe(0);
  });

  it('granting it later enables the microphone, and only the NEXT press talks', async () => {
    const t = setup({ mic: 'denied' });
    await t.connect();
    t.setMic('granted');
    t.voice.pressIn(); // this press asks
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.engine().calls).toContain('allowMic');
    expect(t.engine().opened).toBe(0);
    expect(t.voice.store.getState().problem).toBeNull();
    t.voice.pressOut();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    expect(t.phase()).toBe('transmitting');
  });
});

describe('tokens, heartbeats and revocation', () => {
  it('renews the token when the SDK asks, once even if asked twice at the same moment', async () => {
    const t = setup();
    await t.connect();
    t.engine().events!.onTokenWillExpire();
    t.engine().events!.onTokenExpired();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.api.renew).toHaveBeenCalledTimes(1);
    expect(t.engine().calls).toContain('renew:tok-2');
    expect(t.phase()).toBe('ready_muted');
  });

  it('a refused renewal stops transmission, leaves the channel and says why', async () => {
    const t = setup();
    await t.connect();
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    t.api.renew.mockResolvedValueOnce(deny('LIMIT_REACHED') as never);
    t.engine().events!.onTokenWillExpire();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engine().transmitting).toBe(false);
    expect(t.engine().left).toBe(true);
    expect(t.phase()).toBe('unavailable');
    expect(t.notices).toEqual(['LIMIT_REACHED']);
    // The server closed the session itself: nothing to tell it.
    expect(t.api.leave).not.toHaveBeenCalled();
  });

  it('a renewal that cannot reach the server keeps the current token and the connection', async () => {
    const t = setup();
    await t.connect();
    t.api.renew.mockResolvedValueOnce(deny('NETWORK') as never);
    t.engine().events!.onTokenWillExpire();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.phase()).toBe('ready_muted');
    t.engine().events!.onTokenExpired();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engine().calls).toContain('renew:tok-2');
  });

  it('the kill switch reaches a connected phone at its next heartbeat', async () => {
    const t = setup();
    await t.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.api.heartbeat).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe('ready_muted');
    t.api.heartbeat.mockResolvedValueOnce(deny('VOICE_DISABLED') as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.phase()).toBe('unavailable');
    expect(t.engine().left).toBe(true);
    expect(t.notices).toEqual(['VOICE_DISABLED']);
    // And no more heartbeats after leaving.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.api.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('a heartbeat for a session the server closed asks for a new token instead of dropping the call', async () => {
    const t = setup();
    await t.connect();
    t.api.heartbeat.mockResolvedValueOnce(deny('SESSION_ENDED') as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.api.renew).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe('ready_muted');
  });

  it('the host switching the room’s voice off disconnects a connected phone', async () => {
    const t = setup();
    await t.connect();
    t.api.status.mockResolvedValueOnce({ ok: true, room: { enabled: false, available: false, reason: 'ROOM_VOICE_OFF', canConfigure: false } });
    await t.voice.refreshRoom();
    expect(t.engine().left).toBe(true);
    expect(t.phase()).toBe('unavailable');
    expect(t.voice.store.getState().room!.enabled).toBe(false);
  });

  it('"Leave voice" leaves the channel, tells the server, and allows rejoining without a duplicate session', async () => {
    const t = setup();
    await t.connect();
    t.voice.leaveVoice();
    expect(t.engine().left).toBe(true);
    expect(t.api.leave).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe('idle_muted');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.api.heartbeat).not.toHaveBeenCalled();
    await t.voice.join();
    t.engine().events!.onJoined();
    expect(t.engines).toHaveLength(2);
    expect(t.engines[0]!.left).toBe(true);
    expect(t.phase()).toBe('ready_muted');
  });

  it('attaching the same game again (a reconnect of the board) changes nothing', async () => {
    const t = setup();
    await t.connect();
    t.voice.attach({ ...CREDS });
    expect(t.engines).toHaveLength(1);
    expect(t.engine().left).toBe(false);
    expect(t.phase()).toBe('ready_muted');
  });

  it('the host can switch the room on; a refusal is reported and changes nothing', async () => {
    const t = setup({ room: { enabled: false, available: false, reason: 'ROOM_VOICE_OFF', canConfigure: true } });
    await t.open();
    t.api.enable.mockResolvedValueOnce(deny('NOT_ENTITLED') as never);
    expect(await t.voice.setRoomEnabled(true)).toBe(false);
    expect(t.notices).toEqual(['NOT_ENTITLED']);
    expect(t.voice.store.getState().room!.enabled).toBe(false);
    expect(await t.voice.setRoomEnabled(true)).toBe(true);
    expect(t.voice.store.getState().room!.enabled).toBe(true);
    expect(t.phase()).toBe('idle_muted');
  });
});

describe('who is speaking, and what I hear', () => {
  it('tracks remote players from the SDK’s events, by uid', async () => {
    const t = setup();
    await t.connect();
    const e = t.engine().events!;
    e.onUserJoined(1);
    e.onUserJoined(3);
    expect(t.voice.store.getState().peers).toEqual({ 1: { speaking: false }, 3: { speaking: false } });
    e.onUserSpeaking(3, true);
    expect(t.voice.store.getState().peers[3]).toEqual({ speaking: true });
    e.onUserSpeaking(3, false);
    e.onUserLeft(1);
    expect(t.voice.store.getState().peers).toEqual({ 3: { speaking: false } });
    t.voice.leaveVoice();
    expect(t.voice.store.getState().peers).toEqual({});
  });

  it('muting one player is local, and survives them leaving and rejoining voice', async () => {
    const t = setup();
    await t.connect();
    const e = t.engine().events!;
    e.onUserJoined(1);
    e.onUserJoined(3);
    t.voice.setPeerMuted(3, true);
    expect(t.engine().calls).toContain('mute:3:true');
    expect(t.engine().calls).not.toContain('mute:1:true');
    e.onUserLeft(3);
    t.engine().calls.length = 0;
    e.onUserJoined(3);
    expect(t.engine().calls).toContain('mute:3:true');
    t.voice.setPeerMuted(3, false);
    expect(t.engine().calls).toContain('mute:3:false');
    // Nothing of this is sent to the server.
    expect(t.api.enable).not.toHaveBeenCalled();
  });

  it('unmute everyone keeps the players muted one by one muted, and never touches my microphone', async () => {
    const t = setup();
    await t.connect();
    const e = t.engine().events!;
    e.onUserJoined(1);
    e.onUserJoined(3);
    t.voice.setPeerMuted(3, true);
    t.engine().calls.length = 0;
    t.voice.setMuteAll(true);
    expect(t.engine().calls).toEqual(['mute:1:true', 'mute:3:true']);
    // Someone who joins while everyone is muted is muted too.
    e.onUserJoined(4);
    expect(t.engine().calls).toContain('mute:4:true');
    t.engine().calls.length = 0;
    t.voice.setMuteAll(false);
    expect(t.engine().calls).toEqual(['mute:1:false', 'mute:3:true', 'mute:4:false']);
    expect(t.engine().calls.some((c) => c.startsWith('tx:'))).toBe(false);
    // Muted to me, I can still talk.
    t.voice.setMuteAll(true);
    t.voice.pressIn();
    await vi.advanceTimersByTimeAsync(HOLD_TO_TALK_MS);
    expect(t.phase()).toBe('transmitting');
  });

  it('volumes are clamped, applied locally, and kept for a player who is not connected yet', async () => {
    const t = setup();
    await t.connect();
    const e = t.engine().events!;
    e.onUserJoined(1);
    t.voice.setPeerVolume(1, 40);
    t.voice.setPeerVolume(1, 400);
    t.voice.setPeerVolume(1, -5);
    t.voice.setPeerVolume(3, 60); // not in voice yet
    expect(t.engine().calls.filter((c) => c.startsWith('vol:'))).toEqual(['vol:1:40', 'vol:1:100', 'vol:1:0']);
    e.onUserJoined(3);
    expect(t.engine().calls).toContain('vol:3:60');
    t.voice.setMasterVolume(0);
    t.voice.setMasterVolume(Number.NaN);
    expect(t.engine().calls.filter((c) => c.startsWith('master:'))).toEqual(['master:100', 'master:0', 'master:100']);
    // The master volume does not unmute anyone.
    t.voice.setPeerMuted(1, true);
    t.engine().calls.length = 0;
    t.voice.setMasterVolume(80);
    expect(t.engine().calls).toEqual(['master:80']);
  });

  it('preferences last for the game and are gone with it; the master volume is reapplied on rejoin', async () => {
    const t = setup();
    await t.connect();
    t.voice.setMasterVolume(30);
    t.voice.setPeerMuted(3, true);
    t.voice.leaveVoice();
    await t.voice.join();
    t.engine().events!.onJoined();
    expect(t.engine().calls).toContain('master:30');
    t.engine().events!.onUserJoined(3);
    expect(t.engine().calls).toContain('mute:3:true');
    t.voice.detach();
    expect(t.voice.store.getState()).toMatchObject({ mutedUids: {}, muteAll: false, volumes: {}, masterVolume: 100 });
  });
});
