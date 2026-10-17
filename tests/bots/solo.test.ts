import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameAction } from '@/engine/index.ts';

vi.mock('@/lib/device', () => ({ newActionId: () => randomUUID() }));

const { createSoloGame, discardSoloGame, isLocalGame, localAction, localState, soloBots, subscribeLocal, SOLO_BOT_PACE_MS } = await import('@/features/solo/localGame');

describe('solo games on the device', () => {
  afterEach(() => vi.useRealTimers());

  it('starts a game with the person and the bots, already running, with the same starting cash for everyone', () => {
    const c = createSoloGame({ name: 'Tanmay', mode: 'classic', bots: soloBots(3, 'easy', 'mixed') });
    expect(c.local).toBe(true);
    const res = localState(c);
    if (!res.ok) throw new Error(res.error.message);
    const s = res.snapshot.state;
    expect(s.status).toBe('ACTIVE');
    expect(s.players).toHaveLength(4);
    expect(s.players.filter((p) => p.bot).map((p) => p.bot!.personality).sort()).toHaveLength(3);
    expect(new Set(s.players.map((p) => p.balance))).toEqual(new Set([25000]));
    discardSoloGame(c.gameId);
    expect(isLocalGame(c.gameId)).toBe(false);
  });

  it('plays the bots by itself and waits for the person; the person acts through the engine', async () => {
    vi.useFakeTimers();
    const c = createSoloGame({ name: 'Tanmay', mode: 'classic', bots: soloBots(2, 'normal', 'investor') });
    const pings: number[] = [];
    subscribeLocal(c.gameId, (p) => pings.push(p.version));
    for (let round = 0; round < 40; round += 1) {
      const res = localState(c);
      if (!res.ok) throw new Error(res.error.message);
      const s = res.snapshot.state;
      if (s.turn.playerId === c.playerId) {
        const phase = s.turn.phase;
        const action =
          phase === 'AWAITING_ROLL'
            ? s.players.find((p) => p.id === c.playerId)!.inJail
              ? { type: 'STAY_IN_JAIL' as const }
              : { type: 'ROLL_DICE' as const }
            : phase === 'AWAITING_DECISION'
              ? { type: 'DECLINE_PROPERTY' as const }
              : phase === 'TURN_COMPLETE'
                ? { type: 'END_TURN' as const }
                : null;
        if (action) {
          const r = localAction(c, randomUUID(), s.version, action);
          expect(r.ok || (!r.ok && r.error.code !== 'NOT_FOUND')).toBe(true);
        } else if (phase === 'AWAITING_PAYMENT' && s.turn.pending?.kind === 'PAYMENT') {
          const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', CLUB: 'PAY_CLUB', LOAN_INTEREST: 'PAY_INTEREST' } as const;
          localAction(c, randomUUID(), s.version, { type: pay[s.turn.pending.reason] });
        } else if (s.auction?.status === 'OPEN' && s.auction.participantIds.includes(c.playerId) && !s.auction.passedIds.includes(c.playerId)) {
          localAction(c, randomUUID(), s.version, { type: 'PASS_AUCTION', auctionId: s.auction.id });
        }
      } else if (s.auction?.status === 'OPEN' && s.auction.participantIds.includes(c.playerId) && !s.auction.passedIds.includes(c.playerId)) {
        localAction(c, randomUUID(), s.version, { type: 'PASS_AUCTION', auctionId: s.auction.id });
      }
      await vi.advanceTimersByTimeAsync(SOLO_BOT_PACE_MS * 4 + 6500);
    }
    const end = localState(c);
    if (!end.ok) throw new Error(end.error.message);
    expect(end.snapshot.state.turn.number).toBeGreaterThan(10);
    expect(pings.length).toBeGreaterThan(10);
    discardSoloGame(c.gameId);
  });

  it('a repeated action id is answered without being applied twice; a stale screen is refused', () => {
    const c = createSoloGame({ name: 'Tanmay', mode: 'classic', bots: soloBots(1, 'easy', 'banker') });
    const s = localState(c);
    if (!s.ok) throw new Error();
    if (s.snapshot.state.turn.playerId !== c.playerId) return discardSoloGame(c.gameId);
    const id = randomUUID();
    const first = localAction(c, id, s.snapshot.state.version, { type: 'ROLL_DICE' });
    const again = localAction(c, id, s.snapshot.state.version, { type: 'ROLL_DICE' });
    expect(first.ok && again.ok && again.duplicate).toBe(true);
    expect(localAction(c, randomUUID(), s.snapshot.state.version, { type: 'END_TURN' })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    discardSoloGame(c.gameId);
  });

  it('with hidden finances the person sees only their own cash, as from the server', () => {
    const c = createSoloGame({ name: 'Tanmay', mode: 'intermediate', config: { financialPrivacy: 'hidden' }, bots: soloBots(2, 'hard', 'mixed') });
    const res = localState(c);
    if (!res.ok) throw new Error();
    for (const p of res.snapshot.state.players) expect(p.balance).toBe(p.id === c.playerId ? 25000 : 0);
    discardSoloGame(c.gameId);
  });

  it('the bots bid in a resale the person lists, with nothing more from the person', async () => {
    vi.useFakeTimers();
    const c = createSoloGame({ name: 'Tanmay', mode: 'intermediate', bots: soloBots(2, 'normal', 'opportunist') });
    const pay = { RENT: 'PAY_RENT', TAX: 'PAY_TAX', CARD: 'PAY_CARD', CLUB: 'PAY_CLUB', LOAN_INTEREST: 'PAY_INTEREST' } as const;
    let listed = false;
    let events: string[] = [];
    for (let round = 0; round < 400 && !listed; round += 1) {
      const res = localState(c);
      if (!res.ok) throw new Error(res.error.message);
      const s = res.snapshot.state;
      const me = s.players.find((p) => p.id === c.playerId)!;
      const owned = (Object.keys(s.properties) as (keyof typeof s.properties)[]).filter((k) => s.properties[k].ownerId === c.playerId && !s.properties[k].mortgaged && s.properties[k].houses === 0);
      let action: GameAction | null = null;
      if (s.auction?.status === 'OPEN') {
        if (s.auction.participantIds.includes(c.playerId) && !s.auction.passedIds.includes(c.playerId)) action = { type: 'PASS_AUCTION', auctionId: s.auction.id };
      } else if (s.turn.playerId === c.playerId) {
        const phase = s.turn.phase;
        if (phase === 'AWAITING_ROLL' && owned.length > 0 && !me.inJail) {
          action = { type: 'START_RESALE_AUCTION', propertyKey: owned[0]!, reservePrice: 500 };
          listed = true;
        } else if (phase === 'AWAITING_ROLL') action = me.inJail ? { type: 'STAY_IN_JAIL' } : { type: 'ROLL_DICE' };
        else if (phase === 'AWAITING_DECISION') action = { type: 'BUY_PROPERTY' };
        else if (phase === 'TURN_COMPLETE') action = { type: 'END_TURN' };
        else if (phase === 'AWAITING_PAYMENT' && s.turn.pending?.kind === 'PAYMENT') action = { type: pay[s.turn.pending.reason] };
      }
      if (action) {
        const r = localAction(c, randomUUID(), s.version, action);
        if (!r.ok && action.type === 'START_RESALE_AUCTION') listed = false;
      }
      if (listed) {
        // The whole auction runs out with no input from the person: the device's own timers and bots only.
        await vi.advanceTimersByTimeAsync(20_000);
        const after = localState(c);
        if (!after.ok) throw new Error(after.error.message);
        events = after.snapshot.events.map((e) => e.type);
        break;
      }
      await vi.advanceTimersByTimeAsync(SOLO_BOT_PACE_MS * 4 + 6500);
    }
    discardSoloGame(c.gameId);
    expect(listed).toBe(true);
    expect(events).toContain('BID_PLACED');
    expect(events).not.toContain('AUCTION_UNSOLD');
  });
});
