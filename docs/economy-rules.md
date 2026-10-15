# Clash of Capitals — Agreed Economic Rules

The rules the engine enforces for money, debt, insolvency, departure and the final result. The server
runs them (`supabase/functions/_shared/engine`, a copy of `src/engine`); the app only displays them.
Every value below lives in `src/engine/rules.ts` (Classic) or `src/engine/intermediateConfig.ts`
(Capital); this page explains them and does not override them.

Tests: `tests/engine/economyRules.test.ts`, `tests/engine/cards.test.ts`, `tests/server/economyRules.test.ts`.

## 1. Chance and Community Chest

- The dice total that landed the player picks the table (even/odd) and the entry (`cards.ts`).
- Every effect is computed by the engine from the card data. No action carries an amount, an outcome or
  a card id: `RESOLVE_CARD` is a bare action, and a payload with any other field is refused (`VALIDATION`).
- **Chance on a roll of 11.** The Chance odd table has no 11. It is a bank event, not a card:
  `CHANCE_ROLL_11_REWARD` pays **₹2,000** from the bank (`cards.chanceRoll11Reward`) at landing, with the
  message "Lucky 11 — there is no Chance card for a roll of 11, so the Bank pays you a ₹2,000 reward".
  Both Chance squares (7 and 20) can be reached with an 11, so the trigger is a real landing. No other
  total, and no Community Chest landing, earns a bonus.
- Card money paid automatically (rewards, birthday) is one undo entry; undo posts compensating
  `UNDO_REVERSAL` rows and never re-runs the landing. Card charges are ordinary payments.
- Legacy: a game saved while Chance 11 was still entered by hand (`Pending.CARD_MANUAL`) is settled by
  `RESOLVE_CARD` from the card data — ₹2,000 — whatever the old client asks for.

## 2. Final net worth and the winner (`selectors.ts` `balanceSheet`, `rankStandings`)

- Assets: cash; properties at deed price (Classic) or current market value (Capital); buildings at
  100% of construction cost. Selling a building back to the bank pays 50% (rounded as before).
- Liabilities, each counted once: mortgages (Classic: mortgage value; Capital: redemption cost); loans
  (Classic: principal + interest charged at Start and unpaid; Capital: what closes the loan today,
  including accrued interest and default balances); unpaid crisis bills (Capital).
- At the end: open trades expire, crisis bills are collected, secret objectives are paid (Capital only),
  then players still in the game are ranked. Highest net worth wins; on a tie, lower total liabilities;
  still level, a shared victory. Seat order, ids and chance never decide. Bankrupt and departed players
  are not ranked.

## 3. Loans and credit

### Classic

- 10% interest on the principal, charged once at the next Start.
- **Maturity (proposed policy, pending sign-off):** the principal falls due at the borrower's 3rd Start
  after borrowing (`loans.maturityCircuits`), fixed per loan at signing. Unpaid at the next Start it is
  overdue (borrowing blocked); unpaid at the Start after that it defaults. Default adds no interest and
  blocks borrowing until cleared. Loans signed before maturity existed keep their original contract.

### Capital

- Products, base rates and schedules are unchanged. An installment is due on its date, overdue a quarter
  of a financial year later, and the loan defaults a further year later — roughly when the next
  installment would also be missed.
- On default the whole loan becomes one fixed balance; a secured loan's collateral goes to the bank at
  market value, any surplus is paid to the borrower, any shortfall stays owed. Unsecured loans seize
  nothing. Borrowing is blocked while anything is overdue or in default.

### Credit score (Capital; 700 at the start, 300–850)

| Event | Change |
|---|---:|
| Installment paid on time | +5 |
| Installment becomes overdue | −20 |
| Overdue installment paid | 0 |
| Loan default | −100 |
| Loan fully repaid with a good history (an installment paid on time, nothing ever late) | +10, once |
| Clean financial year (an installment paid on time that year, nothing due, late or in default) | +5 |
| All gains in one financial year | at most +10 |

Borrowing earns nothing; prepaying before anything falls due builds no history, so borrow-and-repay
cycles cannot raise a score. Early repayment itself is always allowed (no penalty). Each event has a
deterministic id and applies once. Score bands only adjust the base rate of new loans
(−2 / −1 / 0 / +3 / +6 points).

## 4. Insolvency and bankruptcy (`estate.ts`)

- A payment the game asks for (rent, tax, card, Club, loan interest, crisis bill) stays pending while
  the player raises money. Bankruptcy is refused while selling buildings (50%) and mortgaging or selling
  property to the bank could cover it. Borrowing is offered but never required.
- Bankruptcy and departure run one settlement, once: pledged collateral against its own loan; then the
  triggering payment, the rest of the turn's payments, crisis bills, then bank loans; the estate sells
  only what it must; a payment owed to several players is shared equally; leftover cash leaves play;
  every property returns to the bank clean; open trades expire. Unpaid amounts are recorded on the claim
  (and once only — interest charged at Start is not counted again on its loan).

## 5. Gifts, trades and resale while a payment is owed

- Players may lend to each other informally; the game never collects it. Ordinary gifts and unequal
  trades are allowed.
- While a mandatory payment is owed: the debtor cannot give money away; a trade must not leave the
  debtor able to raise less from the bank than before (`tradeStripsDebtor`); a resale auction's reserve
  must be at least what the bank would pay for the property (`resaleReserveFloor`). A crisis bill
  pending blocks trades and resale for everyone.

## 6. Deal Maker and auctions

- Deal Maker counts completed player-to-player property trades, any value, any counterparty, back and
  forth allowed. An undone trade stops counting; a trade is recorded once per executing action.
- Auction resale arbitrage is an intended strategy and is unchanged.

## 7. Leaving and disconnection

- `LEAVE_GAME` settles the estate (section 4); a payment the turn was waiting on is paid first to whoever
  it is owed. Leftover cash leaves play; nobody inherits it. A departed player takes no turns, collects
  no rent, cannot vote and cannot win.
- A disconnected player is not removed: the game has no timeout of its own and nobody can remove a
  player after the start.

## Open decisions

1. **Classic maturity duration** — 3 Starts is a proposal (matches the 3-year Personal Loan). Confirm or change `loans.maturityCircuits`.
2. **Default interest** — a defaulted balance (both modes) never grows. No default interest rate has
   been agreed. If one is wanted, a transparent option is simple (non-compounding) interest on the
   remaining default balance, charged once per financial year (Capital) or per Start (Classic).
