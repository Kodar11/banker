-- LEAVE_GAME: a player can walk away from a game. Their row stays (the ledger, events, properties
-- and loans refer to it); only the status changes. Deploy this BEFORE the game-action function
-- that sends the new status.
alter table public.players drop constraint players_status_check;
alter table public.players add constraint players_status_check check (status in ('ACTIVE', 'BANKRUPT', 'LEFT'));
