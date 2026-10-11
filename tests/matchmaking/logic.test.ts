import { describe, expect, it } from 'vitest';
import {
  formatClock,
  isBehind,
  listNames,
  nextHeartbeatMs,
  phaseOf,
  resultMessage,
  searchHint,
  secondsLeft,
  secondsSince,
  shouldApply,
  startBlocker,
  takeNew,
  ticketSummary,
  unreadyMembers,
} from '@/features/matchmaking/logic';
import { toMatchmakingState, type MatchmakingState, type Party } from '@/features/matchmaking/types';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const SETTINGS: MatchmakingState['settings'] = {
  enabled: true,
  readySeconds: 20,
  heartbeatSeconds: 10,
  preferTargetSeconds: 30,
  relaxSeconds: 60,
  targetPlayers: 4,
  minPlayers: 2,
  maxPlayers: 8,
  partyMaxMembers: 8,
};

const base = (overrides: Partial<MatchmakingState> = {}): MatchmakingState => ({
  version: 5,
  serverTime: iso(0),
  settings: SETTINGS,
  cooldownUntilMs: 0,
  liveGame: null,
  party: null,
  partyInvites: [],
  ticket: null,
  match: null,
  game: null,
  lastResult: null,
  ...overrides,
});

const TICKET = { id: 't', kind: 'solo' as const, mode: 'classic' as const, playerCount: 1, status: 'QUEUED' as const, queuedAt: iso(-5000), requeueCount: 0 };
const MATCH = { id: 'm', mode: 'classic' as const, status: 'READY_UP' as const, playerCount: 2, readyDeadline: iso(15_000), players: [] };
const party = (overrides: Partial<Party> = {}): Party => ({
  id: 'p',
  mode: 'classic',
  isLeader: true,
  locked: false,
  members: [
    { playerId: 'RR-22222M', nickname: 'Me', isLeader: true, isMe: true, ready: true, online: true },
    { playerId: 'RR-AAAAA2', nickname: 'Asha', isLeader: false, isMe: false, ready: true, online: true },
  ],
  invites: [],
  ...overrides,
});

describe('which screen an answer means', () => {
  it('is decided by the whole answer, whatever order the events came in', () => {
    expect(phaseOf(null)).toBe('entry');
    expect(phaseOf(base())).toBe('entry');
    expect(phaseOf(base({ party: party() }))).toBe('party');
    expect(phaseOf(base({ ticket: TICKET }))).toBe('searching');
    expect(phaseOf(base({ ticket: TICKET, party: party({ locked: true }) }))).toBe('searching');
    expect(phaseOf(base({ ticket: { ...TICKET, status: 'RESERVED' }, match: MATCH }))).toBe('matchFound');
    expect(phaseOf(base({ ticket: { ...TICKET, status: 'RESERVED' }, match: { ...MATCH, status: 'STARTING' } }))).toBe('starting');
    // The game exists: that wins over anything else still in the answer.
    expect(phaseOf(base({ game: { matchId: 'm', gameId: 'g', seatId: 's', mode: 'classic' }, party: party() }))).toBe('starting');
  });

  it('never shows "match found" for a match the ticket is not reserved in', () => {
    expect(phaseOf(base({ ticket: TICKET, match: MATCH }))).toBe('searching');
    expect(phaseOf(base({ match: MATCH }))).toBe('entry');
  });
});

describe('versions', () => {
  it('a newer or equal answer is applied; an older one that arrives late is not', () => {
    expect(shouldApply(null, base())).toBe(true);
    expect(shouldApply(base({ version: 5 }), base({ version: 6 }))).toBe(true);
    expect(shouldApply(base({ version: 5 }), base({ version: 5 }))).toBe(true);
    expect(shouldApply(base({ version: 5 }), base({ version: 4 }))).toBe(false);
  });

  it('a ping means "refetch" only when it announces something newer, or carries no version', () => {
    expect(isBehind(null, 1)).toBe(true);
    expect(isBehind(base({ version: 5 }), 5)).toBe(false);
    expect(isBehind(base({ version: 5 }), 4)).toBe(false);
    expect(isBehind(base({ version: 5 }), 6)).toBe(true);
    expect(isBehind(base({ version: 5 }), Number.NaN)).toBe(true);
  });
});

describe('clocks', () => {
  it('counts down to the server’s deadline and stops at zero', () => {
    expect(secondsLeft(iso(15_000), NOW)).toBe(15);
    expect(secondsLeft(iso(14_001), NOW)).toBe(15);
    expect(secondsLeft(iso(1), NOW)).toBe(1);
    expect(secondsLeft(iso(0), NOW)).toBe(0);
    expect(secondsLeft(iso(-5000), NOW)).toBe(0);
    expect(secondsLeft('not a date', NOW)).toBe(0);
    expect(secondsLeft(NOW + 2500, NOW)).toBe(3);
  });

  it('counts up from when the search began', () => {
    expect(secondsSince(iso(-65_400), NOW)).toBe(65);
    expect(secondsSince(iso(5000), NOW)).toBe(0);
    expect(secondsSince('', NOW)).toBe(0);
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(725)).toBe('12:05');
    expect(formatClock(-3)).toBe('0:00');
  });

  it('describes what the queue is doing, by the server’s thresholds', () => {
    expect(searchHint(5, 1, SETTINGS)).toMatch(/table of 4/);
    expect(searchHint(5, 5, SETTINGS)).toMatch(/table of 8/);
    expect(searchHint(35, 1, SETTINGS)).toMatch(/two or more/);
    expect(searchHint(70, 1, SETTINGS)).toMatch(/another player arrives/);
    expect(searchHint(70, 5, SETTINGS)).toMatch(/players available/);
    expect(searchHint(0, 8, SETTINGS)).toMatch(/fills a table/);
    // Thresholds changed on the server change the words without an app release.
    expect(searchHint(12, 1, { ...SETTINGS, preferTargetSeconds: 10 })).toMatch(/two or more/);
  });
});

describe('why matchmaking cannot start', () => {
  it('nothing in the way: null', () => {
    expect(startBlocker(base(), NOW, null)).toBeNull();
    expect(startBlocker(base({ party: party() }), NOW, null)).toBeNull();
  });

  it('names the first thing in the way, in the order a player needs to hear it', () => {
    expect(startBlocker(null, NOW, null)?.code).toBe('LOADING');
    expect(startBlocker(base({ settings: { ...SETTINGS, enabled: false } }), NOW, 'ACTIVE')?.code).toBe('DISABLED');
    expect(startBlocker(base({ liveGame: { gameId: 'g', status: 'ACTIVE', matchmade: true } }), NOW, null)?.code).toBe('IN_GAME');
    expect(startBlocker(base({ liveGame: { gameId: 'g', status: 'PAUSED', matchmade: false } }), NOW, null)?.code).toBe('IN_GAME');
    expect(startBlocker(base({ liveGame: { gameId: 'g', status: 'WAITING', matchmade: false } }), NOW, null)?.code).toBe('IN_LOBBY');
    // A game only this phone knows of (joined by code, seat never tied to the account) counts too.
    expect(startBlocker(base(), NOW, 'WAITING')?.code).toBe('IN_LOBBY');
    expect(startBlocker(base(), NOW, 'ACTIVE')?.code).toBe('IN_GAME');
    expect(startBlocker(base({ cooldownUntilMs: NOW + 12_000, liveGame: { gameId: 'g', status: 'ACTIVE', matchmade: true } }), NOW, null)?.code).toBe('IN_GAME');
  });

  it('a cooldown counts down and then is gone', () => {
    const cooling = base({ cooldownUntilMs: NOW + 12_000 });
    expect(startBlocker(cooling, NOW, null)).toEqual({ code: 'COOLDOWN', message: 'You missed a match. You can search again in 12 seconds.' });
    expect(startBlocker(cooling, NOW + 11_000, null)?.message).toMatch(/in 1 second\./);
    expect(startBlocker(cooling, NOW + 12_000, null)).toBeNull();
  });

  it('a party: only the leader starts, everyone must be ready and connected', () => {
    const notLeader = party({ isLeader: false });
    expect(startBlocker(base({ party: notLeader }), NOW, null)?.code).toBe('NOT_LEADER');
    const unready = party({ members: [party().members[0]!, { ...party().members[1]!, ready: false }] });
    expect(startBlocker(base({ party: unready }), NOW, null)).toEqual({ code: 'PARTY_NOT_READY', message: 'Waiting for Asha to be ready.' });
    expect(unreadyMembers(unready)).toEqual(['Asha']);
    const away = party({ members: [party().members[0]!, { ...party().members[1]!, online: false }] });
    expect(startBlocker(base({ party: away }), NOW, null)?.code).toBe('MEMBER_OFFLINE');
    const crowd = party({ members: Array.from({ length: 9 }, (_, i) => ({ ...party().members[1]!, playerId: `RR-AAAA${i + 2}2`, isMe: i === 0, isLeader: i === 0 })) });
    expect(startBlocker(base({ party: crowd }), NOW, null)?.code).toBe('PARTY_TOO_LARGE');
  });

  it('lists names readably', () => {
    expect(listNames(['Asha'])).toBe('Asha');
    expect(listNames(['Asha', 'Bilal'])).toBe('Asha and Bilal');
    expect(listNames(['Asha', 'Bilal', 'Chitra'])).toBe('Asha, Bilal and Chitra');
    expect(listNames(['Asha', 'Bilal', 'Chitra', 'Dev', 'Esha'])).toBe('Asha, Bilal and 3 others');
  });
});

describe('messages', () => {
  const result = (reason: string | null, status: 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'MATCHED' = 'CANCELLED') => ({ ticketId: 't', status, reason, at: iso(0) });

  it('explains every way a search can end without a game — and says nothing when the player stopped it', () => {
    expect(resultMessage(null)).toBeNull();
    expect(resultMessage(result('MATCHED', 'MATCHED'))).toBeNull();
    expect(resultMessage(result('CANCELLED_BY_PLAYER'))).toBeNull();
    expect(resultMessage(result('READY_TIMEOUT'))).toMatchObject({ kind: 'error', message: expect.stringMatching(/Ready-up timed out/) });
    expect(resultMessage(result('DECLINED'))?.message).toMatch(/declined/i);
    expect(resultMessage(result('DISCONNECTED', 'EXPIRED'))?.message).toMatch(/disconnected/);
    expect(resultMessage(result('JOINED_GAME'))?.message).toMatch(/joined another game/);
    expect(resultMessage(result('IN_GAME'))?.message).toMatch(/joined another game/);
    expect(resultMessage(result('PLAYER_LEFT'))?.message).toMatch(/a player left/);
    expect(resultMessage(result('ORPHANED', 'FAILED'))?.message).toMatch(/stopped by the server/);
    expect(resultMessage(result(null, 'FAILED'))?.message).toMatch(/stopped by the server/);
  });

  it('never shows a server code to the player', () => {
    for (const reason of ['READY_TIMEOUT', 'DECLINED', 'DISCONNECTED', 'JOINED_GAME', 'ABANDONED', 'SOMETHING_NEW']) {
      expect(resultMessage(result(reason))?.message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('summarises a ticket', () => {
    expect(ticketSummary('classic', 1)).toBe('Classic · Solo');
    expect(ticketSummary('intermediate', 5)).toBe('Intermediate · 5 players');
  });
});

describe('heartbeat pacing', () => {
  it('keeps the server’s interval while things work, with a little jitter', () => {
    expect(nextHeartbeatMs(10, 0, 0)).toBe(9000);
    expect(nextHeartbeatMs(10, 0, 0.5)).toBe(10_000);
    expect(nextHeartbeatMs(10, 0, 1)).toBe(11_000);
    // Never a tight loop, whatever the server sends.
    expect(nextHeartbeatMs(0, 0, 0)).toBe(2700);
  });

  it('backs off exponentially after failures, with jitter, up to a cap', () => {
    const waits = [1, 2, 3, 4, 5, 6, 10, 50].map((failures) => nextHeartbeatMs(10, failures, 1));
    expect(waits).toEqual([20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(nextHeartbeatMs(10, 1, 0)).toBe(10_000);
    expect(nextHeartbeatMs(10, 6, 0)).toBe(30_000);
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const wait = nextHeartbeatMs(10, 3, random);
      expect(wait).toBeGreaterThanOrEqual(30_000);
      expect(wait).toBeLessThanOrEqual(60_000);
    }
  });
});

describe('announcing once', () => {
  it('returns only what was not announced before', () => {
    const announced = new Set<string>();
    expect(takeNew(['a', 'b'], announced)).toEqual(['a', 'b']);
    expect(takeNew(['a', 'b'], announced)).toEqual([]);
    expect(takeNew(['b', 'c'], announced)).toEqual(['c']);
  });
});

describe('the server’s answer is checked before anything is shown', () => {
  const raw = () => ({
    ok: true,
    version: '7',
    server_time: iso(0),
    settings: { enabled: true, ready_seconds: 20, heartbeat_seconds: 10, prefer_target_seconds: 30, relax_seconds: 60, target_players: 4, min_players: 2, max_players: 8, party_max_members: 8 },
    cooldown_seconds: 12,
    live_game: null,
    party: {
      id: 'p',
      mode: 'intermediate',
      is_leader: false,
      locked: true,
      members: [{ player_id: 'RR-22222M', nickname: 'Me', is_leader: false, is_me: true, ready: true, online: true }],
      invites: [{ id: 'i', player_id: 'RR-AAAAA2', nickname: 'Asha', expires_at: iso(60_000) }],
    },
    party_invites: [{ id: 'pi', mode: 'classic', size: 2, inviter: { player_id: 'RR-BBBBB2', nickname: 'Bilal' }, expires_at: iso(60_000) }],
    ticket: { id: 't', kind: 'party', mode: 'intermediate', player_count: 1, status: 'RESERVED', queued_at: iso(-9000), requeue_count: 1, match_id: 'm' },
    match: {
      id: 'm',
      mode: 'intermediate',
      status: 'READY_UP',
      player_count: 2,
      ready_deadline: iso(15_000),
      players: [
        { player_id: 'RR-22222M', nickname: 'Me', group: 1, party: false, ready: false, is_me: true },
        { player_id: 'RR-BBBBB2', nickname: 'Bilal', group: 2, party: false, ready: true, is_me: false },
      ],
    },
    game: null,
    last_result: { ticket_id: 'old', status: 'CANCELLED', reason: 'READY_TIMEOUT', at: iso(-30_000), mode: 'classic' },
  });

  it('maps a complete answer', () => {
    const state = toMatchmakingState(raw())!;
    expect(state.version).toBe(7);
    expect(state.cooldownUntilMs).toBe(NOW + 12_000);
    expect(state.party).toMatchObject({ mode: 'intermediate', isLeader: false, locked: true });
    expect(state.party!.invites[0]).toEqual({ id: 'i', playerId: 'RR-AAAAA2', nickname: 'Asha', expiresAt: iso(60_000) });
    expect(state.partyInvites[0]).toMatchObject({ id: 'pi', size: 2, inviter: { playerId: 'RR-BBBBB2', nickname: 'Bilal' } });
    expect(state.ticket).toMatchObject({ kind: 'party', status: 'RESERVED', requeueCount: 1 });
    expect(state.match!.players.map((p) => [p.nickname, p.ready, p.isMe])).toEqual([['Me', false, true], ['Bilal', true, false]]);
    expect(state.lastResult).toEqual({ ticketId: 'old', status: 'CANCELLED', reason: 'READY_TIMEOUT', at: iso(-30_000) });
    expect(phaseOf(state)).toBe('matchFound');
  });

  it('no cooldown is "free to queue", and a too-short heartbeat is kept sane', () => {
    const state = toMatchmakingState({ ...raw(), cooldown_seconds: 0, settings: { ...raw().settings, heartbeat_seconds: 0 } })!;
    expect(state.cooldownUntilMs).toBe(0);
    expect(state.settings.heartbeatSeconds).toBe(3);
  });

  it('an answer this version cannot read shows nothing rather than something wrong', () => {
    expect(toMatchmakingState(null)).toBeNull();
    expect(toMatchmakingState({ ok: true })).toBeNull();
    expect(toMatchmakingState({ ...raw(), ticket: { ...raw().ticket, status: 'TELEPORTED' } })).toBeNull();
    expect(toMatchmakingState({ ...raw(), match: { ...raw().match, players: [{ player_id: 'not-an-id', nickname: 'X', group: 1, party: false, ready: false, is_me: false }] } })).toBeNull();
    expect(toMatchmakingState({ ...raw(), settings: { enabled: 'yes' } })).toBeNull();
  });

  it('carries nothing but public profiles: no field for an account id, an email or a token', () => {
    const text = JSON.stringify(toMatchmakingState({ ...raw(), match: { ...raw().match, players: raw().match.players.map((p) => ({ ...p, user_id: 'secret-user', token_hash: 'f'.repeat(64) })) } }));
    expect(text).not.toContain('secret-user');
    expect(text).not.toMatch(/f{64}/);
  });
});
