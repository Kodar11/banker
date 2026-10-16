import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { BOT_PERSONALITIES, type BotDifficulty, type BotSeat, type GameMode } from '@/engine/index.ts';
import { runBotGame } from './simulator';

/**
 * Calibration runs (not part of the normal suite): CALIBRATE=<output.json> npx vitest run tests/bots/calibration.test.ts
 * Many seeded games per configuration; the summary is what docs/bots/README.md reports.
 */
const out = process.env.CALIBRATE;
const GAMES = Number(process.env.CALIBRATE_GAMES ?? 24);

interface Tally {
  games: number;
  finished: number;
  refused: number;
  actions: number;
  msPerDecision: number;
  wins: Record<string, number>;
  bankrupt: Record<string, number>;
  seats: Record<string, number>;
  netWorth: Record<string, number>;
  trades: number;
  loans: number;
  builds: number;
}

function run(name: string, mode: GameMode, seats: (game: number) => BotSeat[], key: (s: BotSeat) => string, config?: Record<string, unknown>): [string, Tally] {
  const t: Tally = { games: 0, finished: 0, refused: 0, actions: 0, msPerDecision: 0, wins: {}, bankrupt: {}, seats: {}, netWorth: {}, trades: 0, loans: 0, builds: 0 };
  for (let g = 0; g < GAMES; g += 1) {
    const r = runBotGame({ seed: 1000 + g, mode, hosted: true, bots: seats(g), config });
    t.games += 1;
    t.finished += r.finished ? 1 : 0;
    t.refused += r.refused;
    t.actions += r.actions;
    t.msPerDecision += r.decisionMs.total / Math.max(1, r.decisionMs.count) / GAMES;
    t.trades += r.counts.ACCEPT_TRADE ?? 0;
    t.loans += (r.counts.REQUEST_LOAN ?? 0) + (r.counts.TAKE_INTERMEDIATE_LOAN ?? 0);
    t.builds += (r.counts.BUILD_HOUSE ?? 0) + (r.counts.BUILD_HOTEL ?? 0);
    for (const s of r.seats) {
      const k = key(s.bot);
      t.seats[k] = (t.seats[k] ?? 0) + 1;
      t.netWorth[k] = (t.netWorth[k] ?? 0) + s.netWorth;
      if (s.status === 'BANKRUPT') t.bankrupt[k] = (t.bankrupt[k] ?? 0) + 1;
      if (s.rank === 1) t.wins[k] = (t.wins[k] ?? 0) + 1;
    }
  }
  for (const k of Object.keys(t.netWorth)) t.netWorth[k] = Math.round(t.netWorth[k]! / t.seats[k]!);
  t.msPerDecision = Math.round(t.msPerDecision * 100) / 100;
  return [name, t];
}

const rotate = (difficulty: BotDifficulty) => (g: number) => BOT_PERSONALITIES.map((_, i) => ({ difficulty, personality: BOT_PERSONALITIES[(i + g) % 4]! }));
const difficulties = (g: number): BotSeat[] =>
  (['easy', 'normal', 'hard', (['easy', 'normal', 'hard'] as const)[g % 3]!] as const).map((difficulty, i) => ({ difficulty, personality: BOT_PERSONALITIES[(i + g) % 4]! }));

it.skipIf(!out)('calibration', () => {
  const report = Object.fromEntries([
    run('classic · normal · personalities', 'classic', rotate('normal'), (s) => s.personality),
    run('classic · hard · personalities', 'classic', rotate('hard'), (s) => s.personality),
    run('capital · normal · personalities', 'intermediate', rotate('normal'), (s) => s.personality),
    run('classic · difficulties', 'classic', difficulties, (s) => s.difficulty),
    run('capital · difficulties', 'intermediate', difficulties, (s) => s.difficulty),
  ]);
  writeFileSync(out!, JSON.stringify(report, null, 1));
}, 3_600_000);
