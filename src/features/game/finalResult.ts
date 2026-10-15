import type { GameSnapshot } from '@/engine/index.ts';

export interface FinalStanding {
  playerId: string;
  netWorth: number;
  /** Total liabilities, the tie-breaker. Absent in a result published before ties were broken this way. */
  liabilities?: number;
  /** 1 = winner; players level on net worth and liabilities share a rank. Absent in an older result. */
  rank?: number;
}

export interface FinalResult {
  /** Every ranked player, in the order the server ranked them. Empty if the result has not reached this phone. */
  standings: FinalStanding[];
  /** The single declared winner, or null when the game ended without one or with a shared victory. */
  winnerId: string | null;
  /** Everyone who won: one player, several when they share the victory, none when nobody was left. */
  winnerIds: string[];
  /** Several players finished level on net worth and on liabilities, and share first place. */
  sharedVictory: boolean;
  /** The winning net worth as ranked; null when there is no winner or no standings to read it from. */
  winnerNetWorth: number | null;
  /** A single winner's net worth minus second place's. Null with fewer than two ranked players, a shared victory, or no winner. */
  lead: number | null;
  /** A single winner level on net worth with someone, ahead on the tie-break: fewer liabilities. */
  wonOnLiabilities: boolean;
  /** Players level on net worth with the winner — those sharing the victory, or those beaten on the tie-break. */
  tiedWithIds: string[];
  /** The winner was the only player still in the game (the rest went bankrupt or left), so there was nobody to rank against. */
  lastPlayerStanding: boolean;
}

function isStanding(value: unknown): value is FinalStanding {
  const row = value as Partial<FinalStanding> | null;
  return !!row && typeof row.playerId === 'string' && typeof row.netWorth === 'number' && Number.isFinite(row.netWorth);
}

/**
 * The finished game's result, read from what the server published when it ended the game: the
 * winners it declared and the standings it ranked. Nothing is worked out again here — the result card
 * and the standings sheet both show these figures, so they can never disagree.
 */
export function finalResult({ state, events }: Pick<GameSnapshot, 'state' | 'events'>): FinalResult {
  const finished = events.find((e) => e.type === 'GAME_FINISHED');
  const published = finished?.payload.standings;
  const standings = Array.isArray(published) ? published.filter(isStanding) : [];
  const declared = finished?.payload.winnerIds;
  const winnerIds = Array.isArray(declared) ? declared.filter((id): id is string => typeof id === 'string') : state.winnerId ? [state.winnerId] : [];
  const winnerId = state.winnerId;
  const sharedVictory = winnerIds.length > 1;
  const top = standings.find((s) => winnerIds.includes(s.playerId)) ?? null;
  // The lead is only meaningful when a single declared winner is the one ranked first.
  const ranked = !sharedVictory && !!top && standings[0]?.playerId === top.playerId && standings.length >= 2;
  const lead = ranked ? top.netWorth - standings[1]!.netWorth : null;
  return {
    standings,
    winnerId,
    winnerIds,
    sharedVictory,
    winnerNetWorth: top?.netWorth ?? null,
    lead,
    wonOnLiabilities: lead === 0,
    tiedWithIds: top ? standings.filter((s) => s.playerId !== top.playerId && s.netWorth === top.netWorth).map((s) => s.playerId) : [],
    lastPlayerStanding: !sharedVictory && !!top && standings.length === 1,
  };
}

/** "Asha", "Asha and Bilal", "Asha, Bilal and Chitra". */
export function namesList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The headline of a finished game: who won, or who shares the victory. */
export function resultTitle(result: Pick<FinalResult, 'winnerIds'>, playerName: (id: string | null) => string): string {
  if (result.winnerIds.length === 0) return 'Game over';
  if (result.winnerIds.length === 1) return `${playerName(result.winnerIds[0]!)} wins!`;
  return `${namesList(result.winnerIds.map((id) => playerName(id)))} share the victory!`;
}
