-- Player accounts: one profile per Supabase Auth user (anonymous guest or Google-linked).
--
-- Security model
--   * A profile belongs to exactly one auth.users row (user_id is the primary key) and is removed
--     with it (ON DELETE CASCADE) — that cascade IS account deletion's data removal.
--   * The app can only SELECT its own row (RLS). It has no INSERT / UPDATE / DELETE privilege:
--     every write goes through the SECURITY DEFINER functions below, which act on auth.uid() and
--     never take a user id from the caller.
--   * player_id (RR-XXXXXX) is generated here, unique, and immutable (trigger). It is a public
--     identifier, never a credential.
--   * google_linked_at mirrors auth.identities; it is written only by init_profile().
--   * Game tables are untouched. A seat in a game is a per-device token, not an account, so
--     deleting an account never changes a game.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  player_id text not null,
  nickname text not null,
  google_linked_at timestamptz,
  -- When the nickname was changed in the last 24 hours (the rate limit's memory).
  nickname_changes timestamptz[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_player_id_key unique (player_id),
  -- 32 symbols: no 0/O, no 1/I.
  constraint profiles_player_id_format check (player_id ~ '^RR-[2-9A-HJ-NP-Z]{6}$'),
  constraint profiles_nickname_length check (char_length(nickname) between 3 and 20 and nickname = btrim(nickname))
);

create function public.guard_profile_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.player_id is distinct from old.player_id
     or new.created_at is distinct from old.created_at then
    raise exception 'profile identity is immutable' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------------
-- Player ID: RR- + 6 symbols from a 32-symbol alphabet.
-- gen_random_uuid() is backed by the server's CSPRNG; bytes 0–5 of a v4 UUID are fully random,
-- and 256 is a multiple of 32, so every symbol is uniform.
-- ---------------------------------------------------------------------------
create function public.generate_player_id() returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bytes bytea := uuid_send(gen_random_uuid());
  id text := 'RR-';
begin
  for i in 0..5 loop
    id := id || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return id;
end;
$$;

-- "Player" + 4 digits. Not unique on purpose: the Player ID is the unique identifier.
create function public.default_nickname() returns text
language sql
volatile
set search_path = ''
as $$
  select 'Player' || lpad(((get_byte(b, 0) * 256 + get_byte(b, 1)) % 9000 + 1000)::text, 4, '0')
  from (select uuid_send(gen_random_uuid()) as b) r;
$$;

-- ---------------------------------------------------------------------------
-- Nickname rules. src/features/account/nickname.ts applies the same normalisation and checks on
-- the phone for instant feedback; THIS is the authority.
-- ---------------------------------------------------------------------------
-- NFC, every kind of space becomes one ordinary space, no leading/trailing space.
create function public.normalize_nickname(p_raw text) returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(normalize(coalesce(p_raw, ''), NFC), '[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+', ' ', 'g'));
$$;

-- null when the (already normalised) nickname is acceptable, otherwise a reason code.
create function public.nickname_problem(p_name text) returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name is null or p_name = '' then
    return 'NICKNAME_EMPTY';
  end if;
  -- Control characters and invisible formatting marks. ZWNJ / ZWJ (U+200C, U+200D) are allowed:
  -- Indian scripts and emoji need them.
  if p_name ~ '[\u0001-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]' then
    return 'NICKNAME_INVALID_CHARACTERS';
  end if;
  if char_length(p_name) > 20 then
    return 'NICKNAME_TOO_LONG';
  end if;
  -- Joiners and spaces do not count towards the minimum.
  if char_length(regexp_replace(p_name, '[ \u200C\u200D]', '', 'g')) < 3 then
    return 'NICKNAME_TOO_SHORT';
  end if;
  return null;
end;
$$;

-- Moderation policy (documented in README, "Accounts"):
--   * A nickname is refused when its folded form (lower case, common digit/symbol look-alikes
--     mapped to letters, everything but a–z removed) CONTAINS a 'contains' term or EQUALS an
--     'exact' term.
--   * 'contains' is for words that are abusive wherever they appear; 'exact' is for words that
--     also occur inside ordinary names (e.g. "Kshitij"), and for names that would impersonate staff.
--   * The list is data: add or remove rows without a deploy. The app cannot read it.
create table public.nickname_blocklist (
  term text primary key check (term ~ '^[a-z]+$'),
  match text not null check (match in ('contains', 'exact'))
);

insert into public.nickname_blocklist (term, match) values
  ('fuck', 'contains'), ('bitch', 'contains'), ('cunt', 'contains'), ('asshole', 'contains'),
  ('bullshit', 'contains'), ('nigger', 'contains'), ('nigga', 'contains'), ('faggot', 'contains'),
  ('retard', 'contains'), ('whore', 'contains'), ('slut', 'contains'), ('porn', 'contains'),
  ('pedophile', 'contains'), ('nazi', 'contains'), ('hitler', 'contains'),
  ('chutiya', 'contains'), ('madarchod', 'contains'), ('behenchod', 'contains'),
  ('bhenchod', 'contains'), ('bhosdi', 'contains'), ('harami', 'contains'),
  ('shit', 'exact'), ('dick', 'exact'), ('rape', 'exact'), ('rapist', 'exact'), ('pedo', 'exact'),
  ('randi', 'exact'), ('lund', 'exact'), ('gaand', 'exact'),
  ('admin', 'exact'), ('administrator', 'exact'), ('moderator', 'exact'), ('support', 'exact'),
  ('official', 'exact'), ('system', 'exact'), ('businessbanker', 'exact');

create function public.nickname_fold(p_name text) returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(translate(lower(p_name), '013457@$!', 'oieastasi'), '[^a-z]', '', 'g');
$$;

create function public.nickname_is_blocked(p_name text) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.nickname_blocklist b
    where (b.match = 'contains' and position(b.term in public.nickname_fold(p_name)) > 0)
       or (b.match = 'exact' and public.nickname_fold(p_name) = b.term)
  );
$$;

-- ---------------------------------------------------------------------------
-- The profile as the app sees it. google_linked is derived, never stored by the app.
-- ---------------------------------------------------------------------------
create function public.profile_json(p public.profiles) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.user_id,
    'player_id', p.player_id,
    'nickname', p.nickname,
    'google_linked', p.google_linked_at is not null,
    'google_linked_at', p.google_linked_at,
    'created_at', p.created_at,
    'updated_at', p.updated_at
  );
$$;

-- ---------------------------------------------------------------------------
-- init_profile(): create-or-load the caller's profile. Safe to call any number of times, from
-- any number of connections at once: one row per user, always the same Player ID.
-- Also brings google_linked_at in line with auth.identities (the trusted source).
-- ---------------------------------------------------------------------------
create function public.init_profile() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
  v_created boolean := false;
  v_linked_at timestamptz;
  v_attempt integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;

  select * into v_row from public.profiles where user_id = v_uid;
  if not found then
    loop
      v_attempt := v_attempt + 1;
      begin
        insert into public.profiles (user_id, player_id, nickname)
        values (v_uid, public.generate_player_id(), public.default_nickname())
        on conflict (user_id) do nothing
        returning * into v_row;
        if found then
          v_created := true;
        else
          -- Another request of the same user created it first.
          select * into v_row from public.profiles where user_id = v_uid;
        end if;
        exit;
      exception
        when unique_violation then
          -- Player ID collision: draw another.
          if v_attempt >= 10 then
            raise;
          end if;
        when foreign_key_violation then
          -- A still-valid token of an account that has been deleted.
          return jsonb_build_object('ok', false, 'code', 'NO_USER');
      end;
    end loop;
  end if;

  select min(i.created_at) into v_linked_at from auth.identities i where i.user_id = v_uid and i.provider = 'google';
  if (v_linked_at is null) <> (v_row.google_linked_at is null) then
    update public.profiles set google_linked_at = v_linked_at where user_id = v_uid returning * into v_row;
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'profile', public.profile_json(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- update_nickname(): validate, moderate, rate-limit (5 changes per 24 hours), then save.
-- The row lock makes concurrent calls of one user run one after the other.
-- ---------------------------------------------------------------------------
create function public.update_nickname(p_nickname text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_changes constant integer := 5;
  c_window constant interval := interval '24 hours';
  v_uid uuid := auth.uid();
  v_name text := public.normalize_nickname(p_nickname);
  v_problem text;
  v_row public.profiles;
  v_recent timestamptz[];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  v_problem := public.nickname_problem(v_name);
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'code', v_problem);
  end if;
  if public.nickname_is_blocked(v_name) then
    return jsonb_build_object('ok', false, 'code', 'NICKNAME_NOT_ALLOWED');
  end if;

  select * into v_row from public.profiles where user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_PROFILE');
  end if;
  if v_row.nickname = v_name then
    return jsonb_build_object('ok', true, 'changed', false, 'profile', public.profile_json(v_row));
  end if;

  v_recent := array(select t from unnest(v_row.nickname_changes) as t where t > now() - c_window order by t);
  if cardinality(v_recent) >= c_max_changes then
    return jsonb_build_object(
      'ok', false,
      'code', 'RATE_LIMITED',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_recent[1] + c_window - now())))::integer)
    );
  end if;

  update public.profiles
    set nickname = v_name, nickname_changes = v_recent || now()
    where user_id = v_uid
    returning * into v_row;
  return jsonb_build_object('ok', true, 'changed', true, 'profile', public.profile_json(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down. The app reads its own row and calls the two functions; nothing else.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.nickname_blocklist enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.nickname_blocklist from anon, authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- nickname_changes stays server-side.
grant select (user_id, player_id, nickname, google_linked_at, created_at, updated_at) on public.profiles to authenticated;

revoke execute on function public.guard_profile_update() from public, anon, authenticated;
revoke execute on function public.generate_player_id() from public, anon, authenticated;
revoke execute on function public.default_nickname() from public, anon, authenticated;
revoke execute on function public.normalize_nickname(text) from public, anon, authenticated;
revoke execute on function public.nickname_problem(text) from public, anon, authenticated;
revoke execute on function public.nickname_fold(text) from public, anon, authenticated;
revoke execute on function public.nickname_is_blocked(text) from public, anon, authenticated;
revoke execute on function public.profile_json(public.profiles) from public, anon, authenticated;
revoke execute on function public.init_profile() from public, anon;
revoke execute on function public.update_nickname(text) from public, anon;
grant execute on function public.init_profile() to authenticated;
grant execute on function public.update_nickname(text) to authenticated;
