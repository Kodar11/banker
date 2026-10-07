/**
 * BUSINESS V1 — Chance and Community Chest.
 *
 * The photographed cards are numbered outcome tables ("... such as 3,5,7"), so
 * each entry is keyed by the dice total that landed the player on the square
 * (see BUSINESS_MVP_RULES.cards.selection — that interpretation is an assumption).
 *
 * Wording and values below are only what the photographs establish. Entries the
 * photographs do not show (or show illegibly) are `verified: false` with a
 * MANUAL effect: the app asks the player to read the physical card and enter the
 * money effect. Nothing here is invented.
 */

export type Deck = 'CHANCE' | 'COMMUNITY_CHEST';

export type CardEffect =
  | { type: 'PAY_BANK'; amount: number }
  | { type: 'RECEIVE_FROM_BANK'; amount: number }
  | { type: 'GO_TO_JAIL' }
  | { type: 'MOVE_TO'; destination: 'REST_HOUSE' | 'JAIL' | 'START'; resolveLanding: boolean }
  | { type: 'SKIP_TURNS'; count: number }
  | { type: 'PAY_PER_BUILDING'; perHouse: number; perHotel: number }
  /** Effect not captured from the photographs — resolve using the physical card. */
  | { type: 'MANUAL' };

export interface CardDefinition {
  id: string;
  deck: Deck;
  /** Dice total this outcome applies to. */
  rollTotal: number;
  text: string;
  effects: CardEffect[];
  /** false = wording/effect not legible in the photographs; needs verification. */
  verified: boolean;
}

const UNKNOWN_TEXT = 'Not captured from the photographed card — read the physical card.';

function card(deck: Deck, rollTotal: number, text: string, effects: CardEffect[], verified = true): CardDefinition {
  return { id: `${deck}_${rollTotal}`, deck, rollTotal, text, effects, verified };
}

function unknown(deck: Deck, rollTotal: number, partialText?: string): CardDefinition {
  return card(deck, rollTotal, partialText ?? UNKNOWN_TEXT, [{ type: 'MANUAL' }], false);
}

export const CHANCE_CARDS: readonly CardDefinition[] = [
  unknown('CHANCE', 1, 'You have won … / bank … (partially legible — read the physical card)'),
  card('CHANCE', 2, 'Loss in share market Rs. 2000/-', [{ type: 'PAY_BANK', amount: 2000 }]),
  card('CHANCE', 3, 'Fines for accident due to driving under the influence Rs. 1500/-', [
    { type: 'PAY_BANK', amount: 1500 },
  ]),
  card('CHANCE', 4, 'House Repairs Rs. 1500/-', [{ type: 'PAY_BANK', amount: 1500 }]),
  card('CHANCE', 5, 'Loss due to fire in godown Rs. 3000/-', [{ type: 'PAY_BANK', amount: 3000 }]),
  unknown('CHANCE', 6),
  unknown('CHANCE', 7),
  unknown('CHANCE', 8),
  unknown('CHANCE', 9),
  card('CHANCE', 10, 'Go to Jail', [{ type: 'GO_TO_JAIL' }]),
  unknown('CHANCE', 11),
  card('CHANCE', 12, 'Go to Rest House, you cannot play next turn', [
    { type: 'MOVE_TO', destination: 'REST_HOUSE', resolveLanding: false },
    { type: 'SKIP_TURNS', count: 1 },
  ]),
];

export const COMMUNITY_CHEST_CARDS: readonly CardDefinition[] = [
  card('COMMUNITY_CHEST', 1, 'School and medical fees: Rs. 1000/-', [{ type: 'PAY_BANK', amount: 1000 }]),
  unknown('COMMUNITY_CHEST', 2),
  card('COMMUNITY_CHEST', 3, 'Marriage celebration: Rs. 200/-', [{ type: 'PAY_BANK', amount: 200 }]),
  unknown('COMMUNITY_CHEST', 4),
  card('COMMUNITY_CHEST', 5, 'Go to jail', [{ type: 'GO_TO_JAIL' }]),
  unknown('COMMUNITY_CHEST', 6),
  unknown('COMMUNITY_CHEST', 7),
  unknown('COMMUNITY_CHEST', 8),
  card(
    'COMMUNITY_CHEST',
    9,
    'Make general repair on all your properties. For each house pay Rs. 100/-. For each hotel pay Rs. 500/-',
    [{ type: 'PAY_PER_BUILDING', perHouse: 100, perHotel: 500 }],
  ),
  unknown('COMMUNITY_CHEST', 10),
  card('COMMUNITY_CHEST', 11, 'Pay insurance premium Rs. 1500/-', [{ type: 'PAY_BANK', amount: 1500 }]),
  unknown('COMMUNITY_CHEST', 12),
];

export const ALL_CARDS: readonly CardDefinition[] = [...CHANCE_CARDS, ...COMMUNITY_CHEST_CARDS];

export const DECK_LABELS: Record<Deck, string> = {
  CHANCE: 'Chance',
  COMMUNITY_CHEST: 'Community Chest',
};

export function findCard(deck: Deck, rollTotal: number): CardDefinition {
  const table = deck === 'CHANCE' ? CHANCE_CARDS : COMMUNITY_CHEST_CARDS;
  const found = table.find((c) => c.rollTotal === rollTotal);
  return found ?? unknown(deck, rollTotal);
}

export function getCardById(id: string): CardDefinition | undefined {
  return ALL_CARDS.find((c) => c.id === id);
}
