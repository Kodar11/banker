import * as SecureStore from 'expo-secure-store';

/**
 * Storage for the Supabase Auth session (access + refresh token), kept in the platform keystore
 * through expo-secure-store — never in plain storage.
 *
 * A session is larger than a keystore entry can reliably hold (about 2 KB on some iOS versions),
 * so a value is stored in pieces. A guest account's session is the ONLY way back into that
 * account, so a write must never be able to destroy the previous value:
 *
 *   1. the new pieces are written under the generation that is NOT in use ("a" or "b"),
 *   2. one small pointer entry is switched to it (the commit),
 *   3. the old generation is removed.
 *
 * If the app dies before step 2 the old value is still what is read back.
 */
const CHUNK_CHARS = 1800;

/** SecureStore keys may contain only letters, digits, ".", "-" and "_". */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function parsePointer(pointer: string | null): { generation: 'a' | 'b'; count: number } | null {
  const match = /^([ab]):(\d+)$/.exec(pointer ?? '');
  if (!match) return null;
  return { generation: match[1] as 'a' | 'b', count: Number(match[2]) };
}

const chunkKey = (key: string, generation: string, index: number) => `${key}.${generation}.${index}`;

async function removeGeneration(key: string, generation: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await SecureStore.deleteItemAsync(chunkKey(key, generation, i)).catch(() => undefined);
}

/** One operation at a time per key: a read never sees a half-finished write. */
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export const secureSessionStorage = {
  getItem(rawKey: string): Promise<string | null> {
    const key = safeKey(rawKey);
    return enqueue(key, async () => {
      const pointer = parsePointer(await SecureStore.getItemAsync(key));
      if (!pointer) return null;
      let encoded = '';
      for (let i = 0; i < pointer.count; i += 1) {
        const part = await SecureStore.getItemAsync(chunkKey(key, pointer.generation, i));
        if (part === null) return null;
        encoded += part;
      }
      try {
        return decodeURIComponent(encoded);
      } catch {
        return null;
      }
    });
  },

  setItem(rawKey: string, value: string): Promise<void> {
    const key = safeKey(rawKey);
    return enqueue(key, async () => {
      // Plain ASCII, so a piece can never end in the middle of a character.
      const encoded = encodeURIComponent(value);
      const current = parsePointer(await SecureStore.getItemAsync(key));
      const generation = current?.generation === 'a' ? 'b' : 'a';
      const count = Math.max(1, Math.ceil(encoded.length / CHUNK_CHARS));
      for (let i = 0; i < count; i += 1) {
        await SecureStore.setItemAsync(chunkKey(key, generation, i), encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
      }
      await SecureStore.setItemAsync(key, `${generation}:${count}`);
      if (current) await removeGeneration(key, current.generation, current.count);
    });
  },

  removeItem(rawKey: string): Promise<void> {
    const key = safeKey(rawKey);
    return enqueue(key, async () => {
      const current = parsePointer(await SecureStore.getItemAsync(key));
      await SecureStore.deleteItemAsync(key);
      if (current) await removeGeneration(key, current.generation, current.count);
    });
  },
};
