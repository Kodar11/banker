import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { formatINR } from '@/utils/currency';

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  big?: boolean;
  /** Fixed text inside the field, before the input (e.g. "₹"). */
  prefix?: string;
  /** How loud the field is in its form: the one thing to fill in ("strong"), or an afterthought ("quiet"). */
  emphasis?: 'normal' | 'strong' | 'quiet';
}

export function TextField({ label, error, big = false, prefix, emphasis = 'normal', ...input }: TextFieldProps) {
  const text = big
    ? 'py-4 text-center text-4xl font-extrabold tracking-[8px]'
    : emphasis === 'strong'
      ? 'py-2.5 text-3xl font-extrabold'
      : emphasis === 'quiet'
        ? 'py-2 text-base font-medium'
        : 'py-3 text-xl font-semibold';
  const box = `rounded-2xl border-2 bg-cream ${error ? 'border-brick' : 'border-transparent'}`;
  return (
    <View className="gap-2">
      <Text className={`font-bold uppercase tracking-widest ${emphasis === 'quiet' ? 'text-xs text-cream/60' : 'text-sm text-cream/80'}`}>{label}</Text>
      {prefix ? (
        <View className={`flex-row items-center pl-4 ${box}`}>
          <Text className={`font-extrabold text-stone-500 ${emphasis === 'strong' ? 'text-3xl' : 'text-xl'}`}>{prefix}</Text>
          <TextInput accessibilityLabel={label} placeholderTextColor="#a8a29e" className={`flex-1 pl-2 pr-4 text-ink ${text}`} {...input} />
        </View>
      ) : (
        <TextInput accessibilityLabel={label} placeholderTextColor="#a8a29e" className={`px-4 text-ink ${box} ${text}`} {...input} />
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm font-semibold text-amber-200">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface MoneyFieldProps extends Omit<TextFieldProps, 'value' | 'onChangeText' | 'prefix' | 'keyboardType' | 'big'> {
  /** Whole rupees as plain digits ("5000"); empty when nothing is entered. */
  value: string;
  onChangeValue: (digits: string) => void;
}

/** A rupee amount: "₹" in the field, digits only, shown grouped as they are typed (5,000). */
export function MoneyField({ value, onChangeValue, ...field }: MoneyFieldProps) {
  return (
    <TextField
      prefix="₹"
      keyboardType="number-pad"
      value={value ? formatINR(Number(value)).replace('₹', '') : ''}
      onChangeText={(t) =>
        onChangeValue(
          t
            .replace(/\D/g, '')
            .replace(/^0+(?=\d)/, '')
            .slice(0, 9),
        )
      }
      {...field}
    />
  );
}
