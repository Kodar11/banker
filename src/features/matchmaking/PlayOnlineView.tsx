import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Label, Pill, Screen, Sheet } from '@/components/ui';
import { COLORS } from '@/constants/theme';
import { GAME_MODE_LABELS, type GameMode } from '@/engine/index.ts';
import { useServerNow } from '@/features/social/lobby';
import { useAccountStore } from '@/store/accountStore';
import { useGameStore } from '@/store/gameStore';
import { useMatchmakingStore } from '@/store/matchmakingStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSocialStore } from '@/store/socialStore';
import { haptics } from '@/utils/haptics';
import { activeGameRoute, goBack } from '@/utils/navigation';
import { formatClock, phaseOf, resultMessage, searchHint, secondsLeft, secondsSince, startBlocker, ticketSummary, unreadyMembers } from './logic';
import type { Match, MatchmakingError, MatchmakingResult, MatchmakingState, Party } from './types';

const MODES: { mode: GameMode; title: string; detail: string }[] = [
  { mode: 'classic', title: GAME_MODE_LABELS.classic, detail: 'The original rules.' },
  { mode: 'intermediate', title: GAME_MODE_LABELS.intermediate, detail: 'Financial years, loans, credit scores and insurance.' },
];

/** Radio pair for the two rulesets. Read-only when `onChange` is absent (a party member sees the leader's choice). */
function ModePicker({ value, onChange, busy }: { value: GameMode; onChange?: (mode: GameMode) => void; busy?: boolean }) {
  return (
    <View className="gap-2" accessibilityRole="radiogroup" testID="online-mode-options">
      {MODES.map((m) => {
        const selected = m.mode === value;
        return (
          <Pressable
            key={m.mode}
            onPress={() => onChange?.(m.mode)}
            disabled={!onChange || busy}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: !onChange || busy }}
            accessibilityLabel={`${m.title} mode. ${m.detail}`}
            testID={`online-mode-${m.mode}`}
            className={`rounded-3xl border-2 bg-cream p-4 ${selected ? 'border-saffron' : 'border-transparent opacity-70'}`}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-xl font-black text-ink">{m.title}</Text>
              {selected ? <Pill tone="gold">Selected</Pill> : null}
            </View>
            <Text className="mt-0.5 text-sm text-stone-600">{m.detail}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Alert({ children, tone = 'warn', testID }: { children: ReactNode; tone?: 'warn' | 'bad' | 'info'; testID?: string }) {
  const box = tone === 'bad' ? 'bg-red-100' : tone === 'info' ? 'bg-white/15' : 'bg-amber-100';
  const text = tone === 'bad' ? 'text-red-900' : tone === 'info' ? 'text-cream' : 'text-amber-900';
  return (
    <Text className={`rounded-xl px-3 py-2 text-center text-sm font-bold ${box} ${text}`} accessibilityRole="alert" testID={testID}>
      {children}
    </Text>
  );
}

function Header({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack?: () => void }) {
  return (
    <>
      {onBack ? <Button size="sm" variant="ghost" title="‹ Home" className="self-start" testID="online-back" onPress={onBack} /> : null}
      <Text className="text-4xl font-black text-cream">{title}</Text>
      {subtitle ? <Text className="-mt-2 text-base font-semibold text-cream/80">{subtitle}</Text> : null}
    </>
  );
}

function PartyMembers({ party, onKick, pending }: { party: Party; onKick?: (playerId: string) => void; pending: Record<string, true> }) {
  return (
    <Card testID="party-members">
      <Label>
        Party · {party.members.length} {party.members.length === 1 ? 'player' : 'players'}
      </Label>
      <View className="mt-2 gap-2">
        {party.members.map((m) => (
          <View key={m.playerId} className="flex-row items-center justify-between gap-3 rounded-xl bg-white px-4 py-3" testID={`party-member-${m.playerId}`}>
            <View className="flex-1">
              <Text className="text-base font-bold text-ink" numberOfLines={1}>
                {m.nickname}
                {m.isMe ? ' (you)' : ''}
              </Text>
              <Text className="text-xs font-semibold tracking-wider text-stone-500">
                {m.playerId}
                {m.online || m.isMe ? '' : ' · not connected'}
              </Text>
            </View>
            {m.isLeader ? <Pill tone="gold">Leader</Pill> : m.ready ? <Pill tone="good">Ready</Pill> : <Pill>Not ready</Pill>}
            {onKick && !m.isMe ? (
              <Button title="Remove" size="sm" variant="secondary" testID={`party-kick-${m.playerId}`} loading={!!pending[`member:${m.playerId}`]} onPress={() => onKick(m.playerId)} />
            ) : null}
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Players of a found match, grouped the way they queued, with who has confirmed. */
function MatchPlayers({ match }: { match: Match }) {
  const groups = new Map<number, Match['players']>();
  for (const p of match.players) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  return (
    <Card testID="match-players">
      <Label>
        {GAME_MODE_LABELS[match.mode]} · {match.playerCount} players
      </Label>
      <View className="mt-2 gap-3">
        {[...groups.entries()].map(([group, members]) => (
          <View key={group} className={members.length > 1 ? 'gap-2 rounded-2xl border-2 border-saffron/60 p-2' : 'gap-2'} testID={`match-group-${group}`}>
            {members.length > 1 ? <Text className="px-1 text-xs font-extrabold uppercase tracking-wider text-saffron-dark">Party of {members.length}</Text> : null}
            {members.map((p) => (
              <View key={p.playerId} className="flex-row items-center justify-between gap-3 rounded-xl bg-white px-4 py-3" testID={`match-player-${p.playerId}`}>
                <View className="flex-1">
                  <Text className="text-base font-bold text-ink" numberOfLines={1}>
                    {p.nickname}
                    {p.isMe ? ' (you)' : ''}
                  </Text>
                  <Text className="text-xs font-semibold tracking-wider text-stone-500">{p.playerId}</Text>
                </View>
                {p.ready ? <Pill tone="good">Ready</Pill> : <Pill tone="warn">Waiting</Pill>}
              </View>
            ))}
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Pick friends to bring into the party. A friend shows as "Invited" only once the server has confirmed it. */
function InviteToPartySheet({ visible, onClose, party, full }: { visible: boolean; onClose: () => void; party: Party; full: boolean }) {
  const social = useSocialStore((s) => s.data);
  const socialPhase = useSocialStore((s) => s.phase);
  const pending = useMatchmakingStore((s) => s.pending);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const members = new Set(party.members.map((m) => m.playerId));
  const invited = new Map(party.invites.map((i) => [i.playerId, i.id]));

  const invite = async (playerId: string) => {
    setErrors(({ [playerId]: _old, ...rest }) => rest);
    const result = await useMatchmakingStore.getState().invite(playerId);
    if (result.ok) haptics.success();
    else setErrors((e) => ({ ...e, [playerId]: result.error.message }));
  };
  const revoke = async (playerId: string, inviteId: string) => {
    const result = await useMatchmakingStore.getState().revokeInvite(inviteId);
    if (!result.ok) setErrors((e) => ({ ...e, [playerId]: result.error.message }));
  };

  return (
    <Sheet visible={visible} title="Invite to party" onClose={onClose} testID="party-invite-sheet">
      {full ? (
        <Alert testID="party-invite-full">The party is full. Nobody else can be invited.</Alert>
      ) : null}
      {!social ? (
        <Text className="py-4 text-center text-base text-stone-600" testID="party-invite-unavailable">
          {socialPhase === 'error' ? 'Your friends list couldn’t be loaded. Check your connection.' : 'Loading your friends…'}
        </Text>
      ) : social.friends.length === 0 ? (
        <View className="items-center gap-3 py-4" testID="party-invite-empty">
          <Text className="text-center text-base text-stone-600">You can invite friends to your party. You have no friends here yet.</Text>
          <Button
            title="Add a friend"
            size="sm"
            variant="secondary"
            testID="party-invite-open-friends"
            onPress={() => {
              onClose();
              router.push('/friends');
            }}
          />
        </View>
      ) : (
        <View className="gap-2">
          {social.friends.map((friend) => {
            const inviteId = invited.get(friend.playerId);
            const busy = !!pending[`invite:${friend.playerId}`] || (!!inviteId && !!pending[`invitation:${inviteId}`]);
            return (
              <View key={friend.playerId} className="gap-1 rounded-xl bg-white px-4 py-3" testID={`party-invite-row-${friend.playerId}`}>
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-base font-bold text-ink" numberOfLines={1}>
                      {friend.nickname}
                    </Text>
                    <Text className="text-xs font-semibold tracking-wider text-stone-500">{friend.playerId}</Text>
                  </View>
                  {members.has(friend.playerId) ? (
                    <Pill tone="good">In party</Pill>
                  ) : inviteId ? (
                    <View className="flex-row items-center gap-2">
                      <Pill tone="gold">Invited</Pill>
                      <Button title="Cancel" size="sm" variant="secondary" testID={`party-invite-revoke-${friend.playerId}`} loading={busy} onPress={() => void revoke(friend.playerId, inviteId)} />
                    </View>
                  ) : (
                    <Button title="Invite" size="sm" testID={`party-invite-send-${friend.playerId}`} disabled={full} loading={busy} onPress={() => void invite(friend.playerId)} />
                  )}
                </View>
                {errors[friend.playerId] ? (
                  <Text className="text-sm font-bold text-brick" accessibilityRole="alert" testID={`party-invite-error-${friend.playerId}`}>
                    {errors[friend.playerId]}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Text className="text-center text-xs text-stone-500">A party invitation lasts 15 minutes. It only adds them to your party — nobody is queued until everyone is ready and you start.</Text>
        </View>
      )}
    </Sheet>
  );
}

/**
 * Play Online: one screen for the whole of random matchmaking. Which part is shown is decided by
 * the server's answer alone (`phaseOf`), so it is right after a restart, a missed event, or events
 * arriving in any order — and "match found" is never shown before the server has reserved one.
 */
export function PlayOnlineView() {
  const accountPhase = useAccountStore((s) => s.phase);
  const owner = useMatchmakingStore((s) => s.ownerUserId);
  const loadPhase = useMatchmakingStore((s) => s.phase);
  const data = useMatchmakingStore((s) => s.data);
  const loadError = useMatchmakingStore((s) => s.error);
  const pending = useMatchmakingStore((s) => s.pending);
  const reconnecting = useMatchmakingStore((s) => s.reconnecting);
  const seatElsewhere = useMatchmakingStore((s) => s.seatElsewhere);
  const session = useSessionStore((s) => s.session);
  const deviceGame = useGameStore((s) => {
    const state = session && s.snapshot?.state.id === session.gameId ? s.snapshot.state : null;
    if (!state || state.status === 'FINISHED') return null;
    return state.players.find((p) => p.id === session!.playerId)?.status === 'LEFT' ? null : state.status;
  });
  const now = useServerNow(500);
  const [mode, setMode] = useState<GameMode>('classic');
  const [failure, setFailure] = useState<MatchmakingError | null>(null);
  const [inviting, setInviting] = useState(false);

  /** Runs one request and shows what the server refused. The screen itself changes only through the store. */
  const run = async <T,>(call: () => Promise<MatchmakingResult<T>>): Promise<MatchmakingResult<T>> => {
    setFailure(null);
    haptics.tap();
    const result = await call();
    if (!result.ok && result.error.code !== 'BUSY') {
      haptics.error();
      setFailure(result.error);
    }
    return result;
  };
  const store = useMatchmakingStore.getState;
  const home = () => goBack('/');

  // ---- nothing from the server yet ----------------------------------------------------------
  if (!data) {
    const signedOut = !owner && accountPhase !== 'idle' && accountPhase !== 'loading';
    return (
      <Screen testID="play-online-screen">
        <Header title="Play Online" onBack={home} />
        <View className="flex-1 items-center justify-center gap-4" testID={loadPhase === 'error' ? 'online-load-error' : 'online-loading'}>
          {loadPhase === 'error' ? (
            <>
              <Text className="text-center text-2xl font-extrabold text-cream">Queue state could not be refreshed</Text>
              <Text className="text-center text-base text-cream/80">{loadError?.message ?? 'Please try again.'}</Text>
              <Button title="Try again" testID="online-retry" onPress={() => void store().refresh()} />
            </>
          ) : signedOut ? (
            <>
              <Text className="text-center text-2xl font-extrabold text-cream">Your profile isn’t ready</Text>
              <Text className="text-center text-base text-cream/80">Playing online needs your player profile. Check your connection, or open Settings to sign in again.</Text>
              <Button title="Open Settings" variant="secondary" testID="online-open-account" onPress={() => router.push('/account')} />
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color={COLORS.saffron} />
              <Text className="text-lg font-semibold text-cream">Checking your online status…</Text>
            </>
          )}
        </View>
      </Screen>
    );
  }

  const phase = phaseOf(data);
  const stale = loadError ? <Alert testID="online-stale">{loadError.code === 'NETWORK' ? 'No connection — this may be out of date. Reconnecting…' : 'Queue state could not be refreshed. Retrying…'}</Alert> : null;
  const failed = failure ? (
    <Alert tone="bad" testID="online-error">
      {failure.code === 'NETWORK' ? 'No connection — we couldn’t tell whether that went through. Checking…' : failure.message}
    </Alert>
  ) : null;

  // ---- the game exists / everyone confirmed -------------------------------------------------
  if (phase === 'starting') {
    const game = data.game;
    const route = game && session?.gameId === game.gameId ? activeGameRoute(game.gameId, 'ACTIVE') : null;
    return (
      <Screen testID="play-online-screen" footer={route ? <Button title="OPEN GAME" testID="online-open-game" variant="success" onPress={() => router.replace(route)} /> : undefined}>
        <Header title={game ? 'Game started' : 'Starting…'} />
        {stale}
        <View className="flex-1 items-center justify-center gap-4" testID="online-starting">
          {seatElsewhere ? (
            <>
              <Text className="text-center text-2xl font-extrabold text-cream">Playing on another device</Text>
              <Text className="text-center text-base text-cream/80" testID="online-seat-elsewhere">
                You confirmed this match on another device, so your seat is there. Continue the game on that device.
              </Text>
              <Button title="Home" variant="secondary" onPress={home} />
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color={COLORS.saffron} />
              <Text className="text-center text-2xl font-extrabold text-cream">{game ? 'Taking you to your table…' : 'Everyone is ready'}</Text>
              <Text className="text-center text-base text-cream/80">{game ? 'Your seat is being opened.' : 'The server is setting up the game. This takes a moment.'}</Text>
            </>
          )}
        </View>
        {data.match && !game ? <MatchPlayers match={data.match} /> : null}
      </Screen>
    );
  }

  // ---- match found: confirm before the server's deadline ------------------------------------
  if (phase === 'matchFound' && data.match) {
    const match = data.match;
    const me = match.players.find((p) => p.isMe);
    const left = secondsLeft(match.readyDeadline, now);
    const waitingFor = match.players.filter((p) => !p.ready).length;
    return (
      <Screen
        scroll
        testID="play-online-screen"
        footer={
          <>
            {me?.ready ? (
              <Button title="YOU’RE READY" subtitle={waitingFor ? `Waiting for ${waitingFor} more` : 'Starting…'} testID="match-ready" variant="success" disabled onPress={() => undefined} />
            ) : (
              <Button title="I’M READY" subtitle={left > 0 ? `${left} s left` : 'Time is up'} testID="match-ready" variant="success" loading={!!pending.ready} disabled={left <= 0} onPress={() => void run(() => store().confirmReady(match.id))} />
            )}
            <Button title="Decline" size="sm" variant="ghost" testID="match-decline" loading={!!pending.decline} disabled={left <= 0} onPress={() => void run(() => store().decline(match.id))} />
          </>
        }
      >
        <Header title="Match found!" subtitle={`${GAME_MODE_LABELS[match.mode]} mode`} />
        {stale}
        {reconnecting ? <Alert testID="online-reconnecting">Reconnecting…</Alert> : null}
        {failed}
        <View className="items-center gap-1 py-2" accessibilityLiveRegion="polite" accessibilityLabel={`${left} seconds left to confirm`}>
          <Text className="text-7xl font-black text-saffron" testID="match-countdown">
            {left}
          </Text>
          <Text className="text-sm font-bold uppercase tracking-widest text-cream/70">{left > 0 ? 'seconds to confirm' : 'checking who confirmed…'}</Text>
        </View>
        <MatchPlayers match={match} />
        <Text className="text-center text-xs text-cream/60">The game starts when every player has confirmed. Declining, or not confirming in time, pauses your matchmaking for a moment.</Text>
      </Screen>
    );
  }

  // ---- searching -----------------------------------------------------------------------------
  if (phase === 'searching' && data.ticket) {
    const ticket = data.ticket;
    const waited = secondsSince(ticket.queuedAt, now);
    const mayCancel = ticket.kind === 'solo' || !data.party || data.party.isLeader;
    return (
      <Screen
        scroll
        testID="play-online-screen"
        footer={
          <>
            {mayCancel ? (
              <Button title="CANCEL SEARCH" variant="secondary" testID="search-cancel" loading={!!pending.cancel} onPress={() => void run(() => store().cancel())} />
            ) : (
              <Button title="Leave party" variant="secondary" size="md" testID="party-leave" loading={!!pending.party} onPress={() => void run(() => store().leaveParty())} />
            )}
            <Button title="Back to Home (keep searching)" size="sm" variant="ghost" testID="search-home" onPress={home} />
          </>
        }
      >
        <Header title={reconnecting ? 'Reconnecting…' : 'Searching…'} subtitle={ticketSummary(ticket.mode, ticket.playerCount)} />
        {stale}
        {reconnecting ? <Alert testID="online-reconnecting">Connection lost. Your place in the queue is kept for a short while — reconnecting…</Alert> : null}
        {failed}
        <View className="items-center gap-2 py-6" testID="search-status">
          <ActivityIndicator size="large" color={COLORS.saffron} />
          <Text className="text-6xl font-black text-cream" testID="search-elapsed" accessibilityLabel={`Searching for ${waited} seconds`}>
            {formatClock(waited)}
          </Text>
          <Text className="text-center text-base font-semibold text-cream/80" testID="search-hint">
            {searchHint(waited, ticket.playerCount, data.settings)}
          </Text>
          {ticket.requeueCount > 0 ? <Text className="text-center text-sm text-cream/70">A match fell through because someone didn’t confirm. You kept your place in the queue.</Text> : null}
        </View>
        {data.party ? <PartyMembers party={data.party} pending={pending} /> : null}
        {!mayCancel ? <Text className="text-center text-xs text-cream/60">Only the party leader can stop the search. Leaving the party takes just you out; the others keep searching.</Text> : null}
      </Screen>
    );
  }

  const blocker = startBlocker(data, now, deviceGame === 'WAITING' || deviceGame === 'ACTIVE' || deviceGame === 'PAUSED' ? deviceGame : null);
  const outcome = resultMessage(data.lastResult);
  const resume = blocker && (blocker.code === 'IN_GAME' || blocker.code === 'IN_LOBBY') && session && deviceGame ? activeGameRoute(session.gameId, deviceGame) : null;

  // ---- in a party, not queued ----------------------------------------------------------------
  if (phase === 'party' && data.party) {
    const party = data.party;
    const me = party.members.find((m) => m.isMe);
    const full = party.members.length + party.invites.length >= data.settings.partyMaxMembers;
    const waiting = unreadyMembers(party);
    // A member does not need to be told they are not the leader: their own button is "I'm ready".
    const shown = blocker?.code === 'NOT_LEADER' ? null : blocker;
    return (
      <Screen
        scroll
        testID="play-online-screen"
        footer={
          <>
            {party.isLeader ? (
              <Button
                title="FIND MATCH"
                subtitle={`${GAME_MODE_LABELS[party.mode]} · ${party.members.length === 1 ? 'just you' : `party of ${party.members.length}`}`}
                testID="party-start"
                loading={!!pending.enqueue}
                disabled={!!blocker}
                onPress={() => void run(() => store().enqueue(null))}
              />
            ) : (
              <Button
                title={me?.ready ? 'NOT READY' : 'I’M READY'}
                subtitle={me?.ready ? 'Tap if you need a moment' : `Queue in ${GAME_MODE_LABELS[party.mode]} with this party`}
                variant={me?.ready ? 'secondary' : 'success'}
                testID="party-ready"
                loading={!!pending.partyReady}
                onPress={() => void run(() => store().setReady(!me?.ready))}
              />
            )}
            <Button title="Leave party" size="sm" variant="ghost" testID="party-leave" loading={!!pending.party} onPress={() => void run(() => store().leaveParty())} />
          </>
        }
      >
        <Header title="Your party" subtitle="Queue together — you’ll never be split up." onBack={home} />
        {stale}
        {failed}
        {outcome ? (
          <Alert tone={outcome.kind === 'error' ? 'bad' : 'info'} testID="online-last-result">
            {outcome.message}
          </Alert>
        ) : null}
        <Label className="text-cream/70">Game mode</Label>
        <ModePicker value={party.mode} busy={!!pending.mode} onChange={party.isLeader ? (next) => void (next !== party.mode && run(() => store().setMode(next))) : undefined} />
        {!party.isLeader ? <Text className="-mt-2 text-xs text-cream/60">The party leader chooses the mode. If it changes, you’ll be asked to confirm again.</Text> : null}
        <PartyMembers party={party} pending={pending} onKick={party.isLeader ? (playerId) => void run(() => store().kick(playerId)) : undefined} />
        {party.invites.length ? (
          <Card testID="party-pending-invites">
            <Label>Invited</Label>
            {party.invites.map((i) => (
              <View key={i.id} className="mt-2 flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-base font-bold text-ink" numberOfLines={1}>
                  {i.nickname}
                </Text>
                <Pill tone="gold">Waiting</Pill>
              </View>
            ))}
          </Card>
        ) : null}
        {party.isLeader ? <Button title="Invite friends" size="md" variant="ghost" testID="party-invite" onPress={() => setInviting(true)} /> : null}
        {shown ? (
          <Alert testID="online-blocker">{shown.message}</Alert>
        ) : party.isLeader && party.members.length > 1 ? (
          <Alert tone="info" testID="party-all-ready">
            Everyone is ready. Start when you are.
          </Alert>
        ) : !party.isLeader && waiting.length === 0 ? (
          <Alert tone="info" testID="party-all-ready">
            Everyone is ready. Waiting for the leader to start.
          </Alert>
        ) : null}
        {resume ? <Button title="Go to your game" size="sm" variant="secondary" testID="online-resume" onPress={() => router.push(resume)} /> : null}
        <InviteToPartySheet visible={inviting && party.isLeader} onClose={() => setInviting(false)} party={party} full={full} />
      </Screen>
    );
  }

  // ---- entry: pick a mode, play solo or gather friends ----------------------------------------
  return (
    <Screen
      scroll
      testID="play-online-screen"
      footer={
        <>
          <Button title="FIND MATCH" subtitle={`Play solo · ${GAME_MODE_LABELS[mode]}`} testID="online-solo" loading={!!pending.enqueue} disabled={!!blocker} onPress={() => void run(() => store().enqueue(mode))} />
          <Button title="PLAY WITH FRIENDS" subtitle="Make a party and queue together" variant="secondary" testID="online-party" loading={!!pending.party} disabled={!!blocker} onPress={() => void run(() => store().createParty(mode))} />
        </>
      }
    >
      <Header title="Play Online" subtitle="Random match with other players." onBack={home} />
      {stale}
      {failed}
      {outcome ? (
        <Alert tone={outcome.kind === 'error' ? 'bad' : 'info'} testID="online-last-result">
          {outcome.message}
        </Alert>
      ) : null}
      {data.partyInvites.map((invite) => (
        <Card key={invite.id} testID={`party-invite-${invite.id}`} className="border-2 border-saffron">
          <Label>Party invitation</Label>
          <Text className="mt-1 text-lg font-black text-ink">{invite.inviter.nickname} invited you to their party</Text>
          <Text className="text-sm text-stone-600">
            {GAME_MODE_LABELS[invite.mode]} · {invite.size} {invite.size === 1 ? 'player' : 'players'} so far · expires in {formatClock(secondsLeft(invite.expiresAt, now))}
          </Text>
          <Text className="text-xs text-stone-500">Joining a party doesn’t start anything: you confirm when you’re ready to queue.</Text>
          <View className="mt-3 flex-row gap-3">
            <Button className="flex-1" title="Join party" size="md" testID={`party-invite-accept-${invite.id}`} loading={!!pending[`invitation:${invite.id}`]} onPress={() => void run(() => store().respondInvite(invite.id, true))} />
            <Button className="flex-1" title="Decline" size="md" variant="secondary" testID={`party-invite-decline-${invite.id}`} onPress={() => void run(() => store().respondInvite(invite.id, false))} />
          </View>
        </Card>
      ))}
      <Label className="text-cream/70">Game mode</Label>
      <ModePicker value={mode} onChange={setMode} />
      <Text className="text-xs text-cream/60">
        Tables of {data.settings.targetPlayers} are preferred ({data.settings.minPlayers}–{data.settings.maxPlayers} players). Public tables use each mode’s standard settings. When a match is found, everyone has {data.settings.readySeconds} seconds to confirm.
      </Text>
      {blocker ? <Alert testID="online-blocker">{blocker.message}</Alert> : null}
      {resume ? <Button title="Go to your game" size="sm" variant="secondary" testID="online-resume" onPress={() => router.push(resume)} /> : null}
    </Screen>
  );
}

/** Home's way into Play Online, saying what is going on there right now. */
export function PlayOnlineEntry() {
  const data: MatchmakingState | null = useMatchmakingStore((s) => s.data);
  const phase = phaseOf(data);
  const invites = data?.partyInvites.length ?? 0;
  const subtitle =
    phase === 'matchFound'
      ? 'Match found — confirm now!'
      : phase === 'starting'
        ? 'Your game is starting'
        : phase === 'searching'
          ? 'Searching for a match…'
          : phase === 'party'
            ? `In a party · ${data?.party?.members.length ?? 1} ${data?.party?.members.length === 1 ? 'player' : 'players'}`
            : invites
              ? `${invites} party ${invites === 1 ? 'invitation' : 'invitations'}`
              : 'Random match · solo or with friends';
  return (
    <View>
      <Button title="PLAY ONLINE" subtitle={subtitle} testID="play-online" variant={phase === 'matchFound' || phase === 'searching' ? 'success' : 'secondary'} onPress={() => router.push('/play-online')} />
      {invites > 0 && phase === 'entry' ? (
        <View pointerEvents="none" testID="play-online-badge" className="absolute -right-1 -top-1 h-6 min-w-[24px] items-center justify-center rounded-full bg-brick px-1.5">
          <Text className="text-xs font-black text-white">{invites > 9 ? '9+' : String(invites)}</Text>
        </View>
      ) : null}
    </View>
  );
}
