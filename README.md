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
* **A seat is not an account.** Each phone joins a game with a random device token; the server stores only its SHA-256. The player account (see Accounts below) is separate and never needed to play.

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
  account.tsx            Settings: player profile, Google link / restore, delete account
  auth-callback.tsx      Where Google sign-in returns to (businessbanker://auth-callback)
src/
  components/ui/         Button, Card, Screen, Sheet, TextField, toasts/banners
  features/              game, lobby, auction, loan, trade, player, transactions
  engine/                Pure game logic + Business board/card data + rules config + API contract
  lib/                   supabase client (+ secure session storage), game API, account API, realtime, device ids
  store/                 Zustand: sessionStore (device credentials), gameStore (server snapshot), accountStore (player account)
  constants/ utils/
supabase/
  migrations/            Schema, constraints, append-only triggers, RLS lockdown, catalog
  functions/game-action/ Edge Function (index.ts = Deno entry, handler.ts, db.ts)
  functions/delete-account/  Edge Function: permanent account deletion
  functions/_shared/engine/  Generated copy of src/engine
tests/
  engine/                Vitest — rules, data, money, auctions, loans, cards, undo, invariants
  server/                Vitest + real Postgres — handler, idempotency, concurrency, RLS, profiles
  account/               Vitest — nickname rules, session storage, OAuth redirect, deletion handler
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
npm run deploy:functions   # syncs the engine, deploys game-action and delete-account
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

## Property insurance and crises (Intermediate only)

Classic games have none of this: no state, no actions, no screens, no restrictions.

* **The rules** (`INTERMEDIATE_RULES.insurance`, shown under House rules): a policy is bought per property — ₹500 in Year 1, +₹100 each financial year, capped at ₹900 — after an explicit confirmation of the exact price. It lasts 36 spaces of average movement from the purchase point and waives **one** crisis bill; then it is spent. No renewal, no refund. A crisis strikes one owned property (mortgaged ones included), picked by the server's RNG across all players still in the game, after the first 18 spaces of average movement and then every 36. Uninsured, its owner owes ₹3,000 at once; nothing else about the property changes.
* **One clock.** Everything runs on the existing shared clock (`gameClock`: the sum of the starting players' dice movement), so "36 spaces of average movement" is `36 × playerCount` on it — the same convention as the financial year. There is no second counter.
* **Engine** — `src/engine/insuranceState.ts` (shape: `IntermediateState.insurance`), `src/engine/insurance.ts` (premium, schedule, selectors, purchase, crisis resolution, settlement). `recordDiceMovement` resolves every checkpoint the clock has reached, in order; `nextCheckpoint` only grows, so each is resolved once. Cover is judged at the checkpoint's own clock point: a policy that expires at the checkpoint does not cover it, and one bought afterwards never does.
* **A pending bill stops the game.** `crisisGate` runs first in `applyAction`: until the bill is settled only pause / resume / leave / end (host) and declining offers are open to everyone, plus — for the player who owes — paying (`PAY_CRISIS_BILL`), selling a building, selling or mortgaging a property and taking a bank loan. Bankruptcy over a bill (`DECLARE_CRISIS_BANKRUPTCY`) is the game's existing bankruptcy, and is refused while the player can afford the bill or any of those options is left. Leaving, or the game ending, collects what cash there is first; anything uncollected counts against net worth.
* **A policy protects its buyer**, not the property: it is not in force while someone else owns the property, and does not pass to a new owner.
* **Storage** — the engine's state is inside the economy document (`games.intermediate`), written under the game lock in the action's own transaction. Migration `20261013000000_property_insurance.sql` adds `insurance_policies` and `crisis_events`, written from that state in the same transaction: the durable record, plus guarantees the database enforces by itself — one crisis per `(game_id, checkpoint)`, one active policy per property and owner, settled rows final, Intermediate games only, RLS on with nothing granted to the app's roles.
* **On the phone** (`src/features/insurance/`) — **More → Property Insurance** (`app/insurance.tsx`), an insurance section on every owned property's deed, a notice to the table when a crisis strikes, and — for the player who owes — a settlement view that replaces the board until the server says the bill is settled.
* A game that started before this version has no `insurance` in its economy and plays on without it.

Deploying this: `npm run deploy:db` (migration `20261013000000_property_insurance.sql`, additive), then `npm run deploy:functions`, then ship the app. A function deployed before the migration cannot store a policy or a crisis.

## Game settings and secret objectives

The host can customise a small, fixed set of rules on **New game** and, until they press Start, from the lobby (**Change settings**). Everyone in the lobby sees the same summary; once the game starts the settings are locked and readable from **More → Game settings**.

* `src/engine/gameConfig.ts` — **`GameConfig`**: starting cash (₹10,000–₹50,000), the loan limit (₹5,000–₹50,000), and for Intermediate the market volatility (Stable / Balanced / Volatile) and whether secret objectives are on. One validator (`parseGameConfig`) runs on the server for `create` and for the host's lobby-only `UPDATE_CONFIG` action. The defaults are the existing rule values, so an untouched game plays exactly as before; a game stored without a config reads as those old rules (`legacyGameConfig`).
* Stored in `games.config`. A database trigger refuses any change once the game has left the lobby, on top of the engine refusing the action.
* The loan limit caps total principal owed. It never lifts an Intermediate product's own maximum, its collateral requirement, or the overdue/default blocks, and it does not touch mortgages.
* The volatility profiles live in `INTERMEDIATE_RULES.market.profiles`; a game's profile only selects which distribution its yearly market draw uses.
* `src/engine/objectives.ts` — the typed objective registry (Property Mogul, The Builder, Cash Guardian, Deal Maker), dealing, scaling (`reward = base × startingCash / 25,000`, nearest ₹100; rupee targets scale the same way), end-of-game evaluation and the privacy boundary:
  * Assignments are stored in `player_objectives` (one row per player, immutable; RLS on, no client grants). The Edge Function sends each player only their own objective (`redactObjectives`, applied to every snapshot) until the game has finished. No event, transaction or broadcast mentions an objective before then.
  * On the phone (`src/features/objectives/`): a private reveal once per player per game when the game starts — it opens covered, waits behind the Intermediate introduction, and is also shown the first time a phone opens a game already running. The objective stays under **More → My secret objective** (first in the list) and on the player's own sheet, with live "have / need" progress read from the synced game state. The phone only remembers *that* it showed the reveal (`OBJECTIVE_SEEN_KEY`), never the objective.
  * When the game finishes, every objective is checked against the same final state, completed ones are paid by the bank as `OBJECTIVE_REWARD` ledger entries, and only then is the winner ranked — all in the one transaction that finishes the game. Only a player still in the game can earn the bonus.

Deploying this: `npm run deploy:db` (migration `20261012000000_game_customization.sql`, additive), then `npm run deploy:functions`, then ship the app. An app that sends settings to a function deployed before this migration is refused.

## Accounts: guest, Google link, restore, delete

Nobody signs in to play. On first launch the app creates a Supabase **anonymous** user and a profile for it; from then on the stored session is restored.

* **Identity** — Supabase Auth, on the app's one client (`src/lib/supabase.ts`). The session is kept in the platform keystore (`src/lib/secureSessionStorage.ts`: expo-secure-store, split into pieces, switched over atomically so a failed write can never destroy the previous session).
* **Profile** — `public.profiles` (migration `20261014000000_player_profiles.sql`), one row per Auth user: `player_id` (`RR-` + 6 of `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, generated in Postgres, unique, immutable by trigger), `nickname` (default `Player1234`), `google_linked_at` (mirrors `auth.identities`). The app can only *read its own row* (RLS). All writes go through two `SECURITY DEFINER` functions that act on `auth.uid()`: `init_profile()` (create-or-load, idempotent) and `update_nickname(text)`.
* **Nickname rules** — NFC, spaces collapsed and trimmed, 3–20 characters, no control or invisible formatting characters, at most 5 changes per 24 hours. Nicknames are not unique; the Player ID is. Checked on the phone for feedback (`src/features/account/nickname.ts`) and enforced in `update_nickname`.
* **Moderation policy** — `public.nickname_blocklist` (server-only data, editable without a deploy). The nickname is folded (lower case, look-alike digits/symbols mapped to letters, everything but a–z dropped) and refused if it *contains* a `contains` term or *equals* an `exact` term. `exact` is used for words that also occur inside ordinary names and for staff-like names (admin, moderator, …).
* **Link Google** — `supabase.auth.linkIdentity` in the system browser (PKCE). It adds Google to the *current* user: same user id, same Player ID. A Google account that already belongs to another player comes back as an error and nothing changes. "Linked" is shown only after `init_profile()` reports the identity.
* **Restore on another phone** — Settings → *Restore with Google* (`signInWithOAuth`), after an explicit confirmation that the phone will switch players. If nobody is linked to that Google account, the previous session is put back and the empty account the sign-in created is deleted.
* **Delete** — Settings → Danger zone → two steps (read, then type DELETE) → Edge Function `delete-account`: verifies the caller's token with Supabase Auth, requires a Google sign-in from the last 10 minutes for linked accounts, then deletes the Auth user (sessions, refresh tokens, Google identity; the profile goes with it by `ON DELETE CASCADE`). The phone clears its session and cache only after the server confirms, then starts over as a new guest.
* **What deletion does not touch** — games. A seat is a device token, not an account: no game row refers to a profile, an active game continues, and games expire on their own. Financial Learning progress lives on the phone only and is kept.
* **Failure rules** (`src/store/accountStore.ts`) — a network or server error never creates a new account and never discards a session; a session is treated as ended only when Supabase Auth says the account is gone; a phone that *had* an account and lost its session asks (restore with Google / start a new guest) instead of silently starting over.

### One-time setup (dashboards — not done by the code)

Package / bundle id: `com.boardgamebank.businessbanker`. Scheme: `businessbanker`. Supabase project ref: `zlsimveghdbanvlupduz`.

1. **Supabase → Authentication → Sign In / Providers**: enable **Anonymous sign-ins**; enable **Manual linking**.
2. **Google Cloud Console → APIs & Services → Credentials**: create an OAuth client of type **Web application**. Authorised redirect URI: `https://zlsimveghdbanvlupduz.supabase.co/auth/v1/callback`. Configure the OAuth consent screen (scopes: openid, email, profile) and publish it (or add test users).
3. **Supabase → Authentication → Providers → Google**: enable, paste that client's **Client ID** and **Client secret** (the secret stays in Supabase; it is never in the app).
4. **Supabase → Authentication → URL Configuration → Redirect URLs**: add `businessbanker://auth-callback` (and, only for trying it in Expo Go, the `exp://…/--/auth-callback` URL Expo prints).
5. `npm run deploy:db`, then `npm run deploy:functions`.
6. Recommended before release: turn on CAPTCHA for anonymous sign-ins (abuse protection) and schedule a clean-up of old, never-linked anonymous users.

No Android OAuth client or SHA-1 fingerprint is needed: sign-in runs in the browser against the Web client. They become necessary only if this is later replaced by the native Google Sign-In SDK (then: an Android client for `com.boardgamebank.businessbanker` with the SHA-1 of the EAS build keystore — `eas credentials` — and of Play App Signing).

`expo-web-browser` and `expo-clipboard` are included in Expo Go; a development or release build needs to be rebuilt once because they are native modules.

## Friends, private invitations, presence and notifications

Players find each other by Player ID, become friends, and invite friends into a lobby. Nothing here is matchmaking, chat or push: it is in-app only.

* **Where it lives** — `supabase/migrations/20261015000000_social.sql` (tables, RLS, functions), `src/lib/socialApi.ts` (one call per function), `src/lib/socialRealtime.ts` (change counter + presence), `src/store/socialStore.ts`, `src/features/social/` (`SocialHost` lifecycle, Friends screen, lobby sheets, `logic.ts` for the rules that need no server). Route: `app/friends.tsx`.
* **Security model** — the same as profiles. RLS is on for every new table and nothing is granted to the app, except `SELECT` on its **own** `social_sync` row (a version number). Every read and write is a `SECURITY DEFINER` function (fixed empty `search_path`, `authenticated` only) that acts on `auth.uid()`; other players are named only by public Player ID. No account id, email or token of another player leaves the server.
* **Friend requests** — `send_friend_request(player_id)`: under a per-pair advisory lock it returns the existing state (already friends / already sent), or — if the other player's request is open — creates the friendship at once (**reciprocal match**, both get a `friends_matched` notification), or inserts a pending request (30 days). `respond_friend_request(id, accept)` is recipient-only, `cancel_friend_request(id)` sender-only; both are idempotent. A declined request keeps looking pending to its sender until it expires or is cancelled.
* **Friendships** — one row per pair, `(user_low, user_high)` with `user_low < user_high` as primary key: a second friendship of the same two players cannot exist. `remove_friend(player_id)` by either side. At most 200 friends (`social_max_friends()`).
* **Blocking** — `block_player` / `unblock_player`. A block ends the friendship, withdraws open requests and invitations between the two, and refuses new ones in both directions. The blocked player is never told (they get the neutral `UNAVAILABLE`). It does not remove anyone from a game they are both in.
* **Seats and accounts** — a seat is still a device token. `players.user_id` (nullable, `ON DELETE SET NULL`) records which account sits there once the app calls `claim_seat(game, seat, token)`, which proves the seat with the token's SHA-256 exactly as the referee does. Only the social functions read it: `game_player_profiles(game)` (for *Add Friend* in a lobby or a running game) and the invitation checks.
* **Invitations** — `send_game_invite(game, player_id)`: the caller must sit in that game, the invitee must be a friend, and the lobby must be able to take them (waiting, not locked, not full). 15 minutes, one live invitation per (game, inviter, recipient), so a retry creates nothing. `open_game_invite(id)` re-checks everything and returns the game code; joining is then the **normal join** through `game-action`, which checks status, lock and capacity again under the game row lock. An invitation is never a way in by itself. `decline_game_invite`, `revoke_game_invite` (inviter or host).
* **Friends of friends** — the game code is independent of friendship. Anyone in the lobby can copy it or share it (system share sheet: mode, code and the app's own `businessbanker://join-game?code=…` link), and whoever has it joins through *Join game* — no friendship with the host, no friend request sent.
* **Host controls** (engine actions, lobby only, host only) — `SET_LOBBY_LOCK` (stored in `games.lobby_locked`; a locked lobby refuses every join with `LOBBY_LOCKED`) and `REMOVE_PLAYER`.
* **Realtime** — `social_sync` holds one change counter per player, bumped by triggers whenever anything they can see changes (including when another account is deleted). The app listens to Postgres changes of its own row and refetches `social_state()` when the announced version is ahead; older answers never replace newer ones. It also refetches on sign-in, reconnect and return to the foreground, and polls every 30 s only while Realtime is down.
* **Presence** — Supabase Realtime Presence on `presence:<presence_key>`. The key is a random value on the profile, given only to the player and their current friends and replaced when a friendship ends or a block is made. A player is tracked on their own topic while the app is in front (keyed by a per-run session id); the Friends screen listens to its friends' topics (at most 50) while it is open. Shown as Online / Offline / Unknown: my own connection dropping reads Unknown, and a friend's drop reads Offline only after 12 s. Presence authorises nothing.
* **Notifications** — `public.notifications`, written only by the functions, unique on `(recipient, deduplication_key)`. Events: friend request received, request accepted, reciprocal match, game invitation. The Friends button shows requests to answer + usable invitations + unseen news. A toast announces a notification once when it arrives; it is marked read (`mark_notifications_read`) when the player leaves the Friends screen, never by merely receiving it.
* **Limits** — `public.social_limits` (data; change a row without a deploy): 30 lookups/min, 20 friend requests/hour, 3 requests to the same player/7 days, 30 invitations/10 min, 5 to the same player/10 min. Refusals carry `retry_after_seconds`.
* **Account deletion** — unchanged (`delete-account`). Every social table references `profiles` `ON DELETE CASCADE`, so friendships, requests, blocks, invitations and notifications of the deleted account go in the same transaction, and the other players' counters are bumped so their phones drop them. Games are not touched.
* **Housekeeping** — optional: `select public.social_cleanup();` (e.g. daily with pg_cron). Nothing depends on it; expiry is decided by the clock wherever a request or an invitation is read.

Deploying this: `npm run deploy:db` **first** (migration `20261015000000_social.sql`, additive; it also adds `social_sync` to the `supabase_realtime` publication), then `npm run deploy:functions` (the referee now reads and writes `games.lobby_locked`), then ship the app. No new Edge Function, secret or dashboard setting is needed; Realtime must be enabled for the project (it already is for the game channels).

## Checks & tests

```bash
npx tsc --noEmit          # typecheck
npx expo lint             # lint
npm run test:engine       # Vitest: engine + exact Business data + drift checks
npm run test:account      # Vitest: nickname rules, secure session storage, deletion handler
npm run test:social       # Vitest: Player ID input, relationship/expiry/presence/notification rules
npm run test:ui           # Jest + RNTL
npm run db:local          # throwaway local Postgres (no Docker) with the migrations
DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
npm run test:e2e -- -e SUPABASE_URL=… -e SUPABASE_KEY=…   # Maestro, on a device/emulator with a dev build
npx expo-doctor
```
