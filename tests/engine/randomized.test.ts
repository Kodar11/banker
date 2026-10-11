import { describe, expect, it } from 'vitest';
import type { GameMode } from '@/engine/index.ts';
import { replay, runScenario, type RunOutcome, type Scenario } from './randomHarness.ts';

/**
 * Seeded randomized play through the real engine, with every invariant (invariantChecks.ts)
 * asserted after each legal action. Deterministic: a seed always plays the same game, so a
 * failure names the seed and prints the steps to replay.
 *
 *   RANDOM_SEEDS=200 RANDOM_STEPS=800 npx vitest run tests/engine/randomized.test.ts   (a longer soak)
 */
const SEEDS = Number(process.env.RANDOM_SEEDS ?? 12);
const STEPS = Number(process.env.RANDOM_STEPS ?? 400);
const TABLES = [2, 3, 4, 6, 8];
const MODES: GameMode[] = ['classic', 'intermediate'];

describe('randomized legal play keeps every invariant', () => {
  const seen: Record<string, number> = {};
  const outcomes: RunOutcome[] = [];

  for (const mode of MODES) {
    for (const players of TABLES) {
      it(`${mode}, ${players} players: ${SEEDS} seeds of up to ${STEPS} actions`, () => {
        for (let i = 0; i < SEEDS; i += 1) {
          const scenario: Scenario = { mode, players, seed: 1000 * players + i + (mode === 'classic' ? 0 : 500_000) };
          const outcome = runScenario(scenario, STEPS);
          outcomes.push(outcome);
          for (const [type, n] of Object.entries(outcome.counts)) seen[type] = (seen[type] ?? 0) + n;
        }
      }, 300_000);
    }
  }

  it('is deterministic: the same seed plays the same game, and its recording replays to the same state', () => {
    for (const mode of MODES) {
      const scenario: Scenario = { mode, players: 4, seed: 4242 };
      const a = runScenario(scenario, 250);
      const b = runScenario(scenario, 250);
      expect(b.steps).toEqual(a.steps);
      expect(b.state).toEqual(a.state);
      const again = replay(scenario, a.steps);
      expect(again.state).toEqual(a.state);
      expect(again.ledger).toEqual(a.ledger);
    }
  });

  it('the sequences really exercise the game: turns, money, property, auctions, trades, undo, loans, bankruptcy and endings', () => {
    const expected = [
      'ROLL_DICE', 'END_TURN', 'BUY_PROPERTY', 'DECLINE_PROPERTY', 'PAY_RENT', 'PAY_TAX', 'PAY_JAIL_FINE', 'STAY_IN_JAIL',
      'PLACE_BID', 'PASS_AUCTION', 'CLOSE_AUCTION', 'BUILD_HOUSE', 'SELL_BUILDING', 'SELL_PROPERTY', 'MORTGAGE_PROPERTY', 'UNMORTGAGE_PROPERTY',
      'TRANSFER_MONEY', 'REQUEST_LOAN', 'REPAY_LOAN', 'CREATE_TRADE', 'ACCEPT_TRADE', 'REJECT_TRADE', 'REQUEST_UNDO', 'APPROVE_UNDO',
      'LEAVE_GAME', 'TAKE_INTERMEDIATE_LOAN', 'PAY_LOAN_INSTALLMENT', 'INSURE_PROPERTY', 'START_RESALE_AUCTION',
    ];
    expect(expected.filter((type) => !seen[type])).toEqual([]);
    expect(outcomes.some((o) => o.state.status === 'FINISHED')).toBe(true);
    expect(outcomes.some((o) => o.state.players.some((p) => p.status === 'BANKRUPT'))).toBe(true);
  });
});
