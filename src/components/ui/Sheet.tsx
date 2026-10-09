import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface SheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testID?: string;
  /** Replaces the plain title (e.g. a player's identity). Stays put while the content scrolls. */
  header?: ReactNode;
  /** Pinned under the scrolling content (e.g. the sheet's main actions), above the system inset. */
  footer?: ReactNode;
}

/** Bottom sheet for secondary tasks (pay a player, loans). */
export function Sheet({ visible, title, onClose, children, testID, header, footer }: SheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <SafeAreaView edges={['bottom']} className="max-h-[85%] rounded-t-3xl bg-cream" testID={testID}>
          <View className={`flex-row justify-between gap-3 px-5 pt-4 ${header ? 'items-start pb-3' : 'items-center pb-2'}`}>
            {header ? <View className="flex-1">{header}</View> : <Text className="text-2xl font-extrabold text-ink">{title}</Text>}
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" className="h-11 w-11 items-center justify-center rounded-full bg-stone-200">
              <Text className="text-xl font-bold text-ink">✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-4 px-5 pb-6" keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View className="border-t border-stone-200 px-5 pb-4 pt-3">{footer}</View> : null}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
