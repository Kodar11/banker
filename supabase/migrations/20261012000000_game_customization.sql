-- Game customization: host settings per game, and Intermediate Mode's secret objectives.
--
-- Additive only. Every existing game keeps working unchanged:
--   * config stays null for games created before this migration (and by an older app that sends
--     none). The engine reads a null config as the rules exactly as they were: ₹25,000 starting
--     cash, ₹20,000 loan limit, the Balanced market, no secret objectives.
--   * player_objectives has no rows for a Classic game, or for a game whose host disabled objectives.
-- Deploy this BEFORE the game-action function that reads and writes these columns.

-- ---------------------------------------------------------------------------
-- The host's settings. Shape: engine GameConfig (src/engine/gameConfig.ts), validated and
-- normalised by the game-action function before it is written. Written when the game is created
-- and by the host's UPDATE_CONFIG while the game is in the lobby; never afterwards.
-- ---------------------------------------------------------------------------
alter table public.games
  add column config jsonb check (config is null or jsonb_typeof(config) = 'object');

-- Locked at the start: once a game has left the lobby its settings can't change, whoever asks.
-- (The engine already refuses; this holds even if a bug or a direct write got past it.)
create function public.forbid_config_change_after_start() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'WAITING' and new.config is distinct from old.config then
    raise exception 'config is locked once the game has started (game %)', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger games_config_locked before update on public.games
  for each row execute function public.forbid_config_change_after_start();

revoke execute on function public.forbid_config_change_after_start() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trades that count towards the Deal Maker objective (completed player-to-player property trades;
-- an undone trade is removed again). Public information: every trade is announced to the table.
-- Shape: engine ObjectiveTrade[]. Written under the game row lock with the action that changed it.
-- ---------------------------------------------------------------------------
alter table public.games
  add column objective_trades jsonb not null default '[]'::jsonb check (jsonb_typeof(objective_trades) = 'array');

-- ---------------------------------------------------------------------------
-- Secret objectives: one private row per player, dealt when an Intermediate game starts.
--
-- Privacy: like every table here, RLS is on with no policies and nothing is granted to the client
-- roles, so the app cannot query it. Rows reach a device only through the game-action function,
-- which sends each player their own objective and nothing else until the game has finished.
--
-- Exactly once: the primary key allows one objective per player per game; the guard below makes
-- the assignment immutable and lets a result be written a single time.
-- ---------------------------------------------------------------------------
create table public.player_objectives (
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id),
  objective_id text not null check (objective_id in ('PROPERTY_MOGUL', 'BUILDER', 'CASH_GUARDIAN', 'DEAL_MAKER')),
  assigned_at timestamptz not null default now(),
  -- The result. All null until the game finishes; then set together, once.
  completed boolean,
  reward bigint check (reward is null or reward >= 0),
  detail text,
  result_order integer,
  evaluated_at timestamptz,
  primary key (game_id, player_id),
  check ((evaluated_at is null) = (completed is null)),
  check ((evaluated_at is null) = (reward is null)),
  check ((evaluated_at is null) = (detail is null)),
  -- A bonus is only ever paid for a completed objective.
  check (reward is null or reward = 0 or completed)
);

create function public.guard_player_objective() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purging', true) = 'on' then
      return old;
    end if;
    raise exception 'player_objectives rows are permanent' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if (select g.game_mode from public.games g where g.id = new.game_id) is distinct from 'intermediate' then
      raise exception 'secret objectives exist only in Intermediate Mode' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.players p where p.id = new.player_id and p.game_id = new.game_id) then
      raise exception 'player % is not in game %', new.player_id, new.game_id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: the assignment never changes, and a result is written once.
  if new.game_id <> old.game_id or new.player_id <> old.player_id or new.objective_id <> old.objective_id
     or new.assigned_at <> old.assigned_at then
    raise exception 'a secret objective cannot be changed' using errcode = 'check_violation';
  end if;
  if old.evaluated_at is not null then
    raise exception 'objective result for player % is already final', old.player_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger player_objectives_guard before insert or update or delete on public.player_objectives
  for each row execute function public.guard_player_objective();

alter table public.player_objectives enable row level security;
revoke all on public.player_objectives from anon, authenticated;
revoke execute on function public.guard_player_objective() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ledger: the secret-objective bonus is its own transaction type, so it is never mixed up with
-- ordinary game money. Every existing type is kept.
-- ---------------------------------------------------------------------------
alter table public.transactions drop constraint transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'STARTING_FUNDS', 'PROPERTY_PURCHASE', 'RENT_PAYMENT', 'PLAYER_TRANSFER', 'TAX_PAYMENT',
    'HOUSE_PURCHASE', 'HOUSE_SALE', 'HOTEL_PURCHASE', 'HOTEL_SALE', 'PROPERTY_SALE',
    'AUCTION_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'START_REWARD', 'LOAN_INTEREST',
    'CARD_PAYMENT', 'CARD_REWARD', 'CARD_COLLECTION', 'CLUB_PAYMENT', 'REST_HOUSE_COLLECTION', 'JAIL_FINE',
    'TRADE_PAYMENT', 'MORTGAGE', 'UNMORTGAGE', 'BANKRUPTCY_SETTLEMENT', 'COLLATERAL_SURPLUS', 'OBJECTIVE_REWARD',
    'UNDO_REVERSAL'
  )
);

-- A player is paid the bonus at most once per game, whatever is retried.
create unique index transactions_one_objective_reward_idx
  on public.transactions (game_id, to_player_id) where type = 'OBJECTIVE_REWARD';
