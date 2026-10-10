import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES } from '@/engine/index.ts';
import {
  badgesOf,
  checkPlayerId,
  friendActionOf,
  gameShareMessage,
  inviteStateAt,
  inviteTimeLeft,
  isBehind,
  isExpired,
  liveRequests,
  lobbyClosedReason,
  normalizePlayerId,
  notificationText,
  PRESENCE_OFFLINE_GRACE_MS,
  presenceStatusOf,
  relationshipOf,
  shouldApply,
  takeUnannounced,
} from '@/features/social/logic';
import { toSeatProfiles, toSocialState, type SeatProfile, type SocialNotification, type SocialState } from '@/features/social/types';
import { TestGame } from '../engine/harness.ts';

const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const DAY = 86_400_000;

const ME = 'RR-22222M';
const FRIEND = 'RR-FFFFF2';
const ASKED = 'RR-AAAAA2';
const ASKING = 'RR-BBBBB2';
const BLOCKED = 'RR-CCCCC2';
const STRANGER = 'RR-DDDDD2';

/** A server answer (public.social_state), as JSON. */
function serverState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    version: 7,
    server_time: at(0),
    me: { player_id: ME, presence_key: 'key-me' },
    friends: [{ player_id: FRIEND, nickname: 'Farah', presence_key: 'key-farah', since: at(-DAY) }],
    incoming: [{ id: 'req-in', player_id: ASKING, nickname: 'Bilal', created_at: at(-DAY), expires_at: at(29 * DAY) }],
    outgoing: [{ id: 'req-out', player_id: ASKED, nickname: 'Asha', created_at: at(-DAY), expires_at: at(29 * DAY) }],
    blocked: [{ player_id: BLOCKED, nickname: 'Chitra' }],
    invites: [
      { id: 'inv-1', state: 'open', mode: 'classic', players: 2, capacity: 8, inviter: { player_id: FRIEND, nickname: 'Farah' }, created_at: at(-MINUTE), expires_at: at(14 * MINUTE) },
    ],
    sent_invites: [],
    notifications: [],
    unread: 0,
    ...overrides,
  };
}

const state = (overrides: Record<string, unknown> = {}): SocialState => {
  const parsed = toSocialState(serverState(overrides));
  if (!parsed) throw new Error('fixture does not parse');
  return parsed;
};

describe('Player ID input', () => {
  it('trims, upper-cases, drops spaces and adds a missing dash', () => {
    expect(normalizePlayerId('RR-7K4P9X')).toBe('RR-7K4P9X');
    expect(normalizePlayerId('  rr-7k4p9x  ')).toBe('RR-7K4P9X');
    expect(normalizePlayerId('rr7k4p9x')).toBe('RR-7K4P9X');
    expect(normalizePlayerId('RR - 7K4 P9X')).toBe('RR-7K4P9X');
    expect(normalizePlayerId('\tRR-7K4P9X\n')).toBe('RR-7K4P9X');
  });

  it('rejects anything that is not a Player ID', () => {
    // 0, 1, I and O are not in the alphabet.
    for (const bad of ['', '   ', 'RR-', 'RR-7K4P9', 'RR-7K4P9XX', 'RR-7K4P90', 'RR-7K4P91', 'RR-7K4P9I', 'RR-7K4P9O', 'XX-7K4P9X', 'RR_7K4P9X', '7K4P9X', 'RR--7K4P9X', "RR-7K4P9X'--"]) {
      expect(normalizePlayerId(bad), bad).toBeNull();
    }
  });

  it('tells empty from malformed', () => {
    expect(checkPlayerId('')).toEqual({ ok: false, problem: 'EMPTY' });
    expect(checkPlayerId('   ')).toEqual({ ok: false, problem: 'EMPTY' });
    expect(checkPlayerId('hello')).toEqual({ ok: false, problem: 'MALFORMED' });
    expect(checkPlayerId(' rr7k4p9x ')).toEqual({ ok: true, playerId: 'RR-7K4P9X' });
  });
});

describe('the server answer is checked before it is used', () => {
  it('parses a complete answer', () => {
    const s = state();
    expect(s.version).toBe(7);
    expect(s.me).toEqual({ playerId: ME, presenceKey: 'key-me' });
    expect(s.friends[0]).toEqual({ playerId: FRIEND, nickname: 'Farah', presenceKey: 'key-farah', since: at(-DAY) });
    expect(s.invites[0]).toMatchObject({ id: 'inv-1', state: 'open', mode: 'classic', players: 2, capacity: 8, inviter: { playerId: FRIEND, nickname: 'Farah' } });
  });

  it('refuses an answer with a malformed Player ID, an unknown state or a missing list', () => {
    expect(toSocialState(serverState({ friends: [{ player_id: 'someone@example.com', nickname: 'x', presence_key: 'k', since: at(0) }] }))).toBeNull();
    expect(toSocialState(serverState({ invites: [{ ...(serverState().invites as object[])[0], state: 'maybe' }] }))).toBeNull();
    const { incoming: _dropped, ...partial } = serverState();
    expect(toSocialState(partial)).toBeNull();
    expect(toSocialState(null)).toBeNull();
  });

  it('a seat whose player may not be shown is unavailable and carries no identity', () => {
    expect(
      toSeatProfiles([
        { seat_id: 's1', unavailable: false, player_id: FRIEND, nickname: 'Farah' },
        { seat_id: 's2', unavailable: true },
        { seat_id: 's3', unavailable: true, player_id: STRANGER, nickname: 'Leaky' },
      ]),
    ).toEqual([
      { seatId: 's1', unavailable: false, player: { playerId: FRIEND, nickname: 'Farah' } },
      { seatId: 's2', unavailable: true, player: null },
      { seatId: 's3', unavailable: true, player: null },
    ]);
    expect(toSeatProfiles([{ seat_id: 's1', unavailable: false, player_id: 'not-an-id' }])).toBeNull();
  });
});

describe('relationship and request state', () => {
  it('reads how I stand with a player from the server lists', () => {
    const s = state();
    expect(relationshipOf(s, ME, NOW)).toBe('self');
    expect(relationshipOf(s, FRIEND, NOW)).toBe('friends');
    expect(relationshipOf(s, ASKED, NOW)).toBe('outgoing');
    expect(relationshipOf(s, ASKING, NOW)).toBe('incoming');
    expect(relationshipOf(s, BLOCKED, NOW)).toBe('blocked');
    expect(relationshipOf(s, STRANGER, NOW)).toBe('none');
    expect(relationshipOf(null, FRIEND, NOW)).toBe('none');
  });

  it('a friendship wins over a leftover request, and a block over everything', () => {
    const both = state({ incoming: [{ id: 'r', player_id: FRIEND, nickname: 'Farah', created_at: at(0), expires_at: at(DAY) }] });
    expect(relationshipOf(both, FRIEND, NOW)).toBe('friends');
    const blockedFriend = state({ blocked: [{ player_id: FRIEND, nickname: 'Farah' }] });
    expect(relationshipOf(blockedFriend, FRIEND, NOW)).toBe('blocked');
  });

  it('requests expire by the clock: 30 days after they were sent they no longer count', () => {
    const s = state();
    const later = NOW + 29 * DAY + 1;
    expect(isExpired(at(29 * DAY), NOW)).toBe(false);
    expect(isExpired(at(29 * DAY), NOW + 29 * DAY)).toBe(true);
    expect(isExpired('not a date', NOW)).toBe(true);
    expect(liveRequests(s.outgoing, NOW)).toHaveLength(1);
    expect(liveRequests(s.outgoing, later)).toHaveLength(0);
    expect(relationshipOf(s, ASKED, later)).toBe('none');
    expect(relationshipOf(s, ASKING, later)).toBe('none');
  });

  it('the Add Friend control of a player at my table', () => {
    const s = state();
    const seat = (playerId: string | null, unavailable = false): SeatProfile => ({ seatId: 'seat', unavailable, player: playerId ? { playerId, nickname: 'N' } : null });
    expect(friendActionOf(s, seat(STRANGER), NOW)).toBe('add');
    expect(friendActionOf(s, seat(ASKED), NOW)).toBe('sent');
    expect(friendActionOf(s, seat(ASKING), NOW)).toBe('respond');
    expect(friendActionOf(s, seat(FRIEND), NOW)).toBe('friends');
    // Blocked by me, blocked by them, no account on that seat, list not loaded, not signed in.
    expect(friendActionOf(s, seat(BLOCKED), NOW)).toBe('unavailable');
    expect(friendActionOf(s, seat(null, true), NOW)).toBe('unavailable');
    expect(friendActionOf(s, undefined, NOW)).toBe('unavailable');
    expect(friendActionOf(null, seat(STRANGER), NOW)).toBe('unavailable');
    expect(friendActionOf(s, seat(ME), NOW)).toBe('unavailable');
  });
});

describe('invitations', () => {
  it('an open invitation expires on the phone the moment its 15 minutes are up', () => {
    const invite = state().invites[0]!;
    expect(inviteStateAt(invite, NOW)).toBe('open');
    expect(inviteStateAt(invite, NOW + 14 * MINUTE - 1)).toBe('open');
    expect(inviteStateAt(invite, NOW + 14 * MINUTE)).toBe('expired');
  });

  it('the server’s reason is kept as it is', () => {
    for (const reason of ['started', 'closed', 'expired', 'locked', 'full'] as const) {
      expect(inviteStateAt({ state: reason, expiresAt: at(MINUTE) }, NOW)).toBe(reason);
      // …and an invitation the server already refused does not become "expired" as well.
      expect(inviteStateAt({ state: reason, expiresAt: at(-MINUTE) }, NOW)).toBe(reason);
    }
  });

  it('counts down in minutes and seconds', () => {
    expect(inviteTimeLeft(at(15 * MINUTE), NOW)).toBe('15:00');
    expect(inviteTimeLeft(at(65_000), NOW)).toBe('1:05');
    expect(inviteTimeLeft(at(900), NOW)).toBe('0:01');
    expect(inviteTimeLeft(at(0), NOW)).toBeNull();
    expect(inviteTimeLeft('nonsense', NOW)).toBeNull();
  });

  it('share message: mode, code and the app’s own join link — nothing else', () => {
    expect(gameShareMessage('classic', '482193')).toBe(
      'Join my Business Banker Classic game! Code: 482193. Open Business Banker and enter this code to join.\nbusinessbanker://join-game?code=482193',
    );
    expect(gameShareMessage('intermediate', '000001')).toContain('Intermediate game! Code: 000001.');
  });

  it('a lobby takes invitations only while it is waiting, unlocked, not full, and I am in it', () => {
    const names = Array.from({ length: BUSINESS_MVP_RULES.players.max }, (_, i) => `Player ${String.fromCharCode(65 + i)}`);
    const lobby = new TestGame(names.slice(0, 2), { start: false });
    const host = lobby.id(names[0]!);
    expect(lobbyClosedReason(lobby.state, host)).toBeNull();
    expect(lobbyClosedReason(lobby.state, null)).toMatch(/not in this lobby/);
    expect(lobbyClosedReason(lobby.state, 'someone-else')).toMatch(/not in this lobby/);

    lobby.act(names[0]!, { type: 'SET_LOBBY_LOCK', locked: true });
    expect(lobbyClosedReason(lobby.state, host)).toMatch(/locked/);
    lobby.act(names[0]!, { type: 'SET_LOBBY_LOCK', locked: false });
    expect(lobbyClosedReason(lobby.state, host)).toBeNull();

    lobby.act(names[1]!, { type: 'LEAVE_GAME' });
    expect(lobbyClosedReason(lobby.state, lobby.id(names[1]!))).toMatch(/not in this lobby/);

    const full = new TestGame(names, { start: false });
    expect(lobbyClosedReason(full.state, full.id(names[0]!))).toMatch(/full/);
    const started = new TestGame(names.slice(0, 3));
    expect(lobbyClosedReason(started.state, started.id(names[0]!))).toMatch(/started/);
  });
});

describe('reconciling server answers', () => {
  it('an older answer never replaces a newer one; an equal one may', () => {
    const current = state({ version: 7 });
    expect(shouldApply(null, current)).toBe(true);
    expect(shouldApply(current, state({ version: 8 }))).toBe(true);
    expect(shouldApply(current, state({ version: 7 }))).toBe(true);
    // A slow response from before the friend was removed must not bring them back.
    expect(shouldApply(state({ version: 9, friends: [] }), current)).toBe(false);
  });

  it('a version heard over Realtime means "behind" only when it is ahead', () => {
    const current = state({ version: 7 });
    expect(isBehind(current, 8)).toBe(true);
    // Duplicate and out-of-order events.
    expect(isBehind(current, 7)).toBe(false);
    expect(isBehind(current, 3)).toBe(false);
    // Nothing loaded yet, or an event that carried no version: look.
    expect(isBehind(null, 1)).toBe(true);
    expect(isBehind(current, Number.NaN)).toBe(true);
  });
});

describe('notifications and badges', () => {
  const note = (id: string, type: SocialNotification['type'], read = false, nickname: string | null = 'Farah'): SocialNotification => ({
    id,
    type,
    actor: nickname ? { playerId: FRIEND, nickname } : null,
    entityId: null,
    createdAt: at(0),
    read,
  });

  it('describes each event with the current nickname, and without one when the player is gone', () => {
    expect(notificationText(note('1', 'friend_request'))).toBe('Farah sent you a friend request');
    expect(notificationText(note('2', 'friend_accepted'))).toBe('Farah accepted your friend request');
    expect(notificationText(note('3', 'friends_matched'))).toBe('You and Farah are now friends');
    expect(notificationText(note('4', 'game_invite'))).toBe('Farah invited you to a game');
    expect(notificationText(note('5', 'game_invite', false, null))).toBe('A player invited you to a game');
  });

  it('announces each notification at most once, however often the same list arrives', () => {
    const announced = new Set<string>();
    const first = [note('a', 'friend_request'), note('b', 'game_invite', true)];
    expect(takeUnannounced(first, announced).map((n) => n.id)).toEqual(['a']);
    // The same answer again (a duplicate event, a refetch).
    expect(takeUnannounced(first, announced)).toEqual([]);
    // A new one arrives on top; a read one is never announced, even the first time it is seen.
    const next = [note('c', 'friends_matched'), note('d', 'friend_accepted', true), ...first];
    expect(takeUnannounced(next, announced).map((n) => n.id)).toEqual(['c']);
    expect(takeUnannounced(next, announced)).toEqual([]);
  });

  it('counts what is waiting once: requests, usable invitations and unseen news', () => {
    const s = state({
      notifications: [
        { id: 'n1', type: 'friend_request', actor: null, entity_id: 'req-in', created_at: at(0), read: false },
        { id: 'n2', type: 'game_invite', actor: null, entity_id: 'inv-1', created_at: at(0), read: false },
        { id: 'n3', type: 'friend_accepted', actor: null, entity_id: null, created_at: at(0), read: false },
        { id: 'n4', type: 'friends_matched', actor: null, entity_id: null, created_at: at(0), read: true },
      ],
      unread: 3,
    });
    // 1 request + 1 open invitation + 1 unread "accepted" (the request and the invitation are not counted twice).
    expect(badgesOf(s, NOW)).toEqual({ requests: 1, invites: 1, total: 3 });
    // The invitation's time runs out.
    expect(badgesOf(s, NOW + 15 * MINUTE)).toEqual({ requests: 1, invites: 0, total: 2 });
    expect(badgesOf(state({ invites: [{ ...(serverState().invites as object[])[0], state: 'locked' }] }), NOW).invites).toBe(0);
    expect(badgesOf(null, NOW)).toEqual({ requests: 0, invites: 0, total: 0 });
  });
});

describe('presence', () => {
  it('maps a channel to Online / Offline / Unknown', () => {
    // No channel, or mine is not joined / lost its connection: cannot tell.
    expect(presenceStatusOf(undefined, NOW)).toBe('unknown');
    expect(presenceStatusOf({ synced: false, present: true, leftAt: null }, NOW)).toBe('unknown');
    expect(presenceStatusOf({ synced: false, present: false, leftAt: NOW - 60_000 }, NOW)).toBe('unknown');
    expect(presenceStatusOf({ synced: true, present: true, leftAt: null }, NOW)).toBe('online');
    // Never seen in this session.
    expect(presenceStatusOf({ synced: true, present: false, leftAt: null }, NOW)).toBe('offline');
  });

  it('a friend who drops off is not shown offline until the grace period has passed', () => {
    const left = { synced: true, present: false, leftAt: NOW };
    expect(presenceStatusOf(left, NOW + 1)).toBe('online');
    expect(presenceStatusOf(left, NOW + PRESENCE_OFFLINE_GRACE_MS - 1)).toBe('online');
    expect(presenceStatusOf(left, NOW + PRESENCE_OFFLINE_GRACE_MS)).toBe('offline');
  });
});
