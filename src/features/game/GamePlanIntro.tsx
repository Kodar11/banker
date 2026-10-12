import { Modal, Text, View } from 'react-native';
import { atMaximumDuration, configOf, durationLabel, GAME_DURATION_YEARS, type GameState } from '@/engine/index.ts';
import { Button } from '@/components/ui';
import { useSeenOnce } from '@/utils/useSeenOnce';

/** The game (and seat) whose plan this device has already shown its player. One game at a time, so one value. */
export const GAME_PLAN_SEEN_KEY = 'business-banker.game-plan-seen.v1';
export const gamePlanSeenValue = (gameId: string, playerId: string) => `${gameId}:${playerId}`;

/** Whether this device has shown `playerId` the plan of this game. Null until storage has answered, and without a player. */
export function useGamePlanSeen(gameId: string, playerId: string | null): { seen: boolean | null; markSeen: () => void } {
  return useSeenOnce(GAME_PLAN_SEEN_KEY, playerId ? gamePlanSeenValue(gameId, playerId) : null);
}

/**
 * "Your Game Plan": how long this game runs and how it ends, shown to every player once when a
 * hosted game starts — a step of the same opening sequence as the Capital introduction before it
 * and the secret objective after it. The duration is read from the game's own settings (the same
 * for every player, locked at the start). Only this phone's overlay: the shared game never waits
 * for it, and it says nothing about anyone's objective.
 */
export function GamePlanIntro({ state, onDone }: { state: GameState; onDone: () => void }) {
  const years = configOf(state).durationYears;
  const longest = atMaximumDuration(state);
  const lines = [
    `Duration: ${durationLabel(years)}`,
    `Approximately ${years} laps`,
    longest
      ? `${durationLabel(GAME_DURATION_YEARS.maxYears)} is the longest a game can run: it ends when they are over.`
      : 'After the selected duration, players will vote to end the game or extend it by one financial year.',
    'Players may also request an early-ending vote during the game.',
  ];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDone}>
      <View className="flex-1 items-center justify-center bg-black/60 px-5" testID="game-plan">
        <View className="w-full max-w-[420px] gap-4 rounded-3xl bg-cream p-5">
          <Text className="text-xs font-extrabold uppercase tracking-[3px] text-stone-500">Your game plan</Text>
          <View className="items-center gap-1">
            <Text className="text-5xl">🗓️</Text>
            <Text className="text-center text-2xl font-black text-ink" testID="game-plan-duration">
              {durationLabel(years)}
            </Text>
          </View>
          <View className="gap-1.5">
            {lines.map((line, i) => (
              <Text key={line} className="text-base text-stone-700" testID={`game-plan-line-${i + 1}`}>
                · {line}
              </Text>
            ))}
          </View>
          <Text className="text-center text-xs text-stone-500">Find it again any time: More → Game settings.</Text>
          <Button size="md" title="Got it" testID="game-plan-done" onPress={onDone} />
        </View>
      </View>
    </Modal>
  );
}
