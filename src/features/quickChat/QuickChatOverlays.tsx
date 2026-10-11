import { memo, useEffect, useState, type ReactNode } from 'react';
import { Animated, Text, View } from 'react-native';
import { PlayerBadge } from '@/components/ui';
import { quickMessage, quickReaction, type PlayerState } from '@/engine/index.ts';
import { useReduceMotion } from '@/utils/useReduceMotion';
import { QUICK_CHAT_VISIBLE_MS, useQuickChatStore } from './quickChatStore';

const POP_IN_MS = 160;
const FADE_OUT_MS = 300;

/** Pops in, fades out just before the event expires. With reduced motion it simply appears and goes. */
function Pop({ children }: { children: ReactNode }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    const pop = Animated.timing(v, { toValue: 1, duration: POP_IN_MS, useNativeDriver: true });
    const fade = Animated.timing(v, { toValue: 0, duration: FADE_OUT_MS, useNativeDriver: true });
    pop.start();
    const t = setTimeout(() => fade.start(), QUICK_CHAT_VISIBLE_MS - FADE_OUT_MS);
    return () => {
      clearTimeout(t);
      pop.stop();
      fade.stop();
    };
  }, [reduce, v]);
  return <Animated.View style={{ opacity: v, transform: reduce ? undefined : [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }}>{children}</Animated.View>;
}

/**
 * On a player's chip, inside its bounds (so the strip never clips it and the layout never moves):
 * their reaction, or a speech mark while their message is up. Never takes a touch.
 */
export const ChipReaction = memo(function ChipReaction({ playerId }: { playerId: string }) {
  const event = useQuickChatStore((s) => s.shown[playerId]);
  if (!event) return null;
  const reaction = event.kind === 'reaction' ? quickReaction(event.key) : undefined;
  return (
    <View pointerEvents="none" testID={`chip-reaction-${playerId}`} style={{ position: 'absolute', right: 3, top: 0, bottom: 0, justifyContent: 'center' }}>
      <Pop key={event.id}>
        <View
          className="h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-cream"
          style={{ shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 3 }}
          accessibilityLiveRegion="polite" accessibilityLabel={reaction ? `${reaction.label} reaction` : 'Sent a message'}>
          <Text allowFontScaling={false} style={{ fontSize: 18, lineHeight: 23 }}>
            {reaction ? reaction.emoji : '💬'}
          </Text>
        </View>
      </Pop>
    </View>
  );
});

/** At most this many message bubbles at once; older ones give way. */
const MAX_BUBBLES = 2;

/**
 * Preset messages, as speech bubbles just ABOVE the player strip (over the title line, never over
 * the board or the turn's action), each on its sender's side of the strip and carrying their badge
 * and name. Place this inside a wrapper around the strip. Never takes a touch.
 */
export const ChatBubbles = memo(function ChatBubbles({ players, meId }: { players: PlayerState[]; meId: string | null }) {
  const shown = useQuickChatStore((s) => s.shown);
  const seats = [...players].sort((a, b) => a.seat - b.seat);
  const bubbles = Object.values(shown)
    .filter((e) => e.kind === 'preset_message')
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(-MAX_BUBBLES);
  if (!bubbles.length) return null;
  return (
    <View pointerEvents="none" testID="chat-bubbles" style={{ position: 'absolute', left: 0, right: 0, bottom: '100%', paddingBottom: 3, gap: 3, zIndex: 5 }}>
      {bubbles.map((e) => {
        const index = seats.findIndex((p) => p.id === e.playerId);
        const sender = seats[index];
        const message = quickMessage(e.key);
        if (!sender || !message) return null;
        // The sender's place along the strip: left, middle or right.
        const along = seats.length > 1 ? index / (seats.length - 1) : 0;
        const name = sender.id === meId ? 'You' : sender.name;
        const side = along < 0.34 ? 'left' : along > 0.66 ? 'right' : 'middle';
        return (
          <View key={e.id} style={{ alignSelf: side === 'left' ? 'flex-start' : side === 'right' ? 'flex-end' : 'center', maxWidth: '86%' }}>
            <Pop>
              <View
                testID={`chat-bubble-${e.playerId}`}
                accessibilityLiveRegion="polite"
                accessibilityLabel={`${name}: ${message.text}`}
                // The bubble's tail: the square corner points down at its sender's side of the strip.
                className={`flex-row items-center gap-1.5 rounded-2xl border border-stone-200 bg-cream px-3 py-1.5 ${side === 'left' ? 'rounded-bl-sm' : side === 'right' ? 'rounded-br-sm' : ''}`}
                style={{ shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 }}
              >
                <PlayerBadge player={sender} size={14} plain />
                <Text className="shrink text-[13px] font-extrabold text-ink" maxFontSizeMultiplier={1.3}>
                  <Text className="font-bold text-stone-500">{name}: </Text>
                  {message.text}
                </Text>
              </View>
            </Pop>
          </View>
        );
      })}
    </View>
  );
});
