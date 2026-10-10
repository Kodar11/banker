import { z } from 'zod';
import { GameCodeSchema } from './actions.ts';
import type { GameErrorCode } from './errors.ts';
import { GAME_MODES, type GameMode } from './intermediateState.ts';
import type { GameEventRecord, GameState, TransactionRecord } from './types.ts';

/** 32 random bytes as hex, generated on the device. The server stores only its SHA-256. */
export const PlayerTokenSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid device token');

const uuid = z.string().uuid();

/** Body of a POST to the `game-action` Edge Function. */
export const ApiRequestSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('create'),
      actionId: uuid,
      token: PlayerTokenSchema,
      name: z.string(),
      /** The ruleset for the whole game. Omitted (an older app) means Classic. Only `create` takes it: joiners inherit the host's. */
      mode: z.enum(GAME_MODES as [GameMode, ...GameMode[]]).optional(),
    })
    .strict(),
  z.object({ op: z.literal('join'), actionId: uuid, token: PlayerTokenSchema, code: GameCodeSchema, name: z.string() }).strict(),
  z.object({ op: z.literal('state'), gameId: uuid, playerId: uuid, token: PlayerTokenSchema }).strict(),
  z
    .object({
      op: z.literal('action'),
      gameId: uuid,
      playerId: uuid,
      token: PlayerTokenSchema,
      actionId: uuid,
      /** state_version the client was looking at when the player tapped. */
      expectedVersion: z.number().int().min(1),
      action: z.unknown(),
    })
    .strict(),
]);

export type ApiRequest = z.infer<typeof ApiRequestSchema>;

export interface GameSnapshot {
  state: GameState;
  /** Most recent events, newest first. */
  events: GameEventRecord[];
  /** Most recent transactions, newest first. */
  transactions: TransactionRecord[];
  serverTime: string;
}

export type ApiErrorCode = GameErrorCode | 'SERVER_ERROR' | 'NETWORK' | 'TIMEOUT';

export type ApiResponse =
  | { ok: true; gameId: string; playerId: string; snapshot: GameSnapshot; duplicate?: boolean }
  | { ok: false; error: { code: ApiErrorCode; message: string } };

/** Payload broadcast on realtime topic `game:<gameId>` after every committed action. */
export interface StateBroadcast {
  version: number;
  events: { type: string; message: string; actorId: string | null }[];
}

export function realtimeTopic(gameId: string): string {
  return `game:${gameId}`;
}
