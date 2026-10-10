-- Property insurance and global crises (Intermediate Mode only).
--
-- Additive only. Every existing game keeps working unchanged:
--   * a Classic game never has a row in either table below (the insert guard refuses one);
--   * an Intermediate game that started before this migration has no `insurance` in its economy
--     document, so the engine runs it without premiums, crises or new restrictions.
-- Deploy this BEFORE the game-action function that writes these tables.
--
-- Where the state lives: the engine reads and writes insurance inside the game's economy document
-- (games.intermediate → insurance, shape: engine InsuranceState), under the game row lock, in the
-- same transaction as the cash movement, the events and the version bump of the action that changed
-- it — exactly like Intermediate loans. The two tables here are written from that document in that
-- same transaction. They are the durable, queryable record of every policy and every crisis, and
-- they add guarantees the database itself enforces, whatever a retry, a race or a bug attempts:
--   * one crisis per checkpoint per game            (crisis_events: unique (game_id, checkpoint));
--   * one active policy per property and owner      (insurance_policies_one_active_idx);
--   * a settled crisis and a closed policy are final (the guards below).
-- A violation aborts the whole action: no partial deduction, no orphaned policy, no second bill.
--
-- Clock columns are points on the game's shared movement counter (the sum of every starting
-- player's dice movement — the counter the financial year already runs on).

-- ---------------------------------------------------------------------------
-- Ledger: the premium and the crisis bill are their own transaction types, so they are never
-- mixed up with rent, tax or loan money. Every existing type is kept.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'REST_HOUSE_COLLECTION', 'JAIL_FINE',
    'TRADE_PAYMENT', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'COLLATERAL_SURPLUS', 'OBJECTIVE_REWARD',
    'INSURANCE_PREMIUM', 'CRISIS_PAYMENT', 'UNDO_REVERSAL'
  )
);

-- ---------------------------------------------------------------------------
-- Policies: one row per purchase. Price, term and status are the server's; a policy is bought
-- ACTIVE and ends exactly once, as CLAIMED (it waived one crisis bill) or EXPIRED (its term ran out).
-- ---------------------------------------------------------------------------
create table public.insurance_policies (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  property_key text not null,
  owner_player_id uuid not null references public.players (id),
  purchase_year integer not null check (purchase_year >= 1),
  premium_paid bigint not null check (premium_paid > 0),
  start_clock integer not null check (start_clock >= 0),
  expiry_clock integer not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLAIMED', 'EXPIRED')),
  -- The crisis this policy was used on (crisis_events.id). Not a foreign key: the crisis row
  -- references the policy, and the two are written together.
  claimed_crisis_id uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (game_id, property_key) references public.properties (game_id, property_key) on delete cascade,
  check (expiry_clock > start_clock),
  check ((status = 'CLAIMED') = (claimed_crisis_id is not null)),
  check ((status = 'ACTIVE') = (closed_at is null))
);

create index insurance_policies_game_idx on public.insurance_policies (game_id);
-- A player holds at most one running policy on a property.
create unique index insurance_policies_one_active_idx
  on public.insurance_policies (game_id, property_key, owner_player_id) where status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Crises: one row per checkpoint of a game's schedule, including the ones that were skipped
-- because nobody owned a property. The selected property, its owner at that moment and the
-- outcome are fixed when the row is written; only a PENDING bill can still change, once.
-- ---------------------------------------------------------------------------
create table public.crisis_events (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  checkpoint integer not null check (checkpoint >= 1),
  checkpoint_clock integer not null check (checkpoint_clock > 0),
  financial_year integer not null check (financial_year >= 1),
  property_key text,
  owner_player_id uuid references public.players (id),
  mortgaged boolean not null default false,
  amount bigint not null check (amount >= 0),
  paid bigint not null default 0 check (paid >= 0),
  policy_id uuid references public.insurance_policies (id) on delete cascade,
  status text not null check (status in ('SKIPPED', 'COVERED', 'PENDING', 'PAID', 'BANKRUPT', 'UNPAID')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- THE exactly-once guarantee: a checkpoint of a game is resolved a single time.
  constraint crisis_events_one_per_checkpoint unique (game_id, checkpoint),
  foreign key (game_id, property_key) references public.properties (game_id, property_key) on delete cascade,
  check (paid <= amount),
  check ((status = 'SKIPPED') = (property_key is null)),
  check ((property_key is null) = (owner_player_id is null)),
  check ((status = 'COVERED') = (policy_id is not null)),
  check ((status = 'PENDING') = (settled_at is null)),
  check (status <> 'SKIPPED' or amount = 0),
  check (status not in ('COVERED', 'PENDING') or paid = 0),
  check (status <> 'PAID' or paid = amount),
  check (status <> 'UNPAID' or paid < amount)
);

create index crisis_events_game_idx on public.crisis_events (game_id);
-- The open bill(s) of a game, found without scanning its history.
create index crisis_events_pending_idx on public.crisis_events (game_id) where status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Guards. Rows are permanent (removed only when an expired game is purged), exist only in an
-- Intermediate game, name a player of that game, and never change once they are final.
-- ---------------------------------------------------------------------------
create function public.guard_insurance_policy() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purging', true) = 'on' then
      return old;
    end if;
    raise exception 'insurance_policies rows are permanent' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if (select g.game_mode from public.games g where g.id = new.game_id) is distinct from 'intermediate' then
      raise exception 'property insurance exists only in Intermediate Mode' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.players p where p.id = new.owner_player_id and p.game_id = new.game_id) then
      raise exception 'player % is not in game %', new.owner_player_id, new.game_id using errcode = 'check_violation';
    end if;
    if new.status <> 'ACTIVE' then
      raise exception 'a policy is bought active' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: what was bought never changes, and a policy ends once.
  if new.game_id <> old.game_id or new.property_key <> old.property_key or new.owner_player_id <> old.owner_player_id
     or new.purchase_year <> old.purchase_year or new.premium_paid <> old.premium_paid
     or new.start_clock <> old.start_clock or new.expiry_clock <> old.expiry_clock or new.created_at <> old.created_at then
    raise exception 'an insurance policy cannot be changed' using errcode = 'check_violation';
  end if;
  if old.status <> 'ACTIVE' then
    raise exception 'policy % is already %', old.id, lower(old.status) using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger insurance_policies_guard before insert or update or delete on public.insurance_policies
  for each row execute function public.guard_insurance_policy();

create function public.guard_crisis_event() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purging', true) = 'on' then
      return old;
    end if;
    raise exception 'crisis_events rows are permanent' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if (select g.game_mode from public.games g where g.id = new.game_id) is distinct from 'intermediate' then
      raise exception 'crises exist only in Intermediate Mode' using errcode = 'check_violation';
    end if;
    if new.owner_player_id is not null
       and not exists (select 1 from public.players p where p.id = new.owner_player_id and p.game_id = new.game_id) then
      raise exception 'player % is not in game %', new.owner_player_id, new.game_id using errcode = 'check_violation';
    end if;
    if new.policy_id is not null
       and not exists (select 1 from public.insurance_policies i where i.id = new.policy_id and i.game_id = new.game_id) then
      raise exception 'policy % is not in game %', new.policy_id, new.game_id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: the selection and its outcome are fixed; only an open bill can be closed, and only once.
  if new.game_id <> old.game_id or new.checkpoint <> old.checkpoint or new.checkpoint_clock <> old.checkpoint_clock
     or new.financial_year <> old.financial_year or new.property_key is distinct from old.property_key
     or new.owner_player_id is distinct from old.owner_player_id or new.mortgaged <> old.mortgaged
     or new.amount <> old.amount or new.policy_id is distinct from old.policy_id or new.created_at <> old.created_at then
    raise exception 'a crisis cannot be changed' using errcode = 'check_violation';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'crisis % is already %', old.id, lower(old.status) using errcode = 'check_violation';
  end if;
  if new.status = 'COVERED' or new.status = 'SKIPPED' then
    raise exception 'a pending crisis bill can only be settled' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger crisis_events_guard before insert or update or delete on public.crisis_events
  for each row execute function public.guard_crisis_event();

-- ---------------------------------------------------------------------------
-- Lock down, like every table here: RLS on with no policies and nothing granted to the client
-- roles. The app reads insurance only through the game-action function, as part of its game's
-- snapshot, after that function has checked the device belongs to the game.
-- ---------------------------------------------------------------------------
alter table public.insurance_policies enable row level security;
alter table public.crisis_events enable row level security;
revoke all on public.insurance_policies from anon, authenticated;
revoke all on public.crisis_events from anon, authenticated;
revoke execute on function public.guard_insurance_policy() from public, anon, authenticated;
revoke execute on function public.guard_crisis_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- To reverse this migration (only once no game holds an INSURANCE_PREMIUM or CRISIS_PAYMENT
-- transaction — the ledger is append-only, so those rows would have to age out first):
--
--   drop table public.crisis_events;
--   drop table public.insurance_policies;
--   drop function public.guard_crisis_event();
--   drop function public.guard_insurance_policy();
--   alter table public.transactions drop constraint transactions_type_check;
--   alter table public.transactions add constraint transactions_type_check check (type in ( …the list in
--     20261012000000_game_customization.sql… ));
-- ---------------------------------------------------------------------------
