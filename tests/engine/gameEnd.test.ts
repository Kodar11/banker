/**
 * Game duration and end-game votes (src/engine/gameEnd.ts, reducer.ts): the host's 5–10 financial
 * years, the early vote (strict majority), the finish-or-extend vote when the duration is over
 * (half, at least one), the hard stop at year 10, and everything that keeps a vote fair — one at a
 * time, once a year per player, a fixed electorate, a server deadline, one secret ballot each.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BOARD_SIZE,
  calendarYear,
  defaultGameConfig,
  durationEstimate,
  durationLimit,
  durationVotesRequired,
  earlyVotesRequired,
  END_VOTE_SECONDS,
  endVoteRequestBlocker,
  financialYear,
  GAME_DURATION_OPTIONS,
  gameClock,
  hasGameDuration,
  INTERMEDIATE_RULES as IR,
  legacyGameConfig,
  netWorth,
  normalizeGameConfig,
  parseGameConfig,
  redactEndVote,
  startHostlessGame,
  yearAt,
  type EngineResult,
  type GameMode,
  type GameState,
} from '@/engine/index.ts';
import { keepOrder, TestGame } from './harness.ts';

const NAMES = ['Asha', 'Bilal', 'Chitra', 'Dev', 'Esha', 'Farid'];
const MODES: GameMode[] = ['classic', 'intermediate'];
const table = (players: number, options: { mode?: GameMode; config?: unknown } = {}) => new TestGame(NAMES.slice(0, players), options);
const types = (r: EngineResult) => r.events.map((e) => e.type);
const vote = (g: TestGame) => g.state.endGame!.vote!;
const finished = (r: EngineResult) => r.events.find((e) => e.type === 'GAME_FINISHED')!.payload as { reason: string; standings: { playerId: string; netWorth: number }[] };

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? 'THROWN', message: e.message ?? '' };
  }
  return { code: 'ACCEPTED', message: '' };
}

/** Test surgery: puts the dice clock `short` spaces before the end of financial year `year`. */
function setClockBeforeEndOf(g: TestGame, year: number, short: number) {
  const eco = g.state.intermediate;
  const movement = eco ? eco.movement : g.state.endGame!.calendar!.movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = year * ids.length * IR.year.spacesPerYear - short;
  if (eco) eco.year = year;
}

/**
 * Plays the last roll of financial year `year` — the current player rolls 3 from three squares
 * before Start, which carries the calendar into the next year — and ends that turn.
 */
function playOut(g: TestGame, year: number): EngineResult {
  setClockBeforeEndOf(g, year, 3);
  const name = g.current;
  g.placeAt(name, BOARD_SIZE - 3);
  g.roll(name, 1, 2);
  return g.act(name, { type: 'END_TURN' });
}

/** Every elector still at the table votes: END until `end` END ballots are in, then CONTINUE (the requester of an early vote has voted END already). */
function castAll(g: TestGame, end: number) {
  const names = vote(g)
    .electorate.map((id) => g.state.players.find((p) => p.id === id)!)
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => p.name);
  let ends = Object.values(vote(g).ballots).filter((b) => b === 'END').length;
  for (const name of names) {
    const open = g.state.endGame?.vote;
    if (!open) return;
    if (g.id(name) in open.ballots) continue;
    const choice = ends < end ? 'END' : 'CONTINUE';
    if (choice === 'END') ends += 1;
    g.act(name, { type: 'CAST_END_VOTE', voteId: open.id, choice });
  }
}

// ---------------------------------------------------------------------------

describe('the duration is a host setting: 5 to 10 financial years, 5 unless chosen', () => {
  it.each(MODES)('%s: defaults to 5, and a game created without one runs for 5', (mode) => {
    expect(defaultGameConfig(mode).durationYears).toBe(5);
    expect(parseGameConfig(mode, undefined).durationYears).toBe(5);
    expect(new TestGame(['Asha', 'Bilal'], { mode }).state.config.durationYears).toBe(5);
  });

  it.each(MODES)('%s: accepts every whole number from 5 to 10 and stores it for everyone', (mode) => {
    expect(GAME_DURATION_OPTIONS).toEqual([5, 6, 7, 8, 9, 10]);
    for (const durationYears of GAME_DURATION_OPTIONS) {
      const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { mode, config: { durationYears } });
      expect(g.state.config.durationYears).toBe(durationYears);
      expect(durationLimit(g.state)).toBe(durationYears);
    }
  });

  it('refuses anything else, with a message that names the setting, before anything is stored', () => {
    for (const bad of [4, 11, 0, -5, 5.5, 7.000001, '7', null, Number.NaN, Number.POSITIVE_INFINITY, [7], { years: 7 }]) {
      const r = refusal(() => new TestGame(['Asha', 'Bilal'], { start: false, config: { durationYears: bad } }));
      expect(`${JSON.stringify(bad)}: ${r.code}`).toBe(`${JSON.stringify(bad)}: VALIDATION`);
      expect(r.message).toMatch(/game duration|A game lasts/i);
    }
  });

  it('a game stored without a duration plays the default five years', () => {
    for (const mode of MODES) {
      expect(legacyGameConfig(mode).durationYears).toBe(5);
      expect(normalizeGameConfig(mode, null).durationYears).toBe(5);
      expect(normalizeGameConfig(mode, { startingCash: 30000, loanLimit: 20000 }).durationYears).toBe(5);
      expect(normalizeGameConfig(mode, { durationYears: 9 }).durationYears).toBe(9);
    }
  });

  it('only the host sets it, only in the lobby; from the start it is locked for everybody', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    expect(refusal(() => g.act('Bilal', { type: 'UPDATE_CONFIG', config: { durationYears: 8 } })).code).toBe('FORBIDDEN');
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { durationYears: 12 } })).code).toBe('VALIDATION');
    g.act('Asha', { type: 'UPDATE_CONFIG', config: { durationYears: 8 } });
    expect(g.state.config.durationYears).toBe(8);
    g.queueRandom(...keepOrder(2));
    g.act('Asha', { type: 'START_GAME' });
    for (const name of ['Asha', 'Bilal']) expect(refusal(() => g.act(name, { type: 'UPDATE_CONFIG', config: { durationYears: 5 } })).code).toBe('INVALID_PHASE');
    expect(durationLimit(g.state)).toBe(8);
  });

  it('a financial year is one lap each on average, so the estimate shown to players is honest', () => {
    // 36 spaces of dice movement per player per year, on a board of 36 squares.
    expect(IR.year.spacesPerYear).toBe(BOARD_SIZE);
    expect(durationEstimate(5)).toBe('5 financial years · Approximately 5 laps');
    expect(durationEstimate(7)).toBe('7 financial years · Approximately 7 laps');
    expect(durationEstimate(10)).toBe('10 financial years · Approximately 10 laps');
  });

  it('the count of years starts with the game: one calendar, kept where the mode already keeps it', () => {
    const classic = table(3);
    expect(classic.state.endGame).toEqual({ extraYears: 0, calendar: { playerCount: 3, movement: Object.fromEntries(['Asha', 'Bilal', 'Chitra'].map((n) => [classic.id(n), 0])) }, requestedIn: {}, vote: null, lastResult: null });
    const capital = table(3, { mode: 'intermediate' });
    // Capital already has the calendar in its economy: there is no second count.
    expect(capital.state.endGame).toMatchObject({ extraYears: 0, calendar: null });
    expect(new TestGame(['Asha', 'Bilal'], { start: false }).state.endGame).toBeNull();
  });

  it('Classic counts dice movement only, exactly as Capital does', () => {
    const g = table(2);
    expect(financialYear(g.state)).toBe(1);
    g.roll('Asha', 3, 4);
    expect(g.state.endGame!.calendar!.movement[g.id('Asha')]).toBe(7);
    setClockBeforeEndOf(g, 1, 0);
    expect(financialYear(g.state)).toBe(2);
  });
});

describe('the thresholds', () => {
  it('early: a strict majority. After the duration: half, rounded down, and at least one', () => {
    expect([2, 3, 4, 5, 6].map(earlyVotesRequired)).toEqual([2, 2, 3, 3, 4]);
    expect([2, 3, 4, 5, 6].map(durationVotesRequired)).toEqual([1, 1, 2, 2, 3]);
  });
});

describe.each(MODES)('early-ending vote (%s)', (mode) => {
  it.each([2, 3, 4, 5, 6])('%i players: one END ballot short and the game goes on; the strict majority ends it', (players) => {
    const need = earlyVotesRequired(players);
    const short = table(players, { mode });
    const worth = Object.fromEntries(short.state.players.map((p) => [p.id, netWorth(short.state, p.id)]));
    short.act('Asha', { type: 'REQUEST_END_VOTE' });
    expect(vote(short)).toMatchObject({ kind: 'EARLY', required: need, requestedBy: short.id('Asha'), year: 1 });
    expect(vote(short).electorate).toHaveLength(players);
    castAll(short, need - 1);
    expect(short.state).toMatchObject({ status: 'ACTIVE', endGame: { vote: null, lastResult: { kind: 'EARLY', outcome: 'CONTINUED' } } });
    // A failed vote pauses nothing: the turn is where it was and the dice roll.
    short.roll(short.current, 1, 1);

    const enough = table(players, { mode, config: { secretObjectives: false } });
    enough.act('Asha', { type: 'REQUEST_END_VOTE' });
    castAll(enough, need);
    expect(enough.state.status).toBe('FINISHED');
    const last = enough.results.at(-1)!;
    expect(types(last)).toEqual(['END_VOTE_CLOSED', 'GAME_FINISHED']);
    // The existing completion flow, untouched: the standings are plain net worth, highest first.
    expect(finished(last)).toMatchObject({ reason: 'VOTE' });
    expect(finished(last).standings).toEqual(enough.state.players.map((p) => ({ playerId: p.id, netWorth: worth[p.id] ?? netWorth(enough.state, p.id) })));
    expect(last.transactions).toEqual([]);
  });

  it('the host has no override: asking alone decides nothing, and a ballot nobody cast counts for neither side', () => {
    const g = table(3, { mode });
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    expect(g.state.status).toBe('ACTIVE');
    expect(refusal(() => g.act('Asha', { type: 'CLOSE_END_VOTE', voteId: vote(g).id })).message).toBe('The vote is still open.');
    g.advance(END_VOTE_SECONDS);
    const closed = g.act('Bilal', { type: 'CLOSE_END_VOTE', voteId: vote(g).id });
    // 1 END of 3, 2 needed: the two silent players are not counted as END — nor as anything else.
    expect(types(closed)).toEqual(['END_VOTE_CLOSED']);
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { vote: null, lastResult: { outcome: 'CONTINUED' } } });
  });

  it('once per player per financial year — also after a failed vote; someone else may still ask; a new year resets it', () => {
    const g = table(3, { mode });
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    castAll(g, 1);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_END_VOTE' }))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'You have already asked for a vote this financial year. You can ask again next year.' });
    // Bilal has not asked this year, and Asha votes in his.
    g.act('Bilal', { type: 'REQUEST_END_VOTE' });
    g.act('Asha', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'CONTINUE' });
    g.act('Chitra', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'CONTINUE' });
    expect(g.state.endGame!.requestedIn).toEqual({ [g.id('Asha')]: 1, [g.id('Bilal')]: 1 });
    playOut(g, 1);
    expect(financialYear(g.state)).toBe(2);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    expect(vote(g)).toMatchObject({ year: 2, requestedBy: g.id('Asha') });
  });

  it('one vote at a time: a second request — the same tap again, or another player at the same moment — opens nothing', () => {
    const g = table(4, { mode });
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const first = vote(g).id;
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(refusal(() => g.act(name, { type: 'REQUEST_END_VOTE' })).code).toBe('INVALID_PHASE');
    expect(vote(g).id).toBe(first);
    // The refused requests cost nobody their own request for the year.
    expect(g.state.endGame!.requestedIn).toEqual({ [g.id('Asha')]: 1 });
  });

  it('not offered in the last financial year: that year ends in a vote anyway', () => {
    const g = table(2, { mode });
    playOut(g, 4);
    expect(financialYear(g.state)).toBe(5);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_END_VOTE' }))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'This is the last financial year. Everyone votes when it ends.' });
    const longer = table(2, { mode, config: { durationYears: 7 } });
    playOut(longer, 5);
    expect(endVoteRequestBlocker(longer.state, longer.id('Asha'))).toBeNull();
    playOut(longer, 6);
    expect(endVoteRequestBlocker(longer.state, longer.id('Asha'))).toMatch(/last financial year/);
  });

  it('never over unfinished business: refused during a decision or an auction, and asking again afterwards works', () => {
    const g = table(3, { mode });
    g.roll('Asha', 1, 2);
    expect(g.state.turn.phase).toBe('AWAITING_DECISION');
    expect(refusal(() => g.act('Bilal', { type: 'REQUEST_END_VOTE' }))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'Wait for the current move to finish, then ask again.' });
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    expect(refusal(() => g.act('Bilal', { type: 'REQUEST_END_VOTE' })).message).toBe('Wait for the auction to finish, then ask again.');
    expect(g.state.endGame!.requestedIn).toEqual({});
    for (const name of ['Asha', 'Bilal', 'Chitra']) g.act(name, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
    g.act('Bilal', { type: 'REQUEST_END_VOTE' });
    expect(vote(g).requestedBy).toBe(g.id('Bilal'));
  });

  it('while the vote is open nothing else is played; when it fails every action is back', () => {
    const g = table(3, { mode });
    g.act('Bilal', { type: 'REQUEST_END_VOTE' });
    const blocked = { code: 'INVALID_PHASE', message: 'A vote on ending the game is in progress.' };
    expect(refusal(() => g.act('Asha', { type: 'ROLL_DICE' }))).toEqual(blocked);
    expect(refusal(() => g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 100 }))).toEqual(blocked);
    expect(refusal(() => g.act('Asha', { type: 'PAUSE_GAME' }))).toEqual(blocked);
    castAll(g, 1);
    g.roll('Asha', 1, 1);
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 100 });
  });
});

describe('ballots', () => {
  it('one per player, locked: a second ballot — the same or the other choice — is refused and changes nothing', () => {
    const g = table(4);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const voteId = vote(g).id;
    // Asking was Asha's own END ballot.
    expect(vote(g).ballots).toEqual({ [g.id('Asha')]: 'END' });
    expect(refusal(() => g.act('Asha', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' }))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'You have already voted.' });
    g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' });
    for (const choice of ['CONTINUE', 'END'] as const) expect(refusal(() => g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice })).code).toBe('VOTE_NOT_ALLOWED');
    expect(vote(g).ballots).toEqual({ [g.id('Asha')]: 'END', [g.id('Bilal')]: 'CONTINUE' });
  });

  it('a ballot counts only if the server received it before the deadline — the server clock, never the sender’s', () => {
    const g = table(3);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const voteId = vote(g).id;
    expect(Date.parse(vote(g).endsAt) - g.nowMs).toBe(END_VOTE_SECONDS * 1000);
    g.advance(END_VOTE_SECONDS - 1);
    g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' });
    g.advance(1);
    expect(refusal(() => g.act('Chitra', { type: 'CAST_END_VOTE', voteId, choice: 'END' }))).toEqual({ code: 'VOTE_CLOSED', message: 'Voting has ended.' });
    // Received in time but processed late (it queued for the game lock): it counts.
    const late = applyAction(g.state, g.id('Chitra'), { type: 'CAST_END_VOTE', voteId, choice: 'END' }, { ...g.ctx(), receivedAt: new Date(g.nowMs - 500).toISOString() });
    expect(late.state.status).toBe('FINISHED');
  });

  it('the timeout settles the vote exactly once: whoever closes second finds no vote, and so does a late ballot', () => {
    const g = table(3);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const voteId = vote(g).id;
    g.advance(END_VOTE_SECONDS + 5);
    const closed = g.act('Chitra', { type: 'CLOSE_END_VOTE', voteId });
    expect(types(closed)).toEqual(['END_VOTE_CLOSED']);
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(refusal(() => g.act(name, { type: 'CLOSE_END_VOTE', voteId }))).toEqual({ code: 'VOTE_CLOSED', message: 'That vote has closed.' });
    expect(refusal(() => g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'END' })).code).toBe('VOTE_CLOSED');
    expect(g.results.flatMap(types).filter((t) => t === 'END_VOTE_CLOSED')).toHaveLength(1);
  });

  it('the last ballot settles the vote without waiting for the clock', () => {
    const g = table(2);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const r = g.act('Bilal', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'CONTINUE' });
    expect(types(r)).toEqual(['END_VOTE_CLOSED']);
    expect(g.state.endGame!.vote).toBeNull();
  });

  it('only the electorate votes: a player who is out of the game, or is not at this table, is refused', () => {
    const g = table(4);
    g.player('Dev').status = 'BANKRUPT';
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    expect(vote(g).electorate).toEqual(['Asha', 'Bilal', 'Chitra'].map((n) => g.id(n)));
    expect(vote(g).required).toBe(2);
    expect(refusal(() => g.act('Dev', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'END' }))).toEqual({ code: 'FORBIDDEN', message: 'You are out of the game.' });
    expect(refusal(() => g.act('Dev', { type: 'REQUEST_END_VOTE' })).code).toBe('FORBIDDEN');
    expect(() => applyAction(g.state, '00000000-0000-4000-8000-ffffffffffff', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'END' }, g.ctx())).toThrow(/not in this game/);
  });
});

describe('votes are secret', () => {
  it('no event, result or other player’s view says who voted for what, or how many did', () => {
    const g = table(4);
    const asked = g.act('Asha', { type: 'REQUEST_END_VOTE' });
    expect(asked.events).toMatchObject([{ type: 'END_VOTE_STARTED', message: 'Asha asked for a vote to end the game early', payload: { kind: 'EARLY', required: 3, electors: 4 } }]);
    const voteId = vote(g).id;
    // A ballot writes no event at all.
    expect(g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'END' }).events).toEqual([]);
    expect(g.act('Chitra', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' }).events).toEqual([]);

    // What each device is sent: its own ballot and nothing of anyone else's — the host's view included.
    for (const [name, own] of [['Asha', { END: 1 }], ['Bilal', { END: 1 }], ['Chitra', { CONTINUE: 1 }], ['Dev', {}]] as const) {
      const seen = redactEndVote(g.state, g.id(name)).endGame!.vote!;
      expect(Object.keys(seen.ballots)).toEqual(Object.keys(own).length ? [g.id(name)] : []);
      expect(seen).toMatchObject({ id: voteId, kind: 'EARLY', endsAt: vote(g).endsAt, required: 3 });
    }
    expect(redactEndVote(g.state, null).endGame!.vote!.ballots).toEqual({});
    // The authoritative state is not changed by looking at it.
    expect(Object.keys(vote(g).ballots)).toHaveLength(3);

    const closed = g.act('Dev', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' });
    const event = closed.events.find((e) => e.type === 'END_VOTE_CLOSED')!;
    expect(event).toMatchObject({ actorId: null, message: 'Game will continue', payload: { voteId, kind: 'EARLY', outcome: 'CONTINUED', durationYears: 5 } });
    expect(g.state.endGame!.lastResult).toEqual({ id: voteId, kind: 'EARLY', outcome: 'CONTINUED', closedAt: new Date(g.nowMs).toISOString() });
    const published = JSON.stringify([closed.events, g.state.endGame!.lastResult, g.state.endGame!.vote]);
    expect(published).not.toMatch(/ballot|tally|"END"|"CONTINUE"/);
    for (const name of ['Bilal', 'Chitra', 'Dev']) expect(published).not.toContain(g.id(name));
  });
});

describe('leaving is not voting', () => {
  it('the electorate and the number needed are fixed when the vote opens: a player who leaves does not lower the bar', () => {
    const g = table(5);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const voteId = vote(g).id;
    g.act('Esha', { type: 'LEAVE_GAME' });
    g.act('Dev', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('ACTIVE');
    expect(vote(g)).toMatchObject({ id: voteId, required: 3 });
    expect(vote(g).electorate).toHaveLength(5);
    // Neither departure is a ballot.
    expect(Object.keys(vote(g).ballots)).toEqual([g.id('Asha')]);
    g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'END' });
    // 2 END of the 3 still needed; the last player present votes to go on — and nobody who left is waited for.
    g.act('Chitra', { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' });
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { vote: null, lastResult: { outcome: 'CONTINUED' } } });
  });

  it('a ballot cast before leaving still counts, and the vote closes when the last player it was waiting for walks away', () => {
    const g = table(4);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const voteId = vote(g).id;
    g.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice: 'END' });
    g.act('Chitra', { type: 'CAST_END_VOTE', voteId, choice: 'END' });
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(g.state.endGame!.vote).not.toBeNull();
    // Dev never votes and leaves: that settles it on the three END ballots cast.
    const r = g.act('Dev', { type: 'LEAVE_GAME' });
    expect(types(r)).toEqual(expect.arrayContaining(['PLAYER_LEFT', 'END_VOTE_CLOSED', 'GAME_FINISHED']));
    expect(finished(r).reason).toBe('VOTE');
  });

  it('the host leaves in the middle of a vote: the vote goes on, the game is not ended by it', () => {
    const g = table(4);
    g.act('Bilal', { type: 'REQUEST_END_VOTE' });
    g.act('Asha', { type: 'LEAVE_GAME' });
    expect(g.state).toMatchObject({ status: 'ACTIVE', hostPlayerId: g.id('Bilal') });
    castAll(g, 1);
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { lastResult: { outcome: 'CONTINUED' } } });
    g.roll(g.current, 1, 1);
  });

  it('when everyone else has left, the existing rule ends the game — the open vote goes with it', () => {
    const g = table(2);
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const r = g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(finished(r).reason).toBe('PLAYERS_LEFT');
    expect(g.state.endGame!.vote).toBeNull();
    expect(g.state.winnerId).toBe(g.id('Asha'));
  });
});

describe.each(MODES)('finish-or-extend vote when the duration is over (%s)', (mode) => {
  it.each([2, 3, 4, 5, 6])('%i players: opens by itself, holds the next turn, ends on half the table — otherwise exactly one more year', (players) => {
    const need = durationVotesRequired(players);
    const g = table(players, { mode, config: { secretObjectives: false } });
    const opened = playOut(g, 5);
    expect(opened.events.filter((e) => e.type === 'END_VOTE_STARTED')).toMatchObject([{ actorId: null, payload: { kind: 'DURATION', required: need, electors: players } }]);
    expect(vote(g)).toMatchObject({ kind: 'DURATION', required: need, requestedBy: null, year: 5, ballots: {} });
    // No new turn while the decision is open: the player who just finished is still the turn's owner, and nobody may roll.
    expect(types(opened)).not.toContain('TURN_STARTED');
    expect(g.current).toBe('Asha');
    for (const name of NAMES.slice(0, players)) expect(refusal(() => g.act(name, { type: 'ROLL_DICE' })).code).toMatch(/INVALID_PHASE|NOT_YOUR_TURN/);
    expect(refusal(() => g.act('Bilal', { type: 'REQUEST_END_VOTE' })).code).toBe('INVALID_PHASE');

    const balances = g.state.players.map((p) => p.balance);
    const positions = g.state.players.map((p) => p.position);
    castAll(g, need - 1);
    // Not enough to end: the same game, one year longer — nobody's money or place is reset.
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { extraYears: 1, vote: null, lastResult: { kind: 'DURATION', outcome: 'EXTENDED' } } });
    expect(durationLimit(g.state)).toBe(6);
    expect(financialYear(g.state)).toBe(6);
    expect(g.state.players.map((p) => p.balance)).toEqual(balances);
    expect(g.state.players.map((p) => p.position)).toEqual(positions);
    const extended = g.results.at(-1)!;
    expect(extended.events.find((e) => e.type === 'END_VOTE_CLOSED')).toMatchObject({ message: 'The game will extend by one financial year — to year 6', payload: { outcome: 'EXTENDED', durationYears: 6 } });
    expect(types(extended).filter((t) => t === 'TURN_STARTED')).toHaveLength(1);
    expect(g.current).toBe('Bilal');

    // The extra year ends in another vote; this time enough players have had enough.
    const again = playOut(g, 6);
    expect(types(again)).toContain('END_VOTE_STARTED');
    expect(vote(g)).toMatchObject({ kind: 'DURATION', year: 6, required: need });
    const worth = g.state.players.map((p) => ({ playerId: p.id, netWorth: netWorth(g.state, p.id) })).sort((a, b) => b.netWorth - a.netWorth);
    castAll(g, need);
    expect(g.state.status).toBe('FINISHED');
    const last = g.results.at(-1)!;
    expect(finished(last)).toEqual({ reason: 'DURATION_VOTE', winnerId: g.state.winnerId, standings: worth });
    expect(types(last)).not.toContain('TURN_STARTED');
  });

  it('nobody votes: the game goes on for one more year (a missing ballot ends nothing)', () => {
    const g = table(3, { mode });
    playOut(g, 5);
    const voteId = vote(g).id;
    expect(refusal(() => g.act('Asha', { type: 'CLOSE_END_VOTE', voteId })).code).toBe('INVALID_PHASE');
    g.advance(END_VOTE_SECONDS);
    g.act('Chitra', { type: 'CLOSE_END_VOTE', voteId });
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { extraYears: 1, lastResult: { outcome: 'EXTENDED' } } });
    expect(g.current).toBe('Bilal');
  });

  it('year 10 is the end: a ten-year game finishes there with no vote, and nothing extends a game to year 11', () => {
    const ten = table(3, { mode, config: { durationYears: 10 } });
    playOut(ten, 9);
    expect(ten.state.endGame!.vote).toBeNull();
    const r = playOut(ten, 10);
    expect(types(r)).not.toContain('END_VOTE_STARTED');
    expect(finished(r).reason).toBe('DURATION_REACHED');
    expect(ten.state).toMatchObject({ status: 'FINISHED', endGame: { extraYears: 0, vote: null } });

    // Nine years chosen, extended once: the tenth is the last, whatever anyone would vote.
    const nine = table(2, { mode, config: { durationYears: 9 } });
    playOut(nine, 9);
    castAll(nine, 0);
    expect(durationLimit(nine.state)).toBe(10);
    expect(refusal(() => nine.act('Asha', { type: 'REQUEST_END_VOTE' })).message).toMatch(/last financial year/);
    expect(finished(playOut(nine, 10)).reason).toBe('DURATION_REACHED');
    expect(nine.state.endGame!.extraYears).toBe(1);
  });

  it('a seven-year game: early votes in years 1–6, the automatic vote only when year 7 is over', () => {
    const g = table(2, { mode, config: { durationYears: 7 } });
    for (const year of [1, 2, 3, 4, 5, 6]) {
      expect(endVoteRequestBlocker(g.state, g.id('Bilal'))).toBeNull();
      expect(types(playOut(g, year))).not.toContain('END_VOTE_STARTED');
      expect(g.state.status).toBe('ACTIVE');
    }
    expect(financialYear(g.state)).toBe(7);
    expect(types(playOut(g, 7))).toContain('END_VOTE_STARTED');
  });

  it('a player who leaves during the vote does not start the next turn or change what is needed', () => {
    const g = table(4, { mode });
    playOut(g, 5);
    const voteId = vote(g).id;
    // The player whose turn had just ended walks away: the turn still waits for the result.
    const left = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(types(left)).not.toContain('TURN_STARTED');
    expect(vote(g)).toMatchObject({ id: voteId, required: 2 });
    expect(vote(g).electorate).toHaveLength(4);
    for (const name of ['Bilal', 'Chitra', 'Dev']) g.act(name, { type: 'CAST_END_VOTE', voteId, choice: 'CONTINUE' });
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: { extraYears: 1 } });
    expect(g.current).toBe('Bilal');
  });
});

describe('the financial year around the vote (Capital)', () => {
  const marketOf = (g: TestGame) => JSON.stringify(g.state.intermediate!.market);

  it('the year after the last one does not begin until the players have voted to play it — and never if they end the game', () => {
    const g = table(2, { mode: 'intermediate', config: { secretObjectives: false } });
    setClockBeforeEndOf(g, 5, 3);
    const market = marketOf(g);
    g.placeAt('Asha', BOARD_SIZE - 3);
    const crossing = g.roll('Asha', 1, 2);
    // The dice have passed the end of year 5; the calendar waits there.
    expect(calendarYear(g.state)).toBe(6);
    expect(g.state.intermediate!.year).toBe(5);
    expect(types(crossing)).not.toContain('FINANCIAL_YEAR_STARTED');
    expect(marketOf(g)).toBe(market);
    g.act('Asha', { type: 'END_TURN' });
    // One END of two is enough after the duration; the result is applied when both have voted.
    g.act('Asha', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'CONTINUE' });
    const ended = g.act('Bilal', { type: 'CAST_END_VOTE', voteId: vote(g).id, choice: 'END' });
    expect(g.state.status).toBe('FINISHED');
    expect(types(ended)).not.toContain('FINANCIAL_YEAR_STARTED');
    expect(g.state.intermediate!.year).toBe(5);
    expect(marketOf(g)).toBe(market);
  });

  it('extending starts that year once — one market change, the calendar back in step with the clock', () => {
    const g = table(2, { mode: 'intermediate' });
    playOut(g, 5);
    castAll(g, 0);
    const eco = g.state.intermediate!;
    expect(eco.year).toBe(6);
    expect(eco.year).toBe(yearAt(eco, gameClock(eco)));
    expect(eco.lastReport?.year).toBe(6);
    const started = g.results.flatMap((r) => r.events).filter((e) => e.type === 'FINANCIAL_YEAR_STARTED');
    expect(started.map((e) => e.payload.year)).toEqual([6]);
    // The next roll is an ordinary one: no second year 6, nothing counted twice.
    const next = g.roll('Bilal', 1, 1);
    expect(types(next)).not.toContain('FINANCIAL_YEAR_STARTED');
    expect(g.state.intermediate!.year).toBe(6);
  });

  it('a retried or repeated roll result cannot count a year twice: the year only follows the clock', () => {
    const g = table(2, { mode: 'intermediate' });
    const first = playOut(g, 1);
    expect(types(first)).not.toContain('END_VOTE_STARTED');
    expect(g.state.intermediate!.year).toBe(2);
    expect(g.results.flatMap((r) => r.events).filter((e) => e.type === 'FINANCIAL_YEAR_STARTED')).toHaveLength(1);
    expect(refusal(() => g.act('Asha', { type: 'ROLL_DICE' })).code).toBe('NOT_YOUR_TURN');
    expect(g.state.intermediate!.year).toBe(2);
  });
});

describe('a paused table', () => {
  it('a vote that opens while the game is paused waits, and gets its full time back on resume', () => {
    const g = table(3);
    setClockBeforeEndOf(g, 5, 3);
    g.placeAt('Asha', BOARD_SIZE - 3);
    g.roll('Asha', 1, 2);
    g.act('Bilal', { type: 'PAUSE_GAME' });
    // Asha walks away mid-turn: her turn is over, which is where the duration is settled.
    g.act('Asha', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('PAUSED');
    const opened = vote(g);
    expect(opened.kind).toBe('DURATION');
    expect(refusal(() => g.act('Bilal', { type: 'CAST_END_VOTE', voteId: opened.id, choice: 'END' })).code).toBe('GAME_PAUSED');
    g.advance(600);
    g.act('Chitra', { type: 'RESUME_GAME' });
    expect(Date.parse(vote(g).endsAt) - g.nowMs).toBe(END_VOTE_SECONDS * 1000);
    g.act('Bilal', { type: 'CAST_END_VOTE', voteId: opened.id, choice: 'END' });
    g.act('Chitra', { type: 'CAST_END_VOTE', voteId: opened.id, choice: 'CONTINUE' });
    expect(g.state.status).toBe('FINISHED');
  });
});

describe('matchmade games are unchanged', () => {
  it.each(MODES)('%s: no duration, no votes — the game plays past year 5 and past year 10', (mode) => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { start: false, mode });
    g.queueRandom(...keepOrder(3));
    g.absorbResult(startHostlessGame(g.state, g.ctx()));
    expect(g.state).toMatchObject({ status: 'ACTIVE', hostPlayerId: null, endGame: null });
    expect(hasGameDuration(g.state)).toBe(false);
    for (const p of g.state.players) expect(refusal(() => applyAction(g.state, p.id, { type: 'REQUEST_END_VOTE' }, g.ctx()))).toEqual({ code: 'VOTE_NOT_ALLOWED', message: 'This game has no end-game votes.' });
    if (mode === 'intermediate') {
      for (const year of [5, 10, 11]) {
        setClockBeforeEndOf(g, year, 3);
        const name = g.current;
        g.placeAt(name, BOARD_SIZE - 3);
        const rolled = g.roll(name, 1, 2);
        // The calendar is never held back: the next year starts with the roll, as it always has.
        expect(g.state.intermediate!.year).toBe(year + 1);
        expect(types(rolled)).toContain('FINANCIAL_YEAR_STARTED');
        const ended = g.act(name, { type: 'END_TURN' });
        expect(types(ended)).toEqual(['TURN_STARTED']);
      }
    } else {
      for (let i = 0; i < 12; i += 1) {
        const name = g.current;
        g.placeAt(name, BOARD_SIZE - 3);
        g.roll(name, 1, 2);
        expect(types(g.act(name, { type: 'END_TURN' }))).toEqual(['TURN_STARTED']);
      }
    }
    expect(g.state).toMatchObject({ status: 'ACTIVE', endGame: null });
  });
});

describe('a hosted game that was already running when durations were introduced', () => {
  const legacy = (g: TestGame): GameState => {
    const { endGame: _dropped, ...rest } = g.state;
    return rest as GameState;
  };

  it('gets the default five years the first time anyone acts, and its votes work from then on', () => {
    const g = table(3);
    g.state = legacy(g);
    expect(hasGameDuration(g.state)).toBe(true);
    expect(durationLimit(g.state)).toBe(5);
    g.act('Asha', { type: 'ROLL_DICE' });
    expect(g.state.endGame).toMatchObject({ extraYears: 0, calendar: { playerCount: 3 }, vote: null });
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 100 });
  });

  it('a Capital game already past its fifth year is not asked to vote for each year it has played', () => {
    const g = table(2, { mode: 'intermediate' });
    setClockBeforeEndOf(g, 8, 20);
    g.state = legacy(g);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 });
    expect(g.state.endGame).toMatchObject({ extraYears: 3, vote: null });
    expect(durationLimit(g.state)).toBe(8);
    expect(g.state.intermediate!.year).toBe(8);
  });
});
