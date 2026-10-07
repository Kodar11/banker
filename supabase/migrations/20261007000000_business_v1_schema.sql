-- Business Banker — schema for BUSINESS_V1 temporary game sessions.
--
-- Security model
--   * The mobile app NEVER reads or writes these tables directly. RLS is enabled on
--     every table with NO policies, and all privileges are revoked from anon and
--     authenticated, so the publishable key cannot touch them.
--   * All reads/writes go through the `game-action` Edge Function, which connects
--     as the database owner, locks the game row (SELECT ... FOR UPDATE), runs the
--     game engine, and commits every change for one action in one transaction.
--   * Ledger tables (transactions, auction_bids, game_events, game_actions) are
--     append-only, enforced by triggers.

-- ---------------------------------------------------------------------------
-- Static catalog (keys only — prices/rents live in the versioned TS source
-- src/engine/businessBoard.ts and are not duplicated here).
-- ---------------------------------------------------------------------------
create table public.board_properties (
  rules_version text not null,
  property_key text not null,
  name text not null,
  property_group text not null check (property_group in ('BLUE', 'PURPLE', 'GREEN', 'PINK', 'TRANSPORT_UTILITY')),
  primary key (rules_version, property_key)
);

-- ---------------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------------
create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{6}$'),
  rules_version text not null default 'BUSINESS_V1',
  status text not null check (status in ('WAITING', 'ACTIVE', 'PAUSED', 'FINISHED')),
  state_version integer not null default 1 check (state_version >= 1),
  host_player_id uuid,
  winner_player_id uuid,
  current_player_id uuid,
  turn_phase text not null default 'AWAITING_ROLL' check (
    turn_phase in ('AWAITING_ROLL', 'AWAITING_DECISION', 'AWAITING_PAYMENT', 'AWAITING_CARD', 'AUCTION', 'TURN_COMPLETE')
  ),
  turn_number integer not null default 0 check (turn_number >= 0),
  -- Full turn context (dice, pending obligation, drawn card). Shape: engine TurnState.
  turn jsonb not null,
  paused_from text check (paused_from is null or paused_from in ('ACTIVE')),
  paused_at timestamptz,
  last_undoable jsonb,
  undo_request jsonb,
  -- Auction shown for the current turn (open, or just closed). Null otherwise.
  current_auction_id uuid,
  assumptions_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((status = 'PAUSED') = (paused_at is not null))
);

-- A code identifies one live game at a time.
create unique index games_live_code_idx on public.games (code) where status in ('WAITING', 'ACTIVE', 'PAUSED');
create index games_expires_at_idx on public.games (expires_at);

-- ---------------------------------------------------------------------------
-- Players (temporary — no accounts). token_hash = sha256 of a device secret.
-- ---------------------------------------------------------------------------
create table public.players (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  seat integer not null check (seat >= 0),
  is_host boolean not null default false,
  ready boolean not null default false,
  balance bigint not null default 0 check (balance >= 0),
  position integer not null default 0 check (position >= 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'BANKRUPT')),
  skip_turns integer not null default 0 check (skip_turns >= 0),
  in_jail boolean not null default false,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  joined_at timestamptz not null default now(),
  unique (game_id, seat)
);

create unique index players_game_name_idx on public.players (game_id, lower(name));
create unique index players_one_host_idx on public.players (game_id) where is_host;

alter table public.games
  add constraint games_host_fk foreign key (host_player_id) references public.players (id) deferrable initially deferred,
  add constraint games_winner_fk foreign key (winner_player_id) references public.players (id) deferrable initially deferred,
  add constraint games_current_fk foreign key (current_player_id) references public.players (id) deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Runtime property state. Primary key guarantees at most one owner per property.
-- ---------------------------------------------------------------------------
create table public.properties (
  game_id uuid not null references public.games (id) on delete cascade,
  rules_version text not null default 'BUSINESS_V1',
  property_key text not null,
  owner_player_id uuid references public.players (id),
  houses smallint not null default 0 check (houses between 0 and 3),
  hotel boolean not null default false,
  mortgaged boolean not null default false,
  primary key (game_id, property_key),
  foreign key (rules_version, property_key) references public.board_properties (rules_version, property_key),
  check (not (hotel and houses > 0)),
  check (not (mortgaged and (hotel or houses > 0))),
  check (owner_player_id is not null or (houses = 0 and not hotel and not mortgaged))
);

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------
create table public.loans (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id),
  principal bigint not null check (principal > 0),
  interest_rate_percent numeric(6, 2) not null check (interest_rate_percent >= 0),
  total_owed bigint not null check (total_owed >= principal),
  outstanding bigint not null check (outstanding >= 0 and outstanding <= total_owed),
  status text not null check (status in ('ACTIVE', 'REPAID', 'DEFAULTED')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'REPAID') = (outstanding = 0 and closed_at is not null) or status = 'DEFAULTED')
);

create index loans_game_idx on public.loans (game_id);

-- ---------------------------------------------------------------------------
-- Auctions
-- ---------------------------------------------------------------------------
create table public.auctions (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  property_key text not null,
  status text not null check (status in ('OPEN', 'CLOSED')),
  high_bid bigint check (high_bid is null or high_bid > 0),
  high_bidder_id uuid references public.players (id),
  minimum_opening_bid bigint not null check (minimum_opening_bid > 0),
  minimum_increment bigint not null check (minimum_increment > 0),
  ends_at timestamptz not null,
  participant_ids uuid[] not null,
  passed_ids uuid[] not null default '{}',
  winner_player_id uuid references public.players (id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((high_bid is null) = (high_bidder_id is null)),
  check ((status = 'CLOSED') = (closed_at is not null))
);

-- At most one open auction per game.
alter table public.games
  add constraint games_current_auction_fk foreign key (current_auction_id) references public.auctions (id) deferrable initially deferred;

create unique index auctions_one_open_idx on public.auctions (game_id) where status = 'OPEN';

create table public.auction_bids (
  id uuid primary key,
  auction_id uuid not null references public.auctions (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id),
  amount bigint not null check (amount > 0),
  action_id uuid not null,
  created_at timestamptz not null default now(),
  -- Bids strictly increase, so two bids can never share an amount.
  unique (auction_id, amount)
);

-- ---------------------------------------------------------------------------
-- Append-only money ledger. Balance changes ONLY with a row here.
-- ---------------------------------------------------------------------------
create table public.transactions (
  id uuid primary key,
  seq bigint generated always as identity,
  game_id uuid not null references public.games (id) on delete cascade,
  action_id uuid not null,
  type text not null check (
    type in (
      'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
      'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
      'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD',
      'CARD_PAYMENT', 'CARD_REWARD', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'UNDO_REVERSAL'
    )
  ),
  from_player_id uuid references public.players (id),
  to_player_id uuid references public.players (id),
  amount bigint not null check (amount > 0),
  property_key text,
  memo text not null default '',
  reverses_transaction_id uuid references public.transactions (id),
  created_at timestamptz not null default now(),
  check (from_player_id is not null or to_player_id is not null),
  check (from_player_id is distinct from to_player_id)
);

create index transactions_game_seq_idx on public.transactions (game_id, seq);

-- ---------------------------------------------------------------------------
-- Event log (what happened, for the feed) and idempotency log.
-- ---------------------------------------------------------------------------
create table public.game_events (
  id uuid primary key,
  seq bigint generated always as identity,
  game_id uuid not null references public.games (id) on delete cascade,
  state_version integer not null,
  type text not null,
  actor_player_id uuid references public.players (id),
  message text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index game_events_game_seq_idx on public.game_events (game_id, seq);

create table public.game_actions (
  action_id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid references public.players (id),
  type text not null,
  payload jsonb not null default '{}',
  state_version_after integer not null,
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index game_actions_game_idx on public.game_actions (game_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. Deleting is only allowed while purging an expired
-- session (purge_expired_games sets app.purging for its own transaction).
-- ---------------------------------------------------------------------------
create function public.forbid_ledger_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('app.purging', true) = 'on' then
    return old;
  end if;
  raise exception '% is append-only (% not allowed)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger transactions_append_only before update or delete on public.transactions
  for each row execute function public.forbid_ledger_mutation();
create trigger auction_bids_append_only before update or delete on public.auction_bids
  for each row execute function public.forbid_ledger_mutation();
create trigger game_events_append_only before update or delete on public.game_events
  for each row execute function public.forbid_ledger_mutation();
create trigger game_actions_append_only before update or delete on public.game_actions
  for each row execute function public.forbid_ledger_mutation();

-- ---------------------------------------------------------------------------
-- Audit helper: balance must equal ledger sum for every player.
-- ---------------------------------------------------------------------------
create function public.verify_game_ledger(p_game_id uuid)
returns table (player_id uuid, balance bigint, ledger_balance bigint, ok boolean)
language sql
stable
set search_path = ''
as $$
  select p.id,
         p.balance,
         coalesce(sum(case when t.to_player_id = p.id then t.amount else 0 end), 0)
           - coalesce(sum(case when t.from_player_id = p.id then t.amount else 0 end), 0) as ledger_balance,
         p.balance = coalesce(sum(case when t.to_player_id = p.id then t.amount else 0 end), 0)
           - coalesce(sum(case when t.from_player_id = p.id then t.amount else 0 end), 0) as ok
  from public.players p
  left join public.transactions t
    on t.game_id = p.game_id and (t.from_player_id = p.id or t.to_player_id = p.id)
  where p.game_id = p_game_id
  group by p.id, p.balance;
$$;

-- Removes whole temporary sessions that expired more than a day ago.
create function public.purge_expired_games() returns integer
language plpgsql
set search_path = ''
as $$
declare
  removed integer;
begin
  perform set_config('app.purging', 'on', true);
  -- Break FK cycles from games → players before cascading.
  update public.games set host_player_id = null, winner_player_id = null, current_player_id = null
    where expires_at < now() - interval '1 day';
  delete from public.games where expires_at < now() - interval '1 day';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down: RLS on, no policies, no grants for client roles.
-- ---------------------------------------------------------------------------
alter table public.board_properties enable row level security;
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.properties enable row level security;
alter table public.loans enable row level security;
alter table public.auctions enable row level security;
alter table public.auction_bids enable row level security;
alter table public.transactions enable row level security;
alter table public.game_events enable row level security;
alter table public.game_actions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on function public.verify_game_ledger(uuid) from public, anon, authenticated;
revoke execute on function public.purge_expired_games() from public, anon, authenticated;
revoke execute on function public.forbid_ledger_mutation() from public, anon, authenticated;
