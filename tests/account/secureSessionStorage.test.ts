import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secureSessionStorage } from '@/lib/secureSessionStorage';

const keystore = vi.hoisted(() => ({ entries: new Map<string, string>(), failWritesMatching: null as RegExp | null }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => keystore.entries.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (keystore.failWritesMatching?.test(key)) throw new Error('keystore write failed');
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`invalid key ${key}`);
    if (new TextEncoder().encode(value).length > 2048) throw new Error('value too large');
    keystore.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => void keystore.entries.delete(key),
}));

const KEY = 'business-banker.auth.v1';
const cp = String.fromCodePoint;
const bigSession = (seed: string) => JSON.stringify({ access_token: seed.repeat(900), refresh_token: 'r', user: { name: `Zo${cp(0xeb)} ${cp(0x1f3b2)} ${cp(0x924)}` } });

describe('secure session storage', () => {
  beforeEach(() => {
    keystore.entries.clear();
    keystore.failWritesMatching = null;
  });

  it('returns null for a key that was never written', async () => {
    expect(await secureSessionStorage.getItem(KEY)).toBeNull();
  });

  it('round-trips a session larger than one keystore entry, non-ASCII included', async () => {
    const value = bigSession('abcdef');
    expect(value.length).toBeGreaterThan(5000);
    await secureSessionStorage.setItem(KEY, value);
    expect(await secureSessionStorage.getItem(KEY)).toBe(value);
    expect(keystore.entries.size).toBeGreaterThan(3);
  });

  it('replacing a value leaves no pieces of the old one behind', async () => {
    await secureSessionStorage.setItem(KEY, bigSession('abcdef'));
    await secureSessionStorage.setItem(KEY, 'short');
    expect(await secureSessionStorage.getItem(KEY)).toBe('short');
    expect(keystore.entries.size).toBe(2); // pointer + one piece
    await secureSessionStorage.setItem(KEY, 'third');
    expect(await secureSessionStorage.getItem(KEY)).toBe('third');
    expect(keystore.entries.size).toBe(2);
  });

  it('a write that fails part-way keeps the previous session readable', async () => {
    const original = bigSession('abcdef');
    await secureSessionStorage.setItem(KEY, original);
    keystore.failWritesMatching = /\.[ab]\.2$/; // the third piece of the new value cannot be written
    await expect(secureSessionStorage.setItem(KEY, bigSession('uvwxyz'))).rejects.toThrow();
    keystore.failWritesMatching = null;
    expect(await secureSessionStorage.getItem(KEY)).toBe(original);
    // And the next write still works.
    await secureSessionStorage.setItem(KEY, 'next');
    expect(await secureSessionStorage.getItem(KEY)).toBe('next');
  });

  it('removes everything, and makes awkward keys safe', async () => {
    const key = 'sb-auth-token-code-verifier/abc:1';
    await secureSessionStorage.setItem(key, bigSession('q'));
    expect(await secureSessionStorage.getItem(key)).not.toBeNull();
    await secureSessionStorage.removeItem(key);
    expect(await secureSessionStorage.getItem(key)).toBeNull();
    expect(keystore.entries.size).toBe(0);
  });

  it('concurrent writes and reads never interleave', async () => {
    const values = ['one', bigSession('k'), 'three', bigSession('m')];
    const writes = values.map((v) => secureSessionStorage.setItem(KEY, v));
    const read = secureSessionStorage.getItem(KEY);
    await Promise.all(writes);
    expect(values).toContain(await read);
    expect(await secureSessionStorage.getItem(KEY)).toBe(values[3]);
  });
});
