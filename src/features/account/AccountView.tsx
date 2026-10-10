import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Button, Card, ConfirmDialog, Label, Pill, Screen, TextField } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { useAccountStatus, useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { goBack } from '@/utils/navigation';
import { haptics } from '@/utils/haptics';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { checkNickname, NICKNAME_MAX, NICKNAME_MESSAGES, nicknameLength } from './nickname';
import { ACCOUNT_STATUS_LABEL, type AccountError, type Profile } from './types';

export const GUEST_WARNING =
  'Your account is currently a guest account. If you uninstall the app or lose this device’s session before linking Google, you may permanently lose access to this account. Link Google to recover it on another device.';

function retryHint(error: AccountError): string {
  if (error.code !== 'RATE_LIMITED' || !error.retryAfterSeconds) return error.message;
  const minutes = Math.ceil(error.retryAfterSeconds / 60);
  return `${error.message} (in about ${minutes >= 90 ? `${Math.round(minutes / 60)} hours` : `${minutes} min`})`;
}

function NicknameEditor({ profile, editable }: { profile: Profile; editable: boolean }) {
  const saving = useAccountStore((s) => s.saving);
  const updateNickname = useAccountStore((s) => s.updateNickname);
  const [draft, setDraft] = useState(profile.nickname);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const check = checkNickname(draft);
  const changed = check.ok && check.nickname !== profile.nickname;
  // Problems show as soon as they exist — except on the untouched field.
  const problem = !check.ok && draft !== profile.nickname ? NICKNAME_MESSAGES[check.problem] : null;

  const save = async () => {
    if (!changed || saving || !editable) return;
    setFailure(null);
    setSaved(false);
    const result = await updateNickname(draft);
    if (result.ok) {
      setDraft(result.value.nickname);
      setSaved(true);
      haptics.success();
    } else {
      // The profile still holds the old nickname; the typed text stays so it can be corrected or retried.
      setFailure(retryHint(result.error));
      haptics.error();
    }
  };

  return (
    <View className="gap-2">
      <TextField
        label="Nickname"
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setFailure(null);
          setSaved(false);
        }}
        editable={editable && !saving}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        error={problem ?? failure}
        testID="nickname-input"
      />
      <View className="flex-row items-center justify-between">
        <Text testID="nickname-counter" className="text-xs font-semibold text-cream/70" accessibilityLabel={`${nicknameLength(draft)} of ${NICKNAME_MAX} characters`}>
          {nicknameLength(draft)}/{NICKNAME_MAX}
        </Text>
        {saved ? (
          <Text testID="nickname-saved" accessibilityRole="alert" className="text-sm font-bold text-green-300">
            ✓ Nickname saved
          </Text>
        ) : null}
      </View>
      <Button size="md" title="Save nickname" testID="nickname-save" loading={saving} disabled={!changed || !editable} onPress={() => void save()} />
    </View>
  );
}

function PlayerIdCard({ playerId }: { playerId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(playerId);
      setCopied(true);
      haptics.tap();
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card testID="player-id-card" className="gap-2">
      <Label>Player ID</Label>
      <Text testID="player-id" selectable className="text-3xl font-black tracking-widest text-ink">
        {playerId}
      </Text>
      <Text className="text-sm leading-5 text-stone-600">Yours for good — it never changes. It is safe to share: it identifies you, it does not sign anyone in.</Text>
      <Button size="sm" title={copied ? '✓ Copied' : 'Copy Player ID'} testID="copy-player-id" className="self-start" onPress={() => void copy()} />
    </Card>
  );
}

export function AccountView() {
  const phase = useAccountStore((s) => s.phase);
  const profile = useAccountStore((s) => s.profile);
  const verified = useAccountStore((s) => s.verified);
  const error = useAccountStore((s) => s.error);
  const busy = useAccountStore((s) => s.busy);
  const status = useAccountStatus();
  const notify = useGameStore((s) => s.notify);

  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmNewGuest, setConfirmNewGuest] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkMessage, setLinkMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const ready = phase === 'ready' && verified;
  const account = useAccountStore.getState;

  const link = async () => {
    setLinkMessage(null);
    const result = await account().linkGoogle();
    if (result.ok) {
      haptics.success();
      setLinkMessage({ kind: 'success', text: 'Google account linked. Your Player ID and nickname are unchanged.' });
    } else if (result.error.code !== 'CANCELLED') {
      haptics.error();
      setLinkMessage({ kind: 'error', text: result.error.message });
    }
  };

  const restore = async () => {
    setConfirmRestore(false);
    setLinkMessage(null);
    const result = await account().restoreWithGoogle();
    if (result.ok) {
      haptics.success();
      setLinkMessage({
        kind: 'success',
        text: result.value.startedNew
          ? 'No saved player was linked to that Google account, so a new one was started and linked to it.'
          : `Welcome back, ${result.value.profile.nickname}. Account restored.`,
      });
    } else if (result.error.code !== 'CANCELLED') {
      haptics.error();
      setLinkMessage({ kind: 'error', text: result.error.message });
    }
  };

  const deleted = () => {
    setConfirmDelete(false);
    notify('success', 'Your account was deleted.');
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
    // Only now, with the deletion confirmed, does the phone start over as a new guest.
    void account().initialize();
  };

  return (
    <Screen scroll testID="account-screen">
      <Button size="sm" variant="ghost" title="‹ Back" className="self-start" onPress={() => goBack('/')} />
      <Text className="text-4xl font-black text-cream">Settings</Text>

      {!profile && (phase === 'idle' || phase === 'loading') ? (
        <View testID="account-loading" className="items-center gap-3 py-10">
          <ActivityIndicator size="large" color={COLORS.saffron} />
          <Text className="text-base font-semibold text-cream">Loading your profile…</Text>
        </View>
      ) : null}

      {phase === 'unavailable' ? (
        <Card testID="account-unavailable" className="gap-3">
          <Text className="text-lg font-extrabold text-ink">{profile ? 'Can’t reach your account right now' : 'Your profile couldn’t be loaded'}</Text>
          <Text accessibilityRole="alert" className="text-sm leading-5 text-stone-700">
            {error?.message ?? 'Check your connection and try again.'} Nothing has been lost, and you can keep playing.
          </Text>
          <Button size="md" title="Try again" testID="account-retry" onPress={() => void account().initialize()} />
        </Card>
      ) : null}

      {phase === 'signedOut' ? (
        <Card testID="account-signed-out" className="gap-3">
          <Text className="text-lg font-extrabold text-ink">You’re signed out on this phone</Text>
          <Text className="text-sm leading-5 text-stone-700">
            {profile ? `The session for ${profile.nickname} (${profile.playerId}) has ended. ` : ''}
            If that account was linked to Google, you can restore it. A guest account that was never linked cannot be recovered.
          </Text>
          <Button size="md" title="Restore with Google" testID="restore-google" loading={busy === 'restore'} disabled={!!busy} onPress={() => void restore()} />
          <Button size="md" variant="outline" title="Start a new guest account" testID="new-guest" loading={busy === 'guest'} disabled={!!busy} onPress={() => setConfirmNewGuest(true)} />
          {linkMessage ? (
            <Text accessibilityRole="alert" testID={linkMessage.kind === 'success' ? 'link-success' : 'link-error'} className={`text-sm font-bold ${linkMessage.kind === 'success' ? 'text-green-700' : 'text-brick'}`}>
              {linkMessage.text}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {profile && phase !== 'signedOut' ? (
        <>
          <Label className="text-cream/70">Player profile</Label>
          {/* Keyed by account: switching players starts the editor from that player's nickname. */}
          <NicknameEditor key={profile.userId} profile={profile} editable={ready && !busy} />
          <PlayerIdCard playerId={profile.playerId} />

          <Label className="text-cream/70">Account security</Label>
          <Card testID="account-security" className="gap-3">
            <View testID="account-status">
              <Pill tone={status === 'google' ? 'good' : status === 'guest' ? 'warn' : 'neutral'}>{status ? ACCOUNT_STATUS_LABEL[status] : phase === 'loading' ? 'Checking account status…' : 'Account status unknown — offline'}</Pill>
            </View>
            {status === 'guest' ? (
              <>
                <Text testID="guest-warning" className="text-sm leading-5 text-stone-700">
                  {GUEST_WARNING}
                </Text>
                <Button size="md" title="Link Google Account" testID="link-google" loading={busy === 'link'} disabled={!!busy} onPress={() => void link()} />
              </>
            ) : null}
            {status === 'google' ? (
              <Text testID="recovery-info" className="text-sm leading-5 text-stone-700">
                To get this account on another phone: install the app, open Settings and choose “Restore with Google” with the same Google account. Your Player ID and nickname come back.
              </Text>
            ) : null}
            {linkMessage ? (
              <Text accessibilityRole="alert" testID={linkMessage.kind === 'success' ? 'link-success' : 'link-error'} className={`text-sm font-bold ${linkMessage.kind === 'success' ? 'text-green-700' : 'text-brick'}`}>
                {linkMessage.text}
              </Text>
            ) : null}
            {ready ? (
              <View className="gap-2 border-t border-stone-200 pt-3">
                <Text className="text-sm leading-5 text-stone-600">Already have a player linked to Google? Signing in with Google is the only way to recover an account.</Text>
                <Button
                  size="sm"
                  variant="outline"
                  title="Restore another account with Google"
                  testID="restore-google"
                  loading={busy === 'restore'}
                  disabled={!!busy}
                  className="self-start"
                  onPress={() => setConfirmRestore(true)}
                />
              </View>
            ) : null}
          </Card>

          <Label className="text-cream/70">Danger zone</Label>
          <Card testID="danger-zone" className="gap-3 border-2 border-brick/40">
            <Text className="text-sm leading-5 text-stone-700">Permanently delete your profile, Player ID and sign-in from the server. This cannot be undone.</Text>
            <Button size="md" variant="danger" title="Delete Account" testID="delete-account" disabled={!ready || !!busy} onPress={() => setConfirmDelete(true)} />
          </Card>

          <ConfirmDialog
            visible={confirmRestore}
            testID="restore-dialog"
            intent="warning"
            title="Switch accounts?"
            summary={`This phone will switch to the player linked to the Google account you choose.`}
            message={
              status === 'google'
                ? `You can come back to ${profile.nickname} (${profile.playerId}) later by restoring with its own Google account. Accounts are never merged.`
                : `Your current guest account ${profile.nickname} (${profile.playerId}) is not linked. If the switch goes through you will permanently lose access to it. Accounts are never merged.`
            }
            detail="If no player is linked to that Google account, nothing changes."
            confirmTitle="Continue"
            cancelTitle="Stay here"
            onConfirm={() => void restore()}
            onCancel={() => setConfirmRestore(false)}
          />
          <DeleteAccountDialog
            visible={confirmDelete}
            profile={profile}
            onDelete={() => account().deleteAccount()}
            onReauthenticate={() => account().reauthenticate()}
            onDeleted={deleted}
            onClose={() => setConfirmDelete(false)}
          />
        </>
      ) : null}

      <ConfirmDialog
        visible={confirmNewGuest}
        testID="new-guest-dialog"
        intent="warning"
        title="Start a new guest account?"
        message="You’ll get a new Player ID and nickname. If your old account was linked to Google, restore it instead — a new guest account does not bring it back."
        confirmTitle="Start new"
        onConfirm={() => {
          setConfirmNewGuest(false);
          void account().startNewGuest();
        }}
        onCancel={() => setConfirmNewGuest(false)}
      />
    </Screen>
  );
}
