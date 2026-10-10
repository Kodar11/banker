import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button, Card, ErrorState, Label } from '@/components/ui';
import { useLearningStore, type LessonResume } from '@/store/learningStore';
import { haptics } from '@/utils/haptics';
import { goBack } from '@/utils/navigation';
import { CHOICE_HOLD_MS, useMotion } from './motion';
import { getChoice, getCollection, getLesson, lessonRoute, nextLesson, TOTAL_LESSONS } from './registry';
import { Tag } from './scenes/parts';
import { SceneView } from './scenes/SceneView';
import { LESSON_STAGES, type Lesson, type LessonChoice, type LessonStage } from './types';

const LEARNING_HOME = '/learning';
const STAGE_NAMES: Record<LessonStage, string> = { situation: 'Situation', decision: 'Decision', consequence: 'What happened', takeaway: 'Takeaway' };
const FRESH: LessonResume = { stage: 'situation', choiceId: null };

/**
 * Where a lesson opens: at the stage it was left on when that is still a consistent place to be
 * (a consequence or takeaway needs the choice that led to it); from the beginning otherwise.
 */
export function resumePoint(lesson: Lesson, saved: LessonResume | undefined): LessonResume {
  if (!saved) return FRESH;
  const choice = getChoice(lesson, saved.choiceId);
  if (saved.stage === 'consequence' || saved.stage === 'takeaway') return choice ? { stage: saved.stage, choiceId: choice.id } : FRESH;
  return { stage: saved.stage, choiceId: null };
}

/** Opens a lesson by id: the lesson player once progress has been read, or a way back if the id is unknown. */
export function LessonPlayer({ lessonId }: { lessonId: string }) {
  const lesson = getLesson(lessonId);
  const hydrated = useLearningStore((s) => s.hydrated);
  const hydrate = useLearningStore((s) => s.hydrate);
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  if (!lesson) {
    return (
      <ErrorState title="Lesson not found" message="This lesson does not exist." action={<Button size="md" title="All lessons" testID="lesson-missing-home" onPress={() => router.dismissTo(LEARNING_HOME)} />} />
    );
  }
  // Stored progress is local and arrives within a moment; nothing is drawn (no spinner) until it has.
  if (!hydrated) return <View className="flex-1 bg-felt" testID="lesson-loading" />;
  return <LessonStory key={lesson.id} lesson={lesson} />;
}

/** Short names that fit under the four step bars; the full name is read out by screen readers. */
const STEP_LABELS: Record<LessonStage, string> = { situation: 'Situation', decision: 'Decision', consequence: 'Outcome', takeaway: 'Takeaway' };

/** The four steps of a lesson as equal segments: done, current (marked with a dot and bold), still to come. */
function StageSteps({ stage }: { stage: LessonStage }) {
  const at = LESSON_STAGES.indexOf(stage);
  return (
    <View className="flex-row gap-1.5" testID="lesson-stage" accessible accessibilityRole="progressbar" accessibilityLabel={`Step ${at + 1} of ${LESSON_STAGES.length}: ${STAGE_NAMES[stage]}`}>
      {LESSON_STAGES.map((s, i) => (
        <View key={s} className="flex-1 gap-1.5">
          <View className={`h-1.5 rounded-full ${i === at ? 'bg-saffron' : i < at ? 'bg-cream' : 'bg-white/20'}`} />
          <Text numberOfLines={1} maxFontSizeMultiplier={1.2} className={`text-center text-[11px] ${i === at ? 'font-extrabold text-saffron' : i < at ? 'font-semibold text-cream/80' : 'font-semibold text-cream/40'}`}>
            {i === at ? '● ' : i < at ? '✓ ' : ''}
            {STEP_LABELS[s]}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A round 44pt control in the lesson's top bar. */
function BarButton({ glyph, label, hint, testID, onPress }: { glyph: string; label: string; hint: string; testID: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={4}
      className="h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-white/10 active:opacity-70"
    >
      <Text className="text-xl font-bold leading-6 text-cream">{glyph}</Text>
    </Pressable>
  );
}

interface ChoiceRowProps {
  choice: LessonChoice;
  letter: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ChoiceRow({ choice, letter, selected, disabled, onPress }: ChoiceRowProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={`lesson-choice-${choice.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Option ${letter}: ${choice.label}. ${choice.description}`}
      accessibilityState={{ selected, disabled }}
      className={`min-h-[64px] flex-row items-center gap-3 rounded-2xl border-2 px-3 py-3 active:opacity-80 ${selected ? 'border-saffron bg-amber-100' : 'border-stone-200 bg-white'} ${disabled && !selected ? 'opacity-50' : ''}`}
    >
      <View className={`h-9 w-9 items-center justify-center rounded-full ${selected ? 'bg-saffron' : 'bg-stone-200'}`}>
        <Text className="text-base font-black text-ink">{selected ? '✓' : letter}</Text>
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-extrabold leading-5 text-ink">{choice.label}</Text>
        <Text className="text-sm leading-5 text-stone-600">{choice.description}</Text>
        {selected ? <Text className="text-xs font-extrabold uppercase tracking-wider text-amber-800">Selected</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * The reusable lesson player: one story from lesson data, in four stages — situation, one
 * decision, its consequence, the takeaway. All of its state is its own (and the learning store's
 * resume point); it never touches a game.
 */
function LessonStory({ lesson }: { lesson: Lesson }) {
  const saveResume = useLearningStore((s) => s.saveResume);
  const clearResume = useLearningStore((s) => s.clearResume);
  const complete = useLearningStore((s) => s.complete);
  const animate = useMotion();
  const [at, setAt] = useState<LessonResume>(() => resumePoint(lesson, useLearningStore.getState().inProgress[lesson.id]));
  /** The choice just tapped, highlighted for a moment before its consequence. While set, nothing else can be chosen. */
  const [picking, setPicking] = useState<string | null>(null);
  const locked = useRef(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chosen = getChoice(lesson, at.choiceId);
  const next = nextLesson(lesson.id);

  // Remember where the lesson is, so leaving at any point resumes here. A lesson that was only
  // opened (still on its first screen) is not "in progress".
  useEffect(() => {
    if (at.stage === 'situation') clearResume(lesson.id);
    else saveResume(lesson.id, at);
  }, [at, lesson.id, saveResume, clearResume]);

  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current);
    },
    [],
  );

  const go = useCallback((stage: LessonStage, choiceId: string | null) => {
    locked.current = false;
    setPicking(null);
    setAt({ stage, choiceId });
  }, []);

  const choose = (choice: LessonChoice) => {
    // One decision, taken once: a second tap during the transition does nothing.
    if (locked.current || at.stage !== 'decision') return;
    locked.current = true;
    haptics.tap();
    if (!animate) {
      go('consequence', choice.id);
      return;
    }
    setPicking(choice.id);
    hold.current = setTimeout(() => go('consequence', choice.id), CHOICE_HOLD_MS);
  };

  const back = () => {
    if (locked.current) return;
    if (at.stage === 'situation') goBack(LEARNING_HOME);
    else if (at.stage === 'decision') go('situation', null);
    // Back to the decision clears the choice: the consequence on screen always belongs to the choice made.
    else if (at.stage === 'consequence') go('decision', null);
    else go('consequence', at.choiceId);
  };

  /** Leave now. Where the lesson is has already been saved; it is not marked completed. */
  const exit = () => goBack(LEARNING_HOME);

  /** Move on without finishing: the lesson stays incomplete and starts from the beginning next time. */
  const skip = () => {
    clearResume(lesson.id);
    if (next) router.replace(lessonRoute(next.id));
    else router.dismissTo(LEARNING_HOME);
  };

  /** The learner has read the takeaway and moves on: this is what completes a lesson. */
  const acknowledge = (then: 'next' | 'home' | 'replay') => {
    complete(lesson.id);
    haptics.success();
    if (then === 'replay') go('situation', null);
    else if (then === 'next' && next) router.replace(lessonRoute(next.id));
    else router.dismissTo(LEARNING_HOME);
  };

  let body;
  let footer;
  if (at.stage === 'situation') {
    body = (
      <Card className="gap-3" testID="lesson-situation">
        <Label>The situation</Label>
        <Text accessibilityRole="header" className="text-2xl font-black leading-8 text-ink">
          {lesson.situation.title}
        </Text>
        <Text className="text-base leading-6 text-stone-700">{lesson.situation.text}</Text>
        <SceneView blocks={lesson.situation.scene} testID="lesson-scene" />
      </Card>
    );
    footer = <Button title="Make a decision" testID="lesson-decide" onPress={() => go('decision', null)} />;
  } else if (at.stage === 'decision') {
    body = (
      <Card className="gap-3" testID="lesson-decision">
        <Label>Your decision</Label>
        <Text accessibilityRole="header" className="text-2xl font-black leading-8 text-ink">
          {lesson.decisionPrompt}
        </Text>
        <Text className="text-sm leading-5 text-stone-600">{lesson.situation.text}</Text>
        <View className="gap-2">
          {lesson.choices.map((choice, i) => (
            <ChoiceRow key={choice.id} choice={choice} letter={String.fromCharCode(65 + i)} selected={picking === choice.id} disabled={picking !== null} onPress={() => choose(choice)} />
          ))}
        </View>
        <Text className="text-xs leading-5 text-stone-500">Pick one. There is no right or wrong answer here — each option has its own trade-off.</Text>
      </Card>
    );
  } else if (at.stage === 'consequence' && chosen) {
    const others = lesson.choices.filter((c) => c.id !== chosen.id);
    body = (
      <Card className="gap-3" testID="lesson-consequence">
        <Label>What happened</Label>
        <View className="flex-row flex-wrap items-center gap-2" testID="lesson-chosen">
          <Tag tone="gold">You chose</Tag>
          <Text className="flex-1 text-sm font-extrabold text-ink">{chosen.label}</Text>
        </View>
        <Text accessibilityRole="header" className="text-xl font-black leading-7 text-ink" testID="lesson-outcome-headline">
          {chosen.outcome.headline}
        </Text>
        <SceneView blocks={chosen.outcome.scene} testID="lesson-scene" />
        <Text className="text-base leading-6 text-stone-700">{chosen.outcome.text}</Text>
        <View className="gap-2 rounded-2xl bg-white p-3" testID="lesson-other-options">
          <Label>The other options, briefly</Label>
          {others.map((other) => (
            <View key={other.id} className="gap-0.5">
              <Text className="text-sm font-extrabold text-ink">{other.label}</Text>
              <Text className="text-sm leading-5 text-stone-600">{other.outcome.headline}</Text>
            </View>
          ))}
        </View>
      </Card>
    );
    footer = <Button title="See the takeaway" testID="lesson-to-takeaway" onPress={() => go('takeaway', chosen.id)} />;
  } else {
    body = (
      <Card className="gap-3" testID="lesson-takeaway">
        <Label>Takeaway</Label>
        <Text accessibilityRole="header" className="text-2xl font-black leading-8 text-ink">
          {lesson.title}
        </Text>
        <View className="gap-1 rounded-2xl bg-white p-3" testID="lesson-board-lesson">
          <Label>🎲 Board lesson</Label>
          <Text className="text-base font-bold leading-6 text-ink">{lesson.boardLesson}</Text>
        </View>
        <View className="gap-1 rounded-2xl bg-white p-3" testID="lesson-real-life">
          <Label>🌍 Real-life connection</Label>
          <Text className="text-base leading-6 text-stone-700">{lesson.realLifeConnection}</Text>
        </View>
        <Text className="text-xs leading-5 text-stone-500">An illustrated example for learning, not personal financial advice.</Text>
      </Card>
    );
    footer = (
      <>
        <Button
          title={next ? 'Next lesson' : 'Finish'}
          subtitle={next ? next.title : 'Back to all lessons'}
          testID="lesson-continue"
          onPress={() => acknowledge(next ? 'next' : 'home')}
        />
        <View className="flex-row gap-3">
          <Button className="flex-1" size="sm" variant="secondary" title="All lessons" testID="lesson-to-collection" onPress={() => acknowledge('home')} />
          <Button className="flex-1" size="sm" variant="secondary" title="Replay" testID="lesson-replay" onPress={() => acknowledge('replay')} />
        </View>
      </>
    );
  }

  return (
    <SafeAreaView testID="lesson-player" className="flex-1 bg-felt" edges={['top', 'bottom', 'left', 'right']}>
      <View className="gap-3 px-5 pb-3 pt-2" testID="lesson-header">
        {/* Two equal round buttons either side, so what sits between them is truly centred. */}
        <View className="flex-row items-center gap-3">
          <BarButton glyph="‹" label="Back" hint={at.stage === 'situation' ? 'Leaves the lesson' : 'Goes to the previous step'} testID="lesson-back" onPress={back} />
          <View className="flex-1 items-center" testID="lesson-position">
            <Text numberOfLines={1} className="text-[11px] font-extrabold uppercase tracking-[2px] text-saffron">
              Lesson {lesson.number} of {TOTAL_LESSONS}
            </Text>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} className="text-sm font-bold text-cream/80">
              {getCollection(lesson.collectionId).title}
            </Text>
          </View>
          <BarButton glyph="✕" label="Exit lesson" hint="Leaves the lesson. You can resume it later." testID="lesson-exit" onPress={exit} />
        </View>
        <Text accessibilityRole="header" className="px-2 text-center text-2xl font-black leading-8 text-cream" testID="lesson-title">
          {lesson.title}
        </Text>
        <StageSteps stage={at.stage} />
      </View>
      {/* Keyed by stage: each stage starts scrolled to the top and mounts only its own scene. */}
      <ScrollView key={at.stage} contentContainerClassName="px-5 pb-6 pt-2">
        {body}
      </ScrollView>
      <View className="gap-2 px-5 pb-3 pt-2">
        {footer}
        {/* The takeaway already offers the next lesson; before that, skipping is a quiet link under the main action. */}
        {at.stage === 'takeaway' ? null : (
          <Pressable onPress={skip} testID="lesson-skip" accessibilityRole="button" accessibilityLabel="Skip this lesson" accessibilityHint="Leaves this lesson unfinished and opens the next one" className="min-h-[44px] items-center justify-center active:opacity-70">
            <Text className="text-sm font-bold text-cream/70">Skip this lesson ›</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}
