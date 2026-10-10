import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { GROUP_LABELS } from '@/engine/index.ts';
import { Label, PlayerBadge } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import type { CastId, StoryCard } from '../types';

/** The people in the stories. Seats only pick a colour from the app's player palette. */
export const CAST: Record<CastId, { name: string; seat: number | null }> = {
  you: { name: 'You', seat: 2 },
  meera: { name: 'Meera', seat: 1 },
  kabir: { name: 'Kabir', seat: 3 },
  bank: { name: 'Bank', seat: null },
};

/** "+₹2,000" / "−₹500": the sign is always written, so direction never depends on colour. */
export function signedINR(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${formatINR(Math.abs(amount))}`;
}

/** A white panel inside the lesson card: one picture of the story. */
export function Panel({ title, children, testID, accessibilityLabel }: { title?: string; children: ReactNode; testID?: string; accessibilityLabel?: string }) {
  return (
    <View className="gap-2 rounded-2xl bg-white p-3" testID={testID} accessibilityLabel={accessibilityLabel}>
      {title ? <Label>{title}</Label> : null}
      {children}
    </View>
  );
}

export function Who({ who, suffix }: { who: CastId; suffix?: string }) {
  const cast = CAST[who];
  return (
    <View className="flex-row items-center gap-1.5">
      {cast.seat === null ? <Text className="text-base">🏦</Text> : <PlayerBadge player={{ name: cast.name, seat: cast.seat }} size={20} />}
      <Text className="text-sm font-extrabold text-ink">
        {cast.name}
        {suffix ? <Text className="font-semibold text-stone-600"> {suffix}</Text> : null}
      </Text>
    </View>
  );
}

/** A small title deed: colour band, name, one fact and — in words — any state it is in. */
export function StoryCardView({ card }: { card: StoryCard }) {
  const theme = PROPERTY_GROUP_THEME[card.group];
  return (
    <View
      accessible
      accessibilityLabel={[card.name, `${GROUP_LABELS[card.group]} property`, card.detail, card.tag].filter(Boolean).join(', ')}
      className={`w-[104px] overflow-hidden rounded-xl border border-stone-300 bg-cream ${card.faded ? 'opacity-50' : ''}`}
    >
      <View style={{ backgroundColor: theme.color, height: 12, borderBottomWidth: 1, borderBottomColor: '#D6D3D1' }} />
      <View className="gap-0.5 px-2 py-1.5">
        <Text className="text-xs font-extrabold leading-4 text-ink">{card.name}</Text>
        {card.detail ? <Text className="text-[11px] leading-4 text-stone-600">{card.detail}</Text> : null}
        {card.tag ? <Text className="text-[11px] font-extrabold leading-4 text-amber-800">{card.tag}</Text> : null}
      </View>
    </View>
  );
}

/** Cash drawn as a coin and an amount. */
export function CashChip({ amount, label }: { amount: number; label?: string }) {
  return (
    <View className="flex-row items-center gap-1 self-start rounded-full bg-amber-100 px-2.5 py-1" accessible accessibilityLabel={`${label ?? 'Cash'} ${formatINR(amount)}`}>
      <Text className="text-xs">🪙</Text>
      <Text className="text-xs font-extrabold text-ink">
        {label ? `${label} ` : ''}
        {formatINR(amount)}
      </Text>
    </View>
  );
}

const TAG_TONES = {
  neutral: 'bg-stone-200 text-stone-700',
  good: 'bg-green-100 text-green-800',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-red-800',
  gold: 'bg-saffron text-ink',
} as const;

/** A short status word in a tinted chip. The word carries the meaning; the tint only supports it. */
export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof TAG_TONES }) {
  return <Text className={`self-start overflow-hidden rounded-full px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider ${TAG_TONES[tone]}`}>{children}</Text>;
}
