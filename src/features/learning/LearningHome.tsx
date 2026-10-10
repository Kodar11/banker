import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, ConfirmDialog, Screen } from '@/components/ui';
import { useLearningStore } from '@/store/learningStore';
import { goBack } from '@/utils/navigation';
import { LESSON_COLLECTIONS } from './lessons';
import { countCompleted, lessonRoute, lessonsIn } from './registry';
import type { CollectionId, Lesson } from './types';

/** Each collection's accent edge, so the four read as different shelves at a glance (their icon and title say which). */
const ACCENTS: Record<CollectionId, string> = {
  cash: 'border-t-8 border-saffron',
  property: 'border-t-8 border-deed-blue',
  debt: 'border-t-8 border-deed-pink',
  strategy: 'border-t-8 border-deed-green',
};

type LessonStatus = 'new' | 'started' | 'done';
/** How a lesson card looks in each state. The state is always written out; colour and the badge only back it up. */
const STATUS: Record<LessonStatus, { text: string; action: string; card: string; badge: string; badgeText: string; chip: string; button: string; buttonText: string }> = {
  new: {
    text: 'Not started',
    action: 'Start',
    card: 'border-stone-200',
    badge: 'bg-stone-100 border-2 border-stone-200',
    badgeText: 'text-stone-600',
    chip: 'bg-stone-100 text-stone-600',
    button: 'bg-saffron',
    buttonText: 'text-ink',
  },
  started: {
    text: 'In progress',
    action: 'Resume',
    card: 'border-saffron',
    badge: 'bg-amber-100 border-2 border-saffron',
    badgeText: 'text-amber-800',
    chip: 'bg-amber-100 text-amber-800',
    button: 'bg-saffron',
    buttonText: 'text-ink',
  },
  done: {
    text: 'Completed',
    action: 'Replay',
    card: 'border-green-200',
    badge: 'bg-green-600 border-2 border-green-600',
    badgeText: 'text-white',
    chip: 'bg-green-100 text-green-800',
    button: 'border border-stone-300 bg-white',
    buttonText: 'text-stone-700',
  },
};

/** One lesson as its own card: number (or a tick once completed), title, one line about it, its state and what a tap does. */
function LessonRow({ lesson, completed, started }: { lesson: Lesson; completed: boolean; started: boolean }) {
  // A completed lesson that is being replayed still counts as completed, and offers to pick the replay back up.
  const status = STATUS[completed ? 'done' : started ? 'started' : 'new'];
  const action = started ? STATUS.started : status;
  return (
    <Pressable
      onPress={() => router.push(lessonRoute(lesson.id))}
      testID={`lesson-row-${lesson.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Lesson ${lesson.number}: ${lesson.title}. ${status.text}.`}
      accessibilityHint={`${action.action}s the lesson`}
      className={`gap-2.5 rounded-2xl border bg-white px-4 py-3.5 active:opacity-70 ${status.card}`}
    >
      {/* Stacked, so the title and summary get the full width of the card instead of a column between two others. */}
      <View className="flex-row items-center gap-3">
        <View className={`h-9 w-9 items-center justify-center rounded-full ${status.badge}`}>
          <Text className={`text-sm font-black ${status.badgeText}`}>{completed ? '✓' : lesson.number}</Text>
        </View>
        <Text className="flex-1 text-[17px] font-extrabold leading-[22px] text-ink">{lesson.title}</Text>
      </View>
      <Text className="text-sm leading-5 text-stone-600">{lesson.summary}</Text>
      <View className="flex-row items-center justify-between gap-3 border-t border-stone-100 pt-2.5">
        <View className="flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text className={`overflow-hidden rounded-full px-2.5 py-1 text-[11px] font-extrabold ${status.chip}`} testID={`lesson-status-${lesson.id}`}>
            {status.text}
          </Text>
          <Text className="text-xs font-semibold text-stone-500">About {lesson.estimatedDurationSeconds} sec</Text>
        </View>
        <View className={`min-w-[84px] items-center rounded-full px-4 py-2 ${action.button}`}>
          <Text className={`text-sm font-extrabold ${action.buttonText}`} testID={`lesson-action-${lesson.id}`}>
            {action.action} ›
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** More → Financial Learning: the four collections, every lesson open from the start, and progress. */
export function LearningHome() {
  const completed = useLearningStore((s) => s.completed);
  const inProgress = useLearningStore((s) => s.inProgress);
  const hydrated = useLearningStore((s) => s.hydrated);
  const hydrate = useLearningStore((s) => s.hydrate);
  const resetProgress = useLearningStore((s) => s.resetProgress);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const overall = countCompleted(completed);
  const anyProgress = overall.completed > 0 || Object.keys(inProgress).length > 0;
  return (
    <Screen scroll testID="learning-home">
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" testID="learning-back" onPress={() => goBack('/')} />
      <Text accessibilityRole="header" className="text-4xl font-black text-cream">
        Financial Learning
      </Text>
      <Text className="text-base font-semibold leading-6 text-cream/80">Short money stories from the Business board. One decision each, about a minute, in any order.</Text>

      <View className="gap-2 rounded-2xl bg-felt-dark px-4 py-3" testID="learning-progress">
        <Text className="text-base font-extrabold text-cream" testID="learning-progress-text">
          {overall.completed} of {overall.total} lessons completed
        </Text>
        <View
          className="h-2.5 overflow-hidden rounded-full bg-white/20"
          accessibilityRole="progressbar"
          accessibilityLabel={`${overall.completed} of ${overall.total} lessons completed`}
          accessibilityValue={{ min: 0, max: overall.total, now: overall.completed }}
        >
          <View className="h-2.5 rounded-full bg-saffron" style={{ width: `${(overall.completed / overall.total) * 100}%` }} />
        </View>
      </View>

      {LESSON_COLLECTIONS.map((collection) => {
        const count = countCompleted(completed, collection.id);
        const lessons = lessonsIn(collection.id);
        return (
          <Card key={collection.id} testID={`collection-${collection.id}`} className={`overflow-hidden p-0 ${ACCENTS[collection.id]}`}>
            <View className="gap-3 px-4 pb-3 pt-4">
              <View className="flex-row items-center gap-3">
                <Text className="text-3xl">{collection.icon}</Text>
                <View className="flex-1">
                  <Text accessibilityRole="header" className="text-lg font-extrabold leading-6 text-ink">
                    {collection.title}
                  </Text>
                  <Text className="text-sm leading-5 text-stone-600">{collection.blurb}</Text>
                </View>
              </View>
              {/* One pip per lesson, in order: filled once that lesson is completed. */}
              <View className="flex-row items-center gap-3" accessible accessibilityLabel={`${count.completed} of ${count.total} completed`}>
                <View className="flex-1 flex-row gap-1.5">
                  {lessons.map((lesson) => (
                    <View key={lesson.id} className={`h-1.5 flex-1 rounded-full ${completed.includes(lesson.id) ? 'bg-green-600' : 'bg-stone-300'}`} />
                  ))}
                </View>
                <Text className="text-xs font-extrabold text-stone-600">
                  <Text testID={`collection-count-${collection.id}`}>
                    {count.completed}/{count.total}
                  </Text>{' '}
                  done
                </Text>
              </View>
            </View>
            <View className="gap-2.5 px-3 pb-3">
              {lessons.map((lesson) => (
                <LessonRow key={lesson.id} lesson={lesson} completed={completed.includes(lesson.id)} started={!!inProgress[lesson.id]} />
              ))}
            </View>
          </Card>
        );
      })}

      <Text className="text-center text-xs leading-5 text-cream/70">These stories are illustrations for learning. They never change a game, and they are not financial advice.</Text>
      {anyProgress ? <Button size="sm" variant="ghost" title="Reset lesson progress" testID="learning-reset" onPress={() => setConfirmReset(true)} /> : null}
      <ConfirmDialog
        visible={confirmReset}
        title="Reset lesson progress?"
        message="Every lesson goes back to not started on this device."
        detail="Your games are not affected."
        confirmTitle="Reset progress"
        intent="warning"
        testID="learning-reset-dialog"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          resetProgress();
          setConfirmReset(false);
        }}
      />
    </Screen>
  );
}
