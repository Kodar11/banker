/// <reference types="jest" />
/**
 * The two pieces of voice that touch the platform, against mocked platform APIs: the Agora adapter
 * (one SDK engine for the whole run of the app, never destroyed and recreated per join) and the
 * permission request (one at a time, Bluetooth asked once). Mocks prove the sequencing, not what a
 * phone does.
 */
import type { VoiceEngine, VoiceEngineEvents } from '@/features/voice/voiceController';

jest.mock('react-native-agora', () => {
  const rtc = {
    initialize: jest.fn(() => 0),
    release: jest.fn(),
    registerEventHandler: jest.fn(),
    unregisterEventHandler: jest.fn(),
    disableVideo: jest.fn(),
    enableAudio: jest.fn(),
    setAudioProfile: jest.fn(),
    setDefaultAudioRouteToSpeakerphone: jest.fn(),
    enableLocalAudio: jest.fn(),
    muteLocalAudioStream: jest.fn(),
    joinChannel: jest.fn(() => 0),
    leaveChannel: jest.fn(),
    renewToken: jest.fn(),
    muteRemoteAudioStream: jest.fn(),
    adjustUserPlaybackSignalVolume: jest.fn(),
    adjustPlaybackSignalVolume: jest.fn(),
  };
  return {
    createAgoraRtcEngine: () => rtc,
    AudioProfileType: { AudioProfileSpeechStandard: 1 },
    AudioScenarioType: { AudioScenarioDefault: 0 },
    ChannelProfileType: { ChannelProfileCommunication: 0 },
    ClientRoleType: { ClientRoleBroadcaster: 1 },
    ConnectionStateType: { ConnectionStateConnected: 3, ConnectionStateReconnecting: 4, ConnectionStateFailed: 5 },
    RemoteAudioState: { RemoteAudioStateStopped: 0, RemoteAudioStateDecoding: 2 },
    RemoteAudioStateReason: { RemoteAudioReasonRemoteMuted: 5, RemoteAudioReasonRemoteOffline: 7 },
  };
});

type Rtc = Record<string, jest.Mock>;
type Handler = Record<string, (...args: unknown[]) => void>;

const JOIN = { token: 'tok', channel: 'rr-x', uid: 2, micAllowed: true };

function listener() {
  const seen: string[] = [];
  const events: VoiceEngineEvents = {
    onJoined: () => void seen.push('joined'),
    onConnection: (state) => void seen.push(`connection:${state}`),
    onUserJoined: (uid) => void seen.push(`in:${uid}`),
    onUserLeft: (uid) => void seen.push(`out:${uid}`),
    onUserSpeaking: (uid, speaking) => void seen.push(`speaking:${uid}:${speaking}`),
    onTokenWillExpire: () => void seen.push('willExpire'),
    onTokenExpired: () => void seen.push('expired'),
  };
  return { seen, events };
}

/** A fresh copy of the adapter (and of the mocked SDK), as on a fresh start of the app. */
function freshApp() {
  let create!: (appId: string | undefined) => VoiceEngine | null;
  let rtc!: Rtc;
  // The adapter loads the SDK when it is first used, so the whole registry starts again, not just one module.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry per test
  create = require('@/features/voice/agoraEngine').createAgoraVoiceEngine;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  rtc = require('react-native-agora').createAgoraRtcEngine();
  const handlerOf = (call: number) => rtc.registerEventHandler!.mock.calls[call]![0] as Handler;
  return { create, rtc, handlerOf };
}

describe('the Agora engine is one engine, kept', () => {
  it('is initialized by the first join only, and no join or leave ever destroys it', () => {
    const { create, rtc } = freshApp();
    for (let i = 0; i < 4; i += 1) {
      const session = create('app-id')!;
      session.join(JOIN, listener().events);
      session.leave();
    }
    expect(rtc.initialize).toHaveBeenCalledTimes(1);
    expect(rtc.joinChannel).toHaveBeenCalledTimes(4);
    expect(rtc.leaveChannel).toHaveBeenCalledTimes(4);
    expect(rtc.release).not.toHaveBeenCalled();
  });

  it('leaving stops the microphone, leaves the channel and removes exactly the handler it registered — once', () => {
    const { create, rtc, handlerOf } = freshApp();
    const session = create('app-id')!;
    session.join(JOIN, listener().events);
    rtc.muteLocalAudioStream!.mockClear();
    rtc.enableLocalAudio!.mockClear();
    session.leave();
    session.leave();
    expect(rtc.muteLocalAudioStream).toHaveBeenCalledWith(true);
    expect(rtc.enableLocalAudio).toHaveBeenCalledWith(false);
    expect(rtc.leaveChannel).toHaveBeenCalledTimes(1);
    expect(rtc.unregisterEventHandler).toHaveBeenCalledTimes(1);
    expect(rtc.unregisterEventHandler).toHaveBeenCalledWith(handlerOf(0));
    // After leaving, nothing more is asked of the SDK through this session.
    session.setTransmitting(true);
    session.allowMic();
    session.renewToken('late');
    expect(rtc.muteLocalAudioStream).toHaveBeenCalledTimes(1);
    expect(rtc.renewToken).not.toHaveBeenCalled();
    expect(() => session.join(JOIN, listener().events)).toThrow();
    expect(rtc.joinChannel).toHaveBeenCalledTimes(1);
  });

  it('a late event of a session that was left reaches nobody; the next session hears its own', () => {
    const { create, handlerOf } = freshApp();
    const first = listener();
    const old = create('app-id')!;
    old.join(JOIN, first.events);
    old.leave();
    const second = listener();
    create('app-id')!.join(JOIN, second.events);

    handlerOf(0).onJoinChannelSuccess!();
    handlerOf(0).onConnectionStateChanged!({}, 5);
    handlerOf(0).onUserJoined!({}, 3);
    handlerOf(0).onRequestToken!();
    expect(first.seen).toEqual([]);
    expect(second.seen).toEqual([]);

    handlerOf(1).onJoinChannelSuccess!();
    handlerOf(1).onUserMuteAudio!({}, 3, false);
    expect(second.seen).toEqual(['joined', 'speaking:3:true']);
    expect(first.seen).toEqual([]);
  });

  it('joins muted, and without the permission captures nothing', () => {
    const { create, rtc } = freshApp();
    create('app-id')!.join({ ...JOIN, micAllowed: false }, listener().events);
    expect(rtc.enableLocalAudio).toHaveBeenCalledWith(false);
    expect(rtc.muteLocalAudioStream).toHaveBeenCalledWith(true);
    expect(rtc.joinChannel!.mock.calls[0]!.slice(0, 3)).toEqual(['tok', 'rr-x', 2]);
  });

  it('a refused join throws (the controller turns it into "Retry voice"), and leaving after it is clean', () => {
    const { create, rtc } = freshApp();
    rtc.joinChannel!.mockReturnValueOnce(-17);
    const session = create('app-id')!;
    expect(() => session.join(JOIN, listener().events)).toThrow('joinChannel -17');
    expect(() => session.leave()).not.toThrow();
    expect(rtc.unregisterEventHandler).toHaveBeenCalledTimes(1);
    expect(rtc.release).not.toHaveBeenCalled();
  });

  it('a failed initialization throws and is tried again by the next join', () => {
    const { create, rtc } = freshApp();
    rtc.initialize!.mockReturnValueOnce(-7);
    const session = create('app-id')!;
    expect(() => session.join(JOIN, listener().events)).toThrow('initialize -7');
    expect(rtc.joinChannel).not.toHaveBeenCalled();
    expect(() => session.leave()).not.toThrow();
    create('app-id')!.join(JOIN, listener().events);
    expect(rtc.initialize).toHaveBeenCalledTimes(2);
    expect(rtc.joinChannel).toHaveBeenCalledTimes(1);
  });

  it('there is no engine without an App ID', () => {
    expect(freshApp().create(undefined)).toBeNull();
  });
});

describe('the permission request', () => {
  type Answer = { granted: boolean; canAskAgain: boolean };

  /** Android 13, microphone not granted yet, Bluetooth not granted: both prompts are due. */
  function android({ api = 33 } = {}) {
    let request!: () => Promise<string>;
    const mic: { resolve: (a: Answer) => void } = { resolve: () => undefined };
    const bluetooth: { resolve: (a: string) => void } = { resolve: () => undefined };
    let camera!: { getMicrophonePermissionsAsync: jest.Mock; requestMicrophonePermissionsAsync: jest.Mock };
    let bluetoothRequest!: jest.Mock;
    let granted = false;
    jest.resetModules();
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry per test
      const rn = require('react-native');
      Object.defineProperty(rn.Platform, 'OS', { configurable: true, get: () => 'android' });
      Object.defineProperty(rn.Platform, 'Version', { configurable: true, get: () => api });
      jest.spyOn(rn.PermissionsAndroid, 'check').mockImplementation(async () => false);
      bluetoothRequest = jest.spyOn(rn.PermissionsAndroid, 'request').mockImplementation(() => new Promise<string>((r) => (bluetooth.resolve = r))) as unknown as jest.Mock;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      camera = require('expo-camera').Camera;
      camera.getMicrophonePermissionsAsync.mockImplementation(async () => ({ granted, canAskAgain: true }));
      camera.requestMicrophonePermissionsAsync.mockImplementation(
        () =>
          new Promise<Answer>((r) => {
            mic.resolve = (a) => {
              granted = a.granted;
              r(a);
            };
          }),
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      request = require('@/features/voice/permissions').requestMicPermission;
    }
    return { request, mic, bluetooth, camera, bluetoothRequest };
  }

  const settle = () => new Promise((r) => setImmediate(r));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asked again while the prompts are open, it shows no second prompt: everyone gets the one answer', async () => {
    const t = android();
    const first = t.request();
    await settle();
    const second = t.request();
    await settle();
    expect(t.camera.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    t.mic.resolve({ granted: true, canAskAgain: true });
    await settle();
    // The Bluetooth prompt is part of the same request.
    const third = t.request();
    await settle();
    expect(t.bluetoothRequest).toHaveBeenCalledTimes(1);
    t.bluetooth.resolve('granted');
    expect(await Promise.all([first, second, third])).toEqual(['granted', 'granted', 'granted']);
    expect(t.camera.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    expect(t.bluetoothRequest).toHaveBeenCalledTimes(1);
  });

  it('Bluetooth is asked for once per run of the app, whatever the answer', async () => {
    const t = android();
    const first = t.request();
    await settle();
    t.mic.resolve({ granted: true, canAskAgain: true });
    await settle();
    t.bluetooth.resolve('never_ask_again');
    expect(await first).toBe('granted');
    for (let i = 0; i < 3; i += 1) expect(await t.request()).toBe('granted');
    expect(t.bluetoothRequest).toHaveBeenCalledTimes(1);
    expect(t.bluetoothRequest).toHaveBeenCalledWith('android.permission.BLUETOOTH_CONNECT');
  });

  it('a refused microphone is "denied", and Bluetooth is not asked for at all', async () => {
    const t = android();
    const asked = t.request();
    await settle();
    t.mic.resolve({ granted: false, canAskAgain: true });
    expect(await asked).toBe('denied');
    expect(t.bluetoothRequest).not.toHaveBeenCalled();
    // A later press asks again (one prompt), as before.
    const again = t.request();
    await settle();
    t.mic.resolve({ granted: false, canAskAgain: false });
    expect(await again).toBe('blocked');
    expect(t.camera.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it('before Android 12 there is no Bluetooth prompt', async () => {
    const t = android({ api: 30 });
    const asked = t.request();
    await settle();
    t.mic.resolve({ granted: true, canAskAgain: true });
    expect(await asked).toBe('granted');
    expect(t.bluetoothRequest).not.toHaveBeenCalled();
  });
});
