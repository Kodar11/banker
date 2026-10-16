import { BUSINESS_MVP_RULES as RULES } from '../engine/index.ts';

/**
 * The dice, from the engine's rules (count and sides). For two six-sided dice these are the familiar
 * 1/36 … 6/36 … 1/36. Exact fractions are kept as counts over the number of outcomes.
 */
export interface DiceOutcome {
  total: number;
  /** Ways this total can be rolled. */
  ways: number;
  probability: number;
}

function enumerate(): DiceOutcome[] {
  const { count, sides } = RULES.dice;
  const ways = new Map<number, number>();
  const outcomes = sides ** count;
  for (let i = 0; i < outcomes; i += 1) {
    let rest = i;
    let total = 0;
    for (let d = 0; d < count; d += 1) {
      total += (rest % sides) + 1;
      rest = Math.floor(rest / sides);
    }
    ways.set(total, (ways.get(total) ?? 0) + 1);
  }
  return [...ways.entries()].sort((a, b) => a[0] - b[0]).map(([total, w]) => ({ total, ways: w, probability: w / outcomes }));
}

/** Every total the dice can show, with its exact probability. Sums to 1. */
export const DICE_DISTRIBUTION: readonly DiceOutcome[] = enumerate();

/** Expected total of one roll (7 for two six-sided dice). */
export const EXPECTED_ROLL: number = DICE_DISTRIBUTION.reduce((s, o) => s + o.total * o.probability, 0);

/** Draws a total with the dice's distribution from a uniform random in [0, 1). */
export function sampleRoll(random: () => number): number {
  const { count, sides } = RULES.dice;
  let total = 0;
  for (let i = 0; i < count; i += 1) total += Math.min(sides, Math.floor(random() * sides) + 1);
  return total;
}
