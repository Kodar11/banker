# Business Banker

The digital bank + referee for the physical Indian board game **Business**.
The board stays the game — tokens, cards and table talk stay physical. The phone handles money, dice, rent, auctions, loans, turns and rules.

> LOOK AT PHONE → SEE WHAT HAPPENED → TAKE ONE ACTION → LOOK BACK AT THE BOARD

## How it works

```
App (Expo Router)  ──POST action──▶  Edge Function `game-action`  ──one SQL transaction──▶  Postgres
     ▲                                  lock game row · idempotency                         append-only ledger
     │                                  stale check · run engine                            constraints · RLS
     └──── Realtime "state changed" ◀── broadcast after commit
```

* **The server is the referee.** The client sends intents (`ROLL_DICE`, `BUY_PROPERTY`, `PLACE_BID`, …). The Edge Function locks the game row, runs the shared engine, and commits every change for that action atomically. Clients never write balances, ownership, loans, auctions or turns.
* **One engine, two places.** `src/engine` is pure TypeScript. The app uses it read-only (to show only valid actions); the Edge Function runs it authoritatively from an exact copy in `supabase/functions/_shared/engine` (`npm run sync:engine`; a test fails if they drift).
* **Money integrity.** Balances change only through `Draft.transfer`, which always appends a transaction. The ledger is append-only (DB triggers). Undo = compensating transactions.
* **Idempotency.** Every tap has an `action_id`; retries reuse it; the server applies it once (`game_actions` primary key).
* **Auction timing.** One deadline, on the server's clock: `auctions.ends_at`, set when the auction opens and again by each accepted bid. Every phone counts down to it using an estimate of the server clock taken from request/response timing (`src/lib/serverClock.ts`) — never from when an update happened to arrive or a screen mounted. A bid is on time if the server *received* it less than `auction.bidGraceSeconds` (1 s, never shown) after that deadline; client timestamps are not used. From that instant the auction can be closed, exactly once: by a timer the Edge Function arms for each deadline, with phones on the auction screen asking too as a backstop.
* **Stale actions.** Decision actions carry the `state_version` the player saw; if the game moved on, the server rejects with “The game just changed”.
* **Realtime.** Broadcast pings carry only the new version; a client refetches only when the ping is *ahead* of its snapshot. It also reconciles once after a reconnect and once when the app returns from the background. Polling (every 5 s) runs **only while realtime is down** — a healthy idle connection does no work (`src/features/game/sync.ts`, dev counters in `src/lib/syncStats.ts`).
* **No accounts.** Each phone generates a random device token; the server stores only its SHA-256.

## Project structure

```
app/                     Routes only (Expo Router)
  _layout.tsx            Root stack + single realtime/sync host
  index.tsx              Home
  create-game.tsx        Create (select Business, host name)
  join-game.tsx          Join by 6-digit code or QR (deep link businessbanker://join-game?code=…)
  lobby/[gameId].tsx     Code, QR, players, ready, start
  game/[gameId].tsx      Main game screen
  auction/[auctionId].tsx
  player/[playerId].tsx  Wallet: balance, properties, loans, net worth, history
  property/[key].tsx     Title deed + allowed actions
  settings.tsx           House rules (the rulebook), leave game
src/
  components/ui/         Button, Card, Screen, Sheet, TextField, toasts/banners
  features/              game, lobby, auction, loan, trade, player, transactions
  engine/                Pure game logic + Business board/card data + rules config + API contract
  lib/                   supabase client, game API, realtime, device ids
  store/                 Zustand: sessionStore (device credentials), gameStore (server snapshot)
  constants/ utils/
supabase/
  migrations/            Schema, constraints, append-only triggers, RLS lockdown, catalog
  functions/game-action/ Edge Function (index.ts = Deno entry, handler.ts, db.ts)
  functions/_shared/engine/  Generated copy of src/engine
tests/
  engine/                Vitest — rules, data, money, auctions, loans, cards, undo, invariants
  server/                Vitest + real Postgres — handler, idempotency, concurrency, RLS
  ui/                    Jest + React Native Testing Library
.maestro/                Maestro E2E flows (+ bot script that plays the second seat)
```

## Business data (BUSINESS_V2) and the rule set

* `src/engine/businessBoard.ts` — the single board source of truth:
  * **title deeds** (prices, rents, house/hotel costs, mortgage values, paired transport/utility rules), from the photographed cards;
  * **`BOARD_ROWS`** — the four sides of the physical board exactly as dictated (corner → corner). The 36-square cycle `BOARD_LAYOUT` is *derived* from the rows by `deriveBoardCycle`, which validates shared corners, closure back to Start and duplicates at module load. The DB catalog is generated from this file (`scripts/print-catalog-sql.ts`) and a test keeps them in sync.
* `src/engine/cards.ts` — the confirmed Chance / Community Chest **EVEN and ODD tables** (dice total picks the table and the entry). The only total with no entry (Chance odd 11) is resolved by hand.
* `src/engine/rules.ts` — **`BUSINESS_MVP_RULES`**, the Classic Mode V1 rule set (`rulesetVersion: 'CLASSIC-V1'`): every configurable value the engine reads — ₹25,000 start, ₹1,500 at Start, 3+ same colour ×2 rent, build on any owned city site (3 houses then a hotel), 50% building sell-back, mortgage = deed value with buildings kept and inactive, unmortgage = value + 10%, loan interest once at the next Start, Income Tax, Wealth Taxes, Club, Rest House, Jail, the 5-second auction countdown, trading, multi-undo.
* `src/engine/rulebook.ts` — the player-facing rulebook shown under **House rules**: the five rules to know first, then three ranked sections. Its text is generated from `BUSINESS_MVP_RULES` and the deed data, so the page cannot state a value the engine does not use (`tests/engine/classicV1.test.ts` checks it).

## Setup

Requirements: Node 22, npm. Supabase Cloud project (already created).

```bash
npm ci
cp .env.example .env    # EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_KEY (publishable key only)
```

Deploy the backend once (needs the Supabase CLI logged in and linked: `npx supabase login && npx supabase link --project-ref <ref>`):

```bash
npm run deploy:db          # supabase db push — applies supabase/migrations
npm run deploy:functions   # syncs the engine, deploys game-action (verify_jwt = false)
```

The function uses the platform-provided `SUPABASE_DB_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; nothing secret ships in the app. Realtime **Broadcast** must allow public channels (the default).

## Run the app

```bash
npx expo start            # scan with Expo Go (all native modules used are in Expo Go)
npx expo run:android      # or a development build (needed for Maestro: appId com.boardgamebank.businessbanker)
```

## Game modes: Classic and Intermediate

The host picks the mode on **New game**; it is stored on the game (`games.game_mode`), every joiner gets it, and it never changes. A game with no stored mode is Classic.

* **Classic** — the rule set above, unchanged. Classic games never read any Intermediate code path.
* **Intermediate** — the same board and turn rules, plus a financial layer kept in one document on the game row (`games.intermediate`, shape `IntermediateState`), written only by the Edge Function in the same transaction as the action that changed it:
  * `src/engine/intermediateConfig.ts` — **`INTERMEDIATE_RULES`**: every rate, limit and threshold (36 spaces per financial year, 5% inflation, the market-change distribution, the five loan products, credit-score events and bands, grace period). Validated with Zod at load.
  * `src/engine/intermediateFinance.ts` — pure, exact integer maths: amortization, schedules, accrued interest, market rounding, projections, purchasing power, collateral limits and settlement.
  * `src/engine/intermediateEngine.ts` — the state transitions: economy creation at Start, the shared calendar driven by dice movement, yearly market changes, loan checkpoints (due → overdue → default), flexible-rate reviews, payments, early repayment, collateral seizure, and the one function that changes a credit score.
  * `src/engine/intermediateSelectors.ts` — read-only views the engine validates against and the screens display (offers, valuation, obligations, financial overview).
  * `src/features/finance/` — the bank (Overview · My Loans · Borrow · Credit), the deed's valuation block, the year / payment notices and the one-time introduction.

Deploying a version that adds or changes Intermediate behaviour: `npm run deploy:db` first (the migration is additive), then `npm run deploy:functions`, then ship the app.

## Game settings and secret objectives

The host can customise a small, fixed set of rules on **New game** and, until they press Start, from the lobby (**Change settings**). Everyone in the lobby sees the same summary; once the game starts the settings are locked and readable from **More → Game settings**.

* `src/engine/gameConfig.ts` — **`GameConfig`**: starting cash (₹10,000–₹50,000), the loan limit (₹5,000–₹50,000), and for Intermediate the market volatility (Stable / Balanced / Volatile) and whether secret objectives are on. One validator (`parseGameConfig`) runs on the server for `create` and for the host's lobby-only `UPDATE_CONFIG` action. The defaults are the existing rule values, so an untouched game plays exactly as before; a game stored without a config reads as those old rules (`legacyGameConfig`).
* Stored in `games.config`. A database trigger refuses any change once the game has left the lobby, on top of the engine refusing the action.
* The loan limit caps total principal owed. It never lifts an Intermediate product's own maximum, its collateral requirement, or the overdue/default blocks, and it does not touch mortgages.
* The volatility profiles live in `INTERMEDIATE_RULES.market.profiles`; a game's profile only selects which distribution its yearly market draw uses.
* `src/engine/objectives.ts` — the typed objective registry (Property Mogul, The Builder, Cash Guardian, Deal Maker), dealing, scaling (`reward = base × startingCash / 25,000`, nearest ₹100; rupee targets scale the same way), end-of-game evaluation and the privacy boundary:
  * Assignments are stored in `player_objectives` (one row per player, immutable; RLS on, no client grants). The Edge Function sends each player only their own objective (`redactObjectives`, applied to every snapshot) until the game has finished. No event, transaction or broadcast mentions an objective before then.
  * When the game finishes, every objective is checked against the same final state, completed ones are paid by the bank as `OBJECTIVE_REWARD` ledger entries, and only then is the winner ranked — all in the one transaction that finishes the game. Only a player still in the game can earn the bonus.

Deploying this: `npm run deploy:db` (migration `20261012000000_game_customization.sql`, additive), then `npm run deploy:functions`, then ship the app. An app that sends settings to a function deployed before this migration is refused.

## Checks & tests

```bash
npx tsc --noEmit          # typecheck
npx expo lint             # lint
npm run test:engine       # Vitest: engine + exact Business data + drift checks
npm run test:ui           # Jest + RNTL
npm run db:local          # throwaway local Postgres (no Docker) with the migrations
DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
npm run test:e2e -- -e SUPABASE_URL=… -e SUPABASE_KEY=…   # Maestro, on a device/emulator with a dev build
npx expo-doctor
```
