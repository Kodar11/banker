/**
 * BUSINESS — Chance and Community Chest.
 *
 * Each deck has TWO tables: the
 * dice total that landed the player on the square picks the EVEN or the ODD
 * table, and the entry with that number (BUSINESS_MVP_RULES.cards.selection).
 *
 * Values and wording are exactly the supplied card data. A dice total with no
 * entry in its table (Chance ODD 11) is `verified: false` with a MANUAL effect:
 * the app asks the player to read the physical card and enter the money effect.
 *
 * Note: the supplied Chance ODD table also lists 10 (Go to Jail) and 12 (Go to
 * Rest House). They are kept exactly as supplied, but with parity selection an
 * odd total never picks them.
 *
 * Effects are data; the engine (reducer.ts → resolveCard) executes them, and all
 * movement goes through the engine's single movement function so Start-crossing
 * and loan-interest rules apply identically to dice and card moves.
 */
import type { PropertyKey, SquareId } from './businessBoard.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';

export type Deck = 'CHANCE' | 'COMMUNITY_CHEST';
export type CardTable = 'EVEN' | 'ODD';

export type MoveDirection = 'FORWARD' | 'BACKWARD';

export type CardEffect =
  | { type: 'PAY_BANK'; amount: number }
  | { type: 'RECEIVE_FROM_BANK'; amount: number }
  /** Every other active player pays the card holder (player-to-player transfers, not bank money). */
  | { type: 'COLLECT_FROM_EACH_PLAYER'; amount: number }
  /** The card holder pays every other active player. */
  | { type: 'PAY_EACH_PLAYER'; amount: number }
  /**
   * Move to a square. FORWARD moves collect the Start reward when they pass/land
   * on Start; BACKWARD moves never do. resolveLanding = buy/rent/tax etc. on arrival.
   */
  | { type: 'MOVE_TO'; target: SquareId; direction: MoveDirection; resolveLanding: boolean }
  /** Move n squares (negative = backward). */
  | { type: 'MOVE_STEPS'; steps: number; resolveLanding: boolean }
  | { type: 'GO_TO_JAIL' }
  | { type: 'GO_TO_REST_HOUSE' }
  | { type: 'SKIP_TURNS'; count: number }
  | { type: 'PAY_PER_BUILDING'; perHouse: number; perHotel: number }
  /** Entry not in the supplied data — resolve using the physical card. */
  | { type: 'MANUAL' };

export interface CardDefinition {
  /** e.g. CHANCE_EVEN_2 */
  id: string;
  deck: Deck;
  table: CardTable;
  /** Dice number this entry applies to. */
  rollTotal: number;
  text: string;
  effects: CardEffect[];
  /** false = not in the supplied card data; resolved by hand. */
  verified: boolean;
}

function card(deck: Deck, table: CardTable, rollTotal: number, text: string, effects: CardEffect[], verified = true): CardDefinition {
  return { id: `${deck}_${table}_${rollTotal}`, deck, table, rollTotal, text, effects, verified };
}

function unknown(deck: Deck, table: CardTable, rollTotal: number): CardDefinition {
  return card(deck, table, rollTotal, 'Not in the supplied card data — read the physical card.', [{ type: 'MANUAL' }], false);
}

const pay = (amount: number): CardEffect => ({ type: 'PAY_BANK', amount });
const receive = (amount: number): CardEffect => ({ type: 'RECEIVE_FROM_BANK', amount });
const JAIL: CardEffect[] = [{ type: 'GO_TO_JAIL' }];
const REST_HOUSE: CardEffect[] = [{ type: 'GO_TO_REST_HOUSE' }, { type: 'SKIP_TURNS', count: 1 }];
const MUMBAI: PropertyKey = 'MUMBAI';

export const CHANCE_EVEN: readonly CardDefinition[] = [
  card('CHANCE', 'EVEN', 2, 'Loss in share market — pay Bank ₹2,000', [pay(2000)]),
  card('CHANCE', 'EVEN', 4, 'Fine for accident due to driving under liquor influence — pay Bank ₹1,500', [pay(1500)]),
  card('CHANCE', 'EVEN', 6, 'House Repairs — pay Bank ₹1,500', [pay(1500)]),
  card('CHANCE', 'EVEN', 8, 'Loss due to fire in godown — pay Bank ₹3,000', [pay(3000)]),
  card('CHANCE', 'EVEN', 10, 'Go to Jail', JAIL),
  card('CHANCE', 'EVEN', 12, 'Go to Rest House — you cannot play next turn', REST_HOUSE),
];

export const CHANCE_ODD: readonly CardDefinition[] = [
  card('CHANCE', 'ODD', 3, 'Lottery Prize — receive ₹2,500 from Bank', [receive(2500)]),
  card('CHANCE', 'ODD', 5, 'Won crossword competition prize — receive ₹1,000 from Bank', [receive(1000)]),
  card('CHANCE', 'ODD', 7, 'Won Jackpot — receive ₹2,000 from Bank', [receive(2000)]),
  card(
    'CHANCE',
    'ODD',
    9,
    'Go back to Bombay (Mumbai). If you pass the starting point collect ₹1,500. Darjeeling export prize — receive ₹3,000',
    [
      {
        type: 'MOVE_TO',
        target: MUMBAI,
        direction: RULES.cards.goBackToMumbaiDirection,
        resolveLanding: RULES.cards.goBackToMumbaiResolvesLanding,
      },
      receive(3000),
    ],
  ),
  card('CHANCE', 'ODD', 10, 'Go to Jail', JAIL),
  card('CHANCE', 'ODD', 12, 'Go to Rest House — skip next turn', REST_HOUSE),
];

export const COMMUNITY_CHEST_EVEN: readonly CardDefinition[] = [
  card('COMMUNITY_CHEST', 'EVEN', 2, 'It is your Birthday — collect ₹500 from each player', [{ type: 'COLLECT_FROM_EACH_PLAYER', amount: 500 }]),
  card('COMMUNITY_CHEST', 'EVEN', 4, '1st prize in beauty contest — receive ₹2,500 from Bank', [receive(2500)]),
  card('COMMUNITY_CHEST', 'EVEN', 6, 'Income tax refund — receive ₹2,000 from Bank', [receive(2000)]),
  card('COMMUNITY_CHEST', 'EVEN', 8, 'Go to Rest House — you cannot play next turn', REST_HOUSE),
  card('COMMUNITY_CHEST', 'EVEN', 10, 'Receive interest on shares — ₹1,500 from Bank', [receive(1500)]),
  card('COMMUNITY_CHEST', 'EVEN', 12, 'Sale of stocks — receive ₹3,000 from Bank', [receive(3000)]),
];

export const COMMUNITY_CHEST_ODD: readonly CardDefinition[] = [
  card('COMMUNITY_CHEST', 'ODD', 3, 'Go to Jail', JAIL),
  card('COMMUNITY_CHEST', 'ODD', 5, 'School and medical fees — pay ₹1,000 to Bank', [pay(1000)]),
  card('COMMUNITY_CHEST', 'ODD', 7, 'Marriage celebration — pay ₹2,000 to Bank', [pay(2000)]),
  card('COMMUNITY_CHEST', 'ODD', 9, 'Make general repairs on all your properties — ₹50 per house, ₹100 per hotel', [
    { type: 'PAY_PER_BUILDING', perHouse: 50, perHotel: 100 },
  ]),
  card('COMMUNITY_CHEST', 'ODD', 11, 'Pay insurance premium — ₹1,500 to Bank', [pay(1500)]),
];

export const CARD_TABLES: Readonly<Record<Deck, Readonly<Record<CardTable, readonly CardDefinition[]>>>> = {
  CHANCE: { EVEN: CHANCE_EVEN, ODD: CHANCE_ODD },
  COMMUNITY_CHEST: { EVEN: COMMUNITY_CHEST_EVEN, ODD: COMMUNITY_CHEST_ODD },
};

export const CHANCE_CARDS: readonly CardDefinition[] = [...CHANCE_EVEN, ...CHANCE_ODD];
export const COMMUNITY_CHEST_CARDS: readonly CardDefinition[] = [...COMMUNITY_CHEST_EVEN, ...COMMUNITY_CHEST_ODD];
export const ALL_CARDS: readonly CardDefinition[] = [...CHANCE_CARDS, ...COMMUNITY_CHEST_CARDS];

export const DECK_LABELS: Record<Deck, string> = {
  CHANCE: 'Chance',
  COMMUNITY_CHEST: 'Community Chest',
};

export function tableFor(rollTotal: number): CardTable {
  return rollTotal % 2 === 0 ? 'EVEN' : 'ODD';
}

/** The card for a deck and the dice total that landed the player on the square. */
export function findCard(deck: Deck, rollTotal: number): CardDefinition {
  const table = tableFor(rollTotal);
  return CARD_TABLES[deck][table].find((c) => c.rollTotal === rollTotal) ?? unknown(deck, table, rollTotal);
}

export function getCardById(id: string): CardDefinition | undefined {
  return ALL_CARDS.find((c) => c.id === id);
}
