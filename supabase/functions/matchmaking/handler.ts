// The matchmaking worker. One "tick" does three bounded things, each in short transactions:
//
//   1. sweep    public.matchmaking_sweep(): timeouts, disconnects, stuck reservations (plain SQL)
//   2. match    per mode: lock a batch of queued tickets → group them (pure, _shared/matchmaking) →
//               public.matchmaking_reserve() per group, all in ONE transaction
//   3. start    per reservation whose players are all ready: claim it, create the game with the
//               game engine and the referee's own persistence (game-action/db.ts), tie it to the
//               reservation — ONE transaction, so there is a game and a STARTED reservation, or neither
//
// Nothing here trusts a client, and nothing depends on a tick finishing: every step re-reads the
// rows it locked, any number of ticks may run at once, and a tick that dies leaves either a
// committed step or nothing. Who calls it: pg_cron (through pg_net) and searching phones; the
// database decides how often it actually runs (matchmaking_candidates' throttle).
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import {
  createGame,
  joinGame,
  startHostlessGame,
  type EngineContext,
  type EngineResult,
  type GameMode,
  type GameState,
} from '../_shared/engine/index.ts';
import { planMatches, sanitizePolicy, type QueueEntry } from '../_shared/matchmaking/grouping.ts';
import { seatNames } from '../_shared/matchmaking/seatNames.ts';
import { insertNewGame, insertPlayer, persistResult, type Sql, type Tx } from '../game-action/db.ts';
import { isUniqueViolation, randomCode, secureRandom } from '../game-action/handler.ts';

export const MATCHMAKING_MODES: readonly GameMode[] = ['classic', 'intermediate'];

/** Where a test may make the worker fail, to prove what is left behind. Never set in production. */
export type FaultPoint = 'after-reserve' | 'before-game' | 'after-game';

export interface MatchmakingDeps {
  sql: Sql;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
  /** Structured log line (one per tick, plus failures). Defaults to console. */
  log?: (entry: Record<string, unknown>) => void;
  /** Failure injection for tests: throw to simulate a crash at that point. */
  fault?: (point: FaultPoint, context: { mode?: GameMode; matchId?: string }) => void;
}

export interface ModeReport {
  mode: GameMode;
  skipped?: string;
  candidates: number;
  reserved: number;
  refused: number;
  error?: string;
}

export interface TickReport {
  ok: boolean;
  durationMs: number;
  sweep: Record<string, number> | null;
  modes: ModeReport[];
  started: number;
  startFailures: number;
}

type Json = Record<string, unknown>;

const errorCategory = (error: unknown): string => {
  const e = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e?.code === 'string') return `DB_${e.code}`;
  if (e?.name === 'GameError') return `ENGINE_${String((error as { code?: unknown }).code ?? 'ERROR')}`;
  return typeof e?.message === 'string' ? e.message.slice(0, 120) : 'UNKNOWN';
};

function logger(deps: MatchmakingDeps) {
  return deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
}

/** One matching run for one mode: a single transaction from the ticket locks to the reservations. */
export async function matchMode(mode: GameMode, deps: MatchmakingDeps, force = false): Promise<ModeReport> {
  const report: ModeReport = { mode, candidates: 0, reserved: 0, refused: 0 };
  const startedAt = Date.now();
  try {
    await deps.sql.begin(async (tx) => {
      const [row] = await tx`select public.matchmaking_candidates(${mode}, ${force}) as r`;
      const batch = row!.r as Json;
      if (typeof batch.skipped === 'string') {
        report.skipped = batch.skipped;
        return;
      }
      const p = (batch.policy ?? {}) as Json;
      const policy = sanitizePolicy({
        targetPlayers: p.target_players,
        minPlayers: p.min_players,
        maxPlayers: p.max_players,
        preferTargetMs: p.prefer_target_ms,
        relaxMs: p.relax_ms,
        partyAloneMinPlayers: p.party_alone_min_players,
        windowSize: p.window_size,
        maxMatches: p.max_matches,
      });
      const entries: QueueEntry[] = ((batch.entries ?? []) as Json[]).map((e) => ({
        id: String(e.id),
        size: Number(e.size),
        queuedAtMs: Number(e.queued_at_ms),
      }));
      report.candidates = entries.length;
      if (entries.length === 0) return;
      const conflicts = ((batch.conflicts ?? []) as [string, string][]).map(([a, b]) => [String(a), String(b)] as const);
      // The database's clock, read under the locks: the one clock the thresholds are judged on.
      const groups = planMatches(entries, policy, Number(batch.now_ms), conflicts);
      for (const group of groups) {
        const [reserved] = await tx`select public.matchmaking_reserve(${mode}, ${group}::uuid[]) as r`;
        if ((reserved!.r as Json).ok === true) report.reserved += 1;
        else report.refused += 1;
      }
      await tx`select public.matchmaking_log_run(${mode}, ${tx.json({
        duration_ms: Date.now() - startedAt,
        candidates: report.candidates,
        reserved: report.reserved,
        refused: report.refused,
      })})`;
      deps.fault?.('after-reserve', { mode });
    });
  } catch (error) {
    // Rolled back as a whole: every ticket this run looked at is exactly as it was.
    report.error = errorCategory(error);
    report.reserved = 0;
    await deps.sql`select public.matchmaking_log_run(${mode}, ${deps.sql.json({ duration_ms: Date.now() - startedAt, error: report.error })})`.catch(() => undefined);
  }
  return report;
}

interface StartPlayer {
  user_id: string;
  seat: number;
  nickname: string;
  token_hash: string;
}

export type StartOutcome = { started: true; gameId: string } | { started: false; code: string };

/**
 * Creates the game of one reservation whose players are all ready. Safe to call any number of
 * times, from any number of workers: the reservation row is the claim (matchmaking_begin_start),
 * and the game, its players, the starting cash and the STARTED reservation commit together.
 */
export async function startMatch(matchId: string, deps: MatchmakingDeps): Promise<StartOutcome> {
  const random = deps.random ?? secureRandom;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  // A six-digit code that is already in use aborts the transaction; draw another, as the referee does.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await deps.sql.begin(async (tx: Tx): Promise<StartOutcome> => {
        const [row] = await tx`select public.matchmaking_begin_start(${matchId}) as r`;
        const claim = row!.r as Json;
        if (claim.ok !== true) return { started: false, code: String(claim.code ?? 'NOT_STARTING') };
        const players = claim.players as StartPlayer[];
        const mode = claim.mode as GameMode;
        deps.fault?.('before-game', { matchId, mode });

        const names = seatNames(players.map((p) => p.nickname));
        const seatIds = players.map(() => newId());
        const gameId = newId();
        const ctx: EngineContext = { actionId: newId(), now: now(), random, newId };

        // The engine builds the game exactly as for a host: create, join, start — with the mode's own
        // default settings, the same for every public table. Nothing here decides a rule.
        const created = createGame({ gameId, code: randomCode(random), hostPlayerId: seatIds[0]!, hostName: names[0]!, mode }, ctx);
        await insertNewGame(tx, created, players[0]!.token_hash);
        let state: GameState = created.state;
        for (let i = 1; i < players.length; i += 1) {
          const joined: EngineResult = joinGame(state, { playerId: seatIds[i]!, name: names[i]! }, ctx);
          await insertPlayer(tx, gameId, joined.state.players.find((p) => p.id === seatIds[i])!, players[i]!.token_hash);
          await persistResult(tx, state.version, joined);
          state = joined.state;
        }
        const started = startHostlessGame(state, ctx);
        await persistResult(tx, state.version, started);
        await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after, result)
          values (${ctx.actionId}, ${gameId}, null, 'MATCHMAKING_START', ${tx.json({ matchId, by: 'MATCHMAKING' })}, ${started.state.version},
            ${tx.json({ transactions: started.transactions.map((t) => t.id), events: started.events.map((e) => e.type) })})`;
        deps.fault?.('after-game', { matchId, mode });

        const seats = players.map((p, i) => ({ user_id: p.user_id, player_id: seatIds[i]! }));
        await tx`select public.matchmaking_finish_start(${matchId}, ${gameId}, ${tx.json(seats)}) as r`;
        return { started: true, gameId };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'games_live_code_idx')) continue;
      const category = errorCategory(error);
      logger(deps)({ at: 'matchmaking.start', matchId, error: category });
      // Outside the rolled-back transaction: count the attempt; after three, everyone is queued again.
      await deps.sql`select public.matchmaking_note_start_failure(${matchId}, ${category})`.catch(() => undefined);
      return { started: false, code: 'START_FAILED' };
    }
  }
  await deps.sql`select public.matchmaking_note_start_failure(${matchId}, 'NO_FREE_GAME_CODE')`.catch(() => undefined);
  return { started: false, code: 'START_FAILED' };
}

/** Starts the reservations that are waiting for their game (bounded; oldest first). */
export async function startDueMatches(deps: MatchmakingDeps): Promise<{ started: number; failed: number }> {
  const due = await deps.sql`
    select m.id from public.matchmaking_matches m
    where m.status = 'STARTING' and m.game_id is null
    order by m.all_ready_at
    limit (select public.matchmaking_setting('max_starts_per_run', 16))`;
  let started = 0;
  let failed = 0;
  for (const row of due) {
    const outcome = await startMatch(row.id as string, deps);
    if (outcome.started) started += 1;
    else if (outcome.code === 'START_FAILED') failed += 1;
  }
  return { started, failed };
}

/** One full pass. Never throws: a failing part is reported and the rest still runs. */
export async function runTick(deps: MatchmakingDeps, options: { force?: boolean } = {}): Promise<TickReport> {
  const startedAt = Date.now();
  const report: TickReport = { ok: true, durationMs: 0, sweep: null, modes: [], started: 0, startFailures: 0 };
  try {
    const [row] = await deps.sql`select public.matchmaking_sweep() as r`;
    report.sweep = row!.r as Record<string, number>;
  } catch (error) {
    report.ok = false;
    logger(deps)({ at: 'matchmaking.sweep', error: errorCategory(error) });
  }
  for (const mode of MATCHMAKING_MODES) {
    const modeReport = await matchMode(mode, deps, options.force === true);
    if (modeReport.error) report.ok = false;
    report.modes.push(modeReport);
  }
  try {
    const starts = await startDueMatches(deps);
    report.started = starts.started;
    report.startFailures = starts.failed;
  } catch (error) {
    report.ok = false;
    logger(deps)({ at: 'matchmaking.start', error: errorCategory(error) });
  }
  report.durationMs = Date.now() - startedAt;
  const worked = report.started + report.startFailures + report.modes.reduce((n, m) => n + m.reserved + m.refused, 0) + Object.values(report.sweep ?? {}).reduce((n, v) => n + v, 0);
  // Counts only: no ids of players, no names, no tokens.
  if (worked > 0 || !report.ok) logger(deps)({ at: 'matchmaking.tick', ...report });
  return report;
}

export interface HandlerResult {
  status: number;
  body: { ok: true; report: TickReport } | { ok: false; error: { code: string; message: string } };
}

/** Body of a POST to the `matchmaking` Edge Function. The only operation is "run a tick". */
export async function handleMatchmakingRequest(rawBody: unknown, deps: MatchmakingDeps): Promise<HandlerResult> {
  const op = (rawBody as { op?: unknown } | null)?.op;
  if (op !== 'tick') return { status: 400, body: { ok: false, error: { code: 'VALIDATION', message: 'That request is not valid.' } } };
  try {
    return { status: 200, body: { ok: true, report: await runTick(deps) } };
  } catch (error) {
    logger(deps)({ at: 'matchmaking.tick', error: errorCategory(error) });
    return { status: 500, body: { ok: false, error: { code: 'SERVER_ERROR', message: 'Matchmaking is temporarily unavailable.' } } };
  }
}
