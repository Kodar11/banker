// The referee. Every game mutation goes through handleRequest:
//
//   validate body → lock game row → idempotency check → authenticate player →
//   stale-version check → load authoritative state → run engine → persist all
//   changes + ledger + events + action record in ONE transaction → broadcast.
//
// Every snapshot returned is the requesting player's view (loadSnapshot): other players' secret
// objectives never leave the server while a game is running, and in a game with hidden finances
// neither does their money. Broadcasts go to everyone at once, so they carry only public events.
//
// Runtime-agnostic so it can be integration-tested in Node against real Postgres.
import {
  ApiRequestSchema,
  createGame,
  GameError,
  isGameError,
  joinGame,
  publicEvents,
  applyAction,
  auctionAcceptUntil,
  endVoteDeadline,
  openEndVote,
  RULES_VERSION,
  STALE_SENSITIVE_ACTIONS,
  type ApiRequest,
  type ApiResponse,
  type EngineContext,
  type GameActionType,
  type GameEventRecord,
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
   * an auction - or a vote on ending the game - when its deadline passes without depending on any
   * phone staying connected.
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

export function randomCode(random: () => number): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, '0');
}

function errorResult(code: string, message: string, status = 200): HandlerResult {
  return { status, body: { ok: false, error: { code: code as never, message } } };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
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
    // The same action id committed by another request at the same instant, in a game this request does
    // not hold the lock of. That transaction won; this one was rolled back whole and changed nothing.
    if (isUniqueViolation(error, 'game_actions_pkey')) return errorResult('VALIDATION', reusedId().message);
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

interface PriorAction {
  game_id: string;
  player_id: string | null;
  type: string;
  payload: unknown;
}

/** Returns the stored record of an already-processed action id, if any. */
async function priorAction(tx: Tx, actionId: string) {
  const [row] = await tx`select game_id, player_id, type, payload from public.game_actions where action_id = ${actionId}`;
  return row as PriorAction | undefined;
}

/** JSON with object keys in one order, so two payloads compare equal exactly when they mean the same request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The idempotency policy, in one place. An action id names ONE request: the same player, in the
 * same game, asking for the same thing. Sent again it is answered with the game as it now stands
 * and nothing is carried out twice. Used for anything else - another player, another game, another
 * kind of request, another payload - it is refused: an id is never an alias for someone else's
 * action, and a different request is never silently swallowed as "already done".
 */
function reusedId(): GameError {
  return new GameError('VALIDATION', 'That action id was already used for a different request.');
}

async function createOp(
  req: Extract<ApiRequest, { op: 'create' }>,
  deps: HandlerDeps,
  now: () => string,
  random: () => number,
  newId: () => string,
): Promise<HandlerResult> {
  const prior = await deps.sql.begin((tx) => priorAction(tx, req.actionId));
  if (prior) return duplicateOf(deps, prior, req.token, 'CREATE_GAME');

  const tokenHash = await sha256Hex(req.token);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const gameId = newId();
    const playerId = newId();
    const code = randomCode(random);
    try {
      const snapshot = await deps.sql.begin(async (tx) => {
        const ctx: EngineContext = { actionId: req.actionId, now: now(), random, newId };
        const result = createGame({ gameId, code, hostPlayerId: playerId, hostName: req.name, mode: req.mode, config: req.config }, ctx);
        await insertNewGame(tx, result, tokenHash);
        await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after)
          values (${req.actionId}, ${gameId}, ${playerId}, 'CREATE_GAME', '{}'::jsonb, ${result.state.version})`;
        const [game] = await tx`select * from public.games where id = ${gameId}`;
        return loadSnapshot(tx, game!, playerId);
      });
      return { status: 200, body: { ok: true, gameId, playerId, snapshot } };
    } catch (error) {
      if (isUniqueViolation(error, 'games_live_code_idx')) continue; // code collision — pick another
      if (isUniqueViolation(error, 'game_actions_pkey')) {
        const again = await deps.sql.begin((tx) => priorAction(tx, req.actionId));
        if (again) return duplicateOf(deps, again, req.token, 'CREATE_GAME');
      }
      throw error;
    }
  }
  return errorResult('SERVER_ERROR', 'Could not create a game code. Please try again.', 500);
}

/** Answers a repeated create or join with the seat it made, to the device that holds that seat's token and to nobody else. */
async function duplicateOf(deps: HandlerDeps, prior: PriorAction, token: string, type: 'CREATE_GAME' | 'JOIN_GAME', gameId?: string): Promise<HandlerResult> {
  const playerId = prior.player_id;
  if (prior.type !== type || !playerId || (gameId !== undefined && prior.game_id !== gameId)) throw reusedId();
  const snapshot = await deps.sql.begin(async (tx) => {
    await authenticate(tx, prior.game_id, playerId, token);
    const [game] = await tx`select * from public.games where id = ${prior.game_id}`;
    if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
    return loadSnapshot(tx, game, playerId);
  });
  return { status: 200, body: { ok: true, gameId: prior.game_id, playerId, snapshot, duplicate: true } };
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
    return { playerId, snapshot: await loadSnapshot(tx, fresh!, playerId), result };
  });

  if ('duplicate' in outcome && outcome.duplicate) return duplicateOf(deps, outcome.duplicate, req.token, 'JOIN_GAME', gameId);
  const { playerId, snapshot, result } = outcome as Exclude<typeof outcome, { duplicate: unknown }>;
  await notify(deps, result.state, result.events);
  return { status: 200, body: { ok: true, gameId, playerId, snapshot } };
}

async function stateOp(req: Extract<ApiRequest, { op: 'state' }>, deps: HandlerDeps): Promise<HandlerResult> {
  // Read-only snapshot in one transaction so all tables are mutually consistent.
  const read = () =>
    deps.sql.begin(async (tx) => {
      await tx`set transaction isolation level repeatable read read only`;
      await authenticate(tx, req.gameId, req.playerId, req.token);
      const [game] = await tx`select * from public.games where id = ${req.gameId}`;
      if (!game) throw new GameError('NOT_FOUND', 'Game not found.');
      assertCurrentRules(game);
      return loadSnapshot(tx, game, req.playerId);
    });
  const snapshot = await read();

  // Durable recovery of the auction close. The close timer (scheduleAuctionClose) lives in the memory
  // of one function instance: a restart, a deploy or a crash loses it, and the only other trigger is a
  // phone that has the auction screen open. Every phone reads the state when it reconnects, comes to
  // the foreground or polls - so a read that finds an auction past its deadline arms the close again,
  // through the one settlement path (closeAuctionIfDue: same lock, same engine rule, exactly once).
  // The read itself stays a read: it answers with what it found, and the close reaches every phone
  // the way any committed action does. Reading a game whose auction is still running arms nothing.
  // The same recovery for a vote on ending the game whose deadline has passed (closeEndVoteIfDue).
  const vote = openEndVote(snapshot.state);
  if (deps.defer && vote && snapshot.state.status === 'ACTIVE') {
    const nowMs = (deps.now ? deps.now() : new Date()).getTime();
    if (nowMs >= endVoteDeadline(vote)) {
      deps.defer(0, async () => {
        try {
          await closeEndVoteIfDue(req.gameId, vote.id, deps);
        } catch (error) {
          // The next read, or any phone showing the vote, tries again.
          console.error('end-vote recovery on read failed', error);
        }
      });
    }
  }
  const auction = snapshot.state.auction;
  if (deps.defer && auction && auction.status === 'OPEN' && snapshot.state.status === 'ACTIVE') {
    const nowMs = (deps.now ? deps.now() : new Date()).getTime();
    if (nowMs >= auctionAcceptUntil(auction)) {
      deps.defer(0, async () => {
        try {
          await closeAuctionIfDue(req.gameId, auction.id, deps);
        } catch (error) {
          // The next read, or any phone on the auction screen, tries again.
          console.error('auction recovery on read failed', error);
        }
      });
    }
  }
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

    // Idempotency: a retried/double-tapped action returns the current state, no re-execution - whatever
    // has happened in the game since, and whatever version the retry says it saw. Only the very same
    // request counts as a retry (see reusedId).
    const prior = await priorAction(tx, req.actionId);
    if (prior) {
      if (prior.game_id !== req.gameId || prior.player_id !== req.playerId) throw reusedId();
      if (prior.type !== String(actionType) || canonical(prior.payload) !== canonical(req.action)) throw reusedId();
      return { duplicate: true as const, snapshot: await loadSnapshot(tx, game, req.playerId) };
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
    const before = openEndVote(state);
    const after = openEndVote(result.state);
    const voteDeadlineSet = !!after && (after.id !== before?.id || after.endsAt !== before.endsAt);
    return { duplicate: false as const, snapshot: await loadSnapshot(tx, fresh!, req.playerId), result, deadlineSet, voteDeadlineSet };
  });

  if (!outcome.duplicate) {
    if (outcome.deadlineSet) scheduleAuctionClose(deps, outcome.result.state);
    if (outcome.voteDeadlineSet) scheduleEndVoteClose(deps, outcome.result.state);
    await notify(deps, outcome.result.state, outcome.result.events);
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
  await notify(deps, result.state, result.events);
  return true;
}

/** Arms the server-side close for the deadline an action just set (a vote opened, or a paused game with one resumed). */
function scheduleEndVoteClose(deps: HandlerDeps, state: GameState): void {
  const vote = openEndVote(state);
  if (!deps.defer || !vote || state.status !== 'ACTIVE') return;
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const delay = Math.max(0, endVoteDeadline(vote) - nowMs) + CLOSE_TIMER_SLACK_MS;
  deps.defer(delay, async () => {
    try {
      await closeEndVoteIfDue(state.id, vote.id, deps);
    } catch (error) {
      // Phones showing the vote also ask for the close, and so does the next read of the game.
      console.error('end-vote close timer failed', error);
    }
  });
}

/**
 * Server-owned closure of a vote on ending the game: settles `voteId` if it is still the game's open
 * vote and its deadline has passed. Same lock, same engine rule and same exactly-once guarantee as a
 * player's CLOSE_END_VOTE - the vote leaves the state in the transaction that settles it - so it is
 * safe to call any number of times, alongside ballots and players' own close requests: whoever comes
 * second finds no vote and does nothing. Returns true when this call closed the vote.
 */
export async function closeEndVoteIfDue(gameId: string, voteId: string, deps: HandlerDeps): Promise<boolean> {
  const random = deps.random ?? secureRandom;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const result = await deps.sql.begin(async (tx) => {
    const game = await lockGame(tx, gameId);
    if (!game || game.status !== 'ACTIVE' || game.rules_version !== RULES_VERSION) return null;
    const state = await loadState(tx, game);
    if (openEndVote(state)?.id !== voteId) return null;
    // The engine needs an acting player; closing has no actor of its own (the event names nobody).
    const actor = state.players.find((p) => p.status === 'ACTIVE');
    if (!actor) return null;
    const actionId = newId();
    const action = { type: 'CLOSE_END_VOTE', voteId };
    let closed;
    try {
      closed = applyAction(state, actor.id, action, { actionId, now: (deps.now ? deps.now() : new Date()).toISOString(), random, newId });
    } catch (error) {
      if (isGameError(error)) return null; // already closed, or the deadline moved (the game was paused)
      throw error;
    }
    await persistResult(tx, state.version, closed);
    await tx`insert into public.game_actions (action_id, game_id, player_id, type, payload, state_version_after, result)
      values (${actionId}, ${gameId}, null, 'CLOSE_END_VOTE', ${tx.json({ ...action, by: 'SERVER_TIMER' })}, ${closed.state.version},
        ${tx.json({ transactions: closed.transactions.map((t) => t.id), events: closed.events.map((e) => e.type) })})`;
    return closed;
  });
  if (!result) return false;
  // A vote that extended the game may have started a turn; one that ended it finished the game. Either way every phone is told.
  await notify(deps, result.state, result.events);
  return true;
}

/**
 * Tells every device the game moved on. The topic is not addressed to one player, so in a game with
 * hidden finances the events are cut down to what anyone may read (publicEvents); each device then
 * fetches its own view of the state.
 */
async function notify(deps: HandlerDeps, state: GameState, events: GameEventRecord[]): Promise<void> {
  if (!deps.broadcast) return;
  try {
    await deps.broadcast(state.id, {
      version: state.version,
      events: publicEvents(state, events).map((e) => ({ type: e.type, message: e.message, actorId: e.actorId })),
    });
  } catch (error) {
    // Committed already; clients also refetch on reconnect/poll, so never fail the action.
    console.error('broadcast failed', error);
  }
}
