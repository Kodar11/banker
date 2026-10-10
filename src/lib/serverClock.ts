/**
 * This phone's estimate of the server's clock — the one clock every auction deadline is on.
 *
 * Each referee response carries the server's time. Measured against when the request left and
 * the response arrived (not when React got round to rendering it), that gives the offset between
 * the two clocks to within half the round trip. The tightest recent sample wins, so one slow
 * response can't skew the countdown. Display only: the server alone decides what is on time.
 */

interface Sample {
  /** Server clock minus this phone's clock, ms. */
  offset: number;
  /** Round trip of the request that produced it, ms: the offset is right to within ± half of this. */
  rtt: number;
  at: number;
}

/** A sample older than this no longer outranks a fresh one (phone clocks drift and get corrected). */
const SAMPLE_MAX_AGE_MS = 60_000;

let best: Sample | null = null;

/** Feed one response: the server time it carried, and this phone's clock when the request left and when the response arrived. */
export function recordServerTime(serverTime: string, sentAt: number, receivedAt: number): void {
  const server = Date.parse(serverTime);
  const rtt = receivedAt - sentAt;
  if (!Number.isFinite(server) || rtt < 0) return;
  // The server stamps its time as it finishes; the response then travels for about half the round trip.
  const sample: Sample = { offset: server + rtt / 2 - receivedAt, rtt, at: receivedAt };
  const stale = best !== null && receivedAt - best.at > SAMPLE_MAX_AGE_MS;
  // Disagreeing by more than both error bars means the phone's clock was changed: start over.
  const jumped = best !== null && Math.abs(sample.offset - best.offset) > (sample.rtt + best.rtt) / 2;
  if (best === null || stale || jumped || sample.rtt <= best.rtt) best = sample;
}

/** Current time on the server's clock, ms. Falls back to the phone's clock until the first response. */
export function serverNow(): number {
  return Date.now() + (best?.offset ?? 0);
}

export function resetServerClock(): void {
  best = null;
}
