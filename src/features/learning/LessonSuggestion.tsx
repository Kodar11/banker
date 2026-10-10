import { Text, View } from 'react-native';
import { Button, Label } from '@/components/ui';
import { useLearningStore } from '@/store/learningStore';
import { suggestedLesson } from './registry';

/**
 * A quiet pointer to one lesson, shown under a finished game's standings. Optional and
 * dismissible; it reads nothing from the game — it is simply the next lesson not yet completed.
 */
export function LessonSuggestion({ onOpen }: { onOpen: (lessonId: string) => void }) {
  const completed = useLearningStore((s) => s.completed);
  const dismissed = useLearningStore((s) => s.suggestionDismissed);
  const dismiss = useLearningStore((s) => s.dismissSuggestion);
  const lesson = suggestedLesson(completed);
  if (dismissed || !lesson) return null;
  return (
    <View className="gap-2 rounded-2xl bg-white p-4" testID="lesson-suggestion">
      <Label>🎓 Financial Learning</Label>
      <Text className="text-base leading-6 text-ink">
        Want a one-minute money story? Try <Text className="font-extrabold">“{lesson.title}.”</Text>
      </Text>
      <View className="flex-row gap-3">
        <Button className="flex-1" size="sm" title="Open lesson" testID="lesson-suggestion-open" onPress={() => onOpen(lesson.id)} />
        <Button className="flex-1" size="sm" variant="secondary" title="Not now" testID="lesson-suggestion-dismiss" onPress={dismiss} />
      </View>
    </View>
  );
}
