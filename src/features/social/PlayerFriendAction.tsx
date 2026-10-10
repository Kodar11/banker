import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Pill } from '@/components/ui';
import { serverNow } from '@/lib/serverClock';
import { useSocialStore } from '@/store/socialStore';
import { haptics } from '@/utils/haptics';
import { FRIEND_ACTION_LABEL, friendActionOf, liveRequests } from './logic';

/**
 * "Add Friend" for another player at my table — in the lobby and in a running game.
 * It only ever talks to the friends functions: nothing here can touch the game or the turn.
 * Shows nothing until the social data of the signed-in account has loaded.
 */
export function PlayerFriendAction({ gameId, seatId }: { gameId: string; seatId: string }) {
  const data = useSocialStore((s) => s.data);
  const seat = useSocialStore((s) => s.seats[gameId]?.find((p) => p.seatId === seatId));
  const pending = useSocialStore((s) => s.pending);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  if (!data) return null;

  const now = serverNow();
  const action = friendActionOf(data, seat, now);
  const player = seat?.player ?? null;
  const request = player ? liveRequests(data.incoming, now).find((r) => r.playerId === player.playerId) : undefined;
  const busy = !!player && (!!pending[`request:${player.playerId}`] || (!!request && !!pending[`respond:${request.id}`]));

  const report = (result: { ok: true } | { ok: false; error: { message: string } }, success: string) => {
    if (result.ok) {
      haptics.success();
      setMessage({ kind: 'success', text: success });
    } else {
      haptics.error();
      setMessage({ kind: 'error', text: result.error.message });
    }
  };

  const add = async () => {
    if (!player) return;
    setMessage(null);
    const result = await useSocialStore.getState().sendRequest(player.playerId);
    report(result, result.ok && result.value.relationship === 'friends' ? `You and ${player.nickname} are now friends.` : `Friend request sent to ${player.nickname}.`);
  };

  const respond = async (accept: boolean) => {
    if (!player || !request) return;
    setMessage(null);
    const result = await useSocialStore.getState().respondRequest(request.id, accept);
    report(result, accept ? `You and ${player.nickname} are now friends.` : 'Request declined.');
  };

  return (
    <View className="gap-2" testID="player-friend-action">
      {action === 'friends' ? (
        <View className="flex-row items-center gap-2" testID="player-friend-state">
          <Pill tone="good">{FRIEND_ACTION_LABEL.friends}</Pill>
          {player ? <Text className="text-sm font-semibold text-stone-600">{player.playerId}</Text> : null}
        </View>
      ) : action === 'respond' ? (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-stone-600" testID="player-friend-state">
            {player?.nickname} sent you a friend request
          </Text>
          <View className="flex-row gap-3">
            <Button className="flex-1" size="sm" variant="success" title="Accept" testID="player-friend-accept" loading={busy} onPress={() => void respond(true)} />
            <Button className="flex-1" size="sm" variant="secondary" title="Decline" testID="player-friend-decline" disabled={busy} onPress={() => void respond(false)} />
          </View>
        </View>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          title={action === 'unavailable' ? 'Add Friend · Unavailable' : FRIEND_ACTION_LABEL[action]}
          testID="player-add-friend"
          disabled={action !== 'add'}
          loading={busy}
          accessibilityHint={action === 'unavailable' ? 'This player can’t be added from here' : undefined}
          onPress={() => void add()}
        />
      )}
      {message ? (
        <Text className={`text-center text-sm font-bold ${message.kind === 'error' ? 'text-brick' : 'text-green-700'}`} accessibilityRole="alert" testID="player-friend-message">
          {message.text}
        </Text>
      ) : null}
    </View>
  );
}
