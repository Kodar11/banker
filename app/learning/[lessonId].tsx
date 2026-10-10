import { useLocalSearchParams } from 'expo-router';
import { LessonPlayer } from '@/features/learning/LessonPlayer';

export default function LessonRoute() {
  const { lessonId } = useLocalSearchParams<{ lessonId: string }>();
  return <LessonPlayer lessonId={lessonId ?? ''} />;
}
