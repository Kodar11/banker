import { Pressable, Text, View } from 'react-native';
import { Sheet } from '@/components/ui';
import { QUICK_MESSAGE_GROUPS, QUICK_REACTIONS, type QuickChatItem } from '@/engine/index.ts';

interface QuickChatSheetProps {
  visible: boolean;
  onClose: () => void;
  /** One tap sends: there is no confirmation. */
  onSend: (item: QuickChatItem) => void;
  /** This player sent something a moment ago. */
  cooling: boolean;
  /** …and tapped again before the cooldown ended. */
  blocked: boolean;
}

/**
 * Reactions and preset messages in ONE sheet: no tabs, no text field. Everything goes to everyone
 * in the game. The list comes from the shared catalogue; nothing here is typed by the player.
 *
 * Dressed like the rest of the table: reactions are chunky cream tiles on a felt panel (the same
 * panel the pay and trade sheets use), messages are white speech bubbles, like the ones that then
 * appear over the players.
 */
export function QuickChatSheet({ visible, onClose, onSend, cooling, blocked }: QuickChatSheetProps) {
  const dim = cooling ? 'opacity-50' : '';
  return (
    <Sheet
      visible={visible}
      title="Chat & React"
      onClose={onClose}
      testID="chat-sheet"
      header={
        <View>
          <Text className="text-2xl font-extrabold text-ink">Chat & React</Text>
          <Text className="text-sm font-semibold text-stone-500">Tap one. Everyone in the game sees it.</Text>
        </View>
      }
    >
      {blocked ? (
        <View accessibilityRole="alert" testID="chat-cooldown" className="flex-row items-center justify-center gap-2 rounded-2xl bg-amber-100 px-3 py-2">
          <Text className="text-base">⏳</Text>
          <Text className="shrink text-sm font-bold text-amber-800">One at a time. You can send again in a moment.</Text>
        </View>
      ) : null}

      <View className="gap-2.5 rounded-2xl bg-felt p-3">
        <Text className="text-xs font-bold uppercase tracking-widest text-cream/80">Quick Reactions</Text>
        <View className="flex-row flex-wrap justify-between gap-y-2" testID="chat-reactions">
          {QUICK_REACTIONS.map((r) => (
            <Pressable
              key={r.key}
              testID={`chat-reaction-${r.key}`}
              onPress={() => onSend({ kind: 'reaction', key: r.key })}
              accessibilityRole="button"
              accessibilityLabel={`${r.label} reaction`}
              accessibilityHint="Sends it to everyone in the game"
              style={{ width: '23.5%' }}
              className={`h-16 items-center justify-center rounded-2xl border-b-4 border-stone-300 bg-cream px-0.5 active:opacity-80 ${dim}`}
            >
              <Text className="text-[26px] leading-8" maxFontSizeMultiplier={1.2}>
                {r.emoji}
              </Text>
              <Text className="text-[10px] font-bold leading-3 text-stone-600" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2}>
                {r.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View className="gap-3">
        <Text className="text-xs font-bold uppercase tracking-widest text-stone-600">Quick Messages</Text>
        {QUICK_MESSAGE_GROUPS.map((group) => (
          <View key={group.key} className="gap-2" testID={`chat-group-${group.key}`}>
            <Text className="text-sm font-extrabold text-ink">{group.title}</Text>
            <View className="flex-row flex-wrap justify-between gap-y-2">
              {group.messages.map((m, i) => (
                <Pressable
                  key={m.key}
                  testID={`chat-message-${m.key}`}
                  onPress={() => onSend({ kind: 'preset_message', key: m.key })}
                  accessibilityRole="button"
                  accessibilityLabel={m.text}
                  accessibilityHint="Sends it to everyone in the game"
                  style={{ width: '48.5%' }}
                  // A speech bubble: the corner nearest the sheet's edge is the tail.
                  className={`min-h-[48px] items-center justify-center rounded-2xl border-b-[3px] border-stone-200 bg-white px-3 py-2 active:opacity-80 ${i % 2 ? 'rounded-br-md' : 'rounded-bl-md'} ${dim}`}
                >
                  {/* Wraps rather than cuts: every message is shown whole. */}
                  <Text className="text-center text-[15px] font-bold leading-5 text-ink">{m.text}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </View>
    </Sheet>
  );
}
