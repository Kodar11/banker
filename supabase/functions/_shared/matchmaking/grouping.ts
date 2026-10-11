// Party-aware grouping for random matchmaking. Pure: no clock, no database, no randomness — the
// same queue, policy and `nowMs` always give the same groups, so every rule here is unit-tested
// (tests/matchmaking/grouping.test.ts). Runs only on the server (the `matchmaking` Edge Function);
// what it proposes is checked again by public.matchmaking_reserve before anything is committed.
//
// An entry is one queue ticket: a solo player, or one whole party. Entries are never split.
//
// Policy, by how long the OLDEST entry of a group has waited:
//   under preferTargetMs   only the preferred size: `targetPlayers` (4); a group holding a party of
//                          4 or more is "full" at `maxPlayers` (8) instead
//   under relaxMs          any valid size (minPlayers..maxPlayers) made of two or more entries
//   from relaxMs           also a party of `partyAloneMinPlayers` or more by itself
//   always                 a party that already fills the table starts by itself
//
// Choosing between valid plans (in this order):
//   1. fewest players left waiting who are past preferTargetMs      (nobody starves)
//   2. fewest players above the preferred size                      (5 solos are 3+2, not one 5)
//   3. most waiting time matched                                    (older entries first)
//   4. most even tables                                             (6 solos are 3+3, not 4+2)
//
// Cost: entries are grouped a window at a time (`windowSize`, 10 by default), by exact search over
// the window's subsets with memoisation — at most 2^W states, each trying only the groups that
// contain its oldest entry and fit the table (≤ maxPlayers players). With W = 10 that is under half
// a million steps in the worst case (ten solo players), independent of the queue's length; a run
// over a batch of N entries does at most ceil(N / (W - carry)) windows. Entries a window leaves
// unmatched are carried (oldest first) into the next one, so an old entry keeps meeting newer ones.

export interface QueueEntry {
  id: string;
  /** Players this entry stands for: 1 for a solo player, the party's size otherwise. */
  size: number;
  /** When it entered the queue (server clock, ms). The waiting-time reference. */
  queuedAtMs: number;
}

export interface GroupingPolicy {
  targetPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  preferTargetMs: number;
  relaxMs: number;
  partyAloneMinPlayers: number;
  windowSize: number;
  maxMatches: number;
}

/** The table size of the game engine (BUSINESS_MVP_RULES.players); the policy can narrow it, never widen it. */
export const TABLE_LIMITS = { min: 2, max: 8 } as const;

export const DEFAULT_POLICY: GroupingPolicy = {
  targetPlayers: 4,
  minPlayers: 2,
  maxPlayers: 8,
  preferTargetMs: 30_000,
  relaxMs: 60_000,
  partyAloneMinPlayers: 4,
  windowSize: 10,
  maxMatches: 16,
};

const MAX_WINDOW = 12;

const int = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Server settings → a policy that is always usable: every value inside the limits the game allows. */
export function sanitizePolicy(raw: Partial<Record<keyof GroupingPolicy, unknown>> | null | undefined): GroupingPolicy {
  const d = DEFAULT_POLICY;
  const maxPlayers = clamp(int(raw?.maxPlayers, d.maxPlayers), TABLE_LIMITS.min, TABLE_LIMITS.max);
  const minPlayers = clamp(int(raw?.minPlayers, d.minPlayers), TABLE_LIMITS.min, maxPlayers);
  const targetPlayers = clamp(int(raw?.targetPlayers, d.targetPlayers), minPlayers, maxPlayers);
  const preferTargetMs = Math.max(0, int(raw?.preferTargetMs, d.preferTargetMs));
  return {
    targetPlayers,
    minPlayers,
    maxPlayers,
    preferTargetMs,
    relaxMs: Math.max(preferTargetMs, int(raw?.relaxMs, d.relaxMs)),
    partyAloneMinPlayers: clamp(int(raw?.partyAloneMinPlayers, d.partyAloneMinPlayers), minPlayers, maxPlayers),
    windowSize: clamp(int(raw?.windowSize, d.windowSize), 2, MAX_WINDOW),
    maxMatches: Math.max(1, int(raw?.maxMatches, d.maxMatches)),
  };
}

export type WaitPhase = 'PREFER_TARGET' | 'RELAXED' | 'OPEN';

/** Queue-age policy: which sizes an entry that has waited `ageMs` may be matched into. */
export function phaseOf(ageMs: number, policy: GroupingPolicy): WaitPhase {
  if (ageMs >= policy.relaxMs) return 'OPEN';
  return ageMs >= policy.preferTargetMs ? 'RELAXED' : 'PREFER_TARGET';
}

/** The size a group is aiming for: the target, or a full table once it holds a party that reaches the target by itself. */
export function preferredSize(sizes: readonly number[], policy: GroupingPolicy): number {
  return sizes.some((s) => s >= policy.targetPlayers) ? policy.maxPlayers : policy.targetPlayers;
}

/** Group-size validation: may entries of these sizes, the oldest of which has waited `oldestAgeMs`, form a match now? */
export function groupSizeAllowed(sizes: readonly number[], oldestAgeMs: number, policy: GroupingPolicy): boolean {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  if (sizes.length === 0 || total < policy.minPlayers || total > policy.maxPlayers) return false;
  const phase = phaseOf(oldestAgeMs, policy);
  if (sizes.length === 1) {
    // A table of friends only: when it is already full, or after the long wait if the party is big enough.
    return total === policy.maxPlayers || (phase === 'OPEN' && total >= policy.partyAloneMinPlayers);
  }
  return phase === 'PREFER_TARGET' ? total === preferredSize(sizes, policy) : true;
}

type Conflicts = ReadonlyArray<readonly [string, string]>;

/** Compatibility check: no pair of these entries is barred from sharing a table. */
export function compatible(ids: readonly string[], conflicts: Conflicts = []): boolean {
  if (conflicts.length === 0) return true;
  const set = new Set(ids);
  return !conflicts.some(([a, b]) => a !== b && set.has(a) && set.has(b));
}

/** Whether these entries may be one match at `nowMs`. The single rule both the planner and the tests use. */
export function isValidGroup(entries: readonly QueueEntry[], policy: GroupingPolicy, nowMs: number, conflicts: Conflicts = []): boolean {
  if (entries.length === 0 || new Set(entries.map((e) => e.id)).size !== entries.length) return false;
  if (entries.some((e) => !Number.isInteger(e.size) || e.size < 1)) return false;
  const oldest = Math.min(...entries.map((e) => e.queuedAtMs));
  return (
    groupSizeAllowed(entries.map((e) => e.size), nowMs - oldest, policy) && compatible(entries.map((e) => e.id), conflicts)
  );
}

/** [players past the preferred wait left unmatched, players above the preferred size, -(waiting time matched), unevenness] — smaller is better. */
type Cost = readonly [number, number, number, number];
interface Plan {
  cost: Cost;
  /** Bit masks over the window, one per group. */
  groups: number[];
}

const ZERO: Plan = { cost: [0, 0, 0, 0], groups: [] };

function better(a: Cost, b: Cost): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

function add(plan: Plan, cost: Cost, group?: number): Plan {
  return {
    cost: [plan.cost[0] + cost[0], plan.cost[1] + cost[1], plan.cost[2] + cost[2], plan.cost[3] + cost[3]],
    groups: group === undefined ? plan.groups : [group, ...plan.groups],
  };
}

/** The best plan for one window (entries oldest first). Exact, memoised over subsets of the window. */
function planWindow(window: readonly QueueEntry[], policy: GroupingPolicy, nowMs: number, conflicts: Conflicts): number[][] {
  const n = window.length;
  const ages = window.map((e) => Math.max(0, nowMs - e.queuedAtMs));
  const index = new Map(window.map((e, i) => [e.id, i]));
  const barred = new Array<number>(n).fill(0);
  for (const [a, b] of conflicts) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    barred[i]! |= 1 << j;
    barred[j]! |= 1 << i;
  }
  const waiting = (i: number): Cost => [ages[i]! >= policy.preferTargetMs ? window[i]!.size : 0, 0, 0, 0];

  const memo = new Map<number, Plan>();
  const solve = (mask: number): Plan => {
    if (mask === 0) return ZERO;
    const known = memo.get(mask);
    if (known) return known;
    // The oldest entry still to place: either it waits, or it is in exactly one of the groups tried below.
    let first = 0;
    while (!(mask & (1 << first))) first += 1;
    const rest = mask & ~(1 << first);
    // Groups are tried before waiting, older members first, and only a strictly better plan replaces
    // the one found so far: on a tie the oldest entries play.
    let best: Plan | null = null;

    const members: number[] = [first];
    const extend = (from: number, groupMask: number, total: number, blocked: number): void => {
      const sizes = members.map((i) => window[i]!.size);
      // `first` is the oldest member: entries are sorted, so its age is the group's.
      if (groupSizeAllowed(sizes, ages[first]!, policy)) {
        const preferred = preferredSize(sizes, policy);
        const cost: Cost = [
          0,
          Math.max(0, total - preferred),
          -members.reduce((sum, i) => sum + window[i]!.size * (ages[i]! + 1), 0),
          total < preferred ? (preferred - total) ** 2 : 0,
        ];
        const candidate = add(solve(mask & ~groupMask), cost, groupMask);
        if (!best || better(candidate.cost, best.cost)) best = candidate;
      }
      for (let j = from; j < n; j += 1) {
        const bit = 1 << j;
        if (!(mask & bit) || blocked & bit) continue;
        const size = window[j]!.size;
        if (total + size > policy.maxPlayers) continue;
        members.push(j);
        extend(j + 1, groupMask | bit, total + size, blocked | barred[j]!);
        members.pop();
      }
    };
    if (window[first]!.size <= policy.maxPlayers) extend(first + 1, 1 << first, window[first]!.size, barred[first]!);
    const wait = add(solve(rest), waiting(first));
    const chosen: Plan = best && !better(wait.cost, (best as Plan).cost) ? best : wait;

    memo.set(mask, chosen);
    return chosen;
  };

  const plan = solve(n >= 31 ? 0 : (1 << n) - 1);
  return plan.groups.map((groupMask) => {
    const group: number[] = [];
    for (let i = 0; i < n; i += 1) if (groupMask & (1 << i)) group.push(i);
    return group;
  });
}

/**
 * Groups queue entries of ONE mode into matches. Returns the ticket ids of each match, oldest
 * group first; entries not returned keep waiting. At most `policy.maxMatches` groups.
 * Entries that could never sit at a table (no players, or more than the table holds) are ignored.
 */
export function planMatches(entries: readonly QueueEntry[], rawPolicy: GroupingPolicy, nowMs: number, conflicts: Conflicts = []): string[][] {
  const policy = sanitizePolicy(rawPolicy);
  const seen = new Set<string>();
  const queue = entries
    .filter((e) => {
      if (!Number.isInteger(e.size) || e.size < 1 || e.size > policy.maxPlayers || !Number.isFinite(e.queuedAtMs) || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    // Oldest first; the id breaks ties so the order (and so the result) never depends on the input's.
    .sort((a, b) => a.queuedAtMs - b.queuedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const matches: string[][] = [];
  const carryLimit = Math.floor(policy.windowSize / 2);
  let carried: QueueEntry[] = [];
  let next = 0;
  while (matches.length < policy.maxMatches && (next < queue.length || carried.length > 0)) {
    const fresh = queue.slice(next, next + policy.windowSize - carried.length);
    // Nothing new to offer the entries that are still waiting: they wait for the next run.
    if (fresh.length === 0) break;
    next += fresh.length;
    const window = [...carried, ...fresh];
    const used = new Set<number>();
    for (const group of planWindow(window, policy, nowMs, conflicts)) {
      if (matches.length >= policy.maxMatches) break;
      matches.push(group.map((i) => window[i]!.id));
      group.forEach((i) => used.add(i));
    }
    carried = window.filter((_, i) => !used.has(i)).slice(0, carryLimit);
  }
  return matches;
}
