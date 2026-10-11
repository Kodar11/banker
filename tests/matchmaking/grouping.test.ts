import { describe, expect, it } from 'vitest';
import {
  compatible,
  DEFAULT_POLICY,
  groupSizeAllowed,
  isValidGroup,
  phaseOf,
  planMatches,
  preferredSize,
  sanitizePolicy,
  type GroupingPolicy,
  type QueueEntry,
} from '../../supabase/functions/_shared/matchmaking/grouping.ts';
import { seatNameOf, seatNames } from '../../supabase/functions/_shared/matchmaking/seatNames.ts';

/** A fixed clock: nothing here sleeps or reads the time. */
const NOW = 1_800_000_000_000;
const SECOND = 1000;
const P = DEFAULT_POLICY;

/** Entries named e0, e1, … of the given sizes. `ages` (seconds waited) is one value for all, or one each; e0 is listed first. */
function queue(sizes: number[], ages: number | number[]): QueueEntry[] {
  return sizes.map((size, i) => ({
    id: `e${i}`,
    size,
    // A millisecond apart, in the order given, so "oldest first" is the order written in the test.
    queuedAtMs: NOW - (Array.isArray(ages) ? ages[i]! : ages) * SECOND - (sizes.length - i),
  }));
}

/** The plan as table sizes, each table as the sizes of its entries: [[1,1,1],[1,1]]. */
function tables(entries: QueueEntry[], policy: GroupingPolicy = P, conflicts: [string, string][] = []): number[][] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return planMatches(entries, policy, NOW, conflicts).map((group) => group.map((id) => byId.get(id)!.size));
}

const totals = (plan: number[][]) => plan.map((t) => t.reduce((a, b) => a + b, 0));
const solos = (n: number) => Array.from({ length: n }, () => 1);

/** Every invariant a plan must hold, whatever the queue looked like. */
function expectSound(entries: QueueEntry[], policy: GroupingPolicy = P, conflicts: [string, string][] = []) {
  const plan = planMatches(entries, policy, NOW, conflicts);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const used = plan.flat();
  expect(new Set(used).size, 'no ticket in two matches').toBe(used.length);
  for (const group of plan) {
    const members = group.map((id) => byId.get(id)!);
    const total = members.reduce((sum, e) => sum + e.size, 0);
    expect(total).toBeGreaterThanOrEqual(policy.minPlayers);
    expect(total).toBeLessThanOrEqual(policy.maxPlayers);
    expect(isValidGroup(members, policy, NOW, conflicts)).toBe(true);
  }
  return plan;
}

describe('queue-age policy', () => {
  it('has three phases, at the configured thresholds', () => {
    expect(phaseOf(0, P)).toBe('PREFER_TARGET');
    expect(phaseOf(29_999, P)).toBe('PREFER_TARGET');
    expect(phaseOf(30_000, P)).toBe('RELAXED');
    expect(phaseOf(59_999, P)).toBe('RELAXED');
    expect(phaseOf(60_000, P)).toBe('OPEN');
  });

  it('prefers four; a group holding a party of four or more aims for a full table', () => {
    expect(preferredSize([1, 1], P)).toBe(4);
    expect(preferredSize([3, 1], P)).toBe(4);
    expect(preferredSize([4, 1], P)).toBe(8);
    expect(preferredSize([5, 1, 1, 1], P)).toBe(8);
  });

  it('before 30 s only the preferred size is a match', () => {
    expect(groupSizeAllowed([1, 1, 1, 1], 0, P)).toBe(true);
    expect(groupSizeAllowed([2, 1, 1], 0, P)).toBe(true);
    expect(groupSizeAllowed([1, 1], 0, P)).toBe(false);
    expect(groupSizeAllowed([1, 1, 1], 29_000, P)).toBe(false);
    expect(groupSizeAllowed([1, 1, 1, 1, 1], 0, P)).toBe(false);
    expect(groupSizeAllowed([5, 1, 1, 1], 0, P)).toBe(true);
    expect(groupSizeAllowed([5, 1], 0, P)).toBe(false);
  });

  it('from 30 s any valid size of two or more entries is a match', () => {
    expect(groupSizeAllowed([1, 1], 30_000, P)).toBe(true);
    expect(groupSizeAllowed([1, 1, 1], 30_000, P)).toBe(true);
    expect(groupSizeAllowed([5, 1], 30_000, P)).toBe(true);
    expect(groupSizeAllowed([3, 3], 30_000, P)).toBe(true);
    // …but a party does not yet start by itself.
    expect(groupSizeAllowed([5], 30_000, P)).toBe(false);
    expect(groupSizeAllowed([4], 59_000, P)).toBe(false);
  });

  it('from 60 s a party of four or more may start by itself; a smaller one, and a solo player, never', () => {
    expect(groupSizeAllowed([4], 60_000, P)).toBe(true);
    expect(groupSizeAllowed([5], 60_000, P)).toBe(true);
    expect(groupSizeAllowed([7], 60_000, P)).toBe(true);
    expect(groupSizeAllowed([3], 600_000, P)).toBe(false);
    expect(groupSizeAllowed([2], 600_000, P)).toBe(false);
    expect(groupSizeAllowed([1], 600_000, P)).toBe(false);
  });

  it('a party that fills the table starts at once', () => {
    expect(groupSizeAllowed([8], 0, P)).toBe(true);
  });

  it('never fewer than two or more than eight players, whatever the wait', () => {
    expect(groupSizeAllowed([1], 3_600_000, P)).toBe(false);
    expect(groupSizeAllowed([5, 4], 3_600_000, P)).toBe(false);
    expect(groupSizeAllowed([6, 3], 3_600_000, P)).toBe(false);
    expect(groupSizeAllowed([1, 1, 1, 1, 1, 1, 1, 1, 1], 3_600_000, P)).toBe(false);
    expect(groupSizeAllowed([], 3_600_000, P)).toBe(false);
  });
});

describe('settings', () => {
  it('are kept inside what the game allows', () => {
    const wild = sanitizePolicy({ targetPlayers: 40, minPlayers: 0, maxPlayers: 99, windowSize: 500, maxMatches: 0, preferTargetMs: -5, relaxMs: -1, partyAloneMinPlayers: 1 });
    expect(wild.minPlayers).toBe(2);
    expect(wild.maxPlayers).toBe(8);
    expect(wild.targetPlayers).toBe(8);
    expect(wild.windowSize).toBe(12);
    expect(wild.maxMatches).toBe(1);
    expect(wild.preferTargetMs).toBe(0);
    expect(wild.relaxMs).toBe(0);
    expect(wild.partyAloneMinPlayers).toBe(2);
  });

  it('missing or unreadable values take the defaults', () => {
    expect(sanitizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(sanitizePolicy({ targetPlayers: 'four' as never, relaxMs: undefined })).toEqual(DEFAULT_POLICY);
  });

  it('the thresholds are configuration, not code', () => {
    const quick = sanitizePolicy({ ...P, preferTargetMs: 5000, relaxMs: 10_000 });
    expect(tables(queue(solos(2), 6), quick)).toEqual([[1, 1]]);
    expect(tables(queue(solos(2), 6), P)).toEqual([]);
    const sixes = sanitizePolicy({ ...P, targetPlayers: 6 });
    expect(totals(tables(queue(solos(6), 0), sixes))).toEqual([6]);
    expect(tables(queue(solos(4), 0), sixes)).toEqual([]);
  });
});

describe('solo players', () => {
  it('one player keeps waiting, however long', () => {
    expect(tables(queue([1], 0))).toEqual([]);
    expect(tables(queue([1], 3600))).toEqual([]);
  });

  it('four make a table at once', () => {
    expect(tables(queue(solos(4), 0))).toEqual([[1, 1, 1, 1]]);
  });

  it('two or three wait for a fourth, then play after 30 s', () => {
    expect(tables(queue(solos(2), 10))).toEqual([]);
    expect(tables(queue(solos(3), 29))).toEqual([]);
    expect(tables(queue(solos(2), 30))).toEqual([[1, 1]]);
    expect(tables(queue(solos(3), 31))).toEqual([[1, 1, 1]]);
  });

  it('five, six, seven or eight who just arrived: tables of four, the rest wait', () => {
    expect(totals(tables(queue(solos(5), 0)))).toEqual([4]);
    expect(totals(tables(queue(solos(6), 0)))).toEqual([4]);
    expect(totals(tables(queue(solos(7), 0)))).toEqual([4]);
    expect(totals(tables(queue(solos(8), 0)))).toEqual([4, 4]);
  });

  it('five who have waited are 3 + 2 — not 4 with one left behind, not one table of five', () => {
    expect(totals(tables(queue(solos(5), 40))).sort()).toEqual([2, 3]);
  });

  it('six who have waited are 3 + 3', () => {
    expect(totals(tables(queue(solos(6), 40)))).toEqual([3, 3]);
  });

  it('seven who have waited are 4 + 3, eight are 4 + 4', () => {
    expect(totals(tables(queue(solos(7), 70))).sort()).toEqual([3, 4]);
    expect(totals(tables(queue(solos(8), 70)))).toEqual([4, 4]);
  });

  it('nine and ten who have waited leave nobody behind', () => {
    expect(totals(tables(queue(solos(9), 45))).sort()).toEqual([3, 3, 3]);
    expect(totals(tables(queue(solos(10), 45))).sort()).toEqual([3, 3, 4]);
  });

  it('a player who has waited takes the next arrival rather than waiting for a perfect table', () => {
    expect(tables(queue([1, 1], [35, 1]))).toEqual([[1, 1]]);
  });

  it('newcomers still get a table of four when one who has waited is among them', () => {
    // 4 + one newcomer left to wait — not 3 + 2.
    const entries = queue(solos(5), [40, 2, 2, 2, 2]);
    const plan = planMatches(entries, P, NOW);
    expect(plan).toEqual([['e0', 'e1', 'e2', 'e3']]);
  });
});

describe('parties are never split', () => {
  it('2 + two solos, and 3 + one solo, are tables of four at once', () => {
    expect(tables(queue([2, 1, 1], 0))).toEqual([[2, 1, 1]]);
    expect(tables(queue([3, 1], 0))).toEqual([[3, 1]]);
  });

  it('a party of four waits for company, takes it after 30 s, and starts alone after 60 s', () => {
    expect(tables(queue([4], 0))).toEqual([]);
    expect(tables(queue([4, 1], 0))).toEqual([]);
    expect(tables(queue([4, 1], 31))).toEqual([[4, 1]]);
    expect(tables(queue([4], 45))).toEqual([]);
    expect(tables(queue([4], 61))).toEqual([[4]]);
  });

  it('a party of four and another party of four fill a table at once', () => {
    expect(tables(queue([4, 4], 0))).toEqual([[4, 4]]);
  });

  it('a party of five takes three solos to fill the table, at once', () => {
    expect(tables(queue([5, 1, 1, 1], 0))).toEqual([[5, 1, 1, 1]]);
  });

  it('a party of five and one solo: wait, then a table of six after 30 s', () => {
    expect(tables(queue([5, 1], 5))).toEqual([]);
    expect(tables(queue([5, 1], 30))).toEqual([[5, 1]]);
  });

  it('a party of five alone starts after 60 s, not before', () => {
    expect(tables(queue([5], 59))).toEqual([]);
    expect(tables(queue([5], 60))).toEqual([[5]]);
  });

  it('a party of six takes two solos; it is never cut into two threes', () => {
    expect(tables(queue([6, 1, 1], 0))).toEqual([[6, 1, 1]]);
    const plan = tables(queue([6], 600));
    expect(plan).toEqual([[6]]);
  });

  it('a party of eight is a complete table by itself, immediately', () => {
    expect(tables(queue([8], 0))).toEqual([[8]]);
    expect(tables(queue([8, 1, 1], 0))).toEqual([[8]]);
  });

  it('five + four would be nine: never combined; each starts alone after 60 s', () => {
    expect(tables(queue([5, 4], 40))).toEqual([]);
    expect(tables(queue([5, 4], 61))).toEqual([[5], [4]]);
  });

  it('six + three would be nine: never combined; the three keep waiting for another entry', () => {
    expect(tables(queue([6, 3], 40))).toEqual([]);
    expect(tables(queue([6, 3], 61))).toEqual([[6]]);
    expect(tables(queue([6, 3, 1], 61)).sort((a, b) => b[0]! - a[0]!)).toEqual([[6], [3, 1]]);
  });

  it('a solo beside a party it cannot fit with keeps searching', () => {
    // 8 is full; the solo has nobody.
    expect(tables(queue([8, 1], 90))).toEqual([[8]]);
    // 7 + 1 = 8 fits: they play together.
    expect(tables(queue([7, 1], 0))).toEqual([[7, 1]]);
  });

  it('two parties of three with two solos become two tables of four', () => {
    expect(tables(queue([3, 3, 1, 1], 0)).map((t) => [...t].sort().reverse())).toEqual([[3, 1], [3, 1]]);
  });

  it('two parties of three with nobody else play together once they have waited', () => {
    expect(tables(queue([3, 3], 10))).toEqual([]);
    expect(tables(queue([3, 3], 30))).toEqual([[3, 3]]);
  });

  it('several large parties share the solos so that none is left out', () => {
    const plan = tables(queue([5, 6, 1, 1, 1], 40));
    expect(plan.map((t) => t[0]).sort()).toEqual([5, 6]);
    expect(totals(plan).reduce((a, b) => a + b, 0)).toBe(14);
    for (const total of totals(plan)) expect(total).toBeLessThanOrEqual(8);
  });

  it('every party size from 1 to 8 comes out whole or not at all', () => {
    for (let size = 1; size <= 8; size += 1) {
      for (const age of [0, 31, 61]) {
        const entries = [...queue([size], age), ...queue(solos(7), age).map((e, i) => ({ ...e, id: `s${i}` }))];
        const plan = expectSound(entries);
        const withParty = plan.filter((g) => g.includes('e0'));
        expect(withParty.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('an entry larger than the table, or with no players, is ignored', () => {
    expect(tables(queue([9, 1, 1, 1, 1], 0))).toEqual([[1, 1, 1, 1]]);
    expect(tables(queue([0, 1, 1, 1, 1], 0))).toEqual([[1, 1, 1, 1]]);
    expect(tables(queue([2.5, 1, 1, 1, 1], 0))).toEqual([[1, 1, 1, 1]]);
  });
});

describe('fairness', () => {
  it('the oldest entry is matched first when only one table can form', () => {
    // A party of three has waited 20 s; four solos just arrived. One solo completes the party's table.
    const entries = queue([3, 1, 1, 1, 1], [20, 1, 1, 1, 1]);
    const plan = planMatches(entries, P, NOW);
    expect(plan[0]).toContain('e0');
    expect(plan[0]).toHaveLength(2);
  });

  it('a waiting large party gets the newcomers it needs before they pair off among themselves', () => {
    const entries = queue([5, 1, 1, 1, 1], [40, 1, 1, 1, 1]);
    const plan = planMatches(entries, P, NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual(['e0', 'e1', 'e2', 'e3']);
  });

  it('newer entries are never matched in place of an older one that fits the same table', () => {
    // Six solos, oldest first, all new: the four oldest play.
    const entries = queue(solos(6), [9, 8, 7, 6, 5, 4]);
    expect(planMatches(entries, P, NOW)).toEqual([['e0', 'e1', 'e2', 'e3']]);
  });

  it('the result does not depend on the order the queue is listed in', () => {
    const entries = queue([3, 1, 2, 1, 1, 5, 1, 1], [50, 45, 44, 30, 20, 10, 5, 1]);
    const a = planMatches(entries, P, NOW);
    const b = planMatches([...entries].reverse(), P, NOW);
    const c = planMatches([entries[3]!, entries[0]!, entries[7]!, entries[5]!, entries[1]!, entries[6]!, entries[2]!, entries[4]!], P, NOW);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('entries that tie on waiting time are ordered by id, so two workers would propose the same groups', () => {
    const tied: QueueEntry[] = ['d', 'b', 'a', 'c', 'e'].map((id) => ({ id, size: 1, queuedAtMs: NOW - 1000 }));
    expect(planMatches(tied, P, NOW)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('a ticket listed twice is used once', () => {
    const entries = queue(solos(4), 0);
    const plan = planMatches([...entries, entries[0]!, entries[1]!], P, NOW);
    expect(plan).toEqual([['e0', 'e1', 'e2', 'e3']]);
  });
});

describe('compatibility', () => {
  it('two entries with a block between them never share a table', () => {
    expect(compatible(['a', 'b', 'c'], [['a', 'z']])).toBe(true);
    expect(compatible(['a', 'b', 'c'], [['c', 'a']])).toBe(false);
    const entries = queue(solos(4), 0);
    expect(tables(entries, P, [['e0', 'e1']])).toEqual([]);
    // With a fifth player, a table of four forms around the conflict.
    const five = queue(solos(5), 0);
    const plan = planMatches(five, P, NOW, [['e0', 'e1']]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.includes('e0') && plan[0]!.includes('e1')).toBe(false);
  });

  it('a blocked pair that has waited is split across two tables rather than seated together', () => {
    const entries = queue(solos(4), 40);
    const plan = expectSound(entries, P, [['e0', 'e1']]);
    expect(plan).toHaveLength(2);
    for (const group of plan) expect(group.includes('e0') && group.includes('e1')).toBe(false);
  });

  it('with nobody else to play, a blocked pair keeps waiting', () => {
    expect(tables(queue(solos(2), 600), P, [['e0', 'e1']])).toEqual([]);
  });
});

describe('bounds', () => {
  it('a queue longer than one window is grouped window by window', () => {
    const plan = expectSound(queue(solos(40), 0));
    expect(plan).toHaveLength(10);
    expect(new Set(plan.flat()).size).toBe(40);
  });

  it('an old entry that fits nobody near it is carried forward to meet later entries', () => {
    // A party of three, then twenty pairs, then the one solo that completes the three.
    const entries = queue([3, ...Array.from({ length: 20 }, () => 2), 1], 0);
    const plan = expectSound(entries, sanitizePolicy({ ...P, maxMatches: 50 }));
    const withThree = plan.find((g) => g.includes('e0'));
    expect(withThree).toEqual(['e0', 'e21']);
    expect(plan).toHaveLength(11);
  });

  it('stops at the configured number of matches per run', () => {
    const plan = planMatches(queue(solos(40), 0), sanitizePolicy({ ...P, maxMatches: 3 }), NOW);
    expect(plan).toHaveLength(3);
  });

  it('the worst case for one window stays cheap', () => {
    const entries = queue(solos(12), 90);
    const started = performance.now();
    const plan = expectSound(entries, sanitizePolicy({ ...P, windowSize: 12 }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(new Set(plan.flat()).size).toBe(12);
  });

  it('holds its invariants on generated queues of every shape', () => {
    // A small fixed-seed generator: the same queues on every run.
    let seed = 20261016;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round += 1) {
      const n = 1 + Math.floor(rand() * 30);
      const entries: QueueEntry[] = Array.from({ length: n }, (_, i) => ({
        id: `t${String(i).padStart(2, '0')}`,
        size: rand() < 0.6 ? 1 : 1 + Math.floor(rand() * 8),
        queuedAtMs: NOW - Math.floor(rand() * 90_000),
      }));
      const conflicts: [string, string][] = rand() < 0.3 ? [[entries[0]!.id, entries[Math.floor(rand() * n)]!.id]] : [];
      const plan = expectSound(entries, P, conflicts);
      // Deterministic: the same input gives the same plan.
      expect(planMatches(entries, P, NOW, conflicts)).toEqual(plan);
    }
  });

  it('an empty queue gives no matches', () => {
    expect(planMatches([], P, NOW)).toEqual([]);
  });
});

describe('names at a matchmade table', () => {
  it('keeps a nickname the game accepts', () => {
    expect(seatNameOf('Asha')).toBe('Asha');
    expect(seatNameOf("D'Souza_9 - jr.")).toBe("D'Souza_9 - jr.");
    expect(seatNameOf('  José   María ')).toBe('José María');
  });

  it('drops what the game does not accept and never returns an empty name', () => {
    expect(seatNameOf('Ravi🔥🔥')).toBe('Ravi');
    expect(seatNameOf('🔥🔥🔥')).toBe('Player');
    expect(seatNameOf('<b>Zed</b>')).toBe('b Zed b');
    expect(seatNameOf('')).toBe('Player');
    expect(seatNameOf('x'.repeat(40))).toHaveLength(20);
  });

  it('gives every player at the table a different name, ignoring case', () => {
    expect(seatNames(['Sam', 'sam', 'SAM', 'Lee'])).toEqual(['Sam', 'sam 2', 'SAM 3', 'Lee']);
    expect(seatNames(['Player 2', 'Player', 'Player'])).toEqual(['Player 2', 'Player', 'Player 3']);
    const long = 'a'.repeat(20);
    const names = seatNames([long, long, long]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(20);
  });

  it('handles a full table of identical nicknames', () => {
    const names = seatNames(Array.from({ length: 8 }, () => 'Player1234'));
    expect(new Set(names).size).toBe(8);
  });
});
