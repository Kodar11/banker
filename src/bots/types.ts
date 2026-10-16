import type { BotDifficulty, BotPersonality, BotSeat, GameAction, GameState, PlayerState } from '../engine/index.ts';

export type { BotDifficulty, BotPersonality };

/** How one bot seat plays: the seat's own configuration (PlayerState.bot). */
export type BotProfile = BotSeat;

/**
 * The seven preference dimensions a decision is scored on. Every dimension is measured in rupees of
 * expected value, so they can be added; a personality only re-weights them (config.PERSONALITY_WEIGHTS).
 */
export const DIMENSIONS = ['wealth', 'liquidity', 'group', 'negotiation', 'market', 'risk', 'objectives'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Components = Record<Dimension, number>;

export function zeroComponents(): Components {
  return { wealth: 0, liquidity: 0, group: 0, negotiation: 0, market: 0, risk: 0, objectives: 0 };
}

export function addComponents(a: Components, b: Components, scale = 1): Components {
  const out = zeroComponents();
  for (const d of DIMENSIONS) out[d] = a[d] + b[d] * scale;
  return out;
}

/**
 * What one bot seat may know, and nothing else. Built from the authoritative state by observation.ts with
 * the same redaction the server applies to that player's own phone: another player's hidden cash, loans,
 * credit, insurance, ballots and secret objectives are not in it.
 */
export interface BotObservation {
  /** The game exactly as this seat's own device would receive it. */
  state: GameState;
  botId: string;
  me: PlayerState;
  /** Other active players' cash: the real figure when finances are open, otherwise an estimate from public information. */
  opponentCash: Record<string, { amount: number; known: boolean }>;
  financesHidden: boolean;
  /** Server clock (ms) the decision is made at: auction and vote deadlines are judged on it. */
  nowMs: number;
}

/** Why the bot is not acting right now, when it is not. */
export type BotWaiting = 'GAME_NOT_RUNNING' | 'NOT_MY_MOVE' | 'TIMER' | 'OUT_OF_GAME';

export interface BotCandidateEvaluation {
  action: GameAction;
  /** Personality-weighted score in rupee-equivalents, relative to doing nothing. */
  score: number;
  components: Components;
  note: string;
}

export interface BotDecision {
  /** The action to send, or null when the bot has nothing to do right now. */
  action: GameAction | null;
  /** Machine-readable category (BUY, BID, PASS, PAY, RECOVER, BUILD, TRADE_ACCEPT, …). */
  kind: string;
  /** The principal reason, in one sentence, for logs and debugging. Never contains another player's private numbers. */
  reason: string;
  waiting?: BotWaiting;
  /** Top candidates considered (debug only; filled when BotDecisionContext.debug is set). */
  considered?: BotCandidateEvaluation[];
}

export interface BotDecisionContext {
  profile: BotProfile;
  /** Stable per game and seat. Drives the only controlled variation a bot has; never the dice. */
  seed: number;
  /** Actions this bot has already taken in the current turn (bounds turn management). */
  actionsThisTurn?: number;
  debug?: boolean;
}
