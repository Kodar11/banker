import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;

describe('undo via compensating transactions', () => {
  it('transfer A→B ₹500 is undone by B→A ₹500; original stays in history', () => {
    const g = new TestGame();
    const t = g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    const actionId = g.state.lastUndoable!.actionId;
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
    expect(g.state.lastUndoable).toBeNull();
  });

  it('undoing a purchase refunds and returns the property to the bank', () => {
    const g = new TestGame();
    g.roll('Asha', 3, 2);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.lastUndoable!.actionId });
    // Bank purchase: any other player may approve.
    expect(g.state.undoRequest!.approverIds.sort()).toEqual([g.id('Bilal'), g.id('Chitra')].sort());
    g.act('Chitra', { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(START);
  });

  it('only the latest undoable action can be undone; rejected requests change nothing', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    const first = g.state.lastUndoable!.actionId;
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 300 });
    expect(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: first })).toThrow(/most recent/);
    g.act('Chitra', { type: 'REQUEST_UNDO', targetActionId: g.state.lastUndoable!.actionId });
    g.act('Bilal', { type: 'REJECT_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.undoRequest).toBeNull();
    expect(g.balance('Chitra')).toBe(START - 300);
  });

  it('cannot undo if the receiver no longer has the money', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 5000 });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.lastUndoable!.actionId });
    const reqId = g.state.undoRequest!.id;
    // Bilal spends almost everything winning an auction (auctions are not undoable).
    g.roll('Asha', 3, 2);
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
    expect(() => g.act('Chitra', { type: 'REQUEST_UNDO', targetActionId: g.state.lastUndoable!.actionId })).toThrow(
      'Only players involved can ask to undo this.',
    );
  });
});
