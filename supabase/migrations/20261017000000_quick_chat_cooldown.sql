-- Quick reactions and preset messages are never stored: they are broadcast and forgotten. The one
-- thing the server keeps is WHEN a player last sent one, so the two-second cooldown is enforced
-- here, on the database clock, whichever phone or function instance the request arrives through.
-- Deploy this BEFORE the game-action function that reads it.
alter table public.players add column last_chat_at timestamptz;
