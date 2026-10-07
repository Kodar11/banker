import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface SheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testID?: string;
}

/** Bottom sheet for secondary tasks (pay a player, loans). */
export function Sheet({ visible, title, onClose, children, testID }: SheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <SafeAreaView edges={['bottom']} className="max-h-[85%] rounded-t-3xl bg-cream" testID={testID}>
          <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
            <Text className="text-2xl font-extrabold text-ink">{title}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" className="h-11 w-11 items-center justify-center rounded-full bg-stone-200">
              <Text className="text-xl font-bold text-ink">✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-4 px-5 pb-6" keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
