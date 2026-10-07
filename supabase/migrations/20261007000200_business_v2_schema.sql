-- Business Banker — BUSINESS_V2: physical board order, card tables, trading,
-- multi-undo, loan interest at the next Start, mortgage with buildings.
--
-- V1 games (placeholder board order) are not loadable by the V2 engine; the
-- Edge Function reports them as expired. Nothing is deleted here — they age out
-- through purge_expired_games() like any other session.

-- ---------------------------------------------------------------------------
-- Defaults now point at V2 (rows are always written with an explicit version).
-- ---------------------------------------------------------------------------
alter table public.games alter column rules_version set default 'BUSINESS_V2';
alter table public.properties alter column rules_version set default 'BUSINESS_V2';

-- ---------------------------------------------------------------------------
-- Undo history replaces the single last_undoable record.
-- ---------------------------------------------------------------------------
alter table public.games add column undo_stack jsonb not null default '[]'::jsonb
  check (jsonb_typeof(undo_stack) = 'array');
alter table public.games drop column last_undoable;

-- ---------------------------------------------------------------------------
-- Circuits completed (Start crossings) — the loan-interest checkpoint.
-- ---------------------------------------------------------------------------
alter table public.players add column circuits integer not null default 0 check (circuits >= 0);

-- ---------------------------------------------------------------------------
-- Loans: interest is charged at the next Start, not added at creation.
-- ---------------------------------------------------------------------------
alter table public.loans
  add column interest_amount bigint not null default 0 check (interest_amount >= 0),
  add column created_at_circuit integer not null default 0 check (created_at_circuit >= 0),
  add column interest_charges integer not null default 0 check (interest_charges >= 0),
  add column interest_paid bigint not null default 0 check (interest_paid >= 0);

-- ---------------------------------------------------------------------------
-- Ledger: new transaction types.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'TRADE_PAYMENT',
    'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'UNDO_REVERSAL'
  )
);

-- ---------------------------------------------------------------------------
-- Player-to-player trade offers. Written only by the game-action function;
-- an offer's items never change after creation, only its status.
-- ---------------------------------------------------------------------------
create table public.trade_offers (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  from_player_id uuid not null references public.players (id),
  to_player_id uuid not null references public.players (id),
  offered_property_keys text[] not null default '{}',
  requested_property_keys text[] not null default '{}',
  offered_money bigint not null default 0 check (offered_money >= 0),
  requested_money bigint not null default 0 check (requested_money >= 0),
  status text not null check (status in ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (from_player_id <> to_player_id),
  check ((status = 'PENDING') = (resolved_at is null)),
  check (cardinality(offered_property_keys) + cardinality(requested_property_keys) > 0)
);

create index trade_offers_game_idx on public.trade_offers (game_id, created_at);
create index trade_offers_pending_idx on public.trade_offers (game_id) where status = 'PENDING';

-- Items are immutable; only PENDING → final status transitions are allowed.
create function public.guard_trade_offer_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'PENDING' then
    raise exception 'trade offer % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.offered_property_keys is distinct from old.offered_property_keys
     or new.requested_property_keys is distinct from old.requested_property_keys
     or new.offered_money <> old.offered_money or new.requested_money <> old.requested_money
     or new.from_player_id <> old.from_player_id or new.to_player_id <> old.to_player_id then
    raise exception 'trade offer items are immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trade_offers_guard before update on public.trade_offers
  for each row execute function public.guard_trade_offer_update();

alter table public.trade_offers enable row level security;
revoke all on public.trade_offers from anon, authenticated;
revoke execute on function public.guard_trade_offer_update() from public, anon, authenticated;
