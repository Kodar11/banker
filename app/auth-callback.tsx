import { useEffect } from 'react';
import { LoadingState } from '@/components/ui';
import { goBack } from '@/utils/navigation';

/**
 * Where Google sign-in returns to (businessbanker://auth-callback?code=…). The code itself is
 * read by the flow that opened the browser (src/lib/accountApi.ts); on Android the same link also
 * reaches the router, so this route exists only to hand straight back to the screen underneath.
 */
export default function AuthCallback() {
  useEffect(() => {
    goBack('/account');
  }, []);
  return <LoadingState message="Finishing sign-in…" />;
}
