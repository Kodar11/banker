import { describe, expect, it } from 'vitest';
import { BOT_NAMES, BUSINESS_MVP_RULES as RULES, GameError, joinBot, positionOfProperty, type GameState } from '@/engine/index.ts';
import { keepOrder, TestGame, testId } from './harness';

/** Adds bots in the lobby and registers their names with the harness. */
function addBots(g: TestGame, n: number): void {
  for (let i = 0; i < n; i += 1) {
    g.act('Tanmay', { type: 'ADD_BOT', difficulty: 'normal', personality: 'banker' });
    const bot = g.state.players[g.state.players.length - 1]!;
    g.ids[bot.name] = bot.id;
  }
}

function start(g: TestGame): void {
  g.queueRandom(...keepOrder(g.state.players.length));
  g.act('Tanmay', { type: 'START_GAME' });
}

const BOT = { difficulty: 'normal', personality: 'banker' } as const;

function bots(state: GameState) {
  return state.players.filter((p) => p.bot);
}

describe('bot seats in the lobby', () => {
  it('the host adds a bot: an ordinary, ready seat marked as a bot, named by the engine', () => {
    const g = new TestGame(['Tanmay', 'Riya'], { start: false });
    const r = g.act('Tanmay', { type: 'ADD_BOT', difficulty: 'hard', personality: 'investor' });
    const [bot] = bots(g.state);
    expect(bot).toMatchObject({ name: BOT_NAMES[0], ready: true, isHost: false, status: 'ACTIVE', bot: { difficulty: 'hard', personality: 'investor' } });
    expect(r.events.map((e) => e.type)).toEqual(['PLAYER_JOINED', 'BOT_ADDED']);
  });

  it('only the host may add a bot, only in the lobby, and never past the table size', () => {
    const g = new TestGame(['Tanmay', 'Riya'], { start: false });
    expect(() => g.act('Riya', { type: 'ADD_BOT', ...BOT })).toThrow(GameError);
    for (let i = 0; i < RULES.players.max - 2; i += 1) g.act('Tanmay', { type: 'ADD_BOT', ...BOT });
    expect(g.state.players).toHaveLength(RULES.players.max);
    expect(() => g.act('Tanmay', { type: 'ADD_BOT', ...BOT })).toThrow(/full/);
    const started = new TestGame(['Tanmay', 'Riya']);
    expect(() => started.act('Tanmay', { type: 'ADD_BOT', ...BOT })).toThrow(GameError);
  });

  it('a bot is removed like anyone else, and its name is never reused at that table', () => {
    const g = new TestGame(['Tanmay', 'Riya'], { start: false });
    g.act('Tanmay', { type: 'ADD_BOT', ...BOT });
    const first = bots(g.state)[0]!;
    g.act('Tanmay', { type: 'REMOVE_PLAYER', playerId: first.id });
    g.act('Tanmay', { type: 'ADD_BOT', ...BOT });
    expect(bots(g.state).map((b) => [b.name, b.status])).toEqual([
      [BOT_NAMES[0], 'LEFT'],
      [BOT_NAMES[1], 'ACTIVE'],
    ]);
  });

  it('bots start with the same cash and get turns like everyone else', () => {
    const g = new TestGame(['Tanmay', 'Riya'], { start: false });
    addBots(g, 1);
    start(g);
    const bot = bots(g.state)[0]!;
    expect(bot.balance).toBe(RULES.startingCash);
    expect(g.state.players.filter((p) => p.status === 'ACTIVE')).toHaveLength(3);
  });

  it('the server seats matchmaking bots with joinBot: same checks, a lock does not stop it', () => {
    const g = new TestGame(['Tanmay'], { start: false });
    g.act('Tanmay', { type: 'SET_LOBBY_LOCK', locked: true });
    const r = joinBot(g.state, { playerId: testId(), bot: BOT }, g.ctx());
    expect(bots(r.state)).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'PLAYER_JOINED', payload: { bot: true } });
  });
});

describe('a table where only bots are left', () => {
  it('the host role passes to a person, not a bot', () => {
    const g = new TestGame(['Tanmay', 'Riya'], { start: false });
    g.act('Tanmay', { type: 'ADD_BOT', ...BOT });
    // The bot joined after Riya, but even seated first it would be passed over.
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.players.find((p) => p.isHost)?.name).toBe('Riya');
  });

  it('a lobby with only bots left closes', () => {
    const g = new TestGame(['Tanmay'], { start: false });
    g.act('Tanmay', { type: 'ADD_BOT', ...BOT });
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('FINISHED');
  });

  it('when the last person leaves a running game, it ends and is ranked as it stands', () => {
    const g = new TestGame(['Tanmay'], { start: false });
    addBots(g, 2);
    start(g);
    const r = g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('FINISHED');
    expect(r.events.find((e) => e.type === 'GAME_FINISHED')?.payload.reason).toBe('NO_PEOPLE_LEFT');
  });

  it('when the last person goes bankrupt the game ends; a bot going bankrupt changes nothing', () => {
    const g = new TestGame(['Tanmay'], { start: false });
    addBots(g, 2);
    start(g);
    g.give(BOT_NAMES[0], 'MUMBAI', { hotel: true });
    g.give(BOT_NAMES[0], 'CALCUTTA');
    g.give(BOT_NAMES[0], 'HYDERABAD');
    // Tanmay has nothing to sell: owing more than their cash they may declare bankruptcy.
    g.state.players = g.state.players.map((p) => (p.name === 'Tanmay' ? { ...p, balance: 0 } : p));
    g.ledger.push({ id: testId(), actionId: testId(), type: 'STARTING_FUNDS', fromPlayerId: g.id('Tanmay'), toPlayerId: null, amount: RULES.startingCash, propertyKey: null, memo: 'test', reversesTransactionId: null, createdAt: new Date().toISOString() });
    g.landOn('Tanmay', positionOfProperty('MUMBAI'), 3);
    const r = g.act('Tanmay', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.events.find((e) => e.type === 'GAME_FINISHED')?.payload.reason).toBe('NO_PEOPLE_LEFT');
  });
});
