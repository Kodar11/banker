import { Text, TextInput, View, type TextInputProps } from 'react-native';

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  big?: boolean;
}

export function TextField({ label, error, big = false, ...input }: TextFieldProps) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-bold uppercase tracking-widest text-cream/80">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#a8a29e"
        className={`rounded-2xl border-2 bg-cream px-4 text-ink ${big ? 'py-4 text-center text-4xl font-extrabold tracking-[8px]' : 'py-3 text-xl font-semibold'} ${error ? 'border-brick' : 'border-transparent'}`}
        {...input}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-sm font-semibold text-amber-200">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
