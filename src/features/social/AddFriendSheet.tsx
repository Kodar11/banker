import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Pill, Sheet, TextField } from '@/components/ui';
import { serverNow } from '@/lib/serverClock';
import { useSocialStore } from '@/store/socialStore';
import { haptics } from '@/utils/haptics';
import { checkPlayerId, liveRequests, PLAYER_ID_MESSAGES, relationshipOf } from './logic';
import type { PublicPlayer, Relationship } from './types';

/**
 * Add a friend by Player ID: look the ID up on the server, show who it is, then send the request.
 * What the found player's card offers always follows the latest server state, so it can never
 * show "Send request" for someone who has meanwhile asked first or become a friend.
 */
export function AddFriendSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const data = useSocialStore((s) => s.data);
  const pending = useSocialStore((s) => s.pending);
  const [input, setInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<{ player: PublicPlayer; relationship: Relationship } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = () => {
    setInput('');
    setFound(null);
    setError(null);
    setNotice(null);
    onClose();
  };

  const find = async () => {
    if (searching) return;
    setFound(null);
    setNotice(null);
    const check = checkPlayerId(input);
    if (!check.ok) {
      setError(PLAYER_ID_MESSAGES[check.problem]);
      return;
    }
    setError(null);
    setInput(check.playerId);
    setSearching(true);
    const res = await useSocialStore.getState().lookup(check.playerId);
    setSearching(false);
    if (!res.ok) {
      haptics.error();
      setError(res.error.message);
      return;
    }
    setFound(res.value);
  };

  const now = serverNow();
  // The lookup's answer, overtaken by anything the store has learned since.
  const live = found ? relationshipOf(data, found.player.playerId, now) : 'none';
  const relationship: Relationship = !found ? 'none' : live !== 'none' ? live : found.relationship === 'self' ? 'self' : data ? 'none' : found.relationship;
  const request = found ? liveRequests(data?.incoming ?? [], now).find((r) => r.playerId === found.player.playerId) : undefined;
  const busy = !!found && (!!pending[`request:${found.player.playerId}`] || !!pending[`friend:${found.player.playerId}`] || (!!request && !!pending[`respond:${request.id}`]));

  const finish = (result: { ok: true } | { ok: false; error: { message: string } }, success: string) => {
    if (result.ok) {
      haptics.success();
      setNotice(success);
      setError(null);
    } else {
      haptics.error();
      setError(result.error.message);
    }
  };

  const send = async () => {
    if (!found) return;
    setNotice(null);
    const result = await useSocialStore.getState().sendRequest(found.player.playerId);
    finish(result, result.ok && result.value.relationship === 'friends' ? `You and ${found.player.nickname} are now friends.` : `Friend request sent to ${found.player.nickname}.`);
  };

  const accept = async () => {
    if (!found || !request) return;
    setNotice(null);
    finish(await useSocialStore.getState().respondRequest(request.id, true), `You and ${found.player.nickname} are now friends.`);
  };

  const unblock = async () => {
    if (!found) return;
    setNotice(null);
    finish(await useSocialStore.getState().unblock(found.player.playerId), `${found.player.nickname} is unblocked.`);
  };

  return (
    <Sheet visible={visible} title="Add a friend" onClose={close} testID="add-friend-sheet">
      <View className="rounded-2xl bg-felt p-4">
        <TextField
          label="Their Player ID"
          value={input}
          onChangeText={(text) => {
            setInput(text);
            setError(null);
          }}
          placeholder="RR-7K4P9X"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          returnKeyType="search"
          onSubmitEditing={() => void find()}
          error={error}
          testID="add-friend-input"
        />
      </View>
      <Button title="Find player" size="md" testID="add-friend-find" loading={searching} onPress={() => void find()} />

      {found ? (
        <View className="gap-3 rounded-2xl border border-stone-300 bg-white p-4" testID="add-friend-result">
          <View>
            <Text className="text-xl font-black text-ink" numberOfLines={1}>
              {found.player.nickname}
            </Text>
            <Text className="text-sm font-bold tracking-widest text-stone-500">{found.player.playerId}</Text>
          </View>
          {relationship === 'self' ? (
            <Text className="text-base font-semibold text-stone-600" testID="add-friend-state">
              That’s your own Player ID.
            </Text>
          ) : relationship === 'friends' ? (
            <View testID="add-friend-state">
              <Pill tone="good">Friends</Pill>
            </View>
          ) : relationship === 'outgoing' ? (
            <Button title="Request Sent" size="md" variant="secondary" disabled testID="add-friend-state" onPress={() => undefined} />
          ) : relationship === 'incoming' ? (
            <Button title="Accept their request" size="md" variant="success" testID="add-friend-accept" loading={busy} onPress={() => void accept()} />
          ) : relationship === 'blocked' ? (
            <Button title="Unblock" size="md" variant="secondary" testID="add-friend-unblock" loading={busy} onPress={() => void unblock()} />
          ) : (
            <Button title="Send friend request" size="md" testID="add-friend-send" loading={busy} onPress={() => void send()} />
          )}
        </View>
      ) : null}
      {notice ? (
        <Text className="text-center text-sm font-bold text-green-700" accessibilityRole="alert" testID="add-friend-notice">
          {notice}
        </Text>
      ) : null}
      {data ? (
        <Text className="text-center text-xs text-stone-500" testID="add-friend-own-id">
          Your Player ID is {data.me.playerId}. Share it so friends can add you.
        </Text>
      ) : null}
    </Sheet>
  );
}
