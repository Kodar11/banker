# Bots

Seats the game plays by itself, in private lobbies, opt-in public matchmaking, and solo games on the device.
The engine (`src/engine`) decides what is legal. A bot only picks which legal action it prefers.

## Where things are

| Piece | File(s) |
|---|---|
| Bot seat in the engine: `PlayerState.bot`, the `ADD_BOT` lobby action, `joinBot` (matchmaking), names and labels, host hand-off to a person, ending a game when only bots are left | `src/engine/botSeat.ts`, `src/engine/reducer.ts`, `src/engine/actions.ts`, `src/engine/types.ts` |
| Decision engine (pure TypeScript, imports only `../engine/index.ts`) | `src/bots/*` |
| What a bot can see | `src/bots/observation.ts` |
| Board movement (exact roll table from the engine's board + card data, seeded Monte Carlo) | `src/bots/movement.ts`, `src/bots/dice.ts` |
| Game horizon (the engine's financial-year clock) | `src/bots/horizon.ts` |
| Valuation model (shared by every decision) | `src/bots/valuation.ts` |
| Every number the bots use | `src/bots/config.ts` |
| Phase dispatcher / auctions / trades / money | `src/bots/policy.ts`, `auction.ts`, `trading.ts`, `finance.ts` |
| Which bot acts next (shared by server, device and simulations) | `src/bots/runner.ts` |
| Server runner for online games | `supabase/functions/game-action/bots.ts` (wired in `handler.ts`) |
| Matchmaking bot fill | `supabase/functions/matchmaking/handler.ts`, migration below |
| Database | `supabase/migrations/20261025000000_bot_players.sql` |
| Solo games on the device | `src/features/solo/localGame.ts`, `app/solo.tsx` |
| Bot UI (badge, pickers, add-bot sheet) | `src/features/bots/BotSetup.tsx`, lobby/game/player screens, Play Online |
| Tests and simulations | `tests/bots/*`, `tests/engine/botSeats.test.ts`, `tests/server/bots.test.ts`, `tests/ui/bots.test.tsx` |

`npm run sync:engine` copies `src/engine` **and** `src/bots` to `supabase/functions/_shared/`. `tests/engine/sourceSync.test.ts` fails if a copy drifts, and also checks that `src/bots` imports only the engine and itself.

## How a bot decides

The order is the same everywhere (`policy.decide`):

1. **Observe.** `observe(state, botId)` runs the same redaction the server applies to that seat's phone (`redactObjectives` → `redactEndVote` → `redactFinances`). With hidden finances the bot does not see other players' cash, loans, credit, insurance, ballots, private payments or secret objectives, at any difficulty. When cash is hidden, a bot estimates it from public information only: starting cash, plus a Start reward per completed lap, minus the deed prices of what they own and the cost of their buildings, plus the mortgage money on their mortgaged properties.
2. **Obligations first, in game order.** An open end-game vote, then a crisis bill, then what others are waiting on (an undo request, a trade offer, an auction). Then loan installments or principal that have fallen due, then the bot's own turn phase.
3. **Candidates come from the engine.** Every candidate is dry-run through the real `applyAction` on a copy of the bot's own view (`engineAccess.dryRun`). An action the engine refuses is never scored. The bot also never proposes an action that would leave it unable to pay what it already owes.
4. **Score.** The value of the position each candidate leads to, minus the value now (`valuation.assess`), weighted by personality.
5. **Choose, send, re-read.** The chosen action goes through the authoritative engine like a person's action. If the server refuses it, it is excluded for that state version and the bot decides again. After every applied action the bot decides afresh from the new state.

Each call returns one action with a short reason, e.g. `Buys Ahmedabad for ₹4,000: worth about ₹527 more than keeping the cash`. The reason never contains another player's private figures. The server stores the decision kind with each bot action (`game_actions.result.decision`).

### Valuation model

Every amount is rupees of expected value. The parts add up to the whole, and nothing is counted twice:

| Part | What it is |
|---|---|
| **wealth** | Cash − liabilities + terminal value of property and buildings (the standings' net worth) + standalone rent over the horizon − rent expected to be paid to others − future loan interest − expected taxes − expected crisis bills (Capital). |
| **group** | Only the *extra* rent that exists because properties are held together (colour ×2 for 3 of a colour, paired transport/utilities). It is computed as rent with the engine's multipliers minus the same rent with none. A test checks that with three of a colour, group equals exactly half the income. |
| **market** | Capital only: expected drift of owned property to the end of the plan, using the game's real volatility-profile mean (not the projection label). Bargains bought below book value are attributed here rather than to wealth. |
| **liquidity** | −penalty for cash below `R_target`. |
| **risk** | −debt aversion on loan principal, −downside of uninsured crisis bills, −payments in arrears. |
| **objectives** | Capital: own secret objective's bonus × an estimated completion chance. |
| **negotiation** | Action-level: half of a deal's gain is attributed here (Deal Maker weighs it highest). |

How the pieces are computed:

- **Rent** always comes from the engine's `computeRent`, under the hypothetical ownership and buildings.
- **Expected landings** per opponent and property come from the movement model, which mirrors the engine's own resolution. Cards are chosen by dice total, so a roll's full effect is known: Chance odd 9 → Mumbai, jail squares and cards, Rest House skips. Dice-multiplier rents use the expected dice total at those landings.
- **Terminal value is not discounted.** The final standings count property at full value, exactly like cash. Income *is* discounted per turn, and also for a possible early end.
- **Construction** must also pass the personality's hurdle: rent gain + terminal value ≥ hurdle × cost. The brief's starting value was 1.25.
- **Auctions.** Maximum bid = the highest price on the auction's increments whose weighted value still clears the minimum improvement, never above cash − amounts owed. The bot bids only while the next legal bid is within that, and never just because it has been bidding. Hard adds a "denial" value: keeping a property from the opponent who would gain most from it.
- **Trades** are valued on both sides. The bot's side uses its full personality valuation. The partner's side uses the same model, neutrally, on public information. Accepting needs gain ≥ max(₹300, margin × what it gives up) after the rivalry adjustment.
  - **Proposals are pitched at what the other side will actually accept.** The bot predicts the partner's verdict with the same rule a bot uses to answer an offer: their gain minus their rivalry towards the bot's own gain, against max(₹300, margin × what they give up). For a bot partner it uses that bot's public settings (its seat label). For a person it uses `BOT_POLICY.trade.personMargin` / `personRivalry`.
  - A counteroffer happens at most once per exchange. The bot proposes at most one offer at a time. Its own stale offers are withdrawn.
  - **A rejected offer is never made again.** The engine records each exchange a bot offered and saw rejected (`GameState.botTradeMemory`, up to 64 per bot, column `games.bot_trade_memory`). This memory outlives the 20 resolved trades a game keeps in its state.
  - In trades, a liquidity *gain* counts only as far as it covers what is actually owed, for either side (see calibration).
- **Raising money** (rent, tax, crisis bill or overdue installment the bot can't cover): the bot picks the least value destroyed per rupee raised among selling buildings, mortgaging, selling to the bank, and loans. It declares bankruptcy only when the engine allows it *and* liquidation plus every loan on offer could not cover the debt.

### Reserve

- `R_base = max(₹2,000, 20% × configured starting cash)`.
- `R_target = R_base + O_known + B_risk`.
  - `O_known`: the payment the turn is waiting on and any crisis bill (`mandatoryPaymentsOwed`), Classic principal that has fallen due, Classic interest due at a Start within two rolls, and Capital installments due now or within a quarter year. Each counted once.
  - `B_risk` (Normal/Hard): a percentile of seeded simulations of the bot's own next 2 turns' outflows (rent, taxes, Club, card charges). The percentile is the personality's `reservePercentile`.
  - `B_risk` (Easy): the documented fallback, max(₹1,000, 2 × the exact expected cost of the next roll).
- The reserve is a strategic target, not a rule. A purchase can breach it when its score still clears the bar. It can never breach `O_known`.

### Horizon

- **Hosted games** use the engine's own clock: `S_remaining = max(0, Y_limit × N × 36 − S_used)`.
  - `Y_limit` is `durationLimit` (duration + extensions).
  - `N` is the clock's *starting* player count.
  - Capital uses `IntermediateState` (`gameClock`); Classic uses `GameEndState.calendar`.
  - Turns left per active player ≈ `S_remaining / (active × 7)`.
  - Normal/Hard discount each future turn by an 8%-per-year chance of an early-end vote.
- **Matchmade games** have no end date. Income is planned over **2 financial years**. This is a planning assumption, not a rule, and is never shown to players.
- The plan is capped per difficulty (Easy 8, Normal 14, Hard 20 turns) and discounted per turn (Easy 0.97, Normal/Hard 0.985).

## Personalities

Same rules, same information, same model. Only the weights and a few tuning values in `config.ts` differ. The agreed weights are used as given (each column sums to 100) and turned into multipliers relative to the average personality:

| Dimension | Investor | Banker | Deal Maker | Opportunist |
|---|---:|---:|---:|---:|
| Long-term wealth | 30 | 20 | 15 | 20 |
| Liquidity | 15 | 35 | 15 | 10 |
| Group value | 20 | 10 | 15 | 10 |
| Negotiation | 5 | 5 | 30 | 10 |
| Market opportunity | 15 | 5 | 10 | 30 |
| Risk avoidance | 10 | 20 | 10 | 5 |
| Objectives | 5 | 5 | 5 | 15 |

| Tuning (UNVALIDATED starting values) | Investor | Banker | Deal Maker | Opportunist |
|---|---:|---:|---:|---:|
| Construction hurdle (× cost) | 1.2 | 1.3 | 1.3 | 1.2 |
| Trade margin | 10% | 15% | 5% | 10% |
| Proposes trades every Nth own turn | 3 | 5 | 1 | 2 |
| Cash offer pitched at (0 = partner's minimum) | 0.45 | 0.3 | 0.5 | 0.2 |
| Opening bid (× its maximum) | 0.5 | 0.4 | 0.5 | 0.3 |
| Reserve percentile (`B_risk`) | 75th | 80th | 75th | 60th |
| Votes END when ahead by | 10% | 5% | 10% | 20% |

## Difficulties

Same rules and the same information at every level. Difficulty changes only the quality of estimation and planning (`DIFFICULTY_TUNING`).

| | Easy | Normal | Hard |
|---|---|---|---|
| Movement | exact next roll, then even spread | seeded Monte Carlo, 256 futures per player | Monte Carlo, 1,024 futures |
| Plan length | 8 turns, discount 0.97 | 14 turns, 0.985, early-end risk | 20 turns, 0.985, early-end risk |
| Reserve buffer | simple fallback | percentile of simulated outflows | same, more samples |
| Estimation error | fixed ±20% per property (deterministic per bot) | none | none |
| Opponent standing | ignored | 0.25 × partner's gain | 0.5 × partner's gain, and denial value in auctions |
| Trades | answers offers only | proposes, counters | proposes, counters |
| Auction bidding | minimum increments | jump bids towards its limit | jump bids |

Decisions are deterministic for the same state, seat and seed. The Monte Carlo is seeded by seat and turn number, so a run of management actions within one turn is judged on one consistent picture and cannot cycle. Bots never touch the game's dice.

## Coverage: every action the engine accepts

| Action | Bot behaviour |
|---|---|
| `ROLL_DICE`, `END_TURN` | Always, once nothing optional is worth more (management is capped at 12 actions per turn). |
| `BUY_PROPERTY` (+ `insurePremium` in Capital), `DECLINE_PROPERTY` | Scored. Can fund a worthwhile purchase by mortgaging or borrowing first (Normal/Hard). After a decline the bot bids in the auction like everyone else. `START_AUCTION` (same effect as decline) is not used. |
| `PLACE_BID`, `PASS_AUCTION`, `CLOSE_AUCTION` | Bank and resale auctions. Closes an auction whose time has run out (the server's timer does too). |
| `PAY_RENT` / `PAY_TAX` / `PAY_CARD` / `PAY_CLUB` / `PAY_INTEREST` | Pays when it can, otherwise raises the money (see above). |
| `DECLARE_BANKRUPTCY`, `PAY_CRISIS_BILL`, `DECLARE_CRISIS_BANKRUPTCY` | As described above. |
| `PAY_JAIL_FINE`, `STAY_IN_JAIL` | Expected value of the exact next roll vs the fine and the tempo of staying, plus a personality reserve check. |
| `RESOLVE_CARD` | Legacy saved games only. |
| `BUILD_HOUSE`, `BUILD_HOTEL`, `UNMORTGAGE_PROPERTY` | Optional moves, scored, plus the construction hurdle. |
| `SELL_BUILDING`, `SELL_PROPERTY`, `MORTGAGE_PROPERTY` | Raising money, or funding a purchase. |
| `REQUEST_LOAN`, `REPAY_LOAN` (Classic) | Recovery and funding. Repays principal that has fallen due before it defaults; voluntary repayment is scored. |
| `TAKE_INTERMEDIATE_LOAN`, `PAY_LOAN_INSTALLMENT`, `PREPAY_INTERMEDIATE_LOAN`, `PAY_DEFAULTED_LOAN` (Capital) | The engine's own offers (rate, limits, pooled collateral). Pays installments as they fall due, and raises money for an overdue one. |
| `INSURE_PROPERTY`, `INSURE_PROPERTIES`, `RENEW_INSURANCE` | Scored against expected crisis bills at the real premiums. A crisis strikes one of the properties owned at the table. The ownership it is shared over is projected per checkpoint: halfway from today's count towards 75% of the board by the next checkpoint, and so on. A policy covers only the next checkpoint, when few properties are owned, so early policies are good value and late ones usually are not. An uninsured bill the bot could not pay from cash counts double as risk. |
| `CREATE_TRADE`, `ACCEPT_TRADE`, `REJECT_TRADE`, `CANCEL_TRADE` | As described above. |
| `APPROVE_UNDO`, `REJECT_UNDO` | Approves when reversing costs it nothing; otherwise rejects. |
| `CAST_END_VOTE`, `CLOSE_END_VOTE` | Votes END when its own estimate of the standings shows it ahead by its margin. Closes a vote whose time is up. |
| Never used, by design | `REQUEST_END_VOTE`, `REQUEST_UNDO`, `PAUSE_GAME`/`RESUME_GAME`, `LEAVE_GAME`, `TRANSFER_MONEY` (a gift has no strategic value), `REFINANCE_INTERMEDIATE_LOAN`, `START_RESALE_AUCTION`/`CANCEL_AUCTION` (bots bid in resales but never list one), and the lobby/host actions (a bot is never a host). |

## Online games

- **Seats.**
  - A bot seat is a `players` row with `bot_difficulty`/`bot_personality`, **no token hash and no account**. The database refuses any other combination, and any change of a seat's kind.
  - `authenticate` refuses a bot seat, and `claim_seat` now refuses a missing hash explicitly (the old `<>` comparison let a NULL through).
  - No fake auth users, profiles or tickets exist for bots.
- **Runner** (`game-action/bots.ts`).
  - Triggered after every committed action (a person's, a timer's, or its own), and recovered by any state read of a game that has been idle ≥ 2 s with a bot due. The app's watchdog asks for such a read after 6 s with no change while a bot may be the one to move.
  - Takes a 30 s per-game lease (`games.bot_runner_until`) and plays at most 30 moves per run, 700 ms apart.
  - Each move runs in its own transaction: lock the game row, load state, decide, `applyAction`, persist, and record the action under the bot's seat with a deterministic id (SHA-256 of game, version, seat, action). A repeat is refused by the primary key.
  - It releases the lease, then checks once more for a due move. It stops when a person is to move, a timer is running, or the game is paused or finished.
  - **Wake-ups.** When the only thing a bot is waiting for is a resale's "get ready" countdown (`nextBotWakeAt`), the runner arms itself for the moment bidding opens. Nothing else happens at that moment, so without this the bots would never bid in a person's resale.
  - Moves the engine keeps refusing are logged and not looped on.
- **When only bots are left.** When the last person leaves or goes bankrupt in a started game, it ends and is ranked as it stands (`NO_PEOPLE_LEFT`). A lobby with only bots closes. The host role always passes to a person.

## Public matchmaking (opt-in)

- **Opting in.** A *solo* searcher can tick "Fill empty seats with bots" (`matchmaking_enqueue(..., p_allow_bots)`). It is off by default, and a party can't ask (`BOTS_SOLO_ONLY`), because every person at a bot table must have chosen it themselves.
- **Grouping is unchanged.** Below the preferred size, groups still form only after the oldest ticket has waited past `prefer_target_seconds`.
- **When bots are added.** `matchmaking_reserve` adds bot seats only when every ticket in the group allowed bots and `bot_fill_enabled` is on. It fills up to `target_players`, within 8 seats, and the count is fixed on the reservation (`bot_seats`).
- **Consent at ready-up.** The ready-up screen shows "+N bots". Confirming is consenting; declining is the ordinary decline.
- **Game creation.** The worker seats the bots with `joinBot` in the same transaction as the game. Personalities alternate, and the difficulty comes from `bot_fill_difficulty` (default Normal). Once the game is committed, the worker starts its bot runner at once (`startBotRunner`: the referee's own runner and broadcast), so a bot holding the first turn plays without waiting for a phone.
- **Ranking.** The app has no ratings or leaderboards, so nothing changes there. Bot involvement is recorded on the seats and the reservation.
- **Older apps** call the two-argument form and queue exactly as before.

## Private rooms

- The host taps **Add a bot** in the lobby and picks a difficulty and personality. The server checks the host, the lobby and the table size (`ADD_BOT`).
- Bots are removed with the ordinary **Remove**.
- Everyone sees `🤖 Normal · Investor` on the seat, and a 🤖 on in-game chips and player sheets.

## Solo play

- **Home → Play vs bots.** Pick a mode, 1–7 bots, a difficulty, and a personality (or Mixed), plus the usual game settings.
- **Fully local.** The device keeps the game and applies every action with the engine. It runs the same bot runner, sends the person the same redacted snapshot the server would, and runs the auction and vote timers, plus the wake-up when a resale opens for bids. The game screens are unchanged because `gameApi` and the sync layer route a `local` session to it.
- **Nothing leaves the phone.** No referee, matchmaking, voice, chat or seat claim. Solo games are unranked.
- **Limitation:** a solo game lives in memory for the app run only and is not saved.

## Disconnect takeover — not implemented

The blocker is that the server has no notion of a disconnected game seat. Presence exists only in the realtime channel on the phones; there is no server-side grace period, pause or reconnection state for game seats (only matchmaking queues have one). Taking over a seat safely would need that first: an authoritative "disconnected since" plus a hand-back transition. Without it, a second ownership path could race the returning player. Bots therefore never act for a human seat.

## Numbers and calibration

The tables below come from `CALIBRATE=<file> npx vitest run tests/bots/calibration.test.ts`: 24 seeded hosted 5-year games per row, 4 bots each, on the real engine. Win% is per seat. Timings are from this development laptop under Node.

**classic · normal · personalities** — 24 games, 24 finished, 0 refused of 18110 actions, 2.64 ms/decision, 20 trades, 326 builds

| Seat | Win % | Bankrupt % | Avg net worth |
|---|---:|---:|---:|
| investor | 33 | 4 | ₹54,206 |
| banker | 8 | 33 | ₹22,710 |
| dealmaker | 38 | 13 | ₹54,435 |
| opportunist | 21 | 13 | ₹46,246 |

**classic · hard · personalities** — 24 games, 24 finished, 0 refused of 17569 actions, 5.37 ms/decision, 16 trades, 403 builds

| Seat | Win % | Bankrupt % | Avg net worth |
|---|---:|---:|---:|
| investor | 25 | 13 | ₹45,582 |
| banker | 0 | 29 | ₹22,266 |
| dealmaker | 46 | 8 | ₹57,910 |
| opportunist | 29 | 8 | ₹51,735 |

**capital · normal · personalities** — 24 games, 24 finished, 0 refused of 16338 actions, 3.82 ms/decision, 45 trades, 290 builds

| Seat | Win % | Bankrupt % | Avg net worth |
|---|---:|---:|---:|
| investor | 46 | 17 | ₹57,670 |
| banker | 21 | 17 | ₹33,018 |
| dealmaker | 25 | 21 | ₹45,452 |
| opportunist | 8 | 42 | ₹27,347 |

**classic · difficulties** — 24 games, 24 finished, 0 refused of 17961 actions, 2.69 ms/decision, 15 trades, 322 builds

| Seat | Win % | Bankrupt % | Avg net worth |
|---|---:|---:|---:|
| easy | 25 | 16 | ₹43,381 |
| normal | 19 | 13 | ₹38,944 |
| hard | 31 | 9 | ₹47,126 |

**capital · difficulties** — 24 games, 24 finished, 0 refused of 19266 actions, 3.52 ms/decision, 23 trades, 246 builds

| Seat | Win % | Bankrupt % | Avg net worth |
|---|---:|---:|---:|
| easy | 28 | 16 | ₹45,123 |
| normal | 28 | 16 | ₹49,945 |
| hard | 19 | 25 | ₹36,503 |

Findings that changed the policy:

- **Bankers were sold out of their property.** In an early 8-game run they accepted 26 offers (others: 6–16) and ended with a third of the Investor's properties. They were chronically below their own reserve target, so any cash-for-property offer "improved liquidity". Now a deal's liquidity gain counts only as far as it covers what is actually owed.
- **Funding a purchase double-counted.** It added the funding step's score to a score already measured from the current position. The bot borrowed for Agra and then declined Agra. Fixed: the pair is scored once, and the purchase must still be worth it once funded.
- **Capital bots declined almost everything.** Crisis bills were projected over the whole remaining game against the few properties owned so far, while income only covered the plan. Both now use the plan's years, and the crisis share is judged against the ownership the table is heading for.
- **Jail.** Bots under-valued moving and never paid the fine. Moving now also counts a third of the price of each property still for sale on the roll, and the tempo towards the next Start reward.

Not yet resolved (with 24 games per row, differences of about ±10 points are within noise):

- **Personality balance.** The Banker remains the weakest seat in all-bot tables (0–21% wins, highest bankruptcy). It holds more cash and builds less, which loses net-worth races to builders. In Capital the Opportunist busts most (42%).
- **Difficulty ordering.** In Classic, Hard leads (31% wins, 9% bankrupt), but Easy is not clearly below Normal. In Capital, Hard trails Normal. The quality differences are real (more samples, longer plans, opponent modelling), but they do not yet show up as a consistently ordered win rate. The likely next lever is Hard's 20-turn plan, which over-values distant rent.

These are recorded rather than "fixed" by changing the game: tune `config.ts` and re-run. None of the values in `config.ts` should be read as validated optima.

## Deployment (not done — needs authorisation)

1. `npm run deploy:db` (applies `20261025000000_bot_players.sql`). Deploy it **before** the functions.
2. `npm run deploy:functions` (syncs `src/engine` and `src/bots`, then deploys `game-action` and `matchmaking`).
3. Ship the app. It works against an older server, without bot features.

Settings: `matchmaking_settings.bot_fill_enabled` (1) and `bot_fill_difficulty` (0/1/2).
