import type { GameAction, GameState } from '../engine/index.ts';
import { dryRun } from './engineAccess.ts';
import type { Components } from './types.ts';
import { assess, delta, weigh, type Assessment, type ValuationContext } from './valuation.ts';

/** One candidate action, run through the engine and valued. */
export interface Scored {
  action: GameAction;
  /** Personality-weighted change in the bot's position, in rupee-equivalents. */
  score: number;
  components: Components;
  note: string;
  /** The position the engine says the action leads to (the bot's own view). */
  after: GameState;
  afterAssessment: Assessment;
}

/** A stable identity for an action (used to exclude one the server refused, and to compare). */
export function actionKey(action: GameAction): string {
  return JSON.stringify(action, Object.keys(action).sort());
}

/**
 * Applies `action` to `from` (default: the bot's view) with the real engine and scores the result against
 * `base`. Null when the engine refuses the action — an illegal action is never scored, however attractive.
 */
export function evaluate(vc: ValuationContext, base: Assessment, action: GameAction, note: string, from: GameState = vc.obs.state, exclude?: ReadonlySet<string>): Scored | null {
  if (exclude?.has(actionKey(action))) return null;
  const result = dryRun(from, vc.obs.botId, action, vc.obs.nowMs);
  if (!result) return null;
  const afterAssessment = assess(vc, result.state);
  const components = delta(afterAssessment.components, base.components);
  return { action, score: weigh(vc, components), components, note, after: result.state, afterAssessment };
}

export function best<T extends { score: number }>(items: readonly (T | null)[]): T | null {
  let top: T | null = null;
  for (const item of items) if (item && (!top || item.score > top.score)) top = item;
  return top;
}
