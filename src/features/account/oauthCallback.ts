import { fail, ok, type Result } from './types';

/** Path the Google sign-in returns to: businessbanker://auth-callback (see app/auth-callback.tsx). */
export const AUTH_CALLBACK_PATH = 'auth-callback';

function parsePairs(part: string | undefined, into: Record<string, string>): void {
  for (const pair of (part ?? '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      into[decodeURIComponent(name)] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // A malformed pair is ignored.
    }
  }
}

/** Query and fragment parameters of the redirect (Supabase Auth uses either). */
export function callbackParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const hash = url.indexOf('#');
  const beforeHash = hash < 0 ? url : url.slice(0, hash);
  const query = beforeHash.indexOf('?');
  if (query >= 0) parsePairs(beforeHash.slice(query + 1), params);
  if (hash >= 0) parsePairs(url.slice(hash + 1), params);
  return params;
}

/** The one-time code to exchange for a session, or why the sign-in did not complete. */
export function readAuthCallback(url: string): Result<string> {
  const params = callbackParams(url);
  const code = params.error_code ?? '';
  const description = params.error_description ?? '';
  if (params.error || code) {
    if (code === 'identity_already_exists' || /already linked/i.test(description)) {
      return fail('IDENTITY_IN_USE', 'That Google account is already linked to another player. Nothing was changed.');
    }
    if (params.error === 'access_denied') return fail('CANCELLED', 'Google sign-in was cancelled.');
    if (code === 'provider_disabled') return fail('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now.');
    return fail('OAUTH', 'Google sign-in did not complete. Please try again.');
  }
  if (!params.code) return fail('OAUTH', 'Google sign-in did not complete. Please try again.');
  return ok(params.code);
}
