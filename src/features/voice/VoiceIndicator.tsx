import { memo, useEffect, useState } from 'react';
import { Animated, View } from 'react-native';
import { voiceUidForSeat } from '@/engine/index.ts';
import { COLORS } from '@/constants/theme';
import { ActionIcon } from '@/features/game/ActionIcon';
import { useReduceMotion } from '@/utils/useReduceMotion';
import { useVoice } from './voice';

export type VoicePresence = 'none' | 'connecting' | 'listening' | 'speaking' | 'muted_by_me';

/** What this phone knows about one player's voice: mine from the push-to-talk state, anyone else's from the SDK's events for their uid. */
export function useVoicePresence(seat: number, isMe: boolean): VoicePresence {
  const uid = voiceUidForSeat(seat);
  return useVoice((s): VoicePresence => {
    if (isMe) {
      if (s.phase === 'transmitting') return 'speaking';
      if (s.phase === 'ready_muted') return 'listening';
      return s.phase === 'connecting' || s.phase === 'reconnecting' ? 'connecting' : 'none';
    }
    const peer = s.peers[uid];
    if (!peer) return 'none';
    if (s.muteAll || s.mutedUids[uid]) return 'muted_by_me';
    return peer.speaking ? 'speaking' : 'listening';
  });
}

export function voicePresenceLabel(presence: VoicePresence): string {
  switch (presence) {
    case 'speaking':
      return 'speaking';
    case 'listening':
      return 'in voice chat';
    case 'connecting':
      return 'connecting to voice chat';
    case 'muted_by_me':
      return 'muted by you';
    default:
      return '';
  }
}

/** A soft pulse while someone talks. With reduced motion it is simply shown. */
function Pulse({ children }: { children: React.ReactNode }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.55, duration: 420, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 420, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, v]);
  return <Animated.View style={{ opacity: v }}>{children}</Animated.View>;
}

/**
 * The small microphone next to a player's name: saffron and pulsing while they talk, dim while
 * they are only listening, struck through when this phone muted them. Nothing at all for a player
 * who is not in voice. Takes no room of its own row and never a touch.
 */
export const VoiceIndicator = memo(function VoiceIndicator({ playerId, seat, isMe, size = 14 }: { playerId: string; seat: number; isMe: boolean; size?: number }) {
  const presence = useVoicePresence(seat, isMe);
  if (presence === 'none') return null;
  if (presence === 'speaking') {
    return (
      <View pointerEvents="none" testID={`voice-speaking-${playerId}`}>
        <Pulse>
          <View style={{ width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, backgroundColor: COLORS.saffron, alignItems: 'center', justifyContent: 'center' }}>
            <ActionIcon name="mic" size={size - 2} color={COLORS.ink} />
          </View>
        </Pulse>
      </View>
    );
  }
  return (
    <View pointerEvents="none" testID={`voice-${presence === 'muted_by_me' ? 'muted' : presence}-${playerId}`} style={{ opacity: presence === 'connecting' ? 0.4 : 0.7 }}>
      <ActionIcon name={presence === 'muted_by_me' ? 'mic-off' : 'mic'} size={size} color={COLORS.cream} />
    </View>
  );
});
