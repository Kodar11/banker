import { useCallback, useRef, useState } from 'react';
import { router } from 'expo-router';
import { GameCodeSchema, PlayerNameSchema, type GameMode } from '@/engine/index.ts';
import { newActionId, newPlayerToken } from '@/lib/device';
import { gameApi, isRetryable } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { haptics } from '@/utils/haptics';

/** Creating picks the game's ruleset (Classic unless stated); joining takes whatever the host picked. */
type Mode = { kind: 'create'; gameMode?: GameMode } | { kind: 'join'; code: string };

/**
 * Create or join a game. The action id + device token are kept for the whole
 * attempt so a retry after a timeout can never create two games / two players.
 */
export function useEnterGame() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ key: string; actionId: string; token: string } | null>(null);
  const setSession = useSessionStore((s) => s.setSession);

  const submit = useCallback(
    async (mode: Mode, rawName: string) => {
      const name = PlayerNameSchema.safeParse(rawName);
      if (!name.success) {
        setError(name.error.issues[0]?.message ?? 'Enter a name');
        return;
      }
      if (mode.kind === 'join' && !GameCodeSchema.safeParse(mode.code).success) {
        setError('Game code is 6 digits');
        return;
      }
      const key = `${mode.kind}:${mode.kind === 'join' ? mode.code : (mode.gameMode ?? 'classic')}:${name.data}`;
      if (attempt.current?.key !== key) attempt.current = { key, actionId: newActionId(), token: newPlayerToken() };
      const { actionId, token } = attempt.current;

      setBusy(true);
      setError(null);
      haptics.tap();
      const enter = () => {
        if (mode.kind === 'join') return gameApi.join(actionId, token, mode.code, name.data);
        // A Classic game is created exactly as it always was; only Intermediate names its mode.
        return mode.gameMode === 'intermediate' ? gameApi.create(actionId, token, name.data, 'intermediate') : gameApi.create(actionId, token, name.data);
      };
      let res = await enter();
      if (!res.ok && isRetryable(res.error)) res = await enter();
      setBusy(false);

      if (!res.ok) {
        haptics.error();
        setError(res.error.message);
        return;
      }
      haptics.success();
      attempt.current = null;
      await setSession({ gameId: res.gameId, playerId: res.playerId, token });
      const store = useGameStore.getState();
      store.reset(res.gameId);
      store.applySnapshot(res.snapshot);
      // Screens of a previous game must not survive underneath the new one.
      if (router.canDismiss()) router.dismissAll();
      router.replace(`/lobby/${res.gameId}`);
    },
    [setSession],
  );

  return { submit, busy, error, setError };
}
