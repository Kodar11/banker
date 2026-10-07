import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const top = (g: TestGame) => g.state.undoStack[g.state.undoStack.length - 1]!;

const START = BUSINESS_MVP_RULES.startingCash;

describe('undo via compensating transactions', () => {
  it('transfer A→B ₹500 is undone by B→A ₹500; original stays in history', () => {
    const g = new TestGame();
    const t = g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    const actionId = top(g).actionId;
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: actionId });
    const req = g.state.undoRequest!;
    expect(req.approverIds).toEqual([g.id('Bilal')]);
    expect(() => g.act('Asha', { type: 'APPROVE_UNDO', requestId: req.id })).toThrow('Another player needs to approve this.');
    const r = g.act('Bilal', { type: 'APPROVE_UNDO', requestId: req.id });
    expect(r.transactions).toMatchObject([
      { type: 'UNDO_REVERSAL', fromPlayerId: g.id('Bilal'), toPlayerId: g.id('Asha'), amount: 500, reversesTransactionId: t.transactions[0]!.id },
    ]);
    expect(g.balance('Asha')).toBe(START);
    expect(g.balance('Bilal')).toBe(START);
    expect(g.ledger.filter((x) => x.type === 'PLAYER_TRANSFER')).toHaveLength(1);
    expect(g.state.undoStack).toHaveLength(0);
  });

  it('undoing a purchase refunds and returns the property to the bank', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId });
    // Bank purchase: any other player may approve.
    expect(g.state.undoRequest!.approverIds.sort()).toEqual([g.id('Bilal'), g.id('Chitra')].sort());
    g.act('Chitra', { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(START);
  });

  it('only the newest undo entry can be undone (older ones after it); rejected requests change nothing', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    const first = top(g).actionId;
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 300 });
    expect(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: first })).toThrow('Undo newer actions first.');
    g.act('Chitra', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId });
    g.act('Bilal', { type: 'REJECT_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.undoRequest).toBeNull();
    expect(g.balance('Chitra')).toBe(START - 300);
  });

  it('cannot undo if the receiver no longer has the money', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 5000 });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId });
    const reqId = g.state.undoRequest!.id;
    // Bilal spends almost everything winning an auction (auctions are not undoable).
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    const auctionId = g.state.auction!.id;
    g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: START + 4000 });
    g.act('Asha', { type: 'PASS_AUCTION', auctionId });
    expect(g.balance('Bilal')).toBe(1000);
    expect(() => g.act('Bilal', { type: 'APPROVE_UNDO', requestId: reqId })).toThrow("Bilal doesn't have enough money to reverse this.");
    expect(g.balance('Asha')).toBe(START - 5000);
  });

  it('only involved players can request an undo', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    expect(() => g.act('Chitra', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId })).toThrow(
      'Only players involved can ask to undo this.',
    );
  });
});

/** Request + approve the newest undo entry. */
function undoTop(g: TestGame, requester: string, approver?: string) {
  const target = top(g);
  g.act(requester, { type: 'REQUEST_UNDO', targetActionId: target.actionId });
  const req = g.state.undoRequest!;
  const by = approver ?? g.state.players.find((p) => req.approverIds.includes(p.id))!.name;
  return g.act(by, { type: 'APPROVE_UNDO', requestId: req.id });
}

describe('undo history (multiple undo, newest first)', () => {
  it('one, two and three consecutive undos: C, then B, then A', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 }); // A
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 200 }); // B
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 300 }); // C
    expect(g.state.undoStack.map((r) => r.description)).toEqual(['Asha paid Bilal ₹100', 'Asha paid Bilal ₹200', 'Asha paid Bilal ₹300']);
    undoTop(g, 'Asha');
    expect(g.balance('Asha')).toBe(START - 300);
    undoTop(g, 'Asha');
    expect(g.balance('Asha')).toBe(START - 100);
    undoTop(g, 'Asha');
    expect(g.balance('Asha')).toBe(START);
    expect(g.state.undoStack).toHaveLength(0);
    expect(g.ledger.filter((t) => t.type === 'UNDO_REVERSAL').map((t) => t.amount)).toEqual([300, 200, 100]);
    expect(g.ledger.filter((t) => t.type === 'PLAYER_TRANSFER')).toHaveLength(3); // history kept
  });

  it('undo after property purchase, then after building on it (LIFO)', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2); // Railway
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.give('Asha', 'INDORE');
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    undoTop(g, 'Asha');
    expect(g.state.properties.INDORE.houses).toBe(1);
    undoTop(g, 'Asha');
    expect(g.state.properties.INDORE.houses).toBe(0);
    undoTop(g, 'Asha');
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(START);
    // Undo never re-rolls or moves the token.
    expect(g.player('Asha').position).toBe(3);
    expect(g.state.turn.roll?.total).toBe(3);
  });

  it('undo after rent reverses the payment to the owner', () => {
    const g = new TestGame();
    g.give('Bilal', 'DELHI');
    g.placeBefore('Asha', 'DELHI', 4);
    g.roll('Asha', 2, 2);
    g.act('Asha', { type: 'PAY_RENT' });
    expect(g.balance('Bilal')).toBe(START + 750);
    const r = undoTop(g, 'Asha', 'Bilal');
    expect(r.transactions).toMatchObject([{ type: 'UNDO_REVERSAL', fromPlayerId: g.id('Bilal'), toPlayerId: g.id('Asha'), amount: 750 }]);
    expect(g.balance('Asha')).toBe(START);
  });

  it('undo after a hotel restores the 3 houses and refunds the hotel', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE', { houses: 3 });
    g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'INDORE' });
    undoTop(g, 'Asha');
    expect(g.state.properties.INDORE).toMatchObject({ hotel: false, houses: 3 });
    expect(g.balance('Asha')).toBe(START);
  });

  it('undo after mortgage with buildings restores the buildings and takes the payout back', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    undoTop(g, 'Asha');
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: false, houses: 2 });
    expect(g.balance('Asha')).toBe(START);
  });

  it('undo after a card effect (Chance odd 3 lottery) takes the reward back; position unchanged', () => {
    const g = new TestGame();
    g.landOn('Asha', 20, 3);
    expect(top(g)).toMatchObject({ actionType: 'CARD_EFFECT' });
    undoTop(g, 'Asha');
    expect(g.balance('Asha')).toBe(START);
    expect(g.player('Asha').position).toBe(20);
  });

  it('undo after Birthday returns ₹500 to each player', () => {
    const g = new TestGame();
    g.landOn('Asha', 16, 2);
    undoTop(g, 'Asha', 'Bilal');
    for (const n of ['Asha', 'Bilal', 'Chitra']) expect(g.balance(n)).toBe(START);
  });

  it('undo after a trade swaps everything back', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    g.act('Asha', {
      type: 'CREATE_TRADE',
      toPlayerId: g.id('Bilal'),
      offeredPropertyKeys: ['MUMBAI'],
      requestedPropertyKeys: ['DELHI'],
      offeredMoney: 1000,
      requestedMoney: 0,
    });
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: g.state.trades[0]!.id });
    undoTop(g, 'Bilal', 'Asha');
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Bilal'));
    expect(g.balance('Asha')).toBe(START);
  });

  it('a superseded entry cannot be undone (the property changed through a non-undoable action)', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    // Test-only state surgery standing in for any change the undo history does not cover.
    g.state.properties.RAILWAY = { ...g.state.properties.RAILWAY, mortgaged: true };
    expect(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId })).toThrow('Railway has changed since — can’t undo.');
  });

  it('an entry deeper in the stack cannot be undone before newer ones', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 });
    const first = top(g).actionId;
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 200 });
    expect(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: first })).toThrow('Undo newer actions first.');
  });

  it('a pending request becomes invalid when a newer undoable action happens', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId });
    const req = g.state.undoRequest!;
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 50 });
    expect(g.state.undoRequest).toBeNull();
    expect(() => g.act('Bilal', { type: 'APPROVE_UNDO', requestId: req.id })).toThrow('That undo request is no longer open.');
  });

  it('bankruptcy clears the history (expired undo)', () => {
    const g = new TestGame();
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 100 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 100 });
    g.roll('Asha', 2, 3);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.undoStack).toHaveLength(0);
  });

  it('history depth is bounded', () => {
    const g = new TestGame();
    for (let i = 0; i < BUSINESS_MVP_RULES.undo.maxDepth + 5; i += 1) {
      g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 1 });
    }
    expect(g.state.undoStack).toHaveLength(BUSINESS_MVP_RULES.undo.maxDepth);
  });

  it('each undo increments the state version (drives the realtime update)', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top(g).actionId });
    const v = g.state.version;
    g.act('Bilal', { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.version).toBe(v + 1);
  });
});
