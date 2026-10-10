import { z } from 'zod';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { INTERMEDIATE_RULES as IR, MARKET_VOLATILITIES, type MarketVolatility } from './intermediateConfig.ts';
import { normalizeGameMode, type GameMode } from './intermediateState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';

/**
 * GameConfig — the rules a host may customise for one game. It lives in GameState.config:
 * chosen while the game is in the lobby, validated and normalised here (the same code runs on
 * the server, which is the only writer), and locked the moment the game starts.
 *
 * Nothing else is customisable. Every other rule stays in BUSINESS_MVP_RULES / INTERMEDIATE_RULES,
 * and the defaults below are exactly those rules' values, so an untouched config plays the game
 * as it has always been played.
 */
export type GameConfig = {
  /** Cash every player receives from the bank when the game starts. */
  startingCash: number;
  /** Most loan principal a player may owe the bank at once (mortgages are separate and unaffected). */
  loanLimit: number;
  /** Intermediate Mode only: how far property values swing each financial year. Inert in Classic. */
  marketVolatility: MarketVolatility;
  /** Intermediate Mode only: each player gets a private objective with an end-of-game bonus. Always false in Classic. */
  secretObjectives: boolean;
};

/** What a host can pick. Enforced by the server, offered by the Create Game screen. */
export const GAME_CONFIG_LIMITS = {
  startingCash: { min: 10000, max: 50000, step: 5000 },
  loanLimit: { min: 5000, max: 50000, step: 5000 },
} as const;

export type GameConfigAmountKey = keyof typeof GAME_CONFIG_LIMITS;

/** The config of a new game whose host changes nothing. */
export function defaultGameConfig(mode: GameMode): GameConfig {
  const intermediate = mode === 'intermediate';
  return {
    startingCash: RULES.startingCash,
    loanLimit: intermediate ? IR.loans.maxOutstandingPrincipal : RULES.loans.maxOutstandingPrincipal,
    marketVolatility: IR.market.defaultProfile,
    secretObjectives: intermediate,
  };
}

/**
 * The config of a game stored before configs existed: the rules exactly as they were then.
 * (Such an Intermediate game never dealt objectives, so it has none.)
 */
export function legacyGameConfig(mode: GameMode): GameConfig {
  return { ...defaultGameConfig(mode), secretObjectives: false };
}

const amount = (key: GameConfigAmountKey, label: string) => {
  const { min, max, step } = GAME_CONFIG_LIMITS[key];
  return z
    .number({ error: `${label} must be a number.` })
    .int(`${label} must be a whole number of rupees.`)
    .min(min, `${label} must be at least ${formatINR(min)}.`)
    .max(max, `${label} can be at most ${formatINR(max)}.`)
    .refine((v) => v % step === 0, `${label} must be a multiple of ${formatINR(step)}.`);
};

/** What a client may send: any subset of the settings. Unknown keys are refused, not ignored. */
const GameConfigInputSchema = z
  .object({
    startingCash: amount('startingCash', 'Starting cash').optional(),
    loanLimit: amount('loanLimit', 'The loan limit').optional(),
    marketVolatility: z.enum(MARKET_VOLATILITIES, { error: 'Choose Stable, Balanced or Volatile for the property market.' }).optional(),
    secretObjectives: z.boolean({ error: 'Secret objectives must be on or off.' }).optional(),
  })
  .strict();

export type GameConfigInput = z.infer<typeof GameConfigInputSchema>;

function build(mode: GameMode, input: GameConfigInput, base: GameConfig): GameConfig {
  const intermediate = mode === 'intermediate';
  return {
    startingCash: input.startingCash ?? base.startingCash,
    loanLimit: input.loanLimit ?? base.loanLimit,
    // Classic has no property market and no objectives: whatever was sent, these stay inert.
    marketVolatility: intermediate ? (input.marketVolatility ?? base.marketVolatility) : base.marketVolatility,
    secretObjectives: intermediate ? (input.secretObjectives ?? base.secretObjectives) : false,
  };
}

/**
 * Validates and normalises the settings a host asked for. Missing settings take their default.
 * Throws a VALIDATION GameError that says which setting is wrong — nothing invalid is ever stored.
 */
export function parseGameConfig(mode: GameMode, raw: unknown): GameConfig {
  const parsed = GameConfigInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail('VALIDATION', issue?.code === 'unrecognized_keys' || !issue ? 'Those game settings are not valid.' : issue.message);
  }
  return build(mode, parsed.data, defaultGameConfig(mode));
}

/**
 * Reads a stored config. Never throws: a game stored without one (or with one this version can't
 * read) plays by the rules that existed before configs did.
 */
export function normalizeGameConfig(mode: GameMode, stored: unknown): GameConfig {
  const legacy = legacyGameConfig(mode);
  if (stored === null || stored === undefined) return legacy;
  const parsed = GameConfigInputSchema.safeParse(stored);
  return parsed.success ? build(mode, parsed.data, legacy) : legacy;
}

/** States that may carry a config. One without (built before configs existed) reads as its mode's legacy rules. */
export type ConfigAware = { mode?: GameMode; config?: GameConfig | null };

/** THE config of a game. Every rule that can be customised is read through here. */
export function configOf(state: ConfigAware): GameConfig {
  return state.config ?? legacyGameConfig(normalizeGameMode(state.mode));
}

export function isDefaultGameConfig(mode: GameMode, config: GameConfig): boolean {
  const d = defaultGameConfig(mode);
  return (
    config.startingCash === d.startingCash &&
    config.loanLimit === d.loanLimit &&
    config.marketVolatility === d.marketVolatility &&
    config.secretObjectives === d.secretObjectives
  );
}

export const GAME_MODE_LABELS: Record<GameMode, string> = { classic: 'Classic', intermediate: 'Intermediate' };

export const MARKET_VOLATILITY_LABELS: Record<MarketVolatility, { label: string; hint: string }> = {
  stable: { label: 'Stable', hint: 'Small yearly changes. Values never fall more than 10%.' },
  balanced: { label: 'Balanced', hint: 'The standard market: rises are a little more likely than falls.' },
  volatile: { label: 'Volatile', hint: 'Big swings both ways. A 20% rise or fall is common.' },
};

export interface ConfigSummaryRow {
  key: 'mode' | keyof GameConfig;
  label: string;
  value: string;
}

/** The rules of one game as players read them, before and after it starts. Classic lists only what applies to it. */
export function gameConfigSummary(mode: GameMode, config: GameConfig): ConfigSummaryRow[] {
  const rows: ConfigSummaryRow[] = [
    { key: 'mode', label: 'Mode', value: GAME_MODE_LABELS[mode] },
    { key: 'startingCash', label: 'Starting cash', value: formatINR(config.startingCash) },
    { key: 'loanLimit', label: 'Maximum outstanding loans', value: formatINR(config.loanLimit) },
  ];
  if (mode === 'intermediate') {
    rows.push(
      { key: 'marketVolatility', label: 'Market volatility', value: MARKET_VOLATILITY_LABELS[config.marketVolatility].label },
      { key: 'secretObjectives', label: 'Secret objectives', value: config.secretObjectives ? 'Enabled' : 'Disabled' },
    );
  }
  return rows;
}
