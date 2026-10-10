import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { FunctionsHttpError, isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError, type Session } from '@supabase/supabase-js';
import { AUTH_CALLBACK_PATH, readAuthCallback } from '@/features/account/oauthCallback';
import { fail, ok, toProfile, type AccountError, type AccountErrorCode, type Profile, type Result } from '@/features/account/types';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Every call the account feature makes to Supabase, one small function each. Nothing here
 * decides what a result means for the player's identity — that is accountStore's job — and
 * nothing here throws.
 */
const TIMEOUT_MS = 12_000;
export const DELETE_FUNCTION_NAME = 'delete-account';

/** The tokens of one signed-in account on this phone. Held in memory only, never logged. */
export interface SessionInfo {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

const NOT_CONFIGURED = fail('NOT_CONFIGURED', 'The game server is not configured.');
const NETWORK_MESSAGE = 'No connection. Check your internet and try again.';
const SERVER_MESSAGE = 'The server had a problem. Please try again.';

const SESSION_CODES = new Set(['user_not_found', 'session_not_found', 'session_expired', 'bad_jwt', 'refresh_token_not_found', 'refresh_token_already_used', 'no_authorization']);

function authError(error: unknown): AccountError {
  const of = (code: AccountErrorCode, message: string): AccountError => ({ code, message });
  if (isAuthRetryableFetchError(error)) return of('NETWORK', NETWORK_MESSAGE);
  if (isAuthSessionMissingError(error)) return of('SESSION_INVALID', 'Your session on this phone has ended.');
  if (isAuthApiError(error)) {
    const code = error.code ?? '';
    if (code === 'anonymous_provider_disabled') return of('ANONYMOUS_DISABLED', 'Guest accounts are not available right now.');
    if (code === 'manual_linking_disabled') return of('LINKING_DISABLED', 'Linking a Google account is not available right now.');
    if (code === 'identity_already_exists') return of('IDENTITY_IN_USE', 'That Google account is already linked to another player. Nothing was changed.');
    if (code === 'provider_disabled' || code === 'oauth_provider_not_supported' || (code === 'validation_failed' && /provider/i.test(error.message))) {
      return of('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now.');
    }
    if (code === 'over_request_rate_limit' || error.status === 429) return of('RATE_LIMITED', 'Too many attempts. Please wait a little and try again.');
    if (code === 'flow_state_not_found' || code === 'flow_state_expired' || code === 'bad_code_verifier') return of('OAUTH', 'Google sign-in did not complete. Please try again.');
    if (SESSION_CODES.has(code) || error.status === 401 || error.status === 403 || error.status === 404) {
      return of('SESSION_INVALID', 'Your session on this phone has ended.');
    }
  }
  return of('SERVER', SERVER_MESSAGE);
}

function info(session: Session): SessionInfo {
  return { userId: session.user.id, accessToken: session.access_token, refreshToken: session.refresh_token };
}

/** Runs one database function with a time limit; maps transport and token failures. */
async function rpc(name: 'init_profile' | 'update_nickname', args?: Record<string, unknown>): Promise<Result<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { data, error, status } = await getSupabase().rpc(name, args).abortSignal(controller.signal);
    if (error) {
      if (status === 401 || /^PGRST30[123]$/.test(error.code ?? '')) return fail('SESSION_INVALID', 'Your session on this phone has ended.');
      if (!status || /abort|network|fetch|timeout/i.test(`${error.message} ${error.details ?? ''}`)) return fail('NETWORK', NETWORK_MESSAGE);
      return fail('SERVER', SERVER_MESSAGE);
    }
    if (!data || typeof data !== 'object') return fail('SERVER', SERVER_MESSAGE);
    return ok(data as Record<string, unknown>);
  } catch {
    return fail('NETWORK', NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens Google in the system browser and turns the redirect back into a session. */
async function googleFlow(start: (redirectTo: string) => Promise<{ data: { url?: string | null } | null; error: unknown }>): Promise<Result<SessionInfo>> {
  if (!isSupabaseConfigured) return NOT_CONFIGURED;
  try {
    const redirectTo = Linking.createURL(AUTH_CALLBACK_PATH);
    const { data, error } = await start(redirectTo);
    if (error) return { ok: false, error: authError(error) };
    if (!data?.url) return fail('OAUTH', 'Google sign-in could not be started. Please try again.');

    const browser = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (browser.type !== 'success') return fail('CANCELLED', 'Google sign-in was cancelled.');
    const code = readAuthCallback(browser.url);
    if (!code.ok) return code;

    const exchanged = await getSupabase().auth.exchangeCodeForSession(code.value);
    if (exchanged.error) return { ok: false, error: authError(exchanged.error) };
    if (!exchanged.data.session) return fail('OAUTH', 'Google sign-in did not complete. Please try again.');
    return ok(info(exchanged.data.session));
  } catch {
    return fail('NETWORK', NETWORK_MESSAGE);
  }
}

export const accountApi = {
  /**
   * The session stored on this phone, refreshed if it had expired. `null` = there is none (never
   * was, or Supabase Auth has ended it). A failure means it could not be checked — the stored
   * session is still there.
   */
  async restoreSession(): Promise<Result<SessionInfo | null>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    try {
      const { data, error } = await getSupabase().auth.getSession();
      if (data.session) return ok(info(data.session));
      if (!error) return ok(null);
      const mapped = authError(error);
      return mapped.code === 'SESSION_INVALID' ? ok(null) : { ok: false, error: mapped };
    } catch {
      return fail('NETWORK', NETWORK_MESSAGE);
    }
  },

  async signInAnonymously(): Promise<Result<SessionInfo>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    try {
      const { data, error } = await getSupabase().auth.signInAnonymously();
      if (error) return { ok: false, error: authError(error) };
      if (!data.session) return fail('SERVER', SERVER_MESSAGE);
      return ok(info(data.session));
    } catch {
      return fail('NETWORK', NETWORK_MESSAGE);
    }
  },

  /** Creates the signed-in user's profile if it does not exist yet (idempotent on the server) and returns it. */
  async initProfile(): Promise<Result<{ profile: Profile; created: boolean }>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    const res = await rpc('init_profile');
    if (!res.ok) return res;
    if (res.value.ok !== true) return fail('SESSION_INVALID', 'Your session on this phone has ended.');
    const profile = toProfile(res.value.profile);
    if (!profile) return fail('SERVER', SERVER_MESSAGE);
    return ok({ profile, created: res.value.created === true });
  },

  /** Asks Supabase Auth whether this phone's session still belongs to an existing account. */
  async verifyUser(): Promise<Result<'valid' | 'gone'>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    try {
      const { data, error } = await getSupabase().auth.getUser();
      if (!error) return data.user ? ok('valid') : ok('gone');
      const mapped = authError(error);
      return mapped.code === 'SESSION_INVALID' ? ok('gone') : { ok: false, error: mapped };
    } catch {
      return fail('NETWORK', NETWORK_MESSAGE);
    }
  },

  async updateNickname(nickname: string): Promise<Result<Profile>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    const res = await rpc('update_nickname', { p_nickname: nickname });
    if (!res.ok) return res;
    if (res.value.ok !== true) {
      const code = String(res.value.code ?? '');
      if (code === 'RATE_LIMITED') {
        const seconds = Number(res.value.retry_after_seconds);
        return fail('RATE_LIMITED', 'You’ve changed your nickname too many times today. Try again later.', Number.isFinite(seconds) ? seconds : undefined);
      }
      if (code === 'NICKNAME_EMPTY' || code === 'NICKNAME_TOO_SHORT' || code === 'NICKNAME_TOO_LONG' || code === 'NICKNAME_INVALID_CHARACTERS' || code === 'NICKNAME_NOT_ALLOWED') {
        return fail(code, code);
      }
      if (code === 'UNAUTHENTICATED' || code === 'NO_PROFILE') return fail('SESSION_INVALID', 'Your session on this phone has ended.');
      return fail('SERVER', SERVER_MESSAGE);
    }
    const profile = toProfile(res.value.profile);
    return profile ? ok(profile) : fail('SERVER', SERVER_MESSAGE);
  },

  /**
   * Adds Google to the account that is signed in. This is Supabase Auth's identity LINKING — the
   * user id cannot change — never a sign-in. If the Google account belongs to someone else the
   * redirect carries an error and the current session is left exactly as it was.
   */
  linkGoogle(): Promise<Result<SessionInfo>> {
    return googleFlow((redirectTo) => getSupabase().auth.linkIdentity({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } }));
  },

  /** Signs in with Google. REPLACES this phone's session with that Google account's player on success. */
  signInWithGoogle(): Promise<Result<SessionInfo>> {
    return googleFlow((redirectTo) =>
      getSupabase().auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } }),
    );
  },

  /** Puts an earlier session of this phone back (after a sign-in that turned out to be the wrong account). */
  async restoreTokens(session: SessionInfo): Promise<Result<SessionInfo>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    try {
      const { data, error } = await getSupabase().auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken });
      if (error) return { ok: false, error: authError(error) };
      if (!data.session) return fail('SERVER', SERVER_MESSAGE);
      return ok(info(data.session));
    } catch {
      return fail('NETWORK', NETWORK_MESSAGE);
    }
  },

  /** Forgets the session on this phone only. Never fails. */
  async signOutLocal(): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      await getSupabase().auth.signOut({ scope: 'local' });
    } catch {
      // Nothing left to do: the next launch checks the session again.
    }
  },

  /**
   * Permanently deletes an account on the server: the signed-in one, or — given its token — an
   * empty account a mistaken Google sign-in has just created.
   */
  async deleteAccount(accessToken?: string): Promise<Result<true>> {
    if (!isSupabaseConfigured) return NOT_CONFIGURED;
    try {
      const { data, error } = await getSupabase().functions.invoke<{ ok: boolean }>(DELETE_FUNCTION_NAME, {
        body: { confirm: 'DELETE' },
        timeout: TIMEOUT_MS,
        ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      });
      if (error) {
        if (error instanceof FunctionsHttpError) {
          let code = '';
          try {
            const parsed = (await error.context.json()) as { error?: { code?: string } };
            code = parsed?.error?.code ?? '';
          } catch {
            // fall through
          }
          if (code === 'REAUTH_REQUIRED') return fail('REAUTH_REQUIRED', 'Confirm with Google to delete this account.');
          if (code === 'UNAUTHORIZED') return fail('SESSION_INVALID', 'Your session on this phone has ended.');
          return fail('SERVER', 'Your account was not deleted. Please try again.');
        }
        return fail('NETWORK', NETWORK_MESSAGE);
      }
      return data?.ok === true ? ok(true) : fail('SERVER', 'Your account was not deleted. Please try again.');
    } catch {
      return fail('NETWORK', NETWORK_MESSAGE);
    }
  },

  /** Supabase Auth ended the session by itself (e.g. the refresh token was revoked). */
  onSignedOut(listener: () => void): () => void {
    if (!isSupabaseConfigured) return () => undefined;
    const { data } = getSupabase().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') listener();
    });
    return () => data.subscription.unsubscribe();
  },

  /** Token refresh runs only while the app is in the foreground. */
  setForeground(active: boolean): void {
    if (!isSupabaseConfigured) return;
    const auth = getSupabase().auth;
    void (active ? auth.startAutoRefresh() : auth.stopAutoRefresh()).catch(() => undefined);
  },
};
