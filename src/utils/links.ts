import { GameCodeSchema } from '@/engine/index.ts';
import { AUTH_CALLBACK_PATH } from '@/features/account/oauthCallback';

/**
 * Every link into the app is built and read here: the join link (QR code, share sheet) and the
 * address Google sign-in returns to. Nothing else writes `<scheme>://`.
 *
 * This is a custom URI scheme, registered by app.json `scheme` — not a web link.
 */

/** The app's only scheme: app.json `scheme`. */
export const APP_SCHEME = 'clashofcapitals';

/** The route a join link opens (app/join-game.tsx). */
export const JOIN_PATH = 'join-game';

/** clashofcapitals://join-game?code=123456 — what the lobby's QR code holds and the share sheet sends. */
export function joinLink(code: string): string {
  return `${APP_SCHEME}://${JOIN_PATH}?code=${code}`;
}

/** clashofcapitals://auth-callback — the address to allow in Supabase Auth's redirect URLs. */
export function authCallbackLink(): string {
  return `${APP_SCHEME}://${AUTH_CALLBACK_PATH}`;
}

const gameCode = (value: string): string | null => (GameCodeSchema.safeParse(value).success ? value : null);

/** `clashofcapitals://join-game?…`, with or without the third slash; the scheme in any case. */
const JOIN_LINK = new RegExp(`^${APP_SCHEME}:///?${JOIN_PATH}/?\\?([^#]*)`, 'i');

/**
 * The 6-digit game code in a scanned QR value, an opened link's `code` parameter or typed text.
 * A link counts only if it is this app's join link and carries exactly one well-formed code;
 * anything else is null. Whether the game exists and can be joined is the server's answer, never
 * this function's.
 */
export function parseJoinCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const link = JOIN_LINK.exec(text);
  if (!link) return gameCode(text);
  const codes = (link[1] ?? '')
    .split('&')
    .filter((pair) => pair.startsWith('code='))
    .map((pair) => pair.slice('code='.length));
  return codes.length === 1 && codes[0] !== undefined ? gameCode(codes[0]) : null;
}
