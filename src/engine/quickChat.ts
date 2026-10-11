// Quick reactions and preset messages: the one catalogue, and the wire format, shared by the app
// and the server. Not game state: nothing here is stored in a game, logged or replayed. A reaction
// travels as an id from this catalogue, never as text.
import { z } from 'zod';
import { PlayerTokenSchema } from './protocol.ts';

/** One reaction or message per player in this long, counted on the server's clock. */
export const QUICK_CHAT_COOLDOWN_MS = 2000;

/** Realtime broadcast event name on the game's topic (next to `state`). */
export const QUICK_CHAT_EVENT = 'chat';

export const QUICK_CHAT_VERSION = 1;

export const QUICK_REACTIONS = [
  { key: 'funny', emoji: '😂', label: 'Funny' },
  { key: 'sneaky', emoji: '😏', label: 'Sneaky move' },
  { key: 'unexpected', emoji: '😮', label: 'Unexpected' },
  { key: 'unlucky', emoji: '😭', label: 'Unlucky' },
  { key: 'great_move', emoji: '🔥', label: 'Great move' },
  { key: 'respect', emoji: '👏', label: 'Respect' },
  { key: 'deal', emoji: '🤝', label: 'Deal?' },
  { key: 'money_gone', emoji: '💸', label: 'Money gone' },
] as const;

export const QUICK_MESSAGE_GROUPS = [
  {
    key: 'teasing',
    title: '😈 Teasing',
    messages: [
      { key: 'bro_is_broke', text: 'Bro is broke 💸' },
      { key: 'skill_issue', text: 'Skill issue 😂' },
      { key: 'nice_try', text: 'Nice try! 😏' },
      { key: 'rip_wallet', text: 'RIP your wallet 💀' },
    ],
  },
  {
    key: 'deals',
    title: '💰 Deals & negotiation',
    messages: [
      { key: 'deal_or_no_deal', text: 'Deal or no deal? 🤝' },
      { key: 'make_an_offer', text: 'Make me an offer!' },
      { key: 'too_expensive', text: "That's too expensive!" },
      { key: 'help_me_out', text: 'Come on, help me out 😂' },
    ],
  },
  {
    key: 'moments',
    title: '🎲 Game moments',
    messages: [
      { key: 'coming_for_you', text: "I'm coming for you 😈" },
      { key: 'lucky_roll', text: 'Lucky roll! 🍀' },
      { key: 'you_got_lucky', text: 'You got lucky! 🙄' },
      { key: 'its_over', text: "It's over for you 💀" },
    ],
  },
] as const;

export type QuickReaction = (typeof QUICK_REACTIONS)[number];
export type QuickReactionKey = QuickReaction['key'];
export type QuickMessage = (typeof QUICK_MESSAGE_GROUPS)[number]['messages'][number];
export type QuickMessageKey = QuickMessage['key'];

export const QUICK_MESSAGES: readonly QuickMessage[] = QUICK_MESSAGE_GROUPS.flatMap((g) => [...g.messages]);

/** What a player picks in the sheet. */
export type QuickChatItem = { kind: 'reaction'; key: QuickReactionKey } | { kind: 'preset_message'; key: QuickMessageKey };

export function quickReaction(key: string): QuickReaction | undefined {
  return QUICK_REACTIONS.find((r) => r.key === key);
}

export function quickMessage(key: string): QuickMessage | undefined {
  return QUICK_MESSAGES.find((m) => m.key === key);
}

/** True when `key` is in the catalogue for `kind`. */
export function isQuickChatItem(item: { kind: string; key: string }): item is QuickChatItem {
  return item.kind === 'reaction' ? !!quickReaction(item.key) : item.kind === 'preset_message' ? !!quickMessage(item.key) : false;
}

const uuid = z.string().uuid();
const kind = z.enum(['reaction', 'preset_message']);
const key = z.string().min(1).max(40);

/** Body of a POST to the `game-action` Edge Function that sends one reaction or message. The sender is whoever the token proves. */
export const QuickChatRequestSchema = z
  .object({
    op: z.literal('chat'),
    gameId: uuid,
    playerId: uuid,
    token: PlayerTokenSchema,
    /** Made on the phone for one tap: the same event is never shown twice. */
    eventId: uuid,
    kind,
    key,
  })
  .strict()
  .refine(isQuickChatItem, { message: 'Unknown reaction or message' });

export type QuickChatRequest = z.infer<typeof QuickChatRequestSchema> & QuickChatItem;

/** What the server broadcasts on the game's topic, and answers the sender with. */
export const QuickChatEventSchema = z
  .object({
    v: z.literal(QUICK_CHAT_VERSION),
    id: uuid,
    gameId: uuid,
    /** The sender, as authenticated by the server. */
    playerId: uuid,
    kind,
    key,
    /** Server time the event was accepted. */
    at: z.string(),
  })
  .strict()
  .refine(isQuickChatItem, { message: 'Unknown reaction or message' });

export type QuickChatEvent = z.infer<typeof QuickChatEventSchema> & QuickChatItem;

export type QuickChatErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'GAME_NOT_ACTIVE' | 'COOLDOWN' | 'UNAVAILABLE' | 'SERVER_ERROR' | 'NETWORK' | 'TIMEOUT';

/** `ok` means the server accepted and broadcast it, not that every phone showed it. */
export type QuickChatResponse =
  | { ok: true; event: QuickChatEvent }
  | { ok: false; error: { code: QuickChatErrorCode; message: string; /** COOLDOWN only. */ retryAfterMs?: number } };
