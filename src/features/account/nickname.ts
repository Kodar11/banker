/**
 * Nickname rules on the phone: instant feedback while typing. The server applies the same
 * normalisation and checks again (supabase/migrations/…_player_profiles.sql) and has the last
 * word — it alone knows the moderation list and the rate limit.
 */
export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 20;

export type NicknameProblem = 'NICKNAME_EMPTY' | 'NICKNAME_TOO_SHORT' | 'NICKNAME_TOO_LONG' | 'NICKNAME_INVALID_CHARACTERS';

/** Exactly the characters the server treats as a space (not JavaScript's wider \s). */
const SPACES = /[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu;
/** Control characters and invisible formatting marks. ZWNJ / ZWJ are allowed (Indian scripts, emoji). */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/u;
const UNCOUNTED = /[ \u200C\u200D]/gu;

/** Length the way the server counts it: Unicode code points, not UTF-16 units. */
export function nicknameLength(value: string): number {
  return Array.from(value).length;
}

/** NFC, every kind of space becomes one ordinary space, nothing at either end. */
export function normalizeNickname(raw: string): string {
  return raw.normalize('NFC').replace(SPACES, ' ').replace(/^ +| +$/g, '');
}

/** null when the (already normalised) nickname is acceptable. */
export function nicknameProblem(name: string): NicknameProblem | null {
  if (name === '') return 'NICKNAME_EMPTY';
  if (FORBIDDEN.test(name)) return 'NICKNAME_INVALID_CHARACTERS';
  if (nicknameLength(name) > NICKNAME_MAX) return 'NICKNAME_TOO_LONG';
  if (nicknameLength(name.replace(UNCOUNTED, '')) < NICKNAME_MIN) return 'NICKNAME_TOO_SHORT';
  return null;
}

export type NicknameCheck = { ok: true; nickname: string } | { ok: false; problem: NicknameProblem };

export function checkNickname(raw: string): NicknameCheck {
  const nickname = normalizeNickname(raw);
  const problem = nicknameProblem(nickname);
  return problem ? { ok: false, problem } : { ok: true, nickname };
}

export const NICKNAME_MESSAGES: Record<NicknameProblem | 'NICKNAME_NOT_ALLOWED', string> = {
  NICKNAME_EMPTY: 'Enter a nickname.',
  NICKNAME_TOO_SHORT: `Use at least ${NICKNAME_MIN} characters.`,
  NICKNAME_TOO_LONG: `Use ${NICKNAME_MAX} characters or fewer.`,
  NICKNAME_INVALID_CHARACTERS: 'That nickname contains characters that can’t be used.',
  NICKNAME_NOT_ALLOWED: 'That nickname isn’t allowed. Please choose another.',
};
