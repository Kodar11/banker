import { ActivityIndicator, Pressable, Text, View } from 'react-native';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

const VARIANTS: Record<Variant, { box: string; text: string; spinner: string }> = {
  primary: { box: 'bg-saffron border-b-4 border-saffron-dark', text: 'text-ink', spinner: '#1F1B16' },
  success: { box: 'bg-green-500 border-b-4 border-green-700', text: 'text-white', spinner: '#fff' },
  secondary: { box: 'bg-cream border-b-4 border-stone-300', text: 'text-ink', spinner: '#1F1B16' },
  danger: { box: 'bg-brick border-b-4 border-red-900', text: 'text-white', spinner: '#fff' },
  ghost: { box: 'bg-white/10 border border-white/30', text: 'text-cream', spinner: '#FFF8E7' },
};

export interface ButtonProps {
  title: string;
  subtitle?: string;
  onPress: () => void;
  variant?: Variant;
  size?: 'lg' | 'md' | 'sm';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityHint?: string;
  className?: string;
  /** Keep the title on one line (shrinks to fit instead of wrapping). Default for size "sm". */
  singleLine?: boolean;
}

/** Big, chunky, tactile button. Large touch targets for game night. */
export function Button({
  title,
  subtitle,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading = false,
  disabled = false,
  testID,
  accessibilityHint,
  className = '',
  singleLine,
}: ButtonProps) {
  const oneLine = singleLine ?? size === 'sm';
  const v = VARIANTS[variant];
  const inactive = disabled || loading;
  const pad = size === 'lg' ? 'min-h-[64px] px-6 py-4' : size === 'md' ? 'min-h-[52px] px-5 py-3' : 'min-h-[44px] px-4 py-2';
  const textSize = size === 'lg' ? 'text-xl' : size === 'md' ? 'text-lg' : 'text-base';
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => ({ transform: [{ scale: pressed && !inactive ? 0.97 : 1 }] })}
      className={`items-center justify-center rounded-2xl ${pad} ${v.box} ${inactive ? 'opacity-50' : ''} ${className}`}
    >
      {loading ? (
        <ActivityIndicator color={v.spinner} />
      ) : (
        <View className="items-center">
          <Text
            className={`${textSize} font-extrabold tracking-wide ${v.text}`}
            numberOfLines={oneLine ? 1 : undefined}
            adjustsFontSizeToFit={oneLine}
            minimumFontScale={0.75}
          >
            {title}
          </Text>
          {subtitle ? <Text className={`text-sm font-semibold opacity-80 ${v.text}`}>{subtitle}</Text> : null}
        </View>
      )}
    </Pressable>
  );
}
