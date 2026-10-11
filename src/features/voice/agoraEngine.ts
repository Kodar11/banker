import type { VoiceEngine, VoiceEngineEvents } from './voiceController';

type Agora = typeof import('react-native-agora');

/**
 * The native Agora module, or null when this build does not contain it (Expo Go, the web, tests).
 * Loaded on first use, never at import: a build without it must still open the game.
 */
function loadAgora(): Agora | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, see above
    return require('react-native-agora') as Agora;
  } catch {
    return null;
  }
}

/**
 * Live player voice over Agora RTC, audio only: no video, no recording, no screen sharing, no
 * proxy. One engine per voice session, created on join and released on leave, so nothing of the
 * SDK (and no microphone capture) outlives "Leave voice", the game, or the app going to the
 * background.
 *
 * Push-to-talk uses muteLocalAudioStream: the channel is joined as a publisher with the local
 * stream muted, and holding the button unmutes it. That is the switch Agora documents for
 * frequent toggling (it takes effect at once, unlike restarting the capture device).
 */
export function createAgoraVoiceEngine(appId: string | undefined): VoiceEngine | null {
  const agora = appId ? loadAgora() : null;
  if (!agora || !appId) return null;
  const { createAgoraRtcEngine, AudioProfileType, AudioScenarioType, ChannelProfileType, ClientRoleType, ConnectionStateType, RemoteAudioState, RemoteAudioStateReason } = agora;

  let rtc: ReturnType<typeof createAgoraRtcEngine>;
  try {
    rtc = createAgoraRtcEngine();
  } catch {
    return null;
  }
  let handler: Parameters<typeof rtc.registerEventHandler>[0] | null = null;
  let released = false;
  /** Every SDK call after release is a no-op; a failing call never reaches the game. */
  const safe = (run: () => unknown) => {
    if (released) return;
    try {
      run();
    } catch {
      // The controller learns about real failures from the connection events.
    }
  };

  return {
    join: ({ token, channel, uid, micAllowed }, events: VoiceEngineEvents) => {
      rtc.initialize({ appId, channelProfile: ChannelProfileType.ChannelProfileCommunication });
      handler = {
        onJoinChannelSuccess: () => {
          // Said again once connected: joined means muted, whatever the SDK did with the earlier call.
          safe(() => rtc.muteLocalAudioStream(true));
          events.onJoined();
        },
        onRejoinChannelSuccess: () => events.onConnection('connected'),
        onConnectionStateChanged: (_connection, state) => {
          if (state === ConnectionStateType.ConnectionStateReconnecting) events.onConnection('reconnecting');
          else if (state === ConnectionStateType.ConnectionStateConnected) events.onConnection('connected');
          else if (state === ConnectionStateType.ConnectionStateFailed) events.onConnection('failed');
        },
        onConnectionLost: () => events.onConnection('reconnecting'),
        onUserJoined: (_connection, remoteUid) => events.onUserJoined(remoteUid),
        onUserOffline: (_connection, remoteUid) => events.onUserLeft(remoteUid),
        // A player's push-to-talk, as the SDK reports it: unmuted while they hold the button.
        onUserMuteAudio: (_connection, remoteUid, muted) => events.onUserSpeaking(remoteUid, !muted),
        // The same fact from the audio itself; it also covers someone already talking when we join.
        onRemoteAudioStateChanged: (_connection, remoteUid, state, reason) => {
          if (state === RemoteAudioState.RemoteAudioStateDecoding) events.onUserSpeaking(remoteUid, true);
          else if (
            state === RemoteAudioState.RemoteAudioStateStopped &&
            (reason === RemoteAudioStateReason.RemoteAudioReasonRemoteMuted || reason === RemoteAudioStateReason.RemoteAudioReasonRemoteOffline)
          ) {
            events.onUserSpeaking(remoteUid, false);
          }
        },
        onTokenPrivilegeWillExpire: () => events.onTokenWillExpire(),
        onRequestToken: () => events.onTokenExpired(),
      };
      rtc.registerEventHandler(handler);
      rtc.disableVideo();
      rtc.enableAudio();
      // Conversation, not music: the speech profile and the SDK's default scenario.
      rtc.setAudioProfile(AudioProfileType.AudioProfileSpeechStandard, AudioScenarioType.AudioScenarioDefault);
      // The phone lies next to the board: loudspeaker, unless a wired or Bluetooth headset is connected (the SDK prefers those by itself).
      rtc.setDefaultAudioRouteToSpeakerphone(true);
      // Without the permission nothing is captured at all; with it, nothing is sent until the button is held.
      rtc.enableLocalAudio(micAllowed);
      rtc.muteLocalAudioStream(true);
      const code = rtc.joinChannel(token, channel, uid, {
        channelProfile: ChannelProfileType.ChannelProfileCommunication,
        clientRoleType: ClientRoleType.ClientRoleBroadcaster,
        publishMicrophoneTrack: true,
        autoSubscribeAudio: true,
        publishCameraTrack: false,
        autoSubscribeVideo: false,
      });
      if (code < 0) throw new Error(`joinChannel ${code}`);
    },
    renewToken: (token) => safe(() => rtc.renewToken(token)),
    setTransmitting: (on) => {
      // Not through `safe`: a failure to MUTE must not pass silently (the controller then leaves the channel).
      if (!released) rtc.muteLocalAudioStream(!on);
    },
    allowMic: () => safe(() => rtc.enableLocalAudio(true)),
    muteRemote: (uid, muted) => safe(() => rtc.muteRemoteAudioStream(uid, muted)),
    setRemoteVolume: (uid, volume) => safe(() => rtc.adjustUserPlaybackSignalVolume(uid, volume)),
    setMasterVolume: (volume) => safe(() => rtc.adjustPlaybackSignalVolume(volume)),
    leave: () => {
      if (released) return;
      safe(() => rtc.muteLocalAudioStream(true));
      safe(() => rtc.enableLocalAudio(false));
      safe(() => rtc.leaveChannel());
      if (handler) safe(() => rtc.unregisterEventHandler(handler!));
      safe(() => rtc.release());
      released = true;
    },
  };
}
