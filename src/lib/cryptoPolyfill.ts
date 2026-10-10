import * as Crypto from 'expo-crypto';

/**
 * Supabase Auth's PKCE flow reads the WebCrypto globals. Where React Native does not provide them
 * it would quietly fall back to Math.random and an un-hashed challenge, so the two functions it
 * uses are supplied from expo-crypto (the platform's secure random source and SHA-256).
 */
export function installCryptoPolyfill(): void {
  const scope = globalThis as { crypto?: { getRandomValues?: unknown; subtle?: { digest?: unknown } } };
  const crypto = scope.crypto ?? (scope.crypto = {});
  if (typeof crypto.getRandomValues !== 'function') {
    crypto.getRandomValues = <T extends Parameters<typeof Crypto.getRandomValues>[0]>(array: T): T => Crypto.getRandomValues(array);
  }
  if (typeof crypto.subtle?.digest !== 'function') {
    crypto.subtle = {
      ...crypto.subtle,
      digest: (algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() !== 'SHA-256') return Promise.reject(new Error(`Unsupported digest: ${name}`));
        return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data);
      },
    };
  }
}
