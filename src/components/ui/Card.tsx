import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

export function Card({
  children,
  className = '',
  testID,
  bottomBorder = true,
}: {
  children: ReactNode;
  className?: string;
  testID?: string;
  bottomBorder?: boolean;
}) {
  return (
    <View testID={testID} className={`rounded-3xl ${bottomBorder ? 'border-b-4 border-stone-300' : ''} bg-cream p-5 ${className}`}>
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

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof PILL_TONES }) {
  const t = PILL_TONES[tone];
  return (
    <View className={`self-start rounded-full px-3 py-1 ${t.box}`}>
      <Text className={`text-xs font-extrabold uppercase tracking-wider ${t.text}`}>{children}</Text>
    </View>
  );
}
