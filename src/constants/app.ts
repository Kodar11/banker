/** Deep link scheme from app.json — QR codes encode businessbanker://join-game?code=123456 */
export const APP_SCHEME = 'businessbanker';

export function joinLink(code: string): string {
  return `${APP_SCHEME}://join-game?code=${code}`;
}

/** Extracts a 6-digit game code from a scanned QR value or typed text. */
export function parseJoinCode(value: string): string | null {
  const fromLink = /[?&]code=(\d{6})\b/.exec(value);
  if (fromLink?.[1]) return fromLink[1];
  const bare = /^\s*(\d{6})\s*$/.exec(value);
  return bare?.[1] ?? null;
}

/** Fallback refresh interval, used ONLY while the realtime channel is not live (never while healthy). */
export const POLL_MS_DEGRADED = 5_000;
