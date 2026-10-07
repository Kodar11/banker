import { Modal, Pressable, Text, View } from 'react-native';
import { Button } from './Button';

interface ConfirmDialogProps {
  visible: boolean;
  icon?: string;
  title: string;
  message: string;
  detail?: string;
  confirmTitle: string;
  cancelTitle?: string;
  /** Destructive/irreversible confirm (danger button). */
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

/**
 * In-app confirmation card in the game's style (replaces the system Alert).
 * Tapping the backdrop or the Android back button cancels.
 */
export function ConfirmDialog({
  visible,
  icon,
  title,
  message,
  detail,
  confirmTitle,
  cancelTitle = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
  testID,
}: ConfirmDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View className="flex-1 items-center justify-center px-6">
        <Pressable
          className="absolute inset-0 bg-black/60"
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={cancelTitle}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          className="w-full max-w-sm items-center rounded-3xl border-b-4 border-stone-300 bg-cream px-6 pb-6 pt-7"
        >
          {icon ? <Text className="text-6xl">{icon}</Text> : null}
          <Text className="mt-2 text-center text-3xl font-black text-ink" accessibilityRole="header">
            {title}
          </Text>
          <Text className="mt-2 text-center text-base font-semibold text-stone-700">{message}</Text>
          {detail ? <Text className="mt-1 text-center text-sm text-stone-500">{detail}</Text> : null}
          <View className="mt-6 flex-row gap-3 self-stretch">
            <Button
              className="flex-1"
              size="md"
              variant="secondary"
              title={cancelTitle}
              testID={testID ? `${testID}-cancel` : undefined}
              disabled={loading}
              onPress={onCancel}
            />
            <Button
              className="flex-1"
              size="md"
              variant={destructive ? 'danger' : 'primary'}
              title={confirmTitle}
              testID={testID ? `${testID}-confirm` : undefined}
              loading={loading}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
