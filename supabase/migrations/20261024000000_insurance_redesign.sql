-- Property insurance redesign (Capital Mode): portfolio policies, an aggregate payout limit per coverage
-- period with automatic (possibly partial) claims, optional renewals with early-buyer and no-claim discounts,
-- and policies that lose a property for good when their buyer parts with it.
--
-- Additive for existing data: every stored policy and crisis is backfilled with exactly the values the engine's
-- upgradeInsurance() gives the same record in the game's economy document, so a game in progress carries on:
--   * a policy keeps its one property (property_keys = bought_keys = {property_key}; none left if CLAIMED),
--     its term and its price; its limit is the one ₹3,000 bill it could waive, already used if CLAIMED;
--   * a COVERED crisis was paid in full by insurance (covered = amount); any other crisis had no cover.
-- Deploy this BEFORE the game-action function that writes the new columns.
--
-- As before, the engine's economy document (games.intermediate → insurance) is the state the engine reads; these
-- rows are its durable record, written from it in the same transaction and under the game lock, with the
-- database's own guarantees on top:
--   * a crisis is resolved once per checkpoint, and what insurance paid towards it never changes (crisis guard);
--   * a policy's claims never exceed its limit and always equal what its crises say it paid (policy guard);
--   * a policy is renewed at most once (insurance_policies_renewed_once_idx);
--   * a policy never gains a property, never pays back a claim, and is final once closed (policy guard).

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
alter table public.insurance_policies
  add column property_keys text[],
  add column bought_keys text[],
  add column base_premium bigint,
  add column portfolio_percent integer not null default 0,
  add column loyalty_percent integer not null default 0,
  add column no_claim_percent integer not null default 0,
  add column payout_limit bigint,
  add column deductible bigint not null default 0,
  add column claimed_total bigint not null default 0,
  add column renewal_of uuid references public.insurance_policies (id) on delete cascade,
  add column entry_year integer,
  add column no_claim_periods integer not null default 0;

-- The guard forbids rewriting a closed policy; the backfill is the one sanctioned rewrite.
alter table public.insurance_policies disable trigger insurance_policies_guard;
update public.insurance_policies set
  property_keys = case when status = 'CLAIMED' then '{}'::text[] else array[property_key] end,
  bought_keys = array[property_key],
  base_premium = premium_paid,
  payout_limit = 3000,
  claimed_total = case when status = 'CLAIMED' then 3000 else 0 end,
  entry_year = purchase_year;
alter table public.insurance_policies enable trigger insurance_policies_guard;

alter table public.insurance_policies
  alter column property_keys set not null,
  alter column bought_keys set not null,
  alter column base_premium set not null,
  alter column payout_limit set not null,
  alter column entry_year set not null;

-- A renewal runs alongside the period it renews until that ends, so "one ACTIVE row per property and owner"
-- no longer holds; the engine keeps cover from overlapping, and the database keeps renewals single.
drop index public.insurance_policies_one_active_idx;
create unique index insurance_policies_renewed_once_idx on public.insurance_policies (renewal_of) where renewal_of is not null;

-- Every check constraint is replaced by the full new set (their generated names are not relied on).
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.insurance_policies'::regclass and contype = 'c' loop
    execute format('alter table public.insurance_policies drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.insurance_policies
  add constraint insurance_policies_purchase_year_check check (purchase_year >= 1),
  add constraint insurance_policies_entry_year_check check (entry_year >= 1 and entry_year <= purchase_year),
  add constraint insurance_policies_premium_check check (premium_paid > 0 and base_premium > 0),
  add constraint insurance_policies_clock_check check (start_clock >= 0 and expiry_clock > start_clock),
  add constraint insurance_policies_status_check check (status in ('ACTIVE', 'EXPIRED', 'ENDED', 'CLAIMED')),
  -- CLAIMED exists only on single-claim policies from before the redesign.
  add constraint insurance_policies_claimed_check check ((status = 'CLAIMED') = (claimed_crisis_id is not null)),
  add constraint insurance_policies_closed_check check ((status = 'ACTIVE') = (closed_at is null)),
  add constraint insurance_policies_keys_check check (cardinality(bought_keys) >= 1 and property_keys <@ bought_keys),
  add constraint insurance_policies_ended_check check (status <> 'ENDED' or cardinality(property_keys) = 0),
  add constraint insurance_policies_limit_check check (payout_limit > 0 and deductible >= 0 and claimed_total >= 0 and claimed_total <= payout_limit),
  add constraint insurance_policies_discount_check check (
    portfolio_percent between 0 and 100 and loyalty_percent between 0 and 100 and no_claim_percent between 0 and 100 and no_claim_periods >= 0
  ),
  add constraint insurance_policies_not_own_renewal check (renewal_of is distinct from id);

-- ---------------------------------------------------------------------------
-- Crises: what insurance paid towards each bill (the claim)
-- ---------------------------------------------------------------------------
alter table public.crisis_events add column covered bigint not null default 0;

alter table public.crisis_events disable trigger crisis_events_guard;
update public.crisis_events set covered = amount where status = 'COVERED';
alter table public.crisis_events enable trigger crisis_events_guard;

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.crisis_events'::regclass and contype = 'c' loop
    execute format('alter table public.crisis_events drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.crisis_events
  add constraint crisis_events_checkpoint_check check (checkpoint >= 1 and checkpoint_clock > 0 and financial_year >= 1),
  add constraint crisis_events_money_check check (amount >= 0 and paid >= 0 and covered >= 0 and covered + paid <= amount),
  add constraint crisis_events_status_check check (status in ('SKIPPED', 'COVERED', 'PENDING', 'PAID', 'BANKRUPT', 'UNPAID')),
  add constraint crisis_events_skipped_check check ((status = 'SKIPPED') = (property_key is null)),
  add constraint crisis_events_owner_check check ((property_key is null) = (owner_player_id is null)),
  -- A claim names the policy that paid it; nothing paid, no policy.
  add constraint crisis_events_claim_check check ((covered > 0) = (policy_id is not null)),
  add constraint crisis_events_covered_check check (status <> 'COVERED' or covered = amount),
  add constraint crisis_events_pending_check check ((status = 'PENDING') = (settled_at is null)),
  add constraint crisis_events_skipped_amount_check check (status <> 'SKIPPED' or amount = 0),
  add constraint crisis_events_unpaid_yet_check check (status not in ('COVERED', 'PENDING') or paid = 0),
  add constraint crisis_events_paid_check check (status <> 'PAID' or covered + paid = amount),
  add constraint crisis_events_unpaid_check check (status <> 'UNPAID' or covered + paid < amount);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.guard_insurance_policy() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  claims bigint;
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
    if new.status <> 'ACTIVE' or new.claimed_total <> 0 then
      raise exception 'a policy is bought active, with nothing claimed' using errcode = 'check_violation';
    end if;
    if new.renewal_of is not null and not exists (
      select 1 from public.insurance_policies r
      where r.id = new.renewal_of and r.game_id = new.game_id and r.owner_player_id = new.owner_player_id
    ) then
      raise exception 'policy % renews a policy of another player or game', new.id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: what was bought never changes, and a policy ends once.
  if new.game_id <> old.game_id or new.property_key is distinct from old.property_key or new.owner_player_id <> old.owner_player_id
     or new.purchase_year <> old.purchase_year or new.premium_paid <> old.premium_paid
     or new.start_clock <> old.start_clock or new.expiry_clock <> old.expiry_clock or new.created_at <> old.created_at
     or new.bought_keys <> old.bought_keys or new.base_premium <> old.base_premium
     or new.portfolio_percent <> old.portfolio_percent or new.loyalty_percent <> old.loyalty_percent
     or new.no_claim_percent <> old.no_claim_percent or new.payout_limit <> old.payout_limit
     or new.deductible <> old.deductible or new.renewal_of is distinct from old.renewal_of
     or new.entry_year <> old.entry_year or new.no_claim_periods <> old.no_claim_periods then
    raise exception 'an insurance policy cannot be changed' using errcode = 'check_violation';
  end if;
  if old.status <> 'ACTIVE' then
    raise exception 'policy % is already %', old.id, lower(old.status) using errcode = 'check_violation';
  end if;
  if new.status = 'CLAIMED' then
    raise exception 'a policy pays claims until its limit; it is no longer used up by one' using errcode = 'check_violation';
  end if;
  if not (new.property_keys <@ old.property_keys) then
    raise exception 'a property cannot be added to policy %', old.id using errcode = 'check_violation';
  end if;
  if new.claimed_total < old.claimed_total then
    raise exception 'a claim on policy % cannot be taken back', old.id using errcode = 'check_violation';
  end if;
  -- What the policy says it paid is exactly what its crises say it paid.
  select coalesce(sum(c.covered), 0) into claims from public.crisis_events c where c.policy_id = new.id;
  if new.claimed_total <> claims then
    raise exception 'policy % claims % but its crises record %', new.id, new.claimed_total, claims using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.guard_crisis_event() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pol record;
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
    if new.policy_id is not null then
      -- A claim is paid by a running policy of the owner that lists the property, and never beyond its limit.
      -- The policy row is locked first, so two claims on it can never both see the same cover left.
      perform 1 from public.insurance_policies i where i.id = new.policy_id for update;
      select i.game_id, i.owner_player_id, i.status, i.property_keys, i.payout_limit,
        (select coalesce(sum(c.covered), 0) from public.crisis_events c where c.policy_id = i.id) as claimed_total
      into pol
      from public.insurance_policies i where i.id = new.policy_id;
      if not found or pol.game_id <> new.game_id then
        raise exception 'policy % is not in game %', new.policy_id, new.game_id using errcode = 'check_violation';
      end if;
      if pol.owner_player_id <> new.owner_player_id or pol.status <> 'ACTIVE' or not (new.property_key = any (pol.property_keys)) then
        raise exception 'policy % does not cover this crisis', new.policy_id using errcode = 'check_violation';
      end if;
      if pol.claimed_total + new.covered > pol.payout_limit then
        raise exception 'policy % has only % of cover left', new.policy_id, pol.payout_limit - pol.claimed_total using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  -- UPDATE: the selection, the claim and the outcome are fixed; only an open bill can be closed, and only once.
  if new.game_id <> old.game_id or new.checkpoint <> old.checkpoint or new.checkpoint_clock <> old.checkpoint_clock
     or new.financial_year <> old.financial_year or new.property_key is distinct from old.property_key
     or new.owner_player_id is distinct from old.owner_player_id or new.mortgaged <> old.mortgaged
     or new.amount <> old.amount or new.covered <> old.covered or new.policy_id is distinct from old.policy_id
     or new.created_at <> old.created_at then
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

revoke execute on function public.guard_insurance_policy() from public, anon, authenticated;
revoke execute on function public.guard_crisis_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- To reverse this migration: only before any game has a portfolio policy, a renewal or a partial claim
-- (the old schema cannot hold them). Drop insurance_policies_renewed_once_idx, the added columns and the new
-- check constraints, then recreate the constraints, the index and both guard functions exactly as written in
-- 20261013000000_property_insurance.sql.
-- ---------------------------------------------------------------------------
