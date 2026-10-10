import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES as RULES, GameActionSchema, isGameError, joinGame, type GameErrorCode } from '@/engine/index.ts';
import { TestGame, testId } from './harness.ts';

const NAMES = ['Tanmay', 'Shamin', 'Ram'];
const lobby = (names = NAMES) => new TestGame(names, { start: false });
const eventsOf = (r: { events: { type: string }[] }) => r.events.map((e) => e.type);

function codeOf(run: () => unknown): GameErrorCode | null {
  try {
    run();
    return null;
  } catch (error) {
    if (isGameError(error)) return error.code;
    throw error;
  }
}

const join = (g: TestGame, name: string) => joinGame(g.state, { playerId: testId(), name }, g.ctx());

describe('SET_LOBBY_LOCK: the host closes admission', () => {
  it('a new lobby is open; locking it refuses every join, unlocking takes them again', () => {
    const g = lobby();
    expect(g.state.lobbyLocked).toBe(false);
    const before = g.state.version;

    const locked = g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true });
    expect(eventsOf(locked)).toEqual(['LOBBY_LOCK_CHANGED']);
    expect(locked.events[0]).toMatchObject({ actorId: g.id('Tanmay'), message: 'Tanmay locked the lobby', payload: { locked: true } });
    expect(g.state.lobbyLocked).toBe(true);
    expect(g.state.version).toBe(before + 1);

    expect(codeOf(() => join(g, 'Priya'))).toBe('LOBBY_LOCKED');
    expect(g.state.players).toHaveLength(3);

    const unlocked = g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: false });
    expect(unlocked.events[0]).toMatchObject({ message: 'Tanmay unlocked the lobby', payload: { locked: false } });
    expect(join(g, 'Priya').state.players).toHaveLength(4);
  });

  it('only the host can; setting it to what it already is announces nothing', () => {
    const g = lobby();
    expect(codeOf(() => g.act('Shamin', { type: 'SET_LOBBY_LOCK', locked: true }))).toBe('FORBIDDEN');
    expect(g.state.lobbyLocked).toBe(false);
    expect(eventsOf(g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: false }))).toEqual([]);
    g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true });
    expect(eventsOf(g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true }))).toEqual([]);
    expect(g.state.lobbyLocked).toBe(true);
  });

  it('the lock never stops the players who are already in: ready, settings, leaving and starting all work', () => {
    const g = lobby();
    g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true });
    g.act('Shamin', { type: 'SET_READY', ready: true });
    g.act('Ram', { type: 'LEAVE_GAME' });
    g.queueRandom(0.5, 0.5, 0.5);
    g.act('Tanmay', { type: 'START_GAME' });
    expect(g.state.status).toBe('ACTIVE');
  });

  it('a new host inherits the lock and can lift it', () => {
    const g = lobby();
    g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true });
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.lobbyLocked).toBe(true);
    expect(codeOf(() => g.act('Ram', { type: 'SET_LOBBY_LOCK', locked: false }))).toBe('FORBIDDEN');
    g.act('Shamin', { type: 'SET_LOBBY_LOCK', locked: false });
    expect(g.state.lobbyLocked).toBe(false);
  });

  it('is a lobby action: refused once the game has started, paused or finished', () => {
    const g = new TestGame(NAMES);
    expect(codeOf(() => g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true }))).toBe('INVALID_PHASE');
    g.act('Tanmay', { type: 'PAUSE_GAME' });
    expect(codeOf(() => g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true }))).toBe('GAME_PAUSED');
    g.act('Tanmay', { type: 'END_GAME' });
    expect(codeOf(() => g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true }))).toBe('GAME_FINISHED');
  });

  it('a started game takes no new players whether or not it was locked', () => {
    const g = new TestGame(NAMES);
    expect(codeOf(() => join(g, 'Priya'))).toBe('GAME_NOT_ACTIVE');
  });

  it('the action takes a boolean and nothing else', () => {
    expect(GameActionSchema.safeParse({ type: 'SET_LOBBY_LOCK', locked: true }).success).toBe(true);
    expect(GameActionSchema.safeParse({ type: 'SET_LOBBY_LOCK' }).success).toBe(false);
    expect(GameActionSchema.safeParse({ type: 'SET_LOBBY_LOCK', locked: 'yes' }).success).toBe(false);
    expect(GameActionSchema.safeParse({ type: 'SET_LOBBY_LOCK', locked: true, by: 'someone' }).success).toBe(false);
  });
});

describe('REMOVE_PLAYER: the host takes someone out of the lobby', () => {
  it('the removed player has left: no seat, no vote, and their place is free again', () => {
    const g = lobby();
    const r = g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: g.id('Ram') });
    expect(eventsOf(r)).toEqual(['PLAYER_REMOVED', 'PLAYER_LEFT']);
    expect(r.events[0]).toMatchObject({ actorId: g.id('Tanmay'), message: 'Tanmay removed Ram from the lobby', payload: { playerId: g.id('Ram') } });
    expect(g.state.players.find((p) => p.id === g.id('Ram'))).toMatchObject({ status: 'LEFT', ready: false });
    expect(codeOf(() => g.act('Ram', { type: 'SET_READY', ready: true }))).toBe('FORBIDDEN');
    // The host stays the host; nothing else about the game changed.
    expect(g.state.hostPlayerId).toBe(g.id('Tanmay'));
    expect(g.state.status).toBe('WAITING');
    expect(r.transactions).toHaveLength(0);
  });

  it('frees a place in a full lobby', () => {
    const names = Array.from({ length: RULES.players.max }, (_, i) => `Player ${String.fromCharCode(65 + i)}`);
    const g = lobby(names);
    expect(codeOf(() => join(g, 'Late'))).toBe('GAME_FULL');
    g.act(names[0]!, { type: 'REMOVE_PLAYER', playerId: g.id(names[3]!) });
    expect(join(g, 'Late').state.players.filter((p) => p.status !== 'LEFT')).toHaveLength(RULES.players.max);
  });

  it('only the host, never themselves, only someone who is there', () => {
    const g = lobby();
    expect(codeOf(() => g.act('Shamin', { type: 'REMOVE_PLAYER', playerId: g.id('Ram') }))).toBe('FORBIDDEN');
    expect(codeOf(() => g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: g.id('Tanmay') }))).toBe('VALIDATION');
    expect(codeOf(() => g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: testId() }))).toBe('NOT_FOUND');
    expect(g.state.players.every((p) => p.status === 'ACTIVE')).toBe(true);
  });

  it('removing someone who is already gone (a second tap) changes nothing', () => {
    const g = lobby();
    g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: g.id('Ram') });
    expect(eventsOf(g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: g.id('Ram') }))).toEqual([]);
  });

  it('is a lobby action: once the game has started nobody can be removed', () => {
    const g = new TestGame(NAMES);
    expect(codeOf(() => g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: g.id('Ram') }))).toBe('INVALID_PHASE');
    expect(g.state.players.find((p) => p.id === g.id('Ram'))!.status).toBe('ACTIVE');
  });
});
