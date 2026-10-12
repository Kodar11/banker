import type { ApiResponse, GameAction } from '../../supabase/functions/_shared/engine/index.ts';

/**
 * Ends a game through the referee the only way players can end one early: `requester` asks for a
 * vote (their own END ballot) and the other players vote END, each from their own seat. The table
 * must be at rest. Returns the response to the request that finished the game — or the first
 * refusal that was not simply "this player is no longer in the game".
 */
export async function endByVote(act: (name: string, action: GameAction) => Promise<ApiResponse>, names: readonly string[], requester: string = names[0]!): Promise<ApiResponse> {
  let last = await act(requester, { type: 'REQUEST_END_VOTE' });
  if (!last.ok) return last;
  for (const name of names) {
    const vote = last.ok ? last.snapshot.state.endGame?.vote : null;
    if (!vote) break;
    if (name === requester) continue;
    const res = await act(name, { type: 'CAST_END_VOTE', voteId: vote.id, choice: 'END' });
    if (res.ok) last = res;
    else if (res.error.code !== 'FORBIDDEN') return res;
  }
  return last;
}
