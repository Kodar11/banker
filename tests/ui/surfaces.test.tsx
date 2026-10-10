/// <reference types="jest" />
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { Card, ConfirmDialog } from '@/components/ui';
import { SquareDetails } from '@/features/board/SquareDetails';
import type { GameView } from '@/features/game/useGameView';
import { PropertyDeed } from '@/features/player/PropertyDeed';
import { netWorth, outstandingDebt, positionOfProperty, positionOfSpecial } from '@/engine/index.ts';
import { Fixture } from './fixtures';

/** Bottom edge of a rendered surface: its width, and anything in its classes that would draw one. */
function bottomEdge(testID: string) {
  const { style, className } = screen.getByTestId(testID).props as { style?: StyleProp<ViewStyle>; className?: string };
  return { width: StyleSheet.flatten(style)?.borderBottomWidth ?? 0, classes: className ?? '' };
}

function expectNoGrayStrip(testID: string) {
  const edge = bottomEdge(testID);
  expect(edge.width).toBe(0);
  expect(edge.classes).not.toMatch(/border-b-|border-stone-300|shadow/);
}

function viewFor(f: Fixture, name: string): GameView {
  const snapshot = f.snapshot();
  const me = snapshot.state.players.find((p) => p.id === f.ids[name]) ?? null;
  const current = snapshot.state.players.find((p) => p.id === snapshot.state.turn.playerId) ?? null;
  return {
    snapshot,
    me,
    current,
    isMyTurn: !!me && current?.id === me.id && snapshot.state.status === 'ACTIVE',
    isHost: !!me?.isHost,
    playerName: (id) => snapshot.state.players.find((p) => p.id === id)?.name ?? 'Bank',
    myNetWorth: me ? netWorth(snapshot.state, me.id) : 0,
    myDebt: me ? outstandingDebt(snapshot.state.loans, me.id) : 0,
  };
}

describe('Cream surfaces have no gray strip along the bottom', () => {
  it('Card: no bottom edge by default; an accent edge only when a card asks for one', async () => {
    await render(
      <>
        <Card testID="plain">
          <Text>Plain</Text>
        </Card>
        <Card testID="accent" className="border-b-4 border-saffron bg-amber-50">
          <Text>Accent</Text>
        </Card>
      </>,
    );
    expectNoGrayStrip('plain');
    const accent = bottomEdge('accent');
    expect(accent.width === 4 || /border-b-4/.test(accent.classes)).toBe(true);
    expect(accent.classes).not.toMatch(/border-stone-300/);
  });

  it('property deeds (site, transport) and the confirmation dialog', async () => {
    const f = new Fixture().roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' });
    const view = await render(<PropertyDeed state={f.state} propertyKey="RAILWAY" playerName={() => 'Asha'} />);
    expectNoGrayStrip('property-deed');
    await view.rerender(<PropertyDeed state={f.state} propertyKey="AMRITSAR" playerName={() => 'Asha'} />);
    expectNoGrayStrip('property-deed');
    await view.rerender(<ConfirmDialog visible title="End Game?" message="Sure?" confirmTitle="End Game" testID="dlg" onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expectNoGrayStrip('dlg');
  });

  it('a property square, Chance and Community Chest in the details sheet', async () => {
    const f = new Fixture().loadAs('Asha');
    const details = (index: number) => <SquareDetails view={viewFor(f, 'Asha')} index={index} onPlayerPress={jest.fn()} />;
    const view = await render(details(positionOfProperty('AMRITSAR')));
    expectNoGrayStrip('property-deed');
    for (const type of ['CHANCE', 'COMMUNITY_CHEST'] as const) {
      await view.rerender(details(positionOfSpecial(type)));
      expectNoGrayStrip('special-square-card');
    }
  });
});
