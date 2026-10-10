// Permanent account deletion. The caller can only ever delete THEMSELVES:
//
//   read the bearer token → ask Supabase Auth who it belongs to (never trust an id in the body) →
//   require the explicit confirmation word → for a Google-linked account require a recent
//   sign-in → delete the Auth user with the service role.
//
// Deleting the Auth user is one operation on the server: it revokes every session and refresh
// token, removes the Google identity, and — through profiles.user_id ON DELETE CASCADE — removes
// the profile. There is no second step that could be left half done, and a retry after a lost
// response finds no user and changes nothing.
//
// Runtime-agnostic so it can be tested in Node (tests/account/deleteAccount.test.ts).

export interface AuthUser {
  id: string;
  hasGoogle: boolean;
  /** ISO time of the last interactive sign-in (not of a token refresh). */
  lastSignInAt: string | null;
}

export interface DeleteAccountDeps {
  /** The user the access token belongs to; null when Supabase Auth rejects it. Throws when Auth cannot be reached. */
  verifyUser: (accessToken: string) => Promise<AuthUser | null>;
  /** Hard-deletes the Auth user. 'not_found' when it is already gone. Throws on any other failure. */
  deleteUser: (userId: string) => Promise<'deleted' | 'not_found'>;
  now?: () => Date;
}

export type DeleteAccountErrorCode = 'UNAUTHORIZED' | 'VALIDATION' | 'REAUTH_REQUIRED' | 'SERVER_ERROR';

export type DeleteAccountResponse = { ok: true } | { ok: false; error: { code: DeleteAccountErrorCode; message: string } };

export interface DeleteAccountResult {
  status: number;
  body: DeleteAccountResponse;
}

/** The word the app must send: the request is deliberate, not a stray call. */
export const DELETE_CONFIRMATION = 'DELETE';

/** A Google-linked account must have signed in with Google this recently to be deleted. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

function fail(status: number, code: DeleteAccountErrorCode, message: string): DeleteAccountResult {
  return { status, body: { ok: false, error: { code, message } } };
}

export function bearerToken(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1] ?? null;
}

export async function handleDeleteAccount(authorization: string | null | undefined, rawBody: unknown, deps: DeleteAccountDeps): Promise<DeleteAccountResult> {
  const token = bearerToken(authorization);
  if (!token) return fail(401, 'UNAUTHORIZED', 'Sign in again to delete your account.');
  if (!rawBody || typeof rawBody !== 'object' || (rawBody as { confirm?: unknown }).confirm !== DELETE_CONFIRMATION) {
    return fail(400, 'VALIDATION', 'Account deletion was not confirmed.');
  }

  try {
    const user = await deps.verifyUser(token);
    if (!user) return fail(401, 'UNAUTHORIZED', 'Sign in again to delete your account.');

    if (user.hasGoogle) {
      const signedInAt = user.lastSignInAt ? Date.parse(user.lastSignInAt) : NaN;
      const now = (deps.now ? deps.now() : new Date()).getTime();
      if (!Number.isFinite(signedInAt) || now - signedInAt > REAUTH_WINDOW_MS) {
        return fail(403, 'REAUTH_REQUIRED', 'Confirm with Google to delete this account.');
      }
    }

    await deps.deleteUser(user.id);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    console.error('delete-account failed', error);
    return fail(500, 'SERVER_ERROR', 'Your account was not deleted. Please try again.');
  }
}
