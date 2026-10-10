import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Button } from './Button';

interface ConfirmDialogProps {
  visible: boolean;
  icon?: string;
  title: string;
  /** What exactly is being confirmed (a transaction, a trade), set apart from the explanation. */
  summary?: string;
  message: string;
  detail?: string;
  confirmTitle: string;
  cancelTitle?: string;
  /** How weighty the confirm is: an ordinary choice, one to think about, or one that can't be taken back. */
  intent?: 'neutral' | 'warning' | 'destructive';
  /** Same as intent="destructive". */
  destructive?: boolean;
  /** The confirmed action is on its way: the confirm button spins and nothing can be pressed or dismissed. */
  loading?: boolean;
  /** Why the confirmed action failed. The dialog stays open so it can be tried again. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

const SUMMARY_TONE = {
  neutral: 'border-stone-200 bg-white',
  warning: 'border-amber-300 bg-amber-50',
  destructive: 'border-red-200 bg-red-50',
} as const;

/**
 * In-app confirmation card in the game's style (replaces the system Alert).
 * Tapping the backdrop or the Android back button cancels — except while the action is being sent.
 * To confirm something from inside a Sheet, render the dialog inside that sheet: it then opens
 * above it and closing it leaves the sheet as it was.
 */
export function ConfirmDialog({
  visible,
  icon,
  title,
  summary,
  message,
  detail,
  confirmTitle,
  cancelTitle = 'Cancel',
  intent,
  destructive = false,
  loading = false,
  error,
  onConfirm,
  onCancel,
  testID,
}: ConfirmDialogProps) {
  const tone = intent ?? (destructive ? 'destructive' : 'neutral');
  const dismiss = () => {
    if (!loading) onCancel();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss} statusBarTranslucent>
      <View className="flex-1 items-center justify-center px-6 py-10">
        <Pressable
          className="absolute inset-0 bg-black/60"
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel={cancelTitle}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <View testID={testID} accessibilityViewIsModal className="max-h-full w-full max-w-sm rounded-3xl border-b-4 border-stone-300 bg-cream">
          {/* Long text (or a large font size) scrolls inside the card; the buttons stay in reach below it. */}
          <ScrollView bounces={false} style={{ flexGrow: 0 }} contentContainerClassName="items-center px-6 pt-7">
            {icon ? <Text className="text-6xl">{icon}</Text> : null}
            <Text className={`text-center text-3xl font-black text-ink ${icon ? 'mt-2' : ''}`} accessibilityRole="header">
              {title}
            </Text>
            {summary ? (
              <View className={`mt-4 self-stretch rounded-2xl border px-4 py-3 ${SUMMARY_TONE[tone]}`} testID={testID ? `${testID}-summary` : undefined}>
                <Text className="text-center text-lg font-extrabold leading-6 text-ink">{summary}</Text>
              </View>
            ) : null}
            <Text className={`text-center text-base font-semibold leading-6 text-stone-700 ${summary ? 'mt-3' : 'mt-2'}`}>{message}</Text>
            {detail ? <Text className="mt-1 text-center text-sm leading-5 text-stone-500">{detail}</Text> : null}
            {error ? (
              <Text accessibilityRole="alert" className="mt-3 self-stretch rounded-xl bg-red-50 px-3 py-2 text-center text-sm font-bold text-brick" testID={testID ? `${testID}-error` : undefined}>
                {error}
              </Text>
            ) : null}
          </ScrollView>
          <View className="flex-row gap-3 px-6 pb-6 pt-5">
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
              variant={tone === 'destructive' ? 'danger' : 'primary'}
              title={confirmTitle}
              testID={testID ? `${testID}-confirm` : undefined}
              loading={loading}
              singleLine
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
