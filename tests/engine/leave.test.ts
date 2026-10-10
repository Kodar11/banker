import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES as RULES, type GameState } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const NAMES = ['Tanmay', 'Shamin', 'Ram', 'Priya']; // Tanmay hosts; the harness pins the turn order to this

const seatsOf = (state: GameState) => Object.fromEntries(state.players.map((p) => [p.name, p.seat]));
const eventsOf = (r: { events: { type: string }[] }) => r.events.map((e) => e.type);

/** Plays `who`'s turn with no decisions to make (a non-double roll onto Start) and ends it. */
function passTurn(g: TestGame, who: string): void {
  g.placeAt(who, 33);
  g.roll(who, 1, 2);
  g.act(who, { type: 'END_TURN' });
}

/** Tanmay rolls onto Railway and declines it: an open auction on Tanmay's turn, everyone a participant. */
function withAuction(): { g: TestGame; auctionId: string } {
  const g = new TestGame(NAMES);
  g.roll('Tanmay', 1, 2);
  g.act('Tanmay', { type: 'DECLINE_PROPERTY' });
  return { g, auctionId: g.state.auction!.id };
}

describe('LEAVE_GAME: a player leaves, the game goes on', () => {
  it('out of turn: only their status changes — no money moves, nothing they own is touched, the turn stays', () => {
    const g = new TestGame(NAMES);
    g.give('Ram', 'DELHI', { houses: 2 });
    passTurn(g, 'Tanmay');
    passTurn(g, 'Shamin');
    g.act('Ram', { type: 'REQUEST_LOAN', amount: RULES.loans.minAmount });
    passTurn(g, 'Ram');
    expect(g.current).toBe('Priya');
    const before = structuredClone(g.state);
    const ledger = g.ledger.length;

    const r = g.act('Ram', { type: 'LEAVE_GAME' });
    expect(eventsOf(r)).toEqual(['PLAYER_LEFT']);
    expect(r.events[0]).toMatchObject({ actorId: g.id('Ram'), message: 'Ram left the game' });
    expect(r.transactions).toHaveLength(0);
    expect(g.ledger).toHaveLength(ledger);
    expect(g.player('Ram')).toMatchObject({ status: 'LEFT', balance: before.players.find((p) => p.name === 'Ram')!.balance, isHost: false });
    expect(g.state.properties.DELHI).toEqual(before.properties.DELHI); // still Ram's, houses and all
    expect(g.state.loans).toEqual(before.loans); // not forgiven, not defaulted
    expect(g.state.status).toBe('ACTIVE');
    expect(g.state.turn).toEqual(before.turn);
    expect(g.state.hostPlayerId).toBe(g.id('Tanmay'));
    expect(seatsOf(g.state)).toEqual(seatsOf(before)); // the drawn order is never redrawn
    expect(g.state.version).toBe(before.version + 1);
  });

  it('they can do nothing more, and leaving twice changes nothing', () => {
    const g = new TestGame(NAMES);
    g.act('Shamin', { type: 'LEAVE_GAME' });
    const after = structuredClone(g.state);
    expect(() => g.act('Shamin', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Ram'), amount: 100 })).toThrow('You have left this game.');
    expect(() => g.act('Shamin', { type: 'ROLL_DICE' })).toThrow('You have left this game.');
    expect(() => g.act('Shamin', { type: 'END_GAME' })).toThrow('You have left this game.');
    expect(() => g.act('Shamin', { type: 'LEAVE_GAME' })).toThrow('You have left this game.');
    expect(g.state).toEqual(after);
    // Nobody can leave on someone else's behalf: the action carries no player id at all.
    expect(() => g.act('Ram', { type: 'LEAVE_GAME', playerId: g.id('Priya') } as never)).toThrow('That action is not valid.');
    expect(g.player('Priya').status).toBe('ACTIVE');
  });

  it('later turns skip them and keep the drawn order', () => {
    const g = new TestGame(NAMES);
    g.act('Ram', { type: 'LEAVE_GAME' });
    const seen: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      seen.push(g.current);
      passTurn(g, g.current);
    }
    expect(seen).toEqual(['Tanmay', 'Shamin', 'Priya', 'Tanmay', 'Shamin', 'Priya', 'Tanmay']);
  });

  it('what they own stays theirs: rent on their property is still owed to them', () => {
    const g = new TestGame(NAMES);
    g.give('Ram', 'DELHI');
    g.act('Ram', { type: 'LEAVE_GAME' });
    const ram = g.balance('Ram');
    g.placeBefore('Tanmay', 'DELHI', 3);
    g.roll('Tanmay', 1, 2);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', toPlayerId: g.id('Ram') });
    g.act('Tanmay', { type: 'PAY_RENT' });
    expect(g.balance('Ram')).toBeGreaterThan(ram);
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Ram'));
  });

  it('it is not a bankruptcy: no settlement, no assets to the bank, no defaulted loans', () => {
    const g = new TestGame(NAMES);
    g.give('Tanmay', 'MUMBAI');
    g.act('Tanmay', { type: 'REQUEST_LOAN', amount: RULES.loans.minAmount });
    const r = g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(eventsOf(r)).not.toContain('PLAYER_BANKRUPT');
    expect(r.transactions.filter((t) => t.type === 'BANKRUPTCY_SETTLEMENT')).toHaveLength(0);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Tanmay'));
    expect(g.state.loans.every((l) => l.status === 'ACTIVE')).toBe(true);
    expect(g.balance('Tanmay')).toBe(RULES.startingCash + RULES.loans.minAmount);
  });
});

describe('LEAVE_GAME on your own turn', () => {
  it('before rolling: the turn passes to the next player', () => {
    const g = new TestGame(NAMES);
    const r = g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.current).toBe('Shamin');
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', number: 2, pending: null, roll: null });
    expect(eventsOf(r)).toEqual(['PLAYER_LEFT', 'HOST_CHANGED', 'TURN_STARTED']);
  });

  it('with a property to decide on: nothing is bought, no auction opens, next player', () => {
    const g = new TestGame(NAMES);
    passTurn(g, 'Tanmay');
    g.roll('Shamin', 1, 2); // Railway, unowned
    expect(g.state.turn.pending).toMatchObject({ kind: 'BUY', propertyKey: 'RAILWAY' });
    const r = g.act('Shamin', { type: 'LEAVE_GAME' });
    expect(g.current).toBe('Ram');
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', pending: null });
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(g.state.auction).toBeNull();
    expect(r.transactions).toHaveLength(0);
  });

  it('while owing rent: the debt is neither paid nor turned into a bankruptcy — the turn simply moves on', () => {
    const g = new TestGame(NAMES);
    g.give('Priya', 'DELHI');
    g.placeBefore('Tanmay', 'DELHI', 3);
    g.roll('Tanmay', 1, 2);
    expect(g.state.turn.phase).toBe('AWAITING_PAYMENT');
    const priya = g.balance('Priya');
    const r = g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(r.transactions).toHaveLength(0);
    expect(g.balance('Priya')).toBe(priya);
    expect(g.balance('Tanmay')).toBe(RULES.startingCash);
    expect(g.current).toBe('Shamin');
    expect(g.state.turn).toMatchObject({ pending: null, followUp: null });
  });

  it('one request, one turn change: a second request is refused and the turn does not move again', () => {
    const g = new TestGame(NAMES);
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    const turn = structuredClone(g.state.turn);
    expect(() => g.act('Tanmay', { type: 'LEAVE_GAME' })).toThrow('You have left this game.');
    expect(g.state.turn).toEqual(turn);
  });
});

describe('LEAVE_GAME during an auction, a trade or an undo request', () => {
  it('a bidder who is not leading counts as passed; the auction carries on', () => {
    const { g, auctionId } = withAuction();
    g.act('Shamin', { type: 'PLACE_BID', auctionId, amount: 500 });
    g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.auction).toMatchObject({ status: 'OPEN', highBidderId: g.id('Shamin') });
    expect(g.state.auction!.passedIds).toContain(g.id('Ram'));
    // Once everyone else is out too, the leader wins as usual.
    g.act('Priya', { type: 'PASS_AUCTION', auctionId });
    g.act('Tanmay', { type: 'PASS_AUCTION', auctionId });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Shamin') });
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Shamin'));
  });

  it('the leading bidder leaves: nobody is charged and the property stays with the bank', () => {
    const { g, auctionId } = withAuction();
    g.act('Ram', { type: 'PLACE_BID', auctionId, amount: 500 });
    const r = g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null });
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
    expect(r.transactions).toHaveLength(0);
    expect(g.balance('Ram')).toBe(RULES.startingCash);
    expect(r.events.find((e) => e.type === 'AUCTION_UNSOLD')!.message).toBe('Railway stays with the bank (Ram left the game)');
    // Still Tanmay's turn, ready to end.
    expect(g.state.turn).toMatchObject({ playerId: g.id('Tanmay'), phase: 'TURN_COMPLETE' });
  });

  it('the player whose turn it is leaves mid-auction: the others finish it, then the turn passes on by itself', () => {
    const { g, auctionId } = withAuction();
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.auction).toMatchObject({ status: 'OPEN' });
    expect(g.state.turn).toMatchObject({ playerId: g.id('Tanmay'), phase: 'AUCTION' });
    g.act('Shamin', { type: 'PLACE_BID', auctionId, amount: 500 });
    g.act('Ram', { type: 'PASS_AUCTION', auctionId });
    const r = g.act('Priya', { type: 'PASS_AUCTION', auctionId });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: g.id('Shamin') });
    expect(eventsOf(r)).toEqual(expect.arrayContaining(['AUCTION_WON', 'TURN_STARTED']));
    expect(g.current).toBe('Shamin');
    expect(g.state.turn.phase).toBe('AWAITING_ROLL');
  });

  it('their open trade offers expire and an undo request waiting on them is dropped', () => {
    const g = new TestGame(NAMES);
    g.give('Ram', 'DELHI');
    g.act('Ram', { type: 'CREATE_TRADE', toPlayerId: g.id('Priya'), offeredPropertyKeys: ['DELHI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
    g.act('Shamin', { type: 'CREATE_TRADE', toPlayerId: g.id('Ram'), offeredPropertyKeys: [], requestedPropertyKeys: ['DELHI'], offeredMoney: 100, requestedMoney: 0 });
    g.act('Tanmay', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Ram'), amount: 100 });
    g.act('Tanmay', { type: 'REQUEST_UNDO', targetActionId: g.state.undoStack.at(-1)!.actionId });
    expect(g.state.undoRequest!.approverIds).toEqual([g.id('Ram')]);
    g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.trades.map((t) => t.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(g.state.undoRequest).toBeNull();
    expect(g.balance('Ram')).toBe(RULES.startingCash + 100); // the payment stands
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Ram'));
  });

  it('a paused game can be left; it stays paused for the others', () => {
    const g = new TestGame(NAMES);
    g.act('Ram', { type: 'PAUSE_GAME' });
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('PAUSED');
    expect(g.current).toBe('Shamin');
    g.act('Priya', { type: 'RESUME_GAME' });
    expect(g.state.status).toBe('ACTIVE');
  });
});

describe('LEAVE_GAME and the host', () => {
  it('leaving is never ending: only the host can end the game, before and after someone leaves', () => {
    const g = new TestGame(NAMES);
    expect(() => g.act('Ram', { type: 'END_GAME' })).toThrow('Only the host can end the game.');
    g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('ACTIVE');
    expect(() => g.act('Shamin', { type: 'END_GAME' })).toThrow('Only the host can end the game.');
    g.act('Tanmay', { type: 'END_GAME' });
    expect(g.state.status).toBe('FINISHED');
  });

  it('the host leaves: the next player in the drawn order becomes the only host', () => {
    const g = new TestGame(NAMES);
    const r = g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.hostPlayerId).toBe(g.id('Shamin'));
    expect(g.state.players.filter((p) => p.isHost).map((p) => p.name)).toEqual(['Shamin']);
    expect(r.events.find((e) => e.type === 'HOST_CHANGED')).toMatchObject({ message: 'Shamin is now the host', payload: { hostPlayerId: g.id('Shamin') } });
    expect(g.state.status).toBe('ACTIVE');
    expect(() => g.act('Ram', { type: 'END_GAME' })).toThrow('Only the host can end the game.');
    g.act('Shamin', { type: 'END_GAME' });
    expect(g.state.status).toBe('FINISHED');
  });

  it('a bankrupt or departed player is never made host', () => {
    const g = new TestGame(NAMES);
    g.act('Shamin', { type: 'LEAVE_GAME' });
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.hostPlayerId).toBe(g.id('Ram'));
  });
});

describe('LEAVE_GAME when too few players remain', () => {
  it('two players, one leaves: the game finishes and the one who stayed wins', () => {
    const g = new TestGame(['Tanmay', 'Shamin']);
    const r = g.act('Shamin', { type: 'LEAVE_GAME' });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: g.id('Tanmay') });
    const finished = r.events.find((e) => e.type === 'GAME_FINISHED')!;
    expect(finished.payload).toMatchObject({ reason: 'PLAYERS_LEFT', winnerId: g.id('Tanmay') });
    expect(() => g.act('Tanmay', { type: 'ROLL_DICE' })).toThrow('This game has finished.');
  });

  it('a bankrupt player leaving changes nothing for those still playing', () => {
    const g = new TestGame(NAMES);
    g.act('Tanmay', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Priya'), amount: g.balance('Tanmay') });
    g.give('Shamin', 'DELHI');
    g.placeBefore('Tanmay', 'DELHI', 3);
    g.roll('Tanmay', 1, 2);
    g.act('Tanmay', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.player('Tanmay').status).toBe('BANKRUPT');
    const turn = structuredClone(g.state.turn);
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.player('Tanmay').status).toBe('LEFT');
    expect(g.state.status).toBe('ACTIVE');
    expect(g.state.turn).toEqual(turn);
    expect(g.state.hostPlayerId).toBe(g.id('Shamin'));
  });
});

describe('LEAVE_GAME in the lobby', () => {
  it('a player who leaves before the start gets no turn and no cash; the rest start normally', () => {
    const g = new TestGame(NAMES, { start: false });
    g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('WAITING');
    expect(() => g.act('Ram', { type: 'SET_READY', ready: true })).toThrow('You have left this game.');
    const r = g.act('Tanmay', { type: 'START_GAME' });
    const playing = g.state.players.filter((p) => p.status === 'ACTIVE');
    expect(playing.map((p) => p.name).sort()).toEqual(['Priya', 'Shamin', 'Tanmay']);
    expect(playing.map((p) => p.seat).sort()).toEqual([0, 1, 2]); // first in the order; Ram comes after
    expect(g.player('Ram')).toMatchObject({ status: 'LEFT', balance: 0, seat: 3 });
    expect(r.transactions.filter((t) => t.type === 'STARTING_FUNDS')).toHaveLength(3);
    expect((r.events.find((e) => e.type === 'GAME_STARTED')!.payload.turnOrder as string[]).includes(g.id('Ram'))).toBe(false);
    for (let i = 0; i < 6; i += 1) {
      expect(g.current).not.toBe('Ram');
      passTurn(g, g.current);
    }
  });

  it('counts only players still there towards the minimum and the maximum; a departed name stays taken', () => {
    const g = new TestGame(['Tanmay', 'Shamin'], { start: false });
    g.act('Shamin', { type: 'LEAVE_GAME' });
    expect(() => g.act('Tanmay', { type: 'START_GAME' })).toThrow(`Need at least ${RULES.players.min} players to start.`);

    const full = new TestGame(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], { start: false });
    expect(() => full.join('Late')).toThrow(/This game is full/);
    full.act('H', { type: 'LEAVE_GAME' });
    expect(() => full.join('h')).toThrow('Someone in this game already has that name.');
    full.join('Late');
    expect(full.state.players.filter((p) => p.status === 'ACTIVE')).toHaveLength(RULES.players.max);
  });

  it('the host leaves the lobby: the next player hosts and can start; the last one out closes the lobby', () => {
    const g = new TestGame(['Tanmay', 'Shamin', 'Ram'], { start: false });
    g.act('Tanmay', { type: 'LEAVE_GAME' });
    expect(g.state.hostPlayerId).toBe(g.id('Shamin'));
    expect(g.player('Shamin')).toMatchObject({ isHost: true, ready: true });
    expect(() => g.act('Ram', { type: 'START_GAME' })).toThrow('Only the host can start the game.');
    g.act('Ram', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('WAITING');
    const r = g.act('Shamin', { type: 'LEAVE_GAME' });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: null });
    expect(r.events.find((e) => e.type === 'GAME_FINISHED')!.payload).toMatchObject({ reason: 'PLAYERS_LEFT', winnerId: null });
  });
});
