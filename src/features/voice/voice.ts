import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useStore } from 'zustand';
import { voiceApi } from '@/lib/voiceApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { createAgoraVoiceEngine } from './agoraEngine';
import { voiceMessage } from './messages';
import { requestMicPermission } from './permissions';
import { VoiceController, type VoiceState } from './voiceController';

/** The app's one voice controller: at most one voice session exists, whichever screen is open. */
export const voice = new VoiceController({
  api: voiceApi,
  // The App ID is public (every Agora client carries it); the certificate never leaves the server.
  createEngine: () => createAgoraVoiceEngine(process.env.EXPO_PUBLIC_AGORA_APP_ID),
  requestMic: requestMicPermission,
  notify: (kind, problem) => useGameStore.getState().notify(kind, voiceMessage(problem)),
});

export function useVoice<T>(selector: (state: VoiceState) => T): T {
  return useStore(voice.store, selector);
}

/**
 * Mounted once in the root layout. Ties voice to the game this phone is in and to the app's
 * lifecycle, so that it ends — microphone first — with every way a game can end here: leaving,
 * the game finishing, being removed, signing out or switching account (each clears the session
 * or takes the player out of play), and the app leaving the foreground.
 */
export function VoiceHost(): null {
  const session = useSessionStore((s) => s.session);
  const gameId = session?.gameId;
  const playerId = session?.playerId;
  const token = session?.token;
  // In play, and still at the table: the only time a voice channel exists.
  const live = useGameStore((s) => {
    const state = s.snapshot?.state;
    if (!state || state.id !== gameId || (state.status !== 'ACTIVE' && state.status !== 'PAUSED')) return false;
    const me = state.players.find((p) => p.id === playerId);
    return !!me && me.status !== 'LEFT';
  });

  useEffect(() => {
    if (!gameId || !playerId || !token) return;
    voice.attach({ gameId, playerId, token });
    return () => voice.detach();
  }, [gameId, playerId, token]);

  useEffect(() => {
    voice.setGameLive(live);
  }, [live, gameId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        voice.appForeground();
        // Possibly back from system settings, where the microphone may have been allowed.
        void voice.recheckMic();
      } else if (next === 'background') voice.appBackground();
      else voice.appInactive();
    });
    return () => sub.remove();
  }, []);

  return null;
}
