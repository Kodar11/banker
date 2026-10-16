import { Pressable, Text, View } from 'react-native';
import {
  defaultGameConfig,
  durationEstimate,
  durationLabel,
  FINANCIAL_PRIVACY_LABELS,
  FINANCIAL_PRIVACY_MODES,
  configAmountLimits,
  GAME_DURATION_OPTIONS,
  gameConfigSummary,
  isDefaultGameConfig,
  MARKET_VOLATILITIES,
  MARKET_VOLATILITY_LABELS,
  type GameConfig,
  type GameConfigAmountKey,
  type GameMode,
} from '@/engine/index.ts';
import { Label } from '@/components/ui';
import { formatINR } from '@/utils/currency';

/** One rupee setting: − value + in the server's own steps, stopping at its limits. */
function AmountRow({ mode, field, label, hint, value, onChange }: { mode: GameMode; field: GameConfigAmountKey; label: string; hint: string; value: number; onChange: (next: number) => void }) {
  const { min, max, step } = configAmountLimits(mode, field);
  const stepper = (delta: number, symbol: string, name: string) => {
    const next = value + delta;
    const disabled = next < min || next > max;
    return (
      <Pressable
        onPress={() => onChange(next)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${name} ${label.toLowerCase()} by ${formatINR(step)}`}
        accessibilityState={{ disabled }}
        testID={`config-${field}-${delta < 0 ? 'minus' : 'plus'}`}
        className={`h-11 w-11 items-center justify-center rounded-full bg-white active:opacity-70 ${disabled ? 'opacity-30' : ''}`}
      >
        <Text className="text-2xl font-black text-ink">{symbol}</Text>
      </Pressable>
    );
  };
  return (
    // Wraps on a narrow phone: the stepper drops under its label instead of squeezing it.
    <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <View className="min-w-[120px] flex-1">
        <Text className="text-base font-extrabold text-ink">{label}</Text>
        <Text className="text-xs text-stone-500">{hint}</Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        {stepper(-step, '−', 'Lower')}
        <Text className="min-w-[80px] text-center text-lg font-black text-ink" testID={`config-${field}-value`} accessibilityLabel={`${label} ${formatINR(value)}`}>
          {formatINR(value)}
        </Text>
        {stepper(step, '+', 'Raise')}
      </View>
    </View>
  );
}

/** A row of mutually exclusive choices (same look as the mode cards: saffron edge on the chosen one). */
export function Choice<T extends string>({ value, options, onChange, testID }: { value: T; options: { value: T; label: string; accessibilityLabel?: string }[]; onChange: (next: T) => void; testID: string }) {
  return (
    <View className="flex-row gap-2" accessibilityRole="radiogroup" testID={testID}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.accessibilityLabel ?? o.label}
            testID={`${testID}-${o.value}`}
            className={`min-h-[44px] flex-1 items-center justify-center rounded-2xl border-2 bg-white px-2 active:opacity-70 ${selected ? 'border-saffron' : 'border-transparent'}`}
          >
            <Text className={`text-sm font-extrabold ${selected ? 'text-ink' : 'text-stone-500'}`}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface EditorProps {
  mode: GameMode;
  value: GameConfig;
  onChange: (next: GameConfig) => void;
  /** Open or hidden finances can be chosen. Only when creating a game: afterwards it is fixed, so the lobby leaves it out. */
  privacyEditable?: boolean;
}

/**
 * The settings a host may change, grouped: money for every game, then the Capital extras.
 * It only offers what the server accepts (same limits, same steps), and the server checks again.
 */
export function GameConfigEditor({ mode, value, onChange, privacyEditable = false }: EditorProps) {
  const set = (patch: Partial<GameConfig>) => onChange({ ...value, ...patch });
  // Where financial privacy can't be edited it is not this editor's to restore either: it keeps the game's own.
  const defaults = { ...defaultGameConfig(mode), ...(privacyEditable ? {} : { financialPrivacy: value.financialPrivacy }) };
  const isDefault = isDefaultGameConfig(mode, privacyEditable ? value : { ...value, financialPrivacy: defaultGameConfig(mode).financialPrivacy });
  return (
    <View className="gap-4" testID="config-editor">
      <AmountRow mode={mode} field="startingCash" label="Starting cash" hint="Each player, from the bank" value={value.startingCash} onChange={(startingCash) => set({ startingCash })} />
      <AmountRow mode={mode} field="loanLimit" label="Loan limit" hint="Most a player can owe the bank in loans" value={value.loanLimit} onChange={(loanLimit) => set({ loanLimit })} />
      <View className="gap-1.5">
        <Text className="text-base font-extrabold text-ink">Game duration</Text>
        <Choice
          testID="config-duration"
          value={String(value.durationYears)}
          options={GAME_DURATION_OPTIONS.map((years) => ({ value: String(years), label: String(years), accessibilityLabel: durationLabel(years) }))}
          onChange={(years) => set({ durationYears: Number(years) })}
        />
        <Text className="text-sm font-extrabold text-ink" testID="config-duration-value">
          {durationEstimate(value.durationYears)}
        </Text>
        <Text className="text-xs text-stone-500" testID="config-duration-hint">
          Choose how many financial years the game will run before players vote to finish or extend it.
        </Text>
      </View>
      {mode === 'intermediate' ? (
        <>
          <View className="gap-1.5">
            <Text className="text-base font-extrabold text-ink">Property market</Text>
            <Choice
              testID="config-volatility"
              value={value.marketVolatility}
              options={MARKET_VOLATILITIES.map((v) => ({ value: v, label: MARKET_VOLATILITY_LABELS[v].label }))}
              onChange={(marketVolatility) => set({ marketVolatility })}
            />
            <Text className="text-xs text-stone-500" testID="config-volatility-hint">
              {MARKET_VOLATILITY_LABELS[value.marketVolatility].hint}
            </Text>
          </View>
          <View className="gap-1.5">
            <Text className="text-base font-extrabold text-ink">Secret objectives</Text>
            <Choice
              testID="config-objectives"
              value={value.secretObjectives ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(next) => set({ secretObjectives: next === 'on' })}
            />
            <Text className="text-xs text-stone-500">
              {value.secretObjectives ? 'Each player gets a private goal. Completing it pays a bonus when the game ends.' : 'No private goals and no end-of-game bonus.'}
            </Text>
          </View>
        </>
      ) : null}
      {privacyEditable ? (
        <View className="gap-1.5">
          <Text className="text-base font-extrabold text-ink">Financial privacy</Text>
          <Choice
            testID="config-privacy"
            value={value.financialPrivacy}
            options={FINANCIAL_PRIVACY_MODES.map((v) => ({ value: v, label: `${FINANCIAL_PRIVACY_LABELS[v].label} finances` }))}
            onChange={(financialPrivacy) => set({ financialPrivacy })}
          />
          <Text className="text-xs text-stone-500" testID="config-privacy-hint">
            {FINANCIAL_PRIVACY_LABELS[value.financialPrivacy].hint} It can’t be changed after the game is created.
          </Text>
        </View>
      ) : null}
      <Pressable
        onPress={() => onChange(defaults)}
        disabled={isDefault}
        accessibilityRole="button"
        accessibilityLabel="Restore default settings"
        accessibilityState={{ disabled: isDefault }}
        testID="config-restore-defaults"
        className={`min-h-[44px] items-center justify-center self-start rounded-2xl border-2 border-stone-300 px-4 active:opacity-70 ${isDefault ? 'opacity-40' : ''}`}
      >
        <Text className="text-sm font-extrabold text-ink">Restore defaults</Text>
      </Pressable>
    </View>
  );
}

/** The rules of this game, as every player reads them. Classic lists only what applies to Classic. */
export function GameConfigSummary({
  mode,
  config,
  title = 'Game rules',
  note,
  testID = 'config-summary',
  timed = true,
}: {
  mode: GameMode;
  config: GameConfig;
  title?: string;
  note?: string;
  testID?: string;
  /** False for a matchmade game, which has no duration to list. */
  timed?: boolean;
}) {
  return (
    <View testID={testID} className="gap-1">
      <Label>{title}</Label>
      {gameConfigSummary(mode, config, { timed }).map((row) => (
        <View key={row.key} className="flex-row items-center justify-between gap-3 py-0.5" testID={`${testID}-${row.key}`} accessible accessibilityLabel={`${row.label}: ${row.value}`}>
          <Text className="flex-1 text-base text-stone-600">{row.label}</Text>
          <Text className="text-base font-extrabold text-ink">{row.value}</Text>
        </View>
      ))}
      {note ? <Text className="mt-1 text-xs text-stone-500">{note}</Text> : null}
    </View>
  );
}
