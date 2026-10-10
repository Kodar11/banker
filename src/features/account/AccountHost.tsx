import { useEffect } from 'react';
import { AppState } from 'react-native';
import { accountApi } from '@/lib/accountApi';
import { useAccountStore } from '@/store/accountStore';

/**
 * The account's lifecycle, mounted once in the root layout: restore or create the account at
 * launch, refresh tokens only while the app is in front, and look again after a failure whenever
 * the app comes back to the foreground. Renders nothing and never blocks a screen.
 */
export function AccountHost() {
  useEffect(() => {
    const { initialize, handleSignedOut } = useAccountStore.getState();
    void initialize();
    accountApi.setForeground(AppState.currentState === 'active');
    const stopListening = accountApi.onSignedOut(handleSignedOut);
    const appState = AppState.addEventListener('change', (next) => {
      accountApi.setForeground(next === 'active');
      const phase = useAccountStore.getState().phase;
      if (next === 'active' && (phase === 'unavailable' || phase === 'idle')) void useAccountStore.getState().initialize();
    });
    return () => {
      stopListening();
      appState.remove();
    };
  }, []);
  return null;
}
