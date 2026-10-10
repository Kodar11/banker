-- Friends, private game invitations, presence keys and in-app notifications.
--
-- Additive only. Every existing game and account keeps working unchanged:
--   * players.user_id stays null for every seat an account never claimed (older apps, and games
--     that were running before this migration). Nothing in the game engine reads it.
--   * games.lobby_locked defaults to false: every lobby is open exactly as before.
-- Deploy this BEFORE the game-action function that reads and writes lobby_locked.
--
-- Security model (the same as profiles)
--   * RLS is on for every table here and nothing is granted to the client roles, with ONE
--     exception: a player may SELECT their own social_sync row (a version counter with no content),
--     which is what Realtime delivers to tell a phone "something of yours changed — refetch".
--   * Every read and write goes through the SECURITY DEFINER functions below. They act on
--     auth.uid() and never take a user id from the caller; other players are named only by their
--     public Player ID, and a function decides for itself whether the caller may do what it asks.
--   * No auth user id, email or token of another player ever leaves the server. A friend is known
--     to the app by Player ID, nickname and a presence key (see profiles.presence_key).
--   * Friend requests, friendships, invitations and notifications reference profiles ON DELETE
--     CASCADE: deleting an account (auth.users -> profiles) removes every one of them in the same
--     transaction, and the triggers below tell the players on the other side to refetch.
--     players.user_id is ON DELETE SET NULL: a game never changes because an account was deleted.

-- ---------------------------------------------------------------------------
-- Additions to existing tables
-- ---------------------------------------------------------------------------

-- The Realtime Presence topic of a player ("presence:<key>"). Unguessable, given only to the
-- player and their current friends, and replaced whenever a friendship ends or a block is made,
-- so a former friend cannot keep watching. Presence is informational: it authorises nothing.
alter table public.profiles add column presence_key uuid not null default gen_random_uuid();
create unique index profiles_presence_key_idx on public.profiles (presence_key);

-- Which account sits in a seat, when one has claimed it (claim_seat, with the seat's device token).
-- Used only by the social functions: who may invite into a game, and who can be befriended from it.
alter table public.players add column user_id uuid references auth.users (id) on delete set null;
create unique index players_game_user_idx on public.players (game_id, user_id) where user_id is not null and status <> 'LEFT';
create index players_user_idx on public.players (user_id) where user_id is not null;

-- The host closed admission. Read and written by the game-action function under the game row lock.
alter table public.games add column lobby_locked boolean not null default false;

-- ---------------------------------------------------------------------------
-- Limits (data: change a row without a deploy). The app cannot read them.
--   lookup               Player ID lookups (and friend requests, which resolve an ID)
--   friend_request       new friend requests, to anyone
--   friend_request_pair  new friend requests to one player (cancel + resend, resend after expiry)
--   game_invite          new direct game invitations, to anyone
--   game_invite_pair     new direct game invitations to one player
-- ---------------------------------------------------------------------------
create table public.social_limits (
  key text primary key,
  max_count integer not null check (max_count > 0),
  window_seconds integer not null check (window_seconds > 0)
);

insert into public.social_limits (key, max_count, window_seconds) values
  ('lookup', 30, 60),
  ('friend_request', 20, 3600),
  ('friend_request_pair', 3, 604800),
  ('game_invite', 30, 600),
  ('game_invite_pair', 5, 600);

create table public.social_rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  action text not null,
  target_user_id uuid references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now()
);

create index social_rate_events_idx on public.social_rate_events (user_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Friend requests. One row per request; `pending` and `declined` are both "open": a declined
-- request keeps looking pending to its sender until it expires or they cancel it, so declining
-- tells the sender nothing. Expiry is a comparison with now() wherever a request is read; the
-- status is brought in line lazily (and by social_cleanup()).
-- ---------------------------------------------------------------------------
create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references public.profiles (user_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint friend_requests_not_self check (sender_user_id <> recipient_user_id)
);

-- At most one open request per direction.
create unique index friend_requests_open_idx on public.friend_requests (sender_user_id, recipient_user_id)
  where status in ('pending', 'declined');
create index friend_requests_recipient_idx on public.friend_requests (recipient_user_id, created_at desc) where status = 'pending';
create index friend_requests_expiry_idx on public.friend_requests (expires_at) where status in ('pending', 'declined');

-- ---------------------------------------------------------------------------
-- Friendships. One row per pair, always stored low id first: the primary key makes a second
-- friendship of the same two players impossible, whoever asked and however the requests raced.
-- ---------------------------------------------------------------------------
create table public.friendships (
  user_low uuid not null references public.profiles (user_id) on delete cascade,
  user_high uuid not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  constraint friendships_ordered check (user_low < user_high)
);

create index friendships_high_idx on public.friendships (user_high);

-- ---------------------------------------------------------------------------
-- Blocks. Directional; every rule that reads them applies in both directions.
-- ---------------------------------------------------------------------------
create table public.player_blocks (
  blocker_user_id uuid not null references public.profiles (user_id) on delete cascade,
  blocked_user_id uuid not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint player_blocks_not_self check (blocker_user_id <> blocked_user_id)
);

create index player_blocks_blocked_idx on public.player_blocks (blocked_user_id);

-- ---------------------------------------------------------------------------
-- Direct game invitations. An invitation names a game; it carries no credential and is never a
-- way into a game by itself: joining is the normal join (code -> game-action), which checks the
-- lobby's status, lock and capacity again under the game row lock.
-- ---------------------------------------------------------------------------
create table public.game_invitations (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  inviter_user_id uuid not null references public.profiles (user_id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint game_invitations_not_self check (inviter_user_id <> recipient_user_id)
);

-- A retry never creates a second live invitation of the same player to the same game.
create unique index game_invitations_live_idx on public.game_invitations (game_id, inviter_user_id, recipient_user_id)
  where status = 'pending';
create index game_invitations_recipient_idx on public.game_invitations (recipient_user_id, created_at desc);
create index game_invitations_game_idx on public.game_invitations (game_id) where status = 'pending';
create index game_invitations_expiry_idx on public.game_invitations (expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Notifications: durable, one row per thing worth telling a player. Written only by the functions
-- below. (recipient, deduplication_key) is unique, so an event processed twice is told once.
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles (user_id) on delete cascade,
  event_type text not null check (event_type in ('friend_request', 'friend_accepted', 'friends_matched', 'game_invite')),
  -- The other player. Their nickname is read when the notification is shown, never stored here.
  actor_user_id uuid references public.profiles (user_id) on delete cascade,
  related_entity_id uuid,
  deduplication_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_dedup_key unique (recipient_user_id, deduplication_key)
);

create index notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- The change counter. One row per player, bumped (by the triggers below) whenever anything that
-- player can see changes. Realtime sends the new version; the app refetches social_state() when
-- it is behind. The row has no content, so a duplicate, late or missing event can never show
-- anything wrong.
-- ---------------------------------------------------------------------------
create table public.social_sync (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- Only players who still have a profile (a row being removed by an account deletion is skipped).
create function public.social_touch(p_user uuid) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.social_sync (user_id)
  select p.user_id from public.profiles p where p.user_id = p_user
  on conflict (user_id) do update set version = public.social_sync.version + 1, updated_at = now();
$$;

-- Always in id order, so two transactions touching the same players can never deadlock.
create function public.social_touch_pair(p_a uuid, p_b uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_a is null or p_b is null or p_a = p_b then
    perform public.social_touch(coalesce(p_a, p_b));
  elsif p_a < p_b then
    perform public.social_touch(p_a);
    perform public.social_touch(p_b);
  else
    perform public.social_touch(p_b);
    perform public.social_touch(p_a);
  end if;
end;
$$;

create function public.social_touch_trigger() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if tg_op = 'DELETE' then
    r := old;
  else
    r := new;
  end if;
  case tg_table_name
    when 'friend_requests' then perform public.social_touch_pair(r.sender_user_id, r.recipient_user_id);
    when 'friendships' then perform public.social_touch_pair(r.user_low, r.user_high);
    when 'game_invitations' then perform public.social_touch_pair(r.inviter_user_id, r.recipient_user_id);
    when 'player_blocks' then perform public.social_touch(r.blocker_user_id);
    when 'notifications' then perform public.social_touch(r.recipient_user_id);
  end case;
  return null;
end;
$$;

create trigger friend_requests_touch after insert or update or delete on public.friend_requests
  for each row execute function public.social_touch_trigger();
create trigger friendships_touch after insert or update or delete on public.friendships
  for each row execute function public.social_touch_trigger();
create trigger game_invitations_touch after insert or update or delete on public.game_invitations
  for each row execute function public.social_touch_trigger();
create trigger player_blocks_touch after insert or update or delete on public.player_blocks
  for each row execute function public.social_touch_trigger();
create trigger notifications_touch after insert or update or delete on public.notifications
  for each row execute function public.social_touch_trigger();

create function public.social_set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger friend_requests_updated before update on public.friend_requests
  for each row execute function public.social_set_updated_at();
create trigger game_invitations_updated before update on public.game_invitations
  for each row execute function public.social_set_updated_at();

-- ---------------------------------------------------------------------------
-- Internal helpers (never callable by the app)
-- ---------------------------------------------------------------------------

-- Trim, drop spaces, upper-case, accept a missing dash. null when it is not a Player ID.
-- src/features/social/playerId.ts does the same on the phone for instant feedback; THIS is the authority.
create function public.normalize_player_id(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select case when v ~ '^RR-[2-9A-HJ-NP-Z]{6}$' then v end
  from (
    select regexp_replace(upper(regexp_replace(coalesce(p_raw, ''), '[[:space:]]', '', 'g')), '^RR([2-9A-HJ-NP-Z]{6})$', 'RR-\1') as v
  ) s;
$$;

-- The most friends one player can have (also bounds the presence channels a phone opens).
create function public.social_max_friends() returns integer
language sql
immutable
set search_path = ''
as $$ select 200 $$;

-- Seats at a table. Mirrors the engine's BUSINESS_MVP_RULES.players.max (tests/server/social.test.ts
-- fails if they drift). Only used to describe an invitation; the join itself is checked by the engine.
create function public.social_game_capacity() returns integer
language sql
immutable
set search_path = ''
as $$ select 8 $$;

create function public.social_request_ttl() returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

create function public.social_invite_ttl() returns interval
language sql
immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

-- Serialises everything that concerns one pair of players: A->B and B->A requests, accept,
-- remove, block and invite all wait for one another, whichever side starts.
create function public.social_lock_pair(p_a uuid, p_b uuid) returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('social-pair:' || least(p_a, p_b)::text || ':' || greatest(p_a, p_b)::text, 0));
$$;

create function public.social_are_friends(p_a uuid, p_b uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.friendships f where f.user_low = least(p_a, p_b) and f.user_high = greatest(p_a, p_b));
$$;

create function public.social_has_blocked(p_blocker uuid, p_blocked uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.player_blocks b where b.blocker_user_id = p_blocker and b.blocked_user_id = p_blocked);
$$;

create function public.social_friend_count(p_user uuid) returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.friendships f where f.user_low = p_user or f.user_high = p_user;
$$;

-- What one player may know about another: the public Player ID and the current nickname.
create function public.social_public_profile(p_user uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('player_id', p.player_id, 'nickname', p.nickname) from public.profiles p where p.user_id = p_user;
$$;

-- 0 when the action is within its limit (and it is now counted); otherwise the seconds to wait.
create function public.social_rate_hit(p_user uuid, p_key text, p_target uuid default null) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_max integer;
  v_window integer;
  v_count integer;
  v_oldest timestamptz;
begin
  select l.max_count, l.window_seconds into v_max, v_window from public.social_limits l where l.key = p_key;
  if not found then
    return 0;
  end if;
  -- One player's counters are read and written by one request at a time.
  perform pg_advisory_xact_lock(hashtextextended('social-rate:' || p_user::text, 0));
  select count(*), min(e.created_at) into v_count, v_oldest
  from public.social_rate_events e
  where e.user_id = p_user and e.action = p_key
    and (p_target is null or e.target_user_id = p_target)
    and e.created_at > now() - make_interval(secs => v_window);
  if v_count >= v_max then
    return greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => v_window) - now())))::integer);
  end if;
  insert into public.social_rate_events (user_id, action, target_user_id) values (p_user, p_key, p_target);
  return 0;
end;
$$;

create function public.social_notify(p_recipient uuid, p_type text, p_actor uuid, p_entity uuid, p_key text) returns void
language sql
set search_path = ''
as $$
  insert into public.notifications (recipient_user_id, event_type, actor_user_id, related_entity_id, deduplication_key)
  values (p_recipient, p_type, p_actor, p_entity, p_key)
  on conflict (recipient_user_id, deduplication_key) do nothing;
$$;

-- Gives a player a new presence topic and tells them and their friends to pick it up.
create function public.social_rotate_presence(p_user uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.profiles set presence_key = gen_random_uuid() where user_id = p_user;
  insert into public.social_sync (user_id)
  select x.user_id
  from (
    select p_user as user_id
    union
    select case when f.user_low = p_user then f.user_high else f.user_low end
    from public.friendships f
    where f.user_low = p_user or f.user_high = p_user
  ) x
  join public.profiles p on p.user_id = x.user_id
  order by x.user_id
  on conflict (user_id) do update set version = public.social_sync.version + 1, updated_at = now();
end;
$$;

-- Ends a friendship (if there is one) and replaces both presence topics. True when one ended.
create function public.social_unfriend(p_a uuid, p_b uuid) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from public.friendships f where f.user_low = least(p_a, p_b) and f.user_high = greatest(p_a, p_b);
  if not found then
    return false;
  end if;
  perform public.social_rotate_presence(least(p_a, p_b));
  perform public.social_rotate_presence(greatest(p_a, p_b));
  return true;
end;
$$;

-- Requests of this pair whose time is up stop being open (so a fresh one can be sent).
create function public.social_expire_requests(p_a uuid, p_b uuid) returns void
language sql
set search_path = ''
as $$
  update public.friend_requests r set status = 'expired'
  where r.status in ('pending', 'declined') and r.expires_at <= now()
    and ((r.sender_user_id = p_a and r.recipient_user_id = p_b) or (r.sender_user_id = p_b and r.recipient_user_id = p_a));
$$;

-- How two players stand, as the first one may see it. A block by the OTHER player reads as 'none':
-- being blocked is never shown (asking them anything then answers UNAVAILABLE).
create function public.social_relationship(p_me uuid, p_other uuid) returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_me = p_other then 'self'
    when public.social_has_blocked(p_me, p_other) then 'blocked'
    when public.social_has_blocked(p_other, p_me) then 'none'
    when public.social_are_friends(p_me, p_other) then 'friends'
    when exists (
      select 1 from public.friend_requests r
      where r.sender_user_id = p_me and r.recipient_user_id = p_other and r.status in ('pending', 'declined') and r.expires_at > now()
    ) then 'outgoing'
    when exists (
      select 1 from public.friend_requests r
      where r.sender_user_id = p_other and r.recipient_user_id = p_me and r.status = 'pending' and r.expires_at > now()
    ) then 'incoming'
    else 'none'
  end;
$$;

-- Whether an invitation can still be used, decided from the game as it is NOW:
-- open | started | closed | expired | locked | full.
create function public.social_invite_state(p_game_id uuid, p_expires_at timestamptz) returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select case
        when g.status = 'FINISHED' or g.expires_at <= now() then 'closed'
        when g.status <> 'WAITING' then 'started'
        when p_expires_at <= now() then 'expired'
        when g.lobby_locked then 'locked'
        when (select count(*) from public.players p where p.game_id = g.id and p.status <> 'LEFT') >= public.social_game_capacity() then 'full'
        else 'open'
      end
      from public.games g
      where g.id = p_game_id
    ),
    'closed'
  );
$$;

-- The caller's seat in a game, if their account has claimed one and has not left.
create function public.social_seat_of(p_game_id uuid, p_user uuid) returns uuid
language sql
stable
set search_path = ''
as $$
  select p.id from public.players p where p.game_id = p_game_id and p.user_id = p_user and p.status <> 'LEFT' limit 1;
$$;

create function public.social_fail(p_code text, p_retry integer default null) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_retry is null then jsonb_build_object('ok', false, 'code', p_code)
              else jsonb_build_object('ok', false, 'code', p_code, 'retry_after_seconds', p_retry) end;
$$;

-- ---------------------------------------------------------------------------
-- lookup_player(): who is behind a Player ID. Returns the public profile and how the caller
-- stands with them — nothing else, and nothing about anyone who is not asked for by exact ID.
-- ---------------------------------------------------------------------------
create function public.lookup_player(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
  v_wait integer;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.social_fail('NO_PROFILE');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  v_wait := public.social_rate_hit(v_uid, 'lookup');
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  return jsonb_build_object(
    'ok', true,
    'player', public.social_public_profile(v_target),
    'relationship', public.social_relationship(v_uid, v_target)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- send_friend_request(): the sender is the caller, always. One transaction under the pair lock:
--   * already friends, or my request is already open  -> nothing new, the current state is returned
--   * THEIR request to me is open                     -> we are friends now (no acceptance needed)
--   * otherwise                                       -> a new pending request, 30 days
-- The answer always carries the relationship as it stands after the call.
-- ---------------------------------------------------------------------------
create function public.send_friend_request(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
  v_wait integer;
  v_theirs public.friend_requests;
  v_id uuid;
  v_player jsonb;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.social_fail('NO_PROFILE');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  -- Resolving an ID here counts as a lookup: the limit cannot be walked around.
  v_wait := public.social_rate_hit(v_uid, 'lookup');
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  if v_target = v_uid then
    return public.social_fail('SELF');
  end if;

  perform public.social_lock_pair(v_uid, v_target);
  v_player := public.social_public_profile(v_target);

  if public.social_has_blocked(v_uid, v_target) then
    return public.social_fail('BLOCKED_BY_YOU');
  end if;
  if public.social_has_blocked(v_target, v_uid) then
    return public.social_fail('UNAVAILABLE');
  end if;
  if public.social_are_friends(v_uid, v_target) then
    return jsonb_build_object('ok', true, 'relationship', 'friends', 'created', false, 'matched', false, 'player', v_player);
  end if;

  perform public.social_expire_requests(v_uid, v_target);

  select r.id into v_id from public.friend_requests r
  where r.sender_user_id = v_uid and r.recipient_user_id = v_target and r.status in ('pending', 'declined');
  if found then
    return jsonb_build_object('ok', true, 'relationship', 'outgoing', 'created', false, 'matched', false, 'request_id', v_id, 'player', v_player);
  end if;

  -- Their open request to me. A request they sent and I declined counts too: it is still theirs
  -- (they have not cancelled it), and now I am asking as well.
  select * into v_theirs from public.friend_requests r
  where r.sender_user_id = v_target and r.recipient_user_id = v_uid and r.status in ('pending', 'declined')
  for update;
  if found then
    if public.social_friend_count(v_uid) >= public.social_max_friends() then
      return public.social_fail('FRIEND_LIMIT');
    end if;
    if public.social_friend_count(v_target) >= public.social_max_friends() then
      return public.social_fail('UNAVAILABLE');
    end if;
    insert into public.friendships (user_low, user_high) values (least(v_uid, v_target), greatest(v_uid, v_target))
    on conflict do nothing;
    update public.friend_requests set status = 'accepted' where id = v_theirs.id;
    -- The request they were told about is answered: its notification has nothing left to ask.
    delete from public.notifications n where n.event_type = 'friend_request' and n.related_entity_id = v_theirs.id;
    perform public.social_notify(v_uid, 'friends_matched', v_target, v_theirs.id, 'friends_matched:' || v_theirs.id::text);
    perform public.social_notify(v_target, 'friends_matched', v_uid, v_theirs.id, 'friends_matched:' || v_theirs.id::text);
    return jsonb_build_object('ok', true, 'relationship', 'friends', 'created', false, 'matched', true, 'player', v_player);
  end if;

  if public.social_friend_count(v_uid) >= public.social_max_friends() then
    return public.social_fail('FRIEND_LIMIT');
  end if;
  if public.social_friend_count(v_target) >= public.social_max_friends() then
    return public.social_fail('UNAVAILABLE');
  end if;
  v_wait := public.social_rate_hit(v_uid, 'friend_request_pair', v_target);
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;
  v_wait := public.social_rate_hit(v_uid, 'friend_request');
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;

  insert into public.friend_requests (sender_user_id, recipient_user_id, expires_at)
  values (v_uid, v_target, now() + public.social_request_ttl())
  returning id into v_id;
  perform public.social_notify(v_target, 'friend_request', v_uid, v_id, 'friend_request:' || v_id::text);
  return jsonb_build_object('ok', true, 'relationship', 'outgoing', 'created', true, 'matched', false, 'request_id', v_id, 'player', v_player);
end;
$$;

-- ---------------------------------------------------------------------------
-- respond_friend_request(): accept or decline. Only the recipient can; to anyone else the
-- request does not exist. Repeating an answer that was already given changes nothing.
-- ---------------------------------------------------------------------------
create function public.respond_friend_request(p_request_id uuid, p_accept boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.friend_requests;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if p_request_id is null or p_accept is null then
    return public.social_fail('VALIDATION');
  end if;
  select * into v_req from public.friend_requests r where r.id = p_request_id and r.recipient_user_id = v_uid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;

  perform public.social_lock_pair(v_uid, v_req.sender_user_id);
  -- Read again, now that nothing else can change this pair.
  select * into v_req from public.friend_requests r where r.id = p_request_id and r.recipient_user_id = v_uid for update;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;

  if v_req.status = 'accepted' or (p_accept and public.social_are_friends(v_uid, v_req.sender_user_id)) then
    return jsonb_build_object('ok', true, 'relationship', case when public.social_are_friends(v_uid, v_req.sender_user_id) then 'friends' else 'none' end);
  end if;
  if v_req.status = 'declined' and not p_accept then
    return jsonb_build_object('ok', true, 'relationship', 'none');
  end if;
  if v_req.status = 'pending' and v_req.expires_at <= now() then
    update public.friend_requests set status = 'expired' where id = v_req.id;
    return public.social_fail('REQUEST_EXPIRED');
  end if;
  if v_req.status <> 'pending' then
    return public.social_fail('REQUEST_GONE');
  end if;

  if not p_accept then
    update public.friend_requests set status = 'declined' where id = v_req.id;
    update public.notifications set read_at = now()
    where recipient_user_id = v_uid and event_type = 'friend_request' and related_entity_id = v_req.id and read_at is null;
    return jsonb_build_object('ok', true, 'relationship', 'none');
  end if;

  if public.social_has_blocked(v_uid, v_req.sender_user_id) or public.social_has_blocked(v_req.sender_user_id, v_uid) then
    return public.social_fail('UNAVAILABLE');
  end if;
  if public.social_friend_count(v_uid) >= public.social_max_friends() then
    return public.social_fail('FRIEND_LIMIT');
  end if;
  if public.social_friend_count(v_req.sender_user_id) >= public.social_max_friends() then
    return public.social_fail('UNAVAILABLE');
  end if;
  insert into public.friendships (user_low, user_high)
  values (least(v_uid, v_req.sender_user_id), greatest(v_uid, v_req.sender_user_id))
  on conflict do nothing;
  update public.friend_requests set status = 'accepted' where id = v_req.id;
  -- A request of mine to them that was still open is settled by the same friendship.
  update public.friend_requests set status = 'accepted'
  where sender_user_id = v_uid and recipient_user_id = v_req.sender_user_id and status in ('pending', 'declined');
  update public.notifications set read_at = now()
  where recipient_user_id = v_uid and event_type = 'friend_request' and related_entity_id = v_req.id and read_at is null;
  perform public.social_notify(v_req.sender_user_id, 'friend_accepted', v_uid, v_req.id, 'friend_accepted:' || v_req.id::text);
  return jsonb_build_object('ok', true, 'relationship', 'friends');
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_friend_request(): only the sender, only a request that is still open. It can never end
-- a friendship: an accepted request answers ALREADY_FRIENDS and nothing changes.
-- ---------------------------------------------------------------------------
create function public.cancel_friend_request(p_request_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.friend_requests;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  select * into v_req from public.friend_requests r where r.id = p_request_id and r.sender_user_id = v_uid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  perform public.social_lock_pair(v_uid, v_req.recipient_user_id);
  select * into v_req from public.friend_requests r where r.id = p_request_id and r.sender_user_id = v_uid for update;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  if v_req.status = 'accepted' then
    return public.social_fail('ALREADY_FRIENDS');
  end if;
  if v_req.status in ('pending', 'declined') then
    update public.friend_requests set status = 'cancelled' where id = v_req.id;
    -- Nobody is told about a request that no longer exists.
    delete from public.notifications n where n.event_type = 'friend_request' and n.related_entity_id = v_req.id;
  end if;
  return jsonb_build_object('ok', true, 'relationship', 'none');
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_friend(): either friend can. Game history is not touched (games do not refer to
-- friendships). Removing someone who is not a friend changes nothing.
-- ---------------------------------------------------------------------------
create function public.remove_friend(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  -- Gone already (their account was deleted): the friendship went with it.
  if not found or v_target = v_uid then
    return jsonb_build_object('ok', true, 'removed', false);
  end if;
  perform public.social_lock_pair(v_uid, v_target);
  return jsonb_build_object('ok', true, 'removed', public.social_unfriend(v_uid, v_target));
end;
$$;

-- ---------------------------------------------------------------------------
-- block_player() / unblock_player(). A block ends the friendship, withdraws every open request
-- and invitation between the two (both directions) and, from then on, refuses new ones in both
-- directions. It does not take anyone out of a game they are both already in.
-- ---------------------------------------------------------------------------
create function public.block_player(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.social_fail('NO_PROFILE');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  if v_target = v_uid then
    return public.social_fail('SELF');
  end if;

  perform public.social_lock_pair(v_uid, v_target);
  insert into public.player_blocks (blocker_user_id, blocked_user_id) values (v_uid, v_target) on conflict do nothing;
  if not public.social_unfriend(v_uid, v_target) then
    -- Not friends, but they may have been given my presence topic earlier in this session.
    perform public.social_rotate_presence(v_uid);
  end if;
  update public.friend_requests r set status = 'cancelled'
  where r.status in ('pending', 'declined')
    and ((r.sender_user_id = v_uid and r.recipient_user_id = v_target) or (r.sender_user_id = v_target and r.recipient_user_id = v_uid));
  update public.game_invitations i set status = 'revoked'
  where i.status = 'pending'
    and ((i.inviter_user_id = v_uid and i.recipient_user_id = v_target) or (i.inviter_user_id = v_target and i.recipient_user_id = v_uid));
  delete from public.notifications n
  where (n.recipient_user_id = v_uid and n.actor_user_id = v_target) or (n.recipient_user_id = v_target and n.actor_user_id = v_uid);
  return jsonb_build_object('ok', true, 'relationship', 'blocked');
end;
$$;

create function public.unblock_player(p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if found and v_target <> v_uid then
    perform public.social_lock_pair(v_uid, v_target);
    delete from public.player_blocks b where b.blocker_user_id = v_uid and b.blocked_user_id = v_target;
  end if;
  return jsonb_build_object('ok', true, 'relationship', 'none');
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_seat(): ties the caller's account to a seat they hold. Holding a seat is proved the way
-- the game-action function proves it — the device token, compared by its SHA-256 — so an account
-- can never attach itself to someone else's seat. The seat follows the phone: if the phone
-- switches to another account, the next claim moves the seat to it.
-- Joining a game also settles every invitation the caller had to it.
-- ---------------------------------------------------------------------------
create function public.claim_seat(p_game_id uuid, p_seat_id uuid, p_token text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_seat public.players;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.profiles where user_id = v_uid) then
    return public.social_fail('NO_PROFILE');
  end if;
  if p_game_id is null or p_seat_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return public.social_fail('FORBIDDEN');
  end if;
  select * into v_seat from public.players p where p.id = p_seat_id and p.game_id = p_game_id for update;
  if not found or v_seat.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') then
    return public.social_fail('FORBIDDEN');
  end if;
  if v_seat.status = 'LEFT' then
    return public.social_fail('NOT_IN_GAME');
  end if;
  if v_seat.user_id is distinct from v_uid then
    begin
      update public.players set user_id = v_uid where id = v_seat.id;
    exception
      when unique_violation then
        -- This account already sits at this table on another phone.
        return public.social_fail('ALREADY_SEATED');
    end;
  end if;
  update public.game_invitations set status = 'accepted'
  where game_id = p_game_id and recipient_user_id = v_uid and status = 'pending';
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- game_player_profiles(): who the other players at my table are, for "Add Friend" in the lobby
-- and during a game. Only for a player seated at that table, only seats an account has claimed,
-- only the public profile. A player who has blocked the caller is listed without one.
-- ---------------------------------------------------------------------------
create function public.game_player_profiles(p_game_id uuid) returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if public.social_seat_of(p_game_id, v_uid) is null then
    return public.social_fail('NOT_IN_GAME');
  end if;
  return jsonb_build_object(
    'ok', true,
    'players', coalesce(
      (
        select jsonb_agg(
          case when public.social_has_blocked(p.user_id, v_uid)
            then jsonb_build_object('seat_id', p.id, 'unavailable', true)
            else jsonb_build_object('seat_id', p.id, 'unavailable', false, 'player_id', pr.player_id, 'nickname', pr.nickname)
          end
          order by p.seat
        )
        from public.players p
        join public.profiles pr on pr.user_id = p.user_id
        where p.game_id = p_game_id and p.user_id <> v_uid
      ),
      '[]'::jsonb
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- send_game_invite(): a direct invitation of a friend into a lobby the caller sits in.
-- (Anyone can still be given the game code — that needs no invitation and no friendship.)
-- Refused when the lobby cannot take the player now: started, closed, locked or full.
-- Sending the same invitation again while it is live returns it; nothing new is created or told.
-- ---------------------------------------------------------------------------
create function public.send_game_invite(p_game_id uuid, p_player_id text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_pid text := public.normalize_player_id(p_player_id);
  v_target uuid;
  v_state text;
  v_id uuid;
  v_expires timestamptz;
  v_wait integer;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if p_game_id is null then
    return public.social_fail('VALIDATION');
  end if;
  if v_pid is null then
    return public.social_fail('INVALID_PLAYER_ID');
  end if;
  if public.social_seat_of(p_game_id, v_uid) is null then
    return public.social_fail('NOT_IN_GAME');
  end if;
  select p.user_id into v_target from public.profiles p where p.player_id = v_pid;
  if not found then
    return public.social_fail('NOT_FOUND');
  end if;
  if v_target = v_uid then
    return public.social_fail('SELF');
  end if;

  v_state := public.social_invite_state(p_game_id, now() + interval '1 second');
  if v_state <> 'open' then
    return public.social_fail(case v_state when 'started' then 'GAME_STARTED' when 'locked' then 'LOBBY_LOCKED' when 'full' then 'GAME_FULL' else 'GAME_CLOSED' end);
  end if;

  perform public.social_lock_pair(v_uid, v_target);
  if public.social_has_blocked(v_uid, v_target) then
    return public.social_fail('BLOCKED_BY_YOU');
  end if;
  if public.social_has_blocked(v_target, v_uid) then
    return public.social_fail('UNAVAILABLE');
  end if;
  if not public.social_are_friends(v_uid, v_target) then
    return public.social_fail('NOT_FRIENDS');
  end if;
  if public.social_seat_of(p_game_id, v_target) is not null then
    return public.social_fail('ALREADY_IN_GAME');
  end if;

  update public.game_invitations set status = 'expired'
  where game_id = p_game_id and inviter_user_id = v_uid and recipient_user_id = v_target and status = 'pending' and expires_at <= now();
  select i.id, i.expires_at into v_id, v_expires from public.game_invitations i
  where i.game_id = p_game_id and i.inviter_user_id = v_uid and i.recipient_user_id = v_target and i.status = 'pending';
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'invite_id', v_id, 'expires_at', v_expires);
  end if;

  v_wait := public.social_rate_hit(v_uid, 'game_invite_pair', v_target);
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;
  v_wait := public.social_rate_hit(v_uid, 'game_invite');
  if v_wait > 0 then
    return public.social_fail('RATE_LIMITED', v_wait);
  end if;

  insert into public.game_invitations (game_id, inviter_user_id, recipient_user_id, expires_at)
  values (p_game_id, v_uid, v_target, now() + public.social_invite_ttl())
  returning id, expires_at into v_id, v_expires;
  perform public.social_notify(v_target, 'game_invite', v_uid, v_id, 'game_invite:' || v_id::text);
  return jsonb_build_object('ok', true, 'created', true, 'invite_id', v_id, 'expires_at', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- open_game_invite(): the recipient is about to join. Checks the invitation and the game again,
-- now, and hands back the game code for the normal join. It reserves nothing: the join itself is
-- still refused if the lobby filled up, was locked or started in between.
-- ---------------------------------------------------------------------------
create function public.open_game_invite(p_invite_id uuid) returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.game_invitations;
  v_state text;
  v_game public.games;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  select * into v_inv from public.game_invitations i where i.id = p_invite_id and i.recipient_user_id = v_uid;
  if not found or v_inv.status <> 'pending'
     or public.social_has_blocked(v_uid, v_inv.inviter_user_id) or public.social_has_blocked(v_inv.inviter_user_id, v_uid) then
    return public.social_fail('INVITE_GONE');
  end if;
  v_state := public.social_invite_state(v_inv.game_id, v_inv.expires_at);
  if v_state <> 'open' then
    return public.social_fail(case v_state
      when 'started' then 'GAME_STARTED' when 'locked' then 'LOBBY_LOCKED' when 'full' then 'GAME_FULL'
      when 'expired' then 'INVITE_EXPIRED' else 'GAME_CLOSED' end);
  end if;
  select * into v_game from public.games g where g.id = v_inv.game_id;
  return jsonb_build_object('ok', true, 'game_id', v_game.id, 'code', v_game.code, 'mode', v_game.game_mode);
end;
$$;

create function public.decline_game_invite(p_invite_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from public.game_invitations i where i.id = p_invite_id and i.recipient_user_id = v_uid) then
    return public.social_fail('NOT_FOUND');
  end if;
  update public.game_invitations set status = 'declined' where id = p_invite_id and recipient_user_id = v_uid and status = 'pending';
  update public.notifications set read_at = now()
  where recipient_user_id = v_uid and event_type = 'game_invite' and related_entity_id = p_invite_id and read_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

-- The inviter can take an invitation back; so can the host of the game it is for.
create function public.revoke_game_invite(p_invite_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.game_invitations;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  select * into v_inv from public.game_invitations i where i.id = p_invite_id;
  if not found or not (
    v_inv.inviter_user_id = v_uid
    or exists (select 1 from public.players p where p.game_id = v_inv.game_id and p.user_id = v_uid and p.is_host and p.status <> 'LEFT')
  ) then
    return public.social_fail('NOT_FOUND');
  end if;
  update public.game_invitations set status = 'revoked' where id = p_invite_id and status = 'pending';
  if found then
    delete from public.notifications n where n.event_type = 'game_invite' and n.related_entity_id = p_invite_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_notifications_read(): the caller's own notifications only — all of them, or the ones named.
-- ---------------------------------------------------------------------------
create function public.mark_notifications_read(p_ids uuid[] default null) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  update public.notifications set read_at = now()
  where recipient_user_id = v_uid and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'marked', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- social_state(): everything the Friends screen shows, for the caller, in one answer.
-- `version` is read first: the lists are at least as new as it, so a phone that holds this
-- answer and later hears a higher version knows it must ask again.
-- ---------------------------------------------------------------------------
create function public.social_state() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.profiles;
  v_version bigint;
begin
  if v_uid is null then
    return public.social_fail('UNAUTHENTICATED');
  end if;
  select * into v_me from public.profiles p where p.user_id = v_uid;
  if not found then
    return public.social_fail('NO_PROFILE');
  end if;
  -- Created on first use, so Realtime has a row to report changes of.
  insert into public.social_sync (user_id) values (v_uid) on conflict (user_id) do nothing;
  select s.version into v_version from public.social_sync s where s.user_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'version', v_version,
    'server_time', now(),
    'me', jsonb_build_object('player_id', v_me.player_id, 'presence_key', v_me.presence_key),
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.player_id, 'nickname', p.nickname, 'presence_key', p.presence_key, 'since', f.created_at)
                       order by lower(p.nickname), p.player_id)
      from public.friendships f
      join public.profiles p on p.user_id = case when f.user_low = v_uid then f.user_high else f.user_low end
      where f.user_low = v_uid or f.user_high = v_uid
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'player_id', p.player_id, 'nickname', p.nickname, 'created_at', r.created_at, 'expires_at', r.expires_at)
                       order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.user_id = r.sender_user_id
      where r.recipient_user_id = v_uid and r.status = 'pending' and r.expires_at > now()
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'player_id', p.player_id, 'nickname', p.nickname, 'created_at', r.created_at, 'expires_at', r.expires_at)
                       order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.user_id = r.recipient_user_id
      where r.sender_user_id = v_uid and r.status in ('pending', 'declined') and r.expires_at > now()
    ), '[]'::jsonb),
    'blocked', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.player_id, 'nickname', p.nickname) order by b.created_at desc)
      from public.player_blocks b
      join public.profiles p on p.user_id = b.blocked_user_id
      where b.blocker_user_id = v_uid
    ), '[]'::jsonb),
    -- Invitations I received in the last hour that I have not answered, each with what the game
    -- looks like now. One that can no longer be used says why.
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id,
          'state', public.social_invite_state(i.game_id, i.expires_at),
          'mode', g.game_mode,
          'players', (select count(*) from public.players s where s.game_id = g.id and s.status <> 'LEFT'),
          'capacity', public.social_game_capacity(),
          'inviter', jsonb_build_object('player_id', p.player_id, 'nickname', p.nickname),
          'created_at', i.created_at,
          'expires_at', i.expires_at
        ) order by i.created_at desc)
      from public.game_invitations i
      join public.games g on g.id = i.game_id
      join public.profiles p on p.user_id = i.inviter_user_id
      where i.recipient_user_id = v_uid and i.status = 'pending' and i.created_at > now() - interval '1 hour'
    ), '[]'::jsonb),
    -- Live invitations I sent (the lobby shows "Invited" next to these friends).
    'sent_invites', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'game_id', i.game_id, 'player_id', p.player_id, 'expires_at', i.expires_at) order by i.created_at desc)
      from public.game_invitations i
      join public.profiles p on p.user_id = i.recipient_user_id
      where i.inviter_user_id = v_uid and i.status = 'pending' and i.expires_at > now()
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', n.id,
          'type', n.event_type,
          'actor', case when n.actor_user_id is null then null else public.social_public_profile(n.actor_user_id) end,
          'entity_id', n.related_entity_id,
          'created_at', n.created_at,
          'read', n.read_at is not null
        ) order by n.created_at desc)
      from (
        select * from public.notifications x where x.recipient_user_id = v_uid order by x.created_at desc limit 30
      ) n
    ), '[]'::jsonb),
    'unread', (select count(*) from public.notifications n where n.recipient_user_id = v_uid and n.read_at is null)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping. Nothing depends on it running: expiry is decided by the clock wherever a request
-- or an invitation is read. Run it from pg_cron (or by hand) to keep the tables small.
-- ---------------------------------------------------------------------------
create function public.social_cleanup() returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.friend_requests set status = 'expired' where status in ('pending', 'declined') and expires_at <= now();
  update public.game_invitations set status = 'expired' where status = 'pending' and expires_at <= now();
  delete from public.friend_requests where status in ('accepted', 'cancelled', 'expired') and updated_at < now() - interval '90 days';
  delete from public.game_invitations where status <> 'pending' and updated_at < now() - interval '7 days';
  delete from public.notifications where (read_at is not null and read_at < now() - interval '30 days') or created_at < now() - interval '90 days';
  delete from public.social_rate_events where created_at < now() - interval '8 days';
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down.
-- ---------------------------------------------------------------------------
alter table public.social_limits enable row level security;
alter table public.social_rate_events enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.player_blocks enable row level security;
alter table public.game_invitations enable row level security;
alter table public.notifications enable row level security;
alter table public.social_sync enable row level security;

revoke all on public.social_limits from anon, authenticated;
revoke all on public.social_rate_events from anon, authenticated;
revoke all on public.friend_requests from anon, authenticated;
revoke all on public.friendships from anon, authenticated;
revoke all on public.player_blocks from anon, authenticated;
revoke all on public.game_invitations from anon, authenticated;
revoke all on public.notifications from anon, authenticated;
revoke all on public.social_sync from anon, authenticated;

-- The one thing the app reads directly (through Realtime): its own change counter.
create policy social_sync_select_own on public.social_sync
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.social_sync to authenticated;

revoke execute on function public.social_touch(uuid) from public, anon, authenticated;
revoke execute on function public.social_touch_pair(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_touch_trigger() from public, anon, authenticated;
revoke execute on function public.social_set_updated_at() from public, anon, authenticated;
revoke execute on function public.normalize_player_id(text) from public, anon, authenticated;
revoke execute on function public.social_max_friends() from public, anon, authenticated;
revoke execute on function public.social_game_capacity() from public, anon, authenticated;
revoke execute on function public.social_request_ttl() from public, anon, authenticated;
revoke execute on function public.social_invite_ttl() from public, anon, authenticated;
revoke execute on function public.social_lock_pair(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_are_friends(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_has_blocked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_friend_count(uuid) from public, anon, authenticated;
revoke execute on function public.social_public_profile(uuid) from public, anon, authenticated;
revoke execute on function public.social_rate_hit(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.social_notify(uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.social_rotate_presence(uuid) from public, anon, authenticated;
revoke execute on function public.social_unfriend(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_expire_requests(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_relationship(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_invite_state(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.social_seat_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_fail(text, integer) from public, anon, authenticated;
revoke execute on function public.social_cleanup() from public, anon, authenticated;

revoke execute on function public.lookup_player(text) from public, anon;
revoke execute on function public.send_friend_request(text) from public, anon;
revoke execute on function public.respond_friend_request(uuid, boolean) from public, anon;
revoke execute on function public.cancel_friend_request(uuid) from public, anon;
revoke execute on function public.remove_friend(text) from public, anon;
revoke execute on function public.block_player(text) from public, anon;
revoke execute on function public.unblock_player(text) from public, anon;
revoke execute on function public.claim_seat(uuid, uuid, text) from public, anon;
revoke execute on function public.game_player_profiles(uuid) from public, anon;
revoke execute on function public.send_game_invite(uuid, text) from public, anon;
revoke execute on function public.open_game_invite(uuid) from public, anon;
revoke execute on function public.decline_game_invite(uuid) from public, anon;
revoke execute on function public.revoke_game_invite(uuid) from public, anon;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
revoke execute on function public.social_state() from public, anon;

grant execute on function public.lookup_player(text) to authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(text) to authenticated;
grant execute on function public.block_player(text) to authenticated;
grant execute on function public.unblock_player(text) to authenticated;
grant execute on function public.claim_seat(uuid, uuid, text) to authenticated;
grant execute on function public.game_player_profiles(uuid) to authenticated;
grant execute on function public.send_game_invite(uuid, text) to authenticated;
grant execute on function public.open_game_invite(uuid) to authenticated;
grant execute on function public.decline_game_invite(uuid) to authenticated;
grant execute on function public.revoke_game_invite(uuid) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.social_state() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: deliver changes of social_sync (and nothing else) to its owner. The publication
-- exists on Supabase; a plain Postgres (the local test database) has none and skips this.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_sync'
     ) then
    alter publication supabase_realtime add table public.social_sync;
  end if;
end;
$$;
