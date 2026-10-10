// The referee. Every game mutation goes through handleRequest:
//
//   validate body → lock game row → idempotency check → authenticate player →
//   stale-version check → load authoritative state → run engine → persist all
//   changes + ledger + events + action record in ONE transaction → broadcast.
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import {
  ApiRequestSchema,
  createGame,
  GameError,
  isGameError,
  joinGame,
  applyAction,
  auctionAcceptUntil,
  RULES_VERSION,
  STALE_SENSITIVE_ACTIONS,
  type ApiRequest,
  type ApiResponse,
  type EngineContext,
  type GameActionType,
  type GameState,
  type StateBroadcast,
} from '../_shared/engine/index.ts';
import { insertNewGame, insertPlayer, loadSnapshot, loadState, lockGame, persistResult, type Sql, type Tx } from './db.ts';

export interface HandlerDeps {
  sql: Sql;
  /** Fire-and-forget realtime notification after commit. */
  broadcast?: (gameId: string, payload: StateBroadcast) => Promise<void>;
  /**
   * Runs `task` after `delayMs`, outside the request (Edge: EdgeRuntime.waitUntil). Used to close
   * an auction when its deadline passes without depending on any phone staying connected.
   */
  defer?: (delayMs: number, task: () => Promise<void>) => void;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
}

export interface HandlerResult {
  status: number;
  body: ApiResponse;
}

const LIVE_STATUSES = ['WAITING', 'ACTIVE', 'PAUSED'];

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cryptographically secure uniform random in [0, 1). */
export function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

function randomCode(random: () => number): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, '0');
}

function errorResult(code: string, message: string, status = 200): HandlerResult {
  return { status, body: { ok: false, error: { code: code as never, message } } };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint_name?: string };
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint);
}

export async function handleRequest(rawBody: unknown, deps: HandlerDeps): Promise<HandlerResult> {
  const parsed = ApiRequestSchema.safeParse(rawBody);
  if (!parsed.success) return errorResult('VALIDATION', 'That request is not valid.', 400);
  const req = parsed.data;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  // Server receipt time, taken before any waiting (connection pool, game lock). This — never a
  // client timestamp — decides whether a bid arrived in time.
  const receivedAt = now();
  const random = deps.random ?? secureRandom;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  try {
    switch (req.op) {
      case 'create':
        return await createOp(req, deps, now, random, newId);
      case 'join':
        return await joinOp(req, deps, now, random, newId);
      case 'state':
        return await stateOp(req, deps);
      case 'action':
        return await actionOp(req, deps, now, random, newId, receivedAt);
    }
  } catch (error) {
    if (isGameError(error)) return errorResult(error.code, error.message);
    if (error instanceof Error && error.message === 'STALE_WRITE') {
      return errorResult('STALE_STATE', 'The game changed while you were acting. Try again.');
    }
    console.error('game-action failed', error);
    return errorResult('SERVER_ERROR', 'Something went wrong. Please try again.', 500);
  }
}

/** Games created by an older engine (V1 placeholder board) can't be loaded by this one. */
function assertCurrentRules(game: Record<string, unknown>): void {
  if (game.rules_version !== RULES_VERSION) {
    throw new GameError('GAME_EXPIRED', 'This game was created with an older version of the board. Start a new game.');
  }
}

async function authenticate(tx: Tx, gameId: string, playerId: string, token: string): Promise<void> {
  const [player] = await tx`select token_hash from public.players where id = ${playerId} and game_id = ${gameId}`;
  if (!player || player.token_hash !== (await sha256Hex(token))) {
    throw new GameError('FORBIDDEN', 'You are not a player in this game.');
  }
}

/** Returns the stored outcome of an already-processed action id, if any. */
async function priorAction(tx: Tx, actionId: string) {
  const [row] = await tx`select game_id, player_id from public.game_actions where action_id = ${actionId}`;
  return row as { game_id: string; player_id: string } | undefined;
}

async function createOp(
  req: Extract<ApiRequest, { op: 'create' }>,
  deps: HandlerDeps,
  now: () => string,
  random: () => number,
  newId: () => string,
): Promise<HandlerResult> {
  const prior = await deps.sql.begin((tx) => priorAction(tx, req.actionId));
  if (prior) return duplicateOf(deps, prior, req.token);

  const tokenHash = await sha256Hex(req.token);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const gameId = newId();
    const playerId = newId();
    const code = randomCode(random);
    try {
      const snapshot = await deps.sql.begin(async (tx) => {
        const ctx: EngineContext = { actionId: req.actionId, now: now(), random, newId };
        const result = createGame({ gameId, code, hostPlayerId: playerId, hostName: req.name }, ctx);
        await insertNewGame(tx, result, tokenHash);
        await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after)
          values (${req.actionId}, ${gameId}, ${playerId}, 'CREATE_GAME', '{}'::jsonb, ${result.state.version})`;
        const [game] = await tx`select * from public.games where id = ${gameId}`;
        return loadSnapshot(tx, game!);
      });
      return { status: 200, body: { ok: true, gameId, playerId, snapshot } };
    } catch (error) {
      if (isUniqueViolation(error, 'games_live_code_idx')) continue; // code collision — pick another
      if (isUniqueViolation(error, 'game_actions_pkey')) {
        const again = await deps.sql.begin((tx) => priorAction(tx, req.actionId));
        if (again) return duplicateOf(deps, again, req.token);
      }
      throw error;
    }
  }
  return errorResult('SERVER_ERROR', 'Could not create a game code. Please try again.', 500);
}

async function duplicateOf(deps: HandlerDeps, prior: { game_id: string; player_id: string }, token: string): Promise<HandlerResult> {
  const snapshot = await deps.sql.begin(async (tx) => {
    await authenticate(tx, prior.game_id, prior.player_id, token);
    const [game] = await tx`select * from public.games where id = ${prior.game_id}`;
    if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
    return loadSnapshot(tx, game);
  });
  return { status: 200, body: { ok: true, gameId: prior.game_id, playerId: prior.player_id, snapshot, duplicate: true } };
}

async function joinOp(
  req: Extract<ApiRequest, { op: 'join' }>,
  deps: HandlerDeps,
  now: () => string,
  random: () => number,
  newId: () => string,
): Promise<HandlerResult> {
  const [found] = await deps.sql`
    select id from public.games where code = ${req.code} and status = any(${LIVE_STATUSES}) and expires_at > now()`;
  if (!found) throw new GameError('NOT_FOUND', 'No game with that code. Check the 6 digits.');
  const gameId = found.id as string;
  const tokenHash = await sha256Hex(req.token);

  const outcome = await deps.sql.begin(async (tx) => {
    const game = await lockGame(tx, gameId);
    if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
    const prior = await priorAction(tx, req.actionId);
    if (prior) return { duplicate: prior };
    assertCurrentRules(game);
    const playerId = newId();
    const state = await loadState(tx, game);
    const result = joinGame(state, { playerId, name: req.name }, { actionId: req.actionId, now: now(), random, newId });
    const player = result.state.players.find((p) => p.id === playerId)!;
    await insertPlayer(tx, gameId, player, tokenHash);
    await persistResult(tx, state.version, result);
    await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after)
      values (${req.actionId}, ${gameId}, ${playerId}, 'JOIN_GAME', '{}'::jsonb, ${result.state.version})`;
    const [fresh] = await tx`select * from public.games where id = ${gameId}`;
    return { playerId, snapshot: await loadSnapshot(tx, fresh!), result };
  });

  if ('duplicate' in outcome && outcome.duplicate) return duplicateOf(deps, outcome.duplicate, req.token);
  const { playerId, snapshot, result } = outcome as Exclude<typeof outcome, { duplicate: unknown }>;
  await notify(deps, gameId, result.state.version, result.events);
  return { status: 200, body: { ok: true, gameId, playerId, snapshot } };
}

async function stateOp(req: Extract<ApiRequest, { op: 'state' }>, deps: HandlerDeps): Promise<HandlerResult> {
  // Read-only snapshot in one transaction so all tables are mutually consistent.
  const snapshot = await deps.sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read read only`;
    await authenticate(tx, req.gameId, req.playerId, req.token);
    const [game] = await tx`select * from public.games where id = ${req.gameId}`;
    if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
    assertCurrentRules(game);
    return loadSnapshot(tx, game);
  });
  return { status: 200, body: { ok: true, gameId: req.gameId, playerId: req.playerId, snapshot } };
}

async function actionOp(
  req: Extract<ApiRequest, { op: 'action' }>,
  deps: HandlerDeps,
  now: () => string,
  random: () => number,
  newId: () => string,
  receivedAt: string,
): Promise<HandlerResult> {
  const actionType = (req.action as { type?: unknown })?.type;

  const outcome = await deps.sql.begin(async (tx) => {
    const game = await lockGame(tx, req.gameId);
    if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
    await authenticate(tx, req.gameId, req.playerId, req.token);

    // Idempotency: a retried/double-tapped action returns the current state, no re-execution.
    const prior = await priorAction(tx, req.actionId);
    if (prior) {
      if (prior.game_id !== req.gameId || prior.player_id !== req.playerId) {
        throw new GameError('VALIDATION', 'Duplicate action id.');
      }
      return { duplicate: true as const, snapshot: await loadSnapshot(tx, game) };
    }

    assertCurrentRules(game);
    const currentVersion = game.state_version as number;
    if (
      typeof actionType === 'string' &&
      STALE_SENSITIVE_ACTIONS.has(actionType as GameActionType) &&
      req.expectedVersion !== currentVersion
    ) {
      throw new GameError('STALE_STATE', 'The game just changed — check the screen and try again.');
    }

    const state = await loadState(tx, game);
    const result = applyAction(state, req.playerId, req.action, { actionId: req.actionId, now: now(), receivedAt, random, newId });
    await persistResult(tx, currentVersion, result);
    await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after, result)
      values (${req.actionId}, ${req.gameId}, ${req.playerId}, ${String(actionType)},
        ${tx.json(req.action as never)}, ${result.state.version},
        ${tx.json({ transactions: result.transactions.map((t) => t.id), events: result.events.map((e) => e.type) })})`;
    const [fresh] = await tx`select * from public.games where id = ${req.gameId}`;
    const deadlineSet = result.state.auction?.id !== state.auction?.id || result.state.auction?.endsAt !== state.auction?.endsAt;
    return { duplicate: false as const, snapshot: await loadSnapshot(tx, fresh!), result, deadlineSet };
  });

  if (!outcome.duplicate) {
    if (outcome.deadlineSet) scheduleAuctionClose(deps, outcome.result.state);
    await notify(deps, req.gameId, outcome.result.state.version, outcome.result.events);
  }
  return {
    status: 200,
    body: { ok: true, gameId: req.gameId, playerId: req.playerId, snapshot: outcome.snapshot, duplicate: outcome.duplicate || undefined },
  };
}

/** Past the acceptance deadline by this much before the server's own close fires. */
const CLOSE_TIMER_SLACK_MS = 25;

/** Arms the server-side close for the deadline an action just set (auction opened, bid accepted, game resumed). */
function scheduleAuctionClose(deps: HandlerDeps, state: GameState): void {
  const auction = state.auction;
  if (!deps.defer || !auction || auction.status !== 'OPEN' || state.status !== 'ACTIVE') return;
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const delay = Math.max(0, auctionAcceptUntil(auction) - nowMs) + CLOSE_TIMER_SLACK_MS;
  deps.defer(delay, async () => {
    try {
      await closeAuctionIfDue(state.id, auction.id, deps);
    } catch (error) {
      // Phones on the auction screen also ask for the close, so this is not the only path.
      console.error('auction close timer failed', error);
    }
  });
}

/**
 * Server-owned auction closure: finalizes `auctionId` if it is still the game's open auction and
 * its acceptance deadline has passed. Same lock, same engine rule and same exactly-once guarantee
 * as a player's CLOSE_AUCTION, so it is safe to call any number of times, alongside bids and
 * player close requests. A timer armed for a deadline that a later bid moved does nothing.
 * Returns true when this call closed the auction.
 */
export async function closeAuctionIfDue(gameId: string, auctionId: string, deps: HandlerDeps): Promise<boolean> {
  const random = deps.random ?? secureRandom;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const result = await deps.sql.begin(async (tx) => {
    const game = await lockGame(tx, gameId);
    if (!game || game.current_auction_id !== auctionId || game.status !== 'ACTIVE' || game.rules_version !== RULES_VERSION) return null;
    const state = await loadState(tx, game);
    // The engine needs an acting player; closing has no actor of its own (the events name the winner).
    const actor = state.players.find((p) => p.status === 'ACTIVE');
    if (!actor) return null;
    const actionId = newId();
    const action = { type: 'CLOSE_AUCTION', auctionId };
    let closed;
    try {
      closed = applyAction(state, actor.id, action, { actionId, now: (deps.now ? deps.now() : new Date()).toISOString(), random, newId });
    } catch (error) {
      if (isGameError(error)) return null; // already closed, or the deadline moved
      throw error;
    }
    await persistResult(tx, state.version, closed);
    await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after, result)
      values (${actionId}, ${gameId}, null, 'CLOSE_AUCTION', ${tx.json({ ...action, by: 'SERVER_TIMER' })}, ${closed.state.version},
        ${tx.json({ transactions: closed.transactions.map((t) => t.id), events: closed.events.map((e) => e.type) })})`;
    return closed;
  });
  if (!result) return false;
  await notify(deps, gameId, result.state.version, result.events);
  return true;
}

async function notify(
  deps: HandlerDeps,
  gameId: string,
  version: number,
  events: { type: string; message: string; actorId: string | null }[],
): Promise<void> {
  if (!deps.broadcast) return;
  try {
    await deps.broadcast(gameId, {
      version,
      events: events.map((e) => ({ type: e.type, message: e.message, actorId: e.actorId })),
    });
  } catch (error) {
    // Committed already; clients also refetch on reconnect/poll, so never fail the action.
    console.error('broadcast failed', error);
  }
}
