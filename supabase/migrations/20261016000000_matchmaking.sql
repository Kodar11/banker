-- Random matchmaking: parties, queue tickets, match reservations, ready-up and recovery.
--
-- Additive only. Every existing game, lobby, friendship and invitation keeps working unchanged:
--   * games.matchmaking_match_id stays null for every game a host created.
--   * Nothing here is read by an app that predates it; such an app simply has no Play Online.
-- Deploy this BEFORE the `matchmaking` Edge Function (the worker) and before the app that uses it.
--
-- Who owns which fact (one writer each; nothing is stored twice):
--   * party_members            who is in a party, and who has confirmed they are ready to queue
--   * matchmaking_tickets      one queue entry: a solo player or one whole party; its state
--   * matchmaking_ticket_members  who a ticket stands for (the snapshot taken when queueing began)
--   * matchmaking_matches      one reservation: the tickets grouped into a match, the ready-up
--                              deadline, and the game it became
--   * matchmaking_match_players   each player's place in a reservation, their ready confirmation and
--                              the hash of the device token that will hold their seat
--   * games / players          the game itself, created by the game engine exactly as a hosted game
--
-- State machines (enforced by the guard triggers below; the app can change none of them directly)
--   ticket  QUEUED -> RESERVED -> MATCHED
--           QUEUED -> CANCELLED | EXPIRED | FAILED
--           RESERVED -> QUEUED            (the reservation fell through and this ticket was not at fault)
--           RESERVED -> CANCELLED | FAILED
--   match   READY_UP -> STARTING -> STARTED
--           READY_UP -> CANCELLED         (someone did not confirm, declined, or left)
--           STARTING -> FAILED | CANCELLED (the game could not be created; everyone is queued again)
--   A ticket is RESERVED exactly while its match is READY_UP or STARTING: reserving the players and
--   opening the ready-up countdown are one commit, so there is no state in between to get stuck in.
--
-- Security model (the same as profiles and friends)
--   * RLS is on for every table here and nothing is granted to the client roles, with ONE
--     exception: a player may SELECT their own matchmaking_sync row (a version counter with no
--     content), which is what Realtime delivers to say "something of yours changed - refetch".
--   * Every read and write a player can make is a SECURITY DEFINER function that acts on
--     auth.uid() and never takes a user id from the caller. Other players are named only by their
--     public Player ID. Grouping, reserving, starting and recovering are done by functions only the
--     server (the worker and pg_cron) can call.
--
-- Lock order (every path takes them in this order, so two requests cannot wait on each other):
--   party row -> match row -> ticket rows -> party_members rows -> ticket_members rows -> change
--   counters (always last, at commit, sorted: see matchmaking_touch). The matcher is the one path
--   that holds ticket locks first; it never waits for a match row, because it only inserts new ones.
--   The one narrow exception is a player leaving at the very instant their ticket is being
--   reserved: Postgres detects that wait and fails one of the two requests, which is retried.

-- ---------------------------------------------------------------------------
-- Settings (data: change a row without a deploy or an app release). The app cannot read them
-- directly; matchmaking_state() hands it the few it needs to draw a countdown.
-- ---------------------------------------------------------------------------
create table public.matchmaking_settings (
  key text primary key,
  value integer not null check (value >= 0)
);

insert into public.matchmaking_settings (key, value) values
  ('enabled', 1),                      -- 0 closes the queue to new entries (maintenance)
  ('target_players', 4),               -- the match size that is preferred
  ('min_players', 2),
  ('max_players', 8),                  -- never above the engine's table size (8)
  ('prefer_target_seconds', 30),       -- until the oldest entry has waited this long: only the preferred size
  ('relax_seconds', 60),               -- after this: the best valid grouping; a big party may start alone
  ('party_alone_min_players', 4),      -- the smallest party that may start by itself after relax_seconds
  ('ready_seconds', 20),               -- ready-up countdown
  ('start_grace_seconds', 30),         -- how long game creation may take before everyone is queued again
  ('reconnect_grace_seconds', 30),     -- a queued player silent for longer than this is taken out
  ('heartbeat_seconds', 10),           -- how often the app says "still here" while searching
  ('party_max_members', 8),
  ('party_invite_ttl_seconds', 900),
  ('party_leader_grace_seconds', 120), -- a leader silent this long hands the party to an online member
  ('party_idle_seconds', 1800),        -- a party nobody has looked at for this long is dissolved
  ('ready_cooldown_seconds', 30),      -- first missed ready-up; doubles with each one inside the window
  ('ready_cooldown_max_seconds', 300),
  ('ready_strike_window_seconds', 900),
  ('batch_size', 64),                  -- tickets one matching run looks at, per mode
  ('window_size', 10),                 -- tickets grouped together at a time (bounds the search)
  ('max_matches_per_run', 16),
  ('max_starts_per_run', 16),
  ('min_run_interval_ms', 1000),       -- matching runs at most this often per mode, whoever asks
  ('client_tick', 1);                  -- 1: a searching app may nudge the worker; 0: scheduler only

create function public.matchmaking_setting(p_key text, p_default integer) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select s.value from public.matchmaking_settings s where s.key = p_key), p_default);
$$;

-- Invitations to a party are limited like invitations to a game (public.social_limits).
insert into public.social_limits (key, max_count, window_seconds) values
  ('party_invite', 30, 600),
  ('party_invite_pair', 5, 600)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The change counter (same idea as social_sync): one row per player, bumped whenever anything
-- that player can see here changes. Realtime sends the new version; the app refetches
-- matchmaking_state() when it is behind. A duplicate, late or missing event can show nothing wrong.
-- ---------------------------------------------------------------------------
create table public.matchmaking_sync (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- Bumping a counter locks its row, and one transaction here can concern many players in several
-- steps (a reservation, a cancelled match, a party change). So nothing bumps a counter directly:
-- matchmaking_touch() only notes WHO must be told, and the notes of a transaction are turned into
-- bumps once, at its commit, in one statement, in user-id order. Counter rows are therefore always
-- the last locks a transaction takes and always taken in the same order: two transactions that
-- concern the same players can never wait on each other over them.
create table public.matchmaking_touch_queue (
  id bigint generated always as identity primary key,
  xid xid8 not null default pg_current_xact_id(),
  user_id uuid not null
);

create index matchmaking_touch_queue_xid_idx on public.matchmaking_touch_queue (xid);

create function public.matchmaking_touch(p_users uuid[]) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.matchmaking_touch_queue (user_id)
  select distinct u from unnest(p_users) as u where u is not null;
$$;

-- Runs at commit (deferred), once per noted row; the first run does the whole transaction's work
-- and the others find nothing left. Only players who still have a profile get a counter.
create function public.matchmaking_touch_flush() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  with mine as (
    delete from public.matchmaking_touch_queue q where q.xid = pg_current_xact_id() returning q.user_id
  )
  insert into public.matchmaking_sync (user_id)
  select p.user_id from public.profiles p where p.user_id in (select m.user_id from mine m) order by p.user_id
  on conflict (user_id) do update set version = public.matchmaking_sync.version + 1, updated_at = now();
  return null;
end;
$$;

create constraint trigger matchmaking_touch_flush after insert on public.matchmaking_touch_queue
  deferrable initially deferred
  for each row execute function public.matchmaking_touch_flush();

-- ---------------------------------------------------------------------------
-- Structured log: every state change of a ticket or a match (written by the triggers below), and
-- one row per worker run. No nickname, email or token is ever written here.
-- ---------------------------------------------------------------------------
create table public.matchmaking_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  entity text not null check (entity in ('ticket', 'match', 'party', 'run')),
  entity_id uuid,
  mode text,
  from_status text,
  to_status text,
  reason text,
  detail jsonb not null default '{}'::jsonb
);

create index matchmaking_events_at_idx on public.matchmaking_events (at);
create index matchmaking_events_entity_idx on public.matchmaking_events (entity, entity_id);

create table public.matchmaking_runs (
  mode text primary key check (mode in ('classic', 'intermediate')),
  last_run_at timestamptz,
  runs bigint not null default 0
);

insert into public.matchmaking_runs (mode) values ('classic'), ('intermediate');

-- ---------------------------------------------------------------------------
-- Parties. A party is a group of friends who queue together. It is NOT a game and NOT a private
-- lobby: joining one starts nothing. The primary key of party_members is the player, so a player
-- can be in one party at a time, however two acceptances race.
-- A party is "locked" exactly while it has a ticket that is QUEUED or RESERVED (derived, never stored).
-- ---------------------------------------------------------------------------
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  -- null only for an instant while the leader's account is being deleted (see party_member_removed).
  leader_user_id uuid references public.profiles (user_id) on delete set null,
  mode text not null default 'classic' check (mode in ('classic', 'intermediate')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.party_members (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  party_id uuid not null references public.parties (id) on delete cascade,
  -- "I am ready to queue in this party, with these players, in this mode." Cleared whenever any of
  -- the three changes. The leader's readiness is their pressing Start.
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index party_members_party_idx on public.party_members (party_id, joined_at);

create table public.party_invitations (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties (id) on delete cascade,
  inviter_user_id uuid not null references public.profiles (user_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint party_invitations_not_self check (inviter_user_id <> recipient_user_id)
);

-- A retry never creates a second live invitation of the same player to the same party.
create unique index party_invitations_live_idx on public.party_invitations (party_id, recipient_user_id) where status = 'pending';
create index party_invitations_recipient_idx on public.party_invitations (recipient_user_id) where status = 'pending';
create index party_invitations_expiry_idx on public.party_invitations (expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Reservations.
-- ---------------------------------------------------------------------------
create table public.matchmaking_matches (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('classic', 'intermediate')),
  status text not null default 'READY_UP' check (status in ('READY_UP', 'STARTING', 'STARTED', 'CANCELLED', 'FAILED')),
  player_count integer not null check (player_count between 2 and 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set by the server when the reservation is made. The app only draws it.
  ready_deadline timestamptz not null,
  all_ready_at timestamptz,
  start_deadline timestamptz,
  started_at timestamptz,
  -- One game per reservation, ever (and games.matchmaking_match_id below says the same from the other side).
  game_id uuid unique references public.games (id) on delete set null,
  start_attempts integer not null default 0,
  last_error text,
  closed_at timestamptz,
  close_reason text,
  check ((status = 'STARTING') <= (all_ready_at is not null and start_deadline is not null)),
  check ((status in ('CANCELLED', 'FAILED')) = (closed_at is not null))
);

create index matchmaking_matches_ready_idx on public.matchmaking_matches (ready_deadline) where status = 'READY_UP';
create index matchmaking_matches_starting_idx on public.matchmaking_matches (all_ready_at) where status = 'STARTING';
create index matchmaking_matches_closed_idx on public.matchmaking_matches (updated_at) where status in ('STARTED', 'CANCELLED', 'FAILED');

alter table public.games add column matchmaking_match_id uuid references public.matchmaking_matches (id) on delete set null;
create unique index games_matchmaking_match_idx on public.games (matchmaking_match_id) where matchmaking_match_id is not null;

-- ---------------------------------------------------------------------------
-- Queue tickets.
-- ---------------------------------------------------------------------------
create table public.matchmaking_tickets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('solo', 'party')),
  -- Who asked: the solo player, or the party's leader at the time. Informational once queued.
  owner_user_id uuid references public.profiles (user_id) on delete set null,
  party_id uuid references public.parties (id) on delete set null,
  mode text not null check (mode in ('classic', 'intermediate')),
  player_count integer not null check (player_count between 1 and 8),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RESERVED', 'MATCHED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  match_id uuid references public.matchmaking_matches (id) on delete set null,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 64),
  -- The waiting-time reference. Kept when a ticket returns to the queue after a failed ready-up.
  queued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  requeue_count integer not null default 0,
  check ((status in ('QUEUED', 'RESERVED')) = (closed_at is null)),
  check (status <> 'RESERVED' or match_id is not null),
  check (kind = 'party' or player_count = 1)
);

-- The matcher's query: one mode, oldest first.
create index matchmaking_tickets_queue_idx on public.matchmaking_tickets (mode, queued_at, id) where status = 'QUEUED';
create index matchmaking_tickets_match_idx on public.matchmaking_tickets (match_id) where match_id is not null;
-- A party is queued at most once.
create unique index matchmaking_tickets_party_idx on public.matchmaking_tickets (party_id) where status in ('QUEUED', 'RESERVED') and party_id is not null;
-- The same request sent twice is the same ticket.
create unique index matchmaking_tickets_idempotency_idx on public.matchmaking_tickets (owner_user_id, idempotency_key) where idempotency_key is not null;
create index matchmaking_tickets_closed_idx on public.matchmaking_tickets (closed_at) where closed_at is not null;

create table public.matchmaking_ticket_members (
  ticket_id uuid not null references public.matchmaking_tickets (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  -- Order inside the ticket (the party's joining order).
  position integer not null default 0,
  -- True exactly while the ticket is QUEUED or RESERVED. Written only by the ticket trigger.
  active boolean not null default true,
  -- The last time this player's app said it was still there.
  last_seen_at timestamptz not null default now(),
  primary key (ticket_id, user_id)
);

-- THE guarantee: a player stands in at most one live ticket, alone or as part of a party,
-- whichever request, device or worker tries to add another.
create unique index matchmaking_ticket_members_active_idx on public.matchmaking_ticket_members (user_id) where active;
create index matchmaking_ticket_members_user_idx on public.matchmaking_ticket_members (user_id, ticket_id);
create index matchmaking_ticket_members_seen_idx on public.matchmaking_ticket_members (last_seen_at) where active;

create table public.matchmaking_match_players (
  match_id uuid not null references public.matchmaking_matches (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  ticket_id uuid not null references public.matchmaking_tickets (id) on delete cascade,
  -- Assignment order in the reservation. (The game draws its turn order when it starts, as always.)
  seat integer not null check (seat between 0 and 7),
  ready_at timestamptz,
  -- SHA-256 of the device token that will hold this seat, given with the ready confirmation.
  token_hash text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  -- The seat in the game, once the game exists.
  game_player_id uuid,
  -- True while the reservation is READY_UP or STARTING. Written only by the match trigger.
  active boolean not null default true,
  primary key (match_id, user_id),
  unique (match_id, seat),
  check ((ready_at is null) = (token_hash is null))
);

-- A player is reserved in at most one match.
create unique index matchmaking_match_players_active_idx on public.matchmaking_match_players (user_id) where active;
create index matchmaking_match_players_user_idx on public.matchmaking_match_players (user_id, match_id);
create index matchmaking_match_players_ticket_idx on public.matchmaking_match_players (ticket_id);

-- A short pause after not confirming a match (never a ban): doubles with each miss inside the window.
create table public.matchmaking_cooldowns (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  strikes integer not null default 0,
  last_strike_at timestamptz,
  blocked_until timestamptz
);

-- ---------------------------------------------------------------------------
-- Guards: the state machines, held by the database whoever writes.
-- ---------------------------------------------------------------------------
create function public.matchmaking_ticket_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode or new.kind is distinct from old.kind or new.queued_at is distinct from old.queued_at then
    raise exception 'a queue ticket''s mode, kind and queue time are fixed (ticket %)', old.id using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'QUEUED' and new.status in ('RESERVED', 'CANCELLED', 'EXPIRED', 'FAILED'))
      or (old.status = 'RESERVED' and new.status in ('QUEUED', 'MATCHED', 'CANCELLED', 'FAILED'))
    ) then
      raise exception 'queue ticket % cannot go from % to %', old.id, old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'QUEUED' then
      new.match_id := null;
    elsif new.status <> 'RESERVED' then
      new.closed_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger matchmaking_tickets_guard before update on public.matchmaking_tickets
  for each row execute function public.matchmaking_ticket_guard();

create function public.matchmaking_ticket_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return null;
    end if;
    v_from := old.status;
  end if;
  insert into public.matchmaking_events (entity, entity_id, mode, from_status, to_status, reason, detail)
  values ('ticket', new.id, new.mode, v_from, new.status, new.close_reason,
          jsonb_build_object('players', new.player_count, 'kind', new.kind, 'match_id', new.match_id,
                             'waited_ms', floor(extract(epoch from (clock_timestamp() - new.queued_at)) * 1000)));
  if tg_op = 'UPDATE' then
    -- (party_members before ticket_members, as everywhere: see "Lock order" at the top.)
    -- The next queue needs a fresh "ready" from every member, unless the leader merely stopped the search.
    if new.status not in ('QUEUED', 'RESERVED') and new.party_id is not null
       and not (new.status = 'CANCELLED' and new.close_reason = 'CANCELLED_BY_PLAYER') then
      update public.party_members pm set ready = false where pm.party_id = new.party_id and pm.ready;
    end if;
    update public.matchmaking_ticket_members m set active = new.status in ('QUEUED', 'RESERVED')
    where m.ticket_id = new.id and m.active is distinct from (new.status in ('QUEUED', 'RESERVED'));
    perform public.matchmaking_touch(array(select m.user_id from public.matchmaking_ticket_members m where m.ticket_id = new.id));
  end if;
  return null;
end;
$$;

create trigger matchmaking_tickets_changed after insert or update on public.matchmaking_tickets
  for each row execute function public.matchmaking_ticket_changed();

create function public.matchmaking_match_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode or new.player_count is distinct from old.player_count
     or new.ready_deadline is distinct from old.ready_deadline then
    raise exception 'a reservation''s mode, size and deadline are fixed (match %)', old.id using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'READY_UP' and new.status in ('STARTING', 'CANCELLED'))
      or (old.status = 'STARTING' and new.status in ('STARTED', 'CANCELLED', 'FAILED'))
    ) then
      raise exception 'match % cannot go from % to %', old.id, old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status in ('CANCELLED', 'FAILED') then
      new.closed_at := now();
    elsif new.status = 'STARTED' then
      new.started_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger matchmaking_matches_guard before update on public.matchmaking_matches
  for each row execute function public.matchmaking_match_guard();

create function public.matchmaking_match_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return null;
    end if;
    v_from := old.status;
  end if;
  insert into public.matchmaking_events (entity, entity_id, mode, from_status, to_status, reason, detail)
  values ('match', new.id, new.mode, v_from, new.status, new.close_reason,
          jsonb_build_object('players', new.player_count, 'game_id', new.game_id, 'attempts', new.start_attempts,
                             'age_ms', floor(extract(epoch from (clock_timestamp() - new.created_at)) * 1000)));
  if tg_op = 'UPDATE' then
    if new.status in ('STARTED', 'CANCELLED', 'FAILED') then
      update public.matchmaking_match_players p set active = false where p.match_id = new.id and p.active;
    end if;
    perform public.matchmaking_touch(array(select p.user_id from public.matchmaking_match_players p where p.match_id = new.id));
  end if;
  return null;
end;
$$;

create trigger matchmaking_matches_changed after insert or update on public.matchmaking_matches
  for each row execute function public.matchmaking_match_changed();

create function public.matchmaking_set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger parties_updated before update on public.parties
  for each row execute function public.matchmaking_set_updated_at();
create trigger party_invitations_updated before update on public.party_invitations
  for each row execute function public.matchmaking_set_updated_at();

-- ---------------------------------------------------------------------------
-- Internal helpers (never callable by the app)
-- ---------------------------------------------------------------------------
create function public.matchmaking_fail(p_code text, p_retry integer default null) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_retry is null then jsonb_build_object('ok', false, 'code', p_code)
              else jsonb_build_object('ok', false, 'code', p_code, 'retry_after_seconds', p_retry) end;
$$;

-- One account's queueing and party-joining requests run one after the other (two phones, a double tap).
create function public.matchmaking_lock_user(p_user uuid) returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('matchmaking-user:' || p_user::text, 0));
$$;

-- The live game this account is still playing in, if any (a seat it has claimed and not left or lost).
create function public.matchmaking_live_game(p_user uuid) returns uuid
language sql
stable
set search_path = ''
as $$
  select g.id
  from public.players p
  join public.games g on g.id = p.game_id
  where p.user_id = p_user and p.status = 'ACTIVE'
    and g.status in ('WAITING', 'ACTIVE', 'PAUSED') and g.expires_at > now()
  order by g.updated_at desc
  limit 1;
$$;

create function public.matchmaking_active_ticket(p_user uuid) returns uuid
language sql
stable
set search_path = ''
as $$
  select m.ticket_id from public.matchmaking_ticket_members m where m.user_id = p_user and m.active;
$$;

-- The ticket that locks a party (QUEUED or RESERVED), if it has one.
create function public.matchmaking_party_ticket(p_party uuid) returns uuid
language sql
stable
set search_path = ''
as $$
  select t.id from public.matchmaking_tickets t where t.party_id = p_party and t.status in ('QUEUED', 'RESERVED');
$$;

-- Seconds a player must still wait after missed ready-ups; 0 when free to queue.
create function public.matchmaking_cooldown_left(p_user uuid) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select greatest(0, ceil(extract(epoch from (c.blocked_until - now()))))::integer
    from public.matchmaking_cooldowns c where c.user_id = p_user and c.blocked_until > now()
  ), 0);
$$;

create function public.matchmaking_strike(p_user uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_base integer := public.matchmaking_setting('ready_cooldown_seconds', 30);
  v_max integer := public.matchmaking_setting('ready_cooldown_max_seconds', 300);
  v_window integer := public.matchmaking_setting('ready_strike_window_seconds', 900);
begin
  if v_base = 0 or not exists (select 1 from public.profiles p where p.user_id = p_user) then
    return;
  end if;
  insert into public.matchmaking_cooldowns as c (user_id, strikes, last_strike_at, blocked_until)
  values (p_user, 1, now(), now() + make_interval(secs => least(v_base, v_max)))
  on conflict (user_id) do update set
    strikes = case when c.last_strike_at is null or c.last_strike_at < now() - make_interval(secs => v_window) then 1 else c.strikes + 1 end,
    last_strike_at = now(),
    blocked_until = now() + make_interval(secs => least(
      v_max,
      v_base * power(2, least(10, case when c.last_strike_at is null or c.last_strike_at < now() - make_interval(secs => v_window) then 0 else c.strikes end))
    ));
end;
$$;

create function public.matchmaking_touch_party(p_party uuid) returns void
language sql
security definer
set search_path = ''
as $$
  select public.matchmaking_touch(array(
    select m.user_id from public.party_members m where m.party_id = p_party
    union
    select i.recipient_user_id from public.party_invitations i where i.party_id = p_party and i.status = 'pending'
  ));
$$;

-- Ends a reservation that will not become a game. The caller holds the match row lock.
-- Tickets with a player named in p_offenders leave the queue; every other ticket goes back into
-- it, whole, with the waiting time it already had.
create function public.matchmaking_cancel_match(p_match uuid, p_status text, p_reason text, p_offenders uuid[]) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  t record;
begin
  update public.matchmaking_matches set status = p_status, close_reason = p_reason
  where id = p_match and status in ('READY_UP', 'STARTING');
  if not found then
    return false;
  end if;
  for t in
    select x.id,
           exists (select 1 from public.matchmaking_ticket_members m where m.ticket_id = x.id and m.user_id = any(p_offenders)) as at_fault
    from public.matchmaking_tickets x
    where x.match_id = p_match and x.status = 'RESERVED'
    order by x.id
    for update of x
  loop
    if t.at_fault then
      update public.matchmaking_tickets set status = 'CANCELLED', close_reason = p_reason where id = t.id;
    else
      update public.matchmaking_tickets set status = 'QUEUED', requeue_count = requeue_count + 1 where id = t.id;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- A player stops being part of a ticket (they left their party, or their account was deleted).
-- The rest of the party is never split and never loses its place:
--   QUEUED    the ticket shrinks and keeps waiting
--   RESERVED  the reservation is cancelled; every other ticket, and the rest of this one, is queued again
-- ---------------------------------------------------------------------------
create function public.matchmaking_ticket_member_removed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.matchmaking_tickets;
  v_left integer;
begin
  select * into v_ticket from public.matchmaking_tickets t where t.id = old.ticket_id;
  if not found or v_ticket.status not in ('QUEUED', 'RESERVED') then
    return null;
  end if;
  if v_ticket.match_id is not null then
    perform 1 from public.matchmaking_matches m where m.id = v_ticket.match_id for update;
  end if;
  select * into v_ticket from public.matchmaking_tickets t where t.id = old.ticket_id for update;
  if not found or v_ticket.status not in ('QUEUED', 'RESERVED') then
    return null;
  end if;
  if v_ticket.status = 'RESERVED' then
    perform 1 from public.matchmaking_matches m where m.id = v_ticket.match_id for update;
    perform public.matchmaking_cancel_match(v_ticket.match_id, 'CANCELLED', 'PLAYER_LEFT', array[old.user_id]);
  end if;
  select count(*) into v_left from public.matchmaking_ticket_members m where m.ticket_id = old.ticket_id;
  if v_left = 0 then
    update public.matchmaking_tickets set status = 'CANCELLED', close_reason = 'ABANDONED'
    where id = old.ticket_id and status in ('QUEUED', 'RESERVED');
  else
    update public.matchmaking_tickets t set
      player_count = v_left,
      owner_user_id = case when t.owner_user_id is null or t.owner_user_id = old.user_id
        then (select m.user_id from public.matchmaking_ticket_members m where m.ticket_id = t.id order by m.position, m.user_id limit 1)
        else t.owner_user_id end
    where t.id = old.ticket_id;
    perform public.matchmaking_touch(array(select m.user_id from public.matchmaking_ticket_members m where m.ticket_id = old.ticket_id));
  end if;
  return null;
end;
$$;

create trigger matchmaking_ticket_members_removed after delete on public.matchmaking_ticket_members
  for each row when (old.active) execute function public.matchmaking_ticket_member_removed();

-- ---------------------------------------------------------------------------
-- A player stops being in a party (left, removed, account deleted). An empty party is dissolved;
-- otherwise leadership passes to the member who has been there longest (an online one if there is
-- one), and everyone confirms again because the party is no longer the one they said "ready" to.
-- ---------------------------------------------------------------------------
create function public.party_member_removed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_party public.parties;
  v_heir uuid;
  v_grace interval := make_interval(secs => public.matchmaking_setting('reconnect_grace_seconds', 30));
begin
  select * into v_party from public.parties p where p.id = old.party_id for update;
  if not found then
    return null; -- the party itself is being removed
  end if;
  if not exists (select 1 from public.party_members m where m.party_id = old.party_id) then
    delete from public.parties where id = old.party_id;
    insert into public.matchmaking_events (entity, entity_id, mode, reason) values ('party', old.party_id, v_party.mode, 'DISSOLVED');
    perform public.matchmaking_touch(array[old.user_id]);
    return null;
  end if;
  if v_party.leader_user_id is null or v_party.leader_user_id = old.user_id then
    select m.user_id into v_heir from public.party_members m
    where m.party_id = old.party_id
    order by (m.last_seen_at > now() - v_grace) desc, m.joined_at, m.user_id
    limit 1;
    update public.parties set leader_user_id = v_heir where id = old.party_id;
    insert into public.matchmaking_events (entity, entity_id, mode, reason) values ('party', old.party_id, v_party.mode, 'LEADER_CHANGED');
  end if;
  if public.matchmaking_party_ticket(old.party_id) is null then
    update public.party_members m set ready = false where m.party_id = old.party_id and m.ready;
  end if;
  perform public.matchmaking_touch_party(old.party_id);
  perform public.matchmaking_touch(array[old.user_id]);
  return null;
end;
$$;

create trigger party_members_removed after delete on public.party_members
  for each row execute function public.party_member_removed();

-- ---------------------------------------------------------------------------
-- Private games and the queue are mutually exclusive for an account: taking a seat at a table
-- (claim_seat) ends that account's search. A reservation that is already committed is not undone
-- here; it is checked again when the game is about to be created.
-- ---------------------------------------------------------------------------
create function public.matchmaking_seat_claimed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.matchmaking_tickets t set status = 'CANCELLED', close_reason = 'JOINED_GAME'
  where t.status = 'QUEUED'
    and t.id in (select m.ticket_id from public.matchmaking_ticket_members m where m.user_id = new.user_id and m.active);
  return null;
end;
$$;

create trigger players_matchmaking_exclusive after update of user_id on public.players
  for each row when (new.user_id is not null and new.user_id is distinct from old.user_id)
  execute function public.matchmaking_seat_claimed();

-- ---------------------------------------------------------------------------
-- What the app is shown. Only public profiles: Player ID and nickname.
-- ---------------------------------------------------------------------------
create function public.matchmaking_party_json(p_party uuid, p_viewer uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'mode', p.mode,
    'is_leader', p.leader_user_id = p_viewer,
    'locked', public.matchmaking_party_ticket(p.id) is not null,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'player_id', pr.player_id,
          'nickname', pr.nickname,
          'is_leader', m.user_id = p.leader_user_id,
          'is_me', m.user_id = p_viewer,
          'ready', m.ready or m.user_id = p.leader_user_id,
          'online', m.last_seen_at > now() - make_interval(secs => public.matchmaking_setting('reconnect_grace_seconds', 30))
        ) order by m.joined_at, m.user_id)
      from public.party_members m
      join public.profiles pr on pr.user_id = m.user_id
      where m.party_id = p.id
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'player_id', pr.player_id, 'nickname', pr.nickname, 'expires_at', i.expires_at) order by i.created_at)
      from public.party_invitations i
      join public.profiles pr on pr.user_id = i.recipient_user_id
      where i.party_id = p.id and i.status = 'pending' and i.expires_at > now()
    ), '[]'::jsonb)
  )
  from public.parties p
  where p.id = p_party;
$$;

create function public.matchmaking_ticket_json(p_ticket uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'mode', t.mode, 'player_count', t.player_count, 'status', t.status,
    'queued_at', t.queued_at, 'requeue_count', t.requeue_count, 'match_id', t.match_id
  )
  from public.matchmaking_tickets t
  where t.id = p_ticket;
$$;

create function public.matchmaking_match_json(p_match uuid, p_viewer uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'mode', m.mode, 'status', m.status, 'player_count', m.player_count, 'ready_deadline', m.ready_deadline,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
          'player_id', pr.player_id,
          'nickname', pr.nickname,
          -- Players who queued together share a group number.
          'group', s.grp,
          'party', s.group_size > 1,
          'ready', s.ready_at is not null,
          'is_me', s.user_id = p_viewer
        ) order by s.seat)
      from (
        select x.*, dense_rank() over (order by x.first_seat) as grp
        from (
          select mp.*, min(mp.seat) over (partition by mp.ticket_id) as first_seat, count(*) over (partition by mp.ticket_id) as group_size
          from public.matchmaking_match_players mp
          where mp.match_id = m.id
        ) x
      ) s
      join public.profiles pr on pr.user_id = s.user_id
    ), '[]'::jsonb)
  )
  from public.matchmaking_matches m
  where m.id = p_match;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_state(): everything Play Online shows, for the caller, in one consistent answer.
-- `version` is read first, so a phone holding this answer that later hears a higher version knows
-- it must ask again. Asking is also a sign of life.
-- ---------------------------------------------------------------------------
create function public.matchmaking_state() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version bigint;
  v_party uuid;
  v_ticket public.matchmaking_tickets;
  v_live uuid;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.matchmaking_fail('NO_PROFILE');
  end if;
  insert into public.matchmaking_sync (user_id) values (v_uid) on conflict (user_id) do nothing;
  select s.version into v_version from public.matchmaking_sync s where s.user_id = v_uid;

  update public.party_members set last_seen_at = now() where user_id = v_uid;
  update public.matchmaking_ticket_members set last_seen_at = now() where user_id = v_uid and active;

  select m.party_id into v_party from public.party_members m where m.user_id = v_uid;
  select t.* into v_ticket from public.matchmaking_tickets t where t.id = public.matchmaking_active_ticket(v_uid);
  v_live := public.matchmaking_live_game(v_uid);

  return jsonb_build_object(
    'ok', true,
    'version', v_version,
    'server_time', clock_timestamp(),
    'settings', jsonb_build_object(
      'enabled', public.matchmaking_setting('enabled', 1) <> 0,
      'ready_seconds', public.matchmaking_setting('ready_seconds', 20),
      'heartbeat_seconds', greatest(public.matchmaking_setting('heartbeat_seconds', 10), 3),
      'prefer_target_seconds', public.matchmaking_setting('prefer_target_seconds', 30),
      'relax_seconds', public.matchmaking_setting('relax_seconds', 60),
      'target_players', public.matchmaking_setting('target_players', 4),
      'min_players', public.matchmaking_setting('min_players', 2),
      'max_players', public.matchmaking_setting('max_players', 8),
      'party_max_members', public.matchmaking_setting('party_max_members', 8)
    ),
    'cooldown_seconds', public.matchmaking_cooldown_left(v_uid),
    'live_game', case when v_live is null then null else (
      select jsonb_build_object('game_id', g.id, 'status', g.status, 'matchmade', g.matchmaking_match_id is not null)
      from public.games g where g.id = v_live
    ) end,
    'party', case when v_party is null then null else public.matchmaking_party_json(v_party, v_uid) end,
    -- Invitations into a party that I have not answered. Each says what it is an invitation to.
    'party_invites', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id,
          'mode', p.mode,
          'size', (select count(*) from public.party_members m where m.party_id = p.id),
          'inviter', jsonb_build_object('player_id', pr.player_id, 'nickname', pr.nickname),
          'expires_at', i.expires_at
        ) order by i.created_at desc)
      from public.party_invitations i
      join public.parties p on p.id = i.party_id
      join public.profiles pr on pr.user_id = i.inviter_user_id
      where i.recipient_user_id = v_uid and i.status = 'pending' and i.expires_at > now()
        and not public.social_has_blocked(v_uid, i.inviter_user_id) and not public.social_has_blocked(i.inviter_user_id, v_uid)
    ), '[]'::jsonb),
    'ticket', case when v_ticket.id is null then null else public.matchmaking_ticket_json(v_ticket.id) end,
    'match', case when v_ticket.id is null or v_ticket.status <> 'RESERVED' then null else public.matchmaking_match_json(v_ticket.match_id, v_uid) end,
    -- The game my last match became, while I am still playing in it: how a phone that was closed
    -- during the countdown finds its table again.
    'game', (
      select jsonb_build_object('match_id', m.id, 'game_id', g.id, 'seat_id', mp.game_player_id, 'mode', m.mode)
      from public.matchmaking_match_players mp
      join public.matchmaking_matches m on m.id = mp.match_id
      join public.games g on g.id = m.game_id
      join public.players pl on pl.id = mp.game_player_id
      where mp.user_id = v_uid and m.status = 'STARTED' and g.status in ('ACTIVE', 'PAUSED') and g.expires_at > now()
        and pl.status = 'ACTIVE' and pl.user_id = v_uid
      order by m.started_at desc
      limit 1
    ),
    -- Why my last search ended, for a couple of minutes: "you did not confirm in time", "a player left".
    'last_result', (
      select jsonb_build_object('ticket_id', t.id, 'status', t.status, 'reason', t.close_reason, 'at', t.closed_at, 'mode', t.mode)
      from public.matchmaking_ticket_members tm
      join public.matchmaking_tickets t on t.id = tm.ticket_id
      where tm.user_id = v_uid and not tm.active and t.closed_at > now() - interval '2 minutes'
      order by t.closed_at desc
      limit 1
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_heartbeat(): "this phone is still here", while searching or sitting in a party.
-- Answers with the change counter (a phone that missed a Realtime event notices here) and whether
-- the worker has something to do for this player right now.
-- ---------------------------------------------------------------------------
create function public.matchmaking_heartbeat() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ticket public.matchmaking_tickets;
  v_due boolean := false;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  update public.party_members set last_seen_at = now() where user_id = v_uid;
  update public.matchmaking_ticket_members set last_seen_at = now() where user_id = v_uid and active;
  select t.* into v_ticket from public.matchmaking_tickets t where t.id = public.matchmaking_active_ticket(v_uid);
  if found and public.matchmaking_setting('client_tick', 1) <> 0 then
    if v_ticket.status = 'QUEUED' then
      v_due := v_ticket.player_count >= public.matchmaking_setting('party_alone_min_players', 4)
        or exists (select 1 from public.matchmaking_tickets o where o.status = 'QUEUED' and o.mode = v_ticket.mode and o.id <> v_ticket.id);
    else
      v_due := exists (
        select 1 from public.matchmaking_matches m
        where m.id = v_ticket.match_id and (m.status = 'STARTING' or (m.status = 'READY_UP' and m.ready_deadline < now()))
      );
    end if;
  end if;
  return jsonb_build_object(
    'ok', true,
    'version', coalesce((select s.version from public.matchmaking_sync s where s.user_id = v_uid), 0),
    'server_time', clock_timestamp(),
    'tick_due', v_due
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
create function public.party_create(p_mode text default 'classic') returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_party uuid;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.matchmaking_fail('NO_PROFILE');
  end if;
  if p_mode is null or p_mode not in ('classic', 'intermediate') then
    return public.matchmaking_fail('VALIDATION');
  end if;
  perform public.matchmaking_lock_user(v_uid);
  select m.party_id into v_party from public.party_members m where m.user_id = v_uid;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'party_id', v_party);
  end if;
  if public.matchmaking_active_ticket(v_uid) is not null then
    return public.matchmaking_fail('ALREADY_QUEUED');
  end if;
  insert into public.parties (leader_user_id, mode) values (v_uid, p_mode) returning id into v_party;
  insert into public.party_members (user_id, party_id, ready) values (v_uid, v_party, true);
  insert into public.matchmaking_events (entity, entity_id, mode, reason) values ('party', v_party, p_mode, 'CREATED');
  perform public.matchmaking_touch(array[v_uid]);
  return jsonb_build_object('ok', true, 'created', true, 'party_id', v_party);
end;
$$;

-- An invitation into my party, to a friend. It queues nobody: the friend must accept, then confirm.
create function public.party_invite(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_party public.parties;
  v_target uuid;
  v_id uuid;
  v_expires timestamptz;
  v_wait integer;
  v_max integer := least(public.matchmaking_setting('party_max_members', 8), 8);
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if v_pid is null then
    return public.matchmaking_fail('INVALID_PLAYER_ID');
  end if;
  select p.* into v_party from public.parties p join public.party_members m on m.party_id = p.id where m.user_id = v_uid;
  if not found then
    return public.matchmaking_fail('NOT_IN_PARTY');
  end if;
  select * into v_party from public.parties p where p.id = v_party.id for update;
  if not found or not exists (select 1 from public.party_members m where m.party_id = v_party.id and m.user_id = v_uid) then
    return public.matchmaking_fail('NOT_IN_PARTY');
  end if;
  if v_party.leader_user_id is distinct from v_uid then
    return public.matchmaking_fail('NOT_LEADER');
  end if;
  if public.matchmaking_party_ticket(v_party.id) is not null then
    return public.matchmaking_fail('PARTY_LOCKED');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found then
    return public.matchmaking_fail('NOT_FOUND');
  end if;
  if v_target = v_uid then
    return public.matchmaking_fail('SELF');
  end if;

  perform public.social_lock_pair(v_uid, v_target);
  if public.social_has_blocked(v_uid, v_target) then
    return public.matchmaking_fail('BLOCKED_BY_YOU');
  end if;
  if public.social_has_blocked(v_target, v_uid) then
    return public.matchmaking_fail('UNAVAILABLE');
  end if;
  if not public.social_are_friends(v_uid, v_target) then
    return public.matchmaking_fail('NOT_FRIENDS');
  end if;
  if exists (select 1 from public.party_members m where m.party_id = v_party.id and m.user_id = v_target) then
    return public.matchmaking_fail('ALREADY_MEMBER');
  end if;

  update public.party_invitations set status = 'expired'
  where party_id = v_party.id and status = 'pending' and expires_at <= now();
  select i.id, i.expires_at into v_id, v_expires from public.party_invitations i
  where i.party_id = v_party.id and i.recipient_user_id = v_target and i.status = 'pending';
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'invite_id', v_id, 'expires_at', v_expires);
  end if;
  if (select count(*) from public.party_members m where m.party_id = v_party.id)
     + (select count(*) from public.party_invitations i where i.party_id = v_party.id and i.status = 'pending') >= v_max then
    return public.matchmaking_fail('PARTY_FULL');
  end if;

  v_wait := public.social_rate_hit(v_uid, 'party_invite_pair', v_target);
  if v_wait > 0 then
    return public.matchmaking_fail('RATE_LIMITED', v_wait);
  end if;
  v_wait := public.social_rate_hit(v_uid, 'party_invite');
  if v_wait > 0 then
    return public.matchmaking_fail('RATE_LIMITED', v_wait);
  end if;

  insert into public.party_invitations (party_id, inviter_user_id, recipient_user_id, expires_at)
  values (v_party.id, v_uid, v_target, now() + make_interval(secs => public.matchmaking_setting('party_invite_ttl_seconds', 900)))
  returning id, expires_at into v_id, v_expires;
  perform public.matchmaking_touch_party(v_party.id);
  return jsonb_build_object('ok', true, 'created', true, 'invite_id', v_id, 'expires_at', v_expires);
end;
$$;

-- Accept or decline an invitation into a party. Only the invited player can. Accepting joins the
-- party and nothing else; two acceptances by the same player cannot both succeed (one party each).
create function public.party_respond_invite(p_invite_id uuid, p_accept boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.party_invitations;
  v_party public.parties;
  v_mine uuid;
  v_max integer := least(public.matchmaking_setting('party_max_members', 8), 8);
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if p_invite_id is null or p_accept is null then
    return public.matchmaking_fail('VALIDATION');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.matchmaking_fail('NO_PROFILE');
  end if;
  select * into v_inv from public.party_invitations i where i.id = p_invite_id and i.recipient_user_id = v_uid;
  if not found then
    return public.matchmaking_fail('INVITE_GONE');
  end if;

  if not p_accept then
    update public.party_invitations set status = 'declined' where id = v_inv.id and status = 'pending';
    perform public.matchmaking_touch_party(v_inv.party_id);
    perform public.matchmaking_touch(array[v_uid]);
    return jsonb_build_object('ok', true, 'joined', false);
  end if;

  perform public.matchmaking_lock_user(v_uid);
  select * into v_party from public.parties p where p.id = v_inv.party_id for update;
  if not found then
    return public.matchmaking_fail('INVITE_GONE');
  end if;
  select * into v_inv from public.party_invitations i where i.id = p_invite_id and i.recipient_user_id = v_uid for update;
  select m.party_id into v_mine from public.party_members m where m.user_id = v_uid;
  if v_mine = v_party.id then
    return jsonb_build_object('ok', true, 'joined', true, 'party_id', v_party.id);
  end if;
  if v_inv.status <> 'pending' then
    return public.matchmaking_fail('INVITE_GONE');
  end if;
  if v_inv.expires_at <= now() then
    update public.party_invitations set status = 'expired' where id = v_inv.id;
    return public.matchmaking_fail('INVITE_EXPIRED');
  end if;
  if public.social_has_blocked(v_uid, v_inv.inviter_user_id) or public.social_has_blocked(v_inv.inviter_user_id, v_uid) then
    return public.matchmaking_fail('INVITE_GONE');
  end if;
  if v_mine is not null then
    return public.matchmaking_fail('ALREADY_IN_PARTY');
  end if;
  if public.matchmaking_active_ticket(v_uid) is not null then
    return public.matchmaking_fail('ALREADY_QUEUED');
  end if;
  if public.matchmaking_party_ticket(v_party.id) is not null then
    return public.matchmaking_fail('PARTY_LOCKED');
  end if;
  if (select count(*) from public.party_members m where m.party_id = v_party.id) >= v_max then
    return public.matchmaking_fail('PARTY_FULL');
  end if;

  begin
    insert into public.party_members (user_id, party_id) values (v_uid, v_party.id);
  exception
    when unique_violation then
      return public.matchmaking_fail('ALREADY_IN_PARTY');
  end;
  update public.party_invitations set status = 'accepted' where id = v_inv.id;
  -- The party changed: what the others said "ready" to no longer exists.
  update public.party_members m set ready = false where m.party_id = v_party.id and m.ready and m.user_id <> v_party.leader_user_id;
  perform public.matchmaking_touch_party(v_party.id);
  return jsonb_build_object('ok', true, 'joined', true, 'party_id', v_party.id);
end;
$$;

create function public.party_revoke_invite(p_invite_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.party_invitations;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  select i.* into v_inv from public.party_invitations i
  join public.parties p on p.id = i.party_id
  where i.id = p_invite_id and (i.inviter_user_id = v_uid or p.leader_user_id = v_uid);
  if not found then
    return public.matchmaking_fail('INVITE_GONE');
  end if;
  update public.party_invitations set status = 'revoked' where id = v_inv.id and status = 'pending';
  perform public.matchmaking_touch_party(v_inv.party_id);
  perform public.matchmaking_touch(array[v_inv.recipient_user_id]);
  return jsonb_build_object('ok', true);
end;
$$;

-- The leader picks the mode. Changing it asks everyone to confirm again.
create function public.party_set_mode(p_mode text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_party public.parties;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if p_mode is null or p_mode not in ('classic', 'intermediate') then
    return public.matchmaking_fail('VALIDATION');
  end if;
  select p.* into v_party from public.parties p join public.party_members m on m.party_id = p.id where m.user_id = v_uid;
  if not found then
    return public.matchmaking_fail('NOT_IN_PARTY');
  end if;
  select * into v_party from public.parties p where p.id = v_party.id for update;
  if v_party.leader_user_id is distinct from v_uid then
    return public.matchmaking_fail('NOT_LEADER');
  end if;
  if public.matchmaking_party_ticket(v_party.id) is not null then
    return public.matchmaking_fail('PARTY_LOCKED');
  end if;
  if v_party.mode <> p_mode then
    update public.parties set mode = p_mode where id = v_party.id;
    update public.party_members m set ready = false where m.party_id = v_party.id and m.ready and m.user_id <> v_uid;
    perform public.matchmaking_touch_party(v_party.id);
  end if;
  return jsonb_build_object('ok', true, 'mode', p_mode);
end;
$$;

-- "I am ready to queue with this party." Only for myself.
create function public.party_set_ready(p_ready boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_party uuid;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if p_ready is null then
    return public.matchmaking_fail('VALIDATION');
  end if;
  select m.party_id into v_party from public.party_members m where m.user_id = v_uid;
  if not found then
    return public.matchmaking_fail('NOT_IN_PARTY');
  end if;
  perform 1 from public.parties p where p.id = v_party for update;
  if public.matchmaking_party_ticket(v_party) is not null then
    return public.matchmaking_fail('PARTY_LOCKED');
  end if;
  update public.party_members set ready = p_ready, last_seen_at = now() where user_id = v_uid and party_id = v_party and ready is distinct from p_ready;
  if found then
    perform public.matchmaking_touch_party(v_party);
  end if;
  return jsonb_build_object('ok', true, 'ready', p_ready);
end;
$$;

-- Leave my party, whatever it is doing. The others stay together (see the two "removed" triggers).
-- Walking out of a match that was found counts as not confirming it.
create function public.party_leave() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_party uuid;
  v_ticket public.matchmaking_tickets;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  select m.party_id into v_party from public.party_members m where m.user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', true, 'left', false);
  end if;
  perform 1 from public.parties p where p.id = v_party for update;
  select t.* into v_ticket from public.matchmaking_tickets t where t.id = public.matchmaking_active_ticket(v_uid);
  if found and v_ticket.status = 'RESERVED' then
    if exists (select 1 from public.matchmaking_matches m where m.id = v_ticket.match_id and m.status = 'STARTING') then
      return public.matchmaking_fail('TOO_LATE');
    end if;
    perform public.matchmaking_strike(v_uid);
  end if;
  delete from public.party_members where user_id = v_uid and party_id = v_party;
  delete from public.matchmaking_ticket_members where user_id = v_uid and active;
  perform public.matchmaking_touch(array[v_uid]);
  return jsonb_build_object('ok', true, 'left', true);
end;
$$;

-- The leader removes a member, before queueing.
create function public.party_kick(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_party public.parties;
  v_target uuid;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if v_pid is null then
    return public.matchmaking_fail('INVALID_PLAYER_ID');
  end if;
  select p.* into v_party from public.parties p join public.party_members m on m.party_id = p.id where m.user_id = v_uid;
  if not found then
    return public.matchmaking_fail('NOT_IN_PARTY');
  end if;
  select * into v_party from public.parties p where p.id = v_party.id for update;
  if v_party.leader_user_id is distinct from v_uid then
    return public.matchmaking_fail('NOT_LEADER');
  end if;
  if public.matchmaking_party_ticket(v_party.id) is not null then
    return public.matchmaking_fail('PARTY_LOCKED');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found or v_target = v_uid then
    return public.matchmaking_fail('VALIDATION');
  end if;
  delete from public.party_members where user_id = v_target and party_id = v_party.id;
  return jsonb_build_object('ok', true, 'removed', found);
end;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_enqueue(): enter the queue - alone, or (the leader) with the whole party.
-- The ticket is created here or not at all; the same request sent twice, from one phone or two,
-- returns the one ticket. A party is taken as it is NOW, under its row lock: nobody joins,
-- leaves or changes the mode between the checks and the ticket.
-- ---------------------------------------------------------------------------
create function public.matchmaking_enqueue(p_mode text default null, p_idempotency_key text default null) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_party public.parties;
  v_mode text;
  v_ticket uuid;
  v_members uuid[];
  v_count integer;
  v_wait integer;
  v_grace interval := make_interval(secs => public.matchmaking_setting('reconnect_grace_seconds', 30));
  v_max integer := least(public.matchmaking_setting('party_max_members', 8), public.matchmaking_setting('max_players', 8), 8);
  v_old public.matchmaking_tickets;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.matchmaking_fail('NO_PROFILE');
  end if;
  if p_mode is not null and p_mode not in ('classic', 'intermediate') then
    return public.matchmaking_fail('VALIDATION');
  end if;
  if p_idempotency_key is not null and char_length(p_idempotency_key) not between 8 and 64 then
    return public.matchmaking_fail('VALIDATION');
  end if;

  perform public.matchmaking_lock_user(v_uid);

  select m.party_id into v_party.id from public.party_members m where m.user_id = v_uid;
  if v_party.id is not null then
    select * into v_party from public.parties p where p.id = v_party.id for update;
    if not found or not exists (select 1 from public.party_members m where m.party_id = v_party.id and m.user_id = v_uid) then
      v_party := null; -- left (or the party was dissolved) while this request waited
    end if;
  end if;

  -- Already queued: that ticket is the answer, whatever this request asked for.
  v_existing := public.matchmaking_active_ticket(v_uid);
  if v_existing is not null then
    select * into v_old from public.matchmaking_tickets t where t.id = v_existing;
    insert into public.matchmaking_events (entity, entity_id, mode, reason) values ('ticket', v_existing, v_old.mode, 'DUPLICATE_ENQUEUE');
    if p_mode is not null and p_mode <> v_old.mode then
      return public.matchmaking_fail('ALREADY_QUEUED') || jsonb_build_object('ticket', public.matchmaking_ticket_json(v_existing));
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'ticket', public.matchmaking_ticket_json(v_existing));
  end if;
  -- A retry of a request whose ticket has since ended must not start a new search by itself.
  if p_idempotency_key is not null and exists (
    select 1 from public.matchmaking_tickets t where t.owner_user_id = v_uid and t.idempotency_key = p_idempotency_key
  ) then
    return public.matchmaking_fail('STALE_REQUEST');
  end if;
  if public.matchmaking_setting('enabled', 1) = 0 then
    return public.matchmaking_fail('MATCHMAKING_DISABLED');
  end if;

  if v_party.id is null then
    -- Solo.
    if p_mode is null then
      return public.matchmaking_fail('VALIDATION');
    end if;
    v_mode := p_mode;
    v_members := array[v_uid];
  else
    if v_party.leader_user_id is distinct from v_uid then
      return public.matchmaking_fail('NOT_LEADER');
    end if;
    if p_mode is not null and p_mode <> v_party.mode then
      return public.matchmaking_fail('PARTY_MODE_MISMATCH');
    end if;
    v_mode := v_party.mode;
    select array_agg(m.user_id order by m.joined_at, m.user_id) into v_members from public.party_members m where m.party_id = v_party.id;
    v_count := coalesce(cardinality(v_members), 0);
    if v_count < 1 or v_count > v_max then
      return public.matchmaking_fail('PARTY_INVALID');
    end if;
    if exists (select 1 from public.party_members m where m.party_id = v_party.id and m.user_id <> v_uid and not m.ready) then
      return public.matchmaking_fail('PARTY_NOT_READY');
    end if;
    if exists (select 1 from public.party_members m where m.party_id = v_party.id and m.user_id <> v_uid and m.last_seen_at <= now() - v_grace) then
      return public.matchmaking_fail('MEMBER_OFFLINE');
    end if;
    if exists (select 1 from public.matchmaking_ticket_members tm where tm.user_id = any(v_members) and tm.active) then
      return public.matchmaking_fail('MEMBER_QUEUED');
    end if;
    -- Two members with a block between them cannot be sent to the same table.
    if exists (
      select 1 from public.player_blocks b where b.blocker_user_id = any(v_members) and b.blocked_user_id = any(v_members)
    ) then
      return public.matchmaking_fail('PARTY_INVALID');
    end if;
    if exists (select 1 from unnest(v_members) u where u <> v_uid and public.matchmaking_live_game(u) is not null) then
      return public.matchmaking_fail('MEMBER_IN_GAME');
    end if;
    if exists (select 1 from unnest(v_members) u where u <> v_uid and public.matchmaking_cooldown_left(u) > 0) then
      return public.matchmaking_fail('MEMBER_COOLDOWN');
    end if;
  end if;

  if public.matchmaking_live_game(v_uid) is not null then
    return public.matchmaking_fail('ALREADY_IN_GAME');
  end if;
  v_wait := public.matchmaking_cooldown_left(v_uid);
  if v_wait > 0 then
    return public.matchmaking_fail('COOLDOWN', v_wait);
  end if;

  begin
    insert into public.matchmaking_tickets (kind, owner_user_id, party_id, mode, player_count, idempotency_key)
    values (case when v_party.id is null then 'solo' else 'party' end, v_uid, v_party.id, v_mode, cardinality(v_members), p_idempotency_key)
    returning id into v_ticket;
    insert into public.matchmaking_ticket_members (ticket_id, user_id, position, last_seen_at)
    select v_ticket, u.user_id, u.ord, now() from unnest(v_members) with ordinality as u(user_id, ord);
  exception
    when unique_violation then
      -- Another request for the same player or party got there first: its ticket is the answer.
      v_existing := public.matchmaking_active_ticket(v_uid);
      if v_existing is null then
        return public.matchmaking_fail('MEMBER_QUEUED');
      end if;
      return jsonb_build_object('ok', true, 'created', false, 'ticket', public.matchmaking_ticket_json(v_existing));
  end;
  perform public.matchmaking_touch(v_members);
  return jsonb_build_object('ok', true, 'created', true, 'ticket', public.matchmaking_ticket_json(v_ticket));
end;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_cancel(): stop searching. A solo player cancels their own ticket; a party's ticket
-- is cancelled by its leader (a member who wants out leaves the party). The answer is the
-- ticket's state AFTER the call: if a match was reserved first, it says so and nothing is undone.
-- ---------------------------------------------------------------------------
create function public.matchmaking_cancel() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_ticket public.matchmaking_tickets;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  v_id := public.matchmaking_active_ticket(v_uid);
  if v_id is null then
    return jsonb_build_object('ok', true, 'cancelled', false, 'status', 'NONE');
  end if;
  select * into v_ticket from public.matchmaking_tickets t where t.id = v_id;
  if v_ticket.party_id is not null and not exists (
    select 1 from public.parties p where p.id = v_ticket.party_id and p.leader_user_id = v_uid
  ) then
    return public.matchmaking_fail('NOT_LEADER');
  end if;
  -- Waits here if the matcher holds the ticket; whichever committed first decides.
  select * into v_ticket from public.matchmaking_tickets t where t.id = v_id for update;
  if v_ticket.status = 'QUEUED' then
    update public.matchmaking_tickets set status = 'CANCELLED', close_reason = 'CANCELLED_BY_PLAYER' where id = v_id;
    return jsonb_build_object('ok', true, 'cancelled', true, 'status', 'CANCELLED');
  end if;
  if v_ticket.status = 'RESERVED' then
    return jsonb_build_object('ok', true, 'cancelled', false, 'status', 'RESERVED', 'match_id', v_ticket.match_id);
  end if;
  return jsonb_build_object('ok', true, 'cancelled', false, 'status', v_ticket.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_ready(): "I am here and ready", for myself only, with the device token that will
-- hold my seat (only its SHA-256 is kept, exactly as the referee keeps a seat's token).
-- Repeating it changes nothing. Until everyone is ready the last phone to confirm holds the seat.
-- The deadline is the server's: a confirmation after it is refused, whatever the phone's clock says.
-- ---------------------------------------------------------------------------
create function public.matchmaking_ready(p_match_id uuid, p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_match public.matchmaking_matches;
  v_me public.matchmaking_match_players;
  v_hash text;
  v_all boolean := false;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if p_match_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return public.matchmaking_fail('VALIDATION');
  end if;
  if not exists (select 1 from public.matchmaking_match_players p where p.match_id = p_match_id and p.user_id = v_uid) then
    return public.matchmaking_fail('MATCH_GONE');
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into v_match from public.matchmaking_matches m where m.id = p_match_id for update;
  select * into v_me from public.matchmaking_match_players p where p.match_id = p_match_id and p.user_id = v_uid;
  if not found or v_match.status in ('CANCELLED', 'FAILED') then
    return public.matchmaking_fail('MATCH_GONE');
  end if;
  if v_match.status in ('STARTING', 'STARTED') then
    if v_me.token_hash = v_hash then
      return jsonb_build_object('ok', true, 'status', v_match.status, 'all_ready', true);
    end if;
    return public.matchmaking_fail('SEAT_ON_OTHER_DEVICE');
  end if;
  if v_match.ready_deadline <= now() then
    return public.matchmaking_fail('READY_TIMEOUT');
  end if;
  update public.matchmaking_match_players set ready_at = coalesce(ready_at, now()), token_hash = v_hash
  where match_id = p_match_id and user_id = v_uid;
  if not exists (select 1 from public.matchmaking_match_players p where p.match_id = p_match_id and p.ready_at is null) then
    v_all := true;
    update public.matchmaking_matches set
      status = 'STARTING', all_ready_at = now(),
      start_deadline = now() + make_interval(secs => public.matchmaking_setting('start_grace_seconds', 30))
    where id = p_match_id;
  else
    perform public.matchmaking_touch(array(select p.user_id from public.matchmaking_match_players p where p.match_id = p_match_id));
  end if;
  return jsonb_build_object('ok', true, 'status', case when v_all then 'STARTING' else 'READY_UP' end, 'all_ready', v_all);
end;
$$;

-- "Not this one." Ends the reservation for everyone at once instead of making them wait out the
-- countdown; the others go straight back into the queue. Counts as a missed ready-up.
create function public.matchmaking_decline(p_match_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_match public.matchmaking_matches;
begin
  if v_uid is null then
    return public.matchmaking_fail('UNAUTHENTICATED');
  end if;
  if p_match_id is null or not exists (select 1 from public.matchmaking_match_players p where p.match_id = p_match_id and p.user_id = v_uid) then
    return public.matchmaking_fail('MATCH_GONE');
  end if;
  select * into v_match from public.matchmaking_matches m where m.id = p_match_id for update;
  if v_match.status in ('STARTING', 'STARTED') then
    return public.matchmaking_fail('TOO_LATE');
  end if;
  if v_match.status = 'READY_UP' then
    perform public.matchmaking_strike(v_uid);
    perform public.matchmaking_cancel_match(p_match_id, 'CANCELLED', 'DECLINED', array[v_uid]);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker's side. Only the server calls these (the `matchmaking` Edge Function, connected as
-- the database owner, and pg_cron).
-- ---------------------------------------------------------------------------

-- Step 1 of a matching run for one mode: take the run (one at a time per mode, not more often than
-- min_run_interval_ms), lock a bounded batch of the oldest queued tickets that no other run holds,
-- drop the ones that may no longer be matched, and hand back what the grouping needs.
-- The locks last until the caller's transaction ends, so a cancel that arrives meanwhile waits and
-- then sees whichever outcome was committed.
create function public.matchmaking_candidates(p_mode text, p_force boolean default false) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_batch integer := least(greatest(public.matchmaking_setting('batch_size', 64), 2), 256);
  v_interval integer := public.matchmaking_setting('min_run_interval_ms', 1000);
  v_ids uuid[];
  r record;
begin
  if public.matchmaking_setting('enabled', 1) = 0 then
    return jsonb_build_object('skipped', 'DISABLED');
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('matchmaking-run:' || p_mode, 0)) then
    return jsonb_build_object('skipped', 'BUSY');
  end if;
  update public.matchmaking_runs set last_run_at = clock_timestamp(), runs = runs + 1
  where mode = p_mode and (p_force or last_run_at is null or last_run_at <= clock_timestamp() - make_interval(secs => v_interval / 1000.0));
  if not found then
    return jsonb_build_object('skipped', 'THROTTLED');
  end if;

  select coalesce(array_agg(x.id), '{}') into v_ids
  from (
    select t.id from public.matchmaking_tickets t
    where t.status = 'QUEUED' and t.mode = p_mode
    order by t.queued_at, t.id
    limit v_batch
    for update skip locked
  ) x;

  for r in
    select t.id, t.player_count,
           (select count(*) from public.matchmaking_ticket_members m where m.ticket_id = t.id and m.active) as members,
           exists (
             select 1 from public.matchmaking_ticket_members m
             where m.ticket_id = t.id and m.active and public.matchmaking_live_game(m.user_id) is not null
           ) as in_game
    from public.matchmaking_tickets t
    where t.id = any(v_ids)
  loop
    if r.members = 0 then
      update public.matchmaking_tickets set status = 'FAILED', close_reason = 'ORPHANED' where id = r.id;
      v_ids := array_remove(v_ids, r.id);
    elsif r.in_game then
      update public.matchmaking_tickets set status = 'CANCELLED', close_reason = 'IN_GAME' where id = r.id;
      v_ids := array_remove(v_ids, r.id);
    elsif r.members <> r.player_count then
      update public.matchmaking_tickets set player_count = r.members where id = r.id;
    end if;
  end loop;

  return jsonb_build_object(
    'now_ms', floor(extract(epoch from clock_timestamp()) * 1000),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'size', t.player_count, 'queued_at_ms', floor(extract(epoch from t.queued_at) * 1000))
                       order by t.queued_at, t.id)
      from public.matchmaking_tickets t where t.id = any(v_ids)
    ), '[]'::jsonb),
    -- Pairs of tickets that must not share a table: a block between any two of their players.
    'conflicts', coalesce((
      select jsonb_agg(jsonb_build_array(c.a, c.b))
      from (
        select distinct least(ma.ticket_id, mb.ticket_id) as a, greatest(ma.ticket_id, mb.ticket_id) as b
        from public.matchmaking_ticket_members ma
        join public.player_blocks bl on bl.blocker_user_id = ma.user_id
        join public.matchmaking_ticket_members mb on mb.user_id = bl.blocked_user_id and mb.active
        where ma.active and ma.ticket_id = any(v_ids) and mb.ticket_id = any(v_ids) and ma.ticket_id <> mb.ticket_id
      ) c
    ), '[]'::jsonb),
    'policy', jsonb_build_object(
      'target_players', public.matchmaking_setting('target_players', 4),
      'min_players', public.matchmaking_setting('min_players', 2),
      'max_players', public.matchmaking_setting('max_players', 8),
      'prefer_target_ms', public.matchmaking_setting('prefer_target_seconds', 30) * 1000,
      'relax_ms', public.matchmaking_setting('relax_seconds', 60) * 1000,
      'party_alone_min_players', public.matchmaking_setting('party_alone_min_players', 4),
      'window_size', public.matchmaking_setting('window_size', 10),
      'max_matches', public.matchmaking_setting('max_matches_per_run', 16)
    )
  );
end;
$$;

-- Step 2: turn one proposed group into a reservation - or refuse it. Nothing the caller proposes is
-- trusted: every ticket is locked and read again, whole tickets only (a party cannot be split by a
-- proposal), one mode, 2 to 8 players, nobody twice, nobody who is in a game. All of it commits
-- together with the caller's transaction, or none of it.
create function public.matchmaking_reserve(p_mode text, p_ticket_ids uuid[]) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct x from unnest(p_ticket_ids) x where x is not null);
  v_found integer;
  v_total integer;
  v_members integer;
  v_users integer;
  v_min integer := greatest(public.matchmaking_setting('min_players', 2), 2);
  v_max integer := least(public.matchmaking_setting('max_players', 8), 8);
  v_match uuid;
begin
  if cardinality(v_ids) = 0 or cardinality(v_ids) <> coalesce(cardinality(p_ticket_ids), 0) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_GROUP');
  end if;
  perform 1 from public.matchmaking_tickets t where t.id = any(v_ids) order by t.id for update;
  select count(*), coalesce(sum(t.player_count), 0) into v_found, v_total
  from public.matchmaking_tickets t
  where t.id = any(v_ids) and t.status = 'QUEUED' and t.mode = p_mode;
  if v_found <> cardinality(v_ids) then
    return jsonb_build_object('ok', false, 'code', 'STALE');
  end if;
  if v_total < v_min or v_total > v_max then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SIZE');
  end if;
  select count(*), count(distinct m.user_id) into v_members, v_users
  from public.matchmaking_ticket_members m where m.ticket_id = any(v_ids) and m.active;
  if v_members <> v_total or v_users <> v_total then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MEMBERS');
  end if;
  if exists (
    select 1 from public.matchmaking_ticket_members m
    where m.ticket_id = any(v_ids) and m.active and public.matchmaking_live_game(m.user_id) is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'IN_GAME');
  end if;
  if exists (
    select 1
    from public.matchmaking_ticket_members ma
    join public.player_blocks bl on bl.blocker_user_id = ma.user_id
    join public.matchmaking_ticket_members mb on mb.user_id = bl.blocked_user_id and mb.active
    where ma.active and ma.ticket_id = any(v_ids) and mb.ticket_id = any(v_ids) and ma.ticket_id <> mb.ticket_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'BLOCKED');
  end if;

  insert into public.matchmaking_matches (mode, player_count, ready_deadline)
  values (p_mode, v_total, now() + make_interval(secs => greatest(public.matchmaking_setting('ready_seconds', 20), 5)))
  returning id into v_match;
  insert into public.matchmaking_match_players (match_id, user_id, ticket_id, seat)
  select v_match, m.user_id, m.ticket_id, (row_number() over (order by t.queued_at, t.id, m.position, m.user_id) - 1)::integer
  from public.matchmaking_ticket_members m
  join public.matchmaking_tickets t on t.id = m.ticket_id
  where m.ticket_id = any(v_ids) and m.active;
  update public.matchmaking_tickets set status = 'RESERVED', match_id = v_match where id = any(v_ids);
  perform public.matchmaking_touch(array(select p.user_id from public.matchmaking_match_players p where p.match_id = v_match));
  return jsonb_build_object('ok', true, 'match_id', v_match, 'players', v_total);
end;
$$;

-- Step 3a: claim a reservation whose players are all ready, and check everything again before the
-- game is created in the caller's transaction. A second caller gets nothing (the row is locked, or
-- no longer STARTING), so the game is created once.
create function public.matchmaking_begin_start(p_match_id uuid) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_match public.matchmaking_matches;
  v_players integer;
  v_valid integer;
  v_in_game uuid[];
begin
  select * into v_match from public.matchmaking_matches m where m.id = p_match_id for update skip locked;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BUSY');
  end if;
  if v_match.status <> 'STARTING' or v_match.game_id is not null then
    return jsonb_build_object('ok', false, 'code', 'NOT_STARTING');
  end if;
  perform 1 from public.matchmaking_tickets t where t.match_id = p_match_id order by t.id for update;

  select count(*) into v_players from public.matchmaking_match_players p where p.match_id = p_match_id;
  -- Every assigned player: ready, with a seat token, still a member of a ticket that is still reserved here.
  select count(*) into v_valid
  from public.matchmaking_match_players p
  join public.matchmaking_tickets t on t.id = p.ticket_id and t.status = 'RESERVED' and t.match_id = p_match_id
  join public.matchmaking_ticket_members tm on tm.ticket_id = t.id and tm.user_id = p.user_id and tm.active
  where p.match_id = p_match_id and p.ready_at is not null and p.token_hash is not null;
  if v_players <> v_match.player_count or v_valid <> v_match.player_count
     or (select coalesce(sum(t.player_count), 0) from public.matchmaking_tickets t where t.match_id = p_match_id and t.status = 'RESERVED') <> v_match.player_count then
    -- Not anyone's fault that can be named: everyone still there is queued again.
    perform public.matchmaking_cancel_match(p_match_id, 'FAILED', 'INVALID_RESERVATION', '{}');
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESERVATION');
  end if;
  select array_agg(p.user_id) into v_in_game
  from public.matchmaking_match_players p
  where p.match_id = p_match_id and public.matchmaking_live_game(p.user_id) is not null;
  if v_in_game is not null then
    perform public.matchmaking_cancel_match(p_match_id, 'CANCELLED', 'IN_GAME', v_in_game);
    return jsonb_build_object('ok', false, 'code', 'IN_GAME');
  end if;

  return jsonb_build_object(
    'ok', true,
    'mode', v_match.mode,
    'players', (
      select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'seat', p.seat, 'nickname', pr.nickname, 'token_hash', p.token_hash) order by p.seat)
      from public.matchmaking_match_players p
      join public.profiles pr on pr.user_id = p.user_id
      where p.match_id = p_match_id
    )
  );
end;
$$;

-- Step 3b: the game exists (written by the engine, in this same transaction). Tie it to the
-- reservation, give each seat its account, and close the tickets. The unique index on
-- games.matchmaking_match_id is the last line: a second game for one reservation cannot be stored.
create function public.matchmaking_finish_start(p_match_id uuid, p_game_id uuid, p_seats jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_match public.matchmaking_matches;
  v_seated integer;
begin
  select * into v_match from public.matchmaking_matches m where m.id = p_match_id for update;
  if not found or v_match.status <> 'STARTING' or v_match.game_id is not null then
    raise exception 'match % is not being started', p_match_id using errcode = 'check_violation';
  end if;
  update public.games set matchmaking_match_id = p_match_id where id = p_game_id;
  update public.players pl set user_id = x.user_id
  from jsonb_to_recordset(p_seats) as x(user_id uuid, player_id uuid)
  where pl.id = x.player_id and pl.game_id = p_game_id;
  update public.matchmaking_match_players mp set game_player_id = x.player_id
  from jsonb_to_recordset(p_seats) as x(user_id uuid, player_id uuid)
  where mp.match_id = p_match_id and mp.user_id = x.user_id;
  get diagnostics v_seated = row_count;
  if v_seated <> v_match.player_count
     or (select count(*) from public.players pl where pl.game_id = p_game_id and pl.user_id is not null) <> v_match.player_count then
    raise exception 'match % has % players but % seats were assigned', p_match_id, v_match.player_count, v_seated using errcode = 'check_violation';
  end if;
  update public.matchmaking_matches set status = 'STARTED', game_id = p_game_id where id = p_match_id;
  update public.matchmaking_tickets set status = 'MATCHED', close_reason = 'MATCHED' where match_id = p_match_id and status = 'RESERVED';
  return jsonb_build_object('ok', true, 'game_id', p_game_id);
end;
$$;

-- Game creation failed (in its own, rolled-back transaction). Remembered outside it; after three
-- tries nobody is kept waiting any longer - everyone goes back into the queue, without a penalty.
create function public.matchmaking_note_start_failure(p_match_id uuid, p_error text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_match public.matchmaking_matches;
begin
  select * into v_match from public.matchmaking_matches m where m.id = p_match_id for update;
  if not found or v_match.status <> 'STARTING' then
    return jsonb_build_object('ok', false);
  end if;
  update public.matchmaking_matches set start_attempts = start_attempts + 1, last_error = left(coalesce(p_error, ''), 200)
  where id = p_match_id;
  insert into public.matchmaking_events (entity, entity_id, mode, reason, detail)
  values ('match', p_match_id, v_match.mode, 'START_ATTEMPT_FAILED', jsonb_build_object('attempt', v_match.start_attempts + 1, 'error', left(coalesce(p_error, ''), 200)));
  if v_match.start_attempts + 1 >= 3 then
    perform public.matchmaking_cancel_match(p_match_id, 'FAILED', 'START_FAILED', '{}');
    return jsonb_build_object('ok', true, 'failed', true);
  end if;
  return jsonb_build_object('ok', true, 'failed', false);
end;
$$;

create function public.matchmaking_log_run(p_mode text, p_detail jsonb) returns void
language sql
set search_path = ''
as $$
  insert into public.matchmaking_events (entity, mode, reason, detail) values ('run', p_mode, 'RUN', coalesce(p_detail, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_sweep(): recovery and housekeeping. Bounded, safe to run at any moment, any number
-- of times, alongside players and workers: every row it acts on is locked first (rows another
-- transaction holds are skipped and seen by the next run) and its state is read again.
--   1. searching players whose phone has been silent past the grace period leave the queue
--   2. ready-up countdowns that ran out: whoever did not confirm leaves the queue (their whole
--      ticket - a party is never split) with a short cooldown; everyone else is queued again
--   3. reservations whose game could not be created in time: everyone is queued again, no penalty
--   4. anything left in a state that should not exist is brought back to one that does
--   5. expired party invitations, absent leaders, abandoned parties, old rows
-- ---------------------------------------------------------------------------
create function public.matchmaking_sweep(p_limit integer default 200) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_grace interval := make_interval(secs => public.matchmaking_setting('reconnect_grace_seconds', 30));
  v_leader_grace interval := make_interval(secs => public.matchmaking_setting('party_leader_grace_seconds', 120));
  v_idle interval := make_interval(secs => public.matchmaking_setting('party_idle_seconds', 1800));
  v_expired integer := 0;
  v_timeouts integer := 0;
  v_failed integer := 0;
  v_repaired integer := 0;
  v_parties integer := 0;
  v_offenders uuid[];
  v_game uuid;
  v_heir uuid;
  r record;
  u uuid;
begin
  -- 1. Disconnected while searching.
  for r in
    select t.id from public.matchmaking_tickets t
    where t.status = 'QUEUED' and exists (
      select 1 from public.matchmaking_ticket_members m where m.ticket_id = t.id and m.active and m.last_seen_at < now() - v_grace
    )
    order by t.queued_at
    limit p_limit
    for update of t skip locked
  loop
    update public.matchmaking_tickets set status = 'EXPIRED', close_reason = 'DISCONNECTED' where id = r.id and status = 'QUEUED';
    v_expired := v_expired + 1;
  end loop;

  -- 2. Ready-up deadlines.
  for r in
    select m.id from public.matchmaking_matches m
    where m.status = 'READY_UP' and m.ready_deadline < now()
    order by m.ready_deadline
    limit p_limit
    for update skip locked
  loop
    select array_agg(p.user_id) into v_offenders from public.matchmaking_match_players p where p.match_id = r.id and p.ready_at is null;
    if v_offenders is null then
      -- Everyone confirmed; only the hand-over to STARTING is missing.
      update public.matchmaking_matches set status = 'STARTING', all_ready_at = now(),
        start_deadline = now() + make_interval(secs => public.matchmaking_setting('start_grace_seconds', 30))
      where id = r.id and status = 'READY_UP';
      v_repaired := v_repaired + 1;
    else
      foreach u in array v_offenders loop
        perform public.matchmaking_strike(u);
      end loop;
      perform public.matchmaking_cancel_match(r.id, 'CANCELLED', 'READY_TIMEOUT', v_offenders);
      v_timeouts := v_timeouts + 1;
    end if;
  end loop;

  -- 3. Games that were not created in time. If one exists after all, it is the truth.
  for r in
    select m.id from public.matchmaking_matches m
    where m.status = 'STARTING' and m.start_deadline < now()
    order by m.start_deadline
    limit p_limit
    for update skip locked
  loop
    select g.id into v_game from public.games g where g.matchmaking_match_id = r.id;
    if found then
      update public.matchmaking_matches set status = 'STARTED', game_id = v_game where id = r.id;
      update public.matchmaking_tickets set status = 'MATCHED', close_reason = 'MATCHED' where match_id = r.id and status = 'RESERVED';
      v_repaired := v_repaired + 1;
    else
      perform public.matchmaking_cancel_match(r.id, 'FAILED', 'START_TIMEOUT', '{}');
      v_failed := v_failed + 1;
    end if;
  end loop;

  -- 4. A reserved ticket whose reservation is over (should not exist; if it does, nobody stays stuck).
  for r in
    select t.id, m.status as match_status
    from public.matchmaking_tickets t
    join public.matchmaking_matches m on m.id = t.match_id
    where t.status = 'RESERVED' and m.status in ('STARTED', 'CANCELLED', 'FAILED')
    limit p_limit
    for update of t skip locked
  loop
    if r.match_status = 'STARTED' then
      update public.matchmaking_tickets set status = 'MATCHED', close_reason = 'MATCHED' where id = r.id;
    else
      update public.matchmaking_tickets set status = 'QUEUED', requeue_count = requeue_count + 1 where id = r.id;
    end if;
    v_repaired := v_repaired + 1;
  end loop;
  for r in
    select t.id from public.matchmaking_tickets t
    where t.status in ('QUEUED', 'RESERVED') and t.updated_at < now() - v_grace
      and not exists (select 1 from public.matchmaking_ticket_members m where m.ticket_id = t.id)
    limit p_limit
    for update of t skip locked
  loop
    if exists (select 1 from public.matchmaking_tickets t where t.id = r.id and t.status = 'RESERVED') then
      perform 1 from public.matchmaking_matches m where m.id = (select t.match_id from public.matchmaking_tickets t where t.id = r.id) for update;
      perform public.matchmaking_cancel_match((select t.match_id from public.matchmaking_tickets t where t.id = r.id), 'FAILED', 'INVALID_RESERVATION', '{}');
    end if;
    update public.matchmaking_tickets set status = 'FAILED', close_reason = 'ORPHANED' where id = r.id and status in ('QUEUED', 'RESERVED');
    v_repaired := v_repaired + 1;
  end loop;

  -- 5. Parties.
  update public.party_invitations set status = 'expired' where status = 'pending' and expires_at <= now();
  for r in
    select p.id from public.parties p
    join public.party_members lm on lm.party_id = p.id and lm.user_id = p.leader_user_id
    where lm.last_seen_at < now() - v_leader_grace
      and exists (select 1 from public.party_members m where m.party_id = p.id and m.user_id <> p.leader_user_id and m.last_seen_at > now() - v_grace)
    limit p_limit
    for update of p skip locked
  loop
    select m.user_id into v_heir from public.party_members m
    where m.party_id = r.id and m.last_seen_at > now() - v_grace
    order by m.joined_at, m.user_id limit 1;
    if v_heir is not null then
      update public.parties set leader_user_id = v_heir where id = r.id;
      insert into public.matchmaking_events (entity, entity_id, reason) values ('party', r.id, 'LEADER_CHANGED');
      perform public.matchmaking_touch_party(r.id);
      v_parties := v_parties + 1;
    end if;
  end loop;
  for r in
    select p.id from public.parties p
    where p.updated_at < now() - v_idle
      and public.matchmaking_party_ticket(p.id) is null
      and not exists (select 1 from public.party_members m where m.party_id = p.id and m.last_seen_at > now() - v_idle)
    limit p_limit
    for update of p skip locked
  loop
    perform public.matchmaking_touch_party(r.id);
    delete from public.parties where id = r.id;
    insert into public.matchmaking_events (entity, entity_id, reason) values ('party', r.id, 'IDLE_DISSOLVED');
    v_parties := v_parties + 1;
  end loop;

  -- Old rows. Bounded like everything else here.
  delete from public.matchmaking_tickets where id in (
    select t.id from public.matchmaking_tickets t where t.closed_at < now() - interval '7 days' limit p_limit
  );
  delete from public.matchmaking_matches where id in (
    select m.id from public.matchmaking_matches m
    where m.status in ('STARTED', 'CANCELLED', 'FAILED') and m.updated_at < now() - interval '7 days' limit p_limit
  );
  delete from public.party_invitations where id in (
    select i.id from public.party_invitations i where i.status <> 'pending' and i.updated_at < now() - interval '7 days' limit p_limit
  );
  delete from public.matchmaking_events where id in (
    select e.id from public.matchmaking_events e where e.at < now() - interval '30 days' limit p_limit * 10
  );
  delete from public.matchmaking_cooldowns c where coalesce(c.last_strike_at, now()) < now() - interval '1 day';

  if v_expired + v_timeouts + v_failed + v_repaired + v_parties > 0 then
    insert into public.matchmaking_events (entity, reason, detail)
    values ('run', 'SWEEP', jsonb_build_object('expired', v_expired, 'ready_timeouts', v_timeouts, 'start_failures', v_failed, 'repaired', v_repaired, 'parties', v_parties));
  end if;
  return jsonb_build_object('expired', v_expired, 'ready_timeouts', v_timeouts, 'start_failures', v_failed, 'repaired', v_repaired, 'parties', v_parties);
end;
$$;

-- ---------------------------------------------------------------------------
-- matchmaking_metrics(): what an operator looks at. Counts and durations only.
--   select public.matchmaking_metrics();              -- the last hour
--   select public.matchmaking_metrics(interval '1 day');
-- ---------------------------------------------------------------------------
create function public.matchmaking_metrics(p_window interval default interval '1 hour') returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'at', now(),
    'window_seconds', extract(epoch from p_window),
    'queue', coalesce((
      select jsonb_object_agg(q.mode, jsonb_build_object('tickets', q.tickets, 'players', q.players, 'oldest_wait_seconds', q.oldest))
      from (
        select t.mode, count(*) as tickets, sum(t.player_count) as players, floor(extract(epoch from (now() - min(t.queued_at)))) as oldest
        from public.matchmaking_tickets t where t.status = 'QUEUED' group by t.mode
      ) q
    ), '{}'::jsonb),
    'ready_up_now', (select count(*) from public.matchmaking_matches m where m.status = 'READY_UP'),
    'starting_now', (select count(*) from public.matchmaking_matches m where m.status = 'STARTING'),
    -- Stale: should have moved on already. Anything above 0 for long means the scheduler is not running.
    'stale', jsonb_build_object(
      'queued_tickets_silent', (
        select count(*) from public.matchmaking_tickets t
        where t.status = 'QUEUED' and exists (
          select 1 from public.matchmaking_ticket_members m
          where m.ticket_id = t.id and m.active
            and m.last_seen_at < now() - make_interval(secs => 2 * public.matchmaking_setting('reconnect_grace_seconds', 30))
        )
      ),
      'ready_up_overdue', (select count(*) from public.matchmaking_matches m where m.status = 'READY_UP' and m.ready_deadline < now() - interval '10 seconds'),
      'starting_overdue', (select count(*) from public.matchmaking_matches m where m.status = 'STARTING' and m.start_deadline < now() - interval '10 seconds')
    ),
    'wait_seconds', (
      select jsonb_build_object(
        'matched', count(*),
        'avg', round(avg(w.s)::numeric, 1),
        'p50', round((percentile_cont(0.5) within group (order by w.s))::numeric, 1),
        'p90', round((percentile_cont(0.9) within group (order by w.s))::numeric, 1),
        'p99', round((percentile_cont(0.99) within group (order by w.s))::numeric, 1)
      )
      from (
        select extract(epoch from (t.closed_at - t.queued_at)) as s
        from public.matchmaking_tickets t where t.status = 'MATCHED' and t.closed_at > now() - p_window
      ) w
    ),
    'tickets_closed', coalesce((
      select jsonb_object_agg(c.k, c.n)
      from (
        select t.status || coalesce(':' || t.close_reason, '') as k, count(*) as n
        from public.matchmaking_tickets t where t.closed_at > now() - p_window group by 1
      ) c
    ), '{}'::jsonb),
    'matches', (
      select jsonb_build_object(
        'reserved', count(*),
        'started', count(*) filter (where m.status = 'STARTED'),
        'ready_timeouts', count(*) filter (where m.close_reason = 'READY_TIMEOUT'),
        'declined', count(*) filter (where m.close_reason = 'DECLINED'),
        'player_left', count(*) filter (where m.close_reason = 'PLAYER_LEFT'),
        'failed', count(*) filter (where m.status = 'FAILED'),
        'ready_timeout_rate', case when count(*) = 0 then null else round(count(*) filter (where m.close_reason = 'READY_TIMEOUT')::numeric / count(*), 3) end,
        'creation_latency_ms_avg', round(avg(extract(epoch from (m.started_at - m.all_ready_at)) * 1000) filter (where m.status = 'STARTED')),
        'creation_latency_ms_max', round(max(extract(epoch from (m.started_at - m.all_ready_at)) * 1000) filter (where m.status = 'STARTED'))
      )
      from public.matchmaking_matches m where m.created_at > now() - p_window
    ),
    'match_sizes', coalesce((
      select jsonb_object_agg(s.player_count::text, s.n)
      from (
        select m.player_count, count(*) as n from public.matchmaking_matches m
        where m.status = 'STARTED' and m.created_at > now() - p_window group by m.player_count
      ) s
    ), '{}'::jsonb),
    'requeues', (select count(*) from public.matchmaking_events e where e.entity = 'ticket' and e.from_status = 'RESERVED' and e.to_status = 'QUEUED' and e.at > now() - p_window),
    'duplicate_requests', (select count(*) from public.matchmaking_events e where e.reason = 'DUPLICATE_ENQUEUE' and e.at > now() - p_window),
    'start_attempt_failures', (select count(*) from public.matchmaking_events e where e.reason = 'START_ATTEMPT_FAILED' and e.at > now() - p_window),
    'worker', (
      select jsonb_build_object(
        'runs', count(*),
        'failures', count(*) filter (where (e.detail ->> 'error') is not null),
        'duration_ms_avg', round(avg((e.detail ->> 'duration_ms')::numeric)),
        'duration_ms_max', max((e.detail ->> 'duration_ms')::numeric),
        'last_run_at', max(e.at)
      )
      from public.matchmaking_events e where e.entity = 'run' and e.reason = 'RUN' and e.at > now() - p_window
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Scheduler. The sweep is plain SQL, so pg_cron runs it by itself. The matcher and the game
-- creation run in the `matchmaking` Edge Function (they need the game engine); pg_cron calls it
-- through pg_net when the two Vault secrets below exist:
--   matchmaking_tick_url   https://<project-ref>.supabase.co/functions/v1/matchmaking
--   matchmaking_tick_key   the project's publishable (anon) key
-- Without them this does nothing, and searching apps still nudge the worker (settings.client_tick).
-- ---------------------------------------------------------------------------
create function public.matchmaking_cron_tick() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  -- Nothing waiting: no request at all.
  if not exists (select 1 from public.matchmaking_tickets t where t.status = 'QUEUED')
     and not exists (select 1 from public.matchmaking_matches m where m.status in ('READY_UP', 'STARTING')) then
    return;
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regproc('net.http_post') is null then
    return;
  end if;
  execute 'select s.decrypted_secret from vault.decrypted_secrets s where s.name = $1' into v_url using 'matchmaking_tick_url';
  if v_url is null or v_url = '' then
    return;
  end if;
  execute 'select s.decrypted_secret from vault.decrypted_secrets s where s.name = $1' into v_key using 'matchmaking_tick_key';
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)'
    using v_url, jsonb_build_object('op', 'tick', 'source', 'cron'),
          jsonb_build_object('Content-Type', 'application/json', 'apikey', coalesce(v_key, ''), 'Authorization', 'Bearer ' || coalesce(v_key, ''));
end;
$$;

-- Supabase has pg_cron and pg_net; a plain Postgres (the local test database) has neither and
-- skips this. A failure here never fails the migration: the README says how to schedule by hand.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      if exists (select 1 from pg_available_extensions where name = 'pg_net') then
        create extension if not exists pg_net;
      end if;
      perform cron.unschedule(j.jobid) from cron.job j where j.jobname in ('matchmaking-sweep', 'matchmaking-tick');
      perform cron.schedule('matchmaking-sweep', '10 seconds', 'select public.matchmaking_sweep()');
      perform cron.schedule('matchmaking-tick', '5 seconds', 'select public.matchmaking_cron_tick()');
    exception
      when others then
        raise notice 'matchmaking: the scheduler was not set up here (%). See README, "Random matchmaking".', sqlerrm;
    end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down.
-- ---------------------------------------------------------------------------
alter table public.matchmaking_settings enable row level security;
alter table public.matchmaking_sync enable row level security;
alter table public.matchmaking_touch_queue enable row level security;
alter table public.matchmaking_events enable row level security;
alter table public.matchmaking_runs enable row level security;
alter table public.parties enable row level security;
alter table public.party_members enable row level security;
alter table public.party_invitations enable row level security;
alter table public.matchmaking_matches enable row level security;
alter table public.matchmaking_tickets enable row level security;
alter table public.matchmaking_ticket_members enable row level security;
alter table public.matchmaking_match_players enable row level security;
alter table public.matchmaking_cooldowns enable row level security;

revoke all on public.matchmaking_settings from anon, authenticated;
revoke all on public.matchmaking_sync from anon, authenticated;
revoke all on public.matchmaking_touch_queue from anon, authenticated;
revoke all on public.matchmaking_events from anon, authenticated;
revoke all on public.matchmaking_runs from anon, authenticated;
revoke all on public.parties from anon, authenticated;
revoke all on public.party_members from anon, authenticated;
revoke all on public.party_invitations from anon, authenticated;
revoke all on public.matchmaking_matches from anon, authenticated;
revoke all on public.matchmaking_tickets from anon, authenticated;
revoke all on public.matchmaking_ticket_members from anon, authenticated;
revoke all on public.matchmaking_match_players from anon, authenticated;
revoke all on public.matchmaking_cooldowns from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- The one thing the app reads directly (through Realtime): its own change counter.
create policy matchmaking_sync_select_own on public.matchmaking_sync
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.matchmaking_sync to authenticated;

-- Every function of this migration: nobody but the server. Then the app's own, to signed-in players.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'matchmaking\_%' or p.proname like 'party\_%')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.signature);
  end loop;
end;
$$;

grant execute on function public.matchmaking_state() to authenticated;
grant execute on function public.matchmaking_heartbeat() to authenticated;
grant execute on function public.matchmaking_enqueue(text, text) to authenticated;
grant execute on function public.matchmaking_cancel() to authenticated;
grant execute on function public.matchmaking_ready(uuid, text) to authenticated;
grant execute on function public.matchmaking_decline(uuid) to authenticated;
grant execute on function public.party_create(text) to authenticated;
grant execute on function public.party_invite(text) to authenticated;
grant execute on function public.party_respond_invite(uuid, boolean) to authenticated;
grant execute on function public.party_revoke_invite(uuid) to authenticated;
grant execute on function public.party_set_mode(text) to authenticated;
grant execute on function public.party_set_ready(boolean) to authenticated;
grant execute on function public.party_leave() to authenticated;
grant execute on function public.party_kick(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: deliver changes of matchmaking_sync (and nothing else) to its owner. The publication
-- exists on Supabase; a plain Postgres (the local test database) has none and skips this.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matchmaking_sync'
     ) then
    alter publication supabase_realtime add table public.matchmaking_sync;
  end if;
end;
$$;
