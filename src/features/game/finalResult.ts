import type { GameSnapshot } from '@/engine/index.ts';

export interface FinalStanding {
  playerId: string;
  netWorth: number;
}

export interface FinalResult {
  /** Every ranked player, in the order the server ranked them. Empty if the result has not reached this phone. */
  standings: FinalStanding[];
  /** The declared winner, or null when the game ended without one. */
  winnerId: string | null;
  /** The winner's final net worth as ranked; null when there is no winner or no standings to read it from. */
  winnerNetWorth: number | null;
  /** Winner's net worth minus second place's. Null with fewer than two ranked players, or no winner. */
  lead: number | null;
  /** Players ranked level with the winner on net worth (the lead is then zero). */
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
 * winner it declared and the standings it ranked. Nothing is worked out again here — the result card
 * and the standings sheet both show these figures, so they can never disagree.
 */
export function finalResult({ state, events }: Pick<GameSnapshot, 'state' | 'events'>): FinalResult {
  const finished = events.find((e) => e.type === 'GAME_FINISHED');
  const published = finished?.payload.standings;
  const standings = Array.isArray(published) ? published.filter(isStanding) : [];
  const winnerId = state.winnerId;
  const winner = winnerId ? (standings.find((s) => s.playerId === winnerId) ?? null) : null;
  // The lead is only meaningful when the declared winner is the one ranked first.
  const ranked = !!winner && standings[0]?.playerId === winner.playerId && standings.length >= 2;
  const lead = ranked ? winner.netWorth - standings[1]!.netWorth : null;
  return {
    standings,
    winnerId,
    winnerNetWorth: winner?.netWorth ?? null,
    lead,
    tiedWithIds: winner && lead === 0 ? standings.filter((s) => s.playerId !== winner.playerId && s.netWorth === winner.netWorth).map((s) => s.playerId) : [],
    lastPlayerStanding: !!winner && standings.length === 1,
  };
}
