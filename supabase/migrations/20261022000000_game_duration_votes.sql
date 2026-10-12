-- Game duration and end-game votes (hosted games).
--
-- Additive only. Every existing game keeps working unchanged:
--   * a config written before this migration has no durationYears; the engine reads that as the
--     default, 5 financial years (src/engine/gameConfig.ts);
--   * end_game stays null for a lobby, for a matchmade game (no host: no duration and no votes),
--     and for a game that was already running — the engine gives a hosted one its end-of-game
--     state the first time it acts on it.
-- Deploy this BEFORE the game-action function that reads and writes the column.
--
-- Where the state lives: the duration is one more host setting in games.config, so it is written
-- when the game is created (and by the host's UPDATE_CONFIG in the lobby) and locked by
-- games_config_locked from the moment the game starts. Everything that happens afterwards — years
-- added by a vote, who has asked for a vote this year, the vote in progress with its electorate,
-- threshold, deadline and ballots, and the last result — is the one document below. The engine
-- writes it under the game row lock, in the same transaction as the events and the version bump,
-- so a vote opens once, a ballot counts once and a result is applied once whatever races or retries.
--
-- Privacy: like every table here, games has RLS on with no policies and nothing granted to the
-- client roles, so the app cannot read ballots. They reach a device only through the game-action
-- function, which sends each player their own ballot and nobody else's (engine redactEndVote).

alter table public.games
  -- Shape: engine GameEndState (src/engine/types.ts).
  add column end_game jsonb check (end_game is null or jsonb_typeof(end_game) = 'object');

-- The duration a host may pick: a whole number of financial years from 5 to 10. The engine
-- validates it first and answers with a message; this holds even if a bug or a direct write got past it.
alter table public.games
  add constraint games_config_duration_years check (
    config is null
    or not (config ? 'durationYears')
    or (
      jsonb_typeof(config -> 'durationYears') = 'number'
      and (config ->> 'durationYears')::numeric between 5 and 10
      and (config ->> 'durationYears')::numeric = trunc((config ->> 'durationYears')::numeric)
    )
  );
