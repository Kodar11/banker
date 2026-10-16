-- Bot players: seats the game plays by itself (src/bots), in private lobbies (added by the host),
-- in public matchmaking (opt-in bot filling) and — on the device only — in solo games.
--
-- Additive. Every existing game, seat, ticket and match keeps working unchanged:
--   * a person's seat is exactly as before: a device token hash, no bot columns;
--   * a bot seat has NO token hash (nobody can ever authenticate as it — every check below and in the
--     Edge Functions refuses a missing hash), NO account (user_id stays null) and its difficulty and
--     personality; none of that can change once the seat exists;
--   * a queue ticket only allows bots when its player asked for it (allow_bots, solo tickets only), and a
--     reservation records how many bot seats it adds (bot_seats, 0 for every existing one).
-- Bots are never fake accounts: they have no auth.users row, no profile and no matchmaking ticket.
-- Deploy this BEFORE the Edge Functions that seat and run bots.

-- ---------------------------------------------------------------------------
-- Seats
-- ---------------------------------------------------------------------------
alter table public.players alter column token_hash drop not null;
alter table public.players
  add column bot_difficulty text check (bot_difficulty in ('easy', 'normal', 'hard')),
  add column bot_personality text check (bot_personality in ('investor', 'banker', 'dealmaker', 'opportunist'));
-- A seat is a person (a device token, no bot settings) or a bot (bot settings, no token, no account) — never both, never neither.
alter table public.players add constraint players_person_or_bot check (
  (bot_difficulty is null) = (bot_personality is null)
  and (bot_difficulty is null) = (token_hash is not null)
  and (bot_difficulty is null or user_id is null)
);

-- What a seat is never changes: a person can't become a bot, a bot can't be given a token or an account.
create function public.players_seat_kind_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.bot_difficulty is distinct from old.bot_difficulty or new.bot_personality is distinct from old.bot_personality
     or (old.token_hash is null and new.token_hash is not null) or (old.token_hash is not null and new.token_hash is null) then
    raise exception 'a seat''s kind (person or bot) and its bot settings are fixed (seat %)', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger players_seat_kind_guard before update on public.players
  for each row execute function public.players_seat_kind_guard();

-- claim_seat compared the token with `<>`, which is never true against a missing hash: a bot seat must
-- refuse every claim explicitly. Same function otherwise.
create or replace function public.claim_seat(p_game_id uuid, p_seat_id uuid, p_token text) returns jsonb
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
  if not found or v_seat.token_hash is null or v_seat.token_hash is distinct from encode(sha256(convert_to(p_token, 'UTF8')), 'hex') then
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
-- The server's bot runner: one at a time per game
-- ---------------------------------------------------------------------------
-- A short lease, taken and renewed by the game-action function while it plays a game's bots and cleared
-- when it stops. It only keeps two runners from taking turns on the same game; correctness does not rest
-- on it — every bot action is still applied under the game row lock to the state as it is then, with its
-- own exactly-once action id.
alter table public.games add column bot_runner_until timestamptz;

-- ---------------------------------------------------------------------------
-- Matchmaking: opt-in bot filling
-- ---------------------------------------------------------------------------
-- A solo player may ask for the empty seats of their table to be filled with bots. Party tickets never
-- carry it: every person at a bot-filled table has to have asked for that themselves.
alter table public.matchmaking_tickets add column allow_bots boolean not null default false;
alter table public.matchmaking_tickets add constraint matchmaking_tickets_bots_solo check (not allow_bots or kind = 'solo');
-- Bot seats a reservation adds to its people. Fixed when it is made, and shown in the ready-up.
alter table public.matchmaking_matches add column bot_seats integer not null default 0 check (bot_seats between 0 and 6);
alter table public.matchmaking_matches add constraint matchmaking_matches_table_size check (player_count + bot_seats <= 8);

insert into public.matchmaking_settings (key, value) values
  ('bot_fill_enabled', 1),   -- 0: no reservation adds bots, whatever the tickets ask for
  ('bot_fill_difficulty', 1) -- 0 easy, 1 normal, 2 hard
on conflict (key) do nothing;

create or replace function public.matchmaking_match_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode or new.player_count is distinct from old.player_count
     or new.ready_deadline is distinct from old.ready_deadline or new.bot_seats is distinct from old.bot_seats then
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

-- A ticket allows bots only if it asked to when it was queued.
create or replace function public.matchmaking_ticket_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode or new.kind is distinct from old.kind or new.queued_at is distinct from old.queued_at
     or new.allow_bots is distinct from old.allow_bots then
    raise exception 'a queue ticket''s mode, kind, queue time and bot preference are fixed (ticket %)', old.id using errcode = 'check_violation';
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

create or replace function public.matchmaking_ticket_json(p_ticket uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'mode', t.mode, 'player_count', t.player_count, 'status', t.status,
    'queued_at', t.queued_at, 'requeue_count', t.requeue_count, 'match_id', t.match_id, 'allow_bots', t.allow_bots
  )
  from public.matchmaking_tickets t
  where t.id = p_ticket;
$$;

create or replace function public.matchmaking_match_json(p_match uuid, p_viewer uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'mode', m.mode, 'status', m.status, 'player_count', m.player_count, 'ready_deadline', m.ready_deadline,
    'bot_seats', m.bot_seats,
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

-- matchmaking_enqueue gains the bot preference. The old two-argument signature is replaced by one whose
-- third argument defaults to false, so an app that does not know about bots queues exactly as before.
drop function public.matchmaking_enqueue(text, text);
create function public.matchmaking_enqueue(p_mode text default null, p_idempotency_key text default null, p_allow_bots boolean default false) returns jsonb
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
    -- Bot filling needs every person's own consent: a party, queued by its leader, never asks for it.
    if coalesce(p_allow_bots, false) then
      return public.matchmaking_fail('BOTS_SOLO_ONLY');
    end if;
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
    insert into public.matchmaking_tickets (kind, owner_user_id, party_id, mode, player_count, idempotency_key, allow_bots)
    values (case when v_party.id is null then 'solo' else 'party' end, v_uid, v_party.id, v_mode, cardinality(v_members), p_idempotency_key,
            v_party.id is null and coalesce(p_allow_bots, false))
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
revoke execute on function public.matchmaking_enqueue(text, text, boolean) from public, anon, authenticated;
grant execute on function public.matchmaking_enqueue(text, text, boolean) to authenticated;

-- A reservation of fewer people than the preferred table size gets bot seats up to it — only when every
-- ticket in it asked for bots (so every person did), bot filling is on, and the table stays within the
-- engine's size. Grouping itself is unchanged: groups below the preferred size only form once the oldest
-- ticket has waited past prefer_target_seconds, exactly as for people-only tables.
create or replace function public.matchmaking_reserve(p_mode text, p_ticket_ids uuid[]) returns jsonb
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
  v_target integer := least(greatest(public.matchmaking_setting('target_players', 4), 2), least(public.matchmaking_setting('max_players', 8), 8));
  v_all_bots boolean;
  v_bots integer := 0;
  v_match uuid;
begin
  if cardinality(v_ids) = 0 or cardinality(v_ids) <> coalesce(cardinality(p_ticket_ids), 0) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_GROUP');
  end if;
  perform 1 from public.matchmaking_tickets t where t.id = any(v_ids) order by t.id for update;
  select count(*), coalesce(sum(t.player_count), 0), bool_and(t.allow_bots) into v_found, v_total, v_all_bots
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
  if coalesce(v_all_bots, false) and public.matchmaking_setting('bot_fill_enabled', 1) <> 0 and v_total < v_target then
    v_bots := least(v_target - v_total, 8 - v_total, 6);
  end if;

  insert into public.matchmaking_matches (mode, player_count, bot_seats, ready_deadline)
  values (p_mode, v_total, v_bots, now() + make_interval(secs => greatest(public.matchmaking_setting('ready_seconds', 20), 5)))
  returning id into v_match;
  insert into public.matchmaking_match_players (match_id, user_id, ticket_id, seat)
  select v_match, m.user_id, m.ticket_id, (row_number() over (order by t.queued_at, t.id, m.position, m.user_id) - 1)::integer
  from public.matchmaking_ticket_members m
  join public.matchmaking_tickets t on t.id = m.ticket_id
  where m.ticket_id = any(v_ids) and m.active;
  update public.matchmaking_tickets set status = 'RESERVED', match_id = v_match where id = any(v_ids);
  perform public.matchmaking_touch(array(select p.user_id from public.matchmaking_match_players p where p.match_id = v_match));
  return jsonb_build_object('ok', true, 'match_id', v_match, 'players', v_total, 'bot_seats', v_bots);
end;
$$;
revoke execute on function public.matchmaking_reserve(text, uuid[]) from public, anon, authenticated;

-- The claim also hands the worker the bot seats to create and how they play.
create or replace function public.matchmaking_begin_start(p_match_id uuid) returns jsonb
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
    'bot_seats', v_match.bot_seats,
    'bot_difficulty', (array['easy', 'normal', 'hard'])[least(greatest(public.matchmaking_setting('bot_fill_difficulty', 1), 0), 2) + 1],
    'players', (
      select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'seat', p.seat, 'nickname', pr.nickname, 'token_hash', p.token_hash) order by p.seat)
      from public.matchmaking_match_players p
      join public.profiles pr on pr.user_id = p.user_id
      where p.match_id = p_match_id
    )
  );
end;
$$;
revoke execute on function public.matchmaking_begin_start(uuid) from public, anon, authenticated;
