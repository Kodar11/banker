import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerToken, handleDeleteAccount, REAUTH_WINDOW_MS, type AuthUser, type DeleteAccountDeps } from '../../supabase/functions/delete-account/handler.ts';

const NOW = new Date('2026-10-11T10:00:00.000Z');
const guest: AuthUser = { id: 'user-guest', hasGoogle: false, lastSignInAt: '2026-09-01T00:00:00.000Z' };
const linked = (minutesAgo: number): AuthUser => ({ id: 'user-linked', hasGoogle: true, lastSignInAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() });

describe('delete-account handler', () => {
  let users: Map<string, AuthUser>;
  const verifyUser = vi.fn<DeleteAccountDeps['verifyUser']>();
  const deleteUser = vi.fn<DeleteAccountDeps['deleteUser']>();
  const deps: DeleteAccountDeps = { now: () => NOW, verifyUser, deleteUser };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    users = new Map([
      ['token-guest', guest],
      ['token-linked-fresh', linked(2)],
      ['token-linked-stale', linked(REAUTH_WINDOW_MS / 60_000 + 1)],
    ]);
    verifyUser.mockReset().mockImplementation(async (token) => users.get(token) ?? null);
    deleteUser.mockReset().mockImplementation(async (id) => {
      const entry = [...users.entries()].find(([, u]) => u.id === id);
      if (!entry) return 'not_found';
      users.delete(entry[0]);
      return 'deleted';
    });
  });

  const call = (authorization: string | null, body: unknown = { confirm: 'DELETE' }) => handleDeleteAccount(authorization, body, deps);

  it('reads only a well-formed bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer abc')).toBe('abc');
    for (const bad of [null, undefined, '', 'abc', 'Basic abc', 'Bearer ', 'Bearer a b']) expect(bearerToken(bad)).toBeNull();
  });

  it('refuses a request without a token, without touching anything', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(verifyUser).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses a token Supabase Auth does not accept', async () => {
    const res = await call('Bearer forged');
    expect(res.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('requires the explicit confirmation word', async () => {
    for (const body of [null, {}, { confirm: 'delete' }, { confirm: true }, 'DELETE']) {
      const res = await call('Bearer token-guest', body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('deletes exactly the caller: an id in the body is ignored', async () => {
    const res = await call('Bearer token-guest', { confirm: 'DELETE', userId: 'user-linked', user_id: 'user-linked' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith('user-guest');
    expect(users.has('token-linked-fresh')).toBe(true);
  });

  it('a Google-linked account needs a recent Google sign-in', async () => {
    const stale = await call('Bearer token-linked-stale');
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ ok: false, error: { code: 'REAUTH_REQUIRED' } });
    expect(deleteUser).not.toHaveBeenCalled();

    users.set('token-linked-never', { id: 'user-x', hasGoogle: true, lastSignInAt: null });
    expect((await call('Bearer token-linked-never')).status).toBe(403);

    const fresh = await call('Bearer token-linked-fresh');
    expect(fresh).toEqual({ status: 200, body: { ok: true } });
    expect(deleteUser).toHaveBeenCalledWith('user-linked');
  });

  it('a retry after success finds no account and deletes nothing more', async () => {
    expect((await call('Bearer token-guest')).body.ok).toBe(true);
    const again = await call('Bearer token-guest');
    expect(again.status).toBe(401);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('an account already removed between the check and the delete still counts as deleted', async () => {
    deleteUser.mockResolvedValueOnce('not_found');
    expect(await call('Bearer token-guest')).toEqual({ status: 200, body: { ok: true } });
  });

  it('reports a failure — never success — when Auth cannot be reached or the delete fails', async () => {
    deleteUser.mockRejectedValueOnce(new Error('admin delete 500'));
    const failed = await call('Bearer token-guest');
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ ok: false, error: { code: 'SERVER_ERROR' } });
    // Nothing was half done: the same request succeeds afterwards.
    expect((await call('Bearer token-guest')).body.ok).toBe(true);

    verifyUser.mockRejectedValueOnce(new Error('auth user 503'));
    expect((await call('Bearer token-linked-fresh')).status).toBe(500);
  });
});
