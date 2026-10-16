/**
 * Seeded randomness for bots. A bot never calls Math.random: the same state, seat and seed always give the
 * same decision, so a retried server request recomputes exactly what it computed before. None of this
 * touches the game's own dice or draws — those come from the engine's RNG on the server.
 */

/** mulberry32: small, fast, and identical on every runtime. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: a stable 32-bit hash of a string. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combines a seed with more context into a new seed. */
export function mixSeed(seed: number, ...parts: (string | number)[]): number {
  return hashString(`${seed >>> 0}|${parts.join('|')}`);
}

/** The seed of one bot seat in one game. */
export function seatSeed(gameId: string, playerId: string): number {
  return hashString(`${gameId}:${playerId}`);
}

/** A fixed value in [-1, 1) for this seed and key: Easy's per-property estimation error. */
export function fixedJitter(seed: number, key: string): number {
  return prng(mixSeed(seed, 'jitter', key))() * 2 - 1;
}
