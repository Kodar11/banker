import { configOf, GAME_DURATION_YEARS } from './gameConfig.ts';
import { INTERMEDIATE_RULES as IR } from './intermediateConfig.ts';
import { economyOf, gameClock, isIntermediate, pendingCrises, yearAt } from './intermediateState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { EndVote, EndVoteChoice, EndVoteKind, GameEndState, GameState } from './types.ts';

/**
 * How a hosted game ends — the rules, in one place. The reducer applies them (it owns the turn and
 * the completion flow); the app reads the same selectors to decide what to offer.
 *
 * The three clocks, which are not interchangeable:
 *   lap / circuit    one player's token passing Start (PlayerState.circuits). Pays the Start reward
 *                    and falls due Classic loan interest. Card moves count; it is per player.
 *   financial year   one shared calendar for the table: a year passes each time the starting players
 *                    have moved IR.year.spacesPerYear spaces BY DICE on average. On this board that
 *                    is one lap each, so a year is about a lap — but only about: card moves, Jail and
 *                    the Rest House move tokens without moving the calendar.
 *   turn             one player's go (TurnState.number). Nothing here counts turns.
 * A game's duration is measured in financial years. Capital Mode already keeps that calendar in its
 * economy (IntermediateState.year / movement) and it is the one used; Classic had no calendar, so
 * GameEndState.calendar keeps the same dice clock for it. There is never a second count of the same thing.
 *
 * The duration: the host picks 5–10 financial years (GameConfig.durationYears). The game plays that
 * many whole years. While an earlier year is being played any active player may ask, once a year,
 * for an EARLY vote, which ends the game on a strict majority. When the last year is over the server
 * opens a DURATION vote by itself: enough END ballots finish the game, anything less plays exactly
 * one more year and then asks again — never past year 10, where the game simply ends.
 *
 * Every vote: one open at a time; the electorate and the number of END ballots needed are fixed when
 * it opens; 30 seconds on the server's clock; one locked, secret ballot per player; a player who does
 * not vote counts for neither side. While a vote is open nothing else is played, so a vote never
 * lands in the middle of a purchase, a payment, an auction or a year change.
 *
 * Matchmade games have no host, no duration and no votes: none of this applies to them.
 */

type EndGameView = Pick<GameState, 'status' | 'hostPlayerId' | 'players' | 'mode'> & {
  endGame?: GameEndState | null;
  intermediate?: GameState['intermediate'];
  config?: GameState['config'] | null;
};

/**
 * This game has a duration and votes: a started game with a host. (A matchmade game is started
 * without one, and a hosted game always has one while it runs — the role passes on when the host leaves.)
 */
export function hasGameDuration(state: EndGameView): boolean {
  return state.status !== 'WAITING' && (state.endGame != null || state.hostPlayerId !== null);
}

/** END ballots an early vote needs: a strict majority of the electorate. */
export function earlyVotesRequired(electors: number): number {
  return Math.floor(electors / 2) + 1;
}

/** END ballots a duration vote needs: half the electorate, rounded down, and at least one. Lower on purpose — the agreed game is over. */
export function durationVotesRequired(electors: number): number {
  return Math.max(1, Math.floor(electors / 2));
}

export function endVotesRequired(kind: EndVoteKind, electors: number): number {
  return kind === 'EARLY' ? earlyVotesRequired(electors) : durationVotesRequired(electors);
}

/**
 * The financial year the dice clock has reached, whatever the game's duration. Capital: the
 * economy's own clock. Classic: the same clock, kept in GameEndState.calendar. 1 before any of it exists.
 */
export function calendarYear(state: EndGameView): number {
  const eco = economyOf(state);
  if (eco) return yearAt(eco, gameClock(eco));
  const calendar = state.endGame?.calendar;
  if (!calendar) return 1;
  const clock = Object.values(calendar.movement).reduce((sum, m) => sum + m, 0);
  return 1 + Math.floor(clock / (Math.max(1, calendar.playerCount) * IR.year.spacesPerYear));
}

/** The last financial year this game plays as things stand: the host's choice plus any extensions, never past the maximum. */
export function durationLimit(state: EndGameView): number {
  return Math.min(GAME_DURATION_YEARS.maxYears, configOf(state).durationYears + (state.endGame?.extraYears ?? 0));
}

/** The year a new financial year may not pass without a vote; none in a game without a duration. */
export function financialYearCap(state: EndGameView): number {
  return hasGameDuration(state) ? durationLimit(state) : Number.POSITIVE_INFINITY;
}

/** The financial year being played. In a game with a duration it stops at the limit until the players have decided. */
export function financialYear(state: EndGameView): number {
  return Math.min(calendarYear(state), financialYearCap(state));
}

/** The agreed duration has been played out: the dice have carried the calendar past the game's last year. */
export function durationOver(state: EndGameView): boolean {
  return hasGameDuration(state) && calendarYear(state) > durationLimit(state);
}

/** No further year can be added: the game is at the longest a game may be. */
export function atMaximumDuration(state: EndGameView): boolean {
  return durationLimit(state) >= GAME_DURATION_YEARS.maxYears;
}

/**
 * The end-of-game state of a game that has none yet: at START_GAME, and for a hosted game that was
 * already running when votes were introduced. Such a game keeps its default duration; if it has
 * already played past it, the years it has played count as extensions so it is not asked to vote
 * for each of them in a row.
 */
export function newGameEnd(state: EndGameView): GameEndState {
  const starters = state.players.filter((p) => p.status !== 'LEFT');
  const calendar = isIntermediate(state) ? null : { playerCount: Math.max(1, starters.length), movement: Object.fromEntries(starters.map((p) => [p.id, 0])) };
  const base = configOf(state).durationYears;
  const played = calendarYear({ ...state, endGame: null });
  const extraYears = Math.min(Math.max(0, played - base), GAME_DURATION_YEARS.maxYears - base);
  return { extraYears, calendar, requestedIn: {}, vote: null, lastResult: null };
}

/** The vote in progress, if any. */
export function openEndVote(state: { endGame?: GameEndState | null }): EndVote | null {
  return state.endGame?.vote ?? null;
}

/** Server-clock ms from which no ballot counts and the vote may be closed. One boundary, no grace: a ballot is in time strictly before it. */
export function endVoteDeadline(vote: Pick<EndVote, 'endsAt'>): number {
  return Date.parse(vote.endsAt);
}

/** Everyone who can still vote has: electors who have left or gone out of the game are not waited for. */
export function endVoteComplete(state: Pick<GameState, 'players'>, vote: EndVote): boolean {
  const active = new Set(state.players.filter((p) => p.status === 'ACTIVE').map((p) => p.id));
  return vote.electorate.every((id) => id in vote.ballots || !active.has(id));
}

/** END ballots cast. A ballot stays counted even if its voter has since left. */
export function endBallots(vote: Pick<EndVote, 'ballots'>): number {
  return Object.values(vote.ballots).filter((choice: EndVoteChoice) => choice === 'END').length;
}

type RequestView = EndGameView & Pick<GameState, 'turn' | 'auction'>;

/**
 * Why `playerId` can't ask for an early vote right now, or null when they can. THE rule: the server
 * refuses with this message, and the app uses it to explain a disabled button.
 *
 * A vote is only opened while the table is at rest — before a roll or after a turn's business is
 * done — so it never interrupts an auction, a purchase decision, a payment, a card or a crisis bill.
 * Asking at another moment is refused, not queued: the player asks again when the move is over.
 */
export function endVoteRequestBlocker(state: RequestView, playerId: string): string | null {
  if (!hasGameDuration(state)) return 'This game has no end-game votes.';
  if (state.status === 'FINISHED') return 'This game has finished.';
  if (state.status !== 'ACTIVE') return 'Resume the game first.';
  if (state.players.find((p) => p.id === playerId)?.status !== 'ACTIVE') return 'You are out of the game.';
  if (openEndVote(state)) return 'A vote is already in progress.';
  const year = financialYear(state);
  if (year >= durationLimit(state)) return 'This is the last financial year. Everyone votes when it ends.';
  if (state.endGame?.requestedIn[playerId] === year) return 'You have already asked for a vote this financial year. You can ask again next year.';
  if (state.auction?.status === 'OPEN' || state.turn.phase === 'AUCTION') return 'Wait for the auction to finish, then ask again.';
  if (pendingCrises(state).length > 0) return 'Wait until the crisis bill is settled, then ask again.';
  if (state.turn.phase !== 'AWAITING_ROLL' && state.turn.phase !== 'TURN_COMPLETE') return 'Wait for the current move to finish, then ask again.';
  return null;
}

/** How long a vote stays open. */
export const END_VOTE_SECONDS = RULES.endGame.voteSeconds;

/**
 * The state as one player may see it. THE privacy boundary for ballots: the server passes every
 * snapshot through here before it leaves, so a device only ever holds its own ballot — the host's
 * included. What is left says that a vote is open, what it asks, until when, and whether I have voted.
 */
export function redactEndVote(state: GameState, viewerId: string | null): GameState {
  const end = state.endGame;
  const vote = end?.vote;
  if (!end || !vote) return state;
  const own = viewerId ? vote.ballots[viewerId] : undefined;
  return { ...state, endGame: { ...end, vote: { ...vote, ballots: own && viewerId ? { [viewerId]: own } : {} } } };
}
