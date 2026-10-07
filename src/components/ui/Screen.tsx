import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
  testID?: string;
}

/** Full-screen felt-table background with safe areas and keyboard handling. */
export function Screen({ children, scroll = false, footer, testID }: ScreenProps) {
  const body = scroll ? (
    <ScrollView contentContainerClassName="px-5 pb-8 pt-2 gap-4" keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View className="flex-1 gap-4 px-5 pt-2">{children}</View>
  );
  return (
    <SafeAreaView testID={testID} className="flex-1 bg-felt" edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
        {footer ? <View className="gap-3 px-5 pb-3 pt-2">{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
