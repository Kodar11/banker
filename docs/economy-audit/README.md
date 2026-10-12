# Economy audit — supporting files

These files back the report in [`../economy-audit.md`](../economy-audit.md). They are **temporary audit experiments, not part of the test suite**. Nothing here is imported by the app, the server or any test.

The scripts carry a `.txt` suffix on purpose, so that `tsc`, ESLint, Vitest and Jest in this repository ignore them.

## Contents

| File | What it is |
|---|---|
| `scripts/probes.audit.ts.txt` | 14 targeted probes of the real engine (loan timing, bankruptcy, credit, objectives, insurance, auctions, the manual card, net worth, deed tables) |
| `scripts/simcore.ts.txt` | the whole-game simulator: scripted strategies playing full games through `applyAction` |
| `scripts/sim.audit.ts.txt` | 5 / 7 / 10 years × 2 / 4 / 8 players × Classic / Capital, mixed and uniform tables, plus the early-ending games |
| `scripts/deviant.audit.ts.txt` | one strategy against three standard investors |
| `scripts/vitest.audit.mjs.txt` | the Vitest config the experiments run under |
| `evidence/probe-results.json` | probe output |
| `evidence/sim-results.json`, `evidence/sim-summary.txt` | simulator output (30 seeds per cell) |
| `evidence/deviant-results.json` | strategy-comparison output (60 seeds per row) |

## Running them again

The experiments use the engine and the test harness of this repository but live outside it.

1. Create an empty folder outside the repository, for example `~/audit`, with three subfolders:

   ```
   audit/vitest.audit.mjs          <- scripts/vitest.audit.mjs.txt
   audit/probes/probes.audit.ts    <- scripts/probes.audit.ts.txt
   audit/sim/simcore.ts            <- scripts/simcore.ts.txt
   audit/sim/sim.audit.ts          <- scripts/sim.audit.ts.txt
   audit/sim2/simcore.ts           <- scripts/simcore.ts.txt (a second copy)
   audit/sim2/deviant.audit.ts     <- scripts/deviant.audit.ts.txt
   ```

2. In `vitest.audit.mjs`, set `repo` to the absolute path of this repository.

3. From the repository root, run one experiment at a time. `AUDIT_DIR` selects the folder and is where the JSON output is written.

   ```bash
   AUDIT_DIR=~/audit/probes npx vitest run --config ~/audit/vitest.audit.mjs
   ```

   ```bash
   SIM_SEEDS=30 AUDIT_DIR=~/audit/sim npx vitest run --config ~/audit/vitest.audit.mjs
   ```

   ```bash
   DEV_SEEDS=60 AUDIT_DIR=~/audit/sim2 npx vitest run --config ~/audit/vitest.audit.mjs
   ```

   The probes take about a second. The two simulations take roughly four and six minutes.

Everything is seeded, so the same engine produces the same numbers. A change to any rule or constant will change them; that is the point of keeping the scripts.

## What the simulator does not do

Trades, gifts, resale auctions, undo, leaving and the manual Chance card are not played. Auctions are an ascending auction in which each strategy bids up to a fixed share of the price. The strategies are simple heuristics described in section E of the report.
