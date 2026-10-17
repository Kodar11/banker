// The server plays the bot seats of online games. Nothing here decides a rule or trusts a client:
//
//   claim the game's runner lease → loop (bounded):
//     lock the game row → load the authoritative state → ask the shared bot engine for the next bot move
//     (each bot decides from its own redacted observation) → apply it with the SAME applyAction as every
//     person's action → persist state + ledger + events + the action record in ONE transaction
//   → release the lease → look once more (a person may have acted meanwhile) and re-arm if a bot is due.
//
// Safety:
//   - Only seats the database marks as bots are ever played (PlayerState.bot comes from bot_difficulty /
//     bot_personality), and a bot seat has no device token, so no request can act as one.
//   - Every move is decided on the state read under the lock, so it can never be stale; it is applied by
//     the engine, which refuses anything illegal. A refused move is excluded and the bot decides again.
//   - Each move has a deterministic action id (game, state version, seat, action): if two runners ever
//     raced, or a retry repeated a committed move, the action table's primary key refuses the second copy.
//   - A crash rolls back the one transaction it was in; the next runner resumes from committed state.
//   - The loop stops when no bot has anything to do (a person is to move, or a timer is running), when the
//     game is paused or finished, or when its budget is spent (it then re-arms itself).
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import { actionKey, nextBotMove, nextBotWakeAt } from '../_shared/bots/index.ts';
import { applyAction, isGameError, RULES_VERSION, type EngineResult, type GameState } from '../_shared/engine/index.ts';
import { loadState, lockGame, persistResult, type Sql } from './db.ts';

export interface BotRunnerDeps {
  sql: Sql;
  /** Runs `task` after `delayMs`, outside the request (Edge: EdgeRuntime.waitUntil). Without it bots never run. */
  defer?: (delayMs: number, task: () => Promise<void>) => void;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
  /** Called after each committed bot move (broadcast, auction / vote close timers). */
  afterCommit?: (before: GameState, result: EngineResult) => Promise<void>;
  /** Pause between two bot moves, so people can follow them (and animations play). */
  paceMs?: number;
  /** Moves one run may make before it hands over to a fresh run. */
  budget?: number;
}

export const BOT_PACE_MS = 700;
export const BOT_RUN_BUDGET = 30;
const LEASE_SECONDS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether this state has bot seats that could need to act (cheap: no decision is computed). */
export function hasActiveBots(state: Pick<GameState, 'status' | 'players'>): boolean {
  return state.status === 'ACTIVE' && state.players.some((p) => p.status === 'ACTIVE' && !!p.bot);
}

/** Arms the runner after a committed change, if the game has bots. */
export function scheduleBots(deps: BotRunnerDeps, state: Pick<GameState, 'id' | 'status' | 'players'>, delayMs = deps.paceMs ?? BOT_PACE_MS): void {
  if (hasActiveBots(state)) armRunner(deps, state.id, delayMs);
}

/** Arms the runner for one game after `delayMs`, whatever its state (runBots re-checks everything under the lease). */
export function armRunner(deps: BotRunnerDeps, gameId: string, delayMs: number): void {
  if (!deps.defer) return;
  deps.defer(delayMs, async () => {
    try {
      await runBots(gameId, deps);
    } catch (error) {
      // The lease expires by itself; the next action or state read arms the runner again.
      console.error('bot runner failed', error);
    }
  });
}

/** A UUID derived from the move's identity (SHA-256), so the same move at the same state version always has the same id. */
export async function botActionId(gameId: string, version: number, botId: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bot|${gameId}|${version}|${botId}|${key}`)));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  // Shaped as a version-4, variant-1 UUID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Step = { kind: 'done' } | { kind: 'refused' } | { kind: 'duplicate' } | { kind: 'moved'; before: GameState; result: EngineResult };

export interface RunReport {
  claimed: boolean;
  moves: number;
  refused: number;
}

/**
 * Plays every bot move that is due in one game, one transaction per move. Returns what it did. Safe to call
 * any number of times, from any number of instances: only the holder of the lease plays, and every move is
 * re-decided under the game lock.
 */
export async function runBots(gameId: string, deps: BotRunnerDeps): Promise<RunReport> {
  const now = () => (deps.now ? deps.now() : new Date());
  const random = deps.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const budget = deps.budget ?? BOT_RUN_BUDGET;
  const report: RunReport = { claimed: false, moves: 0, refused: 0 };

  const [claimed] = await deps.sql`
    update public.games set bot_runner_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id = ${gameId} and status = 'ACTIVE' and (bot_runner_until is null or bot_runner_until < now())
    returning id`;
  if (!claimed) return report;
  report.claimed = true;

  let exclude: Record<string, string[]> = {};
  let excludeVersion = -1;
  const perTurn: Record<string, number> = {};
  let perTurnNumber = -1;
  let more = false;
  try {
    while (report.moves < budget) {
      const step: Step = await deps.sql.begin(async (tx): Promise<Step> => {
        const game = await lockGame(tx, gameId);
        if (!game || game.status !== 'ACTIVE' || game.rules_version !== RULES_VERSION) return { kind: 'done' };
        const state = await loadState(tx, game);
        if (state.version !== excludeVersion) {
          exclude = {};
          excludeVersion = state.version;
        }
        if (state.turn.number !== perTurnNumber) {
          for (const k of Object.keys(perTurn)) delete perTurn[k];
          perTurnNumber = state.turn.number;
        }
        const at = now();
        const move = nextBotMove(state, { nowMs: at.getTime(), exclude, actionsThisTurn: perTurn });
        if (!move) return { kind: 'done' };
        const actionId = await botActionId(gameId, state.version, move.botId, actionKey(move.action));
        const [prior] = await tx`select 1 as hit from public.game_actions where action_id = ${actionId}`;
        if (prior) return { kind: 'duplicate' };
        let result: EngineResult;
        try {
          result = applyAction(state, move.botId, move.action, { actionId, now: at.toISOString(), receivedAt: at.toISOString(), random, newId });
        } catch (error) {
          if (!isGameError(error)) throw error;
          // The engine has the last word: never sent again for this state; the bot decides again.
          (exclude[move.botId] ??= []).push(actionKey(move.action));
          return { kind: 'refused' };
        }
        await persistResult(tx, state.version, result);
        await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after, result)
          values (${actionId}, ${gameId}, ${move.botId}, ${move.action.type}, ${tx.json({ ...move.action, by: 'BOT' } as never)},
            ${result.state.version},
            ${tx.json({ transactions: result.transactions.map((t) => t.id), events: result.events.map((e) => e.type), decision: move.decision.kind })})`;
        await tx`update public.games set bot_runner_until = now() + make_interval(secs => ${LEASE_SECONDS}) where id = ${gameId}`;
        if (state.turn.playerId === move.botId && result.state.turn.number === state.turn.number) perTurn[move.botId] = (perTurn[move.botId] ?? 0) + 1;
        return { kind: 'moved', before: state, result };
      });
      if (step.kind === 'done') break;
      if (step.kind === 'refused') {
        report.refused += 1;
        if (report.refused > budget) break;
        continue;
      }
      if (step.kind === 'duplicate') continue;
      report.moves += 1;
      if (deps.afterCommit) {
        try {
          await deps.afterCommit(step.before, step.result);
        } catch (error) {
          console.error('bot afterCommit failed', error);
        }
      }
      if (step.result.state.status !== 'ACTIVE') break;
      await sleep(deps.paceMs ?? BOT_PACE_MS);
    }
    more = report.moves >= budget;
  } finally {
    await deps.sql`update public.games set bot_runner_until = null where id = ${gameId}`;
  }
  // A person may have acted after this run last looked and before it let go of the lease (their own
  // trigger found the lease taken): look once more, and hand over to a fresh run if a bot is due.
  // (Not after moves the engine kept refusing: that would only loop. Those are logged and left to the next trigger.)
  if (more) {
    armRunner(deps, gameId, deps.paceMs ?? BOT_PACE_MS);
  } else if (report.refused > 0) {
    console.error('bot runner: moves refused by the engine', { gameId, refused: report.refused });
  } else {
    const next = await nextBotCheck(gameId, deps);
    if (next.due) armRunner(deps, gameId, deps.paceMs ?? BOT_PACE_MS);
    // Nothing to do yet, but a bot will have something once a resale's countdown ends: nothing else
    // happens at that moment, so the runner wakes itself then.
    else if (next.wakeInMs !== null) armRunner(deps, gameId, next.wakeInMs + WAKE_SLACK_MS);
  }
  return report;
}

/** Past a wake-up instant by this much before the runner looks again. */
const WAKE_SLACK_MS = 25;

/** Whether a bot has a move to make in the game as it stands (read-only). */
export async function botMoveDue(gameId: string, deps: Pick<BotRunnerDeps, 'sql' | 'now'>): Promise<boolean> {
  return (await nextBotCheck(gameId, deps)).due;
}

/** A read-only look at the game: is a bot move due now, and if not, in how long a bot will have one (nextBotWakeAt). */
export async function nextBotCheck(gameId: string, deps: Pick<BotRunnerDeps, 'sql' | 'now'>): Promise<{ due: boolean; wakeInMs: number | null }> {
  return deps.sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read read only`;
    const [game] = await tx`select * from public.games where id = ${gameId}`;
    if (!game || game.status !== 'ACTIVE' || game.rules_version !== RULES_VERSION) return { due: false, wakeInMs: null };
    const state = await loadState(tx, game);
    if (!hasActiveBots(state)) return { due: false, wakeInMs: null };
    const nowMs = (deps.now ? deps.now() : new Date()).getTime();
    if (nextBotMove(state, { nowMs }) !== null) return { due: true, wakeInMs: null };
    const wake = nextBotWakeAt(state, nowMs);
    return { due: false, wakeInMs: wake === null ? null : Math.max(0, wake - nowMs) };
  });
}
