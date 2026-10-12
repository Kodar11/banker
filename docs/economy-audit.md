# Clash of Capitals — Economy Audit

Audit date: 13 October 2026. Audited tree: commit `51fe70e` plus the uncommitted working-tree changes present that day (the game-duration and end-vote work was mid-flight; see section F). Line numbers refer to that tree and will drift.

Nothing in `src/`, `app/`, `supabase/` or `tests/` was changed by this audit. Everything the audit added is this file and the `docs/economy-audit/` folder (temporary scripts and their raw output).

**How to read the evidence labels**

| Label | Meaning |
|---|---|
| **Code** | Read directly from the cited source. |
| **Existing test** | Asserted by a test that was already in the repository and passed on the audit date. |
| **Probe** | Reproduced by a temporary audit script that drives the real engine (`applyAction`); output in `docs/economy-audit/evidence/probe-results.json`. |
| **Simulated** | Measured over full games played through the real engine by scripted strategies; output in `docs/economy-audit/evidence/`. |
| **Manual** | Calculated by hand from the cited formula. |
| **Unverified** | Not established; listed in section F. |

No production gameplay data was available to the audit (no access to the live database), so **nothing in this report is a statement about how real players behave**. "Simulated" results describe scripted strategies, which are stated in section E.

---

## A. Executive summary

**How the economy works.** Two rule sets share one engine. Classic is the physical board game: every player starts with ₹25,000, collects ₹1,500 each lap, buys 26 properties at printed prices, pays printed rents, and can take a simple bank loan. Capital ("intermediate" in code) keeps all of that and adds a shared financial calendar, yearly property-market changes, five amortizing loan products, a credit score, property insurance against a yearly "crisis" bill, resale auctions and secret objectives. A hosted game lasts 5 to 10 financial years (about one lap per player per year, roughly 5.2 turns each) and the highest net worth wins; a matchmade game has no duration and runs to the last player standing.

**The bank is the only source and sink of money, and it is not a balance.** Money is created by starting cash, the Start reward, card rewards, loans, mortgages and sales to the bank; it is removed by purchases, construction, taxes, fines, interest, repayments, premiums and crisis bills. No bank balance is tracked. Every balance change goes through one function that also writes the ledger row (`Draft.transfer`, `src/engine/draft.ts:64-96`).

**Accounting integrity is sound.** Across 2,700 simulated full games (both modes; 2, 4 and 8 players; 5, 7 and 10 years) every player's balance equalled the sum of their ledger entries after every game, with no negative balance and no structural property violation. The server applies each action under a row lock, in one database transaction, with an exactly-once action id. **No Critical finding was identified.**

**The five things that most shape the economy today**

1. **Debt is cheap and is never collected.** A Classic loan costs a single 10% charge, has no term and never has to be repaid. A Capital loan that is simply ignored defaults after about 2.3 years into a fixed balance that stops growing and is never taken from the player. In simulation, a player who borrowed the limit on the first turn and never repaid won 57–67% of four-player games against three otherwise identical players who did not (a fair share is 25%). Repaying on schedule was not rewarded, and in 10-year Capital games it raised the borrower's bankruptcy rate.
2. **Net worth counts property and buildings at 100% of cost.** Spending cash on a property or a house does not lower the score, so the only cost of investing is liquidity. Players in the simulations ran down from ₹25,000 to about ₹3,000–5,000 of cash by year 3 and stayed there, while most of the cash shortages that followed (99% at four players over five years, 74% at eight players over ten) hit players whose net worth was at least twice the bill.
3. **Insurance is priced well above what it protects.** A policy costs ₹500–900 per property per year and waives one ₹3,000 bill that strikes one property picked at random from everything owned at the table. With 20 or more properties owned, the chance that a given policy pays out is 5% or less. A simulated player who insured everything got back ₹0.22–0.34 per rupee of premium and won 7–17% of four-player games.
4. **The economy is a different game at different table sizes and lengths.** With two players a property is landed on about once every seven years, so rent barely matters and nobody goes bankrupt. With eight players over ten years the game becomes an elimination: four to seven bankruptcies per game, and 17–80% of games ended by last-player-standing before the duration ran out.
5. **Several confirmed exploits let a player take money or score that the rules do not intend** — a self-declared card payout of up to ₹10,000, giving cash away before going bankrupt so the creditor gets nothing, free secret-objective bonuses, free credit score, and buying at auction below the bank's own buy-back price. They are listed with reproductions in section G.

---

## B. Formula reference

### B.0 Architecture map (Phase One)

| Concern | Calculates | Executes the payment | Persists |
|---|---|---|---|
| All rules constants (Classic) | `BUSINESS_MVP_RULES`, `src/engine/rules.ts:9-223` | — | stored per game as `games.assumptions_version` |
| All rules constants (Capital) | `INTERMEDIATE_RULES`, `src/engine/intermediateConfig.ts:155-307` | — | version stored in `IntermediateState.configVersion` |
| Host settings (starting cash, loan limit, volatility, objectives, privacy, duration) | `parseGameConfig`, `src/engine/gameConfig.ts:126-133`; limits `:45-48` | — | `games.config`, written only by `UPDATE_CONFIG` (`supabase/functions/game-action/db.ts:384-386`) |
| Board and deeds | `PROPERTY_DEEDS`, `src/engine/businessBoard.ts:118-208`; `BOARD_ROWS` `:295-304` | — | static; catalog migrations mirror it |
| Dice, movement, Start reward | `rollDice` `reducer.ts:551-580`, `movePlayer` `:600-620`, `completeCircuit` `:622-634` | `completeCircuit` | `players.position`, `players.circuits` |
| Landing resolution | `resolveLanding` `reducer.ts:768-846` | sets `turn.pending`; money moves in `payPending` `:1403-1447` | `games.turn` (JSON) |
| Purchase | `purchasePrice` `selectors.ts:197-199` | `buyProperty` `reducer.ts:1070-1100` | `properties.owner_player_id` |
| Bank auction | `openNewAuction` `reducer.ts:1131-1152`, `placeBid` `:1305-1324` | `finalizeAuction` `:1352-1389` | `auctions`, `auction_bids` |
| Rent | `computeRent` `selectors.ts:53-70` | `payPending('RENT')` | ledger |
| Building, selling, mortgage, redemption | `propertyActionBlocker` `selectors.ts:368-435`; amounts `:154-158`, `:231-254` | `propertyAction` `reducer.ts:1885-1982` | `properties` |
| Classic loans | `loanTerms` `selectors.ts:257-260` | `requestLoan` `reducer.ts:1996-2029`, `repayLoan` `:2031-2048`, `payLoanInterest` `:667-678` | `loans` table |
| Capital loans, credit, market, calendar | `intermediateFinance.ts`, `intermediateSelectors.ts` | `intermediateEngine.ts` | one JSON document, `games.intermediate` |
| Insurance and crises | `insurance.ts:34-46`, `:116-131` | `buyInsurance` `:138-176`, `resolveCrisis` `:272-323`, `payCrisisBill` `:385-402` | `games.intermediate` plus `insurance_policies`, `crisis_events` (`db.ts:499-564`) |
| Cards | `cards.ts:76-125`, `findCard` `:146-149` | `resolveCard` `reducer.ts:880-986`, `resolveManualCard` `:1466-1503` | ledger |
| Taxes, Club, Jail, Rest House | `selectors.ts:110-120`, `rules.ts:39-71` | `requestTax` `reducer.ts:849-857`, `resolveClub` `:860-871`, `payJailFine` `:695-706`, `collectFromEachPlayer` `:734-752` | ledger |
| Trades and transfers | `tradeBlocker` `selectors.ts:296-324` | `acceptTrade` `reducer.ts:2110-2139`, `transferMoney` `:1984-1994` | `trade_offers`, ledger |
| Bankruptcy and leaving | — | `declareBankruptcy` `reducer.ts:1505-1522`, `liquidate` `:1529-1564`, `walkAway` `:1632-1702` | `players.status` |
| Net worth and ranking | `netWorth` `selectors.ts:180-190` | `finishGame` `reducer.ts:1711-1736` | `games.winner_player_id`, `GAME_FINISHED` event |
| Objectives | `OBJECTIVES` `objectives.ts:95-173` | `finalizeObjectives` `:269-298` | `player_objectives` |
| Undo | `undoBlocker` `selectors.ts:343-354` | `approveUndo` `reducer.ts:2268-2304` (compensating `UNDO_REVERSAL` rows) | `games.undo_stack` |
| The single balance mutation | — | `Draft.transfer` `draft.ts:64-96` | `players.balance` + `transactions` |

**Authority.** Every calculation above is authoritative on the server only. The engine in `src/engine` is copied verbatim into `supabase/functions/_shared/engine` by `scripts/sync-engine.mjs`, and `tests/engine/sourceSync.test.ts` fails if the two differ (**Existing test**). The Edge Function locks the game row, checks the action id, loads state from the tables, runs the engine, and writes state, ledger, events and the action record in one transaction (`handler.ts:303-362`, `db.ts:159-162`, `db.ts:334-489`). The client never computes an amount that is charged: the screens import the same selectors (`netWorth`, `financialOverview`, `computeRent`, `loanOffers`, `unmortgageCost`) from the engine. The only duplicated arithmetic is `src/features/learning/calc.ts`, used by the tutorial lessons; it reads the same constants and is not used in play (**Code**).

**Clocks.** Three clocks exist and are not interchangeable (`gameEnd.ts:11-21`): a *lap* (one player passing Start: pays the reward and triggers Classic loan interest), a *financial year* (all starting players have moved 36 spaces by dice on average; drives the duration, the Capital market, Capital loan due dates and crises), and a *turn*. Card moves, Jail and Rest House placements move tokens but not the financial year.

### B.1 Starting cash and host settings

| Setting | Default | Host range | Source |
|---|---|---|---|
| Starting cash | ₹25,000 | ₹10,000–50,000 in ₹5,000 steps | `rules.ts:22`, `gameConfig.ts:45-48` |
| Loan limit (total principal owed) | ₹20,000 both modes | ₹5,000–50,000 in ₹5,000 steps | `rules.ts:176`, `intermediateConfig.ts:228`, `gameConfig.ts:47` |
| Duration | 5 financial years | 5–10; duration votes can extend to 10 | `rules.ts:206-210`, `gameEnd.ts:79-81` |
| Market volatility (Capital) | balanced | stable, balanced, volatile | `intermediateConfig.ts:170-192` |
| Secret objectives (Capital) | on | on or off | `gameConfig.ts:66` |
| Players | — | 2–8 | `rules.ts:16-19` |

Only starting cash, loan limit, volatility, objectives, privacy and duration can be changed. No price, rent, rate or fee is configurable per game. Secret-objective rewards and cash targets scale with starting cash (`objectives.ts:184-187`); nothing else does.

### B.2 Property purchase prices

**Classic:** the deed price. **Capital:** the property's current market value (`purchasePrice`, `selectors.ts:197-199`), which starts at the deed price and changes each financial year (B.9). There is no discount, surcharge or purchase restriction other than having the cash and it being the buyer's turn on that square (`buyProperty`, `reducer.ts:1070-1100`). A declined property goes to an auction among all active players, the decliner included, opening at ₹100 with ₹100 increments and a 5-second countdown that each bid resets (`rules.ts:145-161`). Board data, validation and the amount charged all read the same function (**Code**; **Existing test** `money.test.ts` "buys an unowned property").

City sites (20). Rents are the deed values before the colour-set multiplier.

| Pos | Property | Group | Price | Site | 1 house | 2 houses | 3 houses | Hotel | House cost | Hotel cost | Mortgage | % of price | Redeem |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Mumbai | Blue | 8,500 | 1,200 | 4,000 | 5,500 | 7,500 | 9,000 | 7,500 | 7,500 | 4,250 | 50% | 4,675 |
| 4 | Ahmedabad | Blue | 4,000 | 400 | 1,500 | 3,000 | 4,200 | 5,000 | 4,500 | 4,500 | 2,000 | 50% | 2,200 |
| 6 | Indore | Green | 1,500 | 200 | 600 | 1,500 | 2,500 | 3,600 | 2,000 | 2,000 | 750 | 50% | 825 |
| 8 | Jaipur | Green | 3,000 | 250 | 1,500 | 2,700 | 4,000 | 5,500 | 4,000 | 4,000 | 1,500 | 50% | 1,650 |
| 10 | Delhi | Pink | 6,000 | 750 | 3,000 | 4,300 | 5,500 | 7,500 | 5,000 | 5,000 | 4,000 | 66.7% | 4,400 |
| 11 | Chandigarh | Pink | 2,500 | 200 | 900 | 1,600 | 2,500 | 3,500 | 3,000 | 3,000 | 1,250 | 50% | 1,375 |
| 14 | Shimla | Purple | 2,200 | 200 | 1,000 | 2,750 | 4,500 | 6,000 | 3,500 | 3,500 | 1,100 | 50% | 1,210 |
| 15 | Amritsar | Purple | 3,300 | 300 | 1,400 | 2,800 | 4,000 | 5,000 | 4,500 | 4,500 | 1,050 | 31.8% | 1,155 |
| 17 | Srinagar | Purple | 5,000 | 550 | 3,500 | 5,000 | 7,000 | 8,000 | 6,000 | 6,000 | 2,500 | 50% | 2,750 |
| 19 | Agra | Green | 2,500 | 200 | 900 | 1,600 | 2,500 | 3,500 | 3,000 | 3,000 | 1,250 | 50% | 1,375 |
| 21 | Kanpur | Green | 4,000 | 400 | 1,500 | 3,000 | 4,500 | 5,500 | 4,500 | 4,500 | 2,000 | 50% | 2,200 |
| 22 | Patna | Green | 2,000 | 150 | 800 | 2,000 | 3,000 | 4,500 | 2,500 | 2,500 | 1,000 | 50% | 1,100 |
| 23 | Darjeeling | Blue | 2,500 | 200 | 1,200 | 2,600 | 3,500 | 5,000 | 3,000 | 3,000 | 1,250 | 50% | 1,375 |
| 25 | Calcutta | Blue | 6,500 | 800 | 3,200 | 4,500 | 6,500 | 8,000 | 6,000 | 6,000 | 3,250 | 50% | 3,575 |
| 26 | Hyderabad | Blue | 3,500 | 300 | 1,200 | 3,000 | 4,500 | 6,000 | 5,000 | 5,000 | 1,750 | 50% | 1,925 |
| 28 | Madras | Purple | 7,000 | 900 | 3,500 | 5,000 | 7,000 | 8,500 | 6,500 | 6,500 | 3,500 | 50% | 3,850 |
| 30 | Bangalore | Purple | 4,000 | 400 | 1,500 | 3,000 | 4,500 | 5,500 | 4,500 | 4,500 | 2,000 | 50% | 2,200 |
| 32 | Ootacamund | Pink | 2,500 | 200 | 1,000 | 2,250 | 3,500 | 4,500 | 3,000 | 3,000 | 1,250 | 50% | 1,375 |
| 33 | Cochin | Pink | 3,000 | 300 | 1,200 | 2,000 | 4,250 | 5,500 | 4,000 | 4,000 | 1,500 | 50% | 1,650 |
| 35 | Margao | Pink | 4,000 | 400 | 2,200 | 3,500 | 5,000 | 6,500 | 4,500 | 4,500 | 2,000 | 50% | 2,200 |

Transport and utility (6). They cannot be built on and never get the colour-set multiplier.

| Pos | Property | Price | Rent alone | Partner | Rent with partner | Mortgage | % of price | Redeem |
|---|---|---|---|---|---|---|---|---|
| 2 | Water Works | 3,200 | 500 | Air India | 1,000 | 1,600 | 50% | 1,760 |
| 3 | Railway | 9,500 | 1,000 | Best | 1,350 | 4,750 | 50% | 5,225 |
| 12 | Electric Company | 2,500 | 50 x dice | Motor Boat | 100 x dice | 1,750 | 70% | 1,925 |
| 13 | Best | 3,500 | 600 | Railway | 1,350 | 1,750 | 50% | 1,925 |
| 24 | Air India | 10,500 | 1,200 | Water Works | 1,350 | 4,750 | 45.2% | 5,225 |
| 34 | Motor Boat | 5,500 | 100 x dice | Electric Company | 200 x dice | 1,750 | 31.8% | 1,925 |

Sum of all 26 deed prices: ₹1,12,200 (Blue 25,000; Purple 21,500; Green 13,000; Pink 18,000; transport and utility 34,700) (**Manual**). Starting cash at the table is ₹50,000 with two players, ₹1,00,000 with four and ₹2,00,000 with eight, so the board is unaffordable for two players, roughly matched for four, and cheap for eight.

### B.3 Rent

`computeRent(state, key, diceTotal)` — `selectors.ts:53-70`. Inputs: the property's owner, mortgage flag, houses or hotel, the owner's holdings in that colour, and the dice total that landed the payer.

1. Unowned, or mortgaged: **0**.
2. City: `deed.rent[houses]` (0–3 houses) or `deed.hotelRent`, **multiplied by 2** when the owner holds 3 or more of the 5 properties of that colour. Mortgaged properties count towards the 3 (`rules.ts:101-107`, `selectors.ts:19-36`). The multiplier never exceeds 2 (**Existing test** `rent.test.ts` "4 or 5: still ×2").
3. Transport/utility, fixed type: `base`, or `pairedRent` when the same owner holds the named partner and the partner is not mortgaged.
4. Transport/utility, dice type: `multiplier × diceTotal`, or `pairedMultiplier × diceTotal` with the partner.

There is no rounding (all integers), no minimum and no cap. Rent is charged when the landing is resolved, after any loan interest that fell due on the same move (`reducer.ts:578-579`, `:768-795`). Landing on your own property charges nothing. In Capital, rent does **not** follow market value; it stays at the deed figures (`intermediateRulebook.ts`, "Property values"). The payer owes the owner; if the payer cannot afford it the turn rests in `AWAITING_PAYMENT` until they raise the money or declare bankruptcy (B.11). Rent is owed to an owner who has left the game (their holdings are frozen in their name), so that rent leaves play (**Probe** P3).

Pair rents are asymmetric by design of the deed data: Water Works with Air India charges ₹1,000 while Air India with Water Works charges ₹1,350; Electric Company with Motor Boat charges 100 × dice while Motor Boat with Electric Company charges 200 × dice.

### B.4 Houses and hotels

| Rule | Value | Source |
|---|---|---|
| Where | Any city site the player owns; **the full colour is not required** | `rules.ts:118-120`, `selectors.ts:402-404` |
| When | Only on the builder's own turn, any phase except an auction | `selectors.ts:380`, `:400` |
| Limits | 3 houses, then a hotel that replaces them. No even-building rule. No supply limit on houses or hotels. | `rules.ts:122-124` |
| Blocked by | Mortgage on that property; a Capital secured-loan pledge; an unsettled crisis bill | `selectors.ts:383-401` |
| Cost | `deed.houseCost` per house, `deed.hotelCost` for the hotel, paid to the bank | `reducer.ts:1900-1916` |
| Sell back | `floor(cost × 0.5)`. Houses one at a time. A hotel is sold whole for half of (hotel + 3 houses) and leaves the site empty | `selectors.ts:241-246`, `rules.ts:131` |
| On mortgage | Buildings stay, inactive; nothing is paid for them | `rules.ts:137-142` |
| On trade or resale | Buildings go to the new owner | `rules.ts:181`, `reducer.ts:1262` |
| On bankruptcy or collateral seizure | Buildings are removed without compensation | `reducer.ts:1539-1547`, `intermediateEngine.ts:336-339` |
| In net worth | Counted at full cost (`buildingCost`, `selectors.ts:154-158`) |

Total cash to take each site from bare land to a hotel, and what each step earns. "Landings to recover" is total invested divided by the rent at that level, without the colour-set multiplier (**Manual**, generated from the deed data; a simplified theoretical figure that ignores mortgages, taxes and who lands where).

| Property | Invested: site | +1 house | +2 | +3 | hotel | Landings to recover (site / 1 / 2 / 3 / hotel) | Rent gained per rupee of each step (site / 1st / 2nd / 3rd house / hotel) |
|---|---|---|---|---|---|---|---|
| Indore | 1,500 | 3,500 | 5,500 | 7,500 | 9,500 | 7.5 / 5.8 / 3.7 / 3 / 2.6 | 13.3% / 20% / 45% / 50% / 55% |
| Patna | 2,000 | 4,500 | 7,000 | 9,500 | 12,000 | 13.3 / 5.6 / 3.5 / 3.2 / 2.7 | 7.5% / 26% / 48% / 40% / 60% |
| Darjeeling | 2,500 | 5,500 | 8,500 | 11,500 | 14,500 | 12.5 / 4.6 / 3.3 / 3.3 / 2.9 | 8% / 33.3% / 46.7% / 30% / 50% |
| Agra | 2,500 | 5,500 | 8,500 | 11,500 | 14,500 | 12.5 / 6.1 / 5.3 / 4.6 / 4.1 | 8% / 23.3% / 23.3% / 30% / 33.3% |
| Chandigarh | 2,500 | 5,500 | 8,500 | 11,500 | 14,500 | 12.5 / 6.1 / 5.3 / 4.6 / 4.1 | 8% / 23.3% / 23.3% / 30% / 33.3% |
| Ootacamund | 2,500 | 5,500 | 8,500 | 11,500 | 14,500 | 12.5 / 5.5 / 3.8 / 3.3 / 3.2 | 8% / 26.7% / 41.7% / 41.7% / 33.3% |
| Shimla | 2,200 | 5,700 | 9,200 | 12,700 | 16,200 | 11 / 5.7 / 3.3 / 2.8 / 2.7 | 9.1% / 22.9% / 50% / 50% / 42.9% |
| Jaipur | 3,000 | 7,000 | 11,000 | 15,000 | 19,000 | 12 / 4.7 / 4.1 / 3.8 / 3.5 | 8.3% / 31.3% / 30% / 32.5% / 37.5% |
| Cochin | 3,000 | 7,000 | 11,000 | 15,000 | 19,000 | 10 / 5.8 / 5.5 / 3.5 / 3.5 | 10% / 22.5% / 20% / 56.3% / 31.3% |
| Amritsar | 3,300 | 7,800 | 12,300 | 16,800 | 21,300 | 11 / 5.6 / 4.4 / 4.2 / 4.3 | 9.1% / 24.4% / 31.1% / 26.7% / 22.2% |
| Ahmedabad | 4,000 | 8,500 | 13,000 | 17,500 | 22,000 | 10 / 5.7 / 4.3 / 4.2 / 4.4 | 10% / 24.4% / 33.3% / 26.7% / 17.8% |
| Bangalore | 4,000 | 8,500 | 13,000 | 17,500 | 22,000 | 10 / 5.7 / 4.3 / 3.9 / 4 | 10% / 24.4% / 33.3% / 33.3% / 22.2% |
| Kanpur | 4,000 | 8,500 | 13,000 | 17,500 | 22,000 | 10 / 5.7 / 4.3 / 3.9 / 4 | 10% / 24.4% / 33.3% / 33.3% / 22.2% |
| Margao | 4,000 | 8,500 | 13,000 | 17,500 | 22,000 | 10 / 3.9 / 3.7 / 3.5 / 3.4 | 10% / 40% / 28.9% / 33.3% / 33.3% |
| Hyderabad | 3,500 | 8,500 | 13,500 | 18,500 | 23,500 | 11.7 / 7.1 / 4.5 / 4.1 / 3.9 | 8.6% / 18% / 36% / 30% / 30% |
| Delhi | 6,000 | 11,000 | 16,000 | 21,000 | 26,000 | 8 / 3.7 / 3.7 / 3.8 / 3.5 | 12.5% / 45% / 26% / 24% / 40% |
| Srinagar | 5,000 | 11,000 | 17,000 | 23,000 | 29,000 | 9.1 / 3.1 / 3.4 / 3.3 / 3.6 | 11% / 49.2% / 25% / 33.3% / 16.7% |
| Calcutta | 6,500 | 12,500 | 18,500 | 24,500 | 30,500 | 8.1 / 3.9 / 4.1 / 3.8 / 3.8 | 12.3% / 40% / 21.7% / 33.3% / 25% |
| Madras | 7,000 | 13,500 | 20,000 | 26,500 | 33,000 | 7.8 / 3.9 / 4 / 3.8 / 3.9 | 12.9% / 40% / 23.1% / 30.8% / 23.1% |
| Mumbai | 8,500 | 16,000 | 23,500 | 31,000 | 38,500 | 7.1 / 4 / 4.3 / 4.1 / 4.3 | 14.1% / 37.3% / 20% / 26.7% / 20% |

Observations from the table (**Manual**): a bare site needs 7 to 13 landings to pay for itself; any developed level needs about 3 to 6. The first house is almost always the best single step (it multiplies rent by 3 to 6). The cheapest sites have the best fully-developed yields (Indore, Patna, Shimla, Darjeeling recover a hotel in under 3 landings; Mumbai, Ahmedabad and Amritsar need more than 4). Transport and utility properties need 7 to 9.5 landings and can never be improved. Section E puts these numbers next to how often a property is actually landed on.

### B.5 Mortgages and redemption

| Rule | Value | Source |
|---|---|---|
| Eligibility | Owner, not already mortgaged, not pledged (Capital), not during an auction. Buildings are allowed. Any time, not only on your turn. | `selectors.ts:426-429` |
| Payout | The deed's mortgage value, bank to player | `selectors.ts:252-254`, `reducer.ts:1951-1967` |
| Redemption | `mortgageValue + round(mortgageValue × 0.10)`, player to bank, any time | `selectors.ts:231-234`, `rules.ts:136` |
| While mortgaged | No rent, no building, no selling buildings, no sale to the bank; still counts for the colour set, income tax, wealth tax and crises | `selectors.ts:56`, `:417-425` |
| Trade | Allowed; the mortgage travels with the property | `rules.ts:183` |
| Sale to the bank | Unmortgaged, unbuilt property only; pays the mortgage value | `reducer.ts:1943-1950` |
| Net worth | Classic: deed price minus mortgage value. Capital: market value minus the full redemption cost. | `selectors.ts:161-164`, `:211-218` |

The mortgage value is exactly half the price for 21 of 26 deeds. The five that differ: Amritsar 31.8%, Motor Boat 31.8%, Air India 45.2%, Delhi 66.7%, Electric Company 70.0% (finding L1). There is no interest that accrues over time: redemption costs the same after one turn or fifty.

### B.6 Loans — Classic

`requestLoan`, `reducer.ts:1996-2029`; `rules.ts:163-177`.

| Term | Value |
|---|---|
| Amount | ₹1,000 minimum, ₹500 steps |
| Limit | total outstanding principal ≤ the game's loan limit (default ₹20,000) |
| Collateral, credit check, term, fee | none |
| Interest | `round(principal × 10 / 100)`, fixed when the loan is taken, charged **once**, the next time the borrower passes or lands on Start (`interestEveryCircuit: false`) |
| Repayment | any amount at any time, never required (`repayLoan`, `:2031-2048`) |
| If interest cannot be paid | the turn rests on a `LOAN_INTEREST` payment like any other debt |
| On bankruptcy | the loan is marked `DEFAULTED` and nothing is collected |

Consequences that follow directly from the code: a loan fully repaid before the next Start pays no interest at all (**Existing test** `startAndLoans.test.ts` "a loan repaid before reaching Start owes no interest"; **Probe** P1); a partial repayment does not reduce the interest, which is fixed on the original principal (**Probe** P1: repaying ₹19,000 of ₹20,000 still costs ₹2,000); and once the single charge is paid the loan is free for the rest of the game.

### B.7 Loans — Capital

Products (`intermediateConfig.ts:236-282`); `REQUEST_LOAN` is refused in a Capital game (`reducer.ts:368`).

| Product | Base rate | Years | Rate | Collateral | Max per loan |
|---|---|---|---|---|---|
| Emergency | 20% | 1 | fixed | no | ₹5,000 |
| Personal | 12% | 3 | fixed | no | ₹10,000 |
| Secured | 8% | 3 | fixed | one property | ₹10,000, and 50% of the property's market value rounded down to ₹500 |
| Long-term | 10% | 5 | fixed | no | ₹15,000 |
| Flexible | 7% | 3 | reviewed yearly | no | ₹10,000 |

- **Eligibility** (`loanRequestBlocker`, `intermediateSelectors.ts:234-251`): amount ≥ ₹1,000 in ₹500 steps, ≤ the product maximum, and total outstanding principal ≤ the game's loan limit. Blocked entirely while the player has an overdue installment or a loan in default (`borrowingBlock`, `:137-141`). **There is no limit on the number of loans or on loans per product**, and no check of cash, assets or income. Loans can be taken at any time, not only on your turn.
- **Rate** (`offeredRate`, `intermediateFinance.ts:112-116`): base rate + credit-band adjustment, clamped to 4%–30%. Locked at signing.
- **Collateral** (`eligibleCollateral`, `intermediateSelectors.ts:151-164`): owned, unmortgaged, unbuilt, not already pledged, not listed for auction. While pledged it cannot be mortgaged, sold, traded or built on, and it still earns rent.
- **Schedule** (`buildSchedule`, `intermediateFinance.ts:158-169`): level annual payment `A = P·r·(1+r)^n / ((1+r)^n − 1)`, rounded half up to the rupee; each year's interest is `round(balance × rate)`; the last installment clears whatever principal is left. Installment *k* falls due *k* financial years after signing (`intermediateEngine.ts:395-402`).
- **Fees**: origination ₹0, prepayment penalty ₹0 (`intermediateConfig.ts:234-235`).
- **Flexible review** (`reviewVariableRate`, `intermediateEngine.ts:261-280`): on each due date with installments still to come, the market component moves by −2, −1, 0, +1 or +2 points (equally likely) and the remaining principal is re-amortized.
- **Early repayment** (`prepayLoan`, `:498-519`; `prepaymentQuote`, `intermediateSelectors.ts:301-307`): any part of the not-yet-due principal plus `round(principal × rate × elapsed / yearLength)` of accrued interest. Not allowed while an installment is due.
- **Paying**: `PAY_LOAN_INSTALLMENT` pays the oldest due installment in full, as two ledger rows (principal, interest). **Nothing is ever deducted automatically.**

Schedules as the engine produces them (**Probe** P10):

| Credit score | Product | Principal | Base rate | Credit adj. | Signed rate | Installments (one per year) | Total interest | Total repaid |
|---|---|---|---|---|---|---|---|---|
| 700 | Emergency | 1,000 | 20% | -1 | 19% | 1,190 | 190 | 1,190 |
| 700 | Emergency | 5,000 | 20% | -1 | 19% | 5,950 | 950 | 5,950 |
| 700 | Personal | 10,000 | 12% | -1 | 11% | 4,092, 4,092, 4,093 | 2,277 | 12,277 |
| 700 | Secured | 10,000 | 8% | -1 | 7% | 3,811, 3,811, 3,809 | 1,431 | 11,431 |
| 700 | Long Term | 15,000 | 10% | -1 | 9% | 3,856, 3,856, 3,856, 3,856, 3,859 | 4,283 | 19,283 |
| 700 | Flexible | 10,000 | 7% | -1 | 6% | 3,741, 3,741, 3,742 | 1,224 | 11,224 |
| 850 | Emergency | 1,000 | 20% | -2 | 18% | 1,180 | 180 | 1,180 |
| 850 | Emergency | 5,000 | 20% | -2 | 18% | 5,900 | 900 | 5,900 |
| 850 | Personal | 10,000 | 12% | -2 | 10% | 4,021, 4,021, 4,022 | 2,064 | 12,064 |
| 850 | Secured | 10,000 | 8% | -2 | 6% | 3,741, 3,741, 3,742 | 1,224 | 11,224 |
| 850 | Long Term | 15,000 | 10% | -2 | 8% | 3,757, 3,757, 3,757, 3,757, 3,755 | 3,783 | 18,783 |
| 850 | Flexible | 10,000 | 7% | -2 | 5% | 3,672, 3,672, 3,672 | 1,016 | 11,016 |
| 500 | Emergency | 1,000 | 20% | +6 | 26% | 1,260 | 260 | 1,260 |
| 500 | Emergency | 5,000 | 20% | +6 | 26% | 6,300 | 1,300 | 6,300 |
| 500 | Personal | 10,000 | 12% | +6 | 18% | 4,599, 4,599, 4,600 | 3,798 | 13,798 |
| 500 | Secured | 10,000 | 8% | +6 | 14% | 4,307, 4,307, 4,308 | 2,922 | 12,922 |
| 500 | Long Term | 15,000 | 10% | +6 | 16% | 4,581, 4,581, 4,581, 4,581, 4,582 | 7,906 | 22,906 |
| 500 | Flexible | 10,000 | 7% | +6 | 13% | 4,235, 4,235, 4,235 | 2,705 | 12,705 |

### B.8 Late payment, default and credit score (Capital)

Timeline of one installment, with `L` = one financial year on the game clock (`installmentDeadlines`, `intermediateSelectors.ts:63-67`; `processLoanCheckpoints`, `intermediateEngine.ts:219-254`):

| Clock | Status | Effect |
|---|---|---|
| due date | `DUE` | can be paid on time |
| due + 0.25 L | `OVERDUE` | credit −20; new borrowing blocked until paid |
| due + 1.25 L | loan `DEFAULTED` | credit −75; the whole loan becomes one fixed balance |

Default balance (`defaultLoan`, `:303-355`) = installments already due (principal + interest) + principal not yet due + interest accrued on that principal since the current loan year began. It **never grows again**, can be paid down in any amounts (`payDefaultedLoan`, `:522-537`), and is **never collected**: default does not take cash and does not bankrupt the player. A secured loan's property goes to the bank at today's market value; the value is set against the balance, any surplus is paid to the borrower in cash and any shortfall stays owed (`settleCollateral`, `intermediateFinance.ts:191-194`). Checkpoints are processed only when dice are rolled, and loans of players who are no longer active are frozen.

Credit score (`intermediateConfig.ts:199-218`; the only writer is `applyCreditEvent`, `intermediateEngine.ts:81-97`):

| Event | Change | When | Applied once per |
|---|---|---|---|
| Start of game | 700 | — | — |
| Installment paid while `DUE` | +5 | on payment | loan and installment |
| Installment becomes overdue | −20 | first dice roll at or after due + 0.25 L | loan and installment |
| Overdue installment paid | +5 | on payment | loan and installment |
| Loan defaults | −75 | first dice roll at or after due + 1.25 L | loan |
| Loan fully repaid on its schedule (including by prepayment) | +15 | on the final payment | loan |
| Financial year ends with a loan open and nothing overdue or defaulted | +5 | year change | player and year |

Range 300–850, clamped (`clampScore`). Each event carries a deterministic id and an id already in the history is ignored, so no event can apply twice (**Code**; **Existing test** `intermediateMode.test.ts`). The score has exactly one use: the rate of *new* loans.

| Score | Band | Rate adjustment |
|---|---|---|
| 750–850 | Excellent | −2 points |
| 700–749 | Good | −1 |
| 650–699 | Fair | 0 |
| 550–649 | Weak | +3 |
| 300–549 | Poor | +6 |

### B.9 Property market and inflation (Capital)

At every financial-year change each property draws one change independently (`startNextYear`, `intermediateEngine.ts:171-186`): new value = `round(value × (100 + change) / 100)` to the nearest ₹100, never below ₹100.

| Profile | Changes (probability) | Expected change per year (**Manual**) |
|---|---|---|
| Stable | −10% (20), 0 (40), +10% (30), +20% (10) | +3.0% |
| Balanced | −20% (10), −10% (20), 0 (20), +10% (30), +20% (20) | +3.0% |
| Volatile | −20% (20), −10% (20), 0 (10), +10% (25), +20% (25) | +1.5% |

Market value drives the bank's sale price, net worth, the collateral limit and the value used when collateral is seized. It does not change rent, building cost, mortgage value or the sell-to-bank price. Each property also carries a "trend" drawn at the start (−5, 0, +5 or +10%) that is shown as a five-year projection; **the trend is not an input to the yearly draw** (finding M7). Inflation (5%) is display only: no price or balance is changed by it (`intermediateConfig.ts:163-166`).

### B.10 Insurance and crises (Capital)

| Term | Value | Source |
|---|---|---|
| Premium | per property, paid up front to the bank: `min(900, 500 + 100 × (year − 1))` | `insurance.ts:34-36` |
| Cover length | 36 spaces of average movement from purchase (one financial year of clock) | `:39-41` |
| What it covers | one crisis bill on that property, for the player who bought it | `:66-68`, `:309-318` |
| Crisis schedule | first at 18 spaces of average movement, then every 36: one per financial year, mid-year | `:44-46` |
| Target | one property drawn uniformly from everything owned by active players, mortgaged or not | `:272-299` |
| Bill | flat ₹3,000 regardless of the property | `intermediateConfig.ts:291` |
| Uninsured | the whole table stops until the owner pays; the owner may sell buildings, mortgage, sell to the bank or borrow; bankruptcy only once none of those is left | `:342-374`, `:417-424` |
| Renewal, refund, transfer | none; a policy ends when claimed, when it expires, or when its property is sold at a resale auction | `:213-226`, `:255-263` |
| Deductible, cap, claim count | none; one claim per policy; payout can exceed the property's price | — |

Insurance pays nothing else: not rent, tax, cards, loans or bankruptcy. A crisis never changes ownership, buildings or the mortgage.

### B.11 Taxes, fines, cards and other compulsory payments

| Charge | Trigger | Amount | To | If unaffordable | Ledger type |
|---|---|---|---|---|---|
| Income Tax | landing on square 5 | `min(50 × properties owned, 500)` | bank | pay or go bankrupt | `TAX_PAYMENT` |
| Wealth Taxes | landing on square 31 | `min(100 × houses + 200 × hotels, 500)` | bank | same | `TAX_PAYMENT` |
| Club | landing on square 18 | ₹100 to each other active player | players | same; on bankruptcy the cash goes to the bank, not the players (`reducer.ts:1512`) | `CLUB_PAYMENT` |
| Rest House | landing on square 27 | collect ₹100 from each other active player, then miss a turn | to the lander | a payer who is short pays what they have, no debt | `REST_HOUSE_COLLECTION` |
| Jail | landing on square 9, or a card | ₹500 to leave at the start of a turn, or miss up to 3 turns | bank | cannot pay: must stay | `JAIL_FINE` |
| Card: pay bank | Chance even 2/4/6/8, Community Chest odd 5/7/11 | ₹2,000 / 1,500 / 1,500 / 3,000; ₹1,000 / 2,000 / 1,500 | bank | pay or go bankrupt | `CARD_PAYMENT` |
| Card: repairs | Community Chest odd 9 | ₹50 per house + ₹100 per hotel, uncapped | bank | same | `CARD_PAYMENT` |
| Card: birthday | Community Chest even 2 | ₹500 from each other active player | to the lander | pays what they have | `CARD_COLLECTION` |
| Classic loan interest | passing Start | 10% of principal, once | bank | pay or go bankrupt | `LOAN_INTEREST` |
| Crisis bill (Capital) | yearly | ₹3,000 | bank | B.10 | `CRISIS_PAYMENT` |

Card rewards from the bank: Chance odd 3/5/7 pay ₹2,500 / 1,000 / 2,000; Chance odd 9 moves to Mumbai (always passing Start: +₹1,500) and pays ₹3,000; Community Chest even 4/6/10/12 pay ₹2,500 / 2,000 / 1,500 / 3,000. The card is chosen by the dice total that landed the player (`findCard`, `cards.ts:146-149`), so there is no deck and no shuffle. Weighted by the two-dice distribution, a Chance landing is worth about +₹278 and a Community Chest landing about +₹167 from the bank on average, before Jail and Rest House effects (**Manual**, assuming the dice total is independent of the square reached). Chance on a roll of 11 has no entry and asks the player to type the amount (finding H2). The Chance odd entries for 10 and 12 can never be selected.

Taxes scale with the count of properties or buildings, never with value or cash, and both cap at ₹500.

### B.12 Bankruptcy, leaving and elimination

- **Classic debt on a turn** (`declareBankruptcy`, `reducer.ts:1505-1522`): allowed whenever the player owes a payment and `balance < amount`. The engine does **not** require the player to have sold, mortgaged or borrowed first. Remaining cash goes to the creditor (to the bank when the debt was to several players), all properties return to the bank cleared of buildings and mortgages, loans are closed unpaid, open trades expire, the undo history is cleared (`liquidate`, `:1529-1564`).
- **Capital crisis bill** (`crisisBankruptcyBlocker`, `insurance.ts:417-424`): allowed only when the player cannot pay **and** has no building to sell, nothing to mortgage or sell, and no loan offer available.
- **Leaving** (`walkAway`, `reducer.ts:1632-1702`): not a bankruptcy. Cash, properties and loans stay in the leaver's name, frozen; whatever they owed on their turn is dropped; they are excluded from the final ranking.
- **Game end**: fewer than two active players, an early vote (strict majority), a duration vote (half the electorate, at least one), or year 10 (`finishGame`, `:1711-1736`).

### B.13 Net worth and final ranking

`netWorth`, `selectors.ts:180-190`.

**Classic** = cash + Σ over owned properties of [deed price − (mortgage value if mortgaged) + buildings at full cost] − outstanding loan principal − loan interest charged but unpaid.

**Capital** = cash + Σ over owned properties of [market value + buildings at full cost − (redemption cost if mortgaged)] − Σ over loans of [principal not yet due + principal and interest of installments due or overdue, or the default balance] − crisis bills still owed.

Order at the end (`finishGame`): unsettled crisis bills are collected from whatever cash there is, secret objectives are checked against that state and paid, then active players are ranked by net worth. Bankrupt and departed players are not ranked. **There is no tie-break**: equal net worths resolve to the earlier seat in the drawn turn order (**Probe** P11). The displayed net worth and the ranking use the same function.

Secret objectives (Capital, `objectives.ts:95-173`), at ₹25,000 starting cash:

| Objective | Condition at the end | Bonus |
|---|---|---|
| Property Mogul | own 3+ properties with deed prices totalling ₹12,000+ | ₹5,000 |
| The Builder | 3+ houses standing (a hotel does not count) | ₹4,000 |
| Cash Guardian | ₹12,000+ cash, nothing overdue or in default | ₹4,000 |
| Deal Maker | 2+ accepted property trades during the game | ₹4,000 |

---

## C. Money-flow map

**Classification.** *Creation*: bank to player, increases total player cash. *Sink*: player to bank, decreases it. *Transfer*: player to player, total unchanged. *Balance-sheet*: cash arrives or leaves together with an asset or liability of equal book value, so cash changes but net worth does not.

| Mechanic | Trigger | Payer | Recipient | Formula | Classification | Ledger type | Authority | Evidence |
|---|---|---|---|---|---|---|---|---|
| Starting cash | `START_GAME` | bank | each player | `config.startingCash` | Creation | `STARTING_FUNDS` | server | `reducer.ts:491-493`; test `startAndLoans` |
| Start reward | forward move reaching square 0 | bank | mover | ₹1,500 | Creation | `START_REWARD` | server | `reducer.ts:622-625`; tests `startAndLoans` |
| Card reward | Chance / Community Chest | bank | lander | card value; manual entry up to ₹10,000 | Creation | `CARD_REWARD` | server (amount typed by the player for the manual card) | `reducer.ts:913-915`, `:1485-1492`; tests `cards`; Probe P16 |
| Objective bonus | game end, Capital | bank | completer | scaled reward | Creation | `OBJECTIVE_REWARD` | server | `objectives.ts:287-290`; tests `objectives` |
| Collateral surplus | secured default | bank | borrower | market value − balance | Balance-sheet (property leaves at market value) | `COLLATERAL_SURPLUS` | server | `intermediateEngine.ts:340-342`; Probe P12 |
| Loan disbursement | borrow | bank | borrower | principal | Balance-sheet (cash up, liability up) | `LOAN_DISBURSEMENT` | server | `reducer.ts:2023`, `intermediateEngine.ts:414` |
| Mortgage payout | mortgage | bank | owner | deed mortgage value | Balance-sheet in Classic; costs 10% of mortgage value in Capital net worth | `MORTGAGE` | server | `reducer.ts:1954-1956`; tests `mortgage`; Probe P9 |
| Building sale | sell back | bank | owner | `floor(cost × 0.5)` | Creation of cash, loss of half the cost in net worth | `HOUSE_SALE`, `HOTEL_SALE` | server | `reducer.ts:1917-1942` |
| Property sale to bank | sell | bank | owner | deed mortgage value | Creation of cash, loss of (value − mortgage value) in net worth | `PROPERTY_SALE` | server | `reducer.ts:1943-1950` |
| Property purchase | buy | buyer | bank | deed price / market value | Balance-sheet (cash becomes property at the same book value) | `PROPERTY_PURCHASE` | server | `reducer.ts:1084-1091` |
| Bank auction | auction closes | winner | bank | high bid | Sink of cash; the winner gains net worth when the bid is below value | `AUCTION_PAYMENT` | server | `reducer.ts:1363-1379` |
| Construction | build | owner | bank | deed cost | Balance-sheet (cash becomes buildings at cost) | `HOUSE_PURCHASE`, `HOTEL_PURCHASE` | server | `reducer.ts:1900-1916` |
| Redemption | unmortgage | owner | bank | mortgage value × 1.10 | Sink of the 10% in Classic net worth; neutral in Capital | `UNMORTGAGE` | server | `reducer.ts:1968-1980`; Probe P9 |
| Loan principal repayment | repay / installment / prepay / default payment | borrower | bank | amount | Balance-sheet (cash down, liability down) | `LOAN_REPAYMENT` | server | `reducer.ts:2037`, `intermediateEngine.ts:450`, `:528` |
| Loan interest | Start (Classic); installment or prepayment (Capital) | borrower | bank | B.6, B.7 | Sink | `LOAN_INTEREST` | server | `reducer.ts:668`, `intermediateEngine.ts:451` |
| Taxes | tax squares | lander | bank | B.11 | Sink | `TAX_PAYMENT` | server | `reducer.ts:849-857` |
| Jail fine | choice in Jail | player | bank | ₹500 | Sink | `JAIL_FINE` | server | `reducer.ts:702` |
| Card charge | card | lander | bank | B.11 | Sink | `CARD_PAYMENT` | server | `reducer.ts:964-974` |
| Insurance premium | insure | owner | bank | B.10 | Sink | `INSURANCE_PREMIUM` | server | `insurance.ts:152` |
| Crisis bill | crisis | owner | bank | ₹3,000 | Sink | `CRISIS_PAYMENT` | server | `insurance.ts:392`, `:460` |
| Bankruptcy settlement | bankruptcy | bankrupt | creditor or bank | all remaining cash | Transfer, or Sink when the creditor is the bank | `BANKRUPTCY_SETTLEMENT` | server | `reducer.ts:1530-1538` |
| Rent | landing | lander | owner | B.3 | Transfer | `RENT_PAYMENT` | server | `reducer.ts:786-794`, `:1422-1429` |
| Club | landing | lander | every other active player | ₹100 each | Transfer | `CLUB_PAYMENT` | server | `reducer.ts:860-871` |
| Rest House | landing | every other active player | lander | up to ₹100 each | Transfer | `REST_HOUSE_COLLECTION` | server | `reducer.ts:822-840` |
| Birthday card | card | every other active player | lander | up to ₹500 each | Transfer | `CARD_COLLECTION` | server | `reducer.ts:916-918` |
| Trade | accept | either side | other side | agreed cash; properties move with buildings and mortgage | Transfer | `TRADE_PAYMENT` | server | `reducer.ts:2110-2139` |
| Resale auction (Capital) | auction closes | winner | seller | high bid ≥ reserve | Transfer | `AUCTION_PAYMENT` | server | `reducer.ts:1232-1281` |
| Gift | any time, any active player | sender | another active player | any amount up to ₹10,00,000 | Transfer | `PLAYER_TRANSFER` | server | `reducer.ts:1984-1994` |
| Undo | approved undo | reverse of the original | reverse | same amounts | Reverses the original classification | `UNDO_REVERSAL` | server | `reducer.ts:2283-2299` |

**Not in the ledger because no cash moves:** a loan written off at bankruptcy, a Classic loan closed as `DEFAULTED`, a property or building destroyed by bankruptcy or seizure, a market revaluation, a crisis waived by insurance. These change net worth without a ledger row.

**How loans affect cash and liabilities.** Borrowing raises cash and a liability by the same amount, so net worth is unchanged at the moment of borrowing in both modes (**Probe** P6: net worth ₹9,000 before and after a ₹10,000 loan). The ledger nevertheless records the disbursement as a bank-to-player payment, so a count of "money created" from the ledger overstates new wealth by the principal still owed. Interest reduces net worth only when it is charged (Classic: at Start) or falls due (Capital: on the due date); interest that is accruing but not yet due is not a liability anywhere, which is why a loan taken just before the game ends is free.

**Transaction integrity (Phase Five E).**

| Question | Answer | Evidence |
|---|---|---|
| Does every balance change create a ledger entry? | Yes. `transfer` is the only writer of `balance` in the engine. | `draft.ts:64-96`; **Simulated**: zero ledger violations in 2,700 games; **Existing test** `money.test.ts` "ledger always equals balances", `randomized.test.ts` |
| Can a transaction be recorded without the balance change? | No; they happen in the same function, and the action commits or rolls back whole. | `draft.ts`; `db.ts:334-489` |
| Can a retry apply a payment twice? | No. An action id already stored returns the current state; the same id with a different payload is refused. A lost-update guard checks `state_version`. | `handler.ts:321-326`, `db.ts:358-380`; **Existing test** `tests/server/gameAction.test.ts` (passing on the audit date) |
| Can a failed operation partially update balances? | No. The engine works on a clone and throws before returning; the server rolls the transaction back. | `draft.ts:44-47`; `handler.ts:313-351` |
| Are player-to-player transfers atomic and two-sided? | Yes; one ledger row carries both sides. Multi-payee payments (Club, trades) are several rows in one action. | `draft.ts`; `reducer.ts:1416-1420` |
| Does undo reverse the right transactions? | It posts compensating rows for the recorded moves in reverse order, restores the recorded property state, and refuses if any touched property has changed or a party has left. Loans, auctions, interest, the Jail fine, premiums and crisis bills are not undoable. | `reducer.ts:2196-2304`, `selectors.ts:343-354`; **Existing test** `undo.test.ts` |
| Are loans represented consistently? | Classic loans are rows in `loans`; Capital loans live only inside the `games.intermediate` JSON document. Both are written in the same transaction as the cash movement. | `db.ts:373`, `:462-474` |
| Does the client hold the full ledger? | No: a snapshot carries the latest 400 transactions and 60 events. The server balance stays correct, but a long game's client ledger view is incomplete. | `db.ts:260-261` |

---

## D. Worked examples

All amounts come from the cited formulas with repository values.

**D1. Purchase and development (Manual; costs confirmed by `money.test.ts`).** Indore: buy ₹1,500; three houses 3 × ₹2,000; hotel ₹2,000; total ₹9,500. Rent 200 → 600 → 1,500 → 2,500 → 3,600. With two more Green properties every figure doubles (hotel ₹7,200). Mumbai: ₹8,500 + 3 × ₹7,500 + ₹7,500 = ₹38,500 for a hotel renting at ₹9,000, or ₹18,000 with three Blues, which is 72% of the default starting cash in one landing.

**D2. Transport and utility rent (Manual).** Railway alone ₹1,000; with BEST ₹1,350. Motor Boat on a roll of 9: 100 × 9 = ₹900; with Electric Company 200 × 9 = ₹1,800. Electric Company on the same roll: 50 × 9 = ₹450; with Motor Boat 100 × 9 = ₹900.

**D3. Mortgage, redemption and their effect on net worth (Probe P9).**

| Action on Indore | Cash | Net worth, Classic | Net worth, Capital |
|---|---|---|---|
| Build a house (₹2,000) | −2,000 | 0 | 0 |
| Sell the house (refund ₹1,000) | +1,000 | −1,000 | −1,000 |
| Mortgage (₹750) | +750 | 0 | −75 |
| Redeem (750 + round(75) = ₹825) | −825 | −75 | 0 |
| Sell to the bank (₹750) | +750 | −750 | −750 |

Mortgaging and selling to the bank pay the same cash, but mortgaging keeps the property; selling is never the better choice for cash alone.

**D4. Small and large Classic loan (Probe P1; Manual).** Borrow ₹1,000: receive ₹1,000; `round(1000 × 10 / 100)` = ₹100 due at the next Start; total cost ₹100 whenever (or whether) the principal is repaid. Borrow ₹20,000: ₹2,000 at the next Start. Repay all ₹20,000 before reaching Start: ₹0 interest. Repay ₹19,000 before reaching Start: still ₹2,000.

**D5. Small and large Capital loan (Probe P10).** Emergency ₹1,000 at a score of 700: rate 20 − 1 = 19%; one installment of 1,000 + round(190) = ₹1,190. Long-term ₹15,000 at 700: rate 9%; level payment ₹3,856; installments ₹3,856 × 4 then ₹3,859; interest by year 1,350 / 1,124 / 879 / 611 / 319; total interest ₹4,283; total repaid ₹19,283. The same loan at a score of 500 (Poor, +6): 16%, total interest ₹7,906.

**D6. Early repayment (Manual; Probe P5 for the zero case).** Prepaying ₹5,000 of a 9% loan half-way through the loan year costs 5,000 + round(5,000 × 9 × 0.5 / 100) = ₹5,225. Prepaying at the moment of borrowing costs the principal and ₹0 interest.

**D7. Ignoring a loan (Probe P7, two players, year length 72 clock units).** Long-term ₹15,000 at 9% plus Secured ₹4,000 at 7% on Mumbai, nothing ever paid:

| Game clock | Event | Credit score |
|---|---|---|
| 1.07 years | installment 1 of each loan falls due; the "clean year" bonus is still awarded | 700 → 705 |
| 1.26 years | both installments overdue | 685, then 665 |
| 2.04 years | installment 2 of each falls due | 665 |
| 2.33 years | second Long-term installment overdue; Long-term loan defaults | 645, then 570 |
| 2.33 years | second Secured installment overdue; Secured loan defaults; Mumbai seized | 550, then 475 |

Long-term default balance: two due installments 2 × 3,856 = 7,712, plus principal not yet due 9,762, plus accrued interest 293 = **₹17,767**, fixed for the rest of the game; the scheduled total was ₹19,283. Cash paid to the bank on either loan: **₹0**. The player stays active. Secured loan: balance ₹4,506; Mumbai's market value that day ₹10,300; ₹4,506 applied, **₹5,794 paid to the borrower in cash**, loan settled. The borrower therefore turned a property with a deed price of ₹8,500 into ₹4,000 + ₹5,794 = ₹9,794 of cash, where selling it to the bank would have paid ₹4,250.

**D8. Credit score (Probe P5).** Ten times in a row: borrow ₹1,000 Emergency, prepay ₹1,000 immediately. Score 700 → 715 → … → 850 with no dice rolled, ₹0 interest and no change in cash. The Long-term rate offered moves from 9% to 8%.

**D9. Insurance (Probe P13).** Indore (price ₹1,500) is the only owned property, so the first crisis must strike it. Uninsured: the owner pays ₹3,000, twice the property's price. Insured in Year 1: the owner paid ₹500 and the bill is waived.

**D10. Taxes and penalties (Manual).** Income Tax with 7 properties: min(350, 500) = ₹350; with 10 or more: ₹500. Wealth Taxes with 2 houses and 1 hotel: min(200 + 200, 500) = ₹400. Club with three opponents: ₹300. Community Chest repairs with 4 houses and 1 hotel: 200 + 100 = ₹300.

**D11. Net worth (Manual).** *Classic*: cash ₹4,000; Mumbai with 2 houses (8,500 + 15,000 = 23,500); Delhi mortgaged (6,000 − 4,000 = 2,000); loan ₹5,000 outstanding, interest already paid. Net worth = 4,000 + 23,500 + 2,000 − 5,000 = **₹24,500**. *Capital*, same holdings with Mumbai at a market value of ₹9,400 and Delhi at ₹5,400: Mumbai 9,400 + 15,000; Delhi 5,400 − 4,400 (redemption) = 1,000; a Personal ₹10,000 loan at 11% whose first installment (2,992 + 1,100) is due and unpaid: liability = 3,321 + 3,687 not yet due + 4,092 due = 11,100. Net worth = 4,000 + 24,400 + 1,000 − 11,100 = **₹18,300**.

**D12. Final scoring order (Probe P6).** A player with ₹9,000 cash and the Cash Guardian objective borrows ₹10,000 just before the end. Net worth is ₹9,000 before and after the loan; the objective now passes; the bank pays ₹4,000; final net worth ₹13,000.

---

## E. Whole-game scenarios

**Method.** The audit's simulator plays complete games through `applyAction` with scripted strategies; nothing in the engine is mocked. It is a temporary script (`docs/economy-audit/scripts/`), not a repository test. Durations of 5, 7 and 10 financial years were set through the host setting; when the duration vote opened every player voted to end. Player counts are the rule minimum (2), a typical table (4; the arithmetic midpoint of 2–8 is 5) and the maximum (8). Thirty seeds per cell, default settings otherwise.

Strategies:

| Name | Scenario it stands for | Behaviour |
|---|---|---|
| INVESTOR | 2, 7, 8 | buys anything keeping ₹2,000; builds the step with the best rent per rupee while keeping ₹5,000; borrows only when short; repays |
| LOW | 1 low-income | buys only properties up to ₹3,000 and only while keeping ₹12,000; never builds or borrows |
| BORROWER | 3 borrowing-dependent | INVESTOR, plus borrows to the limit on the first turn and repays (Classic: when cash exceeds the debt by ₹10,000; Capital: each installment when it can) |
| NOREPAY | 4 high-debt | BORROWER in every respect except that it never repays |
| DEADBEAT | 4 high-debt | NOREPAY with thinner reserves (₹500 / ₹1,000) |
| INSURER | 5 insurance-focused | INVESTOR that insures every property it owns, every year (Capital) |
| ALLIN | 6 property-rich, cash-poor | keeps no reserve at all |

When short of cash a strategy borrows (if it borrows), then mortgages unbuilt properties, then sells buildings, then mortgages the rest, and goes bankrupt only when still short.

**Not simulated:** trades, gifts, resale auctions, undo, leaving, the manual card (resolved as "no effect"), and any human judgement. Auctions are simulated as an ascending auction in which each player bids up to a fixed fraction of the price. The results below are properties of these scripts on this engine.

### E.1 The same strategy at every seat (uniform INVESTOR tables)

This isolates duration and table size from strategy. "Money created after the start" excludes starting cash and includes loan principal.

| Mode | Years | Players | How games ended | Year reached | Turns per player | Money created after the start | Money removed | Moved between players | End cash per active player | End net worth per active player | End debt per active player | Bankruptcies per game | Winner's share of table net worth | Houses at end | Hotels at end | Cash shortages per game (of which net worth was at least twice the bill) | Fatal shortages per game |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Classic | 5 | 2 | DURATION_VOTE 100% | 5 | 26.8 | 23,233 | 66,238 | 12,077 | 3,498 | 59,438 | 1,883 | 0 | 67% | 3.1 | 1.1 | 2.1 (2.1) | 0 |
| Classic | 5 | 4 | DURATION_VOTE 100% | 5 | 26.5 | 53,925 | 1,38,355 | 60,703 | 3,893 | 41,417 | 4,167 | 0 | 40% | 7.3 | 2.4 | 8.87 (8.8) | 0 |
| Classic | 5 | 8 | DURATION_VOTE 100% | 5 | 25.9 | 1,43,567 | 2,89,702 | 2,55,328 | 6,995 | 34,434 | 6,838 | 0.3 | 37% | 11.5 | 7.4 | 26.07 (21.7) | 0.3 |
| Classic | 7 | 2 | DURATION_VOTE 100% | 7 | 37.8 | 32,300 | 74,800 | 20,003 | 3,750 | 65,592 | 2,850 | 0 | 71% | 4.1 | 1.3 | 3.37 (3.37) | 0 |
| Classic | 7 | 4 | DURATION_VOTE 100% | 7 | 36.9 | 96,945 | 1,79,280 | 1,12,802 | 4,608 | 46,112 | 7,852 | 0.17 | 53% | 9.1 | 3.3 | 14.97 (13.63) | 0.17 |
| Classic | 7 | 8 | DURATION_VOTE 97%, LAST_PLAYER_STANDING 3% | 6.97 | 36.5 | 2,34,663 | 3,83,704 | 4,09,438 | 8,446 | 49,526 | 8,116 | 1.97 | 43% | 10 | 9.6 | 43.03 (32.07) | 1.97 |
| Classic | 10 | 2 | DURATION_REACHED 93%, LAST_PLAYER_STANDING 7% | 9.97 | 52 | 54,312 | 95,885 | 39,842 | 4,359 | 74,297 | 5,543 | 0.07 | 72% | 5.6 | 1.8 | 5.7 (5.53) | 0.07 |
| Classic | 10 | 4 | DURATION_REACHED 90%, LAST_PLAYER_STANDING 10% | 9.87 | 51.6 | 1,41,357 | 2,23,897 | 1,63,594 | 5,085 | 57,794 | 8,646 | 0.57 | 63% | 10.1 | 5.1 | 21.77 (19.27) | 0.57 |
| Classic | 10 | 8 | DURATION_REACHED 83%, LAST_PLAYER_STANDING 17% | 9.7 | 49.7 | 3,47,507 | 4,90,391 | 5,88,021 | 14,399 | 83,023 | 8,697 | 4.03 | 62% | 5.7 | 11.2 | 63.27 (47.13) | 4.03 |
| Capital | 5 | 2 | DURATION_VOTE 100% | 5 | 27.3 | 31,233 | 73,794 | 12,553 | 3,720 | 59,724 | 3,002 | 0 | 69% | 2.6 | 1.2 | 4.83 (4.77) | 0 |
| Capital | 5 | 4 | DURATION_VOTE 100% | 5 | 26.2 | 77,558 | 1,59,189 | 61,591 | 4,710 | 45,243 | 3,429 | 0.1 | 43% | 6.4 | 2.3 | 14.2 (14.07) | 0.1 |
| Capital | 5 | 8 | DURATION_VOTE 100% | 5 | 25.9 | 1,60,947 | 3,15,376 | 2,37,358 | 6,329 | 37,221 | 4,748 | 0.8 | 36% | 10.4 | 6.5 | 29.7 (25.47) | 0.8 |
| Capital | 7 | 2 | LAST_PLAYER_STANDING 10%, DURATION_VOTE 90% | 6.93 | 37.5 | 46,772 | 90,019 | 20,721 | 3,554 | 68,714 | 2,765 | 0.1 | 73% | 2.5 | 1.2 | 8.7 (8.3) | 0.1 |
| Capital | 7 | 4 | DURATION_VOTE 100% | 7 | 37 | 1,09,223 | 1,92,187 | 94,374 | 4,914 | 54,186 | 3,363 | 0.53 | 53% | 7.3 | 2.5 | 21.4 (20.4) | 0.53 |
| Capital | 7 | 8 | DURATION_VOTE 97%, LAST_PLAYER_STANDING 3% | 6.97 | 36.6 | 2,60,500 | 4,17,295 | 3,70,119 | 8,641 | 59,068 | 6,187 | 3 | 48% | 8.9 | 8.2 | 49.9 (39.57) | 3 |
| Capital | 10 | 2 | DURATION_REACHED 83%, LAST_PLAYER_STANDING 17% | 9.7 | 52.6 | 68,698 | 1,11,381 | 30,917 | 3,991 | 80,923 | 3,263 | 0.17 | 71% | 4.4 | 0.8 | 13.5 (13.27) | 0.17 |
| Capital | 10 | 4 | LAST_PLAYER_STANDING 30%, DURATION_REACHED 70% | 9.93 | 51.9 | 1,67,397 | 2,53,759 | 1,45,758 | 5,682 | 85,976 | 4,352 | 1.6 | 71% | 7 | 3.7 | 31.67 (29.27) | 1.6 |
| Capital | 10 | 8 | LAST_PLAYER_STANDING 47%, DURATION_REACHED 53% | 9.63 | 49.7 | 3,94,760 | 5,53,883 | 5,56,439 | 14,955 | 1,19,018 | 6,530 | 5.27 | 72% | 3.7 | 10.5 | 69.9 (55.13) | 5.27 |

Trajectory through a 10-year game (uniform tables):

| Mode | Players | Measure at the start of year | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Classic | 2 | Cash per active player | 25,000 | 4,538 | 3,452 | 3,184 | 3,681 | 3,792 | 3,553 | 3,938 | 3,958 | 4,282 |
| Classic | 2 | Properties owned (of 26) | 0 | 6.8 | 11.5 | 15.3 | 18.2 | 20.1 | 21.5 | 22.8 | 23.6 | 24.2 |
| Classic | 2 | Buildings standing | 0 | 3.4 | 3.5 | 3.6 | 3.9 | 4.4 | 4.7 | 5.1 | 5.9 | 6.6 |
| Classic | 4 | Cash per active player | 25,000 | 4,713 | 3,078 | 3,306 | 3,697 | 4,063 | 4,274 | 4,041 | 4,400 | 4,975 |
| Classic | 4 | Properties owned (of 26) | 0 | 11.5 | 18.3 | 21.6 | 23.8 | 24.8 | 25.3 | 25.4 | 25.5 | 25.6 |
| Classic | 4 | Buildings standing | 0 | 6.7 | 7.2 | 7.9 | 8.5 | 10.1 | 11.1 | 12.9 | 13.9 | 14.8 |
| Classic | 8 | Cash per active player | 25,000 | 6,029 | 4,303 | 4,730 | 5,179 | 5,775 | 7,630 | 10,281 | 13,604 | 11,523 |
| Classic | 8 | Properties owned (of 26) | 0 | 17.7 | 23.7 | 25.3 | 25.7 | 25.5 | 25.1 | 24.2 | 23.8 | 23.9 |
| Classic | 8 | Buildings standing | 0 | 12.5 | 15.1 | 16.3 | 18.8 | 19.5 | 18.8 | 17.9 | 17.3 | 18.6 |
| Capital | 2 | Cash per active player | 25,000 | 4,595 | 2,540 | 2,193 | 2,255 | 1,957 | 2,147 | 1,944 | 2,257 | 2,177 |
| Capital | 2 | Properties owned (of 26) | 0 | 6.6 | 11.8 | 15.1 | 17.4 | 18.7 | 19.6 | 20.8 | 21.4 | 22.6 |
| Capital | 2 | Buildings standing | 0 | 3.6 | 3.8 | 4.1 | 4.3 | 4.3 | 4.5 | 4.7 | 4.9 | 4.9 |
| Capital | 4 | Cash per active player | 25,000 | 4,063 | 3,111 | 3,016 | 2,937 | 3,186 | 3,721 | 3,547 | 3,738 | 3,624 |
| Capital | 4 | Properties owned (of 26) | 0 | 11.5 | 17.7 | 21.5 | 23.4 | 24.1 | 24.2 | 24.4 | 24.1 | 24.3 |
| Capital | 4 | Buildings standing | 0 | 6.8 | 7.3 | 7.7 | 8.5 | 8.7 | 9.1 | 9.9 | 9.8 | 10.3 |
| Capital | 8 | Cash per active player | 25,000 | 5,804 | 4,482 | 4,398 | 4,914 | 5,880 | 7,038 | 7,148 | 8,222 | 10,138 |
| Capital | 8 | Properties owned (of 26) | 0 | 18.6 | 23.6 | 25.3 | 25.4 | 25.1 | 24.6 | 24.3 | 24.1 | 22.7 |
| Capital | 8 | Buildings standing | 0 | 12.5 | 14.2 | 16.1 | 16.9 | 17.6 | 16.7 | 16.8 | 15.3 | 15.9 |

Where the money went, four players, per game (ledger totals; **Simulated**):

| Ledger type | Direction | Classic 5y | Classic 10y | Capital 5y | Capital 10y |
|---|---|---|---|---|---|
| STARTING_FUNDS | bank to player | 1,00,000 | 1,00,000 | 1,00,000 | 1,00,000 |
| START_REWARD | bank to player | 27,550 | 57,950 | 28,100 | 57,150 |
| LOAN_DISBURSEMENT | bank to player | 16,950 | 42,850 | 24,217 | 54,300 |
| CARD_REWARD | bank to player | 9,383 | 22,933 | 11,917 | 19,550 |
| MORTGAGE | bank to player | 42 | 11,990 | 5,542 | 21,480 |
| HOUSE_SALE | bank to player | 0 | 3,200 | 850 | 6,117 |
| HOTEL_SALE | bank to player | 0 | 2,433 | 1,300 | 4,633 |
| OBJECTIVE_REWARD | bank to player | 0 | 0 | 5,633 | 4,167 |
| HOUSE_PURCHASE | player to bank | 52,467 | 1,05,583 | 53,433 | 85,767 |
| PROPERTY_PURCHASE | player to bank | 37,960 | 40,450 | 34,940 | 39,750 |
| AUCTION_PAYMENT | player to bank | 28,373 | 29,913 | 25,047 | 27,987 |
| HOTEL_PURCHASE | player to bank | 7,233 | 17,850 | 8,117 | 13,900 |
| CARD_PAYMENT | player to bank | 7,645 | 15,557 | 7,590 | 16,727 |
| LOAN_INTEREST | player to bank | 1,310 | 4,143 | 1,552 | 3,580 |
| TAX_PAYMENT | player to bank | 1,467 | 3,422 | 1,247 | 3,265 |
| JAIL_FINE | player to bank | 1,617 | 3,317 | 1,467 | 2,733 |
| LOAN_REPAYMENT | player to bank | 283 | 1,867 | 10,666 | 29,132 |
| UNMORTGAGE | player to bank | 0 | 1,795 | 105 | 1,667 |
| CRISIS_PAYMENT | player to bank | 0 | 0 | 14,900 | 29,100 |
| RENT_PAYMENT | player to player | 58,520 | 1,57,702 | 59,692 | 1,38,388 |
| BANKRUPTCY_SETTLEMENT | player to player | 0 | 2,401 | 272 | 4,557 |
| CLUB_PAYMENT | player to player | 1,000 | 1,513 | 890 | 1,317 |
| REST_HOUSE_COLLECTION | player to player | 722 | 1,410 | 777 | 1,416 |
| CARD_COLLECTION | player to player | 462 | 568 | 88 | 233 |

### E.2 Mixed tables

Six strategies rotated around the table (INVESTOR, LOW, BORROWER, DEADBEAT, INSURER, ALLIN). Use this table for table-level outcomes only: which strategies share a table is not balanced across seeds, so per-strategy numbers from it are confounded by the opposition and are not reported here (they are in `sim-results.json`).

| Mode | Years | Players | How games ended | Year reached | Turns per player | Money created after the start | Money removed | Moved between players | End cash per active player | End net worth per active player | End debt per active player | Bankruptcies per game | Winner's share of table net worth | Houses at end | Hotels at end | Cash shortages per game (of which net worth was at least twice the bill) | Fatal shortages per game |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Classic | 5 | 2 | DURATION_VOTE 100% | 5 | 26.6 | 39,348 | 79,855 | 14,363 | 4,747 | 61,431 | 5,892 | 0 | 72% | 3.8 | 1.5 | 2.7 (2.67) | 0 |
| Classic | 5 | 4 | DURATION_VOTE 100% | 5 | 26.6 | 92,568 | 1,74,979 | 67,927 | 4,629 | 43,785 | 8,110 | 0.2 | 48% | 7.4 | 3 | 9.53 (8.77) | 0.2 |
| Classic | 5 | 8 | DURATION_VOTE 100% | 5 | 26 | 2,30,580 | 3,85,218 | 2,83,013 | 7,239 | 40,126 | 11,343 | 1.73 | 49% | 8.5 | 8.6 | 28.87 (22.83) | 1.73 |
| Classic | 7 | 2 | DURATION_VOTE 93%, LAST_PLAYER_STANDING 7% | 7 | 37.6 | 50,363 | 92,570 | 24,485 | 4,031 | 68,498 | 6,698 | 0.07 | 73% | 5.1 | 1.7 | 4.1 (3.87) | 0.07 |
| Classic | 7 | 4 | DURATION_VOTE 97%, LAST_PLAYER_STANDING 3% | 6.97 | 36.6 | 1,28,408 | 2,15,614 | 1,14,999 | 3,998 | 57,239 | 9,781 | 0.8 | 59% | 9.8 | 4.1 | 15.73 (13.6) | 0.8 |
| Classic | 7 | 8 | DURATION_VOTE 80%, LAST_PLAYER_STANDING 20% | 6.87 | 35.7 | 3,30,640 | 4,93,008 | 4,16,371 | 9,254 | 65,894 | 12,734 | 3.93 | 62% | 5.9 | 9.9 | 46.5 (34.7) | 3.93 |
| Classic | 10 | 2 | LAST_PLAYER_STANDING 33%, DURATION_REACHED 67% | 9.27 | 47.3 | 66,793 | 1,09,763 | 38,451 | 4,218 | 85,982 | 8,420 | 0.33 | 81% | 5.5 | 2.4 | 6.87 (6.2) | 0.33 |
| Classic | 10 | 4 | LAST_PLAYER_STANDING 33%, DURATION_REACHED 67% | 9.63 | 49.7 | 1,78,473 | 2,64,976 | 1,61,543 | 5,547 | 79,983 | 10,397 | 1.57 | 75% | 8.3 | 5.2 | 22.1 (18.43) | 1.57 |
| Classic | 10 | 8 | LAST_PLAYER_STANDING 67%, DURATION_REACHED 33% | 9.1 | 45.7 | 4,50,257 | 6,30,234 | 5,53,732 | 12,014 | 1,71,796 | 13,200 | 6.33 | 90% | 2.1 | 11.6 | 63.03 (46.07) | 6.33 |
| Capital | 5 | 2 | DURATION_VOTE 90%, LAST_PLAYER_STANDING 10% | 4.93 | 26.4 | 50,570 | 91,381 | 14,138 | 4,836 | 56,521 | 8,708 | 0.1 | 72% | 2.7 | 1.5 | 5.87 (5.67) | 0.1 |
| Capital | 5 | 4 | DURATION_VOTE 100% | 5 | 26.4 | 1,16,338 | 2,00,114 | 74,226 | 4,466 | 45,463 | 8,777 | 0.37 | 52% | 6.5 | 3 | 14.7 (13.93) | 0.37 |
| Capital | 5 | 8 | DURATION_VOTE 97%, LAST_PLAYER_STANDING 3% | 5 | 26 | 2,44,870 | 4,15,659 | 2,65,302 | 5,279 | 42,119 | 10,330 | 2.47 | 47% | 9 | 7 | 33.1 (25.83) | 2.47 |
| Capital | 7 | 2 | DURATION_VOTE 77%, LAST_PLAYER_STANDING 23% | 6.67 | 35.3 | 64,342 | 1,07,173 | 20,689 | 4,058 | 67,511 | 7,720 | 0.23 | 78% | 2.4 | 1.5 | 9.03 (8.57) | 0.23 |
| Capital | 7 | 4 | DURATION_VOTE 90%, LAST_PLAYER_STANDING 10% | 6.97 | 36.6 | 1,45,813 | 2,32,099 | 1,01,173 | 4,840 | 61,996 | 8,715 | 1.17 | 64% | 6.9 | 3.2 | 19.93 (17.73) | 1.17 |
| Capital | 7 | 8 | DURATION_VOTE 73%, LAST_PLAYER_STANDING 27% | 6.83 | 35.5 | 3,68,752 | 5,54,079 | 3,83,347 | 5,869 | 1,01,442 | 14,552 | 5.5 | 73% | 5.7 | 9.1 | 53.7 (39.13) | 5.5 |
| Capital | 10 | 2 | DURATION_REACHED 53%, LAST_PLAYER_STANDING 47% | 9 | 47 | 82,448 | 1,24,974 | 30,464 | 4,875 | 85,050 | 7,399 | 0.47 | 85% | 2.6 | 1.5 | 12.77 (12.53) | 0.47 |
| Capital | 10 | 4 | LAST_PLAYER_STANDING 50%, DURATION_REACHED 50% | 8.73 | 44.9 | 1,90,578 | 2,79,326 | 1,38,938 | 5,923 | 92,416 | 10,807 | 2.1 | 78% | 6.3 | 3.6 | 27.23 (23.77) | 2.1 |
| Capital | 10 | 8 | DURATION_REACHED 20%, LAST_PLAYER_STANDING 80% | 9.1 | 46.3 | 4,76,143 | 6,61,731 | 5,11,327 | 11,086 | 1,95,503 | 14,687 | 6.7 | 93% | 4.6 | 8.4 | 71.67 (55.57) | 6.7 |

### E.3 One strategy against three INVESTORs (four players, 60 games per row)

A fair share of wins is 25%. The control row pools all four seats of all-INVESTOR tables.

| Mode | Years | Strategy of the one deviating player | Games | Mean final net worth (std. error) | Win rate | Bankrupt | End cash | End debt | Properties | Rent received | Rent paid | Credit score |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Classic | 5 | INVESTOR (control: all four play it) | 240 | 41,633 (1,289) | 25% | 0% | 3,855 | 4,048 | 6.2 | 14,535 | 14,535 | - |
| Classic | 5 | LOW | 60 | 19,215 (856) | 0% | 0% | 13,058 | 0 | 2.6 | 1,060 | 14,046 | - |
| Classic | 5 | BORROWER | 60 | 47,960 (2,864) | 33% | 0% | 3,417 | 3,217 | 7 | 18,259 | 12,552 | - |
| Classic | 5 | NOREPAY | 60 | 64,335 (4,753) | 60% | 2% | 5,139 | 19,667 | 8.7 | 35,281 | 12,699 | - |
| Classic | 5 | DEADBEAT | 60 | 63,079 (5,042) | 58% | 2% | 3,471 | 19,667 | 8.3 | 35,577 | 12,523 | - |
| Classic | 5 | ALLIN | 60 | 51,380 (3,231) | 32% | 0% | 1,545 | 7,217 | 6.3 | 22,553 | 12,535 | - |
| Classic | 10 | INVESTOR (control: all four play it) | 240 | 49,053 (3,355) | 25% | 18% | 3,866 | 7,056 | 5.9 | 40,851 | 40,851 | - |
| Classic | 10 | LOW | 60 | 3,913 (934) | 0% | 73% | 2,175 | 0 | 0.8 | 1,814 | 31,341 | - |
| Classic | 10 | BORROWER | 60 | 50,582 (6,844) | 27% | 18% | 4,356 | 7,575 | 5.6 | 42,750 | 40,142 | - |
| Classic | 10 | NOREPAY | 60 | 88,398 (8,342) | 57% | 15% | 7,555 | 17,000 | 7.9 | 72,754 | 33,693 | - |
| Classic | 10 | DEADBEAT | 60 | 69,244 (7,728) | 47% | 20% | 5,442 | 16,000 | 6.6 | 64,782 | 36,614 | - |
| Classic | 10 | ALLIN | 60 | 56,394 (7,339) | 37% | 23% | 2,776 | 9,667 | 5.3 | 49,899 | 38,577 | - |
| Capital | 5 | INVESTOR (control: all four play it) | 240 | 44,312 (1,556) | 25% | 3% | 4,569 | 3,396 | 6.1 | 14,614 | 14,614 | 710 |
| Capital | 5 | LOW | 60 | 17,359 (1,017) | 0% | 5% | 10,954 | 0 | 2.4 | 1,181 | 16,446 | 700 |
| Capital | 5 | BORROWER | 60 | 52,011 (4,156) | 40% | 7% | 4,195 | 6,699 | 6.8 | 26,331 | 12,124 | 604 |
| Capital | 5 | NOREPAY | 60 | 72,091 (4,921) | 67% | 0% | 6,539 | 23,708 | 9.6 | 35,586 | 11,840 | 475 |
| Capital | 5 | DEADBEAT | 60 | 68,595 (5,274) | 58% | 5% | 4,239 | 22,523 | 9 | 35,722 | 13,858 | 475 |
| Capital | 5 | INSURER | 60 | 36,362 (2,353) | 7% | 5% | 3,378 | 3,826 | 5.3 | 11,939 | 15,119 | 702 |
| Capital | 5 | ALLIN | 60 | 51,388 (3,422) | 37% | 2% | 3,183 | 5,083 | 6.5 | 19,483 | 13,881 | 678 |
| Capital | 10 | INVESTOR (control: all four play it) | 240 | 50,953 (3,720) | 25% | 33% | 3,718 | 3,250 | 5.8 | 34,798 | 34,798 | 722 |
| Capital | 10 | LOW | 60 | 3,229 (871) | 0% | 77% | 983 | 0 | 0.8 | 1,773 | 30,188 | 701 |
| Capital | 10 | BORROWER | 60 | 44,520 (8,607) | 22% | 55% | 3,401 | 1,592 | 4.8 | 38,726 | 25,703 | 601 |
| Capital | 10 | NOREPAY | 60 | 1,01,873 (9,145) | 57% | 15% | 6,508 | 20,146 | 10.4 | 67,544 | 27,343 | 475 |
| Capital | 10 | DEADBEAT | 60 | 1,01,080 (9,911) | 52% | 22% | 4,824 | 18,567 | 9.9 | 63,684 | 24,748 | 475 |
| Capital | 10 | INSURER | 60 | 33,370 (4,540) | 17% | 32% | 2,816 | 2,850 | 4.8 | 25,982 | 32,149 | 719 |
| Capital | 10 | ALLIN | 60 | 54,457 (8,344) | 30% | 38% | 1,853 | 3,725 | 5.5 | 39,325 | 33,815 | 689 |

Insurance in the same experiment:

| Table | Premiums paid per game | Crises covered per game | Bills avoided per game | Returned per rupee of premium |
|---|---|---|---|---|
| Capital, 5 years, 4 players, one INSURER | 5,355 | 0.6 | 1,800 | 0.34 |
| Capital, 10 years, 4 players, one INSURER | 8,982 | 0.65 | 1,950 | 0.22 |

### E.4 Early-ending game (scenario 9)

Any active player may ask for an early vote once per financial year; a strict majority ends the game (`gameEnd.ts:52-54`, `:149-162`). Here the first player to act in year 3 asked and everyone voted to end, on mixed four-player tables.

| Mode | How games ended | Year reached | Turns per player | End cash per player | End net worth per player | Bankruptcies per game | Winner's share |
|---|---|---|---|---|---|---|---|
| Classic | VOTE 100% | 3 | 11 | 5,283 | 34,278 | 0 | 36% |
| Capital | VOTE 100% | 3 | 10.6 | 5,695 | 34,600 | 0 | 38% |

A game ended at the start of year 3 has had about 11 turns per player: most properties are bought, almost nothing has been recovered through rent, and final net worth is close to starting cash plus the Start rewards.

### E.5 Balance questions

Each answer states its evidence and its limit.

**Is the economy cash-starved or inflationary?** Cash-starved in hand, mildly inflationary in net worth. *Evidence:* on uniform four-player tables cash per active player fell from ₹25,000 to about ₹4,000–5,000 by the start of year 2 and stayed between ₹3,000 and ₹5,000 through year 10 (E.1), while mean net worth per surviving player rose from ₹25,000 to ₹41,000–45,000 after 5 years and ₹58,000–86,000 after 10 (the 10-year figure is flattered by survivorship: bankrupt players are not in the average). Money removed (purchases and construction above all) roughly matched money created after year 2. *Limit:* the scripts spend down to a small reserve by design; a table of cautious humans would hold more cash. The structural point does not depend on the scripts: the bank injects about ₹1,500 per player per year through Start plus a net few hundred through cards, and nothing else, so cash can only stay high if players stop buying and building.

**Can players reasonably afford construction?** Yes for a first house or two, not for broad development. *Evidence:* at the end of a 5-year four-player game there were about 7 houses and 2–3 hotels at the whole table, against 20 buildable sites; ₹52,000–53,000 was spent on houses per game against ₹28,000 of Start rewards (E.1 flows). Taking all five Blue sites to hotels costs ₹1,29,000, more than the whole table's starting cash. *Limit:* scripts build greedily by rent per rupee.

**Do property owners gain an overwhelming compounding advantage?** Over long games and large tables, yes. *Evidence:* the winner's share of all net worth on uniform four-player tables rose from 40–43% at 5 years to 53% at 7 and 63–71% at 10; with eight players the share at 10 years was 62–72% and four to five players per game were bankrupt (E.1). The LOW strategy never won a game in any cell and was bankrupt in 73–77% of 10-year four-player games (E.3). *Mechanism (Code):* rent at 3 houses or a hotel is 3 to 10 times site rent and doubles again with three of a colour, while the only catch-up income is the flat ₹1,500 per lap.

**Do loans help players recover or push them into a debt spiral?** They help, and there is no spiral, because nothing compounds and nothing is collected. *Evidence:* B.6–B.8 (**Code**); D7 (**Probe**). In E.3 the borrow-and-never-repay strategy won 57–67% of games against three INVESTORs and had the highest mean net worth in every cell, in both modes. *Limit:* 60 games per row; standard errors are shown.

**Are repayments sustainable relative to income?** They are affordable early and harmful late. *Evidence:* a ₹15,000 Long-term loan costs ₹3,856 a year against about ₹1,500 of Start income and about ₹3,000–4,000 of rent received per player per year on a four-player table (E.1 flows divided by players and years). In 10-year Capital games the repaying BORROWER went bankrupt in 55% of games against 33% for the control and 15% for NOREPAY (E.3): paying installments removed the cash that would have covered a large rent bill. In 5-year games the repaying BORROWER did somewhat better than the control (win rate 33–40%).

**Does insurance offer a reasonable trade-off?** No, at any table that owns more than about six properties. *Evidence (Manual):* a crisis strikes one of the *N* properties owned at the table, so a policy's expected payout is 3,000 / *N* per year against a premium of ₹500–900; the break-even is *N* = 6 in Year 1 and *N* = 3.3 from Year 5. Four-player tables owned about 11 properties by the start of year 2 and 18 by year 3; eight-player tables 18 and 24 (E.1). *Evidence (Simulated):* E.3 — ₹0.22–0.34 returned per rupee of premium; the INSURER's mean net worth was ₹8,000–17,500 below the control and its win rate 7–17%. The only real benefit is liquidity protection for a player who cannot raise ₹3,000 at all. *Also:* the uninsured bill is a significant sink: ₹15,000 per 5-year game and ₹29,000 per 10-year game, about half of all Start rewards paid in the same games.

**Are taxes and forced expenses proportionate?** Taxes are negligible; cards and crises are the forced expenses that matter. *Evidence:* total tax paid was ₹1,247–1,467 per four-player 5-year game, about ₹70 per player per year, against ₹58,500 of rent (E.1 flows). Both taxes cap at ₹500, which is reached at 10 properties or 5 houses. The largest single card charge is ₹3,000 and cards are a net inflow overall.

**Can players with substantial assets become unable to pay routine expenses?** Constantly, but almost never fatally before the late game. *Evidence:* 8.9 cash shortages per four-player 5-year game, 99% of them hitting a player whose net worth was at least twice the bill, none fatal on Classic uniform tables; at 10 years and eight players 63–70 shortages and 4–5 bankruptcies per game (E.1). Rent caused about 90% of shortages in Classic; in Capital the crisis bill caused between 5% (eight players) and 37% (two players) of them. *Mechanism:* property is illiquid — a mortgage raises 50% of price and a building sells for 50% of cost.

**Are some properties or strategies substantially more profitable than others?** Yes on both counts. *Properties (Manual, B.4):* developed cheap sites recover in under 3 landings and developed expensive sites in about 4; undeveloped sites and all transport and utility properties need 7–13. *Strategies (Simulated, E.3):* maximum leverage without repayment dominates; hoarding cash loses every time; insuring everything cost 18–35% of final net worth relative to not insuring.

**Does the economy change between 5 and 10 years?** Substantially. *Evidence (E.1, uniform four-player tables):* bankruptcies per game 0 → 0.17 → 0.57 in Classic and 0.1 → 0.53 → 1.6 in Capital; buildings at the table grow by 20–75% between year 5 and year 10; the winner's share of net worth rises by about 25 points; 10–30% of 10-year games end by elimination before year 10. A 5-year game is decided mostly by who bought what; a 10-year game is decided by development and by who gets knocked out.

**Does player count change the balance?** More than any other variable measured. *Evidence:* with two players only 17–19 of 26 properties were owned by the start of year 5, about ₹12,000 moved between players per 5-year game and there were no bankruptcies; with eight players virtually all 26 were owned by year 4, ₹2,37,000–2,55,000 moved between players per 5-year game, and bankruptcies began in 5-year games (E.1). *Mechanism (Manual):* each opponent's turn lands on a given square about 1 time in 36, and a player takes about 5.2 turns a year, so a property is landed on about 0.14 times per opponent per year: 0.14 a year with two players, 0.43 with four, 1.0 with eight. A site that needs 4 landings to pay back does so in about 28 years with two players, 9 with four and 4 with eight.

**Capital against Classic.** On identical tables Capital produced more bankruptcies (for example 1.6 against 0.57 per 10-year four-player game) and a larger winner's share, driven by crisis bills and installments rather than by the market.

---

## F. Correctness and coverage report

### F.1 What ran

| Suite | Command | Result on the audit date |
|---|---|---|
| Engine and learning (existing) | `npx vitest run tests/engine tests/learning` | **32 files, 1,112 tests, all passed** |
| Account, social, matchmaking, voice logic (existing) | `npx vitest run tests/account tests/social tests/matchmaking tests/voice` | **11 files, 190 tests, all passed** |
| Server integration against real Postgres (existing) | `DATABASE_URL=… npx vitest run tests/server` on a throwaway local PostgreSQL 18 with every migration applied | **377 passed, 22 failed** (pre-existing; see F.2) |
| UI (existing) | `npx jest` | **814 passed, 1 failed** (`tests/ui/polish.test.tsx`, "Game log … latest events up to the limit"; unrelated to the economy, in a file with uncommitted changes) |
| Typecheck | `npx tsc --noEmit` | **fails**, only on `END_GAME` in `tests/server/*` (same cause as F.2) |
| Lint | `npx expo lint` | no problems reported |
| Audit probes (new, temporary) | 14 probes in `scripts/probes.audit.ts.txt` | all 14 ran; each reproduced what it set out to test |
| Audit simulations (new, temporary) | `scripts/sim.audit.ts.txt`, `scripts/deviant.audit.ts.txt` | 2,700 full games; zero ledger or property violations |

### F.2 Existing tests that failed before any change

All 22 server failures and the typecheck failure come from one in-progress change in the working tree: the `END_GAME` action was replaced by end-of-game votes and `durationYears` was added to the game settings, and `tests/server` had not caught up. Thirteen tests fail with "That action is not valid" at an `END_GAME` call, two more expect a specific refusal of `END_GAME`, six fail comparing a stored config that now includes `durationYears`, and one is downstream of the same calls. New server test files for the vote flow appeared in the working tree during the audit, so this was being worked on at the time. **Effect on this audit:** the server tests that prove "objective bonuses are evaluated once and paid once", "a retried end-of-game pays nothing more" and "a crisis bill open at the end is collected before the winner is decided" could not pass on the audit date. The engine-level tests for the same behaviour did pass. Server-side idempotency of ordinary actions, which those files also cover, passed.

### F.3 What the existing tests cover

| Area | Engine tests | Server tests (real Postgres) |
|---|---|---|
| Start reward, movement, circuits | `startAndLoans`, `board`, `turns`, `cards` | `gameAction` |
| Purchase, auction, bids, timing | `money`, `auctionLoanCards`, `hardening` | `gameAction` |
| Rent at every level, colour sets, pairs, mortgaged cases | `rent` (20 tests), `money` | `gameAction` |
| Building, selling, mortgage, redemption, undo of each | `money`, `mortgage`, `classicV1`, `undo` | `gameAction` |
| Classic loans: timing of interest, limits, insufficient funds | `startAndLoans` | `gameAction` |
| Capital maths: amortization, accrual, collateral, market, credit bands | `intermediateFinance` (23 tests) | — |
| Capital lifecycle: due, overdue, default, seizure, prepayment, rate review | `intermediateMode` (61 tests) | `intermediate` |
| Insurance and crises | `insurance` (51 tests) | `insurance` |
| Objectives | `objectives` (55 tests) | `customization` (failing, F.2) |
| Trades, resale auctions | `trades`, `resaleAuction` | `resaleAuction` |
| Bankruptcy, leaving | `leave`, `money`, `mortgage` | `gameAction` |
| Net worth | `money` "cash + property at deed price + buildings at cost − loans", `mortgage` | — |
| Ledger equals balances under random play | `money`, `randomized` + `invariantChecks` | — |
| Idempotency, stale state, concurrency | — | `gameAction` |
| Engine copy on the server is identical | `sourceSync` | — |

The existing tests validate the authoritative engine, and the server tests validate the real handler against a real database. They match the current semantics of the code. They prove that each rule does what it is written to do; **none of them asserts anything about balance**, and several behaviours this audit flags are locked in by tests as intended (a loan repaid before Start is free; a mortgaged property counts for the colour set; leaving freezes holdings).

### F.4 Gaps

- No test covers a whole game played by strategies, so nothing would notice a balance regression. The random harness plays random legal actions and checks invariants, which is a correctness tool.
- No test covers the behaviours in findings H2, H3, M1, M2, M4 as *undesired*; they are simply untested.
- `tests/engine/randomHarness.ts` and `harness.ts` carry comments saying building needs the whole colour, which the rules do not require (`rules.ts:120`).
- Net worth in Capital has no direct formula test for a player with a mortgage, a due installment and a crisis bill together.
- Tie-breaking in the final ranking is untested and undefined.

### F.5 Environment limitations and what remains unverified

- **No production data.** Purchase rates, how often players borrow, default, insure, trade or quit are unknown. Every behavioural statement is from scripts.
- **Not exercised by the audit:** the app's screens (beyond the existing UI suite), realtime broadcast, the matchmaking path, Deno execution of the Edge Function (the handler was run under Node, as the repository's own server tests do), and a deployed Supabase project.
- **Not simulated:** trades, gifts, resale auctions, undo, leaving, human timing in 5-second auctions.
- **Scripts are heuristics.** A stronger strategy than those tested may exist; the audit shows that not repaying beats repaying *for these scripts*, and explains from the code why the result should generalise, but it is not a proof of optimal play.
- **Deed data.** The five mortgage values that are not half the price may be faithful to the physical cards or transcription slips; the audit cannot tell.
- Server tests reflect a snapshot of a working tree that was changing during the audit.

---

## G. Ranked findings

No **Critical** finding: no path was found that corrupts balances, liabilities or the authoritative result.

Each finding is marked **Bug** (the code does something the rules text or evident intent does not), **Exploit** (works as coded, but gives an unintended advantage), or **Balance** (a matter of tuning).

### High

**H1. Debt is never collected, and borrowing to the limit without repaying dominates. — Balance (design)**
- *Evidence.* Classic: one 10% charge, no term, no required repayment (`rules.ts:163-177`, `reducer.ts:1996-2048`). Capital: default fixes the balance, stops interest, takes no cash and is not bankruptcy (`intermediateEngine.ts:292-355`); the only penalties are the credit score and a block on new borrowing. Simulated E.3: NOREPAY won 60% / 57% (Classic 5 / 10 years) and 67% / 57% (Capital) against a fair 25%, with mean net worth 1.5 to 2 times the control.
- *Reproduce.* Probe P7; or rerun `deviant.audit.ts`.
- *Impact.* The loan system adds free liquidity for whoever uses it most aggressively; repayment, credit score and the choice between products have little bearing on who wins. In Capital a loan taken late never reaches its first due date, so it is entirely free.
- *Confidence.* High for the mechanics (code and probe). Medium-high for dominance (scripted strategies, 60 games per row, large effect).
- *Next.* Decide what debt is for before tuning rates: whether unpaid debt should be collected (forced sale, garnished Start reward, bankruptcy), whether Classic interest should recur, and whether accrued interest belongs in net worth. This is the decision collateral-aware lending depends on.

**H2. Chance on a roll of 11 lets the player type their own payout, up to ₹10,000. — Exploit**
- *Evidence.* `cards.ts:85-106` has no Chance odd 11 entry; `findCard` returns a manual card; `resolveManualCard` (`reducer.ts:1466-1503`) pays `RECEIVE` up to `manualMaxAmount` (`rules.ts:98`) from the bank on the player's word. The app offers it (`src/features/game/ActionPanel.tsx:298-317`). Only the player themselves can ask to undo it (Probe P16: another player's request is refused).
- *Reproduce.* Probe P16: from square 9 roll 5 + 6, then `RESOLVE_CARD` `RECEIVE` 10000.
- *Impact.* ₹10,000 is 40% of starting cash. It needs a roll of 11 onto one of two Chance squares, roughly once in 300 turns: about 0.3 times per four-player 5-year game and about once per eight-player 10-year game (Manual). In an online game there is no physical card to read.
- *Confidence.* High.
- *Next.* Decide the real effect of that card, or make the manual path impossible to use for a gain without the table's consent.

**H3. A debtor can empty their pockets before going bankrupt, or simply leave, and the creditor gets nothing. — Bug against the rulebook; Exploit**
- *Evidence.* `declareBankruptcy` checks only `balance < amount` (`reducer.ts:1511`). `TRANSFER_MONEY` and trades are allowed while a payment is pending. The rulebook says bankruptcy follows only "if you still cannot pay" after raising money (`rulebook.ts:204-207`). `walkAway` drops the pending payment (`reducer.ts:1697-1698`). The Capital crisis path does enforce "nothing left to try" (`insurance.ts:417-424`), so the two bankruptcies are inconsistent.
- *Reproduce.* Probe P2: owing ₹15,000 with ₹25,000 in hand, the debtor gives ₹25,000 to a third player and declares bankruptcy; the creditor receives ₹0. Probe P3: owing ₹7,500, the debtor leaves; the creditor receives ₹0 and the debtor keeps ₹25,000 frozen.
- *Impact.* Rent, the main transfer in the game, can be denied to the player who earned it, and wealth can be moved to an ally at will. Unlimited gifts also allow kingmaking at the final ranking.
- *Confidence.* High.
- *Next.* Decide the bankruptcy rule (must liquidate first? who inherits property?) and whether gifts should exist at all, or be restricted while a debt is pending.

**H4. Insurance costs several times its expected value, and the crisis bill ignores the property it strikes. — Balance**
- *Evidence.* B.10; E.5; E.3 (₹0.22–0.34 returned per rupee; INSURER win rate 7–17%). The bill is ₹3,000 on a ₹1,500 site and on a ₹10,500 one alike (Probe P13).
- *Impact.* The rational choice is never to insure once about six properties are owned at the table, which makes the feature a trap for players who use it and a flat ₹3,000 random tax for those who do not. Uninsured bills also stop the whole table until paid.
- *Confidence.* High for the arithmetic; medium for the size of the net-worth effect (scripted).
- *Next.* Set a target for what share of premiums should come back, then choose between scaling the bill with value, scaling the premium, or changing how the target is drawn.

### Medium

**M1. Secret-objective bonuses can be had for nothing. — Exploit**
- Deal Maker: two players pass one property back and forth for ₹1 each way and both collect ₹4,000 (Probe P8). Cash Guardian: a loan just before the end supplies the cash, costs nothing in net worth and pays ₹4,000 (Probe P6). The Builder: three houses on the cheapest site cost ₹6,000 that net worth counts in full. Property Mogul: three properties worth ₹12,000 by deed price.
- *Impact.* A ₹4,000–5,000 bonus is about 10% of a typical 5-year final net worth (₹41,000–45,000), enough to decide close games.
- *Confidence.* High. *Next.* Decide whether objectives should be hard; if so define each against something that cannot be manufactured at the last moment.

**M2. An auction won below the mortgage value is an instant profit from the bank. — Exploit**
- The decliner may bid; bidding opens at ₹100; `SELL_PROPERTY` pays the deed mortgage value at once. Probe P15: Delhi declined, won for ₹100, sold to the bank for ₹4,000. With two attentive bidders the price rises to the mortgage value, so the exposure is in two-player games, low-cash tables, the 5-second window and collusion.
- *Confidence.* High. *Next.* Consider a reserve at the mortgage value, or a delay before a property can be sold back.

**M3. The loan menu contains products nobody should choose. — Balance**
- Flexible (6% at a score of 700, at most 10% after two reviews) is cheaper than Personal (11% fixed) in every possible outcome, with the same limit, term and no collateral (`intermediateConfig.ts:231`, `:246-281`). There is no limit on loans per product, so two Flexible loans fill the ₹20,000 limit. Emergency at 19% is never the cheapest way to borrow unless everything else is exhausted. Secured (7%) costs more than Flexible's expected rate and ties up a property.
- *Confidence.* High (Manual, from the configured numbers). *Next.* Give each product a reason to exist: speed, size, risk or eligibility.

**M4. The credit score can be raised to the maximum for free, and matters little anyway. — Exploit; Balance**
- Probe P5: 700 to 850 in ten borrow-and-prepay pairs, ₹0 cost. The entire range of the score moves a rate by 8 points (−2 to +6), and a defaulted borrower is blocked from borrowing regardless of score.
- *Confidence.* High. *Next.* Decide whether "repaid" should require the loan to have run for some time, and what else the score should gate.

**M5. Net worth is defined differently in the two modes and overstates buildings. — Balance; inconsistency**
- Buildings count at 100% of cost though they can only be sold for 50%. A mortgage costs nothing in Classic net worth until redeemed, and the full 10% charge in Capital at once (Probe P9). Capital ignores interest that has accrued but is not yet due. Players who left are not ranked even though they still hold cash and property.
- *Impact.* Spending is free in score terms, which is the root of the cash-poor equilibrium in E.5.
- *Confidence.* High. *Next.* Choose one valuation basis (cost, liquidation or market) and apply it in both modes.

**M6. The game's character flips with table size and length. — Balance**
- E.5: property does not pay back with two players; eight players over ten years is an elimination game, with 17–80% of games not reaching the chosen duration. Starting cash is fixed per player while the board's price is fixed in total.
- *Confidence.* Medium-high (simulated). *Next.* Decide the intended experience for 2, 4 and 8 players, then consider scaling starting cash, the Start reward or the year length by table size.

**M7. The Capital "trend" and five-year projection are unrelated to what the market does. — Misleading presentation**
- `trendPercent` is drawn at the start and used only by `projectedValue`; `pickMarketChange` never reads it (`intermediateEngine.ts:112`, `:178`; `intermediateFinance.ts:63-72`, `:84-87`). A property shown with a +10% trend has the same expected change as one shown with −5%. Inflation is likewise display-only. The Stable profile has the same expected growth as Balanced with less risk, and Volatile has half the growth.
- *Confidence.* High. *Next.* Either make the trend bias the draw or stop showing a projection.

**M8. Taxes are too small to matter. — Balance**
- About ₹70 per player per year against rents in the thousands; both cap at ₹500 (E.5). Wealth is not taxed in proportion to anything.
- *Confidence.* High. *Next.* Decide whether taxes are meant to be a brake on the leader.

**M9. Leaving freezes property out of the game and turns its rent into a sink. — Balance**
- A departed player's properties are never returned to the bank and still charge rent, which accumulates in an account that can never spend it (Probe P3; `reducer.ts:1614-1624`).
- *Confidence.* High. *Next.* Decide what should happen to a leaver's estate.

### Low

- **L1. Five deed mortgage values are not half the price** (Amritsar ₹1,050 of ₹3,300; Motor Boat ₹1,750 of ₹5,500; Air India ₹4,750 of ₹10,500; Delhi ₹4,000 of ₹6,000; Electric Company ₹1,750 of ₹2,500), and two pair rents are asymmetric (B.3). `businessBoard.ts:129-205`. Possibly faithful to the cards. *Next:* check against the photographs.
- **L2. Selling a property to the bank is never better than mortgaging it**: same cash, and the mortgage keeps ownership (D3).
- **L3. Classic loan interest is all-or-nothing**: repaying 95% before Start saves nothing, repaying 100% saves all of it (Probe P1).
- **L4. Ties in final net worth go to the earlier seat**; no tie-break rule exists (Probe P11).
- **L5. Chance odd 10 and 12 can never be drawn** (`cards.ts:104-105`); the code comment acknowledges it.
- **L6. On a "pay each player" debt, a bankrupt's cash goes to the bank, not to the players owed** (`reducer.ts:1512`).
- **L7. The "clean year" credit bonus is paid while an installment is due and unpaid**, as long as it is not yet overdue (D7, first row).
- **L8. Server tests and the typecheck fail on the audit date** because of the in-progress end-of-game change (F.2); end-of-game payout idempotency is temporarily unproven at the server level.
- **L9. The client receives only the latest 400 ledger rows**, so in-app financial history is incomplete in long games (`db.ts:261`).
- **L10. Test-harness comments describe a full-colour building requirement the rules do not have** (F.4).

---

## H. Future decision checklist

In priority order. Nothing here was implemented.

| # | Decision | What this audit established | Evidence still needed before changing it |
|---|---|---|---|
| 1 | **What happens to unpaid debt** (collection, bankruptcy, recurring interest) and therefore whether lending should become collateral-aware | Debt is free leverage today (H1); secured default already sells the property at market value (D7) | A target for how often borrowing should win; a rerun of E.3 under each candidate rule; real borrowing and default rates from live games |
| 2 | **Bankruptcy and financial-distress rules** in Classic, and gifts | Voluntary bankruptcy and gifts defeat creditors (H3); the Capital crisis path already has the stricter rule | A written rule for the order of liquidation and for who inherits; a check that the random harness still finds no stuck states |
| 3 | **Final wealth and winner calculation** | Buildings at cost, mode differences, no tie-break, leavers unranked (M5, L4) | A decision on valuation basis; replay of E.1 to see how rankings move under it |
| 4 | **Insurance premium and coverage** | Premium is 3–5 times expected value at normal table sizes (H4) | Target loss ratio; whether the crisis is meant as a sink or as a risk to manage; live data on how many players insure |
| 5 | **Secret objectives** | All four can be completed without real play (M1) | Which behaviours the objectives are meant to reward |
| 6 | **Interest rates, products and repayment** | Dominated products, no per-product cap, free late loans (M3) | Should follow decision 1; then a role for each product |
| 7 | **Credit-score tuning** | Free to maximise, narrow effect (M4) | Should follow decisions 1 and 6 |
| 8 | **Property and construction prices; scaling by table size** | Payback depends on table size far more than on the deed (E.5, M6); cheap sites dominate when developed (B.4) | Intended game length per table size; live landing and purchase data; this must come after 1–3, because leverage and scoring change what a price means |
| 9 | **Taxes** | Negligible (M8) | Whether a brake on the leader is wanted; effect on E.1's winner share |
| 10 | **Market presentation** | Trend is cosmetic (M7) | A product decision only |
| 11 | **The manual Chance card and the auction floor** | Confirmed exploits (H2, M2) | The physical card's real text; whether sell-to-bank should exist |

**Reusable asset.** The simulator in `docs/economy-audit/scripts/` reproduces every table in section E in about ten minutes. Promoted into `tests/` as a non-blocking balance report, it would let each decision above be evaluated before and after a change.

---

## Appendix: supporting files

| Path | Contents |
|---|---|
| `docs/economy-audit/README.md` | how to rerun the experiments |
| `docs/economy-audit/scripts/probes.audit.ts.txt` | the 14 probes (P1–P16; P4 was folded into P2 and P14 generates the deed tables) |
| `docs/economy-audit/scripts/simcore.ts.txt`, `sim.audit.ts.txt`, `deviant.audit.ts.txt` | the simulator and its two experiments |
| `docs/economy-audit/evidence/probe-results.json` | raw probe output |
| `docs/economy-audit/evidence/sim-results.json`, `sim-summary.txt` | E.1, E.2, E.4 raw output |
| `docs/economy-audit/evidence/deviant-results.json` | E.3 raw output |
