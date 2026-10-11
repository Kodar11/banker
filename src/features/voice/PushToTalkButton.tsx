import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { COLORS } from '@/constants/theme';
import { ActionIcon } from '@/features/game/ActionIcon';
import { FIXED_HEIGHT_FONT_SCALE, type ActionLayout } from '@/features/game/layout';
import { voiceMessage } from './messages';
import { useVoice, voice } from './voice';
import type { VoicePhase } from './voiceController';

const LABEL: Record<VoicePhase, string> = {
  unavailable: 'Voice off',
  idle_muted: 'Join voice',
  connecting: 'Connecting…',
  ready_muted: 'Hold to talk',
  transmitting: 'Talking',
  reconnecting: 'Reconnecting…',
  error: 'Retry voice',
};

const HINT: Record<VoicePhase, string> = {
  unavailable: 'Voice chat is not available right now',
  idle_muted: 'Joins this game’s voice chat with your microphone off',
  connecting: 'Joining voice chat',
  ready_muted: 'Press and hold to talk. Release to mute',
  transmitting: 'Your microphone is on. Release to mute',
  reconnecting: 'Voice chat is reconnecting. Your microphone is off',
  error: 'Voice chat could not connect. Tap to try again',
};

/**
 * The microphone, in the action grid where Auction used to be (Auction is in More). Same size and
 * shape as the buttons around it. A tap joins voice and never transmits; holding it — once joined
 * — transmits until the finger lifts, slides off or the touch is cancelled (Pressable reports all
 * three as a press-out). It opens no sheet.
 */
export function PushToTalkButton({ layout, height, focused = true }: { layout: ActionLayout; height: number; /** False while another screen covers the table. */ focused?: boolean }) {
  const phase = useVoice((s) => s.phase);
  const problem = useVoice((s) => s.problem);
  const micOff = useVoice((s) => s.mic === 'denied' || s.mic === 'blocked');

  // The button going away (navigation, a layout change, the game ending) can swallow the release.
  useEffect(() => () => voice.stopTransmitting(), []);
  useEffect(() => {
    if (!focused) voice.stopTransmitting();
  }, [focused]);

  const twoLines = layout === 'row';
  const talking = phase === 'transmitting';
  const off = phase === 'unavailable';
  const busy = phase === 'connecting' || phase === 'reconnecting';
  const failed = phase === 'error';
  const color = talking ? COLORS.ink : COLORS.cream;
  const label = phase === 'ready_muted' && micOff ? 'Mic is off' : LABEL[phase];
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        testID="push-to-talk"
        onPressIn={() => voice.pressIn()}
        onPressOut={() => voice.pressOut()}
        onPress={() => voice.tap()}
        // Holding is the gesture: no long-press action, and the finger may wander a little without letting go.
        pressRetentionOffset={12}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Voice chat: ${label}`}
        accessibilityHint={off ? voiceMessage(problem) : phase === 'ready_muted' && micOff ? voiceMessage(problem) : HINT[phase]}
        accessibilityState={{ disabled: off, busy, selected: talking }}
        style={{ height, gap: 2 }}
        className={`items-center justify-center rounded-xl border px-0.5 ${
          talking ? 'border-saffron bg-saffron' : failed ? 'border-brick bg-white/10 active:bg-white/20' : 'border-white/20 bg-white/10 active:bg-white/20'
        } ${off ? 'opacity-40' : busy ? 'opacity-70' : ''}`}
      >
        <ActionIcon name={off || failed || (phase === 'ready_muted' && micOff) ? 'mic-off' : 'mic'} size={twoLines ? 22 : 20} color={color} />
        <Text
          testID="push-to-talk-label"
          style={{ color }}
          className={`text-center font-bold ${twoLines ? 'text-[10px] leading-[12px]' : 'text-xs leading-4'}`}
          numberOfLines={twoLines ? 2 : 1}
          maxFontSizeMultiplier={FIXED_HEIGHT_FONT_SCALE}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}
