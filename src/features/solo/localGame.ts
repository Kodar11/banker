import {
  applyAction,
  auctionAcceptUntil,
  createGame,
  defaultBotPersonalities,
  endVoteDeadline,
  GameError,
  isGameError,
  joinBot,
  openEndVote,
  redactEndVote,
  redactFinances,
  redactObjectives,
  STALE_SENSITIVE_ACTIONS,
  type ApiResponse,
  type BotSeat,
  type EngineContext,
  type EngineResult,
  type GameAction,
  type GameEventRecord,
  type GameMode,
  type GameSnapshot,
  type GameState,
  type StateBroadcast,
  type TransactionRecord,
} from '@/engine/index.ts';
import { actionKey, nextBotMove } from '@/bots/index.ts';
import { newActionId } from '@/lib/device';
import type { Credentials } from '@/lib/gameApi';


/**
 * Solo games: one person against bots, entirely on this device. Nothing here talks to a server — not the
 * referee, not matchmaking, not voice or chat — and nothing about a solo game is ever sent anywhere.
 *
 * The device plays the referee's part with the referee's own code: every action, the person's and the
 * bots', goes through the engine's applyAction exactly as on the server; the person's screen is sent the
 * same redacted snapshot the server would send (their own finances only, when hidden); the bots decide
 * with the same shared bot engine and from the same per-seat observations as online. Timers the server
 * would run (auction and vote deadlines) run here.
 *
 * The answers have the server's shape (ApiResponse), so the game screens work unchanged. A solo game
 * lives in memory for as long as the app runs; it is not saved (see docs/bots/README.md).
 */

/** Pause between two bot moves, so the person can follow them. */
export const SOLO_BOT_PACE_MS = 650;
const EVENTS_KEPT = 60;
const TRANSACTIONS_KEPT = 400;

type Listener = (payload: StateBroadcast) => void;

interface LocalGame {
  state: GameState;
  /** Newest first, as the server sends them. */
  events: GameEventRecord[];
  transactions: TransactionRecord[];
  /** Actions already applied, by id: a repeated id is answered with the game as it stands, never applied twice. */
  applied: Map<string, string>;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Per bot: actions the engine refused for the current version (never proposed again for it). */
  refused: Record<string, string[]>;
  refusedVersion: number;
}

const games = new Map<string, LocalGame>();

/** Uniform in [0, 1) from the platform's secure generator when there is one. Only the engine's dice and draws use it. */
function random(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return Math.random();
}

function ctx(): EngineContext {
  const now = new Date().toISOString();
  return { actionId: newActionId(), now, receivedAt: now, random, newId: newActionId };
}

export function isLocalGame(gameId: string | null | undefined): boolean {
  return !!gameId && games.has(gameId);
}

export interface SoloSetup {
  name: string;
  mode: GameMode;
  config?: unknown;
  bots: BotSeat[];
}

/** Creates and starts a solo game; returns the person's credentials (marked local: nothing is sent anywhere). */
export function createSoloGame(setup: SoloSetup): Credentials {
  if (setup.bots.length < 1 || setup.bots.length > 7) throw new GameError('VALIDATION', 'Choose between 1 and 7 bots.');
  const gameId = newActionId();
  const playerId = newActionId();
  const created = createGame({ gameId, code: '000000', hostPlayerId: playerId, hostName: setup.name, mode: setup.mode, config: setup.config }, ctx());
  const game: LocalGame = { state: created.state, events: [], transactions: [], applied: new Map(), listeners: new Set(), timer: null, stopped: false, refused: {}, refusedVersion: 0 };
  record(game, created);
  for (const bot of setup.bots) record(game, joinBot(game.state, { playerId: newActionId(), bot }, ctx()));
  record(game, applyAction(game.state, playerId, { type: 'START_GAME' }, ctx()));
  games.set(gameId, game);
  schedule(game);
  return { gameId, playerId, token: 'local', local: true };
}

/** A solo table's bots: `count` of them at one difficulty, with one personality or each a different one. */
export function soloBots(count: number, difficulty: BotSeat['difficulty'], personality: BotSeat['personality'] | 'mixed'): BotSeat[] {
  const personalities = personality === 'mixed' ? defaultBotPersonalities(count, Math.floor(random() * 4)) : Array.from({ length: count }, () => personality);
  return personalities.map((p) => ({ difficulty, personality: p }));
}

/** Forgets a solo game (the person left it, or it is over and they went home). */
export function discardSoloGame(gameId: string): void {
  const game = games.get(gameId);
  if (!game) return;
  game.stopped = true;
  if (game.timer) clearTimeout(game.timer);
  games.delete(gameId);
}

function record(game: LocalGame, result: EngineResult): void {
  game.state = result.state;
  game.events = [...[...result.events].reverse(), ...game.events].slice(0, EVENTS_KEPT);
  game.transactions = [...[...result.transactions].reverse(), ...game.transactions].slice(0, TRANSACTIONS_KEPT);
}

/** What the person's phone receives: the server's redaction, for the person. */
function snapshotFor(game: LocalGame, viewerId: string): GameSnapshot {
  return redactFinances(
    {
      state: redactEndVote(redactObjectives(game.state, viewerId), viewerId),
      events: game.events,
      transactions: game.transactions,
      serverTime: new Date().toISOString(),
    },
    viewerId,
  );
}

function notFound(): ApiResponse {
  return { ok: false, error: { code: 'NOT_FOUND', message: 'This solo game is no longer on this phone. Start a new one.' } };
}

export function localState(c: Credentials): ApiResponse {
  const game = games.get(c.gameId);
  if (!game || !game.state.players.some((p) => p.id === c.playerId)) return notFound();
  return { ok: true, gameId: c.gameId, playerId: c.playerId, snapshot: snapshotFor(game, c.playerId) };
}

export function localAction(c: Credentials, actionId: string, expectedVersion: number, action: GameAction): ApiResponse {
  const game = games.get(c.gameId);
  if (!game || !game.state.players.some((p) => p.id === c.playerId)) return notFound();
  if (game.applied.has(actionId)) return { ok: true, gameId: c.gameId, playerId: c.playerId, snapshot: snapshotFor(game, c.playerId), duplicate: true };
  if (STALE_SENSITIVE_ACTIONS.has(action.type) && expectedVersion !== game.state.version) {
    return { ok: false, error: { code: 'STALE_STATE', message: 'The game just changed — check the screen and try again.' } };
  }
  try {
    const result = applyAction(game.state, c.playerId, action, { ...ctx(), actionId });
    game.applied.set(actionId, action.type);
    record(game, result);
    publish(game, result.events);
    schedule(game);
    return { ok: true, gameId: c.gameId, playerId: c.playerId, snapshot: snapshotFor(game, c.playerId) };
  } catch (error) {
    if (isGameError(error)) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}

/** Live updates for the person's screen: the same "state changed" ping the server broadcasts. */
export function subscribeLocal(gameId: string, listener: Listener): () => void {
  const game = games.get(gameId);
  if (!game) return () => undefined;
  game.listeners.add(listener);
  return () => game.listeners.delete(listener);
}

function publish(game: LocalGame, events: GameEventRecord[]): void {
  const payload: StateBroadcast = { version: game.state.version, events: events.map((e) => ({ type: e.type, message: e.message, actorId: e.actorId })) };
  for (const l of game.listeners) l(payload);
}

/**
 * The device's bot runner and timers: after every change, the next bot move (paced), or — when no bot has
 * anything to do — the next deadline the server would have acted on (an auction or a vote running out).
 */
function schedule(game: LocalGame): void {
  if (game.stopped) return;
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
  if (game.state.status !== 'ACTIVE') return;
  game.timer = setTimeout(() => step(game), SOLO_BOT_PACE_MS);
}

function step(game: LocalGame): void {
  game.timer = null;
  if (game.stopped || game.state.status !== 'ACTIVE') return;
  if (game.refusedVersion !== game.state.version) {
    game.refused = {};
    game.refusedVersion = game.state.version;
  }
  const nowMs = Date.now();
  const move = nextBotMove(game.state, { nowMs, exclude: game.refused });
  if (move) {
    try {
      const result = applyAction(game.state, move.botId, move.action, ctx());
      record(game, result);
      publish(game, result.events);
    } catch (error) {
      if (!isGameError(error)) throw error;
      (game.refused[move.botId] ??= []).push(actionKey(move.action));
    }
    schedule(game);
    return;
  }
  // Nothing for a bot to do: a person is to move, or a timer is running. Close what has run out, as the server's timers do.
  const auction = game.state.auction?.status === 'OPEN' ? game.state.auction : null;
  const vote = openEndVote(game.state);
  const closer = game.state.players.find((p) => p.status === 'ACTIVE');
  const due = (at: number, action: GameAction) => {
    if (!closer) return false;
    if (nowMs < at) {
      game.timer = setTimeout(() => step(game), Math.max(50, at - nowMs + 25));
      return true;
    }
    try {
      const result = applyAction(game.state, closer.id, action, ctx());
      record(game, result);
      publish(game, result.events);
      schedule(game);
    } catch (error) {
      if (!isGameError(error)) throw error;
    }
    return true;
  };
  if (vote && due(endVoteDeadline(vote), { type: 'CLOSE_END_VOTE', voteId: vote.id })) return;
  if (auction) due(auctionAcceptUntil(auction), { type: 'CLOSE_AUCTION', auctionId: auction.id });
}
