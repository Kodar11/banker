-- Voice chat (push-to-talk) for private rooms: an experiment that can be capped or switched off
-- here, without an app release. Deploy this BEFORE the voice-token function that reads it.
--
-- Security model
--   * The app never reads or writes any of this. RLS is on with no policies, every privilege is
--     revoked from anon and authenticated, and the only reader/writer is the `voice-token` Edge
--     Function (which connects as the database owner, like game-action).
--   * A room has voice only when its host turned it on (games.voice_enabled) and the host was
--     allowed to at that moment. A matchmade game can never have it: a check constraint says so,
--     whatever any function does.
--   * Nothing about what is said is stored: no audio, no transcript. What is kept is who was
--     connected to which room's voice and for how long (random game and seat ids, never names),
--     which is what the usage caps and the cost estimate need.
--   * Usage rows deliberately have NO foreign key to games/players: a game is purged a day after
--     it expires, and the month's usage must still count it.

-- ---------------------------------------------------------------------------
-- The room's capability. The server's flag, set only by the voice-token function for the host.
-- ---------------------------------------------------------------------------
alter table public.games add column voice_enabled boolean not null default false;
alter table public.games
  add constraint games_voice_private_only check (not (voice_enabled and matchmaking_match_id is not null));

-- ---------------------------------------------------------------------------
-- Settings (data: change a row without a deploy or an app release).
--   update public.voice_settings set value = 0 where key = 'voice_chat_enabled';   -- kill switch
-- ---------------------------------------------------------------------------
create table public.voice_settings (
  key text primary key,
  value integer not null check (value >= 0)
);

insert into public.voice_settings (key, value) values
  ('voice_chat_enabled', 1),              -- 0: no token is issued or renewed anywhere; connected phones leave at their next heartbeat
  ('private_voice_enabled', 1),           -- 0: the same, for private rooms (the only kind that has voice today)
  ('require_entitlement', 1),             -- 1: the host's account must be in voice_entitlements; 0: any host of a private room (testing)
  ('monthly_game_limit', 20),             -- voice-enabled games per UTC month, counted when a game's first token is issued
  ('monthly_participant_minutes', 3000),  -- safety cap on connected participant-minutes per UTC month. SET THIS from your Agora plan and pricing.
  ('per_game_minutes', 120),              -- voice time one game may use, from its first token; 0: no per-game limit
  ('token_ttl_seconds', 600),             -- life of one Agora token; also the longest a phone stays connected after a cap is hit
  ('heartbeat_seconds', 30),              -- how often a connected phone says "still here"; also how fast the kill switch reaches it
  ('stale_seconds', 90),                  -- a session silent for longer than this is closed (and stops being counted)
  ('token_rate_max', 12),                 -- tokens one seat may be issued per token_rate_window_seconds
  ('token_rate_window_seconds', 60),
  ('cost_micro_usd_per_minute', 990);     -- for the ESTIMATE in voice_usage_monthly only. Set it to your account's audio rate.

create function public.voice_setting(p_key text, p_default integer) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select s.value from public.voice_settings s where s.key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Entitlement: which accounts may host a voice room. There is no subscription system in the app
-- yet, so this table IS the entitlement source for now: a row is written by the developer (or,
-- later, by whatever verifies a purchase on the server). The app cannot write it and is never
-- asked whether it is entitled.
--   select public.voice_grant('RR-ABC234');          -- by the player's public id, no expiry
--   select public.voice_grant('RR-ABC234', 30);      -- for 30 days
--   select public.voice_revoke('RR-ABC234');
-- ---------------------------------------------------------------------------
create table public.voice_entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  note text not null default ''
);

create function public.voice_host_entitled(p_user uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.voice_entitlements e
    where e.user_id = p_user and (e.expires_at is null or e.expires_at > now())
  );
$$;

create function public.voice_grant(p_player_id text, p_days integer default null, p_note text default '') returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.profiles where player_id = public.normalize_player_id(p_player_id);
  if v_user is null then
    return false;
  end if;
  insert into public.voice_entitlements (user_id, expires_at, note)
  values (v_user, case when p_days is null then null else now() + make_interval(days => p_days) end, coalesce(p_note, ''))
  on conflict (user_id) do update set granted_at = now(), expires_at = excluded.expires_at, note = excluded.note;
  return true;
end;
$$;

create function public.voice_revoke(p_player_id text) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_removed integer;
begin
  delete from public.voice_entitlements e using public.profiles p
  where p.user_id = e.user_id and p.player_id = public.normalize_player_id(p_player_id);
  get diagnostics v_removed = row_count;
  return v_removed > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Usage. One row per game that actually used voice (the primary key is what stops a game being
-- counted twice, however many phones ask at once), and one row per stretch a seat was connected.
-- Months are UTC.
-- ---------------------------------------------------------------------------
create table public.voice_game_sessions (
  game_id uuid primary key,
  month date not null,
  started_at timestamptz not null default now()
);
create index voice_game_sessions_month_idx on public.voice_game_sessions (month);

create table public.voice_participant_sessions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null,
  player_id uuid not null,
  month date not null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  token_expires_at timestamptz not null,
  -- Tokens issued in this session: 1 for a clean one, more for renewals and reconnects.
  tokens_issued integer not null default 1 check (tokens_issued >= 1),
  -- Times the phone asked to join again while this session was still open (a reconnect).
  rejoins integer not null default 0 check (rejoins >= 0),
  ended_at timestamptz,
  end_reason text check (end_reason in ('left', 'stale', 'revoked')),
  -- Connected time, fixed when the session ends.
  seconds integer check (seconds >= 0),
  check ((ended_at is null) = (seconds is null)),
  check ((ended_at is null) = (end_reason is null))
);
-- At most one open session per seat: a reconnect continues it instead of being counted again.
create unique index voice_participant_sessions_open_idx on public.voice_participant_sessions (game_id, player_id) where ended_at is null;
create index voice_participant_sessions_month_idx on public.voice_participant_sessions (month);
create index voice_participant_sessions_seen_idx on public.voice_participant_sessions (last_seen_at) where ended_at is null;

-- Token requests per seat, for the rate limit. One row per seat, overwritten.
create table public.voice_token_rate (
  player_id uuid primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

-- ---------------------------------------------------------------------------
-- What the experiment used, per UTC month. Participant-minutes here are the app's own count of
-- connected time; `estimated_cost_usd` multiplies them by cost_micro_usd_per_minute. It is an
-- ESTIMATE: the bill is whatever Agora's console reports.
-- ---------------------------------------------------------------------------
create view public.voice_usage_monthly with (security_invoker = true) as
with p as (
  select month,
         game_id,
         player_id,
         coalesce(seconds, greatest(0, extract(epoch from (now() - joined_at)))::integer) as seconds,
         rejoins,
         end_reason
  from public.voice_participant_sessions
),
per_game as (
  select month, game_id, count(distinct player_id) as participants, sum(seconds) as seconds
  from p group by month, game_id
),
per_month as (
  select month,
         count(*) as sessions,
         sum(seconds) as seconds,
         sum(rejoins) as rejoins,
         count(*) filter (where end_reason = 'stale') as stale_sessions,
         count(*) filter (where end_reason = 'revoked') as revoked_sessions
  from p group by month
)
select g.month,
       count(*)::integer as voice_games,
       coalesce(max(m.sessions), 0)::integer as participant_sessions,
       round(coalesce(max(m.seconds), 0) / 60.0, 1) as participant_minutes,
       round(coalesce(avg(pg.seconds), 0) / 60.0, 1) as avg_participant_minutes_per_game,
       round(coalesce(avg(pg.participants), 0), 1) as avg_participants_per_game,
       coalesce(max(m.rejoins), 0)::integer as reconnects,
       coalesce(max(m.stale_sessions), 0)::integer as sessions_timed_out,
       coalesce(max(m.revoked_sessions), 0)::integer as sessions_forced_off,
       round(coalesce(max(m.seconds), 0) / 60.0 * public.voice_setting('cost_micro_usd_per_minute', 990) / 1000000.0, 2) as estimated_cost_usd
from public.voice_game_sessions g
left join per_game pg on pg.game_id = g.game_id and pg.month = g.month
left join per_month m on m.month = g.month
group by g.month;

-- ---------------------------------------------------------------------------
-- Lock down: RLS on, no policies, no grants for client roles.
-- ---------------------------------------------------------------------------
alter table public.voice_settings enable row level security;
alter table public.voice_entitlements enable row level security;
alter table public.voice_game_sessions enable row level security;
alter table public.voice_participant_sessions enable row level security;
alter table public.voice_token_rate enable row level security;

revoke all on public.voice_settings from anon, authenticated;
revoke all on public.voice_entitlements from anon, authenticated;
revoke all on public.voice_game_sessions from anon, authenticated;
revoke all on public.voice_participant_sessions from anon, authenticated;
revoke all on public.voice_token_rate from anon, authenticated;
revoke all on public.voice_usage_monthly from anon, authenticated;

revoke execute on function public.voice_setting(text, integer) from public, anon, authenticated;
revoke execute on function public.voice_host_entitled(uuid) from public, anon, authenticated;
revoke execute on function public.voice_grant(text, integer, text) from public, anon, authenticated;
revoke execute on function public.voice_revoke(text) from public, anon, authenticated;
