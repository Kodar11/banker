import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Button, Card, ConfirmDialog, Label, Pill, Screen, Sheet } from '@/components/ui';
import { COLORS, playerInitial } from '@/constants/theme';
import { serverNow } from '@/lib/serverClock';
import { watchPresence } from '@/lib/socialRealtime';
import { useAccountStore } from '@/store/accountStore';
import { useSocialStore } from '@/store/socialStore';
import { goBack } from '@/utils/navigation';
import { haptics } from '@/utils/haptics';
import { AddFriendSheet } from './AddFriendSheet';
import {
  badgesOf,
  INVITE_REASONS,
  inviteStateAt,
  inviteTimeLeft,
  isExpired,
  MAX_PRESENCE_CHANNELS,
  MODE_LABEL,
  notificationText,
  PRESENCE_LABEL,
  presenceStatusOf,
  relationshipOf,
} from './logic';
import { useInvitableLobby, useServerNow, type InvitableLobby } from './lobby';
import type { Friend, FriendRequest, GameInvite, PresenceStatus, PublicPlayer, SocialState } from './types';

type Tab = 'friends' | 'requests' | 'invites';

/** While the screen is open: lobbies fill, lock and start without telling an invited player. */
const INVITES_RECHECK_MS = 20_000;

const PRESENCE_DOT: Record<PresenceStatus, string> = { online: 'bg-green-500', offline: 'bg-stone-400', unknown: 'bg-amber-400' };

type Outcome = { ok: true } | { ok: false; error: { message: string } };

/** Friends: my friends (with presence), friend requests in both directions, and game invitations. */
export function FriendsView() {
  const accountPhase = useAccountStore((s) => s.phase);
  const accountReady = useAccountStore((s) => s.phase === 'ready' && s.verified);
  const phase = useSocialStore((s) => s.phase);
  const data = useSocialStore((s) => s.data);
  const error = useSocialStore((s) => s.error);
  const refreshing = useSocialStore((s) => s.refreshing);
  const now = useServerNow(1000);
  const lobby = useInvitableLobby();

  const [tab, setTab] = useState<Tab>('friends');
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState<PublicPlayer | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Authoritative data when the screen opens.
  useEffect(() => {
    void useSocialStore.getState().refresh();
  }, []);

  // Leaving the screen is what makes its notifications "seen" — receiving them never does.
  useEffect(() => () => void useSocialStore.getState().markRead(), []);

  const hasInvites = (data?.invites.length ?? 0) > 0;
  useEffect(() => {
    if (!hasInvites) return;
    const timer = setInterval(() => void useSocialStore.getState().refresh(), INVITES_RECHECK_MS);
    return () => clearInterval(timer);
  }, [hasInvites]);

  // Presence: only while this screen is open, only for the friends on it, and never more than the cap.
  const presenceKeys = (data?.friends ?? []).slice(0, MAX_PRESENCE_CHANNELS).map((f) => f.presenceKey).join(',');
  useEffect(() => {
    if (!presenceKeys) return;
    const stop = watchPresence(presenceKeys.split(','), (event) => useSocialStore.getState().notePresence(event, serverNow()));
    return () => {
      stop();
      useSocialStore.getState().clearPresence();
    };
  }, [presenceKeys]);

  const report = (result: Outcome, success: string) => {
    if (result.ok) {
      haptics.success();
      setNotice({ kind: 'success', text: success });
    } else {
      haptics.error();
      setNotice({ kind: 'error', text: result.error.message });
    }
  };

  const badges = badgesOf(data, now);
  const unread = (data?.notifications ?? []).filter((n) => !n.read);

  return (
    <Screen testID="friends-screen">
      <View className="flex-row items-center justify-between">
        <Button size="sm" variant="ghost" title="‹ Back" testID="friends-back" onPress={() => goBack('/')} />
        <Button size="sm" title="+ Add Friend" testID="friends-add" disabled={!data} onPress={() => setAdding(true)} />
      </View>
      <Text className="text-4xl font-black text-cream">Friends</Text>

      {!data ? (
        <FirstLoad accountPhase={accountPhase} accountReady={accountReady} phase={phase} message={error?.message ?? null} />
      ) : (
        <>
          <View className="flex-row gap-2" accessibilityRole="tablist">
            <TabButton id="friends" label="My Friends" active={tab} onPress={setTab} />
            <TabButton id="requests" label="Requests" count={badges.requests} active={tab} onPress={setTab} />
            <TabButton id="invites" label="Game Invites" count={badges.invites} active={tab} onPress={setTab} />
          </View>
          <ScrollView
            className="flex-1"
            contentContainerClassName="gap-4 pb-8"
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void useSocialStore.getState().refresh()} tintColor={COLORS.cream} colors={[COLORS.saffron]} testID="friends-refresh" />}
            testID="friends-scroll"
          >
            {error ? (
              <View className="flex-row items-center justify-between gap-3 rounded-xl bg-amber-400/90 px-3 py-2" accessibilityRole="alert" testID="friends-stale">
                <Text className="flex-1 text-sm font-bold text-ink">Couldn’t refresh — this may be out of date.</Text>
                <Button size="sm" variant="secondary" title="Retry" testID="friends-stale-retry" onPress={() => void useSocialStore.getState().refresh()} />
              </View>
            ) : null}
            {notice ? (
              <Pressable onPress={() => setNotice(null)} accessibilityRole="alert" testID="friends-notice" className={`rounded-xl px-4 py-3 ${notice.kind === 'error' ? 'bg-brick' : 'bg-green-600'}`}>
                <Text className="text-center text-sm font-bold text-white">{notice.text}</Text>
              </Pressable>
            ) : null}
            {unread.length ? (
              <Card testID="friends-news" className="gap-2">
                <Label>New</Label>
                {unread.slice(0, 5).map((n) => (
                  <Text key={n.id} className="text-base font-semibold text-ink" testID="friends-news-item">
                    {notificationText(n)}
                  </Text>
                ))}
                {unread.length > 5 ? <Text className="text-sm text-stone-500">+{unread.length - 5} more</Text> : null}
              </Card>
            ) : null}

            {tab === 'friends' ? (
              <FriendsTab data={data} now={now} lobby={lobby} onOpen={setProfile} onAdd={() => setAdding(true)} report={report} />
            ) : tab === 'requests' ? (
              <RequestsTab data={data} now={now} onOpen={setProfile} report={report} />
            ) : (
              <InvitesTab data={data} now={now} report={report} />
            )}
          </ScrollView>
        </>
      )}

      <AddFriendSheet visible={adding} onClose={() => setAdding(false)} />
      {/* Keyed by player: a sheet never carries one player's messages over to the next. */}
      <PlayerProfileSheet key={profile?.playerId ?? 'none'} player={profile} lobby={lobby} onClose={() => setProfile(null)} />
    </Screen>
  );
}

function FirstLoad({ accountPhase, accountReady, phase, message }: { accountPhase: string; accountReady: boolean; phase: string; message: string | null }) {
  // No confirmed account: Friends has nobody to show friends of. The account screen owns that recovery.
  if (!accountReady && accountPhase !== 'idle' && accountPhase !== 'loading') {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-4" testID="friends-no-account">
        <Text className="text-center text-xl font-extrabold text-cream">{accountPhase === 'signedOut' ? 'You’re signed out' : 'Your profile isn’t available'}</Text>
        <Text className="text-center text-base text-cream/80">Friends need your player profile. {accountPhase === 'signedOut' ? 'Open Settings to restore it.' : 'Check your connection and try again.'}</Text>
        {accountPhase === 'signedOut' ? (
          <Button title="Open Settings" size="md" testID="friends-open-account" onPress={() => router.push('/account')} />
        ) : (
          <Button title="Try again" size="md" testID="friends-retry-account" onPress={() => void useAccountStore.getState().initialize()} />
        )}
      </View>
    );
  }
  if (phase === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-4" testID="friends-error">
        <Text className="text-center text-xl font-extrabold text-cream">Couldn’t load your friends</Text>
        <Text className="text-center text-base text-cream/80">{message ?? 'Please try again.'}</Text>
        <Button title="Try again" size="md" testID="friends-retry" onPress={() => void useSocialStore.getState().refresh()} />
      </View>
    );
  }
  return (
    <View className="flex-1 items-center justify-center gap-4" testID="friends-loading">
      <ActivityIndicator size="large" color={COLORS.saffron} />
      <Text className="text-lg font-semibold text-cream">Loading your friends…</Text>
    </View>
  );
}

function TabButton({ id, label, count = 0, active, onPress }: { id: Tab; label: string; count?: number; active: Tab; onPress: (tab: Tab) => void }) {
  const selected = active === id;
  return (
    <Pressable
      onPress={() => onPress(id)}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={count ? `${label}, ${count} waiting` : label}
      testID={`friends-tab-${id}`}
      className={`min-h-[44px] flex-1 flex-row items-center justify-center gap-1.5 rounded-xl px-2 py-2 active:opacity-80 ${selected ? 'bg-cream' : 'border border-white/30 bg-white/10'}`}
    >
      <Text className={`text-sm font-extrabold ${selected ? 'text-ink' : 'text-cream'}`} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {label}
      </Text>
      {count > 0 ? (
        <View className="h-5 min-w-[20px] items-center justify-center rounded-full bg-brick px-1" testID={`friends-tab-${id}-badge`}>
          <Text className="text-xs font-black text-white">{count > 9 ? '9+' : String(count)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <View className="h-10 w-10 items-center justify-center rounded-full bg-saffron" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text className="text-lg font-black text-ink">{playerInitial(name)}</Text>
    </View>
  );
}

function Identity({ player, onPress, testID, children }: { player: PublicPlayer; onPress?: () => void; testID?: string; children?: React.ReactNode }) {
  const body = (
    <>
      <Avatar name={player.nickname} />
      <View className="flex-1">
        <Text className="text-lg font-bold text-ink" numberOfLines={1}>
          {player.nickname}
        </Text>
        <Text className="text-xs font-semibold tracking-wider text-stone-500">{player.playerId}</Text>
        {children}
      </View>
    </>
  );
  if (!onPress) return <View className="flex-1 flex-row items-center gap-3">{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${player.nickname}, ${player.playerId}. Open profile`} testID={testID} className="min-h-[44px] flex-1 flex-row items-center gap-3 active:opacity-80">
      {body}
    </Pressable>
  );
}

interface TabProps {
  data: SocialState;
  now: number;
  report: (result: Outcome, success: string) => void;
}

function FriendsTab({ data, now, lobby, onOpen, onAdd, report }: TabProps & { lobby: InvitableLobby | null; onOpen: (p: PublicPlayer) => void; onAdd: () => void }) {
  const presence = useSocialStore((s) => s.presence);
  const pending = useSocialStore((s) => s.pending);
  if (data.friends.length === 0) {
    return (
      <Card testID="friends-empty" className="items-center gap-3">
        <Text className="text-5xl">🤝</Text>
        <Text className="text-center text-xl font-extrabold text-ink">No friends yet</Text>
        <Text className="text-center text-base text-stone-600">Add someone with their Player ID, or tap a player’s name in a lobby or a game.</Text>
        <Button title="Add a friend" size="md" testID="friends-empty-add" onPress={onAdd} />
        <BlockedList data={data} report={report} />
      </Card>
    );
  }
  const invited = new Set(lobby ? data.sentInvites.filter((i) => i.gameId === lobby.gameId && !isExpired(i.expiresAt, now)).map((i) => i.playerId) : []);
  const invite = async (friend: Friend) => {
    if (!lobby) return;
    report(await useSocialStore.getState().sendInvite(lobby.gameId, friend.playerId), `Invitation sent to ${friend.nickname}.`);
  };
  return (
    <Card testID="friends-list" className="gap-2">
      <Label>My friends ({data.friends.length})</Label>
      {data.friends.map((friend) => {
        const status = presenceStatusOf(presence[friend.presenceKey], now);
        return (
          <View key={friend.playerId} className="flex-row items-center gap-3 rounded-xl bg-white px-3 py-2.5" testID={`friend-row-${friend.playerId}`}>
            <Identity player={friend} onPress={() => onOpen(friend)} testID={`friend-open-${friend.playerId}`}>
              <View className="mt-0.5 flex-row items-center gap-1.5" testID={`friend-presence-${friend.playerId}`} accessibilityLabel={PRESENCE_LABEL[status]}>
                <View className={`h-2.5 w-2.5 rounded-full ${PRESENCE_DOT[status]}`} />
                <Text className="text-xs font-bold text-stone-600">{PRESENCE_LABEL[status]}</Text>
              </View>
            </Identity>
            {lobby ? (
              invited.has(friend.playerId) ? (
                <Pill tone="gold">Invited</Pill>
              ) : (
                <Button title="Invite" size="sm" testID={`friend-invite-${friend.playerId}`} loading={!!pending[`invite:${lobby.gameId}:${friend.playerId}`]} onPress={() => void invite(friend)} />
              )
            ) : null}
          </View>
        );
      })}
      <Text className="text-xs text-stone-500">
        {lobby ? 'Invite sends them an invitation to the lobby you’re in.' : 'Tap a friend for more. Create or join a game to invite them.'}
      </Text>
      <BlockedList data={data} report={report} />
    </Card>
  );
}

function BlockedList({ data, report }: Pick<TabProps, 'data' | 'report'>) {
  const pending = useSocialStore((s) => s.pending);
  if (data.blocked.length === 0) return null;
  return (
    <View className="mt-2 gap-2 self-stretch" testID="blocked-list">
      <Label>Blocked ({data.blocked.length})</Label>
      {data.blocked.map((player) => (
        <View key={player.playerId} className="flex-row items-center gap-3 rounded-xl bg-white px-3 py-2">
          <Identity player={player} />
          <Button
            title="Unblock"
            size="sm"
            variant="secondary"
            testID={`unblock-${player.playerId}`}
            loading={!!pending[`friend:${player.playerId}`]}
            onPress={async () => report(await useSocialStore.getState().unblock(player.playerId), `${player.nickname} is unblocked.`)}
          />
        </View>
      ))}
    </View>
  );
}

function RequestsTab({ data, now, onOpen, report }: TabProps & { onOpen: (p: PublicPlayer) => void }) {
  const pending = useSocialStore((s) => s.pending);
  const social = useSocialStore.getState;
  const incoming = data.incoming.filter((r) => !isExpired(r.expiresAt, now));
  const respond = async (request: FriendRequest, accept: boolean) =>
    report(await social().respondRequest(request.id, accept), accept ? `You and ${request.nickname} are now friends.` : 'Request declined.');
  const resend = async (request: FriendRequest) => {
    const result = await social().sendRequest(request.playerId);
    report(result, result.ok && result.value.relationship === 'friends' ? `You and ${request.nickname} are now friends.` : `Friend request sent to ${request.nickname}.`);
  };
  return (
    <>
      <Card testID="requests-incoming" className="gap-2">
        <Label>Received ({incoming.length})</Label>
        {incoming.length === 0 ? (
          <Text className="text-base text-stone-500" testID="requests-incoming-empty">
            No friend requests waiting.
          </Text>
        ) : (
          incoming.map((request) => {
            const busy = !!pending[`respond:${request.id}`];
            return (
              <View key={request.id} className="gap-2 rounded-xl bg-white px-3 py-2.5" testID={`request-in-${request.playerId}`}>
                <Identity player={request} onPress={() => onOpen(request)} testID={`request-open-${request.playerId}`} />
                <View className="flex-row gap-3">
                  <Button className="flex-1" title="Accept" size="sm" variant="success" testID={`request-accept-${request.playerId}`} loading={busy} onPress={() => void respond(request, true)} />
                  <Button className="flex-1" title="Decline" size="sm" variant="secondary" testID={`request-decline-${request.playerId}`} disabled={busy} onPress={() => void respond(request, false)} />
                </View>
              </View>
            );
          })
        )}
      </Card>
      <Card testID="requests-outgoing" className="gap-2">
        <Label>Sent ({data.outgoing.length})</Label>
        {data.outgoing.length === 0 ? (
          <Text className="text-base text-stone-500" testID="requests-outgoing-empty">
            You have no requests waiting for an answer.
          </Text>
        ) : (
          data.outgoing.map((request) => {
            const expired = isExpired(request.expiresAt, now);
            return (
              <View key={request.id} className="flex-row items-center gap-3 rounded-xl bg-white px-3 py-2.5" testID={`request-out-${request.playerId}`}>
                <Identity player={request}>
                  <View className="mt-1">{expired ? <Pill>Expired</Pill> : <Pill tone="warn">Pending</Pill>}</View>
                </Identity>
                {expired ? (
                  <Button title="Resend" size="sm" testID={`request-resend-${request.playerId}`} loading={!!pending[`request:${request.playerId}`]} onPress={() => void resend(request)} />
                ) : (
                  <Button
                    title="Cancel"
                    size="sm"
                    variant="secondary"
                    testID={`request-cancel-${request.playerId}`}
                    loading={!!pending[`respond:${request.id}`]}
                    onPress={async () => report(await social().cancelRequest(request.id), 'Request cancelled.')}
                  />
                )}
              </View>
            );
          })
        )}
        <Text className="text-xs text-stone-500">A request waits 30 days for an answer.</Text>
      </Card>
    </>
  );
}

function InvitesTab({ data, now, report }: TabProps) {
  const pending = useSocialStore((s) => s.pending);
  const social = useSocialStore.getState;
  const open = data.invites.filter((i) => inviteStateAt(i, now) === 'open');
  const gone = data.invites.filter((i) => inviteStateAt(i, now) !== 'open');

  const join = async (invite: GameInvite) => {
    // Asked again, now: the list on screen may be seconds old, and the lobby may have moved on.
    const result = await social().openInvite(invite.id);
    if (!result.ok) {
      report(result, '');
      return;
    }
    router.push(`/join-game?code=${result.value.code}`);
  };

  return (
    <>
      <Card testID="invites-open" className="gap-2">
        <Label>Invitations ({open.length})</Label>
        {open.length === 0 ? (
          <Text className="text-base text-stone-500" testID="invites-empty">
            No game invitations right now. When a friend invites you to their lobby, it appears here for 15 minutes.
          </Text>
        ) : (
          open.map((invite) => {
            const busy = !!pending[`invitation:${invite.id}`];
            return (
              <View key={invite.id} className="gap-2 rounded-xl bg-white px-3 py-2.5" testID={`invite-${invite.id}`}>
                <Identity player={invite.inviter}>
                  <Text className="mt-0.5 text-sm font-semibold text-stone-700" testID={`invite-detail-${invite.id}`}>
                    {MODE_LABEL[invite.mode]} game · Lobby open · {invite.players}/{invite.capacity} players
                  </Text>
                  <Text className="text-xs text-stone-500" testID={`invite-expiry-${invite.id}`}>
                    Expires in {inviteTimeLeft(invite.expiresAt, now) ?? '0:00'}
                  </Text>
                </Identity>
                <View className="flex-row gap-3">
                  <Button className="flex-1" title="Join Game" size="sm" variant="success" testID={`invite-join-${invite.id}`} loading={busy} onPress={() => void join(invite)} />
                  <Button
                    className="flex-1"
                    title="Decline"
                    size="sm"
                    variant="secondary"
                    testID={`invite-decline-${invite.id}`}
                    disabled={busy}
                    onPress={async () => report(await social().declineInvite(invite.id), 'Invitation declined.')}
                  />
                </View>
              </View>
            );
          })
        )}
      </Card>
      {gone.length ? (
        <Card testID="invites-gone" className="gap-2">
          <Label>No longer available</Label>
          {gone.map((invite) => {
            const state = inviteStateAt(invite, now);
            return (
              <View key={invite.id} className="flex-row items-center gap-3 rounded-xl bg-stone-100 px-3 py-2.5" testID={`invite-gone-${invite.id}`}>
                <View className="flex-1">
                  <Text className="text-base font-bold text-stone-700" numberOfLines={1}>
                    {invite.inviter.nickname} · {MODE_LABEL[invite.mode]} game
                  </Text>
                  <Text className="text-sm font-semibold text-stone-600" testID={`invite-reason-${invite.id}`}>
                    {state === 'open' ? '' : INVITE_REASONS[state]}
                  </Text>
                </View>
                <Button
                  title="Dismiss"
                  size="sm"
                  variant="secondary"
                  testID={`invite-dismiss-${invite.id}`}
                  loading={!!pending[`invitation:${invite.id}`]}
                  onPress={async () => {
                    const result = await social().declineInvite(invite.id);
                    if (!result.ok) report(result, '');
                  }}
                />
              </View>
            );
          })}
        </Card>
      ) : null}
    </>
  );
}

/**
 * One player's public profile and what I can do with them. Opened from a friend or a request.
 * The actions always follow the server's latest state for that player.
 */
function PlayerProfileSheet({ player, lobby, onClose }: { player: PublicPlayer | null; lobby: InvitableLobby | null; onClose: () => void }) {
  const data = useSocialStore((s) => s.data);
  const presence = useSocialStore((s) => s.presence);
  const pending = useSocialStore((s) => s.pending);
  const now = useServerNow(5000);
  const [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!player) return null;
  const social = useSocialStore.getState();
  const relationship = relationshipOf(data, player.playerId, now);
  const friend = data?.friends.find((f) => f.playerId === player.playerId);
  // The nickname may have changed since the row was tapped.
  const current: PublicPlayer = friend ?? data?.incoming.find((r) => r.playerId === player.playerId) ?? player;
  const request = data?.incoming.find((r) => r.playerId === player.playerId && !isExpired(r.expiresAt, now));
  const sent = data?.outgoing.find((r) => r.playerId === player.playerId && !isExpired(r.expiresAt, now));
  const busy = !!pending[`friend:${player.playerId}`] || !!pending[`request:${player.playerId}`] || (!!request && !!pending[`respond:${request.id}`]) || (!!sent && !!pending[`respond:${sent.id}`]);
  const status = friend ? presenceStatusOf(presence[friend.presenceKey], now) : null;
  const invited = !!lobby && !!data?.sentInvites.some((i) => i.gameId === lobby.gameId && i.playerId === player.playerId && !isExpired(i.expiresAt, now));

  const run = async (call: Promise<Outcome>, success: string) => {
    setMessage(null);
    const result = await call;
    if (result.ok) haptics.success();
    else haptics.error();
    setMessage(result.ok ? { kind: 'success', text: success } : { kind: 'error', text: result.error.message });
  };

  const confirmed = async () => {
    const action = confirm;
    if (!action) return;
    setFailure(null);
    const result = action === 'remove' ? await social.removeFriend(player.playerId) : await social.block(player.playerId);
    if (!result.ok) {
      setFailure(result.error.message);
      return;
    }
    haptics.success();
    setConfirm(null);
    if (action === 'remove') onClose();
    else setMessage({ kind: 'success', text: `${current.nickname} is blocked.` });
  };

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(player.playerId);
      setCopied(true);
      haptics.tap();
    } catch {
      setCopied(false);
    }
  };

  return (
    <Sheet visible title="Player" onClose={onClose} testID="player-profile-sheet">
      <View className="flex-row items-center gap-3">
        <Avatar name={current.nickname} />
        <View className="flex-1">
          <Text className="text-2xl font-black text-ink" numberOfLines={1} testID="profile-nickname">
            {current.nickname}
          </Text>
          <Text className="text-sm font-bold tracking-widest text-stone-500" selectable testID="profile-player-id">
            {player.playerId}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        {relationship === 'friends' ? <Pill tone="good">Friends</Pill> : relationship === 'blocked' ? <Pill tone="bad">Blocked</Pill> : relationship === 'outgoing' ? <Pill tone="warn">Request sent</Pill> : relationship === 'incoming' ? <Pill tone="gold">Wants to be friends</Pill> : null}
        {status ? (
          <View className="flex-row items-center gap-1.5" testID="profile-presence">
            <View className={`h-2.5 w-2.5 rounded-full ${PRESENCE_DOT[status]}`} />
            <Text className="text-sm font-bold text-stone-600">{PRESENCE_LABEL[status]}</Text>
          </View>
        ) : null}
      </View>
      <Button size="sm" variant="secondary" className="self-start" title={copied ? '✓ Copied' : 'Copy Player ID'} testID="profile-copy-id" onPress={() => void copy()} />

      {message ? (
        <Text className={`text-center text-sm font-bold ${message.kind === 'error' ? 'text-brick' : 'text-green-700'}`} accessibilityRole="alert" testID="profile-message">
          {message.text}
        </Text>
      ) : null}

      <View className="gap-3">
        {relationship === 'friends' ? (
          <>
            {lobby ? (
              <Button
                title={invited ? 'Invited to your game' : 'Invite to Game'}
                size="md"
                testID="profile-invite"
                disabled={invited}
                loading={!!pending[`invite:${lobby.gameId}:${player.playerId}`]}
                onPress={() => void run(social.sendInvite(lobby.gameId, player.playerId), `Invitation sent to ${current.nickname}.`)}
              />
            ) : (
              <Text className="text-sm text-stone-500" testID="profile-no-lobby">
                Create or join a game, then invite {current.nickname} from the lobby.
              </Text>
            )}
            <Button title="Remove Friend" size="md" variant="outline" testID="profile-remove" disabled={busy} onPress={() => setConfirm('remove')} />
          </>
        ) : relationship === 'incoming' && request ? (
          <View className="flex-row gap-3">
            <Button className="flex-1" title="Accept" size="md" variant="success" testID="profile-accept" loading={busy} onPress={() => void run(social.respondRequest(request.id, true), `You and ${current.nickname} are now friends.`)} />
            <Button className="flex-1" title="Decline" size="md" variant="secondary" testID="profile-decline" disabled={busy} onPress={() => void run(social.respondRequest(request.id, false), 'Request declined.')} />
          </View>
        ) : relationship === 'outgoing' && sent ? (
          <Button title="Cancel request" size="md" variant="secondary" testID="profile-cancel" loading={busy} onPress={() => void run(social.cancelRequest(sent.id), 'Request cancelled.')} />
        ) : relationship === 'blocked' ? (
          <Button title="Unblock" size="md" variant="secondary" testID="profile-unblock" loading={busy} onPress={() => void run(social.unblock(player.playerId), `${current.nickname} is unblocked.`)} />
        ) : relationship === 'none' ? (
          <Button title="Add Friend" size="md" testID="profile-add" loading={busy} onPress={() => void run(social.sendRequest(player.playerId), `Friend request sent to ${current.nickname}.`)} />
        ) : null}
        {relationship !== 'blocked' && relationship !== 'self' ? <Button title="Block" size="sm" variant="outline" className="self-start" testID="profile-block" disabled={busy} onPress={() => setConfirm('block')} /> : null}
      </View>

      <ConfirmDialog
        visible={confirm !== null}
        testID="profile-confirm"
        title={confirm === 'block' ? `Block ${current.nickname}?` : `Remove ${current.nickname}?`}
        message={
          confirm === 'block'
            ? 'You won’t be friends any more, and neither of you can send the other friend requests or game invitations. They are not told.'
            : 'You’ll stop being friends. Your game history is not affected, and you can add each other again later.'
        }
        detail={confirm === 'block' ? 'A game you are both already in is not affected.' : undefined}
        confirmTitle={confirm === 'block' ? 'Block' : 'Remove'}
        intent={confirm === 'block' ? 'destructive' : 'warning'}
        loading={busy}
        error={failure}
        onConfirm={() => void confirmed()}
        onCancel={() => setConfirm(null)}
      />
    </Sheet>
  );
}
