import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

/** A plain cream surface. No edge of its own: a card that needs an accent edge asks for one in `className`. */
export function Card({ children, className = '', testID }: { children: ReactNode; className?: string; testID?: string }) {
  return (
    <View testID={testID} className={`rounded-3xl bg-cream p-5 ${className}`}>
      {children}
    </View>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Text className={`text-xs font-bold uppercase tracking-widest text-stone-500 ${className}`}>{children}</Text>;
}

const PILL_TONES = {
  neutral: { box: 'bg-stone-200', text: 'text-stone-700' },
  good: { box: 'bg-green-100', text: 'text-green-800' },
  warn: { box: 'bg-amber-100', text: 'text-amber-800' },
  bad: { box: 'bg-red-100', text: 'text-red-800' },
  gold: { box: 'bg-saffron', text: 'text-ink' },
} as const;

/** Hugs its text at the start of a column by default. Inside a row, pass `className="self-center"` to sit on the row's centre line. */
export function Pill({ children, tone = 'neutral', className = 'self-start' }: { children: ReactNode; tone?: keyof typeof PILL_TONES; className?: string }) {
  const t = PILL_TONES[tone];
  return (
    <View className={`rounded-full px-3 py-1 ${t.box} ${className}`}>
      <Text className={`text-xs font-extrabold uppercase tracking-wider ${t.text}`}>{children}</Text>
    </View>
  );
}
