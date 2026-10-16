import { describe, expect, it } from 'vitest';
import { BOT_PERSONALITIES, type BotDifficulty, type BotSeat } from '@/engine/index.ts';
import { runBotGame, type SimResult, type SimScenario } from './simulator';

/**
 * Seeded bot-only games on the real engine. These are the release gate for the bot policy: every game
 * must progress without a bot-induced deadlock, never break an engine invariant, and hosted games must
 * finish. A refused action is allowed (a bot's view can lack something the server knows) but must be rare.
 */

const table = (difficulty: BotDifficulty, n = 4, offset = 0): BotSeat[] =>
  Array.from({ length: n }, (_, i) => ({ difficulty, personality: BOT_PERSONALITIES[(i + offset) % 4]! }));

const mixed = (n = 4): BotSeat[] =>
  Array.from({ length: n }, (_, i) => ({ difficulty: (['easy', 'normal', 'hard'] as const)[i % 3]!, personality: BOT_PERSONALITIES[i % 4]! }));

const SCENARIOS: (SimScenario & { name: string })[] = [
  { name: 'classic · easy · 4', seed: 11, mode: 'classic', hosted: true, bots: table('easy') },
  { name: 'classic · normal · 4', seed: 12, mode: 'classic', hosted: true, bots: table('normal') },
  { name: 'classic · hard · 4', seed: 13, mode: 'classic', hosted: true, bots: table('hard') },
  { name: 'classic · mixed · 6', seed: 14, mode: 'classic', hosted: true, bots: mixed(6) },
  { name: 'classic · normal · 2', seed: 15, mode: 'classic', hosted: true, bots: table('normal', 2, 1) },
  { name: 'classic · hard · 3 · ₹10,000 start', seed: 16, mode: 'classic', hosted: true, config: { startingCash: 10000 }, bots: table('hard', 3, 2) },
  { name: 'classic · normal · 4 · ₹50,000 start · hidden', seed: 17, mode: 'classic', hosted: true, config: { startingCash: 50000, financialPrivacy: 'hidden' }, bots: table('normal') },
  { name: 'classic · mixed · 4 · 7 years', seed: 18, mode: 'classic', hosted: true, config: { durationYears: 7 }, bots: mixed(4) },
  { name: 'capital · normal · 4', seed: 21, mode: 'intermediate', hosted: true, bots: table('normal') },
  { name: 'capital · hard · 4 · hidden · volatile', seed: 22, mode: 'intermediate', hosted: true, config: { financialPrivacy: 'hidden', marketVolatility: 'volatile' }, bots: table('hard') },
  { name: 'capital · easy · 5 · stable', seed: 23, mode: 'intermediate', hosted: true, config: { marketVolatility: 'stable' }, bots: table('easy', 5) },
  { name: 'capital · mixed · 4 · 10 years · no objectives', seed: 24, mode: 'intermediate', hosted: true, config: { durationYears: 10, secretObjectives: false }, bots: mixed(4) },
  { name: 'matchmade classic · hard · 4 (bounded)', seed: 31, mode: 'classic', hosted: false, maxActions: 2500, bots: table('hard') },
  { name: 'matchmade capital · normal · 4 (bounded)', seed: 32, mode: 'intermediate', hosted: false, maxActions: 2500, bots: table('normal') },
];

describe('seeded bot games on the real engine', () => {
  it.each(SCENARIOS)('$name', (scenario) => {
    const r: SimResult = runBotGame(scenario);
    expect(r.violations).toEqual([]);
    expect(r.stuck).toBeNull();
    if (scenario.hosted) expect(r.finished).toBe(true);
    else expect(r.finished || r.actions >= (scenario.maxActions ?? 0)).toBe(true);
    expect(r.refused).toBeLessThanOrEqual(Math.max(3, r.actions * 0.01));
    // Every game is actually played: dice rolled, property bought (or auctioned), rent paid.
    expect(r.counts.ROLL_DICE ?? 0).toBeGreaterThan(20);
    expect((r.counts.BUY_PROPERTY ?? 0) + (r.counts.PLACE_BID ?? 0)).toBeGreaterThan(3);
    // Decisions stay quick on a laptop-class CPU (server and phone budgets: docs/bots/README.md).
    expect(r.decisionMs.total / Math.max(1, r.decisionMs.count)).toBeLessThan(40);
  }, 240_000);

  it('the same seed replays the same game exactly', () => {
    const scenario: SimScenario = { seed: 41, mode: 'classic', hosted: true, bots: mixed(4) };
    const a = runBotGame(scenario);
    const b = runBotGame(scenario);
    expect(b.counts).toEqual(a.counts);
    expect(b.seats).toEqual(a.seats);
  }, 120_000);
});
