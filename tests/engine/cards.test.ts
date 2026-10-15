import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyCardDefinition,
  BUSINESS_MVP_RULES,
  CARD_TABLES,
  CHANCE_EVEN,
  CHANCE_ROLL_11_REWARD,
  CHANCE_ODD,
  COMMUNITY_CHEST_EVEN,
  COMMUNITY_CHEST_ODD,
  findCard,
  positionOfProperty,
  positionOfSpecial,
  type CardDefinition,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;
const REWARD = BUSINESS_MVP_RULES.start.passReward;
/** Second Chance / Community Chest squares: reachable with any total 2–12 without passing Start. */
const CHANCE = 20;
const CHEST = 16;

function landOnCard(square: number, total: number, names?: string[]) {
  const g = new TestGame(names);
  const r = g.landOn('Asha', square, total);
  return { g, r };
}

describe('card tables — exact supplied data', () => {
  it('Chance EVEN: 2, 4, 6, 8, 10, 12', () => {
    expect(CHANCE_EVEN.map((c) => [c.rollTotal, c.effects])).toEqual([
      [2, [{ type: 'PAY_BANK', amount: 2000 }]],
      [4, [{ type: 'PAY_BANK', amount: 1500 }]],
      [6, [{ type: 'PAY_BANK', amount: 1500 }]],
      [8, [{ type: 'PAY_BANK', amount: 3000 }]],
      [10, [{ type: 'GO_TO_JAIL' }]],
      [12, [{ type: 'GO_TO_REST_HOUSE' }, { type: 'SKIP_TURNS', count: 1 }]],
    ]);
  });

  it('Chance ODD: 3, 5, 7, 9, 10, 12 (as supplied)', () => {
    expect(CHANCE_ODD.map((c) => [c.rollTotal, c.effects])).toEqual([
      [3, [{ type: 'RECEIVE_FROM_BANK', amount: 2500 }]],
      [5, [{ type: 'RECEIVE_FROM_BANK', amount: 1000 }]],
      [7, [{ type: 'RECEIVE_FROM_BANK', amount: 2000 }]],
      [
        9,
        [
          {
            type: 'MOVE_TO',
            target: 'MUMBAI',
            direction: BUSINESS_MVP_RULES.cards.goBackToMumbaiDirection,
            resolveLanding: BUSINESS_MVP_RULES.cards.goBackToMumbaiResolvesLanding,
          },
          { type: 'RECEIVE_FROM_BANK', amount: 3000 },
        ],
      ],
      [10, [{ type: 'GO_TO_JAIL' }]],
      [12, [{ type: 'GO_TO_REST_HOUSE' }, { type: 'SKIP_TURNS', count: 1 }]],
    ]);
  });

  it('Community Chest EVEN: 2, 4, 6, 8, 10, 12', () => {
    expect(COMMUNITY_CHEST_EVEN.map((c) => [c.rollTotal, c.effects])).toEqual([
      [2, [{ type: 'COLLECT_FROM_EACH_PLAYER', amount: 500 }]],
      [4, [{ type: 'RECEIVE_FROM_BANK', amount: 2500 }]],
      [6, [{ type: 'RECEIVE_FROM_BANK', amount: 2000 }]],
      [8, [{ type: 'GO_TO_REST_HOUSE' }, { type: 'SKIP_TURNS', count: 1 }]],
      [10, [{ type: 'RECEIVE_FROM_BANK', amount: 1500 }]],
      [12, [{ type: 'RECEIVE_FROM_BANK', amount: 3000 }]],
    ]);
  });

  it('Community Chest ODD: 3, 5, 7, 9, 11', () => {
    expect(COMMUNITY_CHEST_ODD.map((c) => [c.rollTotal, c.effects])).toEqual([
      [3, [{ type: 'GO_TO_JAIL' }]],
      [5, [{ type: 'PAY_BANK', amount: 1000 }]],
      [7, [{ type: 'PAY_BANK', amount: 2000 }]],
      [9, [{ type: 'PAY_PER_BUILDING', perHouse: 50, perHotel: 100 }]],
      [11, [{ type: 'PAY_BANK', amount: 1500 }]],
    ]);
  });

  it('parity picks the table; the dice number picks the entry', () => {
    expect(findCard('CHANCE', 10).id).toBe('CHANCE_EVEN_10');
    expect(findCard('CHANCE', 9).id).toBe('CHANCE_ODD_9');
    expect(findCard('COMMUNITY_CHEST', 2).id).toBe('COMMUNITY_CHEST_EVEN_2');
    expect(findCard('COMMUNITY_CHEST', 3).id).toBe('COMMUNITY_CHEST_ODD_3');
  });

  it('every dice total 2–12 resolves to a definition; the only one that is not a printed card is the Chance roll-11 bank reward', () => {
    const events: string[] = [];
    for (const deck of ['CHANCE', 'COMMUNITY_CHEST'] as const) {
      for (let t = 2; t <= 12; t += 1) {
        const c = findCard(deck, t);
        expect(c.effects.length).toBeGreaterThan(0);
        if (c.kind === 'BANK_EVENT') events.push(c.id);
      }
    }
    expect(events).toEqual(['CHANCE_ROLL_11_REWARD']);
    for (const deck of Object.values(CARD_TABLES)) {
      for (const table of Object.values(deck)) for (const c of table) expect(c.kind).toBe('CARD');
    }
    // Community Chest odd 11 is a printed card (the insurance premium), not a reward.
    expect(findCard('COMMUNITY_CHEST', 11)).toMatchObject({ id: 'COMMUNITY_CHEST_ODD_11', kind: 'CARD', effects: [{ type: 'PAY_BANK', amount: 1500 }] });
  });
});

describe('Chance — EVEN', () => {
  it.each([
    [2, 2000],
    [4, 1500],
    [6, 1500],
    [8, 3000],
  ])('Chance %i: pay the bank ₹%i', (total, amount) => {
    const { g } = landOnCard(CHANCE, total);
    expect(g.state.turn.card).toMatchObject({ cardId: `CHANCE_EVEN_${total}`, table: 'EVEN', kind: 'CARD' });
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CARD', amount, toPlayerId: null });
    const r = g.act('Asha', { type: 'PAY_CARD' });
    expect(r.transactions).toMatchObject([{ type: 'CARD_PAYMENT', amount, fromPlayerId: g.id('Asha'), toPlayerId: null }]);
    expect(g.balance('Asha')).toBe(START - amount);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('Chance 10: go to Jail (trapped for up to 3 turns, no Start reward)', () => {
    const { g } = landOnCard(CHANCE, 10);
    expect(g.player('Asha')).toMatchObject({ position: positionOfSpecial('JAIL'), inJail: true, jailTurnsLeft: 3, skipTurns: 0 });
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    expect(g.ledger.some((t) => t.type === 'START_REWARD')).toBe(false);
  });

  it('Chance 12: go to Rest House and cannot play next turn', () => {
    const { g } = landOnCard(CHANCE, 12);
    expect(g.player('Asha')).toMatchObject({ position: positionOfSpecial('REST_HOUSE'), skipTurns: 1 });
    g.act('Asha', { type: 'END_TURN' });
    for (const n of ['Bilal', 'Chitra']) {
      g.landOn(n, positionOfSpecial('WEALTH_TAX'), 4); // no buildings: nothing to pay
      g.act(n, { type: 'END_TURN' });
    }
    expect(g.current).toBe('Bilal'); // Asha's turn skipped
  });
});

describe('Chance — ODD', () => {
  it.each([
    [3, 2500],
    [5, 1000],
    [7, 2000],
  ])('Chance %i: receive ₹%i from the bank, applied immediately', (total, amount) => {
    const { g, r } = landOnCard(CHANCE, total);
    expect(r.transactions).toMatchObject([{ type: 'CARD_REWARD', amount, fromPlayerId: null, toPlayerId: g.id('Asha') }]);
    expect(g.balance('Asha')).toBe(START + amount);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('Chance 9: go back to Mumbai through the movement engine — Start reward + ₹3,000 prize in ONE atomic resolution', () => {
    const { g, r } = landOnCard(CHANCE, 9);
    expect(g.player('Asha').position).toBe(positionOfProperty('MUMBAI'));
    expect(g.player('Asha').circuits).toBe(1);
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['START_REWARD', REWARD],
      ['CARD_REWARD', 3000],
    ]);
    expect(g.balance('Asha')).toBe(START + REWARD + 3000);
    // Mumbai is resolved on arrival: unowned → buy offer.
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_DECISION', pending: { kind: 'BUY', propertyKey: 'MUMBAI' } });
    expect(r.events.map((e) => e.type)).toEqual(['DICE_ROLLED', 'CARD_DRAWN', 'PASSED_START', 'MOVED']);
  });

  it('Chance 9 from the first Chance square also passes Start; Mumbai rent applies when owned', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI');
    g.landOn('Asha', 7, 9); // from square 34: the roll itself passes Start once, the card move passes it again
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', amount: 1200, toPlayerId: g.id('Bilal') });
    expect(g.player('Asha').circuits).toBe(2);
    expect(g.balance('Asha')).toBe(START + 2 * REWARD + 3000);
  });

});

/** Refusal code of an action, asserting the state is untouched (the engine validates raw input too). */
function refusal(g: TestGame, name: string, action: unknown): string {
  const before = JSON.stringify(g.state);
  let code = 'ACCEPTED';
  try {
    applyAction(g.state, g.id(name), action, g.ctx());
  } catch (error) {
    code = (error as { code?: string }).code ?? `THROWN ${String(error)}`;
  }
  expect(JSON.stringify(g.state)).toBe(before);
  return code;
}

describe('Chance on a roll of 11 — the bank reward', () => {
  const BONUS = BUSINESS_MVP_RULES.cards.chanceRoll11Reward;

  it('is ₹2,000, defined by the engine, with no card behind it', () => {
    expect(BONUS).toBe(2000);
    expect(findCard('CHANCE', 11)).toBe(CHANCE_ROLL_11_REWARD);
    expect(CHANCE_ROLL_11_REWARD).toMatchObject({ deck: 'CHANCE', table: 'ODD', rollTotal: 11, kind: 'BANK_EVENT', effects: [{ type: 'RECEIVE_FROM_BANK', amount: 2000 }] });
    expect(CHANCE_ROLL_11_REWARD.text).toContain('roll of 11');
    expect(CHANCE_ROLL_11_REWARD.text).toContain('₹2,000');
  });

  it.each([
    ['the second Chance square, from the Jail square (5 + 6)', CHANCE, 0],
    ['the first Chance square, from square 32 (passing Start on the way)', positionOfSpecial('CHANCE'), REWARD],
  ])('a real roll of 11 onto %s pays ₹2,000 at once: one bank ledger row, one message, the turn is done', (_label, square, startReward) => {
    const g = new TestGame();
    g.placeAt('Asha', (square - 11 + 36) % 36);
    const r = g.roll('Asha', 5, 6);
    expect(g.player('Asha').position).toBe(square);
    expect(r.transactions.filter((t) => t.type === 'CARD_REWARD')).toEqual([
      expect.objectContaining({ type: 'CARD_REWARD', fromPlayerId: null, toPlayerId: g.id('Asha'), amount: 2000, memo: CHANCE_ROLL_11_REWARD.text }),
    ]);
    expect(r.transactions.filter((t) => t.type !== 'CARD_REWARD').map((t) => t.type)).toEqual(startReward ? ['START_REWARD'] : []);
    expect(g.balance('Asha')).toBe(START + startReward + 2000);
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null, card: { cardId: 'CHANCE_ROLL_11_REWARD', kind: 'BANK_EVENT', rollTotal: 11 } });
    const drawn = r.events.find((e) => e.type === 'CARD_DRAWN')!;
    expect(drawn.message).toBe(`Chance, roll of 11: ${CHANCE_ROLL_11_REWARD.text}`);
    expect(g.state.undoStack.at(-1)).toMatchObject({ actionType: 'CARD_EFFECT', actorId: g.id('Asha'), moves: [{ fromPlayerId: null, toPlayerId: g.id('Asha'), amount: 2000 }] });
  });

  it('only a landing on Chance with 11 earns it: 11 onto another square, or another total onto Chance, never does', () => {
    const g = new TestGame();
    g.landOn('Asha', positionOfProperty('DARJEELING'), 11);
    expect(g.ledger.some((t) => t.type === 'CARD_REWARD')).toBe(false);
    expect(g.state.turn.card).toBeNull();
    for (const total of [3, 5, 7, 9]) {
      const h = new TestGame();
      h.landOn('Asha', CHANCE, total);
      expect(h.state.turn.card).toMatchObject({ cardId: `CHANCE_ODD_${total}`, kind: 'CARD' });
    }
  });

  it('the client cannot name an amount, an outcome or a card: forged payloads are refused, before and after the reward', () => {
    const g = new TestGame();
    const forged = [
      { type: 'RESOLVE_CARD', resolution: 'RECEIVE', amount: 10000 },
      { type: 'RESOLVE_CARD', resolution: 'PAY', amount: 0 },
      { type: 'RESOLVE_CARD', resolution: 'NONE' },
      { type: 'RESOLVE_CARD', cardId: 'CHANCE_ODD_3' },
      { type: 'RESOLVE_CARD', amount: 2000 },
      { type: 'CLAIM_CARD', cardId: 'CHANCE_ROLL_11_REWARD' },
      { type: 'PAY_CARD', amount: 1 },
    ];
    for (const action of forged) expect(refusal(g, 'Asha', action)).toBe('VALIDATION');
    // Before any roll there is no card: the bare action is refused too.
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
    g.landOn('Asha', CHANCE, 11);
    for (const action of forged) expect(refusal(g, 'Asha', action)).toBe('VALIDATION');
    // The reward is already settled: nothing more to claim, by the lander or anyone else.
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
    expect(refusal(g, 'Bilal', { type: 'RESOLVE_CARD' })).toBe('NOT_YOUR_TURN');
    expect(refusal(g, 'Asha', { type: 'ROLL_DICE' })).toBe('INVALID_PHASE');
    expect(g.ledger.filter((t) => t.type === 'CARD_REWARD').map((t) => t.amount)).toEqual([2000]);
  });

  it('undo takes back exactly the ₹2,000, once; the landing is not re-run and a stale or repeated undo is refused', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', CHANCE, 11);
    const target = g.state.undoStack.at(-1)!.actionId;
    // Bank money has no counterparty: everyone else may approve.
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: target });
    const request = g.state.undoRequest!;
    expect([...request.approverIds].sort()).toEqual([g.id('Bilal'), g.id('Chitra')].sort());
    const u = g.act('Bilal', { type: 'APPROVE_UNDO', requestId: request.id });
    expect(u.transactions).toEqual([
      expect.objectContaining({ type: 'UNDO_REVERSAL', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 2000, reversesTransactionId: r.transactions[0]!.id }),
    ]);
    expect(g.balance('Asha')).toBe(START);
    expect(g.state.undoStack).toHaveLength(0);
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null });
    expect(refusal(g, 'Chitra', { type: 'APPROVE_UNDO', requestId: request.id })).toBe('UNDO_NOT_ALLOWED');
    expect(refusal(g, 'Bilal', { type: 'APPROVE_UNDO', requestId: request.id })).toBe('UNDO_NOT_ALLOWED');
    expect(refusal(g, 'Asha', { type: 'REQUEST_UNDO', targetActionId: target })).toBe('UNDO_NOT_ALLOWED');
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
    expect(g.ledger.filter((t) => t.type === 'CARD_REWARD' || t.type === 'UNDO_REVERSAL').map((t) => [t.type, t.amount])).toEqual([
      ['CARD_REWARD', 2000],
      ['UNDO_REVERSAL', 2000],
    ]);
  });

  it('an undo request overtaken by a newer action is refused, and changes nothing', () => {
    const g = new TestGame();
    g.landOn('Asha', CHANCE, 11);
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.undoStack.at(-1)!.actionId });
    const request = g.state.undoRequest!;
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    expect(refusal(g, 'Bilal', { type: 'APPROVE_UNDO', requestId: request.id })).toBe('UNDO_NOT_ALLOWED');
    expect(g.balance('Asha')).toBe(START + 2000 - 500);
  });

  it('a game saved while Chance 11 was entered by hand is settled from the card data: ₹2,000, whatever the client asks for', () => {
    const g = new TestGame();
    g.landOn('Asha', positionOfProperty('DARJEELING'), 11);
    // Recreate the legacy state the old manual path left behind (no money had moved yet).
    g.placeAt('Asha', CHANCE);
    g.state.turn.phase = 'AWAITING_CARD';
    g.state.turn.pending = { kind: 'CARD_MANUAL', cardId: 'CHANCE_ODD_11', deck: 'CHANCE', rollTotal: 11 };
    g.state.turn.card = null;
    const before = g.balance('Asha');
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD', resolution: 'RECEIVE', amount: 10000 })).toBe('VALIDATION');
    expect(refusal(g, 'Bilal', { type: 'RESOLVE_CARD' })).toBe('NOT_YOUR_TURN');
    const r = g.act('Asha', { type: 'RESOLVE_CARD' });
    expect(r.transactions).toEqual([expect.objectContaining({ type: 'CARD_REWARD', fromPlayerId: null, amount: 2000 })]);
    expect(g.balance('Asha')).toBe(before + 2000);
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null, card: { cardId: 'CHANCE_ROLL_11_REWARD' } });
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
  });
});

describe('Community Chest — no client-chosen money either', () => {
  it('the printed amount is the only one: a card charge is a fixed payment that RESOLVE_CARD or an amount cannot change', () => {
    const g = new TestGame();
    g.landOn('Asha', CHEST, 11);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CARD', amount: 1500, toPlayerId: null });
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD', resolution: 'NONE' })).toBe('VALIDATION');
    expect(refusal(g, 'Asha', { type: 'PAY_CARD', amount: 1 })).toBe('VALIDATION');
    const r = g.act('Asha', { type: 'PAY_CARD' });
    expect(r.transactions).toEqual([expect.objectContaining({ type: 'CARD_PAYMENT', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 1500 })]);
    expect(refusal(g, 'Asha', { type: 'PAY_CARD' })).toBe('INVALID_PHASE');
  });

  it('a reward card pays its printed amount once, automatically', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', CHEST, 12);
    expect(r.transactions).toEqual([expect.objectContaining({ type: 'CARD_REWARD', fromPlayerId: null, amount: 3000 })]);
    expect(refusal(g, 'Asha', { type: 'RESOLVE_CARD' })).toBe('INVALID_PHASE');
    expect(g.balance('Asha')).toBe(START + 3000);
  });
});

describe('Community Chest — EVEN', () => {
  it('2: Birthday — ₹500 from EACH other player (player-to-player, not bank money)', () => {
    const { g, r } = landOnCard(CHEST, 2, ['Asha', 'Bilal', 'Chitra', 'Dev']);
    expect(r.transactions).toHaveLength(3);
    for (const t of r.transactions) expect(t).toMatchObject({ type: 'CARD_COLLECTION', amount: 500, toPlayerId: g.id('Asha') });
    expect(r.transactions.map((t) => t.fromPlayerId).sort()).toEqual([g.id('Bilal'), g.id('Chitra'), g.id('Dev')].sort());
    expect(r.transactions.some((t) => t.fromPlayerId === null)).toBe(false);
    expect(g.balance('Asha')).toBe(START + 1500);
    for (const n of ['Bilal', 'Chitra', 'Dev']) expect(g.balance(n)).toBe(START - 500);
  });

  it('2: Birthday — a player short of ₹500 pays what they have', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 200 });
    const r = g.landOn('Asha', CHEST, 2);
    expect(r.transactions.map((t) => t.amount).sort()).toEqual([200, 500]);
    expect(g.balance('Bilal')).toBe(0);
    expect(r.events.some((e) => e.type === 'CARD_SHORTFALL')).toBe(true);
  });

  it.each([
    [4, 2500],
    [6, 2000],
    [10, 1500],
    [12, 3000],
  ])('%i: receive ₹%i from the bank', (total, amount) => {
    const { g } = landOnCard(CHEST, total);
    expect(g.balance('Asha')).toBe(START + amount);
    expect(g.ledger.at(-1)).toMatchObject({ type: 'CARD_REWARD', amount, fromPlayerId: null });
  });

  it('8: go to Rest House, skip next turn — a direct move that never collects at Start', () => {
    // From the second Community Chest (29) the Rest House (27) is "behind": a direct move, no circuit.
    const { g } = landOnCard(29, 8);
    expect(g.player('Asha')).toMatchObject({ position: positionOfSpecial('REST_HOUSE'), skipTurns: 1, circuits: 0 });
    expect(g.ledger.some((t) => t.type === 'START_REWARD')).toBe(false);
    // Card rules unchanged: the card only skips the turn — collecting is for landing on Rest House by a roll.
    expect(g.ledger.some((t) => t.type === 'REST_HOUSE_COLLECTION')).toBe(false);
  });
});

describe('Community Chest — ODD', () => {
  it('3: go to Jail', () => {
    const { g } = landOnCard(CHEST, 3);
    expect(g.player('Asha')).toMatchObject({ inJail: true, position: positionOfSpecial('JAIL'), jailTurnsLeft: 3 });
  });

  it.each([
    [5, 1000],
    [7, 2000],
    [11, 1500],
  ])('%i: pay ₹%i to the bank', (total, amount) => {
    const { g } = landOnCard(CHEST, total);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CARD', amount, toPlayerId: null });
    g.act('Asha', { type: 'PAY_CARD' });
    expect(g.balance('Asha')).toBe(START - amount);
  });

  it('9: general repairs — ₹50 per house, ₹100 per hotel', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE', { houses: 2 });
    g.give('Asha', 'AGRA', { houses: 3 });
    g.give('Asha', 'MUMBAI', { hotel: true });
    g.give('Asha', 'DELHI', { hotel: true });
    g.give('Bilal', 'KANPUR', { houses: 3 }); // not Asha's
    g.landOn('Asha', CHEST, 9);
    expect(g.state.turn.pending).toMatchObject({ amount: 5 * 50 + 2 * 100 });
  });

  it('9: with no buildings costs nothing', () => {
    const { g } = landOnCard(CHEST, 9);
    expect(g.state.turn.pending).toBeNull();
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });
});

describe('card engine — movement effects', () => {
  const custom = (effects: CardDefinition['effects']): CardDefinition => ({
    id: 'TEST',
    deck: 'CHANCE',
    table: 'ODD',
    rollTotal: 9,
    text: 'test card',
    effects,
    kind: 'CARD',
  });

  it('backward MOVE_TO never collects the Start reward', () => {
    const g = new TestGame();
    g.placeAt('Asha', CHANCE);
    g.absorbResult(applyCardDefinition(g.state, custom([{ type: 'MOVE_TO', target: 'MUMBAI', direction: 'BACKWARD', resolveLanding: false }]), 9, g.ctx()));
    expect(g.player('Asha').position).toBe(1);
    expect(g.ledger.some((t) => t.type === 'START_REWARD')).toBe(false);
  });

  it('MOVE_STEPS forward across Start pays; backward across Start does not', () => {
    const g = new TestGame();
    g.placeAt('Asha', 34);
    g.absorbResult(applyCardDefinition(g.state, custom([{ type: 'MOVE_STEPS', steps: 3, resolveLanding: false }]), 9, g.ctx()));
    expect(g.player('Asha').position).toBe(1);
    expect(g.balance('Asha')).toBe(START + REWARD);
    g.absorbResult(applyCardDefinition(g.state, custom([{ type: 'MOVE_STEPS', steps: -3, resolveLanding: false }]), 9, g.ctx()));
    expect(g.player('Asha').position).toBe(34);
    expect(g.balance('Asha')).toBe(START + REWARD);
  });

  it('pay-every-player effect requests one payment split between the other players', () => {
    const g = new TestGame();
    g.placeAt('Asha', CHANCE);
    g.absorbResult(applyCardDefinition(g.state, custom([{ type: 'PAY_EACH_PLAYER', amount: 300 }]), 9, g.ctx()));
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', amount: 600 });
    const r = g.act('Asha', { type: 'PAY_CARD' });
    expect(r.transactions.map((t) => [t.toPlayerId, t.amount])).toEqual([
      [g.id('Bilal'), 300],
      [g.id('Chitra'), 300],
    ]);
  });
});
