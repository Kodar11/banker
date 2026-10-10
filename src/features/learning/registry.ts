import { cashAfter } from './calc';
import { LESSON_COLLECTIONS, LESSONS } from './lessons';
import type { ChoiceId, CollectionId, Lesson, LessonChoice, LessonCollection, SceneBlock, SceneKind } from './types';

/** Every scene kind the lesson player can draw. A lesson that uses anything else fails validation. */
export const SCENE_KINDS: readonly SceneKind[] = ['cash', 'holdings', 'trade', 'auction', 'presentValue', 'growth', 'loanComparison', 'schedule', 'credit', 'compare', 'note'];

export const TOTAL_LESSONS = LESSONS.length;

export function getLesson(id: string | null | undefined): Lesson | null {
  return LESSONS.find((lesson) => lesson.id === id) ?? null;
}

export function getChoice(lesson: Lesson, id: string | null | undefined): LessonChoice | null {
  return lesson.choices.find((choice) => choice.id === id) ?? null;
}

export function getCollection(id: CollectionId): LessonCollection {
  return LESSON_COLLECTIONS.find((collection) => collection.id === id)!;
}

export function lessonsIn(collectionId: CollectionId): Lesson[] {
  return LESSONS.filter((lesson) => lesson.collectionId === collectionId);
}

/** The lesson after this one in the overall order; null after the last. */
export function nextLesson(id: string): Lesson | null {
  const index = LESSONS.findIndex((lesson) => lesson.id === id);
  return index >= 0 ? (LESSONS[index + 1] ?? null) : null;
}

export function lessonRoute(id: string): `/learning/${string}` {
  return `/learning/${id}`;
}

export interface LearningCounts {
  completed: number;
  total: number;
}

/** Progress is always derived from the completion records, so a count can never drift from them. */
export function countCompleted(completedIds: readonly string[], collectionId?: CollectionId): LearningCounts {
  const lessons = collectionId ? lessonsIn(collectionId) : LESSONS;
  return { completed: lessons.filter((lesson) => completedIds.includes(lesson.id)).length, total: lessons.length };
}

/** The lesson a finished game points to: the first one not completed yet, or none once all are done. */
export function suggestedLesson(completedIds: readonly string[]): Lesson | null {
  return LESSONS.find((lesson) => !completedIds.includes(lesson.id)) ?? null;
}

const CHOICE_IDS: readonly ChoiceId[] = ['a', 'b', 'c'];

function sceneProblems(where: string, scene: readonly SceneBlock[]): string[] {
  const problems: string[] = [];
  for (const block of scene) {
    if (!SCENE_KINDS.includes(block.kind)) problems.push(`${where}: unknown scene kind "${block.kind}"`);
    // A story never shows a player below zero: a bill that cannot be paid is explained, not booked.
    if (block.kind === 'cash' && cashAfter(block.start, block.movements.map((m) => m.amount)).lowest < 0) problems.push(`${where}: cash goes below zero`);
    if (block.kind === 'holdings' && block.holders.some((h) => (h.cash ?? 0) < 0)) problems.push(`${where}: a holder has negative cash`);
    if (block.kind === 'loanComparison' && block.variablePaths.some((p) => p.ratesByYear.length !== block.years)) problems.push(`${where}: a rate path does not cover every year`);
  }
  return problems;
}

/** Everything wrong with the lesson data, as readable sentences. Empty = valid. Checked by the tests. */
export function validateLessons(lessons: readonly Lesson[] = LESSONS, collections: readonly LessonCollection[] = LESSON_COLLECTIONS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const slugs = new Set<string>();
  for (const lesson of lessons) {
    const at = lesson.id || '(no id)';
    if (seen.has(lesson.id)) problems.push(`${at}: duplicate id`);
    if (slugs.has(lesson.slug)) problems.push(`${at}: duplicate slug`);
    seen.add(lesson.id);
    slugs.add(lesson.slug);
    if (!collections.some((c) => c.id === lesson.collectionId)) problems.push(`${at}: unknown collection`);
    if (!SCENE_KINDS.includes(lesson.visualType)) problems.push(`${at}: unknown visual type`);
    for (const [name, text] of Object.entries({ title: lesson.title, summary: lesson.summary, decisionPrompt: lesson.decisionPrompt, boardLesson: lesson.boardLesson, realLifeConnection: lesson.realLifeConnection, situation: lesson.situation.text })) {
      if (!text.trim()) problems.push(`${at}: empty ${name}`);
    }
    if (lesson.situation.scene.length === 0) problems.push(`${at}: the situation shows nothing`);
    problems.push(...sceneProblems(`${at} situation`, lesson.situation.scene));
    if (lesson.choices.length < 2 || lesson.choices.length > 3) problems.push(`${at}: needs two or three choices`);
    lesson.choices.forEach((choice, i) => {
      const where = `${at} choice ${choice.id}`;
      if (choice.id !== CHOICE_IDS[i]) problems.push(`${where}: choices must be a, b, c in order`);
      if (!choice.label.trim() || !choice.description.trim()) problems.push(`${where}: missing label or description`);
      if (!choice.outcome.headline.trim() || !choice.outcome.text.trim()) problems.push(`${where}: missing outcome text`);
      if (choice.outcome.scene.length === 0) problems.push(`${where}: the outcome shows nothing`);
      problems.push(...sceneProblems(where, choice.outcome.scene));
    });
    const kinds = [...lesson.situation.scene, ...lesson.choices.flatMap((c) => c.outcome.scene)].map((b) => b.kind);
    if (!kinds.includes(lesson.visualType)) problems.push(`${at}: its visual type is never shown`);
  }
  return problems;
}
