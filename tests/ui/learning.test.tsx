/// <reference types="jest" />
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { router, useLocalSearchParams } from 'expo-router';
import Home from '../../app/index';
import LearningRoute from '../../app/learning/index';
import LessonRoute from '../../app/learning/[lessonId]';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { LearningHome } from '@/features/learning/LearningHome';
import { LessonPlayer, resumePoint } from '@/features/learning/LessonPlayer';
import { LessonSuggestion } from '@/features/learning/LessonSuggestion';
import { LESSON_COLLECTIONS, LESSONS } from '@/features/learning/lessons';
import { CHOICE_HOLD_MS, learningMotion } from '@/features/learning/motion';
import { getLesson } from '@/features/learning/registry';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { LEARNING_STORAGE_KEY, useLearningStore } from '@/store/learningStore';
import { useSessionStore } from '@/store/sessionStore';
import { netWorth, outstandingDebt } from '@/engine/index.ts';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const store = SecureStore as jest.Mocked<typeof SecureStore>;
const learning = () => useLearningStore.getState();

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
  const current = snapshot.state.players.find((p) => p.id === snapshot.state.turn.playerId) ?? null;
  return {
    snapshot,
    me,
    current,
    isMyTurn: !!me && current?.id === me.id && snapshot.state.status === 'ACTIVE',
    isHost: !!me?.isHost,
    playerName: (id) => snapshot.state.players.find((p) => p.id === id)?.name ?? 'Bank',
    myNetWorth: me ? netWorth(snapshot.state, me.id) : 0,
    myDebt: me ? outstandingDebt(snapshot.state.loans, me.id) : 0,
  };
}

/** What a restart leaves: nothing in memory, only what was written to the device. */
function restartApp() {
  useLearningStore.setState({ completed: [], inProgress: {}, hydrated: false, suggestionDismissed: false });
}

const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));

/** Plays a lesson from its first screen to its takeaway with the given choice. */
async function playTo(stage: 'decision' | 'consequence' | 'takeaway', choice = 'a') {
  await press('lesson-decide');
  if (stage === 'decision') return;
  await press(`lesson-choice-${choice}`);
  if (stage === 'consequence') return;
  await press('lesson-to-takeaway');
}

beforeEach(async () => {
  jest.clearAllMocks();
  learningMotion.enabled = false;
  await SecureStore.deleteItemAsync(LEARNING_STORAGE_KEY);
  useLearningStore.setState({ completed: [], inProgress: {}, hydrated: true, suggestionDismissed: false });
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  jest.clearAllMocks();
});

afterEach(() => {
  learningMotion.enabled = true;
});

describe('Financial Learning home', () => {
  it('shows the title, four collections with counts, overall progress and every lesson as not started', async () => {
    await render(<LearningRoute />);
    expect(screen.getByText('Financial Learning')).toBeTruthy();
    expect(screen.getByTestId('learning-progress-text')).toHaveTextContent('0 of 15 lessons completed');
    expect(LESSON_COLLECTIONS.map((c) => c.id)).toEqual(['cash', 'property', 'debt', 'strategy']);
    for (const [id, total] of [['cash', 4], ['property', 4], ['debt', 4], ['strategy', 3]] as const) {
      const card = screen.getByTestId(`collection-${id}`);
      expect(within(card).getByTestId(`collection-count-${id}`)).toHaveTextContent(`0/${total}`);
      expect(within(card).getAllByText('Not started')).toHaveLength(total);
    }
    for (const lesson of LESSONS) {
      expect(screen.getByTestId(`lesson-row-${lesson.id}`)).toHaveTextContent(new RegExp(lesson.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      expect(screen.getByTestId(`lesson-action-${lesson.id}`)).toHaveTextContent(/Start/);
    }
    // Nothing to reset yet.
    expect(screen.queryByTestId('learning-reset')).toBeNull();
  });

  it('opens any lesson directly — the last one needs none of the earlier ones', async () => {
    await render(<LearningHome />);
    await press('lesson-row-L15');
    expect(router.push).toHaveBeenCalledWith('/learning/L15');
    await press('lesson-row-L01');
    expect(router.push).toHaveBeenCalledWith('/learning/L01');
  });

  it('Back leaves the module', async () => {
    await render(<LearningHome />);
    await press('learning-back');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('shows completed, in-progress and not-started lessons in words, and counts from the completion records', async () => {
    useLearningStore.setState({ completed: ['L01', 'L02', 'L05', 'L09', 'L13'], inProgress: { L03: { stage: 'decision', choiceId: null } } });
    await render(<LearningHome />);
    expect(screen.getByTestId('learning-progress-text')).toHaveTextContent('5 of 15 lessons completed');
    expect(screen.getByTestId('collection-count-cash')).toHaveTextContent('2/4');
    expect(screen.getByTestId('collection-count-property')).toHaveTextContent('1/4');
    expect(screen.getByTestId('collection-count-debt')).toHaveTextContent('1/4');
    expect(screen.getByTestId('collection-count-strategy')).toHaveTextContent('1/3');
    expect(screen.getByTestId('lesson-status-L01')).toHaveTextContent('Completed');
    expect(screen.getByTestId('lesson-action-L01')).toHaveTextContent(/Replay/);
    expect(screen.getByTestId('lesson-status-L03')).toHaveTextContent('In progress');
    expect(screen.getByTestId('lesson-action-L03')).toHaveTextContent(/Resume/);
    expect(screen.getByTestId('lesson-status-L04')).toHaveTextContent('Not started');
    expect(screen.getByTestId('lesson-row-L01').props.accessibilityLabel).toContain('Completed');
    // Replay opens the same lesson.
    await press('lesson-row-L01');
    expect(router.push).toHaveBeenCalledWith('/learning/L01');
  });

  it('resets progress only after an explicit confirmation', async () => {
    useLearningStore.setState({ completed: ['L01'], inProgress: { L02: { stage: 'takeaway', choiceId: 'b' } } });
    await render(<LearningHome />);
    await press('learning-reset');
    await fireEvent.press(within(screen.getByTestId('learning-reset-dialog')).getByText('Cancel'));
    expect(learning().completed).toEqual(['L01']);
    await press('learning-reset');
    await fireEvent.press(within(screen.getByTestId('learning-reset-dialog')).getByText('Reset progress'));
    expect(learning().completed).toEqual([]);
    expect(learning().inProgress).toEqual({});
    expect(screen.getByTestId('learning-progress-text')).toHaveTextContent('0 of 15 lessons completed');
  });
});

describe('Lesson player', () => {
  it('walks through situation, decision, consequence and takeaway', async () => {
    const lesson = getLesson('L03')!;
    await render(<LessonPlayer lessonId="L03" />);
    expect(screen.getByTestId('lesson-position')).toHaveTextContent(/Lesson 3 of 15\s*Cash & Liquidity/);
    expect(screen.getByTestId('lesson-stage').props.accessibilityLabel).toBe('Step 1 of 4: Situation');
    expect(screen.getByTestId('lesson-situation')).toHaveTextContent(/Rent day/);
    expect(screen.getByTestId('lesson-situation')).toHaveTextContent(/₹2,000 of rent/);
    expect(screen.getByTestId('lesson-scene')).toBeTruthy();
    expect(screen.queryByTestId('lesson-decision')).toBeNull();

    await press('lesson-decide');
    expect(screen.getByTestId('lesson-stage').props.accessibilityLabel).toBe('Step 2 of 4: Decision');
    expect(screen.getByTestId('lesson-decision')).toHaveTextContent(new RegExp(lesson.decisionPrompt.replace('?', '\\?')));
    expect(screen.getAllByTestId(/^lesson-choice-/)).toHaveLength(3);
    expect(screen.getByTestId('lesson-choice-b').props.accessibilityLabel).toBe('Option B: Reserve it for the bills. Pay what is due before anything else.');

    await press('lesson-choice-b');
    expect(screen.getByTestId('lesson-stage').props.accessibilityLabel).toBe('Step 3 of 4: What happened');
    expect(screen.getByTestId('lesson-chosen')).toHaveTextContent(/Reserve it for the bills/);
    expect(screen.getByTestId('lesson-outcome-headline')).toHaveTextContent('Bills paid in full. Cash goes from ₹1,500 to ₹1,000.');
    // The consequence is on screen as figures, not only as an animation.
    expect(screen.getByTestId('scene-cash-end')).toHaveTextContent('₹1,000');
    expect(screen.getByTestId('scene-cash')).toHaveTextContent(/Rent received\+₹2,000/);
    expect(screen.getByTestId('scene-cash')).toHaveTextContent(/Loan installment−₹2,000/);
    expect(screen.getByText(/-₹500 net/)).toBeTruthy();
    // The options not taken are summarised; they are not a second decision.
    const others = screen.getByTestId('lesson-other-options');
    expect(others).toHaveTextContent(/Spend the rent/);
    expect(others).toHaveTextContent(/Pay the bills, then cut debt/);
    expect(screen.queryByTestId('lesson-choice-a')).toBeNull();

    await press('lesson-to-takeaway');
    expect(screen.getByTestId('lesson-stage').props.accessibilityLabel).toBe('Step 4 of 4: Takeaway');
    expect(screen.getByTestId('lesson-board-lesson')).toHaveTextContent(new RegExp(lesson.boardLesson));
    expect(screen.getByTestId('lesson-real-life')).toHaveTextContent(new RegExp(lesson.realLifeConnection));
    // Reaching the takeaway is not yet completing it.
    expect(learning().completed).toEqual([]);
  });

  it('every lesson and every choice can be played to the end, offline, with its own consequence', async () => {
    for (const lesson of LESSONS) {
      for (const choice of lesson.choices) {
        useLearningStore.setState({ inProgress: {} });
        const view = await render(<LessonPlayer lessonId={lesson.id} />);
        expect(screen.getByTestId('lesson-situation')).toBeTruthy();
        await playTo('consequence', choice.id);
        expect(screen.getByTestId('lesson-outcome-headline')).toHaveTextContent(choice.outcome.headline);
        expect(screen.queryByTestId('scene-fallback')).toBeNull();
        await press('lesson-to-takeaway');
        expect(screen.getByTestId('lesson-board-lesson')).toBeTruthy();
        await press('lesson-continue');
        await view.unmount();
      }
    }
    expect([...learning().completed].sort()).toEqual(LESSONS.map((l) => l.id).sort());
    expect(api.action).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
  });

  it('the concept scenes show their figures: present value, compounding, loans, mortgage, credit', async () => {
    let view = await render(<LessonPlayer lessonId="L04" />);
    expect(screen.queryByTestId('scene-present-value-discount')).toBeNull(); // the situation does not give the answer away
    await playTo('consequence', 'b');
    expect(screen.getByTestId('scene-present-value-discount')).toHaveTextContent(/PV = FV \/ \(1 \+ r\)\^n/);
    expect(screen.getByTestId('scene-present-value-discount')).toHaveTextContent(/₹12,000 \/ \(1\.10\)\^2 ≈ ₹9,917/);
    expect(screen.getByTestId('scene-present-value-compare')).toHaveTextContent(/the payment today is worth ₹83 more/);
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L08" />);
    await playTo('consequence', 'b');
    expect(screen.getByTestId('scene-growth-formula')).toHaveTextContent(/₹5,000 × \(1\.05\)\^5 ≈ ₹6,381/);
    for (const [year, value] of [[0, '₹5,000'], [1, '₹5,250'], [2, '₹5,513'], [3, '₹5,788'], [4, '₹6,078'], [5, '₹6,381']] as const) {
      expect(screen.getByTestId(`scene-growth-year-${year}`)).toHaveTextContent(value);
    }
    expect(screen.getByText('Hypothetical')).toBeTruthy();
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L15" />);
    await playTo('consequence', 'c');
    expect(screen.getByTestId('scene-growth-alternatives')).toHaveTextContent(/Falling: 3% a year≈ ₹4,294/);
    expect(screen.getByText(/not that model/)).toBeTruthy();
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L09" />);
    await playTo('consequence', 'c');
    expect(screen.getByTestId('scene-loan-row-0')).toHaveTextContent(/Fixed rate.*10% every year.*₹12,064/);
    expect(screen.getByTestId('scene-loan-row-2')).toHaveTextContent(/less than the fixed loan/);
    expect(screen.getByTestId('scene-loan-row-3')).toHaveTextContent(/Rates jump.*Hypothetical.*7% → 13% → 16%.*more than the fixed loan/);
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L11" />);
    await playTo('consequence', 'a');
    expect(screen.getByTestId('scene-cash')).toHaveTextContent(/Hill Court mortgaged\+₹5,000/);
    expect(screen.getByTestId('scene-holdings')).toHaveTextContent(/Mortgaged · no rent · 2 houses inactive/);
    expect(screen.getByTestId('scene-schedule')).toHaveTextContent(/₹5,500/);
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L12" />);
    await playTo('consequence', 'b');
    expect(screen.getByTestId('scene-credit')).toHaveTextContent(/Installment overdue−20 → 680/);
    expect(screen.getByTestId('scene-credit')).toHaveTextContent(/Caught up\+5 → 685/);
    expect(screen.getByTestId('scene-credit-score')).toHaveTextContent('685');
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    view = await render(<LessonPlayer lessonId="L13" />);
    expect(screen.getByTestId('scene-trade-proposed')).toBeTruthy();
    await playTo('consequence', 'c');
    expect(screen.getByTestId('scene-trade-declined')).toHaveTextContent(/nothing changes hands/i);
    await view.unmount();

    useLearningStore.setState({ inProgress: {} });
    await render(<LessonPlayer lessonId="L02" />);
    await playTo('consequence', 'a');
    expect(screen.getByTestId('scene-auction-result')).toHaveTextContent(/You win at ₹5,000/);
    expect(screen.getByTestId('scene-cash-reserve')).toHaveTextContent(/₹1,000 short/);
  });

  it('a second tap during the transition cannot pick another choice or start it twice', async () => {
    jest.useFakeTimers();
    try {
      learningMotion.enabled = true;
      await render(<LessonPlayer lessonId="L01" />);
      await press('lesson-decide');
      await press('lesson-choice-a');
      // The tapped choice is shown as selected, and every option is locked while it moves on.
      expect(screen.getByTestId('lesson-choice-a').props.accessibilityState).toEqual({ selected: true, disabled: true });
      expect(screen.getByTestId('lesson-choice-a')).toHaveTextContent(/Selected/);
      expect(screen.getByTestId('lesson-choice-b').props.accessibilityState).toEqual({ selected: false, disabled: true });
      await press('lesson-choice-b');
      await press('lesson-choice-a');
      await press('lesson-back');
      expect(screen.getByTestId('lesson-decision')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(CHOICE_HOLD_MS + 50);
      });
      expect(screen.getByTestId('lesson-outcome-headline')).toHaveTextContent(getLesson('L01')!.choices[0]!.outcome.headline);
      expect(learning().inProgress.L01).toEqual({ stage: 'consequence', choiceId: 'a' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('Back steps through the stages without leaving a stale choice behind', async () => {
    await render(<LessonPlayer lessonId="L01" />);
    await playTo('takeaway', 'c');
    await press('lesson-back');
    expect(screen.getByTestId('lesson-chosen')).toHaveTextContent(/Borrow from the bank/);
    await press('lesson-back');
    expect(screen.getByTestId('lesson-decision')).toBeTruthy();
    expect(learning().inProgress.L01).toEqual({ stage: 'decision', choiceId: null });
    await press('lesson-choice-a');
    expect(screen.getByTestId('lesson-chosen')).toHaveTextContent(/Keep everything, pay the tax/);
    await press('lesson-back');
    await press('lesson-back');
    expect(screen.getByTestId('lesson-situation')).toBeTruthy();
    expect(learning().inProgress.L01).toBeUndefined();
    // From the first screen, Back leaves the lesson.
    await press('lesson-back');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('opening a lesson does not mark it completed or in progress', async () => {
    await render(<LessonPlayer lessonId="L06" />);
    expect(learning().completed).toEqual([]);
    expect(learning().inProgress).toEqual({});
  });

  it('Skip leaves the lesson incomplete and opens the next one', async () => {
    await render(<LessonPlayer lessonId="L01" />);
    await playTo('consequence', 'b');
    await press('lesson-skip');
    expect(router.replace).toHaveBeenCalledWith('/learning/L02');
    expect(learning().completed).toEqual([]);
    expect(learning().inProgress.L01).toBeUndefined();
  });

  it('Skip on the last lesson returns to the lesson list', async () => {
    await render(<LessonPlayer lessonId="L15" />);
    await press('lesson-skip');
    expect(router.dismissTo).toHaveBeenCalledWith('/learning');
    expect(learning().completed).toEqual([]);
  });

  it('Exit mid-lesson keeps it incomplete and resumes at the same consequence later', async () => {
    const first = await render(<LessonPlayer lessonId="L07" />);
    await playTo('consequence', 'c');
    await press('lesson-exit');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(learning().completed).toEqual([]);
    expect(learning().inProgress.L07).toEqual({ stage: 'consequence', choiceId: 'c' });
    await first.unmount();

    await render(<LessonPlayer lessonId="L07" />);
    expect(screen.getByTestId('lesson-consequence')).toBeTruthy();
    expect(screen.getByTestId('lesson-chosen')).toHaveTextContent(/Hold for a recovery/);
    expect(screen.getByTestId('lesson-outcome-headline')).toHaveTextContent(getLesson('L07')!.choices[2]!.outcome.headline);
  });

  it('exiting at the takeaway without acknowledging it does not complete the lesson', async () => {
    await render(<LessonPlayer lessonId="L02" />);
    await playTo('takeaway', 'b');
    await press('lesson-exit');
    expect(learning().completed).toEqual([]);
    expect(learning().inProgress.L02).toEqual({ stage: 'takeaway', choiceId: 'b' });
  });

  it('acknowledging the takeaway completes the lesson once and moves to the next', async () => {
    await render(<LessonPlayer lessonId="L01" />);
    await playTo('takeaway');
    expect(screen.getByTestId('lesson-continue')).toHaveTextContent(/Next lesson.*The Auction Temptation/);
    await press('lesson-continue');
    expect(learning().completed).toEqual(['L01']);
    expect(learning().inProgress.L01).toBeUndefined();
    expect(router.replace).toHaveBeenCalledWith('/learning/L02');
  });

  it('"All lessons" completes the lesson and returns to the collection list', async () => {
    await render(<LessonPlayer lessonId="L10" />);
    await playTo('takeaway', 'b');
    await press('lesson-to-collection');
    expect(learning().completed).toEqual(['L10']);
    expect(router.dismissTo).toHaveBeenCalledWith('/learning');
  });

  it('the last lesson finishes back at the lesson list', async () => {
    await render(<LessonPlayer lessonId="L15" />);
    await playTo('takeaway', 'b');
    expect(screen.getByTestId('lesson-continue')).toHaveTextContent(/Finish/);
    await press('lesson-continue');
    expect(learning().completed).toEqual(['L15']);
    expect(router.dismissTo).toHaveBeenCalledWith('/learning');
  });

  it('replaying a completed lesson starts clean and never counts twice', async () => {
    await render(<LessonPlayer lessonId="L05" />);
    await playTo('takeaway', 'a');
    await press('lesson-replay');
    expect(learning().completed).toEqual(['L05']);
    // A clean scenario: back on the first screen, with no choice carried over.
    expect(screen.getByTestId('lesson-situation')).toBeTruthy();
    expect(screen.getByTestId('scene-trade-proposed')).toBeTruthy();
    expect(learning().inProgress.L05).toBeUndefined();
    await playTo('takeaway', 'c');
    await press('lesson-replay');
    await playTo('takeaway', 'b');
    await press('lesson-to-collection');
    expect(learning().completed).toEqual(['L05']);
  });

  it('a completed lesson opened again from the list starts from the beginning', async () => {
    useLearningStore.setState({ completed: ['L03'] });
    await render(<LessonPlayer lessonId="L03" />);
    expect(screen.getByTestId('lesson-situation')).toBeTruthy();
    expect(screen.queryByTestId('lesson-chosen')).toBeNull();
  });

  it('a resume point that no longer makes sense restarts the lesson instead of showing a broken screen', async () => {
    const lesson = getLesson('L01')!;
    expect(resumePoint(lesson, undefined)).toEqual({ stage: 'situation', choiceId: null });
    expect(resumePoint(lesson, { stage: 'consequence', choiceId: 'zzz' })).toEqual({ stage: 'situation', choiceId: null });
    expect(resumePoint(lesson, { stage: 'takeaway', choiceId: null })).toEqual({ stage: 'situation', choiceId: null });
    expect(resumePoint(lesson, { stage: 'decision', choiceId: 'b' })).toEqual({ stage: 'decision', choiceId: null });
    expect(resumePoint(lesson, { stage: 'takeaway', choiceId: 'b' })).toEqual({ stage: 'takeaway', choiceId: 'b' });
    useLearningStore.setState({ inProgress: { L01: { stage: 'consequence', choiceId: 'zzz' } } });
    await render(<LessonPlayer lessonId="L01" />);
    expect(screen.getByTestId('lesson-situation')).toBeTruthy();
  });

  it('an unknown lesson offers a way back instead of crashing', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValueOnce({ lessonId: 'L99' });
    await render(<LessonRoute />);
    expect(screen.getByText('Lesson not found')).toBeTruthy();
    await press('lesson-missing-home');
    expect(router.dismissTo).toHaveBeenCalledWith('/learning');
  });

  it('the lesson route opens the lesson named in the URL', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValueOnce({ lessonId: 'L14' });
    await render(<LessonRoute />);
    expect(screen.getByTestId('lesson-position')).toHaveTextContent(/Lesson 14 of 15\s*Negotiation & Strategy/);
  });
});

describe('Learning progress persistence', () => {
  it('survives an app restart: completions and the resume point come back from the device', async () => {
    const first = await render(<LessonPlayer lessonId="L01" />);
    await playTo('takeaway');
    await press('lesson-continue');
    await first.unmount();
    const second = await render(<LessonPlayer lessonId="L04" />);
    await playTo('consequence', 'b');
    await second.unmount();
    expect(JSON.parse((await SecureStore.getItemAsync(LEARNING_STORAGE_KEY))!)).toEqual({ completed: ['L01'], inProgress: { L04: { stage: 'consequence', choiceId: 'b' } } });

    restartApp();
    await render(<LessonPlayer lessonId="L04" />);
    // Nothing is drawn until the stored progress has been read; then the lesson is where it was left.
    expect(await screen.findByTestId('lesson-consequence')).toBeTruthy();
    expect(screen.getByTestId('lesson-outcome-headline')).toHaveTextContent(/₹9,917/);
    expect(learning().completed).toEqual(['L01']);
  });

  it('the lesson list reads stored progress after a restart', async () => {
    await SecureStore.setItemAsync(LEARNING_STORAGE_KEY, JSON.stringify({ completed: ['L02', 'L11'], inProgress: {} }));
    restartApp();
    await render(<LearningHome />);
    expect(await screen.findByText('2 of 15 lessons completed')).toBeTruthy();
    expect(screen.getByTestId('collection-count-debt')).toHaveTextContent('1/4');
  });

  it('unreadable or broken storage leaves the lessons usable for this session', async () => {
    store.getItemAsync.mockRejectedValueOnce(new Error('storage unavailable'));
    store.setItemAsync.mockRejectedValue(new Error('storage unavailable'));
    restartApp();
    await render(<LessonPlayer lessonId="L01" />);
    expect(await screen.findByTestId('lesson-situation')).toBeTruthy();
    await playTo('takeaway');
    await press('lesson-to-collection');
    expect(learning().completed).toEqual(['L01']);
    store.setItemAsync.mockReset();
    store.setItemAsync.mockImplementation(async () => undefined);

    restartApp();
    store.getItemAsync.mockResolvedValueOnce('{not json');
    await learning().hydrate();
    expect(learning().hydrated).toBe(true);
    expect(learning().completed).toEqual([]);

    restartApp();
    store.getItemAsync.mockResolvedValueOnce(JSON.stringify({ completed: ['L01', 'L01', 7], inProgress: { L02: { stage: 'nowhere' }, L03: { stage: 'decision' } } }));
    await learning().hydrate();
    expect(learning().completed).toEqual(['L01']);
    expect(learning().inProgress).toEqual({ L03: { stage: 'decision', choiceId: null } });
  });
});

describe('Entry points and isolation from the game', () => {
  beforeEach(() => startupRouting.reset());

  it('Home → Financial Learning, with no game and no account', async () => {
    await render(<Home />);
    await press('open-learning');
    expect(router.push).toHaveBeenCalledWith('/learning');
  });

  it('More → Financial Learning opens the module and sends nothing to the game', async () => {
    const f = new Fixture().loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    await press('open-more');
    const entry = within(screen.getByTestId('more-actions')).getByTestId('open-learning');
    expect(entry).toHaveTextContent(/Financial Learning/);
    await fireEvent.press(entry);
    expect(router.push).toHaveBeenCalledWith('/learning');
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('playing lessons during a game changes nothing in it: cash, properties, loans, turn, transactions', async () => {
    const f = new Fixture().roll('Asha', 1, 2).loadAs('Asha');
    const before = JSON.stringify(useGameStore.getState().snapshot);
    const session = JSON.stringify(useSessionStore.getState().session);
    for (const id of ['L01', 'L09', 'L11', 'L12']) {
      const view = await render(<LessonPlayer lessonId={id} />);
      await playTo('takeaway', 'a');
      await press('lesson-continue');
      await view.unmount();
    }
    const left = await render(<LessonPlayer lessonId="L13" />);
    await playTo('consequence', 'b');
    await press('lesson-exit');
    await left.unmount();
    expect(JSON.stringify(useGameStore.getState().snapshot)).toBe(before);
    expect(JSON.stringify(useSessionStore.getState().session)).toBe(session);
    expect(JSON.stringify(f.state)).toBe(JSON.stringify(JSON.parse(before).state));
    expect(api.action).not.toHaveBeenCalled();
    // Lesson state lives only in the learning store — nothing of it is in the game store.
    expect(JSON.stringify(useGameStore.getState())).not.toMatch(/L13|inProgress|consequence/);
    expect(learning().completed).toEqual(['L01', 'L09', 'L11', 'L12']);
  });

  it('a finished game suggests a lesson under the standings; it opens the module and does not hold the result back', async () => {
    const f = new Fixture().act('Asha', { type: 'END_GAME' }).loadAs('Asha');
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    // The game-over actions are there without touching the suggestion.
    expect(screen.getByTestId('new-game-button')).toBeTruthy();
    expect(screen.queryByTestId('lesson-suggestion')).toBeNull();
    await press('context-cta');
    expect(screen.getByTestId('finished-card')).toBeTruthy();
    expect(screen.getByTestId('lesson-suggestion')).toHaveTextContent(/Rich on Paper, Broke in Cash/);
    await press('lesson-suggestion-open');
    expect(router.push).toHaveBeenCalledWith('/learning/L01');
    expect(api.action).not.toHaveBeenCalled();
  });

  it('the suggestion can be dismissed, stays dismissed, and skips lessons already completed', async () => {
    const onOpen = jest.fn();
    const first = await render(<LessonSuggestion onOpen={onOpen} />);
    await press('lesson-suggestion-dismiss');
    expect(screen.queryByTestId('lesson-suggestion')).toBeNull();
    await first.unmount();
    const again = await render(<LessonSuggestion onOpen={onOpen} />);
    expect(screen.queryByTestId('lesson-suggestion')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    await again.unmount();

    useLearningStore.setState({ suggestionDismissed: false, completed: ['L01'] });
    const next = await render(<LessonSuggestion onOpen={onOpen} />);
    expect(screen.getByTestId('lesson-suggestion')).toHaveTextContent(/The Auction Temptation/);
    await press('lesson-suggestion-open');
    expect(onOpen).toHaveBeenCalledWith('L02');
    await next.unmount();

    useLearningStore.setState({ completed: LESSONS.map((l) => l.id) });
    await render(<LessonSuggestion onOpen={onOpen} />);
    expect(screen.queryByTestId('lesson-suggestion')).toBeNull();
  });
});
