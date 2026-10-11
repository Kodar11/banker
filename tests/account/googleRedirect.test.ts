import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountApi } from '@/lib/accountApi';
import { authCallbackLink } from '@/utils/links';

const mocks = vi.hoisted(() => ({
  // Without a named scheme this stand-in answers with a wrong one, so the test fails if none is passed.
  createURL: vi.fn((path: string, options?: { scheme?: string }) => `${options?.scheme ?? 'unnamed-scheme'}://${path}`),
  openAuthSessionAsync: vi.fn(),
  signInWithOAuth: vi.fn(),
  linkIdentity: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

vi.mock('expo-linking', () => ({ createURL: mocks.createURL }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: mocks.openAuthSessionAsync }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({ auth: { signInWithOAuth: mocks.signInWithOAuth, linkIdentity: mocks.linkIdentity, exchangeCodeForSession: mocks.exchangeCodeForSession } }),
}));

const CALLBACK = 'clashofcapitals://auth-callback';
const session = { user: { id: 'user-1' }, access_token: 'access', refresh_token: 'refresh' };

describe('Google sign-in redirect address', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: 'https://accounts.example/auth' }, error: null });
    mocks.linkIdentity.mockResolvedValue({ data: { url: 'https://accounts.example/auth' }, error: null });
    mocks.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: `${CALLBACK}?code=one-time` });
    mocks.exchangeCodeForSession.mockResolvedValue({ data: { session }, error: null });
  });

  it('is the address the server config allows', () => {
    expect(authCallbackLink()).toBe(CALLBACK);
  });

  it('restoring with Google asks Supabase to return to it, waits for it, and exchanges the code once', async () => {
    const res = await accountApi.signInWithGoogle();
    expect(mocks.signInWithOAuth.mock.calls[0]![0].options.redirectTo).toBe(CALLBACK);
    expect(mocks.openAuthSessionAsync).toHaveBeenCalledWith('https://accounts.example/auth', CALLBACK);
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('one-time');
    expect(res).toEqual({ ok: true, value: { userId: 'user-1', accessToken: 'access', refreshToken: 'refresh' } });
  });

  it('linking Google returns to the same address', async () => {
    await accountApi.linkGoogle();
    expect(mocks.linkIdentity.mock.calls[0]![0].options.redirectTo).toBe(CALLBACK);
    expect(mocks.openAuthSessionAsync).toHaveBeenCalledWith('https://accounts.example/auth', CALLBACK);
  });

  it('a closed browser exchanges nothing', async () => {
    mocks.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const res = await accountApi.signInWithGoogle();
    expect(res).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
