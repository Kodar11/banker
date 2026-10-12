/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canSeeFinances,
  defaultGameConfig,
  EVENT_PRIVACY,
  financesHidden,
  formatINR,
  GameError,
  gameConfigSummary,
  legacyGameConfig,
  normalizeGameConfig,
  offeredRate,
  parseGameConfig,
  positionOfProperty,
  positionOfSpecial,
  premiumForYear,
  publicEvents,
  redactFinances,
  type GameEventRecord,
  type GameMode,
  type GameSnapshot,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const HIDDEN = { financialPrivacy: 'hidden' };

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

/** The whole game as the server holds it: every event and ledger entry, newest first (as loadSnapshot reads them). */
function full(g: TestGame): GameSnapshot {
  return {
    state: g.state,
    events: g.results.flatMap((r) => r.events).reverse(),
    transactions: [...g.ledger].reverse(),
    serverTime: '2026-01-01T10:00:00.000Z',
  };
}

/** What `name`'s phone is sent. */
const seenBy = (g: TestGame, name: string) => redactFinances(full(g), g.id(name));
const messages = (s: GameSnapshot) => s.events.map((e) => e.message);
const playerIn = (s: GameSnapshot, g: TestGame, name: string) => s.state.players.find((p) => p.id === g.id(name))!;

// ---------------------------------------------------------------------------

describe('the setting', () => {
  it('is Open by default, in both modes, and for a game stored before it existed', () => {
    for (const mode of ['classic', 'intermediate'] as GameMode[]) {
      expect(defaultGameConfig(mode).financialPrivacy).toBe('open');
      expect(legacyGameConfig(mode).financialPrivacy).toBe('open');
      expect(parseGameConfig(mode, undefined).financialPrivacy).toBe('open');
      expect(normalizeGameConfig(mode, null).financialPrivacy).toBe('open');
      // A config written before the setting existed has no such key.
      expect(normalizeGameConfig(mode, { startingCash: 30000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false }).financialPrivacy).toBe('open');
    }
    expect(financesHidden(new TestGame().state)).toBe(false);
  });

  it('the host can choose Hidden when creating a Classic or a Capital game, and it is stored in the game', () => {
    for (const mode of ['classic', 'intermediate'] as GameMode[]) {
      const g = new TestGame(['Asha', 'Bilal'], { mode, config: HIDDEN });
      expect(g.state.config.financialPrivacy).toBe('hidden');
      expect(financesHidden(g.state)).toBe(true);
      // Read back from storage (what a reconnect or a restore does), it is still hidden.
      expect(normalizeGameConfig(mode, JSON.parse(JSON.stringify(g.state.config))).financialPrivacy).toBe('hidden');
      expect(gameConfigSummary(mode, g.state.config).find((r) => r.key === 'financialPrivacy')?.value).toBe('Hidden');
    }
  });

  it('refuses a value that is neither', () => {
    expect(refusal(() => parseGameConfig('classic', { financialPrivacy: 'secret' })).code).toBe('VALIDATION');
    expect(refusal(() => parseGameConfig('classic', { financialPrivacy: true })).code).toBe('VALIDATION');
  });

  it('is fixed once the game is created: the lobby can change the other settings but not this one', () => {
    for (const [chosen, other] of [
      ['hidden', 'open'],
      ['open', 'hidden'],
    ] as const) {
      const g = new TestGame(['Asha', 'Bilal'], { start: false, config: { financialPrivacy: chosen } });
      // Asking for the other one is refused, not ignored.
      const r = refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { ...g.state.config, financialPrivacy: other } }));
      expect(r.code).toBe('VALIDATION');
      expect(r.message).toMatch(/can’t be changed/);
      // Leaving it out (an older app) or repeating it keeps it; the rest still changes.
      g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 30000 } });
      expect(g.state.config).toMatchObject({ startingCash: 30000, financialPrivacy: chosen });
      g.act('Asha', { type: 'UPDATE_CONFIG', config: { ...g.state.config, loanLimit: 10000 } });
      expect(g.state.config).toMatchObject({ loanLimit: 10000, financialPrivacy: chosen });
      // A joiner can change nothing at all.
      expect(refusal(() => g.act('Bilal', { type: 'UPDATE_CONFIG', config: { financialPrivacy: other } })).code).toBe('FORBIDDEN');
      // And once started, nobody can.
      g.startWith(['Asha', 'Bilal']);
      expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { financialPrivacy: other } })).code).toBe('INVALID_PHASE');
      expect(g.state.config.financialPrivacy).toBe(chosen);
    }
  });
});

describe('every event the engine emits is classified', () => {
  it('no d.event(...) type is missing from EVENT_PRIVACY', () => {
    const dir = join(__dirname, '..', '..', 'src', 'engine');
    const emitted = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      // The first argument of every d.event( call: a literal, or a choice between literals.
      for (const call of source.matchAll(/\bd\.event\(\s*([^,]+),/g)) {
        // (A condition that picks between two types compares against a status literal: that is not a type.)
        const literals = [...call[1]!.replace(/===\s*'[A-Z_]+'/g, '').matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]!);
        // The one call that passes a variable: collectFromEachPlayer's shortfall event.
        if (literals.length === 0) expect(call[1]!.trim()).toBe('event');
        literals.forEach((t) => emitted.add(t));
      }
    }
    emitted.add('CARD_SHORTFALL').add('REST_HOUSE_SHORTFALL');
    expect(emitted.size).toBeGreaterThan(80);
    expect([...emitted].filter((t) => !(t in EVENT_PRIVACY))).toEqual([]);
  });

  it('an event type nobody classified is kept from everyone but its actor', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: HIDDEN });
    const mystery: GameEventRecord = { id: 'e', type: 'SOMETHING_NEW', actorId: g.id('Asha'), message: 'Asha did something worth ₹9,999', payload: { amount: 9999 }, createdAt: 'now' };
    const snapshot = { ...full(g), events: [mystery] };
    expect(redactFinances(snapshot, g.id('Asha')).events).toEqual([mystery]);
    expect(redactFinances(snapshot, g.id('Bilal')).events).toEqual([]);
    expect(publicEvents(g.state, [mystery])).toEqual([]);
  });
});

describe('open finances: nothing changes', () => {
  it('the snapshot is sent exactly as it is, to everyone', () => {
    const g = new TestGame();
    g.landOn('Asha', positionOfProperty('MUMBAI'), 7);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    const snapshot = full(g);
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(redactFinances(snapshot, g.id(name))).toBe(snapshot);
    expect(redactFinances(snapshot, null)).toBe(snapshot);
    const events = g.results.flatMap((r) => r.events);
    expect(publicEvents(g.state, events)).toEqual(events);
    expect(canSeeFinances(g.state, g.id('Bilal'), g.id('Asha'))).toBe(true);
  });
});

describe('hidden finances, Classic', () => {
  /** Asha owns Mumbai and has a bank loan; Bilal landed on it and paid rent. Three players, so Chitra watched it all. */
  function played() {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { config: HIDDEN });
    g.landOn('Asha', positionOfProperty('MUMBAI'), 7);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.act('Asha', { type: 'END_TURN' });
    g.landOn('Bilal', positionOfProperty('MUMBAI'), 7);
    return g;
  }

  it('a player always sees their own cash, loans and ledger; nobody else does', () => {
    const g = played();
    const rent = g.state.turn.pending!;
    g.act('Bilal', { type: 'PAY_RENT' });

    const asha = seenBy(g, 'Asha');
    expect(playerIn(asha, g, 'Asha').balance).toBe(g.balance('Asha'));
    expect(asha.state.loans).toEqual(g.state.loans);
    expect(asha.state.loans).toHaveLength(1);
    expect(asha.transactions.length).toBeGreaterThan(0);
    expect(asha.transactions.every((t) => t.fromPlayerId === g.id('Asha') || t.toPlayerId === g.id('Asha'))).toBe(true);
    // Her own ledger is complete: every entry of hers the server holds.
    expect(asha.transactions).toEqual(full(g).transactions.filter((t) => t.fromPlayerId === g.id('Asha') || t.toPlayerId === g.id('Asha')));
    expect(messages(asha)).toContain(`Asha borrowed ${formatINR(5000)} from the bank`);

    for (const watcher of ['Bilal', 'Chitra']) {
      const view = seenBy(g, watcher);
      expect(canSeeFinances(view.state, g.id(watcher), g.id('Asha'))).toBe(false);
      expect(canSeeFinances(view.state, g.id(watcher), g.id(watcher))).toBe(true);
      // Their own money is whole.
      expect(playerIn(view, g, watcher).balance).toBe(g.balance(watcher));
      // Asha's is not there: no cash, no loan, no ledger entry of hers they took no part in.
      expect(playerIn(view, g, 'Asha').balance).toBe(0);
      expect(view.state.loans).toEqual([]);
      expect(view.transactions.every((t) => t.fromPlayerId === g.id(watcher) || t.toPlayerId === g.id(watcher))).toBe(true);
      expect(messages(view).some((m) => /borrowed|loan/i.test(m))).toBe(false);
      // Nothing anywhere in what they were sent carries her balance or the loan.
      const wire = JSON.stringify(view);
      expect(wire).not.toContain(String(g.balance('Asha')));
      expect(wire).not.toContain(g.state.loans[0]!.id);
    }
    expect(rent.kind).toBe('PAYMENT');
  });

  it('what the table can see stays: position, ownership, buildings, mortgages, purchases', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    g.act('Bilal', { type: 'END_TURN' });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const view = seenBy(g, 'Chitra');
    expect(view.state.properties).toEqual(g.state.properties);
    expect(view.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), mortgaged: true });
    expect(view.state.players.map((p) => ({ id: p.id, name: p.name, position: p.position, status: p.status, inJail: p.inJail }))).toEqual(
      g.state.players.map((p) => ({ id: p.id, name: p.name, position: p.position, status: p.status, inJail: p.inJail })),
    );
    expect(view.state.trades).toEqual(g.state.trades);
    expect(view.state.config).toEqual(g.state.config);
    // Public property transactions are told in full.
    expect(messages(view).some((m) => /^Asha bought Mumbai for ₹/.test(m))).toBe(true);
    expect(messages(view).some((m) => /^Asha mortgaged Mumbai for ₹/.test(m))).toBe(true);
    expect(messages(view).some((m) => /^Bilal rolled 7 → Mumbai/.test(m))).toBe(true);
  });

  it('rent is public: the bill and the payment are shown to everyone, amount included', () => {
    const g = played();
    const owed = g.state.turn.pending!;
    if (owed.kind !== 'PAYMENT') throw new Error('expected rent to be due');
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(seenBy(g, name).state.turn.pending).toEqual(owed);

    g.act('Bilal', { type: 'PAY_RENT' });
    const paid = `Bilal paid ${formatINR(owed.amount)} to Asha (Rent for Mumbai)`;
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(messages(seenBy(g, name))).toContain(paid);
    const chitra = seenBy(g, 'Chitra');
    expect(chitra.events.find((e) => e.type === 'PAYMENT_MADE')).toEqual(full(g).events.find((e) => e.type === 'PAYMENT_MADE'));
    // What it did to either player's cash is still theirs: no balance, no ledger entry.
    expect(playerIn(chitra, g, 'Asha').balance).toBe(0);
    expect(playerIn(chitra, g, 'Bilal').balance).toBe(0);
    expect(chitra.transactions.some((t) => t.type === 'RENT_PAYMENT')).toBe(false);
  });

  it('tax: everyone sees the landing, only the payer sees what was paid', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    g.act('Bilal', { type: 'END_TURN' });
    g.act('Chitra', { type: 'ROLL_DICE' });
    if (g.state.turn.phase === 'AWAITING_DECISION') g.act('Chitra', { type: 'DECLINE_PROPERTY' });
    if (g.state.auction?.status === 'OPEN') {
      for (const name of ['Asha', 'Bilal', 'Chitra']) g.act(name, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
    }
    if (g.state.turn.phase !== 'TURN_COMPLETE') throw new Error(`unexpected phase ${g.state.turn.phase}`);
    g.act('Chitra', { type: 'END_TURN' });
    g.landOn('Asha', positionOfSpecial('INCOME_TAX'), 7);
    const tax = g.state.turn.pending!;
    if (tax.kind !== 'PAYMENT') throw new Error('expected tax to be due');
    expect(seenBy(g, 'Asha').state.turn.pending).toEqual(tax);
    expect(seenBy(g, 'Bilal').state.turn.pending).toBeNull();
    g.act('Asha', { type: 'PAY_TAX' });

    expect(messages(seenBy(g, 'Asha')).some((m) => m.startsWith(`Asha paid ${formatINR(tax.amount)} to Bank (Income Tax`))).toBe(true);
    for (const watcher of ['Bilal', 'Chitra']) {
      const view = seenBy(g, watcher);
      expect(messages(view)).toContain('Asha rolled 7 → Income Tax');
      expect(messages(view)).toContain('Asha paid tax');
      expect(messages(view).some((m) => m.includes('Income Tax —') || m.includes('to Bank'))).toBe(false);
      expect(view.events.find((e) => e.type === 'PAYMENT_MADE' && e.actorId === g.id('Asha'))!.payload).toEqual({ reason: 'TAX' });
      expect(view.transactions.some((t) => t.type === 'TAX_PAYMENT')).toBe(false);
    }
  });

  it('loans and repayments reach nobody else, in the feed or the broadcast', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 1000 });
    expect(messages(seenBy(g, 'Asha')).some((m) => m.startsWith(`Asha repaid ${formatINR(1000)}`))).toBe(true);
    expect(seenBy(g, 'Chitra').events.some((e) => e.type.startsWith('LOAN'))).toBe(false);
    const broadcast = publicEvents(g.state, g.results.flatMap((r) => r.events));
    expect(broadcast.some((e) => e.type.startsWith('LOAN'))).toBe(false);
    expect(broadcast.some((e) => /borrowed|repaid/.test(e.message))).toBe(false);
    expect(broadcast.some((e) => /^Bilal paid ₹.* to Asha \(Rent for Mumbai\)$/.test(e.message))).toBe(true);
    expect(broadcast.some((e) => e.type === 'PROPERTY_PURCHASED')).toBe(true);
  });

  it('a direct payment between two players is theirs: others learn only that it happened', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1234 });
    const told = `Bilal paid Asha ${formatINR(1234)}`;
    expect(messages(seenBy(g, 'Bilal'))).toContain(told);
    expect(messages(seenBy(g, 'Asha'))).toContain(told);
    const chitra = seenBy(g, 'Chitra');
    expect(messages(chitra)).toContain('Bilal paid Asha');
    expect(JSON.stringify(chitra.events)).not.toContain('1234');
    expect(JSON.stringify(chitra.events)).not.toContain(formatINR(1234));
  });

  it('passing Start is seen, the reward is not announced', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: HIDDEN });
    g.placeAt('Asha', 34);
    g.rollTotal('Asha', 4);
    expect(messages(seenBy(g, 'Asha')).some((m) => /^Asha collected ₹.* for passing Start$/.test(m))).toBe(true);
    const bilal = seenBy(g, 'Bilal');
    expect(messages(bilal)).toContain('Asha passed Start');
    expect(messages(bilal).some((m) => m.includes('collected'))).toBe(false);
  });

  it('the feed keeps its order and timestamps: events are rewritten in place or left out, never moved', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    const all = full(g).events;
    const seen = seenBy(g, 'Chitra').events;
    expect(seen.length).toBeLessThan(all.length);
    const order = seen.map((e) => all.findIndex((x) => x.id === e.id));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const e of seen) {
      const original = all.find((x) => x.id === e.id)!;
      expect({ type: e.type, actorId: e.actorId, createdAt: e.createdAt }).toEqual({ type: original.type, actorId: original.actorId, createdAt: original.createdAt });
    }
  });

  it('undo: the players involved see what would be undone; the rest see that something would', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    const top = g.state.undoStack[g.state.undoStack.length - 1]!;
    expect(seenBy(g, 'Bilal').state.undoStack.at(-1)).toEqual(top);
    expect(seenBy(g, 'Asha').state.undoStack.at(-1)).toEqual(top);
    expect(seenBy(g, 'Chitra').state.undoStack.at(-1)).toMatchObject({ actionId: top.actionId, description: "Another player's action", moves: [], transactionIds: [] });
    g.act('Bilal', { type: 'REQUEST_UNDO', targetActionId: top.actionId });
    expect(seenBy(g, 'Asha').state.undoRequest).toEqual(g.state.undoRequest);
    expect(seenBy(g, 'Chitra').state.undoRequest!.description).toBe("Another player's action");
    expect(messages(seenBy(g, 'Chitra'))).toContain('Bilal asked to undo an action');
    const chitra = seenBy(g, 'Chitra').state;
    expect(JSON.stringify([chitra.undoStack, chitra.undoRequest])).not.toContain(top.description);
  });

  it('auctions and trades are played, and told, exactly as in an open game', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { config: HIDDEN });
    g.landOn('Asha', positionOfProperty('MUMBAI'), 7);
    g.act('Asha', { type: 'START_AUCTION' });
    const auctionId = g.state.auction!.id;
    g.act('Bilal', { type: 'PLACE_BID', auctionId, amount: g.state.auction!.minimumOpeningBid });
    g.act('Asha', { type: 'PASS_AUCTION', auctionId });
    g.act('Chitra', { type: 'PASS_AUCTION', auctionId });
    if (g.state.auction?.status === 'OPEN') {
      g.advance(600);
      g.act('Asha', { type: 'CLOSE_AUCTION', auctionId });
    }
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
    g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 2500 });
    g.act('Asha', { type: 'ACCEPT_TRADE', tradeId: g.state.trades.at(-1)!.id });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));

    const chitra = seenBy(g, 'Chitra');
    const told = full(g).events;
    for (const type of ['AUCTION_STARTED', 'BID_PLACED', 'AUCTION_PASSED', 'AUCTION_WON', 'TRADE_OFFERED', 'TRADE_ACCEPTED']) {
      expect(chitra.events.filter((e) => e.type === type), type).toEqual(told.filter((e) => e.type === type));
      expect(told.some((e) => e.type === type), type).toBe(true);
    }
    expect(chitra.state.auction).toEqual(g.state.auction);
    expect(chitra.state.trades).toEqual(g.state.trades);
  });

  it('when the game has finished, everything is revealed', () => {
    const g = played();
    g.act('Bilal', { type: 'PAY_RENT' });
    expect(financesHidden(g.state)).toBe(true);
    g.act('Asha', { type: 'END_GAME' });
    expect(g.state.status).toBe('FINISHED');
    expect(financesHidden(g.state)).toBe(false);
    const snapshot = full(g);
    expect(redactFinances(snapshot, g.id('Chitra'))).toBe(snapshot);
  });
});

describe('hidden finances, Capital', () => {
  function played() {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { mode: 'intermediate', config: { ...HIDDEN, secretObjectives: false } });
    g.landOn('Asha', positionOfProperty('MUMBAI'), 7);
    g.act('Asha', { type: 'BUY_PROPERTY' });
    const eco = g.state.intermediate!;
    g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: offeredRate('PERSONAL', eco.credit[g.id('Asha')]!).ratePercent });
    g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: premiumForYear(eco.year) });
    return g;
  }

  it('credit, loan contracts and insurance are the owner’s alone; the market and the calendar stay public', () => {
    const g = played();
    const eco = g.state.intermediate!;
    const premium = premiumForYear(eco.year);

    const asha = seenBy(g, 'Asha').state.intermediate!;
    expect(asha.loans).toEqual(eco.loans);
    expect(asha.credit).toEqual({ [g.id('Asha')]: eco.credit[g.id('Asha')] });
    expect(asha.insurance!.policies).toEqual(eco.insurance!.policies);
    expect(asha.insurance!.policies[0]!.premiumPaid).toBe(premium);

    for (const watcher of ['Bilal', 'Chitra']) {
      const view = seenBy(g, watcher);
      const seen = view.state.intermediate!;
      expect(seen.loans).toEqual([]);
      expect(Object.keys(seen.credit)).toEqual([g.id(watcher)]);
      expect(seen.creditEvents.every((e) => e.playerId === g.id(watcher))).toBe(true);
      expect(Object.keys(seen.yearFlags).every((id) => id === g.id(watcher))).toBe(true);
      // Public: the calendar, the market, movement and the crises so far.
      expect(seen.market).toEqual(eco.market);
      expect(seen.movement).toEqual(eco.movement);
      expect(seen.year).toBe(eco.year);
      expect(seen.insurance!.crises).toEqual(eco.insurance!.crises);
      expect(seen.insurance!.nextCheckpoint).toBe(eco.insurance!.nextCheckpoint);
      // Whether Mumbai is insured is Asha's to know: no policy, and no word of it in the feed or the broadcast.
      expect(seen.insurance!.policies).toEqual([]);
      expect(messages(view).some((m) => /insur/i.test(m))).toBe(false);
      expect(view.events.some((e) => e.type.startsWith('INSURANCE'))).toBe(false);
      expect(JSON.stringify(view)).not.toContain(eco.insurance!.policies[0]!.id);
      expect(messages(view).some((m) => /^Asha bought Mumbai for ₹/.test(m))).toBe(true);
      expect(view.events.some((e) => e.type === 'INTERMEDIATE_LOAN_TAKEN' || e.type === 'CREDIT_SCORE_CHANGED' || e.type.startsWith('LOAN'))).toBe(false);
      expect(JSON.stringify(view)).not.toContain(eco.loans[0]!.id);
    }
    expect(messages(seenBy(g, 'Asha'))).toContain(`Asha insured Mumbai for ${formatINR(premium)}`);
    expect(publicEvents(g.state, g.results.flatMap((r) => r.events)).some((e) => /insur/i.test(e.message))).toBe(false);
    expect(seenBy(g, 'Asha').events.some((e) => e.type === 'INTERMEDIATE_LOAN_TAKEN')).toBe(true);
  });
});
