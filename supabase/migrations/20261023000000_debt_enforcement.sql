-- Debt enforcement and estate settlement (docs/economy-rules.md).
--
-- 1. Classic bank loans get a principal maturity, fixed when the loan is signed: the borrower's
--    lap count (circuits) at which the principal falls due. Null for every loan signed before this
--    migration: those keep the contract they were signed under (repayable at any time).
--    A loan in default stays status 'DEFAULTED' with closed_at null while it can still be collected;
--    when the borrower's estate is settled it is closed (closed_at set) with `outstanding` recording
--    what the estate could not pay. Both already satisfy the table's existing checks.
--
-- 2. The ledger gets one new type, ESTATE_SETTLEMENT: the cash a departed or bankrupt player still
--    holds once every claim on their estate is paid. It goes to the bank (it leaves play). Every
--    existing type is kept.
--
-- Deploy this BEFORE the game-action function that writes maturity_circuit and ESTATE_SETTLEMENT.
-- Nothing is rewritten: existing rows are valid as they are.

alter table public.loans
  add column maturity_circuit integer
    check (maturity_circuit is null or maturity_circuit > created_at_circuit);

alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'REST_HOUSE_COLLECTION', 'JAIL_FINE',
    'TRADE_PAYMENT', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'COLLATERAL_SURPLUS', 'OBJECTIVE_REWARD',
    'INSURANCE_PREMIUM', 'CRISIS_PAYMENT', 'ESTATE_SETTLEMENT', 'UNDO_REVERSAL'
  )
);

-- ---------------------------------------------------------------------------
-- To reverse (only once no game holds an ESTATE_SETTLEMENT transaction — the ledger is append-only):
--
--   alter table public.loans drop column maturity_circuit;
--   alter table public.transactions drop constraint transactions_type_check;
--   alter table public.transactions add constraint transactions_type_check check (type in ( …the list in
--     20261013000000_property_insurance.sql… ));
-- ---------------------------------------------------------------------------
