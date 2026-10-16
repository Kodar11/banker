import { applyAction, isGameError, type EngineContext, type EngineResult, type GameAction, type GameState } from '../engine/index.ts';

/**
 * The only way a bot touches the rules: it asks the engine. `dryRun` applies an action to a COPY of the
 * bot's own view with the real reducer and returns the result — or null when the engine refuses it. The
 * engine is pure (it clones the state it is given), so nothing a dry run does reaches the live game.
 *
 * A dry run decides what the bot will consider legal; it never decides what is legal. The server applies
 * the chosen action to the authoritative state through the same applyAction as every human action, and
 * that is the only verdict that counts.
 */

let counter = 0;
function dryRunId(): string {
  counter = (counter + 1) % 0xffffffffffff;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

function context(nowMs: number): EngineContext {
  const now = new Date(nowMs).toISOString();
  // Dry runs never roll dice that matter: they only test legality and the effect of a decision.
  return { actionId: dryRunId(), now, receivedAt: now, random: () => 0.5, newId: dryRunId };
}

export function dryRun(state: GameState, actorId: string, action: GameAction, nowMs: number): EngineResult | null {
  try {
    return applyAction(state, actorId, action, context(nowMs));
  } catch (error) {
    if (isGameError(error)) return null;
    throw error;
  }
}

/** Why the engine refuses an action, or null when it accepts it. */
export function refusal(state: GameState, actorId: string, action: GameAction, nowMs: number): string | null {
  try {
    applyAction(state, actorId, action, context(nowMs));
    return null;
  } catch (error) {
    if (isGameError(error)) return `${error.code}: ${error.message}`;
    throw error;
  }
}
