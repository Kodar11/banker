import { z } from 'zod';
import { PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';

const propertyKey = z.enum(PROPERTY_KEYS as [PropertyKey, ...PropertyKey[]]);
const id = z.string().uuid();
const rupees = z.number().int().positive().max(10_000_000);
const money = z.number().int().min(0).max(10_000_000);

const bare = <T extends string>(type: T) => z.object({ type: z.literal(type) }).strict();
const onProperty = <T extends string>(type: T) => z.object({ type: z.literal(type), propertyKey }).strict();

export const GameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_READY'), ready: z.boolean() }).strict(),
  bare('START_GAME'),
  bare('ROLL_DICE'),
  bare('BUY_PROPERTY'),
  bare('DECLINE_PROPERTY'),
  bare('START_AUCTION'),
  bare('PAY_RENT'),
  bare('PAY_TAX'),
  bare('PAY_CARD'),
  bare('PAY_INTEREST'),
  bare('PAY_CLUB'),
  /** In Jail, on your turn: pay the fine and play this turn normally. */
  bare('PAY_JAIL_FINE'),
  /** In Jail, on your turn: miss this turn (released after the last one). */
  bare('STAY_IN_JAIL'),
  z
    .object({
      type: z.literal('RESOLVE_CARD'),
      resolution: z.enum(['PAY', 'RECEIVE', 'NONE']),
      amount: z.number().int().min(0).max(10_000_000).optional(),
    })
    .strict(),
  onProperty('BUILD_HOUSE'),
  onProperty('BUILD_HOTEL'),
  onProperty('SELL_BUILDING'),
  onProperty('SELL_PROPERTY'),
  onProperty('MORTGAGE_PROPERTY'),
  onProperty('UNMORTGAGE_PROPERTY'),
  z
    .object({
      type: z.literal('TRANSFER_MONEY'),
      toPlayerId: id,
      amount: rupees,
      memo: z.string().trim().max(80).optional(),
    })
    .strict(),
  z.object({ type: z.literal('REQUEST_LOAN'), amount: rupees }).strict(),
  z.object({ type: z.literal('REPAY_LOAN'), loanId: id, amount: rupees }).strict(),
  z.object({ type: z.literal('PLACE_BID'), auctionId: id, amount: rupees }).strict(),
  z.object({ type: z.literal('PASS_AUCTION'), auctionId: id }).strict(),
  z.object({ type: z.literal('CLOSE_AUCTION'), auctionId: id }).strict(),
  bare('END_TURN'),
  bare('DECLARE_BANKRUPTCY'),
  z
    .object({
      type: z.literal('CREATE_TRADE'),
      toPlayerId: id,
      offeredPropertyKeys: z.array(propertyKey).max(26),
      requestedPropertyKeys: z.array(propertyKey).max(26),
      offeredMoney: money,
      requestedMoney: money,
    })
    .strict(),
  z.object({ type: z.literal('ACCEPT_TRADE'), tradeId: id }).strict(),
  z.object({ type: z.literal('REJECT_TRADE'), tradeId: id }).strict(),
  z.object({ type: z.literal('CANCEL_TRADE'), tradeId: id }).strict(),
  z.object({ type: z.literal('REQUEST_UNDO'), targetActionId: id }).strict(),
  z.object({ type: z.literal('APPROVE_UNDO'), requestId: id }).strict(),
  z.object({ type: z.literal('REJECT_UNDO'), requestId: id }).strict(),
  bare('PAUSE_GAME'),
  bare('RESUME_GAME'),
  bare('END_GAME'),
]);

export type GameAction = z.infer<typeof GameActionSchema>;
export type GameActionType = GameAction['type'];

/**
 * Actions whose meaning depends on what the player saw on screen. If the client's
 * state_version is behind, these are rejected as stale so the player re-reads the
 * screen first (e.g. a bid placed against an outdated high bid).
 */
export const STALE_SENSITIVE_ACTIONS: ReadonlySet<GameActionType> = new Set<GameActionType>([
  'START_GAME',
  'ROLL_DICE',
  'BUY_PROPERTY',
  'DECLINE_PROPERTY',
  'START_AUCTION',
  'PAY_RENT',
  'PAY_TAX',
  'PAY_CARD',
  'PAY_INTEREST',
  'PAY_CLUB',
  'PAY_JAIL_FINE',
  'STAY_IN_JAIL',
  'RESOLVE_CARD',
  'PLACE_BID',
  'END_TURN',
  'DECLARE_BANKRUPTCY',
  'APPROVE_UNDO',
]);

export const PlayerNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(20, 'Name must be 20 characters or less')
  .regex(/^[\p{L}\p{N} .'_-]+$/u, 'Use letters, numbers and spaces only');

export const GameCodeSchema = z.string().regex(/^\d{6}$/, 'Game code is 6 digits');
