// Voice chat (push-to-talk): the wire format shared by the app and the `voice-token` Edge Function.
// Not game state: nothing here is stored in a game, logged or replayed, and no game action reads it.
// The server decides who may talk, in which channel and under which uid; the app only asks.
import { z } from 'zod';
import { PlayerTokenSchema } from './protocol.ts';

/** Realtime broadcast event name on the game's topic: "this room's voice setting changed, ask again". */
export const VOICE_EVENT = 'voice';

/**
 * The Agora channel of a game. Derived from the game id on the server, never taken from a request:
 * a token for one game's channel is useless in any other. 35 characters, inside Agora's 64-byte limit.
 */
export function voiceChannelName(gameId: string): string {
  return `rr-${gameId.replace(/-/g, '')}`;
}

/**
 * A player's Agora uid: their seat, plus one (0 means "pick one for me" to Agora). Seats are unique
 * in a game and fixed once it has started, so every phone maps the same uid to the same player
 * without anything being sent between them.
 */
export function voiceUidForSeat(seat: number): number {
  return seat + 1;
}

export function seatForVoiceUid(uid: number): number {
  return uid - 1;
}

/** Why voice is not to be had right now. The app shows a sentence for each; the server never explains further. */
export type VoiceDenial =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  /** The kill switch, or private-room voice, is off. */
  | 'VOICE_DISABLED'
  /** A matchmade game: voice is never offered there. */
  | 'PUBLIC_GAME'
  /** The host has not turned voice on for this room. */
  | 'ROOM_VOICE_OFF'
  /** The room's host may not (or may no longer) host voice. */
  | 'NOT_ENTITLED'
  | 'NOT_HOST'
  /** Voice is for a game in play (not the lobby, not a finished game). */
  | 'GAME_NOT_ACTIVE'
  /** The experiment's monthly allowance is used up. */
  | 'LIMIT_REACHED'
  /** This game has used its own voice time. */
  | 'GAME_LIMIT_REACHED'
  | 'RATE_LIMITED'
  /** The server has no Agora credentials. */
  | 'NOT_CONFIGURED'
  /** A heartbeat for a voice session the server has already closed: ask for a new token. */
  | 'SESSION_ENDED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'TIMEOUT';

const uuid = z.string().uuid();
const seat = { gameId: uuid, playerId: uuid, token: PlayerTokenSchema };

/** Body of a POST to the `voice-token` Edge Function. The caller is whoever the device token proves. */
export const VoiceRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), ...seat }).strict(),
  /** Host only: turn voice on or off for the room. */
  z.object({ op: z.literal('enable'), ...seat, enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('join'), ...seat }).strict(),
  z.object({ op: z.literal('renew'), ...seat }).strict(),
  z.object({ op: z.literal('heartbeat'), ...seat }).strict(),
  z.object({ op: z.literal('leave'), ...seat }).strict(),
]);

export type VoiceRequest = z.infer<typeof VoiceRequestSchema>;

/** What the app may know about a room's voice. */
export interface VoiceRoom {
  /** The host turned voice on for this room (the server's flag). */
  enabled: boolean;
  /** A token would be issued right now. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason: VoiceDenial | null;
  /** The caller is the host of a private room and may switch voice on or off. */
  canConfigure: boolean;
}

/** Everything the app needs to join, and nothing else: no certificate, no other player's token. */
export interface VoiceGrant {
  token: string;
  channel: string;
  uid: number;
  /** Server time the token stops working. */
  expiresAt: string;
  /** How often the app says "still connected" while in the channel. */
  heartbeatSeconds: number;
}

export type VoiceFailure = { ok: false; error: { code: VoiceDenial; message: string } };

export type VoiceStatusResponse = { ok: true; room: VoiceRoom } | VoiceFailure;
export type VoiceGrantResponse = { ok: true; grant: VoiceGrant } | VoiceFailure;
export type VoiceAckResponse = { ok: true } | VoiceFailure;
export type VoiceResponse = VoiceStatusResponse | VoiceGrantResponse | VoiceAckResponse;
