import { Component, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Reveal } from '../motion';
import type { SceneBlock } from '../types';
import { AuctionScene } from './AuctionScene';
import { CashLedger, Compare, CreditScore, Holdings, Note, Schedule } from './BasicScenes';
import { CompoundingTimeline } from './CompoundingTimeline';
import { LoanComparisonScene } from './LoanComparisonScene';
import { PresentValueTimeline } from './PresentValueTimeline';
import { PropertyTradeScene } from './PropertyTradeScene';

function renderBlock(block: SceneBlock): ReactNode {
  switch (block.kind) {
    case 'cash':
      return <CashLedger scene={block} />;
    case 'holdings':
      return <Holdings scene={block} />;
    case 'trade':
      return <PropertyTradeScene scene={block} />;
    case 'auction':
      return <AuctionScene scene={block} />;
    case 'presentValue':
      return <PresentValueTimeline scene={block} />;
    case 'growth':
      return <CompoundingTimeline scene={block} />;
    case 'loanComparison':
      return <LoanComparisonScene scene={block} />;
    case 'schedule':
      return <Schedule scene={block} />;
    case 'credit':
      return <CreditScore scene={block} />;
    case 'compare':
      return <Compare scene={block} />;
    case 'note':
      return <Note scene={block} />;
  }
}

/** If one picture fails to draw, the lesson carries on: its text already says what happened. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View className="rounded-2xl bg-stone-100 px-3 py-2" testID="scene-fallback">
        <Text className="text-xs text-stone-600">This picture could not be shown. The text describes what happens.</Text>
      </View>
    );
  }
}

/** Draws a story scene: its blocks in order, each arriving a moment after the one before. */
export function SceneView({ blocks, testID }: { blocks: readonly SceneBlock[]; testID?: string }) {
  return (
    <View className="gap-3" testID={testID}>
      {blocks.map((block, i) => (
        <SceneBoundary key={`${block.kind}-${i}`}>
          <Reveal index={i}>{renderBlock(block)}</Reveal>
        </SceneBoundary>
      ))}
    </View>
  );
}
