import { Text, View } from 'react-native';
import { OBJECTIVES, objectiveView } from '@/engine/index.ts';
import { Card, Label, Pill } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { formatINR } from '@/utils/currency';

/**
 * This player's own secret objective. Opened from More, in a sheet on their own phone: nothing of it
 * is ever drawn on the shared table. The device holds no other player's objective until the game ends.
 */
export function MyObjective({ view }: { view: GameView }) {
  const { state } = view.snapshot;
  const mine = view.me ? objectiveView(state, view.me.id) : null;
  if (!mine) return null;
  const finished = state.status === 'FINISHED';
  return (
    <Card testID="my-objective" className="gap-2 bg-white">
      <View className="flex-row items-start justify-between gap-2">
        <Text className="flex-1 text-2xl font-black text-ink" testID="my-objective-name">
          {mine.definition.name}
        </Text>
        <Pill tone="gold">{formatINR(mine.terms.reward)} bonus</Pill>
      </View>
      <Text className="text-base leading-6 text-stone-700" testID="my-objective-description">
        {mine.description}
      </Text>
      {finished ? null : (
        <View className="rounded-xl bg-cream px-3 py-2">
          <View className="flex-row items-center justify-between gap-2">
            <Label>Right now</Label>
            <Pill tone={mine.check.completed ? 'good' : 'neutral'}>{mine.check.completed ? 'On track' : 'Not yet'}</Pill>
          </View>
          <View testID="my-objective-measures">
            {mine.measures.map((line) => (
              <Text key={line} className="text-lg font-black text-ink">
                {line}
              </Text>
            ))}
          </View>
          <Text className="text-sm text-stone-600" testID="my-objective-progress">
            {mine.check.progress}
          </Text>
          <Text className="text-xs text-stone-500">{mine.check.completed ? 'On track — it is checked when the game ends.' : 'Not there yet — it is checked when the game ends.'}</Text>
        </View>
      )}
      <Text className="text-xs text-stone-500">
        {finished ? 'The game is over: every objective has been revealed.' : 'Only you can see this. It can’t be changed, and the bonus is paid by the bank when the game ends.'}
      </Text>
    </Card>
  );
}

/** The reveal, once the game has finished: every player's objective, whether they made it, and the bonus. */
export function ObjectiveResults({ view }: { view: GameView }) {
  const results = view.snapshot.state.objectives?.results;
  if (!results?.length) return null;
  return (
    <Card testID="objective-results" className="gap-2">
      <Label>Secret objectives</Label>
      {results.map((r) => (
        <View key={r.playerId} className="gap-0.5 rounded-xl bg-white px-4 py-3" testID={`objective-result-${r.playerId}`}>
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-base font-extrabold text-ink">
              {view.playerName(r.playerId)} · {OBJECTIVES[r.objectiveId].name}
            </Text>
            <Pill tone={r.completed ? 'good' : 'neutral'}>{r.completed ? 'Completed' : 'Not completed'}</Pill>
          </View>
          <Text className="text-sm text-stone-600">{r.detail}</Text>
          {r.completed ? <Text className="text-sm font-extrabold text-green-700">Bonus: +{formatINR(r.reward)}</Text> : <Text className="text-sm font-bold text-stone-500">No bonus</Text>}
        </View>
      ))}
      <Text className="text-xs text-stone-500">Bonuses are paid by the bank, separately from the game’s other money, and are included in the net worth above.</Text>
    </Card>
  );
}
