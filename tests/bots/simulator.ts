import { appendFileSync } from 'node:fs';
import {
  applyAction,
  auctionAcceptUntil,
  balanceSheet,
  createGame,
  endVoteDeadline,
  isGameError,
  joinBot,
  ledgerViolations,
  openEndVote,
  ownedBy,
  playerViolations,
  propertyViolations,
  startHostlessGame,
  totalDebt,
  type BotSeat,
  type EngineContext,
  type EngineResult,
  type GameMode,
  type GameState,
  type TransactionRecord,
} from '@/engine/index.ts';
import { actionKey, nextBotMove, prng } from '@/bots/index.ts';

/**
 * Seeded bot-only games on the real engine. Every action is chosen by the bot policy and applied with
 * applyAction exactly as the server applies a person's action; the money, property and player invariants
 * are checked after every one. Nothing about the rules is mocked.
 *
 * The clock advances one second per action (and jumps to a deadline when only a timer is left), so
 * auction countdowns and vote deadlines run as they do on the server.
 */

export interface SimScenario {
  seed: number;
  mode: GameMode;
  bots: BotSeat[];
  /** Host-created game (has a duration and votes) or a matchmade (hostless) one. */
  hosted: boolean;
  config?: Record<string, unknown>;
  /** Safety bound on actions. A hostless game only ends when one player is left, which can take long. */
  maxActions?: number;
}

export interface SeatResult {
  id: string;
  bot: BotSeat;
  status: GameState['players'][number]['status'];
  netWorth: number;
  cash: number;
  debt: number;
  properties: number;
  buildings: number;
  rank: number | null;
}

export interface SimResult {
  scenario: SimScenario;
  finished: boolean;
  reason: string | null;
  actions: number;
  turns: number;
  refused: number;
  stuck: string | null;
  winnerIds: string[];
  seats: SeatResult[];
  counts: Record<string, number>;
  /** Actions applied, by seat and type. */
  perSeat: Record<string, Record<string, number>>;
  decisionMs: { total: number; max: number; count: number; byKind: Record<string, { ms: number; n: number; max: number }> };
  violations: string[];
}

const START_MS = Date.parse('2026-01-01T10:00:00.000Z');

export function runBotGame(scenario: SimScenario): SimResult {
  let counter = 0;
  const newId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
  const rng = prng(scenario.seed);
  let nowMs = START_MS;
  const ctx = (): EngineContext => ({ actionId: newId(), now: new Date(nowMs).toISOString(), random: rng, newId });
  const ledger: TransactionRecord[] = [];
  const absorb = (r: EngineResult) => {
    ledger.push(...r.transactions);
    return r.state;
  };

  // The host seat is created as a person by the engine (createGame always has one) and then marked as a bot
  // here — test-only — so the whole table is played by the policy.
  const hostId = newId();
  let state = absorb(createGame({ gameId: newId(), code: '123456', hostPlayerId: hostId, hostName: 'Bot Host', mode: scenario.mode, config: scenario.config }, ctx()));
  state = { ...state, players: state.players.map((p) => (p.id === hostId ? { ...p, bot: scenario.bots[0]! } : p)) };
  for (const bot of scenario.bots.slice(1)) state = absorb(joinBot(state, { playerId: newId(), bot }, ctx()));
  state = scenario.hosted ? absorb(applyAction(state, hostId, { type: 'START_GAME' }, ctx())) : absorb(startHostlessGame(state, ctx()));

  const result: SimResult = {
    scenario,
    finished: false,
    reason: null,
    actions: 0,
    turns: 0,
    refused: 0,
    stuck: null,
    winnerIds: [],
    seats: [],
    counts: {},
    perSeat: {},
    decisionMs: { total: 0, max: 0, count: 0, byKind: {} },
    violations: [],
  };
  const maxActions = scenario.maxActions ?? 6000;
  let exclude: Record<string, string[]> = {};
  let excludeVersion = state.version;
  const perTurn: Record<string, number> = {};
  let perTurnNumber = state.turn.number;
  let idle = 0;

  while (state.status === 'ACTIVE' && result.actions < maxActions) {
    if (state.version !== excludeVersion) {
      exclude = {};
      excludeVersion = state.version;
    }
    if (state.turn.number !== perTurnNumber) {
      for (const k of Object.keys(perTurn)) delete perTurn[k];
      perTurnNumber = state.turn.number;
    }
    if (process.env.SIM_TRACE) {
      appendFileSync(process.env.SIM_TRACE, `${result.actions} ${state.turn.phase} ${state.turn.playerId} auction=${state.auction?.status} trades=${state.trades.filter((x) => x.status === 'PENDING').length}\n`);
    }
    const t0 = performance.now();
    const move = nextBotMove(state, { nowMs, exclude, actionsThisTurn: perTurn });
    const ms = performance.now() - t0;
    if (process.env.SIM_LOG && move) {
      const actor = state.players.find((p) => p.id === move.botId)!;
      appendFileSync(process.env.SIM_LOG, `${result.actions}	${actor.bot?.personality}	cash=${actor.balance}	props=${state.players.length && Object.values(state.properties).filter((p) => p.ownerId === actor.id).length}	${move.action.type}	${move.decision.reason}
`);
    }
    result.decisionMs.total += ms;
    result.decisionMs.max = Math.max(result.decisionMs.max, ms);
    result.decisionMs.count += 1;
    const kind = move?.decision.kind ?? 'NONE';
    const k = (result.decisionMs.byKind[kind] ??= { ms: 0, n: 0, max: 0 });
    k.ms += ms;
    k.n += 1;
    k.max = Math.max(k.max, ms);
    if (!move) {
      // Only a timer can be left (an auction or a vote counting down): let it run out.
      const auction = state.auction?.status === 'OPEN' ? state.auction : null;
      const vote = openEndVote(state);
      const deadline = Math.min(auction ? auctionAcceptUntil(auction) : Infinity, vote ? endVoteDeadline(vote) : Infinity);
      idle += 1;
      if (Number.isFinite(deadline) && deadline > nowMs && idle < 5) {
        nowMs = deadline + 1;
        continue;
      }
      result.stuck = `No bot could act: phase ${state.turn.phase}, turn of ${state.turn.playerId}, auction ${state.auction?.status ?? 'none'}`;
      break;
    }
    idle = 0;
    try {
      const before = state;
      state = absorb(applyAction(state, move.botId, move.action, ctx()));
      result.actions += 1;
      result.counts[move.action.type] = (result.counts[move.action.type] ?? 0) + 1;
      const seat = (result.perSeat[move.botId] ??= {});
      seat[move.action.type] = (seat[move.action.type] ?? 0) + 1;
      if (before.turn.number !== state.turn.number) result.turns += 1;
      if (before.turn.playerId === move.botId && state.turn.number === before.turn.number) perTurn[move.botId] = (perTurn[move.botId] ?? 0) + 1;
      const problems = [...ledgerViolations(state, ledger), ...propertyViolations(state), ...playerViolations(state)];
      if (problems.length) {
        result.violations.push(...problems.map((p) => `after ${move.action.type}: ${p}`));
        break;
      }
    } catch (error) {
      if (!isGameError(error)) throw error;
      // The engine refused what the bot believed legal: never retried for this state.
      result.refused += 1;
      (exclude[move.botId] ??= []).push(actionKey(move.action));
      // A bot that keeps proposing refused actions for one state is stuck: report it rather than loop.
      if ((exclude[move.botId]?.length ?? 0) > 25) {
        result.stuck = `${move.botId} had 25 actions refused in one state (last: ${move.action.type})`;
        break;
      }
    }
    nowMs += 1000;
  }

  result.finished = state.status === 'FINISHED';
  const finished = state.status === 'FINISHED';
  if (finished) {
    result.reason = 'finished';
    result.winnerIds = state.winnerId ? [state.winnerId] : [];
  }
  const ranked = state.players
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => ({ id: p.id, nw: balanceSheet(state, p.id).netWorth }))
    .sort((a, b) => b.nw - a.nw);
  result.seats = state.players.map((p) => {
    const sheet = balanceSheet(state, p.id);
    const keys = ownedBy(state, p.id);
    return {
      id: p.id,
      bot: p.bot!,
      status: p.status,
      netWorth: p.status === 'ACTIVE' ? sheet.netWorth : 0,
      cash: p.balance,
      debt: totalDebt(state, p.id),
      properties: keys.length,
      buildings: keys.reduce((s, k) => s + (state.properties[k].hotel ? 4 : state.properties[k].houses), 0),
      rank: p.status === 'ACTIVE' ? ranked.findIndex((r) => r.id === p.id) + 1 : null,
    };
  });
  if (!finished && ranked[0]) result.winnerIds = [ranked[0].id];
  return result;
}
