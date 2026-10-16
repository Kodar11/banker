import {
  calendarYear,
  durationLimit,
  economyOf,
  gameClock,
  GAME_DURATION_YEARS,
  hasGameDuration,
  INTERMEDIATE_RULES as IR,
  type GameState,
} from '../engine/index.ts';
import { BOT_POLICY } from './config.ts';
import type { DifficultyTuning } from './config.ts';

/**
 * How much game is left, as the bots plan for it. Read from the engine's own clock (gameEnd.ts): a
 * financial year passes each time the starting players have moved IR.year.spacesPerYear spaces by dice on
 * average. Capital Mode keeps that clock in its economy; Classic keeps the same clock in GameEndState.
 *
 *   S_remaining = max(0, Y_limit × N × P − S_used)
 *   Y_limit  the game's last financial year (the host's duration plus extensions; durationLimit)
 *   N        the number of STARTING players the clock counts (never the shrinking active count)
 *   P        spaces per financial year (IR.year.spacesPerYear, 36)
 *   S_used   dice movement the clock has recorded
 *
 * Only active players still move, so the turns each of them has left ≈ S_remaining / (active × 7).
 * That is an estimate for valuation, never a prediction of when the game ends.
 *
 * A matchmade game has no duration: it ends when one player is left. Its income is planned over
 * BOT_POLICY.horizon.matchmadePlanningYears financial years — a planning assumption, not a rule.
 */
export interface Horizon {
  hosted: boolean;
  /** Turns each active player is expected to have left (Infinity for a matchmade game). */
  remainingTurns: number;
  /** Turns actually valued: the remaining turns, capped by the difficulty's planning limit. */
  planningTurns: number;
  /** Financial years left to the planned end (fractional). */
  yearsLeft: number;
  /** Financial years the plan values flows over (income, interest, crises): planningTurns of movement. */
  planningYears: number;
  /** Weight that turns a benefit at the end of the plan into what it is worth now, early ending included. */
  endWeight: number;
  /** Weight of each turn's income, early ending and discounting included (index = turns from now). */
  turnWeights: number[];
  /** Sum of turnWeights: how many "full-value turns" the plan is worth. */
  weightedTurns: number;
}

const SPACES_PER_YEAR = IR.year.spacesPerYear;

export function remainingSpaces(state: GameState): { spaces: number; playerCount: number } {
  const eco = economyOf(state);
  if (eco) return { spaces: Math.max(0, durationLimit(state) * eco.playerCount * SPACES_PER_YEAR - gameClock(eco)), playerCount: eco.playerCount };
  const calendar = state.endGame?.calendar;
  const playerCount = calendar?.playerCount ?? Math.max(1, state.players.filter((p) => p.status !== 'LEFT').length);
  const used = calendar ? Object.values(calendar.movement).reduce((s, m) => s + m, 0) : 0;
  return { spaces: Math.max(0, durationLimit(state) * playerCount * SPACES_PER_YEAR - used), playerCount };
}

export function gameHorizon(state: GameState, tuning: DifficultyTuning): Horizon {
  const active = Math.max(1, state.players.filter((p) => p.status === 'ACTIVE').length);
  const avg = BOT_POLICY.horizon.averageRoll;
  const hosted = hasGameDuration(state);
  let remainingTurns: number;
  let yearsLeft: number;
  if (hosted) {
    const { spaces, playerCount } = remainingSpaces(state);
    remainingTurns = spaces / (active * avg);
    yearsLeft = spaces / (playerCount * SPACES_PER_YEAR);
  } else {
    remainingTurns = Number.POSITIVE_INFINITY;
    yearsLeft = BOT_POLICY.horizon.matchmadePlanningYears;
  }
  const planYears = hosted ? yearsLeft : BOT_POLICY.horizon.matchmadePlanningYears;
  // A turn is about avg/36 of a financial year for each player.
  const planTurnsFromYears = (planYears * SPACES_PER_YEAR) / avg;
  const planningTurns = Math.max(0, Math.min(tuning.maxPlanningTurns, hosted ? remainingTurns : planTurnsFromYears));

  // Early ending: a hosted game may be ended by a vote before its last year. Each remaining year it
  // survives with (1 − p); a turn t turns away is in year t × avg / 36 from now.
  const early = hosted ? tuning.earlyEndPerYear : 0;
  const turnWeights: number[] = [];
  const whole = Math.floor(planningTurns);
  for (let t = 0; t < whole; t += 1) {
    const survive = (1 - early) ** ((t * avg) / SPACES_PER_YEAR);
    turnWeights.push(tuning.turnDiscount ** t * survive);
  }
  const fraction = planningTurns - whole;
  if (fraction > 0) turnWeights.push(fraction * tuning.turnDiscount ** whole * (1 - early) ** ((whole * avg) / SPACES_PER_YEAR));
  const weightedTurns = turnWeights.reduce((s, w) => s + w, 0);
  const endWeight = tuning.turnDiscount ** planningTurns;
  return { hosted, remainingTurns, planningTurns, yearsLeft, planningYears: (planningTurns * avg) / SPACES_PER_YEAR, endWeight, turnWeights, weightedTurns };
}

/** The financial year the game is in and how many it may still run (for reporting and tests). */
export function yearsSummary(state: GameState): { year: number; limit: number | null } {
  return { year: calendarYear(state), limit: hasGameDuration(state) ? Math.min(GAME_DURATION_YEARS.maxYears, durationLimit(state)) : null };
}
