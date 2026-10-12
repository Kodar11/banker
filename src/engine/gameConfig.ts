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
/**
 * Who may see a player's money. `open`: everyone sees everyone's finances, as the game has always been.
 * `hidden`: each player sees only their own cash, ledger, loans and credit until the game has finished;
 * the board, property ownership, buildings, mortgages, auctions and trades stay public either way.
 * What exactly is private is decided in one place: financialPrivacy.ts.
 */
export const FINANCIAL_PRIVACY_MODES = ['open', 'hidden'] as const;
export type FinancialPrivacy = (typeof FINANCIAL_PRIVACY_MODES)[number];

export type GameConfig = {
  /** Cash every player receives from the bank when the game starts. */
  startingCash: number;
  /** Most loan principal a player may owe the bank at once (mortgages are separate and unaffected). */
  loanLimit: number;
  /** Capital Mode only: how far property values swing each financial year. Inert in Classic. */
  marketVolatility: MarketVolatility;
  /** Capital Mode only: each player gets a private objective with an end-of-game bonus. Always false in Classic. */
  secretObjectives: boolean;
  /** Open or hidden finances. Chosen by the host when the game is created and fixed from then on — not even the lobby can change it. */
  financialPrivacy: FinancialPrivacy;
  /**
   * How many financial years the game runs before the players vote to finish it or play one more
   * (gameEnd.ts). Only a hosted game has a duration; a matchmade game ignores this.
   */
  durationYears: number;
};

/** What a host can pick. Enforced by the server, offered by the Create Game screen. */
export const GAME_CONFIG_LIMITS = {
  startingCash: { min: 10000, max: 50000, step: 5000 },
  loanLimit: { min: 5000, max: 50000, step: 5000 },
} as const;

export type GameConfigAmountKey = keyof typeof GAME_CONFIG_LIMITS;

/** The game durations a host can pick, in financial years: every whole number from the shortest to the longest. */
export const GAME_DURATION_YEARS = RULES.endGame.duration;
export const GAME_DURATION_OPTIONS: readonly number[] = Array.from(
  { length: GAME_DURATION_YEARS.maxYears - GAME_DURATION_YEARS.minYears + 1 },
  (_, i) => GAME_DURATION_YEARS.minYears + i,
);

/** The config of a new game whose host changes nothing. */
export function defaultGameConfig(mode: GameMode): GameConfig {
  const intermediate = mode === 'intermediate';
  return {
    startingCash: RULES.startingCash,
    loanLimit: intermediate ? IR.loans.maxOutstandingPrincipal : RULES.loans.maxOutstandingPrincipal,
    marketVolatility: IR.market.defaultProfile,
    secretObjectives: intermediate,
    financialPrivacy: 'open',
    durationYears: GAME_DURATION_YEARS.defaultYears,
  };
}

/**
 * The config of a game stored before configs existed: the rules exactly as they were then.
 * (Such a Capital game never dealt objectives, so it has none.)
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
    financialPrivacy: z.enum(FINANCIAL_PRIVACY_MODES, { error: 'Choose Open or Hidden finances.' }).optional(),
    durationYears: z
      .number({ error: 'The game duration must be a number of financial years.' })
      .int('The game duration must be a whole number of financial years.')
      .min(GAME_DURATION_YEARS.minYears, `A game lasts at least ${GAME_DURATION_YEARS.minYears} financial years.`)
      .max(GAME_DURATION_YEARS.maxYears, `A game lasts at most ${GAME_DURATION_YEARS.maxYears} financial years.`)
      .optional(),
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
    financialPrivacy: input.financialPrivacy ?? base.financialPrivacy,
    durationYears: input.durationYears ?? base.durationYears,
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
 * The settings a host asked for in the lobby (UPDATE_CONFIG). Everything is validated as at creation,
 * except financial privacy: that was fixed when the game was created, so it is carried over from the
 * current config, and asking for the other one is refused rather than silently ignored.
 */
export function updateGameConfig(mode: GameMode, current: GameConfig, raw: unknown): GameConfig {
  const next = parseGameConfig(mode, raw);
  const asked = (raw as { financialPrivacy?: unknown } | null | undefined)?.financialPrivacy;
  if (asked !== undefined && asked !== current.financialPrivacy) {
    fail('VALIDATION', 'Open or hidden finances is chosen when the game is created and can’t be changed.');
  }
  return { ...next, financialPrivacy: current.financialPrivacy };
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
    config.secretObjectives === d.secretObjectives &&
    config.financialPrivacy === d.financialPrivacy &&
    config.durationYears === d.durationYears
  );
}

/** What players call each mode. The stored value stays `intermediate` (games.game_mode, saved games, the API); only its name is Capital. */
export const GAME_MODE_LABELS: Record<GameMode, string> = { classic: 'Classic', intermediate: 'Capital' };

/** The mode's full name, where it stands on its own: "Classic Mode", "Capital Mode". */
export const GAME_MODE_NAMES: Record<GameMode, string> = { classic: `${GAME_MODE_LABELS.classic} Mode`, intermediate: `${GAME_MODE_LABELS.intermediate} Mode` };

export const MARKET_VOLATILITY_LABELS: Record<MarketVolatility, { label: string; hint: string }> = {
  stable: { label: 'Stable', hint: 'Small yearly changes. Values never fall more than 10%.' },
  balanced: { label: 'Balanced', hint: 'The standard market: rises are a little more likely than falls.' },
  volatile: { label: 'Volatile', hint: 'Big swings both ways. A 20% rise or fall is common.' },
};

export const FINANCIAL_PRIVACY_LABELS: Record<FinancialPrivacy, { label: string; hint: string }> = {
  open: { label: 'Open', hint: 'Everyone can view every player’s financial information.' },
  hidden: { label: 'Hidden', hint: 'Each player sees their own finances. Opponents see only public game information.' },
};

export interface ConfigSummaryRow {
  key: 'mode' | keyof GameConfig;
  label: string;
  value: string;
}

/** "7 financial years" — the duration as players read it. */
export function durationLabel(years: number): string {
  return `${years} financial ${years === 1 ? 'year' : 'years'}`;
}

/**
 * What a duration means at the table. A financial year passes each time the players have moved
 * IR.year.spacesPerYear spaces by dice on average — one trip round the board each — so a game of N
 * years is about N laps. An estimate for the players; the game itself counts dice movement, not laps.
 */
export function durationEstimate(years: number): string {
  return `${durationLabel(years)} · Approximately ${years} ${years === 1 ? 'lap' : 'laps'}`;
}

/**
 * The rules of one game as players read them, before and after it starts. Classic lists only what applies to it.
 * `timed: false` leaves the duration out: a matchmade game has none.
 */
export function gameConfigSummary(mode: GameMode, config: GameConfig, { timed = true }: { timed?: boolean } = {}): ConfigSummaryRow[] {
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
  rows.push({ key: 'financialPrivacy', label: 'Finances', value: FINANCIAL_PRIVACY_LABELS[config.financialPrivacy].label });
  if (timed) rows.push({ key: 'durationYears', label: 'Game duration', value: durationLabel(config.durationYears) });
  return rows;
}
