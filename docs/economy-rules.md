# Clash of Capitals — Agreed Economic Rules

The rules the engine enforces for money, debt, insolvency, departure and the final result. The server
runs them (`supabase/functions/_shared/engine`, a copy of `src/engine`); the app only displays them.
Every value below lives in `src/engine/rules.ts` (Classic) or `src/engine/intermediateConfig.ts`
(Capital); this page explains them and does not override them.

Tests: `tests/engine/economyRules.test.ts`, `tests/engine/loanSystem.test.ts`, `tests/engine/cards.test.ts`, `tests/server/economyRules.test.ts`.

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

### Capital — the five products (`intermediateConfig.ts` `loans`)

| Product | Base rate | Term | Principal | Security | Rate |
|---|---:|---|---|---|---|
| Emergency | 18% | 1 year | ₹10,000–₹20,000 | none | fixed |
| Personal | 13% | 3 years | ₹10,000–₹30,000 | none | fixed |
| Secured | 7% | 3 years | ₹10,000–₹50,000 | pledged property and buildings | fixed |
| Long-term | 11% | 5 years | ₹10,000–₹40,000 | none | fixed |
| Flexible-rate | 9% to start | 3 years | ₹10,000–₹30,000 | none | variable |

- Amounts in ₹500 steps. No single loan above ₹50,000; the host's total limit (`GameConfig.loanLimit`,
  default ₹20,000, at least ₹10,000 in Capital) caps all of a player's loans together. Several loans at once
  are allowed within those limits. No fees, no prepayment penalty. Unsecured products need no property.
- **Rate:** base rate + the credit band's points (−2 / −1 / 0 / +3 / +6), kept within 4%–30%. Fixed for the
  life of the loan, except Flexible-rate.
- **Interest:** one installment a year, the first a full financial year after signing. Each year's interest is
  charged on the principal still outstanding; installments are level (the last one clears the remainder), all
  in whole rupees, rounded half up, computed on the server. Interest accrues pro rata within a loan year; an
  early repayment, a refinance, a default and the balance sheet all use that one accrual. A payment of an
  installment is its principal and its interest, as two ledger entries; only the oldest due installment can be
  paid; early repayment is of principal not yet due, plus its accrued interest, once nothing is due.
- **Flexible-rate:** on each anniversary the market component moves by −2, −1, 0, +1 or +2 points (equally
  likely, the server's seeded draw, kept within 4%–30%); the credit adjustment agreed at signing stays. Only
  installments not yet due are recalculated; nothing already due or paid changes. Every review is recorded.
- **Repayment capacity:** a year of installments on all of a player's loans (everything due now plus each
  loan's next installment), a new loan's first-year payment included, may not exceed the player's net worth
  plus one year of Start rewards (₹1,500 — the only income the game guarantees; rent is never assumed).
  Borrowing itself does not change it. An offer shows the most that fits.

### Capital — secured loans and collateral

- One or more properties may be pledged to one loan, as a pool, with their buildings. Eligible: owned by the
  borrower, not mortgaged (a mortgage and a pledge are never both on one property), not pledged to another
  open loan, not up for auction.
- Valued when the loan is signed (and recorded with it, `pledges`): property at its current market value;
  houses and hotels at 50% of what they cost to build (exactly what selling them back pays). The loan can be
  at most 80% of the pooled value, rounded down to ₹500, and the ₹50,000 product maximum, the total limit
  and repaying capacity still apply. A pool that cannot secure ₹10,000 is refused, with the reason.
- While pledged, a property cannot be mortgaged, sold, traded, auctioned or built on, and its buildings
  cannot be sold back. An undo that would change a pledged property is refused.
- Repaid in full, the pledge ends with the loan, once. Market changes after signing never change the loan.

### Capital — late payment, default and recovery

- An installment is due on its date, overdue a quarter of a financial year later (−20, once), and the loan
  defaults a further year later (−100, once) — roughly when the next installment would also be missed.
- On default the whole loan becomes one fixed balance (installments due + principal not yet due + interest
  accrued this loan year). A secured loan's pledged properties — only those — go to the bank with their
  buildings, valued that day (market value + buildings at 50% of cost); the value is set against the balance,
  any surplus is paid to the borrower, any shortfall stays owed. Unsecured loans seize nothing. Borrowing is
  blocked while anything is overdue or in default; a default is not bankruptcy.

### Capital — refinancing (`REFINANCE_INTERMEDIATE_LOAN`)

- One active loan with nothing due is paid off by a new loan in one action: the old loan's payoff (principal
  not yet due + interest accrued this loan year) is paid from the new loan's money, and from cash if the new
  loan is smaller. The old loan closes SETTLED with its history; the new loan is an ordinary new loan (every
  limit, the capacity check and the current credit band apply; the old loan's principal and payment are what
  it frees). Its collateral is released and may be pledged again in the same step — never two live claims.
- No credit-score bonus, and it is refused while any payment is overdue or a loan is in default.

### Capital — undo and the end of the game

- Taking, paying, prepaying or refinancing a Capital loan is never an undo entry: the debt can't be undone
  while the cash is kept.
- When the game ends, each open loan counts at what would close it that day (principal + interest due +
  interest accrued this loan year) — never future years' interest. Nothing is seized because the game ends,
  so a loan signed on the last turn counts in full against the cash it paid out.

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

## 8. Property insurance (Capital, `insurance.ts`)

- Covered: the scheduled `PROPERTY_CRISIS` only. A policy covers one property or a portfolio for one
  36-space period and pays each covered crisis automatically (loss − deductible ₹0) until it has paid its
  limit, ₹3,000 a period; the owner pays anything above it. Premiums are deducted only when the player has
  the cash: no debt is ever created for one.
- Price (`insuranceQuote`): ₹250 × properties in Year 1, +₹50 a year, max ₹450 each; discounts add up and are
  capped at 50%: portfolio 5% per extra property (max 25%); renewals only: early-buyer 20%/10% (line first
  bought in Year 1/2) and no-claim 10% per claim-free period in a row (max 30%). A claim resets the no-claim
  run only.
- Renewal is optional; it opens after the period's crisis checkpoint and closes 12 spaces after cover ends.
  No cancellation and no refunds, including at the end of the game. A property leaving its buyer leaves the
  policy for good; the new owner is not covered. Paid claims reduce the crisis bill and so never appear in
  net worth twice.

## Open decisions

1. **Classic maturity duration** — 3 Starts is a proposal (matches the 3-year Personal Loan). Confirm or change `loans.maturityCircuits`.
2. **Default interest** — a defaulted balance (both modes) never grows. No default interest rate has
   been agreed. If one is wanted, a transparent option is simple (non-compounding) interest on the
   remaining default balance, charged once per financial year (Capital) or per Start (Classic).
3. **Default total loan limit (Capital)** — the host default stays ₹20,000, so with the new ₹10,000 minimum a
   player can hold at most two loans and the Personal, Long-term, Flexible and Secured maximums are only
   reachable when the host raises the limit (up to ₹50,000). Confirm, or raise `loans.maxOutstandingPrincipal`.
4. **Flexible-rate cap** — the rate moves at most 2 points a year and never leaves 4%–30%; there is no
   separate lifetime cap above the starting rate. Add one (for example +6 points) if wanted.
5. **Classic secured lending** — Classic has its own single 10% bank loan and no secured product, so the
   "deed price" collateral basis is not used anywhere. Decide whether Classic should get a secured loan.
6. **Insurance payout limit** — ₹3,000 a period (one crisis bill) is derived, not agreed: the schedule puts
   exactly one crisis in each 36-space period, so the limit never binds by default and only matters if the
   schedule is tightened or the bill raised. Confirm, or set `insurance.payoutLimit` (must be ≥ one bill).
