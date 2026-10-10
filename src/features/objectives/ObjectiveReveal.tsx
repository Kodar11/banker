import { useCallback, useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { objectiveView } from '@/engine/index.ts';
import { Button } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { formatINR } from '@/utils/currency';

/** The game (and seat) whose objective this device has already shown its player. One game at a time, so one value. */
export const OBJECTIVE_SEEN_KEY = 'business-banker.objective-seen.v1';
export const objectiveSeenValue = (gameId: string, playerId: string) => `${gameId}:${playerId}`;

/**
 * Whether this device has shown `playerId` their objective for this game. Only a note on this phone
 * about what was displayed: the assignment itself lives on the server and is never stored here.
 * `seen` is null until storage has answered, and always null without a player (no objective).
 */
export function useObjectiveSeen(gameId: string, playerId: string | null): { seen: boolean | null; markSeen: () => void } {
  const value = playerId ? objectiveSeenValue(gameId, playerId) : null;
  const [known, setKnown] = useState<{ value: string; seen: boolean } | null>(null);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    SecureStore.getItemAsync(OBJECTIVE_SEEN_KEY)
      .then((stored) => {
        if (!cancelled) setKnown((now) => (now?.value === value && now.seen ? now : { value, seen: stored === value }));
      })
      // Storage unavailable: the entry in More still works, so skip the reveal rather than repeat it forever.
      .catch(() => {
        if (!cancelled) setKnown({ value, seen: true });
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const markSeen = useCallback(() => {
    if (!value) return;
    setKnown({ value, seen: true });
    SecureStore.setItemAsync(OBJECTIVE_SEEN_KEY, value).catch(() => undefined);
  }, [value]);

  return { seen: value && known?.value === value ? known.seen : null, markSeen };
}

interface RevealProps {
  view: GameView;
  /** Put it away for now: it is offered again the next time the game is opened. */
  onLater: () => void;
  /** The player has read it. */
  onSeen: () => void;
}

/**
 * The private reveal, once per player per game, when the game starts (or the first time this phone
 * opens a game already running). It opens covered — a phone lying on the table shows nothing — and
 * is only this phone's overlay: the shared game never waits for it.
 */
export function ObjectiveReveal({ view, onLater, onSeen }: RevealProps) {
  const [shown, setShown] = useState(false);
  const mine = view.me ? objectiveView(view.snapshot.state, view.me.id) : null;
  if (!mine) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={shown ? onSeen : onLater}>
      <View className="flex-1 items-center justify-center bg-black/60 px-5" testID="objective-reveal">
        <View className="w-full max-w-[420px] gap-4 rounded-3xl bg-cream p-5">
          <Text className="text-xs font-extrabold uppercase tracking-[3px] text-stone-500">Your secret objective</Text>
          {shown ? (
            <>
              <View className="items-center gap-2">
                <Text className="text-5xl">🎯</Text>
                <Text className="text-center text-2xl font-black text-ink" testID="objective-reveal-name">
                  {mine.definition.name}
                </Text>
                <Text className="text-center text-base text-stone-700" testID="objective-reveal-description">
                  {mine.description}
                </Text>
                <Text className="text-center text-lg font-black text-ink" testID="objective-reveal-reward">
                  Reward: {formatINR(mine.terms.reward)}
                </Text>
              </View>
              <Text className="text-center text-xs text-stone-500">Find it again any time: More → My secret objective, or tap your own name.</Text>
              <Button size="md" title="Got it" testID="objective-reveal-done" onPress={onSeen} />
            </>
          ) : (
            <>
              <View className="items-center gap-2">
                <Text className="text-5xl">🎯</Text>
                <Text className="text-center text-2xl font-black text-ink">You have a secret objective</Text>
                <Text className="text-center text-base text-stone-700">
                  Every player was dealt a private goal for this game. Complete yours for a bonus when the game ends. Make sure only you can see this screen.
                </Text>
              </View>
              <View className="flex-row gap-3">
                <Button className="flex-1" size="md" variant="secondary" title="Later" testID="objective-reveal-later" onPress={onLater} />
                <Button className="flex-1" size="md" title="Show mine" testID="objective-reveal-show" onPress={() => setShown(true)} />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
