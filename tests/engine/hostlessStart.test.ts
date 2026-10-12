import { describe, expect, it } from 'vitest';
import { applyAction, BUSINESS_MVP_RULES, ledgerViolations, startHostlessGame, type EngineContext } from '@/engine/index.ts';
import { orderRandoms, TestGame, testId } from './harness.ts';

/** A game the server assembled (public matchmaking): started by the server, and nobody is its host. */
function ctx(randoms: number[] = []): EngineContext {
  const queue = [...randoms];
  return { actionId: testId(), now: '2026-01-01T10:00:05.000Z', random: () => queue.shift() ?? 0.5, newId: testId };
}

describe('startHostlessGame', () => {
  it('starts the game exactly as the host would, then leaves the table without a host', () => {
    const names = ['Asha', 'Bilal', 'Chitra', 'Dev'];
    const hosted = new TestGame(names, { start: false });
    const hostless = new TestGame(names, { start: false });
    const draw = orderRandoms(names, ['Chitra', 'Asha', 'Dev', 'Bilal']);
    const byHost = applyAction(hosted.state, hosted.id('Asha'), { type: 'START_GAME' }, ctx(draw));
    const byServer = startHostlessGame(hostless.state, ctx(draw));

    expect(byServer.state.status).toBe('ACTIVE');
    expect(byServer.state.hostPlayerId).toBeNull();
    expect(byServer.state.players.every((p) => !p.isHost)).toBe(true);
    // Same draw, same order, same cash, same first turn.
    expect(byServer.state.players.map((p) => p.name)).toEqual(byHost.state.players.map((p) => p.name));
    expect(byServer.state.players.map((p) => p.balance)).toEqual(byHost.state.players.map((p) => p.balance));
    expect(byServer.state.players.every((p) => p.balance === BUSINESS_MVP_RULES.startingCash)).toBe(true);
    expect(hostless.state.players.find((p) => p.id === byServer.state.turn.playerId)?.name).toBe(
      hosted.state.players.find((p) => p.id === byHost.state.turn.playerId)?.name,
    );
    expect(byServer.transactions.map((t) => t.type)).toEqual(byHost.transactions.map((t) => t.type));
    expect(byServer.events.map((e) => e.type)).toEqual(byHost.events.map((e) => e.type));
    expect(ledgerViolations(byServer.state, byServer.transactions)).toEqual([]);
  });

  it('a Capital table gets its economy and its secret objectives', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { start: false, mode: 'intermediate' });
    const started = startHostlessGame(g.state, ctx());
    expect(started.state.intermediate).not.toBeNull();
    expect(Object.keys(started.state.objectives?.assignments ?? {})).toHaveLength(3);
  });

  it('nobody can end a hostless game for the others, and the turn passes on normally', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    const started = startHostlessGame(g.state, ctx(orderRandoms(['Asha', 'Bilal'], ['Asha', 'Bilal'])));
    for (const p of started.state.players) {
      expect(() => applyAction(started.state, p.id, { type: 'REQUEST_END_VOTE' }, ctx())).toThrow(/no end-game votes/);
    }
    const first = started.state.turn.playerId!;
    const rolled = applyAction(started.state, first, { type: 'ROLL_DICE' }, ctx([0.01, 0.2]));
    expect(rolled.state.turn.hasRolled).toBe(true);
  });

  it('a player leaving a hostless game does not make anyone the host', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { start: false });
    const started = startHostlessGame(g.state, ctx());
    const leaver = started.state.players[0]!;
    const after = applyAction(started.state, leaver.id, { type: 'LEAVE_GAME' }, ctx());
    expect(after.state.hostPlayerId).toBeNull();
    expect(after.state.players.every((p) => !p.isHost)).toBe(true);
    expect(after.state.status).toBe('ACTIVE');
  });

  it('refuses a game that has started, has too few players, or has nobody to start it', () => {
    const running = new TestGame(['Asha', 'Bilal']);
    expect(() => startHostlessGame(running.state, ctx())).toThrow(/already started/);
    const alone = new TestGame(['Asha'], { start: false });
    expect(() => startHostlessGame(alone.state, ctx())).toThrow(/at least/);
    const two = new TestGame(['Asha', 'Bilal'], { start: false });
    const once = startHostlessGame(two.state, ctx());
    expect(() => startHostlessGame(once.state, ctx())).toThrow(/already started/);
  });
});
