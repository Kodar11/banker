import * as Crypto from 'expo-crypto';

/** New idempotency key for one user intent (one tap). */
export function newActionId(): string {
  return Crypto.randomUUID();
}

/** 32 random bytes as hex. Identifies this device as a player; only its hash is stored server-side. */
export function newPlayerToken(): string {
  return Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
}
