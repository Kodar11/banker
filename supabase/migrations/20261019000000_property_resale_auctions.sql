-- Property resale auctions (Intermediate Mode only): a player auctions a property they own, with
-- whatever is built on it, to the other players, subject to a reserve price.
--
-- Additive only. Every existing auction row — and every auction of an unowned property from now
-- on — has all six new columns null and behaves exactly as before; a Classic game can never have a
-- resale row (the guard below refuses one).
-- Deploy this BEFORE the game-action function that writes these columns.
--
-- Where the state lives: a resale runs on the game's one auction (public.auctions, at most one OPEN
-- per game — auctions_one_open_idx), so bids, the countdown and the close are the ones every
-- auction uses. The engine decides everything under the game row lock, in the same transaction as
-- the payment, the ownership change, the events and the version bump. The columns here are that
-- decision's record, with guarantees the database itself enforces whatever a retry, a race or a
-- bug attempts:
--   * the terms of a listing never change, and its outcome is written once;
--   * the seller is never a bidder, the high bidder or the winner;
--   * a sale names a winner whose bid reached the reserve — and nothing else does.
-- A violation aborts the whole action: no payment without the property, no property without the payment.

alter table public.auctions
  -- The player selling. Null = the bank's auction of an unowned property.
  add column seller_player_id uuid references public.players (id),
  -- The least the seller accepts. Not a bid.
  add column reserve_price bigint check (reserve_price is null or reserve_price > 0),
  -- What stood on the property when it was listed; the sale requires it unchanged.
  add column listed_houses smallint check (listed_houses is null or listed_houses between 0 and 3),
  add column listed_hotel boolean,
  -- The phase the seller's turn returns to when the auction ends.
  add column resume_phase text check (resume_phase is null or resume_phase in ('AWAITING_ROLL', 'AWAITING_PAYMENT', 'TURN_COMPLETE')),
  -- How it ended; null while it is open.
  add column resale_outcome text check (resale_outcome is null or resale_outcome in ('SOLD', 'UNSOLD', 'CANCELLED'));

alter table public.auctions
  -- A row is a resale with all of its terms, or not a resale at all.
  add constraint auctions_resale_terms_complete check (
    (seller_player_id is null and reserve_price is null and listed_houses is null and listed_hotel is null
      and resume_phase is null and resale_outcome is null)
    or (seller_player_id is not null and reserve_price is not null and listed_houses is not null
      and listed_hotel is not null and resume_phase is not null)
  ),
  add constraint auctions_resale_buildings check (listed_hotel is not true or listed_houses = 0),
  -- An open resale has no outcome yet; a closed one always has one.
  add constraint auctions_resale_outcome_when_closed check (
    seller_player_id is null or ((status = 'OPEN') = (resale_outcome is null))
  ),
  -- The seller is excluded from bidding for the whole life of the auction.
  add constraint auctions_seller_never_bids check (
    seller_player_id is null
    or (high_bidder_id is distinct from seller_player_id
      and winner_player_id is distinct from seller_player_id
      and not (seller_player_id = any (participant_ids)))
  ),
  -- SOLD means exactly: a winner, who is the high bidder, at a bid that reached the reserve.
  add constraint auctions_resale_sold check (
    seller_player_id is null
    or ((coalesce(resale_outcome, '') = 'SOLD') = (winner_player_id is not null))
  ),
  add constraint auctions_resale_sold_at_reserve check (
    coalesce(resale_outcome, '') <> 'SOLD'
    or (high_bid is not null and high_bid >= reserve_price and winner_player_id = high_bidder_id)
  ),
  -- Cancelling is only possible before the first bid.
  add constraint auctions_resale_cancelled_without_bids check (
    coalesce(resale_outcome, '') <> 'CANCELLED' or high_bid is null
  );

-- ---------------------------------------------------------------------------
-- Guard. A resale exists only in an Intermediate game, is listed by a player of that game, keeps
-- the terms it was listed with, and ends once: a closed resale is never rewritten, so a duplicate
-- or late finalization cannot sell the same property twice.
-- (The engine re-saves the game's current auction with every action; saving a closed resale again
-- with the same values is not a change and is allowed.)
-- ---------------------------------------------------------------------------
create function public.guard_resale_auction() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.seller_player_id is null then
      return new;
    end if;
    if (select g.game_mode from public.games g where g.id = new.game_id) is distinct from 'intermediate' then
      raise exception 'property resale auctions exist only in Intermediate Mode' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.players p where p.id = new.seller_player_id and p.game_id = new.game_id) then
      raise exception 'player % is not in game %', new.seller_player_id, new.game_id using errcode = 'check_violation';
    end if;
    -- No check on status or bids here: the engine saves the current auction as an upsert, and this
    -- insert branch runs for every row an upsert proposes — an auction with bids, or closed, included.
    return new;
  end if;
  -- UPDATE: an auction never becomes, or stops being, a resale; the listing never changes.
  if new.seller_player_id is distinct from old.seller_player_id
     or new.reserve_price is distinct from old.reserve_price
     or new.listed_houses is distinct from old.listed_houses
     or new.listed_hotel is distinct from old.listed_hotel
     or new.resume_phase is distinct from old.resume_phase then
    raise exception 'the terms of a resale auction cannot be changed' using errcode = 'check_violation';
  end if;
  if old.seller_player_id is not null and old.status = 'CLOSED'
     and (new.status is distinct from old.status
       or new.resale_outcome is distinct from old.resale_outcome
       or new.winner_player_id is distinct from old.winner_player_id
       or new.high_bid is distinct from old.high_bid
       or new.high_bidder_id is distinct from old.high_bidder_id
       or new.closed_at is distinct from old.closed_at) then
    raise exception 'resale auction % is already %', old.id, lower(old.resale_outcome) using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger auctions_resale_guard before insert or update on public.auctions
  for each row execute function public.guard_resale_auction();

-- public.auctions keeps the lockdown it has always had (RLS on, no policies, nothing granted).
revoke execute on function public.guard_resale_auction() from public, anon, authenticated;
