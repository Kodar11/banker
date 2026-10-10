import { z } from 'zod';

export const PLAYER_ID_PATTERN = /^RR-[2-9A-HJ-NP-Z]{6}$/;

/** The profile exactly as the server returns it (public.profile_json). */
export const ServerProfileSchema = z.object({
  user_id: z.string().min(1),
  player_id: z.string().regex(PLAYER_ID_PATTERN),
  nickname: z.string().min(1),
  google_linked: z.boolean(),
});

export interface Profile {
  userId: string;
  /** Public, permanent, shareable. Never a credential. */
  playerId: string;
  nickname: string;
  /** From the server (auth.identities) for this app run. Never stored on the phone. */
  googleLinked: boolean;
}

export type AccountStatus = 'guest' | 'google';

export function toProfile(raw: unknown): Profile | null {
  const parsed = ServerProfileSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { userId: parsed.data.user_id, playerId: parsed.data.player_id, nickname: parsed.data.nickname, googleLinked: parsed.data.google_linked };
}

/**
 * Guest or Google-linked — only ever from a profile the server confirmed during this app run.
 * A profile remembered from an earlier run says nothing about the link (null = not known).
 */
export function accountStatusOf(profile: Profile | null, verified: boolean): AccountStatus | null {
  if (!profile || !verified) return null;
  return profile.googleLinked ? 'google' : 'guest';
}

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  guest: 'Guest account — not linked',
  google: 'Google account linked',
};

export type AccountErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'SERVER'
  /** Supabase Auth no longer accepts this phone's session. */
  | 'SESSION_INVALID'
  | 'ANONYMOUS_DISABLED'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'NOT_READY'
  | 'CANCELLED'
  | 'GOOGLE_NOT_CONFIGURED'
  | 'LINKING_DISABLED'
  /** The Google account already belongs to a different player. */
  | 'IDENTITY_IN_USE'
  | 'OAUTH'
  /** Linked on the server, but the confirmation could not be loaded yet. */
  | 'CONFIRM_PENDING'
  /** Restore found no player linked to that Google account. */
  | 'NO_LINKED_ACCOUNT'
  | 'WRONG_GOOGLE_ACCOUNT'
  | 'REAUTH_REQUIRED'
  | 'NICKNAME_EMPTY'
  | 'NICKNAME_TOO_SHORT'
  | 'NICKNAME_TOO_LONG'
  | 'NICKNAME_INVALID_CHARACTERS'
  | 'NICKNAME_NOT_ALLOWED';

export interface AccountError {
  code: AccountErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AccountError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: AccountErrorCode, message: string, retryAfterSeconds?: number): Result<never> => ({
  ok: false,
  error: retryAfterSeconds === undefined ? { code, message } : { code, message, retryAfterSeconds },
});
