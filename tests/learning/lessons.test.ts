import { describe, expect, it } from 'vitest';
import { cashAfter } from '@/features/learning/calc';
import { LESSON_COLLECTIONS, LESSONS } from '@/features/learning/lessons';
import { countCompleted, getChoice, getLesson, lessonsIn, nextLesson, SCENE_KINDS, suggestedLesson, validateLessons } from '@/features/learning/registry';
import type { Lesson, SceneBlock } from '@/features/learning/types';

const allScenes = (lesson: Lesson): SceneBlock[] => [...lesson.situation.scene, ...lesson.choices.flatMap((c) => c.outcome.scene)];
const allText = (lesson: Lesson): string => JSON.stringify(lesson);

describe('lesson registry', () => {
  it('registers exactly 15 lessons in four collections of 4, 4, 4 and 3', () => {
    expect(LESSONS).toHaveLength(15);
    expect(LESSON_COLLECTIONS.map((c) => c.title)).toEqual(['Cash & Liquidity', 'Property & Investment', 'Debt & Credit', 'Negotiation & Strategy']);
    expect(LESSON_COLLECTIONS.map((c) => lessonsIn(c.id).length)).toEqual([4, 4, 4, 3]);
    expect(LESSONS.map((l) => l.number)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('uses the canonical titles, in order', () => {
    expect(LESSONS.map((l) => l.title)).toEqual([
      'Rich on Paper, Broke in Cash',
      'The Auction Temptation',
      'Income Is Not the Same as Cash Flow',
      'Present Value: ₹10,000 Today or Later?',
      'Complete the Colour Group?',
      'All Your Eggs in One Basket',
      'Market Value vs. Purchase Price',
      'The Power of Compounding',
      'The Loan That Looks Cheap',
      'Borrowing vs. Waiting',
      'Mortgage or Sell?',
      'Credit Score: One Missed Payment',
      'The Deal Maker',
      'When to Walk Away',
      'Future Value: What Could This Become?',
    ]);
  });

  it('passes validation: unique ids, one prompt, 2–3 choices, a consequence per choice, known visuals', () => {
    expect(validateLessons()).toEqual([]);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(15);
    expect(new Set(LESSONS.map((l) => l.slug)).size).toBe(15);
    for (const lesson of LESSONS) {
      expect(typeof lesson.decisionPrompt).toBe('string');
      expect(lesson.decisionPrompt.length).toBeGreaterThan(0);
      expect(lesson.choices.length === 2 || lesson.choices.length === 3).toBe(true);
      expect(lesson.boardLesson.length).toBeGreaterThan(0);
      expect(lesson.realLifeConnection.length).toBeGreaterThan(0);
      expect(lesson.estimatedDurationSeconds).toBeGreaterThanOrEqual(30);
      expect(lesson.estimatedDurationSeconds).toBeLessThanOrEqual(60);
      expect(SCENE_KINDS).toContain(lesson.visualType);
      for (const choice of lesson.choices) {
        expect(choice.outcome.scene.length).toBeGreaterThan(0);
        expect(choice.outcome.headline.length).toBeGreaterThan(0);
        expect(getChoice(lesson, choice.id)).toBe(choice);
      }
      for (const block of allScenes(lesson)) expect(SCENE_KINDS).toContain(block.kind);
    }
  });

  it('validation catches broken lesson data', () => {
    const base = LESSONS[0]!;
    expect(validateLessons([base, base])).toContain('L01: duplicate id');
    expect(validateLessons([{ ...base, choices: base.choices.slice(0, 1) }])).toContain('L01: needs two or three choices');
    expect(validateLessons([{ ...base, visualType: 'hologram' as never }])).toContain('L01: unknown visual type');
    const overdrawn: Lesson = { ...base, situation: { ...base.situation, scene: [{ kind: 'cash', start: 100, movements: [{ label: 'Bill', amount: -500 }] }] } };
    expect(validateLessons([overdrawn])).toContain('L01 situation: cash goes below zero');
    const empty: Lesson = { ...base, choices: base.choices.map((c, i) => (i === 0 ? { ...c, outcome: { ...c.outcome, scene: [] } } : c)) };
    expect(validateLessons([empty])).toContain('L01 choice a: the outcome shows nothing');
  });

  it('no story ever shows cash below zero', () => {
    for (const lesson of LESSONS) {
      for (const block of allScenes(lesson)) {
        if (block.kind === 'cash') expect(cashAfter(block.start, block.movements.map((m) => m.amount)).lowest).toBeGreaterThanOrEqual(0);
        if (block.kind === 'holdings') for (const holder of block.holders) expect(holder.cash ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never labels a choice right or wrong, and scores nothing', () => {
    for (const lesson of LESSONS) {
      expect(allText(lesson)).not.toMatch(/\b(correct|incorrect|wrong|smart|foolish|mistake|well done|stars?)\b/i);
    }
  });

  it('is deterministic: lesson data is plain data with no functions', () => {
    expect(JSON.parse(JSON.stringify(LESSONS))).toEqual(LESSONS);
  });

  it('lookups, order and suggestions', () => {
    expect(getLesson('L04')?.slug).toBe('present-value');
    expect(getLesson('nope')).toBeNull();
    expect(nextLesson('L01')?.id).toBe('L02');
    expect(nextLesson('L15')).toBeNull();
    expect(suggestedLesson([])?.title).toBe('Rich on Paper, Broke in Cash');
    expect(suggestedLesson(['L01', 'L02'])?.id).toBe('L03');
    expect(suggestedLesson(LESSONS.map((l) => l.id))).toBeNull();
    expect(countCompleted(['L01', 'L05', 'L05', 'unknown'])).toEqual({ completed: 2, total: 15 });
    expect(countCompleted(['L01', 'L05'], 'cash')).toEqual({ completed: 1, total: 4 });
  });
});

describe('story figures', () => {
  const lesson = (id: string) => getLesson(id)!;
  const outcome = (id: string, choice: string) => getChoice(lesson(id), choice)!.outcome;
  const cashEnd = (blocks: SceneBlock[]) => {
    const cash = blocks.find((b) => b.kind === 'cash');
    if (!cash || cash.kind !== 'cash') throw new Error('no cash scene');
    return cashAfter(cash.start, cash.movements.map((m) => m.amount)).end;
  };

  it('01: ₹1,000 cash and a ₹500 tax', () => {
    expect(lesson('L01').situation.text).toContain('₹1,000');
    expect(lesson('L01').situation.text).toContain('₹500');
    expect(cashEnd(outcome('L01', 'a').scene)).toBe(500);
    expect(cashEnd(outcome('L01', 'b').scene)).toBe(2000);
    expect(cashEnd(outcome('L01', 'c').scene)).toBe(1500);
  });

  it('02: ₹6,000 cash against a ₹2,000 reserve, which is a plan and not a rule', () => {
    expect(cashEnd(outcome('L02', 'a').scene)).toBe(1000);
    expect(cashEnd(outcome('L02', 'b').scene)).toBe(6000);
    expect(cashEnd(outcome('L02', 'c').scene)).toBe(6000);
    for (const c of lesson('L02').choices) expect(JSON.stringify(c.outcome.scene)).toContain('The game does not hold cash back for you');
  });

  it('03: ₹2,000 in, ₹2,500 out, net −₹500 — and no bill is paid without the cash', () => {
    for (const c of lesson('L03').choices) expect(JSON.stringify(c.outcome.scene)).toContain('-₹500 net');
    expect(cashEnd(outcome('L03', 'a').scene)).toBe(1500);
    expect(outcome('L03', 'a').headline).toContain('₹1,000 short');
    expect(cashEnd(outcome('L03', 'b').scene)).toBe(1000);
    expect(cashEnd(outcome('L03', 'c').scene)).toBe(500);
  });

  it('04: ₹12,000 in two years is about ₹9,917 today, stated as illustrative', () => {
    expect(outcome('L04', 'b').headline).toContain('₹9,917');
    expect(outcome('L04', 'c').headline).toContain('₹9,917');
    expect(outcome('L04', 'a').headline).toContain('₹12,100');
    for (const c of lesson('L04').choices) expect(JSON.stringify(c.outcome.scene)).toContain('illustrative comparison');
  });

  it('08 and 15: ₹5,000 at 5% for five years is about ₹6,381, labelled hypothetical', () => {
    expect(outcome('L08', 'b').headline).toContain('₹6,381');
    expect(outcome('L08', 'c').headline).toContain('₹3,829');
    expect(outcome('L15', 'a').headline).toContain('₹6,381');
    expect(outcome('L15', 'c').headline).toContain('₹4,294');
    expect(outcome('L15', 'c').headline).toContain('₹7,347');
    for (const c of lesson('L15').choices) expect(JSON.stringify(c.outcome.scene)).toContain('not that model');
    for (const c of lesson('L08').choices) expect(JSON.stringify(c.outcome.scene)).toContain('No real investment guarantees a fixed return');
  });

  it('09: fixed 10% against a variable loan from 7%, with hypothetical paths', () => {
    expect(lesson('L09').situation.text).toContain('7%');
    expect(lesson('L09').situation.text).toContain('10%');
    for (const c of lesson('L09').choices) {
      expect(c.outcome.scene.some((b) => b.kind === 'loanComparison')).toBe(true);
      expect(JSON.stringify(c.outcome.scene)).toContain('hypothetical examples');
    }
  });

  it('11: the mortgage pays ₹5,000, keeps both houses on the site and costs ₹5,500 to undo', () => {
    const mortgage = outcome('L11', 'a');
    expect(cashEnd(mortgage.scene)).toBe(500 + 5000 - 4000);
    expect(mortgage.text).toContain('₹5,500');
    expect(mortgage.text).toContain('Nothing is paid for the houses');
    expect(JSON.stringify(mortgage.scene)).toContain('2 houses inactive');
  });

  it('12: the score is a sample, and never called a real credit score', () => {
    expect(outcome('L12', 'a').headline).toContain('680');
    expect(outcome('L12', 'a').headline).toContain('605');
    expect(outcome('L12', 'b').headline).toContain('685');
    for (const c of lesson('L12').choices) expect(JSON.stringify(c.outcome.scene)).toContain('not a real credit bureau score');
  });

  it('13 and 05: a counteroffer is accepted as part of the story, not as a certainty', () => {
    expect(JSON.stringify(outcome('L13', 'b'))).toContain('not a certainty');
    expect(JSON.stringify(outcome('L05', 'b'))).toContain('could just as well have said no');
  });
});
