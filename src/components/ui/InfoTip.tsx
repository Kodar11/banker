import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Button } from './Button';

interface InfoTipProps {
  /** The label the explanation belongs to. Shown next to the icon, and as the card's heading. */
  label: string;
  /** The explanation itself. */
  text: string;
  /** Classes for the label text (size, colour), so it matches the labels around it. */
  labelClassName?: string;
  className?: string;
  testID?: string;
}

/**
 * A label with a small ⓘ beside it: tapping either opens the explanation in a card, in the same
 * style as ConfirmDialog. The whole label is the touch target, so the visible icon can stay small.
 * Tapping outside, "Got it" or the Android back button closes it. Like ConfirmDialog, it opens
 * above a Sheet it is rendered in.
 */
export function InfoTip({ label, text, labelClassName = 'text-sm text-stone-600', className = '', testID }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}. More information`}
        accessibilityHint="Opens an explanation"
        testID={testID}
        // No taller than the label, so a row with an ⓘ keeps the rhythm of the rows around it; the slop makes up the touch target.
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
        className={`flex-row items-center gap-1.5 active:opacity-70 ${className}`}
      >
        <Text className={`shrink ${labelClassName}`}>{label}</Text>
        <View className="h-[18px] w-[18px] items-center justify-center rounded-full border border-stone-400">
          <Text className="text-[11px] font-black leading-[14px] text-stone-500">i</Text>
        </View>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <View className="flex-1 items-center justify-center px-6 py-10">
          <Pressable className="absolute inset-0 bg-black/60" onPress={close} accessibilityRole="button" accessibilityLabel="Close" testID={testID ? `${testID}-backdrop` : undefined} />
          <View accessibilityViewIsModal className="max-h-full w-full max-w-sm rounded-3xl bg-cream">
            {/* Long text (or a large font size) scrolls inside the card; the button stays in reach below it. */}
            <ScrollView bounces={false} style={{ flexGrow: 0 }} contentContainerClassName="gap-2 px-6 pt-6">
              <Text className="text-xl font-black text-ink" accessibilityRole="header">
                {label}
              </Text>
              <Text className="text-base leading-6 text-stone-700" testID={testID ? `${testID}-text` : undefined}>
                {text}
              </Text>
            </ScrollView>
            <View className="px-6 pb-6 pt-5">
              <Button size="md" title="Got it" testID={testID ? `${testID}-close` : undefined} onPress={close} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
