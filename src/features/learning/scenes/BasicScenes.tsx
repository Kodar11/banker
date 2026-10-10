import { Text, View } from 'react-native';
import { creditBand, INTERMEDIATE_RULES as IR } from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';
import { cashAfter, creditScoresAfter } from '../calc';
import { CountUp, GrowBar } from '../motion';
import type { CashScene, CompareScene, CreditScene, HoldingsScene, NoteScene, ScheduleScene } from '../types';
import { CashChip, Panel, signedINR, StoryCardView, Tag, Who } from './parts';

/** A cash balance: where it started, each movement in or out, and where it ends. */
export function CashLedger({ scene }: { scene: CashScene }) {
  const { end } = cashAfter(scene.start, scene.movements.map((m) => m.amount));
  const moved = scene.movements.length > 0;
  const gap = scene.reserve ? end - scene.reserve.amount : 0;
  return (
    <Panel title={scene.title ?? 'Your cash'} testID="scene-cash">
      {moved ? (
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="flex-1 text-sm text-stone-600">{scene.startLabel ?? 'Cash before'}</Text>
          <Text className="text-base font-bold text-ink">{formatINR(scene.start)}</Text>
        </View>
      ) : null}
      {scene.movements.map((m) => (
        <View key={m.label} className="flex-row items-baseline justify-between gap-3" accessible accessibilityLabel={`${m.label}: ${m.amount < 0 ? 'paid' : 'received'} ${formatINR(Math.abs(m.amount))}`}>
          <Text className="flex-1 text-sm text-stone-700">
            {m.amount < 0 ? '↑ ' : '🪙 '}
            {m.label}
          </Text>
          <Text className={`text-base font-extrabold ${m.amount < 0 ? 'text-brick' : 'text-green-700'}`}>{signedINR(m.amount)}</Text>
        </View>
      ))}
      <View className={`flex-row items-baseline justify-between gap-3 ${moved ? 'border-t border-stone-200 pt-2' : ''}`}>
        <Text className="flex-1 text-sm font-bold text-ink">{scene.endLabel ?? (moved ? 'Cash now' : 'Cash')}</Text>
        <CountUp from={scene.start} to={end} format={formatINR} className="text-2xl font-black text-ink" testID="scene-cash-end" delay={200} />
      </View>
      {scene.reserve ? (
        <View className="gap-1 border-t border-stone-200 pt-2" testID="scene-cash-reserve">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="flex-1 text-sm text-stone-600">{scene.reserve.label}</Text>
            <Text className="text-base font-bold text-ink">{formatINR(scene.reserve.amount)}</Text>
          </View>
          <Tag tone={gap >= 0 ? 'good' : 'warn'}>{gap >= 0 ? `Covered, with ${formatINR(gap)} to spare` : `${formatINR(-gap)} short`}</Tag>
        </View>
      ) : null}
    </Panel>
  );
}

/** Who owns what: each person's cash and property cards. */
export function Holdings({ scene }: { scene: HoldingsScene }) {
  return (
    <Panel title={scene.title} testID="scene-holdings">
      {scene.holders.map((holder, i) => (
        <View key={holder.who} className={`gap-2 ${i > 0 ? 'border-t border-stone-200 pt-2' : ''}`}>
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Who who={holder.who} suffix={holder.note && holder.cards.length > 0 && holder.who === 'bank' ? `· ${holder.note}` : undefined} />
            {holder.cash !== undefined ? <CashChip amount={holder.cash} /> : null}
          </View>
          {holder.cards.length > 0 ? (
            <View className="flex-row flex-wrap gap-2">
              {holder.cards.map((card) => (
                <StoryCardView key={card.name} card={card} />
              ))}
            </View>
          ) : (
            <Text className="text-sm text-stone-500">No properties</Text>
          )}
          {holder.note && holder.who !== 'bank' ? <Text className="text-xs font-semibold text-stone-600">{holder.note}</Text> : null}
        </View>
      ))}
    </Panel>
  );
}

const SCHEDULE_STATUS = {
  paid: { text: 'Paid', tone: 'good' },
  due: { text: 'Due', tone: 'warn' },
  overdue: { text: 'Overdue', tone: 'bad' },
  upcoming: { text: 'Upcoming', tone: 'neutral' },
} as const;

/** A small calendar of payments. */
export function Schedule({ scene }: { scene: ScheduleScene }) {
  return (
    <Panel title={scene.title} testID="scene-schedule">
      {scene.rows.map((row) => {
        const status = row.status === 'info' ? null : SCHEDULE_STATUS[row.status];
        return (
          <View key={`${row.when}-${row.label}`} className="flex-row items-center gap-2">
            <View className="w-[76px] rounded-lg bg-stone-100 px-1.5 py-1">
              <Text className="text-center text-[11px] font-extrabold leading-4 text-stone-700">📅 {row.when}</Text>
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-bold text-ink">{row.label}</Text>
              {status ? <Tag tone={status.tone}>{status.text}</Tag> : null}
            </View>
            {row.amount !== undefined ? <Text className="text-base font-extrabold text-ink">{formatINR(row.amount)}</Text> : null}
          </View>
        );
      })}
    </Panel>
  );
}

/** A sample credit score, moved step by step by the game's own score rules. */
export function CreditScore({ scene }: { scene: CreditScene }) {
  const scores = creditScoresAfter(scene.start, scene.steps.map((s) => s.event));
  // The meter ends on the score that has actually happened; "if…" steps are listed, not applied to it.
  const settledIndex = scene.steps.reduce((last, step, i) => (step.conditional ? last : i), -1);
  const settled = settledIndex >= 0 ? scores[settledIndex]! : scene.start;
  const span = IR.credit.max - IR.credit.min;
  return (
    <Panel title={scene.title ?? 'Sample credit score'} testID="scene-credit">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="flex-1 text-sm text-stone-600">Started at</Text>
        <Text className="text-base font-bold text-ink">
          {scene.start} · {creditBand(scene.start).label}
        </Text>
      </View>
      {scene.steps.map((step, i) => {
        const delta = IR.credit.events[step.event];
        return (
          <View key={step.label} className="flex-row items-baseline justify-between gap-3" accessible accessibilityLabel={`${step.label}: ${delta < 0 ? 'minus' : 'plus'} ${Math.abs(delta)}, score ${scores[i]}`}>
            <View className="flex-1 gap-0.5">
              <Text className="text-sm text-stone-700">{step.label}</Text>
              {step.conditional ? <Tag>Only if it happens</Tag> : null}
            </View>
            <Text className={`text-base font-extrabold ${delta < 0 ? 'text-brick' : 'text-green-700'}`}>
              {delta < 0 ? '−' : '+'}
              {Math.abs(delta)} → {scores[i]}
            </Text>
          </View>
        );
      })}
      <View className="gap-1 border-t border-stone-200 pt-2">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="flex-1 text-sm font-bold text-ink">Score now</Text>
          <View className="flex-row items-baseline gap-1.5">
            <CountUp from={scene.start} to={settled} format={String} className="text-2xl font-black text-ink" testID="scene-credit-score" delay={200} />
            <Text className="text-sm font-bold text-stone-600">{creditBand(settled).label}</Text>
          </View>
        </View>
        <GrowBar fraction={(settled - IR.credit.min) / span} />
        <Text className="text-[11px] text-stone-500">
          Scale {IR.credit.min}–{IR.credit.max}
        </Text>
      </View>
    </Panel>
  );
}

/** Alternatives next to each other: one small table per alternative. */
export function Compare({ scene }: { scene: CompareScene }) {
  const wide = scene.columns.length === 1;
  return (
    <Panel title={scene.title} testID="scene-compare">
      <View className="flex-row flex-wrap gap-2">
        {scene.columns.map((column) => (
          <View key={column.title} style={{ flexGrow: 1, flexBasis: wide ? '100%' : '46%' }} className={`gap-1 rounded-xl border px-2.5 py-2 ${column.tag ? 'border-saffron bg-amber-50' : 'border-stone-200 bg-stone-50'}`}>
            <Text className="text-sm font-extrabold text-ink">{column.title}</Text>
            {column.tag ? <Tag tone="gold">{column.tag}</Tag> : null}
            {column.rows.map((row) => (
              <View key={row.label} className={wide ? 'flex-row items-baseline justify-between gap-3' : ''}>
                <Text className={`text-[11px] leading-4 text-stone-500 ${wide ? 'flex-1 text-sm' : ''}`}>{row.label}</Text>
                <Text className="text-sm font-bold text-ink">{row.value}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </Panel>
  );
}

const NOTE_TONES = {
  neutral: { box: 'bg-stone-100', icon: 'ℹ️', word: 'Note' },
  good: { box: 'bg-green-50', icon: '✅', word: 'Note' },
  warn: { box: 'bg-amber-50', icon: '⚠️', word: 'Caution' },
  bad: { box: 'bg-red-50', icon: '⚠️', word: 'Caution' },
} as const;

/** A stated assumption, limit or caution. */
export function Note({ scene }: { scene: NoteScene }) {
  const tone = NOTE_TONES[scene.tone];
  return (
    <View className={`flex-row gap-2 rounded-2xl px-3 py-2 ${tone.box}`} testID="scene-note" accessible accessibilityLabel={`${tone.word}: ${scene.text}`}>
      <Text className="text-sm">{tone.icon}</Text>
      <Text className="flex-1 text-xs leading-5 text-stone-700">{scene.text}</Text>
    </View>
  );
}
