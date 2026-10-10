import { describe, expect, it } from 'vitest';
import { callbackParams, readAuthCallback } from '@/features/account/oauthCallback';

describe('Google sign-in redirect', () => {
  it('reads the one-time code from the query', () => {
    expect(readAuthCallback('businessbanker://auth-callback?code=abc-123')).toEqual({ ok: true, value: 'abc-123' });
  });

  it('reads parameters from the query and the fragment, decoded', () => {
    expect(callbackParams('businessbanker://auth-callback?a=1&b=two+words#c=%E2%9C%93&d')).toEqual({ a: '1', b: 'two words', c: String.fromCodePoint(0x2713), d: '' });
  });

  it('a Google account that belongs to another player is a conflict, never a session', () => {
    const res = readAuthCallback('businessbanker://auth-callback?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('IDENTITY_IN_USE');
    // An error wins even if a code is present.
    const both = readAuthCallback('businessbanker://auth-callback?code=abc&error_code=identity_already_exists');
    expect(both.ok).toBe(false);
  });

  it('denied consent is a cancellation; anything else is a failed sign-in', () => {
    const denied = readAuthCallback('businessbanker://auth-callback?error=access_denied&error_description=User+denied');
    expect(!denied.ok && denied.error.code).toBe('CANCELLED');
    const other = readAuthCallback('businessbanker://auth-callback#error=server_error&error_description=boom');
    expect(!other.ok && other.error.code).toBe('OAUTH');
    const disabled = readAuthCallback('businessbanker://auth-callback?error=invalid_request&error_code=provider_disabled');
    expect(!disabled.ok && disabled.error.code).toBe('GOOGLE_NOT_CONFIGURED');
    const empty = readAuthCallback('businessbanker://auth-callback');
    expect(!empty.ok && empty.error.code).toBe('OAUTH');
  });
});
