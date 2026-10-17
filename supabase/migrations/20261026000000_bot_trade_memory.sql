-- Bots remember the trade offers that were turned down (GameState.botTradeMemory), so a bot never makes
-- the same rejected offer twice — even after the offer itself has dropped out of the trades a game keeps in
-- its state. Per bot seat, at most BOT_TRADE_MEMORY exchange signatures (src/engine/botSeat.ts).
--
-- Additive: every existing game reads it as empty. Deploy BEFORE the Edge Functions that write it.
alter table public.games add column bot_trade_memory jsonb not null default '{}'::jsonb;
