import type { VoiceAckResponse, VoiceGrantResponse, VoiceRequest, VoiceStatusResponse } from '@/engine/index.ts';
import { invoke, type Credentials } from './gameApi';

export const VOICE_FUNCTION_NAME = 'voice-token';

const call = <T extends { ok: boolean }>(op: VoiceRequest['op'], c: Credentials, extra: object = {}) =>
  invoke<T>({ op, gameId: c.gameId, playerId: c.playerId, token: c.token, ...extra }, undefined, VOICE_FUNCTION_NAME) as Promise<T>;

/**
 * Thin, typed wrapper around the voice-token Edge Function. Never throws. The seat's device token
 * is the only thing the app proves; whether voice is allowed, in which channel and as which uid is
 * the server's answer.
 */
export const voiceApi = {
  status: (c: Credentials) => call<VoiceStatusResponse>('status', c),
  /** Host only. */
  enable: (c: Credentials, enabled: boolean) => call<VoiceStatusResponse>('enable', c, { enabled }),
  join: (c: Credentials) => call<VoiceGrantResponse>('join', c),
  renew: (c: Credentials) => call<VoiceGrantResponse>('renew', c),
  heartbeat: (c: Credentials) => call<VoiceAckResponse>('heartbeat', c),
  leave: (c: Credentials) => call<VoiceAckResponse>('leave', c),
};

export type VoiceApi = typeof voiceApi;
