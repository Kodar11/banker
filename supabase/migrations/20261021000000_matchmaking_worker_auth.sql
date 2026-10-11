-- Matchmaking worker: who may make it run, and how often.
--
-- Until now the `matchmaking` Edge Function ran a full tick (sweep, a matching run per mode, game
-- creation) for ANY caller: no token was asked for and only the matching runs were throttled. From
-- this migration on, together with the function deployed after it:
--
--   * the scheduler (pg_cron -> pg_net) proves itself with a server-only secret, kept in Vault here
--     and in the function's own secrets (MATCHMAKING_WORKER_SECRET) - never in the app;
--   * a searching phone may still ask the worker to look now, as the signed-in player it is; that
--     request runs nothing unless matchmaking_tick_claim() below says so;
--   * the WHOLE tick, whoever asks, runs at most once per min_tick_interval_ms.
--
-- Additive and safe to apply before the function: an older function ignores the extra header.
-- Nothing about queueing, parties, ready-up, reservations or game creation changes.

insert into public.matchmaking_settings (key, value) values
  ('min_tick_interval_ms', 250),        -- a whole worker tick runs at most this often, whoever asks
  ('client_nudge_interval_ms', 1000)    -- one player may ask the worker to look at most this often
on conflict (key) do nothing;

-- One row: when the last tick was let through.
create table public.matchmaking_tick_gate (
  id boolean primary key default true check (id),
  last_tick_at timestamptz,
  ticks bigint not null default 0
);
insert into public.matchmaking_tick_gate (id) values (true);

-- One row per player who has ever nudged the worker: when they last did.
create table public.matchmaking_nudges (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  last_nudge_at timestamptz not null,
  nudges bigint not null default 0
);

alter table public.matchmaking_tick_gate enable row level security;
alter table public.matchmaking_nudges enable row level security;
revoke all on public.matchmaking_tick_gate from anon, authenticated;
revoke all on public.matchmaking_nudges from anon, authenticated;

-- ---------------------------------------------------------------------------
-- matchmaking_tick_claim(p_user): may a tick run now?
--   p_user null  the scheduler (the function has already checked its secret)
--   p_user set   a signed-in player (the function has already verified their token)
-- A player's request counts only while they are in the queue or in a countdown, only while
-- settings.client_tick is on, and at most once per client_nudge_interval_ms for that player: one
-- player's limit never touches another's. Then the one gate for everybody: a tick at most once per
-- min_tick_interval_ms. Concurrent callers wait on the gate row and all but one are refused.
-- Answers { run: true } or { run: false, reason, retry_after_ms? }.
-- ---------------------------------------------------------------------------
create function public.matchmaking_tick_claim(p_user uuid default null) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tick_ms integer := public.matchmaking_setting('min_tick_interval_ms', 250);
  v_nudge_ms integer := public.matchmaking_setting('client_nudge_interval_ms', 1000);
  v_last timestamptz;
begin
  if p_user is not null then
    if public.matchmaking_setting('client_tick', 1) = 0 then
      return jsonb_build_object('run', false, 'reason', 'CLIENT_TICK_OFF');
    end if;
    if public.matchmaking_active_ticket(p_user) is null then
      return jsonb_build_object('run', false, 'reason', 'NOT_SEARCHING');
    end if;
    insert into public.matchmaking_nudges as n (user_id, last_nudge_at, nudges)
    values (p_user, clock_timestamp(), 1)
    on conflict (user_id) do update set last_nudge_at = excluded.last_nudge_at, nudges = n.nudges + 1
      where n.last_nudge_at <= clock_timestamp() - make_interval(secs => v_nudge_ms / 1000.0);
    if not found then
      select n.last_nudge_at into v_last from public.matchmaking_nudges n where n.user_id = p_user;
      return jsonb_build_object(
        'run', false,
        'reason', 'RATE_LIMITED',
        'retry_after_ms', greatest(0, v_nudge_ms - floor(extract(epoch from clock_timestamp() - coalesce(v_last, clock_timestamp())) * 1000)::integer)
      );
    end if;
  end if;

  update public.matchmaking_tick_gate g set last_tick_at = clock_timestamp(), ticks = g.ticks + 1
  where g.id and (g.last_tick_at is null or g.last_tick_at <= clock_timestamp() - make_interval(secs => v_tick_ms / 1000.0));
  if not found then
    return jsonb_build_object('run', false, 'reason', 'THROTTLED');
  end if;
  return jsonb_build_object('run', true);
end;
$$;

revoke execute on function public.matchmaking_tick_claim(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The scheduled tick now carries the worker secret. Vault secrets:
--   matchmaking_tick_url      https://<project-ref>.supabase.co/functions/v1/matchmaking
--   matchmaking_tick_secret   the same value as the function secret MATCHMAKING_WORKER_SECRET
--   matchmaking_tick_key      (optional) the project's publishable key, sent as before
-- Without the URL or the secret this sends nothing: the function would refuse the request anyway.
-- Searching phones still nudge the worker, and matchmaking_sweep() still runs from pg_cron by itself.
-- ---------------------------------------------------------------------------
create or replace function public.matchmaking_cron_tick() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
  v_secret text;
  v_headers jsonb;
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
  execute 'select s.decrypted_secret from vault.decrypted_secrets s where s.name = $1' into v_secret using 'matchmaking_tick_secret';
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    return;
  end if;
  execute 'select s.decrypted_secret from vault.decrypted_secrets s where s.name = $1' into v_key using 'matchmaking_tick_key';
  v_headers := jsonb_build_object('Content-Type', 'application/json', 'x-matchmaking-secret', v_secret);
  if v_key is not null and v_key <> '' then
    v_headers := v_headers || jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key);
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)'
    using v_url, jsonb_build_object('op', 'tick', 'source', 'cron'), v_headers;
end;
$$;

revoke execute on function public.matchmaking_cron_tick() from public, anon, authenticated;
