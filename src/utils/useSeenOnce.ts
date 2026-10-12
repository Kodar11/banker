import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

/**
 * Whether this device has already shown its player something that is shown once — a note on this
 * phone under `storageKey`, holding the `value` (which game, which seat) it was last shown for.
 * `seen` is null until storage has answered, and always null without a value (nothing to show).
 * If storage is unavailable it reads as seen: better to skip a one-off than to repeat it forever.
 */
export function useSeenOnce(storageKey: string, value: string | null): { seen: boolean | null; markSeen: () => void } {
  const [known, setKnown] = useState<{ value: string; seen: boolean } | null>(null);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    SecureStore.getItemAsync(storageKey)
      .then((stored) => {
        if (!cancelled) setKnown((now) => (now?.value === value && now.seen ? now : { value, seen: stored === value }));
      })
      .catch(() => {
        if (!cancelled) setKnown({ value, seen: true });
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey, value]);

  const markSeen = useCallback(() => {
    if (!value) return;
    setKnown({ value, seen: true });
    SecureStore.setItemAsync(storageKey, value).catch(() => undefined);
  }, [storageKey, value]);

  return { seen: value && known?.value === value ? known.seen : null, markSeen };
}
