/// <reference types="jest" />
/**
 * UI for game duration and end-game votes: the duration selector on Create Game, "Your Game Plan"
 * at the start, the vote request in More, and the vote card every player sees (EndVoteHost).
 * The rules themselves are tested in tests/engine/gameEnd.test.ts; here it is what a phone shows
 * and what it sends.
 */
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { BOARD_SIZE, INTERMEDIATE_RULES as IR, netWorth, redactEndVote, startHostlessGame, totalDebt, type GameMode, type GameSnapshot } from '@/engine/index.ts';
import { INTRO_SEEN_KEY } from '@/features/finance/IntermediateIntro';
import { EndVoteHost } from '@/features/game/EndVote';
import { GAME_PLAN_SEEN_KEY, gamePlanSeenValue } from '@/features/game/GamePlanIntro';
import { GameScreen } from '@/features/game/GameScreen';
import type { GameView } from '@/features/game/useGameView';
import { LobbyView } from '@/features/lobby/LobbyView';
import { OBJECTIVE_SEEN_KEY } from '@/features/objectives/ObjectiveReveal';
import { gameApi } from '@/lib/gameApi';
import { resetServerClock } from '@/lib/serverClock';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import CreateGame from '../../app/create-game';
import { Fixture, ok } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const MODES: GameMode[] = ['classic', 'intermediate'];

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
  const current = snapshot.state.players.find((p) => p.id === snapshot.state.turn.playerId) ?? null;
  return {
    snapshot,
    me,
    current,
    isMyTurn: !!me && current?.id === me.id && snapshot.state.status === 'ACTIVE',
    isHost: !!me?.isHost,
    playerName: (id) => snapshot.state.players.find((p) => p.id === id)?.name ?? 'Bank',
    myNetWorth: me ? netWorth(snapshot.state, me.id) : 0,
    myDebt: me ? totalDebt(snapshot.state, me.id) : 0,
  };
}

/** What the server sends `name`'s phone: the snapshot with everyone else's ballot removed. */
const sentTo = (f: Fixture, name: string): GameSnapshot => ({ ...f.snapshot(), state: redactEndVote(f.state, f.ids[name]!) });

/** Loads the game on `name`'s phone exactly as the server would send it: this phone never holds anyone else's ballot. */
function phoneOf(f: Fixture, name: string): Fixture {
  useSessionStore.setState({ session: { gameId: f.state.id, playerId: f.ids[name]!, token: 'a'.repeat(64) }, hydrated: true });
  useGameStore.getState().reset(f.state.id);
  useGameStore.getState().applySnapshot(sentTo(f, name));
  useGameStore.getState().setConnection('live');
  return f;
}

/** Plays the last roll of financial year `year` and ends that turn (test surgery on the dice clock). */
function playOut(f: Fixture, year: number): Fixture {
  const eco = f.state.intermediate;
  const movement = eco ? eco.movement : f.state.endGame!.calendar!.movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = year * ids.length * IR.year.spacesPerYear - 3;
  if (eco) eco.year = year;
  const current = f.state.players.find((p) => p.id === f.state.turn.playerId)!;
  current.position = BOARD_SIZE - 3;
  return f.roll(current.name, 1, 2).act(current.name, { type: 'END_TURN' });
}

const vote = (f: Fixture) => f.state.endGame!.vote!;
const press = async (testID: string) => fireEvent.press(screen.getByTestId(testID));

beforeEach(async () => {
  jest.clearAllMocks();
  resetServerClock();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  await SecureStore.setItemAsync(INTRO_SEEN_KEY, '1');
  await SecureStore.deleteItemAsync(OBJECTIVE_SEEN_KEY);
  await SecureStore.deleteItemAsync(GAME_PLAN_SEEN_KEY);
});

// ---------------------------------------------------------------------------

describe('Create game: the duration', () => {
  it('offers 5 to 10 financial years, 5 chosen, and says what the choice means', async () => {
    await render(<CreateGame />);
    const row = screen.getByTestId('config-duration');
    expect(within(row).getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([5, 6, 7, 8, 9, 10].map((n) => `${n} financial years`));
    expect(screen.getByTestId('config-duration-5').props.accessibilityState.selected).toBe(true);
    expect(within(screen.getByTestId('game-settings')).getByText('Game duration')).toBeTruthy();
    expect(screen.getByTestId('config-duration-value')).toHaveTextContent('5 financial years · Approximately 5 laps');
    expect(screen.getByTestId('config-duration-hint')).toHaveTextContent('Choose how many financial years the game will run before players vote to finish or extend it.');
    await press('config-duration-7');
    expect(screen.getByTestId('config-duration-7').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('config-duration-value')).toHaveTextContent('7 financial years · Approximately 7 laps');
    await press('config-duration-10');
    expect(screen.getByTestId('config-duration-value')).toHaveTextContent('10 financial years · Approximately 10 laps');
    // The review the host reads before creating shows it too.
    expect(screen.getByTestId('game-review')).toHaveTextContent(/Game duration\s*10 financial years/);
  });

  it.each(MODES)('%s: the chosen duration is sent with the game, and survives switching the mode', async (mode) => {
    const f = new Fixture(['Tanmay'], { start: false, mode, config: { durationYears: 8 } });
    api.create.mockResolvedValue(ok(f.snapshot()));
    await render(<CreateGame />);
    await press('config-duration-8');
    await press('game-mode-intermediate');
    if (mode === 'classic') await press('game-mode-classic');
    expect(screen.getByTestId('config-duration-8').props.accessibilityState.selected).toBe(true);
    await fireEvent.changeText(screen.getByTestId('host-name'), 'Tanmay');
    await press('create-confirm');
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]![3]).toBe(mode);
    expect(api.create.mock.calls[0]![4]).toMatchObject({ durationYears: 8 });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/lobby/${f.state.id}`));
  });

  it('Restore defaults puts it back to 5', async () => {
    await render(<CreateGame />);
    await press('config-duration-9');
    expect(screen.getByTestId('config-restore-defaults').props.accessibilityState.disabled).toBe(false);
    await press('config-restore-defaults');
    expect(screen.getByTestId('config-duration-5').props.accessibilityState.selected).toBe(true);
  });
});

describe('Lobby: every player reads the same duration', () => {
  it.each(['Asha', 'Bilal'])('%s sees the host’s choice; only the host can open the editor', async (name) => {
    const f = new Fixture(['Asha', 'Bilal'], { start: false, config: { durationYears: 7 } }).loadAs(name);
    await render(<LobbyView view={viewFor(f, name)} />);
    expect(screen.getByTestId('lobby-rules')).toHaveTextContent(/Game duration\s*7 financial years/);
    expect(!!screen.queryByTestId('lobby-edit-config')).toBe(name === 'Asha');
  });
});

describe('Your Game Plan: the duration is announced when the game starts', () => {
  it.each(MODES)('%s: every player is shown the selected duration, once', async (mode) => {
    for (const name of ['Asha', 'Bilal']) {
      const f = new Fixture(['Asha', 'Bilal'], { mode, config: { durationYears: 7, secretObjectives: false } }).loadAs(name, { planSeen: false });
      const view = await render(<GameScreen view={viewFor(f, name)} />);
      const plan = await screen.findByTestId('game-plan');
      expect(within(plan).getByText('Your game plan')).toBeTruthy();
      expect(within(plan).getByTestId('game-plan-line-1')).toHaveTextContent('· Duration: 7 financial years');
      expect(within(plan).getByTestId('game-plan-line-2')).toHaveTextContent('· Approximately 7 laps');
      expect(within(plan).getByTestId('game-plan-line-3')).toHaveTextContent('· After the selected duration, players will vote to end the game or extend it by one financial year.');
      expect(within(plan).getByTestId('game-plan-line-4')).toHaveTextContent('· Players may also request an early-ending vote during the game.');
      await press('game-plan-done');
      expect(screen.queryByTestId('game-plan')).toBeNull();
      expect(await SecureStore.getItemAsync(GAME_PLAN_SEEN_KEY)).toBe(gamePlanSeenValue(f.state.id, f.ids[name]!));
      await view.unmount();
      // Opening the game again does not repeat it.
      const again = await render(<GameScreen view={viewFor(f, name)} />);
      await act(async () => {});
      expect(screen.queryByTestId('game-plan')).toBeNull();
      await again.unmount();
    }
  });

  it('a ten-year game says it ends there, and promises no extension', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { config: { durationYears: 10 } }).loadAs('Bilal', { planSeen: false });
    await render(<GameScreen view={viewFor(f, 'Bilal')} />);
    const plan = await screen.findByTestId('game-plan');
    expect(plan).toHaveTextContent(/Duration: 10 financial years/);
    expect(plan).toHaveTextContent(/10 financial years is the longest a game can run: it ends when they are over\./);
    expect(plan).not.toHaveTextContent(/extend it by one financial year/);
  });

  it('comes before the secret objective, says nothing about it, and the objective still follows', async () => {
    const f = new Fixture(['Asha', 'Bilal'], { mode: 'intermediate' }).loadAs('Asha', { planSeen: false });
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    const plan = await screen.findByTestId('game-plan');
    expect(screen.queryByTestId('objective-reveal')).toBeNull();
    expect(plan).not.toHaveTextContent(/objective/i);
    await press('game-plan-done');
    expect(await screen.findByTestId('objective-reveal')).toBeTruthy();
  });

  it('never blocks the game: the table is there underneath, and Android back dismisses it', async () => {
    const f = new Fixture().loadAs('Asha', { planSeen: false });
    await render(<GameScreen view={viewFor(f, 'Asha')} />);
    let modal = (await screen.findByTestId('game-plan')).parent;
    expect(screen.getByTestId('classic-board')).toBeTruthy();
    while (modal && modal.type !== 'Modal') modal = modal.parent;
    await fireEvent(modal!, 'requestClose');
    expect(screen.queryByTestId('game-plan')).toBeNull();
  });

  it('a matchmade game shows no plan, no duration and no vote request', async () => {
    const lobby = new Fixture(['Asha', 'Bilal'], { start: false });
    lobby.state = startHostlessGame(lobby.state, { ...lobby.ctx(), random: () => 0.999 }).state;
    lobby.loadAs('Asha', { planSeen: false });
    await render(<GameScreen view={viewFor(lobby, 'Asha')} />);
    await act(async () => {});
    expect(screen.queryByTestId('game-plan')).toBeNull();
    expect(screen.queryByTestId('duration-indicator')).toBeNull();
    expect(screen.getByTestId('game-header')).toHaveTextContent(/Classic · India/);
    await press('open-more');
    expect(screen.getByTestId('leave-game-button')).toBeTruthy();
    expect(screen.queryByTestId('request-end-vote')).toBeNull();
    await press('open-config');
    expect(screen.getByTestId('config-summary')).not.toHaveTextContent(/Game duration/);
  });
});

describe('More → Request End-Game Vote', () => {
  it('is unavailable, with the reason, in the last financial year and once I have asked this year', async () => {
    const last = playOut(playOut(playOut(playOut(new Fixture(), 1), 2), 3), 4).loadAs('Asha');
    const first = await render(<GameScreen view={viewFor(last, 'Asha')} />);
    expect(screen.getByTestId('duration-indicator')).toHaveTextContent('Classic · Year 5 of 5');
    await press('open-more');
    expect(screen.getByTestId('request-end-vote').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('request-end-vote')).toHaveTextContent(/This is the last financial year\. Everyone votes when it ends\./);
    await first.unmount();

    const asked = new Fixture(['Asha', 'Bilal', 'Chitra']).act('Asha', { type: 'REQUEST_END_VOTE' });
    for (const name of ['Bilal', 'Chitra']) asked.act(name, { type: 'CAST_END_VOTE', voteId: vote(asked).id, choice: 'CONTINUE' });
    asked.loadAs('Asha');
    const second = await render(<GameScreen view={viewFor(asked, 'Asha')} />);
    await press('open-more');
    expect(screen.getByTestId('request-end-vote').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('request-end-vote')).toHaveTextContent(/You have already asked for a vote this financial year/);
    await second.unmount();
    // Bilal has not asked: his is still available.
    asked.loadAs('Bilal');
    await render(<GameScreen view={viewFor(asked, 'Bilal')} />);
    await press('open-more');
    expect(screen.getByTestId('request-end-vote').props.accessibilityState.disabled).toBe(false);
  });

  it('a player who is out of the game is not offered it', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']);
    f.state.players.find((p) => p.name === 'Chitra')!.status = 'BANKRUPT';
    f.loadAs('Chitra');
    await render(<GameScreen view={viewFor(f, 'Chitra')} />);
    await press('open-more');
    expect(screen.queryByTestId('request-end-vote')).toBeNull();
    expect(screen.getByTestId('leave-game-button')).toBeTruthy();
  });
});

describe('the early vote, on each player’s phone', () => {
  const open = () => new Fixture(['Asha', 'Bilal', 'Chitra']).act('Asha', { type: 'REQUEST_END_VOTE' });

  it('asks the question, offers the two choices and counts down from the server’s deadline', async () => {
    const f = phoneOf(open(), 'Bilal');
    await render(<EndVoteHost />);
    const card = screen.getByTestId('end-vote');
    expect(within(card).getByTestId('end-vote-title')).toHaveTextContent('End this game early?');
    expect(within(card).getByText('A strict majority must vote to end the game.')).toBeTruthy();
    expect(within(card).getByTestId('end-vote-detail')).toHaveTextContent('Asha asked for this vote. 2 of 3 players must vote to end. Votes are secret.');
    expect(within(card).getByTestId('end-vote-end')).toHaveTextContent('End Game');
    expect(within(card).getByTestId('end-vote-continue')).toHaveTextContent('Continue Playing');
    expect(within(card).getByTestId('end-vote-countdown')).toHaveTextContent(/^0:(30|29)$/);
    expect(screen.queryByTestId('end-vote-mine')).toBeNull();
    // Not a word about who has voted, or how: this phone was never sent it.
    expect(JSON.stringify(useGameStore.getState().snapshot!.state.endGame)).not.toMatch(/"END"|"CONTINUE"/);
    expect(vote(f).ballots).toEqual({ [f.ids.Asha!]: 'END' });
  });

  it.each([
    ['end-vote-end', 'END', 'End Game'],
    ['end-vote-continue', 'CONTINUE', 'Continue Playing'],
  ] as const)('%s sends one %s ballot for this vote, then shows only my own submitted vote', async (button, choice, label) => {
    const f = phoneOf(open(), 'Bilal');
    const voteId = vote(f).id;
    f.act('Bilal', { type: 'CAST_END_VOTE', voteId, choice });
    api.action.mockResolvedValue(ok(sentTo(f, 'Bilal')));
    await render(<EndVoteHost />);
    await press(button);
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1));
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'CAST_END_VOTE', voteId, choice });
    const mine = await screen.findByTestId('end-vote-mine');
    expect(mine).toHaveTextContent(new RegExp(`Your vote\\s*${label}\\s*Submitted\\. Waiting for the other players\\.`));
    // Locked: there is nothing left to press.
    expect(screen.queryByTestId('end-vote-end')).toBeNull();
    expect(screen.queryByTestId('end-vote-continue')).toBeNull();
    expect(screen.getByTestId('end-vote')).not.toHaveTextContent(/Asha voted|Chitra voted|1 of|votes so far/i);
  });

  it('the player who asked sees their own END ballot already in; the host sees no more than anyone else', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra']).act('Bilal', { type: 'REQUEST_END_VOTE' });
    phoneOf(f, 'Bilal');
    const asker = await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-mine')).toHaveTextContent(/Your vote\s*End Game/);
    expect(screen.getByTestId('end-vote-detail')).toHaveTextContent(/^You asked for this vote\./);
    await asker.unmount();
    // Asha is the host. Chitra has voted meanwhile; nothing on Asha's phone says so.
    f.act('Chitra', { type: 'CAST_END_VOTE', voteId: vote(f).id, choice: 'CONTINUE' });
    phoneOf(f, 'Asha');
    await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-end')).toBeTruthy();
    expect(screen.queryByTestId('end-vote-mine')).toBeNull();
    expect(useGameStore.getState().snapshot!.state.endGame!.vote!.ballots).toEqual({});
  });

  it('reopening the app mid-vote shows the same vote: the time really left, and my ballot', async () => {
    const f = open();
    // Bilal voted before the app was closed (Chitra has not, so the vote is still open).
    f.state.endGame!.vote!.ballots[f.ids.Bilal!] = 'CONTINUE';
    // Twelve seconds of the thirty have gone by on the server's clock.
    f.state.endGame!.vote!.endsAt = new Date(Date.now() + 18_000).toISOString();
    phoneOf(f, 'Bilal');
    const firstLaunch = await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-countdown')).toHaveTextContent(/^0:1[78]$/);
    expect(screen.getByTestId('end-vote-mine')).toHaveTextContent(/Continue Playing/);
    await firstLaunch.unmount();
    useGameStore.getState().reset(null);
    phoneOf(f, 'Bilal');
    await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-countdown')).toHaveTextContent(/^0:1[78]$/);
    expect(screen.getByTestId('end-vote-mine')).toHaveTextContent(/Continue Playing/);
    expect(api.action).not.toHaveBeenCalled();
  });

  it('when the deadline has passed the phone asks the server to close the vote — the server decides', async () => {
    const f = open();
    f.state.endGame!.vote!.endsAt = new Date(Date.now() - 1000).toISOString();
    phoneOf(f, 'Asha');
    api.action.mockResolvedValue({ ok: false, error: { code: 'VOTE_CLOSED', message: 'That vote has closed.' } });
    await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-countdown')).toHaveTextContent('0:00');
    expect(screen.getByText('Voting has ended. Counting…')).toBeTruthy();
    await waitFor(() => expect(api.action).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.action.mock.calls[0]![3]).toEqual({ type: 'CLOSE_END_VOTE', voteId: vote(f).id });
    // Already closed by someone else: it does not keep asking.
    await act(async () => new Promise((r) => setTimeout(r, 1300)));
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('a player who is out of the game watches; they are given nothing to vote with', async () => {
    const f = new Fixture(['Asha', 'Bilal', 'Chitra', 'Dev']);
    f.state.players.find((p) => p.name === 'Dev')!.status = 'BANKRUPT';
    phoneOf(f.act('Asha', { type: 'REQUEST_END_VOTE' }), 'Dev');
    await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote-watching')).toHaveTextContent('The active players are voting.');
    expect(screen.queryByTestId('end-vote-end')).toBeNull();
    expect(screen.getByTestId('end-vote-detail')).toHaveTextContent(/2 of 3 players must vote to end/);
  });
});

describe('the result, on every phone that saw the vote', () => {
  it.each(['Asha', 'Bilal', 'Chitra'])('%s: a failed early vote says the game will continue — and not who voted how', async (name) => {
    const f = phoneOf(new Fixture(['Asha', 'Bilal', 'Chitra']).act('Asha', { type: 'REQUEST_END_VOTE' }), name);
    await render(<EndVoteHost />);
    expect(screen.getByTestId('end-vote')).toBeTruthy();
    for (const voter of ['Bilal', 'Chitra']) f.act(voter, { type: 'CAST_END_VOTE', voteId: vote(f).id, choice: 'CONTINUE' });
    await act(async () => useGameStore.getState().applySnapshot(sentTo(f, name)));
    expect(screen.queryByTestId('end-vote')).toBeNull();
    const result = screen.getByTestId('end-vote-result');
    expect(within(result).getByTestId('end-vote-result-title')).toHaveTextContent('Game will continue');
    expect(result).not.toHaveTextContent(/Asha|Bilal|Chitra|\d of \d/);
    await press('end-vote-result-ok');
    expect(screen.queryByTestId('end-vote-result')).toBeNull();
  });

  it('a passed vote says the game ending was approved, on the finished game', async () => {
    const f = phoneOf(new Fixture(['Asha', 'Bilal']).act('Asha', { type: 'REQUEST_END_VOTE' }), 'Bilal');
    await render(<EndVoteHost />);
    f.act('Bilal', { type: 'CAST_END_VOTE', voteId: vote(f).id, choice: 'END' });
    expect(f.state.status).toBe('FINISHED');
    await act(async () => useGameStore.getState().applySnapshot(sentTo(f, 'Bilal')));
    expect(screen.getByTestId('end-vote-result-title')).toHaveTextContent('Game ending approved');
  });

  it('a phone that never saw the vote open is not shown an old result', async () => {
    const f = new Fixture(['Asha', 'Bilal']).act('Asha', { type: 'REQUEST_END_VOTE' });
    f.act('Bilal', { type: 'CAST_END_VOTE', voteId: vote(f).id, choice: 'CONTINUE' });
    phoneOf(f, 'Bilal');
    await render(<EndVoteHost />);
    expect(screen.queryByTestId('end-vote')).toBeNull();
    expect(screen.queryByTestId('end-vote-result')).toBeNull();
  });
});

describe.each(MODES)('the finish-or-extend vote (%s)', (mode) => {
  it('opens by itself when the selected duration is over, with its own question and choices', async () => {
    const f = phoneOf(playOut(new Fixture(['Asha', 'Bilal', 'Chitra'], { mode, config: { secretObjectives: false } }), 5), 'Chitra');
    expect(vote(f)).toMatchObject({ kind: 'DURATION', required: 1 });
    await render(<EndVoteHost />);
    const card = screen.getByTestId('end-vote');
    expect(within(card).getByTestId('end-vote-title')).toHaveTextContent('What should happen next?');
    expect(within(card).getByText('Your selected game duration has ended.')).toBeTruthy();
    expect(within(card).getByTestId('end-vote-end')).toHaveTextContent('End Game');
    expect(within(card).getByTestId('end-vote-continue')).toHaveTextContent('Play One More Financial Year');
    expect(within(card).getByTestId('end-vote-detail')).toHaveTextContent('1 of 3 players must vote to end. Votes are secret.');
  });

  it('not enough END ballots: every phone is told the game extends by one financial year, and the table shows the new limit', async () => {
    const f = phoneOf(playOut(new Fixture(['Asha', 'Bilal'], { mode, config: { secretObjectives: false } }), 5), 'Asha');
    await render(
      <>
        <GameScreen view={viewFor(f, 'Asha')} />
        <EndVoteHost />
      </>,
    );
    for (const name of ['Asha', 'Bilal']) f.act(name, { type: 'CAST_END_VOTE', voteId: vote(f).id, choice: 'CONTINUE' });
    await act(async () => useGameStore.getState().applySnapshot(sentTo(f, 'Asha')));
    const result = screen.getByTestId('end-vote-result');
    expect(within(result).getByTestId('end-vote-result-title')).toHaveTextContent('The game will extend by one financial year');
    expect(result).toHaveTextContent(/The game now runs for 6 financial years\./);
    expect(f.state.endGame).toMatchObject({ extraYears: 1, vote: null });
  });
});
