// The one place the Agora App Certificate is used: signing an RTC token with Agora's own
// token library (AccessToken2). Runtime-agnostic (Deno in production, Node in tests).
import agoraToken from 'agora-token';

const { RtcTokenBuilder, RtcRole } = agoraToken;

/** Agora App IDs and certificates are 32 hex characters. Anything else is a configuration mistake. */
const HEX32 = /^[0-9a-f]{32}$/i;

/**
 * A signer for one Agora project, or null when the credentials are missing or malformed (voice
 * is then refused as "not configured" instead of handing out tokens that cannot work).
 */
export function createTokenBuilder(appId: string | undefined, certificate: string | undefined) {
  if (!appId || !certificate || !HEX32.test(appId) || !HEX32.test(certificate)) return undefined;
  // Everyone in a voice room may speak (push-to-talk decides when), so every token is a publisher's.
  // The token and its privileges expire together, `ttlSeconds` from now.
  return (channel: string, uid: number, ttlSeconds: number): string =>
    RtcTokenBuilder.buildTokenWithUid(appId, certificate, channel, uid, RtcRole.PUBLISHER, ttlSeconds, ttlSeconds);
}
