import { describe, expect, it } from 'vitest';
import { applyAction, type GameState } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const NAMES = ['Tanmay', 'Shamin', 'Ram', 'Priya']; // Tanmay creates the game (host)

/** Small seeded PRNG (mulberry32) standing in for the server's RNG. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Starts a lobby with `random` as the server RNG and returns the started state. */
function startWithRng(names: string[], random: () => number): GameState {
  const g = new TestGame(names, { start: false });
  return applyAction(g.state, g.id(names[0]!), { type: 'START_GAME' }, { ...g.ctx(), random }).state;
}

const orderOf = (state: GameState) => [...state.players].sort((a, b) => a.seat - b.seat).map((p) => p.name);
const firstOf = (state: GameState) => state.players.find((p) => p.id === state.turn.playerId)!.name;
const seatsOf = (state: GameState) => Object.fromEntries(state.players.map((p) => [p.name, p.seat]));

/** Plays `who`'s turn with no decisions to make (a non-double roll onto Start) and ends it. */
function passTurn(g: TestGame, who: string): void {
  g.placeAt(who, 33);
  g.roll(who, 1, 2);
  g.act(who, { type: 'END_TURN' });
}

describe('random starting player', () => {
  it('the lobby keeps joining order; nobody has the turn before the game starts', () => {
    const g = new TestGame(NAMES, { start: false });
    expect(orderOf(g.state)).toEqual(NAMES);
    expect(g.state.turn.playerId).toBeNull();
  });

  it('the host is not automatically first: the draw decides, and seats follow the draw', () => {
    const g = new TestGame(NAMES, { start: false });
    const r = g.startWith(['Priya', 'Tanmay', 'Ram', 'Shamin']);
    expect(g.state.status).toBe('ACTIVE');
    expect(g.current).toBe('Priya');
    expect(g.state.turn.number).toBe(1);
    expect(orderOf(g.state)).toEqual(['Priya', 'Tanmay', 'Ram', 'Shamin']);
    expect(g.player('Priya').seat).toBe(0);
    expect(g.player('Tanmay')).toMatchObject({ seat: 1, isHost: true });
    expect(g.state.players.map((p) => p.seat).sort()).toEqual([0, 1, 2, 3]);
    const started = r.events.find((e) => e.type === 'GAME_STARTED')!;
    expect(started.message).toBe('Game started! Priya goes first');
    expect(started.payload).toEqual({ firstPlayerId: g.id('Priya'), turnOrder: ['Priya', 'Tanmay', 'Ram', 'Shamin'].map((n) => g.id(n)) });
  });

  it.each([2, 3, 4, 8])('%i players: every player can start, and the host starts no more often than anyone else', (count) => {
    const names = ['Tanmay', 'Shamin', 'Ram', 'Priya', 'Esha', 'Farid', 'Gita', 'Hari'].slice(0, count);
    const random = seeded(20261009 + count);
    const firsts: Record<string, number> = {};
    const orders = new Set<string>();
    for (let i = 0; i < 600 * count; i += 1) {
      const state = startWithRng(names, random);
      expect(new Set(orderOf(state))).toEqual(new Set(names)); // the starter is always a player of this game
      firsts[firstOf(state)] = (firsts[firstOf(state)] ?? 0) + 1;
      orders.add(orderOf(state).join('>'));
    }
    for (const name of names) {
      // Each player is expected to start 600 games; ±25% is far outside chance.
      expect(firsts[name]).toBeGreaterThan(450);
      expect(firsts[name]).toBeLessThan(750);
    }
    if (count <= 4) expect(orders.size).toBe([0, 1, 2, 6, 24][count]); // every ordering occurs
  });

  it('another game can draw another order', () => {
    const a = new TestGame(NAMES, { start: false });
    a.startWith(['Shamin', 'Tanmay', 'Ram', 'Priya']);
    const b = new TestGame(NAMES, { start: false });
    b.startWith(['Priya', 'Ram', 'Shamin', 'Tanmay']);
    expect(orderOf(a.state)).toEqual(['Shamin', 'Tanmay', 'Ram', 'Priya']);
    expect(orderOf(b.state)).toEqual(['Priya', 'Ram', 'Shamin', 'Tanmay']);
  });

  it('starting is atomic: status, order, first player and starting cash all come from the one START_GAME', () => {
    const g = new TestGame(NAMES, { start: false });
    const r = g.startWith(['Ram', 'Priya', 'Tanmay', 'Shamin']);
    expect(r.state.status).toBe('ACTIVE');
    expect(r.state.turn).toMatchObject({ playerId: g.id('Ram'), number: 1, phase: 'AWAITING_ROLL' });
    expect(r.transactions.filter((t) => t.type === 'STARTING_FUNDS')).toHaveLength(4);
  });

  it('the draw happens exactly once: a second START_GAME is rejected and changes nothing', () => {
    const g = new TestGame(NAMES, { start: false });
    g.startWith(['Priya', 'Tanmay', 'Ram', 'Shamin']);
    const before = structuredClone(g.state);
    g.queueRandom(0.1, 0.1, 0.1);
    expect(() => g.act('Tanmay', { type: 'START_GAME' })).toThrow('The game has already started.');
    expect(g.state).toEqual(before);
  });

  it('a client cannot say who starts: START_GAME carries nothing but its type', () => {
    const g = new TestGame(NAMES, { start: false });
    for (const extra of [{ firstPlayerId: g.id('Tanmay') }, { turnOrder: [g.id('Tanmay')] }, { seat: 0 }]) {
      expect(() => applyAction(g.state, g.id('Tanmay'), { type: 'START_GAME', ...extra }, g.ctx())).toThrow('That action is not valid.');
    }
    expect(g.state.status).toBe('WAITING');
  });
});

describe('turn rotation on the drawn order', () => {
  const ORDER = ['Priya', 'Tanmay', 'Ram', 'Shamin'];

  function started(): TestGame {
    const g = new TestGame(NAMES, { start: false });
    g.startWith(ORDER);
    return g;
  }

  it('turns follow the drawn order and wrap around', () => {
    const g = started();
    const seen: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      seen.push(g.current);
      passTurn(g, g.current);
    }
    expect(seen).toEqual([...ORDER, ...ORDER, 'Priya']);
    expect(g.state.turn.number).toBe(10);
  });

  it('nothing after START_GAME redraws it: later RNG use, pause/resume, or reloading the stored state', () => {
    const g = started();
    const drawn = seatsOf(g.state);
    passTurn(g, 'Priya'); // dice come from the same RNG
    g.act('Ram', { type: 'PAUSE_GAME' });
    g.act('Shamin', { type: 'RESUME_GAME' });
    // What a reconnecting phone is served: the persisted state, read back.
    g.state = JSON.parse(JSON.stringify(g.state)) as GameState;
    expect(seatsOf(g.state)).toEqual(drawn);
    expect(g.current).toBe('Tanmay');
    passTurn(g, 'Tanmay');
    expect(g.current).toBe('Ram');
    expect(seatsOf(g.state)).toEqual(drawn);
  });

  it('a bankrupt player is skipped; the others keep their drawn order and the host gains nothing', () => {
    const g = started(); // Priya → Tanmay → Ram → Shamin
    passTurn(g, 'Priya');
    passTurn(g, 'Tanmay');
    // Ram gives away all his cash, then owes rent he cannot pay.
    g.act('Ram', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Priya'), amount: g.balance('Ram') });
    g.give('Shamin', 'DELHI');
    g.placeBefore('Ram', 'DELHI', 3);
    g.roll('Ram', 1, 2);
    expect(g.state.turn.phase).toBe('AWAITING_PAYMENT');
    const drawn = seatsOf(g.state);
    g.act('Ram', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.player('Ram').status).toBe('BANKRUPT');
    expect(seatsOf(g.state)).toEqual(drawn); // no re-draw
    const seen: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      seen.push(g.current);
      passTurn(g, g.current);
    }
    expect(seen).toEqual(['Shamin', 'Priya', 'Tanmay', 'Shamin', 'Priya', 'Tanmay', 'Shamin']);
  });

  it('Rest House skips still work on a drawn order', () => {
    const g = started();
    g.placeAt('Priya', 21);
    g.roll('Priya', 3, 3); // 27 Rest House: Priya misses her next turn
    g.act('Priya', { type: 'END_TURN' });
    for (const who of ['Tanmay', 'Ram', 'Shamin']) {
      expect(g.current).toBe(who);
      passTurn(g, who);
    }
    expect(g.current).toBe('Tanmay'); // Priya skipped, order otherwise unchanged
    expect(g.player('Priya').skipTurns).toBe(0);
  });
});

describe('a new game is a new game', () => {
  it('a finished game accepts nothing more, and the next game shares none of its state', () => {
    const old = new TestGame(['Tanmay', 'Shamin']);
    old.placeBefore('Tanmay', 'MUMBAI', 3);
    old.roll('Tanmay', 1, 2);
    old.act('Tanmay', { type: 'BUY_PROPERTY' });
    old.act('Tanmay', { type: 'END_GAME' });
    expect(old.state.status).toBe('FINISHED');
    expect(() => old.act('Shamin', { type: 'ROLL_DICE' })).toThrow('This game has finished.');
    expect(() => old.act('Tanmay', { type: 'START_GAME' })).toThrow('This game has finished.');

    const next = new TestGame(['Shamin', 'Tanmay'], { start: false });
    expect(next.state.id).not.toBe(old.state.id);
    expect(next.state).toMatchObject({ status: 'WAITING', winnerId: null, loans: [], trades: [], undoStack: [], auction: null });
    expect(next.state.turn).toMatchObject({ playerId: null, number: 0, roll: null, pending: null });
    const oldIds = old.state.players.map((p) => p.id);
    expect(next.state.players.some((p) => oldIds.includes(p.id))).toBe(false);
    expect(next.state.players.every((p) => p.balance === 0 && p.position === 0 && p.status === 'ACTIVE')).toBe(true);
    expect(Object.values(next.state.properties).every((p) => p.ownerId === null && p.houses === 0 && !p.hotel && !p.mortgaged)).toBe(true);
    expect(next.ledger).toHaveLength(0);
  });
});
