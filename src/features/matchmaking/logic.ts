import { GAME_MODE_LABELS, type GameMode } from '@/engine/index.ts';
import type { LastResult, MatchmakingState, Party } from './types';

/**
 * The rules of the Play Online screens that need no server: which screen the server's answer
 * means, what is stopping a search from starting, how a countdown and a wait read, and how long to
 * back off after a failed request. Pure functions, unit-tested (tests/matchmaking/logic.test.ts).
 * None of it decides anything the server decides.
 */

/**
 *  entry      nothing going on: choose a mode, play solo or gather friends
 *  party      in a party that is not queued
 *  searching  a ticket is in the queue
 *  matchFound a match is reserved: confirm before the server's deadline
 *  starting   everyone confirmed (or the game exists): the server is starting the game
 */
export type PlayOnlinePhase = 'entry' | 'party' | 'searching' | 'matchFound' | 'starting';

/** Which screen an answer means. Derived from the whole answer, never from the order events arrived in. */
export function phaseOf(state: MatchmakingState | null): PlayOnlinePhase {
  if (!state) return 'entry';
  if (state.game) return 'starting';
  if (state.match && state.ticket?.status === 'RESERVED') return state.match.status === 'READY_UP' ? 'matchFound' : 'starting';
  if (state.ticket) return 'searching';
  return state.party ? 'party' : 'entry';
}

/** A fetched answer replaces the one on screen unless it is older (a slow response overtaken by a newer one). */
export function shouldApply(current: MatchmakingState | null, incoming: MatchmakingState): boolean {
  return !current || incoming.version >= current.version;
}

/** Realtime (or a heartbeat) announced `version`: is the phone behind? An event without one always means "look". */
export function isBehind(current: MatchmakingState | null, version: number): boolean {
  if (!current) return true;
  return !Number.isFinite(version) || version > current.version;
}

/** Whole seconds until `deadline` on the server's clock; 0 once it has passed or cannot be read. */
export function secondsLeft(deadline: string | number, serverNowMs: number): number {
  const at = typeof deadline === 'number' ? deadline : Date.parse(deadline);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - serverNowMs) / 1000));
}

/** Whole seconds since `since` on the server's clock (never negative). */
export function secondsSince(since: string, serverNowMs: number): number {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((serverNowMs - at) / 1000));
}

/** 0:07, 1:32, 12:05. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What the queue is doing for a player who has waited `waited` seconds — the policy, in words. */
export function searchHint(waited: number, players: number, settings: MatchmakingState['settings']): string {
  if (players >= settings.maxPlayers) return 'Your party fills a table — starting as soon as everyone confirms.';
  if (waited < settings.preferTargetSeconds) return `Looking for a table of ${players > settings.targetPlayers ? settings.maxPlayers : settings.targetPlayers}.`;
  if (waited < settings.relaxSeconds) return 'Taking any table of two or more players now.';
  return players >= settings.targetPlayers ? 'Starting with the players available.' : 'Still looking — you’ll be matched as soon as another player arrives.';
}

export interface StartBlocker {
  code: 'LOADING' | 'DISABLED' | 'COOLDOWN' | 'IN_GAME' | 'IN_LOBBY' | 'NOT_LEADER' | 'PARTY_NOT_READY' | 'MEMBER_OFFLINE' | 'PARTY_TOO_LARGE';
  message: string;
}

/**
 * Why matchmaking cannot start right now, in the order a player would want to hear it; null when it
 * can. The server checks all of this again (and more): this only keeps the button honest.
 * `deviceLobby` — this phone still sits in a game it joined by code (which the account may not know of).
 */
export function startBlocker(state: MatchmakingState | null, serverNowMs: number, deviceLobby: 'WAITING' | 'ACTIVE' | 'PAUSED' | null): StartBlocker | null {
  if (!state) return { code: 'LOADING', message: 'Loading your online status…' };
  if (!state.settings.enabled) return { code: 'DISABLED', message: 'Online matchmaking is closed for maintenance. Please try again soon.' };
  const live = state.liveGame?.status ?? deviceLobby;
  if (live === 'WAITING') return { code: 'IN_LOBBY', message: 'You’re in a private lobby. Leave it before playing online.' };
  if (live) return { code: 'IN_GAME', message: 'You’re already in a game. Finish or leave it before playing online.' };
  const wait = secondsLeft(state.cooldownUntilMs, serverNowMs);
  if (state.cooldownUntilMs > 0 && wait > 0) {
    return { code: 'COOLDOWN', message: `You missed a match. You can search again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.` };
  }
  const party = state.party;
  if (party) {
    if (party.members.length > state.settings.partyMaxMembers) return { code: 'PARTY_TOO_LARGE', message: `A party can have at most ${state.settings.partyMaxMembers} players.` };
    if (!party.isLeader) return { code: 'NOT_LEADER', message: 'Only the party leader can start matchmaking.' };
    const waiting = unreadyMembers(party);
    if (waiting.length) return { code: 'PARTY_NOT_READY', message: `Waiting for ${listNames(waiting)} to be ready.` };
    const away = party.members.filter((m) => !m.isMe && !m.online).map((m) => m.nickname);
    if (away.length) return { code: 'MEMBER_OFFLINE', message: `${listNames(away)} ${away.length === 1 ? 'isn’t' : 'aren’t'} connected right now.` };
  }
  return null;
}

/** Members (other than the leader) who have not confirmed. */
export function unreadyMembers(party: Party): string[] {
  return party.members.filter((m) => !m.ready && !m.isLeader).map((m) => m.nickname);
}

/** "Asha", "Asha and Bilal", "Asha, Bilal and 2 others". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** What to tell a player whose search ended without a game; null when there is nothing to say (they stopped it themselves). */
export function resultMessage(result: LastResult | null): { kind: 'error' | 'info'; message: string } | null {
  if (!result || result.status === 'MATCHED') return null;
  switch (result.reason) {
    case 'CANCELLED_BY_PLAYER':
      return null;
    case 'READY_TIMEOUT':
      return { kind: 'error', message: 'Ready-up timed out: a match was found but not everyone in your group confirmed in time.' };
    case 'DECLINED':
      return { kind: 'info', message: 'Match declined. Your search has stopped.' };
    case 'DISCONNECTED':
      return { kind: 'error', message: 'You were disconnected for too long, so your search was stopped. Start it again when you’re ready.' };
    case 'JOINED_GAME':
    case 'IN_GAME':
      return { kind: 'info', message: 'Your search was stopped because you joined another game.' };
    case 'ABANDONED':
    case 'PLAYER_LEFT':
      return { kind: 'info', message: 'Your search was stopped because a player left.' };
    default:
      return { kind: 'error', message: 'Your search was stopped by the server. Please start it again.' };
  }
}

/** "Classic · 3 players". */
export function ticketSummary(mode: GameMode, players: number): string {
  return `${GAME_MODE_LABELS[mode]} · ${players === 1 ? 'Solo' : `${players} players`}`;
}

/**
 * How long to wait before the next heartbeat after `failures` in a row: the normal interval while
 * things work, then doubling up to a cap, with jitter so phones that lost the server together do
 * not all come back in the same instant. `random` is injected (0..1).
 */
export function nextHeartbeatMs(heartbeatSeconds: number, failures: number, random: number): number {
  const base = Math.max(3, heartbeatSeconds) * 1000;
  if (failures <= 0) return Math.round(base * (0.9 + 0.2 * random));
  const backoff = Math.min(60_000, base * 2 ** Math.min(failures, 6));
  return Math.round(backoff * (0.5 + 0.5 * random));
}

/** Ids in `ids` that were not announced yet; marks them as announced. */
export function takeNew(ids: readonly string[], announced: Set<string>): string[] {
  const fresh = ids.filter((id) => !announced.has(id));
  fresh.forEach((id) => announced.add(id));
  return fresh;
}
