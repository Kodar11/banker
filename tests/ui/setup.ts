/// <reference types="jest" />
import { useOnboardingStore } from '@/store/onboardingStore';
/* Jest setup for UI tests: mock native modules and the network layer. */

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

jest.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    getRandomBytes: (len: number) => new Uint8Array(len).fill(7),
  };
});

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })) }));

jest.mock('expo-linking', () => ({ createURL: (path: string) => `businessbanker://${path}` }));

jest.mock('expo-camera', () => ({
  CameraView: () => null,
  Camera: {
    getMicrophonePermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    requestMicrophonePermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  },
  useCameraPermissions: () => [{ granted: false }, jest.fn()],
}));

jest.mock('react-native-qrcode-svg', () => () => null);

jest.mock('expo-router', () => {
  const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), canDismiss: jest.fn(() => false), dismissAll: jest.fn(), dismissTo: jest.fn() };
  return {
    router,
    useRouter: () => router,
    useLocalSearchParams: jest.fn(() => ({})),
    usePathname: jest.fn(() => '/'),
    useIsFocused: jest.fn(() => true),
    Stack: Object.assign(() => null, { Screen: () => null }),
  };
});

jest.mock('@/lib/realtime', () => ({
  subscribeToGame: jest.fn(() => () => undefined),
}));

// Voice never reaches Supabase (or a microphone) in UI tests. By default the server says the room
// has no voice, which is every existing test's game; tests/ui/voice.test.tsx sets what it needs.
jest.mock('@/lib/voiceApi', () => {
  const offline = { ok: false, error: { code: 'NETWORK', message: 'Connection lost.' } };
  return {
    VOICE_FUNCTION_NAME: 'voice-token',
    voiceApi: {
      status: jest.fn(async () => ({ ok: true, room: { enabled: false, available: false, reason: 'ROOM_VOICE_OFF', canConfigure: false } })),
      enable: jest.fn(async () => offline),
      join: jest.fn(async () => offline),
      renew: jest.fn(async () => offline),
      heartbeat: jest.fn(async () => offline),
      leave: jest.fn(async () => ({ ok: true })),
    },
  };
});

jest.mock('@/lib/gameApi', () => ({
  gameApi: { create: jest.fn(), join: jest.fn(), state: jest.fn(), action: jest.fn(), chat: jest.fn() },
  isRetryable: (e: { code: string }) => e.code === 'NETWORK' || e.code === 'TIMEOUT',
  callGameApi: jest.fn(),
}));

// The account layer never reaches Supabase in UI tests. Defaults describe a phone with no network;
// tests/ui/account.test.tsx sets what each scenario needs.
jest.mock('@/lib/accountApi', () => {
  const offline = { ok: false, error: { code: 'NETWORK', message: 'No connection. Check your internet and try again.' } };
  return {
    DELETE_FUNCTION_NAME: 'delete-account',
    accountApi: {
      restoreSession: jest.fn(async () => offline),
      signInAnonymously: jest.fn(async () => offline),
      initProfile: jest.fn(async () => offline),
      verifyUser: jest.fn(async () => offline),
      updateNickname: jest.fn(async () => offline),
      linkGoogle: jest.fn(async () => offline),
      signInWithGoogle: jest.fn(async () => offline),
      restoreTokens: jest.fn(async () => offline),
      signOutLocal: jest.fn(async () => undefined),
      deleteAccount: jest.fn(async () => offline),
      onSignedOut: jest.fn(() => () => undefined),
      setForeground: jest.fn(),
    },
  };
});

// The social layer never reaches Supabase in UI tests either. Defaults describe a phone with no network;
// tests/ui/friends.test.tsx sets what each scenario needs.
jest.mock('@/lib/socialApi', () => {
  const offline = { ok: false, error: { code: 'NETWORK', message: 'No connection. Check your internet and try again.' } };
  const call = () => jest.fn(async () => offline);
  return {
    socialError: (code: string) => ({ code, message: code === 'NOT_READY' ? 'Your profile isn’t loaded yet. Check your connection and try again.' : code }),
    socialApi: {
      state: call(),
      lookup: call(),
      sendRequest: call(),
      respondRequest: call(),
      cancelRequest: call(),
      removeFriend: call(),
      block: call(),
      unblock: call(),
      claimSeat: call(),
      seatProfiles: call(),
      sendInvite: call(),
      openInvite: call(),
      declineInvite: call(),
      revokeInvite: call(),
      markRead: call(),
    },
  };
});

jest.mock('@/lib/socialRealtime', () => ({
  subscribeToSocialSync: jest.fn(() => () => undefined),
  subscribeToMatchmakingSync: jest.fn(() => () => undefined),
  trackOwnPresence: jest.fn(() => () => undefined),
  watchPresence: jest.fn(() => () => undefined),
}));

// Random matchmaking never reaches Supabase in UI tests. Defaults describe a phone with no network;
// tests/ui/matchmaking.test.tsx sets what each scenario needs.
jest.mock('@/lib/matchmakingApi', () => {
  const offline = { ok: false, error: { code: 'NETWORK', message: 'No connection. Check your internet and try again.' } };
  const call = () => jest.fn(async () => offline);
  return {
    MATCHMAKING_FUNCTION_NAME: 'matchmaking',
    matchmakingError: (code: string) => ({ code, message: code === 'NOT_READY' ? 'Your profile isn’t loaded yet. Check your connection and try again.' : code }),
    matchmakingApi: {
      state: call(),
      heartbeat: call(),
      enqueue: call(),
      cancel: call(),
      ready: call(),
      decline: call(),
      createParty: call(),
      invite: call(),
      respondInvite: call(),
      revokeInvite: call(),
      setMode: call(),
      setReady: call(),
      leaveParty: call(),
      kick: call(),
      nudge: jest.fn(async () => undefined),
    },
  };
});

// Every UI test starts as a returning player: the first-launch introduction has been seen.
// tests/ui/onboarding.test.tsx sets what each of its scenarios needs.
beforeEach(() => {
  useOnboardingStore.setState({ status: 'done' });
});
