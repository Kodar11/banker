import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { voiceUidForSeat, type PlayerState } from '@/engine/index.ts';
import { Button, PlayerBadge } from '@/components/ui';
import { voiceMessage } from './messages';
import { useVoice, voice } from './voice';
import { DEFAULT_VOLUME, type VoicePhase } from './voiceController';
import { useVoicePresence, voicePresenceLabel } from './VoiceIndicator';
import { VolumeSlider } from './VolumeSlider';

const STATUS: Record<VoicePhase, string> = {
  unavailable: 'Not available',
  idle_muted: 'Not joined',
  connecting: 'Connecting…',
  ready_muted: 'Connected · mic off',
  transmitting: 'Connected · talking',
  reconnecting: 'Reconnecting…',
  error: 'Couldn’t connect',
};

/**
 * The Voice part of the More sheet, shown only in a room whose host turned voice on. Collapsed to
 * one row until opened, so More stays as short as it was. Everything in here changes what THIS
 * phone hears (or whether it is in voice at all): nothing is sent to the game or to other players.
 */
export function VoiceSection({ players, meId }: { players: PlayerState[]; meId: string | null }) {
  const [open, setOpen] = useState(false);
  const enabled = useVoice((s) => s.room?.enabled === true);
  const phase = useVoice((s) => s.phase);
  const problem = useVoice((s) => s.problem);
  const mic = useVoice((s) => s.mic);
  const muteAll = useVoice((s) => s.muteAll);
  const masterVolume = useVoice((s) => s.masterVolume);
  if (!enabled) return null;

  const joined = phase === 'ready_muted' || phase === 'transmitting' || phase === 'reconnecting';
  const others = players.filter((p) => p.id !== meId && p.status !== 'LEFT').sort((a, b) => a.seat - b.seat);
  const explain = phase === 'unavailable' || phase === 'error' || (joined && (mic === 'denied' || mic === 'blocked'));
  return (
    <View className="rounded-2xl bg-white" testID="voice-section">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        testID="voice-section-toggle"
        accessibilityRole="button"
        accessibilityLabel={`Voice, ${STATUS[phase]}`}
        accessibilityHint={open ? 'Hides the voice controls' : 'Shows the voice controls'}
        accessibilityState={{ expanded: open }}
        className="min-h-[52px] flex-row items-center gap-3 px-4 py-2"
      >
        <Text className="w-7 text-center text-xl">🎙️</Text>
        <View className="flex-1">
          <Text className="text-base font-bold text-ink">Voice</Text>
          <Text className="text-xs text-stone-500" numberOfLines={1} testID="voice-status">
            {STATUS[phase]}
          </Text>
        </View>
        <Text className="text-lg text-stone-400">{open ? '⌄' : '›'}</Text>
      </Pressable>

      {open ? (
        <View className="gap-3 border-t border-stone-200 px-4 pb-4 pt-3" testID="voice-controls">
          {explain ? (
            <Text className="text-sm font-semibold text-stone-700" testID="voice-problem" accessibilityRole="alert">
              {voiceMessage(problem)}
            </Text>
          ) : null}
          {joined && mic === 'blocked' ? (
            <Button size="sm" variant="secondary" className="self-start" title="Open Settings" testID="voice-open-settings" onPress={() => void Linking.openSettings().catch(() => undefined)} />
          ) : null}

          {phase === 'idle_muted' || phase === 'error' ? (
            <>
              <Text className="text-xs text-stone-500">Joining connects you with your microphone off. Hold the mic button on the table to talk.</Text>
              <Button size="sm" className="self-start" title={phase === 'error' ? 'Try again' : 'Join voice'} testID="voice-join" onPress={() => void voice.join()} />
            </>
          ) : null}
          {phase === 'connecting' ? <Text className="text-xs text-stone-500">Connecting to voice…</Text> : null}

          {joined ? (
            <>
              <View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-bold text-ink">Voice volume</Text>
                  <Text className="text-xs font-bold text-stone-500" testID="voice-master-value">
                    {masterVolume}%
                  </Text>
                </View>
                <VolumeSlider value={masterVolume} onChange={(v) => voice.setMasterVolume(v)} label="Voice volume, all players" testID="voice-master-volume" />
                <Text className="text-xs text-stone-500">Only the players’ voices. Game sounds and your phone’s volume are not changed.</Text>
              </View>

              <View className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-xs text-stone-500">
                  {muteAll ? 'You hear nobody. They can still hear each other, and you when you talk.' : 'Muting only changes what you hear.'}
                </Text>
                <Button
                  size="sm"
                  variant="secondary"
                  title={muteAll ? 'Unmute everyone' : 'Mute everyone'}
                  testID="voice-mute-all"
                  disabled={others.length === 0}
                  onPress={() => voice.setMuteAll(!muteAll)}
                />
              </View>

              {others.map((p) => (
                <PlayerVoiceRow key={p.id} player={p} muteAll={muteAll} />
              ))}

              {/* Not destructive: the seat, the game and the turn are untouched, and joining again is one tap. */}
              <Button size="sm" variant="outline" className="self-start" title="Leave voice" testID="voice-leave" accessibilityHint="Disconnects you from voice chat. You stay in the game" onPress={() => voice.leaveVoice()} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PlayerVoiceRow({ player, muteAll }: { player: PlayerState; muteAll: boolean }) {
  const uid = voiceUidForSeat(player.seat);
  const presence = useVoicePresence(player.seat, false);
  const muted = useVoice((s) => s.mutedUids[uid] === true);
  const volume = useVoice((s) => s.volumes[uid] ?? DEFAULT_VOLUME);
  const state = presence === 'none' ? 'Not in voice' : muted ? 'Muted by you' : muteAll ? 'Muted (everyone)' : presence === 'speaking' ? 'Speaking' : 'Listening';
  return (
    <View className="gap-1 rounded-xl bg-stone-100 px-3 py-2" testID={`voice-player-${player.id}`}>
      <View className="flex-row items-center gap-2">
        <PlayerBadge player={player} size={22} />
        <View className="flex-1">
          <Text className="text-sm font-bold text-ink" numberOfLines={1}>
            {player.name}
          </Text>
          <Text className="text-xs text-stone-500" testID={`voice-player-state-${player.id}`} accessibilityLabel={`${player.name}: ${state}${presence === 'none' ? '' : `, ${voicePresenceLabel(presence)}`}`}>
            {state}
          </Text>
        </View>
        <Button
          size="sm"
          variant="secondary"
          title={muted ? 'Unmute' : 'Mute'}
          testID={`voice-mute-${player.id}`}
          accessibilityHint={muted ? `Hear ${player.name} again` : `Stop hearing ${player.name}. Only you are affected`}
          onPress={() => voice.setPeerMuted(uid, !muted)}
        />
      </View>
      <VolumeSlider value={volume} onChange={(v) => voice.setPeerVolume(uid, v)} label={`Volume of ${player.name}`} testID={`voice-volume-${player.id}`} disabled={muted || muteAll} />
    </View>
  );
}
