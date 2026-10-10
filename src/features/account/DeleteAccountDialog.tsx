import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/ui';
import type { AccountError, Profile, Result } from './types';

export const DELETE_WORD = 'DELETE';

interface DeleteAccountDialogProps {
  visible: boolean;
  profile: Profile;
  /** Asks the server to delete the account. Resolves only with the server's answer. */
  onDelete: () => Promise<Result<true>>;
  /** A fresh Google sign-in for this account (linked accounts only). */
  onReauthenticate: () => Promise<Result<true>>;
  /** The server confirmed the deletion. */
  onDeleted: () => void;
  onClose: () => void;
}

function Point({ children }: { children: string }) {
  return (
    <View className="flex-row gap-2">
      <Text className="text-base font-black text-brick">•</Text>
      <Text className="flex-1 text-base leading-6 text-stone-700">{children}</Text>
    </View>
  );
}

/**
 * Deleting an account takes two deliberate steps: read what will happen and continue, then type
 * the word DELETE. Nothing is reported as deleted until the server has confirmed it; a failure
 * leaves the dialog open and the account exactly as it was.
 */
export function DeleteAccountDialog({ visible, profile, onDelete, onReauthenticate, onDeleted, onClose }: DeleteAccountDialogProps) {
  const [step, setStep] = useState<'explain' | 'confirm'>('explain');
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<AccountError | null>(null);

  const close = () => {
    if (working) return;
    setStep('explain');
    setTyped('');
    setError(null);
    onClose();
  };

  const run = async (reauthenticateFirst: boolean) => {
    if (working) return;
    setWorking(true);
    setError(null);
    let result: Result<true> = reauthenticateFirst ? await onReauthenticate() : { ok: true, value: true };
    if (result.ok) result = await onDelete();
    setWorking(false);
    if (result.ok) {
      setStep('explain');
      setTyped('');
      onDeleted();
    } else {
      setError(result.error);
    }
  };

  const ready = typed.trim().toUpperCase() === DELETE_WORD;
  const needsGoogle = error?.code === 'REAUTH_REQUIRED';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View className="flex-1 items-center justify-center px-6 py-10">
        <Pressable className="absolute inset-0 bg-black/60" onPress={close} accessibilityRole="button" accessibilityLabel="Cancel" testID="delete-dialog-backdrop" />
        <View testID="delete-dialog" accessibilityViewIsModal className="max-h-full w-full max-w-sm rounded-3xl bg-cream">
          <ScrollView bounces={false} style={{ flexGrow: 0 }} contentContainerClassName="gap-3 px-6 pt-7" keyboardShouldPersistTaps="handled">
            <Text className="text-center text-3xl font-black text-ink" accessibilityRole="header">
              {step === 'explain' ? 'Delete your account?' : 'Last step'}
            </Text>
            {step === 'explain' ? (
              <View className="gap-2" testID="delete-explanation">
                <Point>This is permanent. It cannot be undone.</Point>
                <Point>{`Your nickname and Player ID ${profile.playerId} are erased from the server. Nobody can get this Player ID back — including you.`}</Point>
                {profile.googleLinked ? <Point>Your Google account is disconnected from this player. Your Google account itself is not touched.</Point> : null}
                <Point>Your account holds no statistics or other records, so there is nothing else to remove.</Point>
                <Point>A game you are in right now is not affected: your seat stays and you can keep playing. Lesson progress stays on this phone.</Point>
                <Point>This is not the same as uninstalling. Uninstalling removes the app from this phone; only this deletes the account.</Point>
              </View>
            ) : (
              <View className="gap-3">
                <Text className="text-center text-base font-semibold leading-6 text-stone-700">{`Type ${DELETE_WORD} to permanently delete ${profile.nickname} (${profile.playerId}).`}</Text>
                <TextInput
                  testID="delete-confirm-input"
                  accessibilityLabel={`Type ${DELETE_WORD} to confirm`}
                  value={typed}
                  onChangeText={setTyped}
                  editable={!working}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={DELETE_WORD}
                  placeholderTextColor="#a8a29e"
                  className="rounded-2xl border-2 border-stone-300 bg-white px-4 py-3 text-center text-xl font-extrabold tracking-widest text-ink"
                />
              </View>
            )}
            {error ? (
              <Text accessibilityRole="alert" testID="delete-error" className="rounded-xl bg-red-50 px-3 py-2 text-center text-sm font-bold text-brick">
                {error.message}
              </Text>
            ) : null}
          </ScrollView>
          <View className="gap-3 px-6 pb-6 pt-5">
            {step === 'explain' ? (
              <Button size="md" variant="danger" title="Continue" testID="delete-continue" onPress={() => setStep('confirm')} />
            ) : needsGoogle ? (
              <Button size="md" variant="danger" title="Confirm with Google & delete" testID="delete-reauth" loading={working} disabled={!ready} singleLine onPress={() => void run(true)} />
            ) : (
              <Button size="md" variant="danger" title="Delete forever" testID="delete-final" loading={working} disabled={!ready} onPress={() => void run(false)} />
            )}
            <Button size="md" variant="secondary" title="Keep my account" testID="delete-cancel" disabled={working} onPress={close} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
