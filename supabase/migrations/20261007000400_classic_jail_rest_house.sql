-- Classic Mode finalized rules (engine assumptions MVP-3):
--   * Jail traps a player for up to 3 of their turns (pay ₹500 to leave early).
--   * Rest House collects from every other player; leaving Jail early is a fine.

-- ---------------------------------------------------------------------------
-- Jail: turns left in Jail. in_jail is kept and must agree with it.
-- ---------------------------------------------------------------------------
alter table public.players add column jail_turns_left integer not null default 0
  check (jail_turns_left between 0 and 3);

-- Players jailed under the old rule (skip one turn) get the new rule's full stay.
update public.players set jail_turns_left = 3, skip_turns = 0 where in_jail;

alter table public.players add constraint players_jail_state_check check (in_jail = (jail_turns_left > 0));

-- ---------------------------------------------------------------------------
-- Ledger: new transaction types.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'REST_HOUSE_COLLECTION', 'JAIL_FINE',
    'TRADE_PAYMENT', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'UNDO_REVERSAL'
  )
);
