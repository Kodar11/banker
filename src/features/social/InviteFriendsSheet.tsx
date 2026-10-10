import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Pill, Sheet } from '@/components/ui';
import { useSocialStore } from '@/store/socialStore';
import { haptics } from '@/utils/haptics';
import { isExpired } from './logic';
import { useServerNow } from './lobby';

interface InviteFriendsSheetProps {
  visible: boolean;
  onClose: () => void;
  gameId: string;
  /** Why nobody can be invited right now (locked, full, started), or null. */
  closedReason: string | null;
  onShare: () => void;
}

/**
 * Direct invitations from a lobby: pick friends, the server sends each one an invitation that
 * lasts 15 minutes. A friend is shown as "Invited" only once the server has confirmed it, and as
 * "In lobby" from the server's list of who sits at the table. Non-friends get the code instead.
 */
export function InviteFriendsSheet({ visible, onClose, gameId, closedReason, onShare }: InviteFriendsSheetProps) {
  const data = useSocialStore((s) => s.data);
  const phase = useSocialStore((s) => s.phase);
  const loadError = useSocialStore((s) => s.error);
  const seats = useSocialStore((s) => s.seats[gameId]);
  const pending = useSocialStore((s) => s.pending);
  const now = useServerNow(5000);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const seated = new Set((seats ?? []).map((s) => s.player?.playerId).filter(Boolean));
  const invited = new Map((data?.sentInvites ?? []).filter((i) => i.gameId === gameId && !isExpired(i.expiresAt, now)).map((i) => [i.playerId, i.id]));

  const invite = async (playerId: string) => {
    setErrors(({ [playerId]: _old, ...rest }) => rest);
    const result = await useSocialStore.getState().sendInvite(gameId, playerId);
    if (result.ok) haptics.success();
    else {
      haptics.error();
      setErrors((e) => ({ ...e, [playerId]: result.error.message }));
    }
  };

  const revoke = async (playerId: string, inviteId: string) => {
    const result = await useSocialStore.getState().revokeInvite(inviteId);
    if (!result.ok) setErrors((e) => ({ ...e, [playerId]: result.error.message }));
  };

  return (
    <Sheet
      visible={visible}
      title="Invite friends"
      onClose={onClose}
      testID="invite-friends-sheet"
      footer={<Button title="Share game code" size="md" variant="secondary" testID="invite-share-code" onPress={onShare} />}
    >
      {closedReason ? (
        <Text className="rounded-xl bg-amber-100 px-3 py-2 text-center text-sm font-bold text-amber-900" accessibilityRole="alert" testID="invite-closed">
          {closedReason} Nobody can be invited right now.
        </Text>
      ) : null}
      {!data ? (
        <View className="items-center gap-3 py-4" testID="invite-unavailable">
          <Text className="text-center text-base text-stone-600">
            {phase === 'error' && loadError ? loadError.message : phase === 'idle' ? 'Your profile isn’t ready yet, so your friends list can’t be shown.' : 'Loading your friends…'}
          </Text>
          {phase === 'error' ? <Button title="Try again" size="sm" variant="secondary" testID="invite-retry" onPress={() => void useSocialStore.getState().refresh()} /> : null}
        </View>
      ) : data.friends.length === 0 ? (
        <View className="items-center gap-3 py-4" testID="invite-empty">
          <Text className="text-center text-base text-stone-600">You have no friends here yet. Share the game code — anyone with it can join, friend or not.</Text>
          <Button
            title="Add a friend"
            size="sm"
            variant="secondary"
            testID="invite-open-friends"
            onPress={() => {
              onClose();
              router.push('/friends');
            }}
          />
        </View>
      ) : (
        <View className="gap-2">
          {data.friends.map((friend) => {
            const inviteId = invited.get(friend.playerId);
            const busy = !!pending[`invite:${gameId}:${friend.playerId}`] || (!!inviteId && !!pending[`invitation:${inviteId}`]);
            return (
              <View key={friend.playerId} className="gap-1 rounded-xl bg-white px-4 py-3" testID={`invite-row-${friend.playerId}`}>
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-base font-bold text-ink" numberOfLines={1}>
                      {friend.nickname}
                    </Text>
                    <Text className="text-xs font-semibold tracking-wider text-stone-500">{friend.playerId}</Text>
                  </View>
                  {seated.has(friend.playerId) ? (
                    <Pill tone="good">In lobby</Pill>
                  ) : inviteId ? (
                    <View className="flex-row items-center gap-2">
                      <Pill tone="gold">Invited</Pill>
                      <Button title="Cancel" size="sm" variant="secondary" testID={`invite-revoke-${friend.playerId}`} loading={busy} onPress={() => void revoke(friend.playerId, inviteId)} />
                    </View>
                  ) : (
                    <Button title="Invite" size="sm" testID={`invite-send-${friend.playerId}`} disabled={!!closedReason} loading={busy} onPress={() => void invite(friend.playerId)} />
                  )}
                </View>
                {errors[friend.playerId] ? (
                  <Text className="text-sm font-bold text-brick" accessibilityRole="alert" testID={`invite-error-${friend.playerId}`}>
                    {errors[friend.playerId]}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Text className="text-center text-xs text-stone-500">An invitation lasts 15 minutes. It shows up in their Friends → Game Invites.</Text>
        </View>
      )}
    </Sheet>
  );
}
