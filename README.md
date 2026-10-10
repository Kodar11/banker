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
  settings.tsx           House-rule assumptions, leave game
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

## Business data (BUSINESS_V2) vs. assumptions

* `src/engine/businessBoard.ts` — the single board source of truth:
  * **title deeds** (prices, rents, house/hotel costs, mortgage values, paired transport/utility rules), from the photographed cards;
  * **`BOARD_ROWS`** — the four sides of the physical board exactly as dictated (corner → corner). The 36-square cycle `BOARD_LAYOUT` is *derived* from the rows by `deriveBoardCycle`, which validates shared corners, closure back to Start and duplicates at module load. The DB catalog is generated from this file (`scripts/print-catalog-sql.ts`) and a test keeps them in sync.
* `src/engine/cards.ts` — the confirmed Chance / Community Chest **EVEN and ODD tables** (dice total picks the table and the entry). The only total with no entry (Chance odd 11) is resolved by hand.
* `src/engine/rules.ts` — **`BUSINESS_MVP_RULES`**, each value marked ✅ confirmed (₹25,000 start, ₹1,500 at Start, 3+ same colour ×2 rent, loan interest at next Start, trading, multi-undo, and the finalized Classic rules: Income Tax ₹50/property max ₹500, Wealth Taxes ₹100/house + ₹200/hotel max ₹500, Club pays ₹100 to each player, Rest House collects ₹100 from each player then skips a turn, Jail up to 3 turns or ₹500 to leave, 5-second auction countdown) or ⚠️ assumption (other auction details, building sell-back rate, how buildings are valued on mortgage, …). Players see both lists in-app under **House rules**.

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
