import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BUSINESS_MVP_RULES,
  canTransition,
  canTransitionStatus,
  rollDiceValues,
  RESTING_PHASES,
  TURN_TRANSITIONS,
  type TurnPhase,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

describe('dice', () => {
  it('values are always within 1–6 across the random range', () => {
    for (const r of [0, 0.0001, 0.1666, 0.1667, 0.5, 0.8333, 0.9999, 0.999999999]) {
      for (const v of rollDiceValues(() => r)) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
      }
    }
  });

  it('rolls two dice', () => {
    expect(rollDiceValues(Math.random)).toHaveLength(BUSINESS_MVP_RULES.dice.count);
  });

  it('injected result is deterministic and moves the player', () => {
    const g = new TestGame();
    const r = g.roll('Asha', 3, 2);
    expect(g.state.turn.roll).toEqual({ dice: [3, 2], total: 5, isDouble: false });
    expect(g.player('Asha').position).toBe(5);
    expect(r.events.find((e) => e.type === 'DICE_ROLLED')?.message).toBe('Asha rolled 5 → Income Tax');
  });

  it('passing Start pays the reward via a transaction', () => {
    const g = new TestGame();
    g.player('Asha').position = 33;
    const before = g.balance('Asha');
    const r = g.roll('Asha', 2, 2); // 33 + 4 = 37 → 1 (Mumbai)
    expect(g.player('Asha').position).toBe(1);
    expect(r.transactions.find((t) => t.type === 'START_REWARD')?.amount).toBe(BUSINESS_MVP_RULES.start.passReward);
    expect(g.balance('Asha')).toBe(before + BUSINESS_MVP_RULES.start.passReward);
  });
});

describe('turn order', () => {
  it('starts with the host and gives everyone starting cash', () => {
    const g = new TestGame();
    expect(g.state.status).toBe('ACTIVE');
    expect(g.current).toBe('Asha');
    for (const n of ['Asha', 'Bilal', 'Chitra']) expect(g.balance(n)).toBe(BUSINESS_MVP_RULES.startingCash);
    expect(g.ledger.filter((t) => t.type === 'STARTING_FUNDS')).toHaveLength(3);
  });

  it('rotates in seat order and wraps around', () => {
    const g = new TestGame();
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const who = g.current;
      order.push(who);
      g.player(who).position = 34; // 34 + 2 = Start
      g.roll(who, 1, 1);
      g.act(who, { type: 'END_TURN' });
    }
    expect(order).toEqual(['Asha', 'Bilal', 'Chitra', 'Asha']);
  });

  it("rejects actions when it's not your turn", () => {
    const g = new TestGame();
    expect(() => g.roll('Bilal', 1, 2)).toThrow("It's not your turn.");
  });

  it('cannot roll twice or end turn before rolling', () => {
    const g = new TestGame();
    expect(() => g.act('Asha', { type: 'END_TURN' })).toThrow('Roll the dice first.');
    g.player('Asha').position = 7;
    g.roll('Asha', 1, 1);
    expect(() => g.roll('Asha', 1, 1)).toThrow('You have already rolled.');
  });

  it('cannot end turn while a decision is pending', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2); // Railway, unowned
    expect(g.state.turn.phase).toBe('AWAITING_DECISION');
    expect(() => g.act('Asha', { type: 'END_TURN' })).toThrow('Finish your current action first.');
  });

  it('skips a player who landed on Rest House', () => {
    const g = new TestGame();
    g.player('Asha').position = 21;
    g.roll('Asha', 3, 3); // 27 Rest House
    expect(g.player('Asha').skipTurns).toBe(1);
    g.act('Asha', { type: 'END_TURN' });
    for (const who of ['Bilal', 'Chitra']) {
      g.player(who).position = 7;
      g.roll(who, 1, 1);
      g.act(who, { type: 'END_TURN' });
    }
    expect(g.current).toBe('Bilal');
    expect(g.player('Asha').skipTurns).toBe(0);
  });

  it('game actions are rejected before the game starts', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    expect(() => g.roll('Asha', 1, 2)).toThrow('The game has not started yet.');
  });

  it('only the host can start, and needs the minimum players', () => {
    const solo = new TestGame(['Asha'], { start: false });
    expect(() => solo.act('Asha', { type: 'START_GAME' })).toThrow(/Need at least/);
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    expect(() => g.act('Bilal', { type: 'START_GAME' })).toThrow('Only the host can start the game.');
    g.act('Bilal', { type: 'SET_READY', ready: true });
    expect(g.player('Bilal').ready).toBe(true);
  });

  it('version increments on every applied action', () => {
    const g = new TestGame();
    const v = g.state.version;
    g.roll('Asha', 3, 2);
    expect(g.state.version).toBe(v + 1);
  });

  it('rejects malformed actions', () => {
    const g = new TestGame();
    expect(() => applyAction(g.state, g.id('Asha'), { type: 'SET_BALANCE', balance: 999999 }, g.ctx())).toThrow('That action is not valid.');
    expect(() => applyAction(g.state, g.id('Asha'), { type: 'ROLL_DICE', dice: [6, 6] }, g.ctx())).toThrow('That action is not valid.');
    expect(() => applyAction(g.state, '00000000-0000-4000-8000-ffffffffffff', { type: 'ROLL_DICE' }, g.ctx())).toThrow('You are not in this game.');
  });

  it('rejects actions on an expired game', () => {
    const g = new TestGame();
    g.advance(BUSINESS_MVP_RULES.session.ttlHours * 3600 + 60);
    expect(() => g.roll('Asha', 1, 2)).toThrow('This game has expired. Start a new one.');
  });
});

describe('state machine', () => {
  it('follows the documented path for a property landing', () => {
    const g = new TestGame();
    const r = g.roll('Asha', 1, 2);
    expect(r.transitions).toEqual([
      { from: 'AWAITING_ROLL', to: 'MOVING' },
      { from: 'MOVING', to: 'RESOLVING' },
      { from: 'RESOLVING', to: 'AWAITING_DECISION' },
    ]);
    const buy = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(buy.transitions).toEqual([
      { from: 'AWAITING_DECISION', to: 'TRANSACTION' },
      { from: 'TRANSACTION', to: 'TURN_COMPLETE' },
    ]);
    const end = g.act('Asha', { type: 'END_TURN' });
    expect(end.transitions).toEqual([{ from: 'TURN_COMPLETE', to: 'AWAITING_ROLL' }]);
  });

  it('every recorded transition in a long game is in the table, and resting phases are stable', () => {
    const g = new TestGame();
    for (let i = 0; i < 30; i += 1) {
      const who = g.current;
      if (g.player(who).inJail) {
        g.act(who, { type: 'STAY_IN_JAIL' });
        continue;
      }
      const r = g.roll(who, (i % 6) + 1, ((i * 5) % 6) + 1);
      for (const t of r.transitions) expect(canTransition(t.from, t.to)).toBe(true);
      const phase = g.state.turn.phase;
      expect(RESTING_PHASES.has(phase)).toBe(true);
      const pending = g.state.turn.pending;
      if (phase === 'AWAITING_DECISION' && pending?.kind === 'BUY') {
        if (g.balance(who) >= pending.price) g.act(who, { type: 'BUY_PROPERTY' });
        else {
          g.act(who, { type: 'DECLINE_PROPERTY' });
          for (const id of g.state.auction!.participantIds) {
            g.act(g.state.players.find((p) => p.id === id)!.name, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
          }
        }
      } else if (phase === 'AWAITING_PAYMENT' && pending?.kind === 'PAYMENT') {
        const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', LOAN_INTEREST: 'PAY_INTEREST', CLUB: 'PAY_CLUB' } as const;
        if (g.balance(who) < pending.amount) {
          g.act(who, { type: 'DECLARE_BANKRUPTCY' });
          if (g.state.status === 'FINISHED') break;
          continue;
        }
        g.act(who, { type: pay[pending.reason] });
      } else if (phase === 'AWAITING_CARD') g.act(who, { type: 'RESOLVE_CARD', resolution: 'NONE' });
      g.act(who, { type: 'END_TURN' });
    }
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('AWAITING_ROLL', 'TURN_COMPLETE')).toBe(false);
    expect(canTransition('TURN_COMPLETE', 'AWAITING_DECISION')).toBe(false);
    expect(canTransition('AWAITING_DECISION', 'AWAITING_ROLL')).toBe(false);
    expect(canTransitionStatus('WAITING', 'PAUSED')).toBe(false);
    expect(canTransitionStatus('FINISHED', 'ACTIVE')).toBe(false);
    expect(canTransitionStatus('ACTIVE', 'PAUSED')).toBe(true);
    const all = Object.keys(TURN_TRANSITIONS) as TurnPhase[];
    for (const from of all) for (const to of TURN_TRANSITIONS[from]) expect(all).toContain(to);
  });
});

describe('pause / resume', () => {
  it('blocks all gameplay while paused', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'PAUSE_GAME' });
    expect(g.state.status).toBe('PAUSED');
    expect(() => g.roll('Asha', 1, 2)).toThrow('Game is paused.');
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 })).toThrow('Game is paused.');
    expect(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).toThrow('Game is paused.');
    expect(() => g.act('Asha', { type: 'PAUSE_GAME' })).toThrow('Game is paused.');
    g.act('Chitra', { type: 'RESUME_GAME' });
    expect(g.state.status).toBe('ACTIVE');
    g.roll('Asha', 1, 2);
    expect(g.state.turn.phase).toBe('AWAITING_DECISION');
  });

  it('resuming extends an open auction by the paused time', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    const endsAt = Date.parse(g.state.auction!.endsAt);
    g.act('Bilal', { type: 'PAUSE_GAME' });
    g.advance(120);
    g.act('Bilal', { type: 'RESUME_GAME' });
    expect(Date.parse(g.state.auction!.endsAt)).toBe(endsAt + 120_000);
  });
});
