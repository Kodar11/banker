/// <reference types="jest" />
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
    Stack: Object.assign(() => null, { Screen: () => null }),
  };
});

jest.mock('@/lib/realtime', () => ({
  subscribeToGame: jest.fn(() => () => undefined),
}));

jest.mock('@/lib/gameApi', () => ({
  gameApi: { create: jest.fn(), join: jest.fn(), state: jest.fn(), action: jest.fn() },
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
