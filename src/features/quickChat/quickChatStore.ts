import { create } from 'zustand';
import { QuickChatEventSchema, type QuickChatEvent } from '@/engine/index.ts';
import { serverNow } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';

/** How long a reaction or message stays on screen. */
export const QUICK_CHAT_VISIBLE_MS = 2600;
/** An event older than this (server clock) is old news: it is dropped, never shown late. */
const MAX_AGE_MS = 10_000;
/** Event ids remembered so the same event is never shown twice (the sender's echo and the broadcast). */
const SEEN_LIMIT = 64;

/**
 * What is on screen right now, and nothing else: the latest reaction or message of each player,
 * until it expires. In memory only — never persisted, never part of the game snapshot.
 * One slot per player keeps this bounded by the table size; a player's newer event replaces
 * their older one, and other players' are untouched.
 */
export const useQuickChatStore = create<{ shown: Record<string, QuickChatEvent> }>(() => ({ shown: {} }));

const seen: string[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * One event from the realtime channel (or the server's answer to this phone's own send), as it
 * arrived. Anything malformed, unknown, for another game, from someone not at this table, already
 * shown or too old is ignored. Returns true when it is now on screen.
 */
export function receiveQuickChat(gameId: string, payload: unknown): boolean {
  const parsed = QuickChatEventSchema.safeParse(payload);
  if (!parsed.success) return false;
  const event = parsed.data as QuickChatEvent;
  const game = useGameStore.getState();
  if (event.gameId !== gameId || game.gameId !== gameId) return false;
  if (game.snapshot && !game.snapshot.state.players.some((p) => p.id === event.playerId)) return false;
  if (seen.includes(event.id)) return false;
  const at = Date.parse(event.at);
  if (!Number.isFinite(at) || serverNow() - at > MAX_AGE_MS) return false;

  seen.push(event.id);
  if (seen.length > SEEN_LIMIT) seen.shift();
  useQuickChatStore.setState((s) => ({ shown: { ...s.shown, [event.playerId]: event } }));
  const previous = timers.get(event.playerId);
  if (previous) clearTimeout(previous);
  timers.set(
    event.playerId,
    setTimeout(() => {
      timers.delete(event.playerId);
      useQuickChatStore.setState((s) => {
        if (s.shown[event.playerId]?.id !== event.id) return s;
        const { [event.playerId]: _gone, ...rest } = s.shown;
        return { shown: rest };
      });
    }, QUICK_CHAT_VISIBLE_MS),
  );
  return true;
}

/** Leaving the game or the game screen: everything on screen and every pending expiry goes. */
export function clearQuickChat(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  seen.length = 0;
  if (Object.keys(useQuickChatStore.getState().shown).length) useQuickChatStore.setState({ shown: {} });
}
