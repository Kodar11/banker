/**
 * Bot seats — what the engine knows about a seat the game plays by itself.
 *
 * A bot is an ordinary player in every rule: the same starting cash, turns, payments, auctions,
 * trades, loans, bankruptcy and standings. The only thing the engine records is THAT a seat is a
 * bot and how it was configured (difficulty and personality), so every device can show it and the
 * server knows which seats it must play. The decisions themselves live in src/bots, outside the
 * engine, and reach the game only as ordinary actions that this engine validates.
 *
 * Public information: everyone at the table may see which seats are bots, and how they were set up.
 */

export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export const BOT_PERSONALITIES = ['investor', 'banker', 'dealmaker', 'opportunist'] as const;
export type BotPersonality = (typeof BOT_PERSONALITIES)[number];

/** How a bot seat plays. Stored with the seat (PlayerState.bot) and fixed for the whole game. */
export interface BotSeat {
  difficulty: BotDifficulty;
  personality: BotPersonality;
}

export const BOT_DIFFICULTY_LABELS: Record<BotDifficulty, { label: string; hint: string }> = {
  easy: { label: 'Easy', hint: 'Simple estimates and short-term plans. Good for learning the game.' },
  normal: { label: 'Normal', hint: 'Balanced play: plans ahead, manages cash and negotiates.' },
  hard: { label: 'Hard', hint: 'Simulates the board, weighs risk and timing carefully.' },
};

export const BOT_PERSONALITY_LABELS: Record<BotPersonality, { label: string; motto: string; hint: string }> = {
  investor: { label: 'Investor', motto: 'Growth first', hint: 'Buys income, completes groups and builds when it pays back.' },
  banker: { label: 'Banker', motto: 'Stability first', hint: 'Keeps cash in reserve, avoids debt and buys protection.' },
  dealmaker: { label: 'Deal Maker', motto: 'Negotiation first', hint: 'Proposes trades and counteroffers to complete groups.' },
  opportunist: { label: 'Opportunist', motto: 'Advantage first', hint: 'Hunts bargains and auctions, and takes calculated risks.' },
};

/**
 * Names a bot seat is given, in order: the first one nobody at the table has. Each starts with "Bot" so
 * a bot is never mistaken for a person in a list of names, and every one is a valid player name.
 */
export const BOT_NAMES = ['Bot Aarav', 'Bot Diya', 'Bot Kabir', 'Bot Meera', 'Bot Rohan', 'Bot Isha', 'Bot Vikram', 'Bot Anaya'] as const;

/** The personalities of a table of `count` bots when nobody picks them: each in turn, so no two neighbours play alike. */
export function defaultBotPersonalities(count: number, offset = 0): BotPersonality[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => BOT_PERSONALITIES[(i + offset) % BOT_PERSONALITIES.length]!);
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(value);
}

export function isBotPersonality(value: unknown): value is BotPersonality {
  return typeof value === 'string' && (BOT_PERSONALITIES as readonly string[]).includes(value);
}

/** "Bot · Normal · Investor" — how a bot seat is described next to its name. */
export function botSeatLabel(bot: BotSeat): string {
  return `Bot · ${BOT_DIFFICULTY_LABELS[bot.difficulty].label} · ${BOT_PERSONALITY_LABELS[bot.personality].label}`;
}
