# Clash of Capitals

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
* **Idempotency.** Every tap has an `action_id`; retries reuse it; the server applies it once (`game_actions` primary key). An id names one request: the same player, game, action and payload. Sent again it is answered with the game as it now stands (whatever version the retry says it saw); used for anything else it is refused (`VALIDATION`), never answered as "already done". The action record commits or rolls back with the game state, and records are only removed with the whole expired game.
* **Unknown outcomes.** If every attempt of an action is lost on the way (timeout, no connection) the phone does not treat it as failed: it reads the game again and sends nothing else until that read has succeeded (`gameStore.outcomeUnknown`), so a second tap can never be a second execution.
* **Auction close.** The server closes an auction when its deadline passes (a timer armed with each new deadline) and any phone on the auction screen may ask too; all of them go through one settlement path that closes exactly once. That timer lives in one function instance's memory, so a read of the game (`op: "state"`, which every phone does on reconnect, foreground and poll) that finds an auction past its deadline arms the close again.
* **Auction timing.** One deadline, on the server's clock: `auctions.ends_at`, set when the auction opens and again by each accepted bid. Every phone counts down to it using an estimate of the server clock taken from request/response timing (`src/lib/serverClock.ts`) — never from when an update happened to arrive or a screen mounted. A bid is on time if the server *received* it less than `auction.bidGraceSeconds` (1 s, never shown) after that deadline; client timestamps are not used. From that instant the auction can be closed, exactly once: by a timer the Edge Function arms for each deadline, with phones on the auction screen asking too as a backstop.
* **Stale actions.** Decision actions carry the `state_version` the player saw; if the game moved on, the server rejects with “The game just changed”.
* **Realtime.** Broadcast pings carry only the new version; a client refetches only when the ping is *ahead* of its snapshot. It also reconciles once after a reconnect and once when the app returns from the background. Polling (every 5 s) runs **only while realtime is down** — a healthy idle connection does no work (`src/features/game/sync.ts`, dev counters in `src/lib/syncStats.ts`).
* **A seat is not an account.** Each phone joins a game with a random device token; the server stores only its SHA-256. The player account (see Accounts below) is separate and never needed to play.

## Project structure

```
app/                     Routes only (Expo Router)
  _layout.tsx            Root stack + single realtime/sync host
  index.tsx              Home (a first launch shows the introduction here instead)
  onboarding.tsx         The introduction again, from House rules → "Replay intro"
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

## Game modes: Classic and Capital

The host picks the mode on **New game**; it is stored on the game (`games.game_mode`), every joiner gets it, and it never changes. A game with no stored mode is Classic.

Players see **Classic Mode** and **Capital Mode**. Capital Mode was first called Intermediate Mode, and that is still its name in everything stored or exchanged: the `game_mode` value `'intermediate'`, the `games.intermediate` column, the API, the `Intermediate*` types and file names, and the messages raised by the database guards in older migrations. Only the displayed name changed, so existing games read exactly as before. The displayed names live in one place: `GAME_MODE_LABELS` / `GAME_MODE_NAMES` in `src/engine/gameConfig.ts`.

* **Classic** — the rule set above, unchanged. Classic games never read any Capital code path.
* **Capital** — the same board and turn rules, plus a financial layer kept in one document on the game row (`games.intermediate`, shape `IntermediateState`), written only by the Edge Function in the same transaction as the action that changed it:
  * `src/engine/intermediateConfig.ts` — **`INTERMEDIATE_RULES`**: every rate, limit and threshold (36 spaces per financial year, 5% inflation, the market-change distribution, the five loan products, credit-score events and bands, grace period). Validated with Zod at load.
  * `src/engine/intermediateFinance.ts` — pure, exact integer maths: amortization, schedules, accrued interest, market rounding, projections, purchasing power, collateral limits and settlement.
  * `src/engine/intermediateEngine.ts` — the state transitions: economy creation at Start, the shared calendar driven by dice movement, yearly market changes, loan checkpoints (due → overdue → default), flexible-rate reviews, payments, early repayment, collateral seizure, and the one function that changes a credit score.
  * `src/engine/intermediateSelectors.ts` — read-only views the engine validates against and the screens display (offers, valuation, obligations, financial overview).
  * `src/features/finance/` — the bank (Overview · My Loans · Borrow · Credit), the deed's valuation block, the year / payment notices and the one-time introduction.

Deploying a version that adds or changes Capital behaviour: `npm run deploy:db` first (the migration is additive), then `npm run deploy:functions`, then ship the app.

## Property insurance and crises (Capital only)

Classic games have none of this: no state, no actions, no screens, no restrictions.

* **The rules** (`INTERMEDIATE_RULES.insurance`, shown under House rules): a policy is bought per property — ₹500 in Year 1, +₹100 each financial year, capped at ₹900 — after an explicit confirmation of the exact price. It lasts 36 spaces of average movement from the purchase point and waives **one** crisis bill; then it is spent. No renewal, no refund. A crisis strikes one owned property (mortgaged ones included), picked by the server's RNG across all players still in the game, after the first 18 spaces of average movement and then every 36. Uninsured, its owner owes ₹3,000 at once; nothing else about the property changes.
* **One clock.** Everything runs on the existing shared clock (`gameClock`: the sum of the starting players' dice movement), so "36 spaces of average movement" is `36 × playerCount` on it — the same convention as the financial year. There is no second counter.
* **Engine** — `src/engine/insuranceState.ts` (shape: `IntermediateState.insurance`), `src/engine/insurance.ts` (premium, schedule, selectors, purchase, crisis resolution, settlement). `recordDiceMovement` resolves every checkpoint the clock has reached, in order; `nextCheckpoint` only grows, so each is resolved once. Cover is judged at the checkpoint's own clock point: a policy that expires at the checkpoint does not cover it, and one bought afterwards never does.
* **A pending bill stops the game.** `crisisGate` runs first in `applyAction`: until the bill is settled only pause / resume / leave / end (host) and declining offers are open to everyone, plus — for the player who owes — paying (`PAY_CRISIS_BILL`), selling a building, selling or mortgaging a property and taking a bank loan. Bankruptcy over a bill (`DECLARE_CRISIS_BANKRUPTCY`) is the game's existing bankruptcy, and is refused while the player can afford the bill or any of those options is left. Leaving, or the game ending, collects what cash there is first; anything uncollected counts against net worth.
* **A policy protects its buyer**, not the property: it is not in force while someone else owns the property, and does not pass to a new owner.
* **Storage** — the engine's state is inside the economy document (`games.intermediate`), written under the game lock in the action's own transaction. Migration `20261013000000_property_insurance.sql` adds `insurance_policies` and `crisis_events`, written from that state in the same transaction: the durable record, plus guarantees the database enforces by itself — one crisis per `(game_id, checkpoint)`, one active policy per property and owner, settled rows final, Capital games only, RLS on with nothing granted to the app's roles.
* **On the phone** (`src/features/insurance/`) — **More → Property Insurance** (`app/insurance.tsx`), an insurance section on every owned property's deed, a notice to the table when a crisis strikes, and — for the player who owes — a settlement view that replaces the board until the server says the bill is settled.
* A game that started before this version has no `insurance` in its economy and plays on without it.

Deploying this: `npm run deploy:db` (migration `20261013000000_property_insurance.sql`, additive), then `npm run deploy:functions`, then ship the app. A function deployed before the migration cannot store a policy or a crisis.

## Property resale auctions (Capital only)

A player can put a property they own — with every house or the hotel on it — up for auction to the other players. A Classic game never has the action, on the phone or on the server.

* **The rules** (shown under House rules): on your own turn (before rolling, after your move is settled, or while you owe a payment) list a property that is not mortgaged and not pledged as loan collateral, with a reserve price of your choosing (up to `INTERMEDIATE_RULES.resale.maxReservePrice`). Bidding **opens at the reserve price** — nothing lower is a bid — after a short "get ready" (`INTERMEDIATE_RULES.resale.startCountdownSeconds`, 3 s) during which no bid is accepted, so the auction is on every phone before the 5-second bidding clock starts. From there it is the game's ordinary auction (increment, countdown reset per bid, grace); the seller never bids. The winning bid is paid buyer → seller and the property moves with its buildings exactly as they stand. No bid: nothing changes hands. The seller may cancel only until the first bid.
* **Engine** — it runs on the game's one auction: `AuctionState.resale` (seller, reserve, listed buildings, phase to return to, outcome) is the only addition; `PLACE_BID`, `PASS_AUCTION`, `CLOSE_AUCTION`, the timers and the server-side close are the existing ones. New actions: `START_RESALE_AUCTION`, `CANCEL_AUCTION`. One answer for "can this be listed?" (`resaleBlocker` in `src/engine/selectors.ts`) is used by the server and by every screen; `resaleSaleBlocker` re-judges the sale at the close against the state as it is then (mode, ownership, mortgage, collateral, buildings, the bid, the buyer's cash). While listed, the property cannot be built on, mortgaged, sold, traded or pledged.
* **Insurance** — the seller's policy on a sold property is closed with the sale (`endInsuranceOnSale`): no refund, never revived, not passed on. The buyer is offered the ordinary purchase on the result screen and on the property card; it is optional.
* **Storage** — migration `20261019000000_property_resale_auctions.sql` adds six nullable columns to `auctions` (null on every auction of an unowned property) and the database's own guarantees: the terms of a listing never change, the seller is never a bidder or the winner, "sold" means a winner whose bid reached the reserve, a closed resale is never rewritten, and a resale row cannot exist in a Classic game.
* **On the phone** (`src/features/auction/`) — the table's **Auction** button opens the auction screen, which lists your properties under **Auction my property** when nothing is running; every property card you own has **Auction Property**. Both open the same reserve-and-review flow (`ResaleSheet`).

Deploying this: `npm run deploy:db` **first** (the migration is additive), then `npm run deploy:functions`, then ship the app. A function deployed before the migration cannot store an auction.

## Game settings and secret objectives

The host can customise a small, fixed set of rules on **New game** and, until they press Start, from the lobby (**Change settings**). Everyone in the lobby sees the same summary; once the game starts the settings are locked and readable from **More → Game settings**.

* `src/engine/gameConfig.ts` — **`GameConfig`**: starting cash (₹10,000–₹50,000), the loan limit (₹5,000–₹50,000), and for Capital the market volatility (Stable / Balanced / Volatile) and whether secret objectives are on. One validator (`parseGameConfig`) runs on the server for `create` and for the host's lobby-only `UPDATE_CONFIG` action. The defaults are the existing rule values, so an untouched game plays exactly as before; a game stored without a config reads as those old rules (`legacyGameConfig`).
* Stored in `games.config`. A database trigger refuses any change once the game has left the lobby, on top of the engine refusing the action.
* The loan limit caps total principal owed. It never lifts a Capital product's own maximum, its collateral requirement, or the overdue/default blocks, and it does not touch mortgages.
* The volatility profiles live in `INTERMEDIATE_RULES.market.profiles`; a game's profile only selects which distribution its yearly market draw uses.
* `src/engine/objectives.ts` — the typed objective registry (Property Mogul, The Builder, Cash Guardian, Deal Maker), dealing, scaling (`reward = base × startingCash / 25,000`, nearest ₹100; rupee targets scale the same way), end-of-game evaluation and the privacy boundary:
  * Assignments are stored in `player_objectives` (one row per player, immutable; RLS on, no client grants). The Edge Function sends each player only their own objective (`redactObjectives`, applied to every snapshot) until the game has finished. No event, transaction or broadcast mentions an objective before then.
  * On the phone (`src/features/objectives/`): a private reveal once per player per game when the game starts — it opens covered, waits behind the Capital introduction, and is also shown the first time a phone opens a game already running. The objective stays under **More → My secret objective** (first in the list) and on the player's own sheet, with live "have / need" progress read from the synced game state. The phone only remembers *that* it showed the reveal (`OBJECTIVE_SEEN_KEY`), never the objective.
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

Package / bundle id: `com.boardgamebank.businessbanker`. Scheme: `businessbanker`. Supabase project ref: `zlsimveghdbanvlupduz`. These identifiers predate the name Clash of Capitals and are kept on purpose: the package id is the app's identity on a phone and in the stores, and the scheme is in the redirect allow-list below and in every join link and QR code already shared. The same goes for the Expo slug (`board-game-bank`, tied to the EAS project).

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

## Random matchmaking (Play Online)

Solo players and parties of friends queue for a public table. The server groups them, runs a ready-up countdown, creates the game and starts it — there is no human host. Nothing here is skill ranking, bots, regions, voice or push.

* **Where it lives** — `supabase/migrations/20261016000000_matchmaking.sql` (tables, guards, RLS, every function), `supabase/functions/_shared/matchmaking/` (`grouping.ts`: the pure grouping algorithm; `seatNames.ts`), `supabase/functions/matchmaking/` (the worker), `src/lib/matchmakingApi.ts`, `src/store/matchmakingStore.ts`, `src/features/matchmaking/` (`MatchmakingHost` lifecycle, `PlayOnlineView`, `logic.ts`). Route: `app/play-online.tsx`. Home has a **PLAY ONLINE** button.
* **Who owns which fact** — `party_members` (who is in a party, who confirmed), `matchmaking_tickets` + `matchmaking_ticket_members` (one queue entry: a solo player or one whole party), `matchmaking_matches` + `matchmaking_match_players` (one reservation: its tickets, the ready-up deadline, each player's confirmation and seat-token hash, the game it became), `games` / `players` (the game, written by the engine as for a hosted game). `games.matchmaking_match_id` is the only new column on an existing table.
* **State machines** (guard triggers refuse every other change, whoever writes):
  * ticket `QUEUED → RESERVED → MATCHED`; `QUEUED → CANCELLED | EXPIRED | FAILED`; `RESERVED → QUEUED` (the reservation fell through and this ticket was not at fault) `| CANCELLED | FAILED`. Terminal tickets are never reused.
  * match `READY_UP → STARTING → STARTED`; `READY_UP → CANCELLED`; `STARTING → FAILED | CANCELLED`.
  * A ticket is `RESERVED` exactly while its match is `READY_UP` or `STARTING`: reserving the players and opening the countdown are one commit, so "reserved" and "ready-up" are one step here and there is nothing in between to get stuck in.
* **Guarantees held by the database** — one live ticket per player, alone or inside a party (`matchmaking_ticket_members_active_idx`); one live ticket per party; one live reservation per player; unique seats per reservation and per game; 2–8 players per reservation (check constraint); one game per reservation (`games_matchmaking_match_idx` + `matchmaking_matches.game_id` unique); mode, size and deadline of a reservation immutable.
* **Grouping** (`grouping.ts`, deterministic, unit-tested) — per mode, oldest first. By the wait of the oldest entry of a group: under 30 s only the preferred size (4; a group holding a party of 4+ aims for 8); from 30 s any valid size made of two or more entries; from 60 s a party of 4+ may start alone; a party of 8 starts at once. Between valid plans it picks, in order: fewest waited-30 s players left behind, fewest players above the preferred size, most waiting time matched, most even tables (so 5 waiting solos are 3+2, 6 are 3+3, 7 are 4+3). Parties are whole entries and can never be split; tickets with a block between any two of their players are never grouped. Cost: exact search over a window of 10 entries (at most 2^10 states), windows slide over a batch of 64 tickets, so a run is bounded whatever the queue's length.
* **The worker** (`matchmaking` Edge Function, one "tick") — `matchmaking_sweep()` → per mode, one transaction: `matchmaking_candidates()` (advisory lock per mode, throttle, `FOR UPDATE SKIP LOCKED` batch, drops ineligible tickets) → `planMatches()` → `matchmaking_reserve()` per group (re-checks everything; a proposal is never trusted) → per all-ready reservation, one transaction: `matchmaking_begin_start()` (the claim) → engine `createGame` / `joinGame` / `startHostlessGame` through the referee's own persistence (`game-action/db.ts`) → `matchmaking_finish_start()`. A tick can die anywhere: each step is committed whole or not at all, and any number of ticks may run at once.
* **Hostless games** — `startHostlessGame` (engine) is the host's `START_GAME` followed by removing the host role, so nobody at a public table can end the game for the others. Public tables use each mode's default `GameConfig`; the canonical copy is `games.config` as always.
* **Seats** — a seat is still a device token. The phone generates it, stores it, and sends it with **I'm ready** (`matchmaking_ready`); the server keeps its SHA-256 and the worker writes it into `players.token_hash`. Until everyone is ready the last phone to confirm holds the seat; a second device of the same account is told the game is on the other one.
* **Ready-up policy** — 20 s, the server's deadline. Not confirming, declining, or leaving the party during the countdown: that player's whole ticket (their party stays together) leaves the queue, the player gets a cooldown (30 s, doubling to 5 min, forgotten after 15 min), and every other ticket goes back into the queue with the waiting time it had. A game that cannot be created (3 tries or 30 s): everyone is queued again, nobody is penalised.
* **Parties** — `party_create`, `party_invite` (friends only, 15 min, rate-limited through `social_limits`), `party_respond_invite`, `party_set_mode` (leader), `party_set_ready` (each member, for themselves), `party_leave`, `party_kick`. A party invitation joins a group and queues nobody; it is separate from game invitations and from `notifications` (so older apps are unaffected). Queueing locks the party. A member leaving while queued shrinks the ticket, which keeps its place; the leader leaving hands leadership on.
* **Liveness** — `matchmaking_heartbeat()` every 10 s while searching, in a countdown or in a party (foreground only; exponential backoff with jitter on failure). A searching phone silent for 30 s loses its ticket (`EXPIRED / DISCONNECTED`, no cooldown). The phone remembers nothing about a queue between runs: `matchmaking_state()` is fetched at sign-in, on foreground, on a Realtime ping (`matchmaking_sync`, one channel per player) and on reconnect.
* **Private games** — an account at a table cannot queue; `claim_seat` on a private table cancels that account's search (`JOINED_GAME`). Seats an account never claimed (older apps) are caught on the phone only.
* **Settings** — `public.matchmaking_settings` (thresholds, countdown, grace periods, batch sizes, `enabled`, `client_tick`). Change a row; no deploy, no app release.
* **Observability** — `public.matchmaking_events` (every ticket and match transition with its reason, one row per worker run; no nicknames, tokens or emails), `select public.matchmaking_metrics();` (queue by mode, wait percentiles, match sizes, timeout rate, requeues, duplicate requests, creation latency, stale counts, worker duration and failures), and one JSON log line per working tick in the function logs.

### Deploying matchmaking

1. `npm run deploy:db` — migration `20261016000000_matchmaking.sql` (additive). It adds `matchmaking_sync` to the `supabase_realtime` publication and, where `pg_cron` is available, schedules `matchmaking-sweep` (every 10 s, plain SQL) and `matchmaking-tick` (every 5 s). Sub-minute schedules need Postgres 15.1.1.61 or later; if the scheduling block could not run it says so in a notice — then enable **Database → Extensions → pg_cron and pg_net** and run:
   ```sql
   select cron.schedule('matchmaking-sweep', '10 seconds', 'select public.matchmaking_sweep()');
   select cron.schedule('matchmaking-tick', '5 seconds', 'select public.matchmaking_cron_tick()');
   ```
2. `npm run deploy:functions` deploys `game-action`, `delete-account` and the `matchmaking` function. `verify_jwt = false` for `matchmaking` does **not** mean it is open: the handler accepts exactly two callers (see "Who may run the worker" below) and refuses everybody else before any matchmaking work is done.
3. Once: the worker secret. Generate a random value of at least 32 characters (for example `openssl rand -hex 32`) and store the **same** value in two server-only places. It must never appear in the app, in `.env`, or in any `EXPO_PUBLIC_*` variable.
   ```bash
   npx supabase secrets set MATCHMAKING_WORKER_SECRET=<the value>
   ```
   ```sql
   select vault.create_secret('https://zlsimveghdbanvlupduz.supabase.co/functions/v1/matchmaking', 'matchmaking_tick_url');
   select vault.create_secret('<the value>', 'matchmaking_tick_secret');
   select vault.create_secret('<publishable key>', 'matchmaking_tick_key');  -- optional, sent as before
   ```
   A project that already has `matchmaking_tick_url` only needs `matchmaking_tick_secret` (and the function secret). To rotate: set the new value in both places; in between, scheduled ticks are refused and searching phones carry the matching.
4. Check: `select jobname, schedule, active from cron.job;` and, after a test match, `select public.matchmaking_metrics();` (`stale` should be all zeros).
5. Ship the app. An older app has no Play Online and is otherwise unaffected.

### Who may run the worker

The `matchmaking` function does privileged work (it connects as the database owner), so it only runs for:

* **The scheduler** (`pg_cron` through `pg_net`, `matchmaking_cron_tick()`): it sends the worker secret in the `x-matchmaking-secret` header. The function compares it, in constant time, with its own `MATCHMAKING_WORKER_SECRET`. A wrong, empty or unconfigured secret is `403`, and such a request is never treated as a player's.
* **A searching player** (the app's nudge after *Find match*, after the last *I'm ready*, and when the heartbeat says something is due): it sends the player's own access token, which the function verifies with Supabase Auth, as `delete-account` does. The database then decides whether that player's request counts (`matchmaking_tick_claim`): only while they are in the queue or in a countdown, only while `client_tick` is on, and at most once per `client_nudge_interval_ms` (1 s) per player (`429` otherwise). A player's request carries nothing but "look now": it cannot name a ticket, a match or another player, and it is not told what the tick did.

Everything else (no token, the publishable key, an unknown token) is `401`. And whoever asks, a whole tick is let through at most once per `min_tick_interval_ms` (250 ms): fifty simultaneous requests are one tick, the rest answer `200 { ran: false, skipped: "THROTTLED" }`. Both intervals are rows in `public.matchmaking_settings`.

Deploy order for this check: `npm run deploy:db` first (migration `20261021000000_matchmaking_worker_auth.sql`: additive; the scheduled request gains a header an older function ignores), then set the secret (step 3), then `npm run deploy:functions`. If the function is deployed before the secret exists, scheduled ticks are refused until it does; players keep matching through their own nudges and `matchmaking_sweep()` keeps running from pg_cron. Apps already installed are unaffected: they already send the player's token with the request.

### Manual test plan (four Android devices)

Use four devices A–D on a development or preview build, each with its own guest account; make A–B and C–D friends.

1. **Solo, four players** — all four: Play Online → Classic → Find match. Expect *Match found* on all within a few seconds, a 20 s countdown that agrees across devices, then the same game on all four with four different seats; the first player rolls.
2. **Two players** — A and B only: no match for 30 s, then a two-player match.
3. **Modes apart** — A, B Classic; C, D Capital: two separate matches after 30 s, never a mixed one.
4. **Cancel** — A searches and cancels; B, C, D search: A is never matched. Tap Cancel repeatedly: one result.
5. **Missed ready-up** — four search; D does not confirm. After 20 s: D is told and paused; A, B, C are searching again with their elapsed time intact, and are matched after 30 s.
6. **Decline** — as 5, D declines: the others are searching again immediately.
7. **Party** — A invites B (Play with friends → Invite); B joins and confirms; A starts. C and D search solo: one match of four with A and B shown as a party. Repeat with B not ready: A cannot start. Change the mode as A: B must confirm again.
8. **Party leaves** — A+B queued; B leaves the party: A keeps searching. A (leader) leaves instead: B becomes leader and the search continues.
9. **Disconnect while searching** — A searches, then airplane mode for 15 s: *Reconnecting…*, same ticket. Again for 60 s: the search has ended, with the reason shown.
10. **Restart** — force-close A during the countdown after confirming; reopen: A lands in the countdown or in the game, in the same seat. Force-close while searching and reopen within 30 s: still searching.
11. **Elsewhere in the app** — A searches, then opens Friends: when the match is found A is brought to the countdown.
12. **Two devices, one account** — link A with Google, restore on a fifth device; search from both: one ticket. Confirm on one: the other says the game is on the other device.
13. **Private games** — A sits in a private lobby: Play Online says to leave it first. A searches, then joins a game by code on the same device: the search has ended.
14. **Regression** — create and join a private game by code and QR, friends and invitations, Classic and Capital play, reconnect in a running game, Financial Learning, account deletion while queued.

Simulations without devices: `tests/matchmaking` (party sizes 1–8, thresholds, fairness, bounds), `tests/server/matchmaking.test.ts` (concurrent workers, cancel/reserve and ready/timeout races, failure injection around game creation, recovery).

### Limits and known risks

* Not load-tested. Matching is one transaction per mode per run (64 tickets, 16 matches by default) at most once a second, on one database. Raise `batch_size` / `max_matches_per_run` or the tick frequency before expecting more, and measure.
* Without the worker secret in Vault and in the function (step 3) the scheduled tick does nothing and matching depends on a searching phone nudging the worker; the sweep still runs from pg_cron.
* A game created by an app that predates friends never ties its seats to accounts, so the server cannot see that such a player is "in a game".
* A player leaving at the very instant their ticket is reserved can make Postgres fail one of the two requests (deadlock detection); it is retried by the phone or the next run. Not observed in the concurrency tests.
* The public tick endpoint is unauthenticated by design; it costs an invocation per call. Put a rate limit in front of it if that is abused.

## Voice chat (push-to-talk, private rooms, experimental)

Optional live voice over Agora RTC, audio only, in private rooms whose host turned it on. Public
(matchmade) games never have it: a check constraint on `games` says so. Nothing is recorded.

- **Where**: in a voice room the bottom-centre grid button is the microphone (Auction is in More,
  and still opens by itself when an auction starts). Tap to join muted; hold (120 ms) to talk;
  release, slide off, lose focus or background the app to mute. More → Voice has per-player mute
  and volume, mute everyone, voice volume and Leave voice: all local to the phone.
- **Who decides**: the `voice-token` Edge Function. It proves the seat with the device token (as
  `game-action` does), re-checks kill switch, private room, the room's flag, the host's
  entitlement, game in play and the caps, and only then signs a short-lived token for that game's
  channel (`rr-<game id>`) and that seat's uid (seat + 1). A renewal runs every check again.
- **Code**: `src/engine/voice.ts` (wire format), `supabase/functions/voice-token/`,
  `src/features/voice/` (`voiceController.ts` is the state machine; `agoraEngine.ts` is the only
  file that touches the SDK), migration `20261018000000_voice_chat.sql`.

### Setup and deploy

```bash
npx supabase secrets set AGORA_APP_ID=<app id> AGORA_APP_CERTIFICATE=<primary certificate>
npm run deploy:db          # the migration first
npm run deploy:functions   # includes voice-token
```

`EXPO_PUBLIC_AGORA_APP_ID` goes in `.env` (and in the EAS environment for cloud builds). The
certificate is a function secret only. `react-native-agora` is native: voice needs a development
build (`eas build --profile development`, or `npx expo run:android|ios`), not Expo Go, where the
mic button reports that voice is not in this version of the app.

### Switches, entitlement and limits (SQL editor, no release needed)

```sql
update public.voice_settings set value = 0 where key = 'voice_chat_enabled';   -- kill switch
update public.voice_settings set value = 20 where key = 'monthly_game_limit';
update public.voice_settings set value = 3000 where key = 'monthly_participant_minutes';
update public.voice_settings set value = 0 where key = 'require_entitlement';  -- any host (testing)
select public.voice_grant('RR-ABC234');        -- let this player host voice rooms (optionally: , 30 days)
select public.voice_revoke('RR-ABC234');
select * from public.voice_usage_monthly;      -- games, participant-minutes, reconnects, estimated cost
```

There is no subscription system yet: `voice_entitlements` is the entitlement source, written only
by the server side. A game counts toward the monthly limit when its first token is issued, once.
When a cap is reached, new joins and renewals are refused at once and a connected phone runs out
its current token (at most `token_ttl_seconds`); the kill switch reaches connected phones at their
next heartbeat (`heartbeat_seconds`). `voice_usage_monthly` is the app's own estimate of connected
time, not Agora's bill.

## Checks & tests

```bash
npx tsc --noEmit          # typecheck
npx expo lint             # lint
npm run test:engine       # Vitest: engine + exact Business data + drift checks
npm run test:account      # Vitest: nickname rules, secure session storage, deletion handler
npm run test:social       # Vitest: Player ID input, relationship/expiry/presence/notification rules
npm run test:matchmaking  # Vitest: grouping algorithm, seat names, Play Online rules
npm run test:voice        # Vitest: the push-to-talk state machine
npm run test:ui           # Jest + RNTL
npm run db:local          # throwaway local Postgres (no Docker) with the migrations
DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
npm run test:e2e -- -e SUPABASE_URL=… -e SUPABASE_KEY=…   # Maestro, on a device/emulator with a dev build
npx expo-doctor
```
