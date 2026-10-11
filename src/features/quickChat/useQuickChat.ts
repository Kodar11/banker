import { useCallback, useEffect, useRef, useState } from 'react';
import { QUICK_CHAT_COOLDOWN_MS, type QuickChatItem } from '@/engine/index.ts';
import { newActionId } from '@/lib/device';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { haptics } from '@/utils/haptics';
import { clearQuickChat, receiveQuickChat } from './quickChatStore';

/**
 * Sending a reaction or preset message from this phone. The cooldown kept here only saves a wasted
 * request and gives instant feedback: the server enforces the real one. Nothing here waits on, or
 * changes, the game.
 */
export function useQuickChat({ onSent }: { onSent: () => void }) {
  /** Inside this phone's cooldown: the sheet says so when something is tapped. */
  const [cooling, setCooling] = useState(false);
  /** A tap landed during the cooldown. */
  const [blocked, setBlocked] = useState(false);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startCooldown = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    setCooling(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCooling(false);
      setBlocked(false);
    }, ms);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      // The table is gone: so is whatever was floating over it.
      clearQuickChat();
    },
    [],
  );

  const send = async (item: QuickChatItem) => {
    if (sending.current) return;
    if (cooling) {
      setBlocked(true);
      haptics.warning();
      return;
    }
    const session = useSessionStore.getState().session;
    if (!session) return;
    sending.current = true;
    startCooldown(QUICK_CHAT_COOLDOWN_MS);
    haptics.tap();
    onSent();
    const res = await gameApi.chat(session, newActionId(), item);
    sending.current = false;
    if (res.ok) {
      // Shown here straight away; the broadcast of the same event is then recognised and skipped.
      receiveQuickChat(session.gameId, res.event);
    } else if (res.error.code === 'COOLDOWN') {
      startCooldown(res.error.retryAfterMs ?? QUICK_CHAT_COOLDOWN_MS);
      useGameStore.getState().notify('info', 'One at a time. Try again in a moment.');
    } else {
      useGameStore.getState().notify('info', 'That could not be sent. The game carries on.');
    }
  };

  return { send, cooling, blocked, clearBlocked: useCallback(() => setBlocked(false), []) };
}
