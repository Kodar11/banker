import { Text, View } from 'react-native';
import { Reveal } from '../motion';
import type { CastId, TradeItem, TradeScene } from '../types';
import { CashChip, CAST, Panel, StoryCardView, Tag, Who } from './parts';

const STATUS = {
  proposed: { text: 'Proposed', tone: 'neutral' },
  accepted: { text: 'Accepted — it changes hands', tone: 'good' },
  declined: { text: 'Declined — nothing changes hands', tone: 'bad' },
} as const;

/** "You give" / "Meera gives", in the tense the deal is in. */
function verbFor(who: CastId, status: TradeScene['status']): string {
  if (status === 'accepted') return 'gave';
  if (status === 'declined') return 'would give';
  return who === 'you' ? 'give' : 'gives';
}

function Items({ items }: { items: TradeItem[] }) {
  return (
    <View className="items-start gap-2">
      {items.map((item) => ('card' in item ? <StoryCardView key={item.card.name} card={item.card} /> : <CashChip key={`cash-${item.cash}`} amount={item.cash} />))}
    </View>
  );
}

/**
 * A deal between two players: what each side hands over, and whether it happened. When the deal
 * is accepted each side's items slide in from the player who gave them.
 */
export function PropertyTradeScene({ scene }: { scene: TradeScene }) {
  const status = STATUS[scene.status];
  const moving = scene.status === 'accepted';
  return (
    <Panel title={scene.title ?? 'The deal'} testID="scene-trade">
      <View className="flex-row gap-2">
        <View className="flex-1 gap-2">
          <Who who={scene.left.who} suffix={verbFor(scene.left.who, scene.status)} />
          <Reveal from={moving ? 'left' : 'below'}>
            <Items items={scene.left.gives} />
          </Reveal>
        </View>
        <Text className="self-center text-xl text-stone-400" accessibilityElementsHidden importantForAccessibility="no">
          ⇄
        </Text>
        <View className="flex-1 gap-2">
          <Who who={scene.right.who} suffix={verbFor(scene.right.who, scene.status)} />
          <Reveal from={moving ? 'right' : 'below'} index={1}>
            <Items items={scene.right.gives} />
          </Reveal>
        </View>
      </View>
      <View className="gap-1 border-t border-stone-200 pt-2" testID={`scene-trade-${scene.status}`}>
        <Tag tone={status.tone}>{status.text}</Tag>
        {scene.statusNote ? <Text className="text-xs leading-5 text-stone-600">{scene.statusNote}</Text> : null}
        {scene.status === 'proposed' ? <Text className="text-xs leading-5 text-stone-600">{CAST[scene.right.who].name} is waiting for your answer.</Text> : null}
      </View>
    </Panel>
  );
}
