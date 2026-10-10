-- Intermediate Mode: an explicit ruleset per game, and the Intermediate economy.
--
-- Additive only. Every existing game keeps working unchanged:
--   * game_mode defaults to 'classic', so games created before this migration — and games
--     created by an older app that sends no mode — are Classic games.
--   * intermediate stays null for every Classic game; nothing Classic reads it.
-- Deploy this BEFORE the game-action function that reads and writes these columns.

-- ---------------------------------------------------------------------------
-- The ruleset. Chosen by the host when the game is created; never changes.
-- ---------------------------------------------------------------------------
alter table public.games
  add column game_mode text not null default 'classic' check (game_mode in ('classic', 'intermediate'));

-- ---------------------------------------------------------------------------
-- The Intermediate economy: financial year, cumulative movement, market values and applied
-- annual changes, loan contracts with their installments and collateral claims, credit scores
-- and their event history. Shape: engine IntermediateState (src/engine/intermediateState.ts).
--
-- One document on the game row, like `turn` and `undo_stack`: it is read and written only by
-- the game-action function, under the game row lock, in the same transaction as the balances,
-- ledger and events of the action that changed it. Null until an Intermediate game starts.
-- ---------------------------------------------------------------------------
alter table public.games
  add column intermediate jsonb check (intermediate is null or jsonb_typeof(intermediate) = 'object');

-- A Classic game never carries an economy.
alter table public.games
  add constraint games_intermediate_only_in_mode check (game_mode = 'intermediate' or intermediate is null);

-- The mode is immutable for the life of the game.
create function public.forbid_game_mode_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.game_mode is distinct from old.game_mode then
    raise exception 'game_mode cannot change (game %)', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger games_mode_immutable before update on public.games
  for each row execute function public.forbid_game_mode_change();

revoke execute on function public.forbid_game_mode_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ledger: one new transaction type (the surplus returned to a borrower when seized
-- collateral is worth more than the defaulted debt). Every existing type is kept.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'REST_HOUSE_COLLECTION', 'JAIL_FINE',
    'TRADE_PAYMENT', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'COLLATERAL_SURPLUS', 'UNDO_REVERSAL'
  )
);
