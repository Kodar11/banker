/// <reference types="jest" />
import { StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { netWorth, outstandingDebt, type GameSnapshot } from '@/engine/index.ts';
import { AuctionView, auctionResult } from '@/features/auction/AuctionView';
import { GameLog } from '@/features/game/GameLog';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import JoinGame from '../../app/join-game';
import Settings from '../../app/settings';
import { Fixture } from './fixtures';

function viewOf(snapshot: GameSnapshot, playerId: string): GameView {
  const me = snapshot.state.players.find((p) => p.id === playerId) ?? null;
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

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Join game: the code field stays centred', () => {
  const code = () => screen.getByTestId('join-code');
  const align = () => StyleSheet.flatten(code().props.style).textAlign;
  // The placeholder is decoration (the field has its label), so it is hidden from screen readers.
  const dots = () => screen.queryByText('••••••', { includeHiddenElements: true });

  it('empty, typed, cleared and pasted: always centre-aligned, with no native placeholder to pull the cursor aside', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValue({});
    await render(<JoinGame />);
    expect(code().props.value).toBe('');
    expect(align()).toBe('center');
    expect(code().props.placeholder).toBeUndefined();
    expect(dots()).toBeTruthy(); // drawn behind the empty field, centred

    await fireEvent.changeText(code(), '4');
    expect(align()).toBe('center');
    expect(dots()).toBeNull();

    await fireEvent.changeText(code(), '482915'); // a pasted full code
    expect(code().props.value).toBe('482915');
    expect(align()).toBe('center');

    await fireEvent.changeText(code(), '');
    expect(align()).toBe('center');
    expect(dots()).toBeTruthy();
    expect(code().props).toMatchObject({ maxLength: 6, keyboardType: 'number-pad', accessibilityLabel: '6-digit code' });
  });
});

describe('Auction result', () => {
  const players = [
    { id: 'a', name: 'Asha' },
    { id: 'r', name: 'Ram' },
  ];

  it('names the winner from the winner id; never an empty name', () => {
    expect(auctionResult({ winnerId: 'r' }, players)).toEqual({ sold: true, text: 'Sold to Ram' });
    expect(auctionResult({ winnerId: 'a' }, players)).toEqual({ sold: true, text: 'Sold to Asha' });
    expect(auctionResult({ winnerId: null }, players)).toEqual({ sold: false, text: 'Unsold — stays with the bank' });
    // The winner is not in the player list this phone has (yet): the sale is reported without a name.
    expect(auctionResult({ winnerId: 'x' }, players)).toEqual({ sold: true, text: 'Property sold' });
    expect(auctionResult({ winnerId: 'r' }, [{ id: 'r', name: '  ' }])).toEqual({ sold: true, text: 'Property sold' });
  });

  function soldToRam() {
    const f = new Fixture(['Asha', 'Ram', 'Chitra']);
    f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    const id = f.state.auction!.id;
    f.act('Ram', { type: 'PLACE_BID', auctionId: id, amount: 500 });
    f.act('Asha', { type: 'PASS_AUCTION', auctionId: id }).act('Chitra', { type: 'PASS_AUCTION', auctionId: id });
    return { f, id };
  }

  it.each(['Ram', 'Asha', 'Chitra'])('on the phone of %s: the same complete result, on a full-width line', async (who) => {
    const { f, id } = soldToRam();
    f.loadAs(who);
    await render(<AuctionView view={viewOf(f.snapshot(), f.ids[who]!)} auctionId={id} />);
    expect(screen.getByTestId('auction-result')).toHaveTextContent(/SOLD.*Sold to Ram$/);
    const line = screen.getByTestId('auction-result-text');
    expect(line).toHaveTextContent('Sold to Ram');
    // Not letter-spaced or transformed: nothing for Android to mis-measure and cut the last word from.
    const style = StyleSheet.flatten(line.props.style) ?? {};
    expect(style.letterSpacing).toBeUndefined();
    expect(style.textTransform).toBeUndefined();
  });

  it('player data that arrives late: a safe line first, then the name', async () => {
    const { f, id } = soldToRam();
    f.loadAs('Asha');
    const full = f.snapshot();
    const partial: GameSnapshot = { ...full, state: { ...full.state, players: full.state.players.filter((p) => p.id !== f.ids.Ram) } };
    const view = await render(<AuctionView view={viewOf(partial, f.ids.Asha!)} auctionId={id} />);
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent(/^Property sold$/);
    await view.rerender(<AuctionView view={viewOf(full, f.ids.Asha!)} auctionId={id} />);
    expect(screen.getByTestId('auction-result-text')).toHaveTextContent(/^Sold to Ram$/);
    expect(screen.getAllByTestId('auction-result-text')).toHaveLength(1);
  });

  it('no bids: every phone shows the unsold result', async () => {
    const f = new Fixture(['Asha', 'Ram']);
    f.roll('Asha', 1, 2).act('Asha', { type: 'DECLINE_PROPERTY' });
    const id = f.state.auction!.id;
    f.act('Ram', { type: 'PASS_AUCTION', auctionId: id }).act('Asha', { type: 'PASS_AUCTION', auctionId: id });
    for (const who of ['Asha', 'Ram']) {
      f.loadAs(who);
      const view = await render(<AuctionView view={viewOf(f.snapshot(), f.ids[who]!)} auctionId={id} />);
      expect(screen.getByTestId('auction-result')).toHaveTextContent(/CLOSED.*Unsold — stays with the bank$/);
      await view.unmount();
    }
  });
});

describe('Game log', () => {
  it('one row per event, newest first, with who did it and when; long messages are not cut', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2).act('Asha', { type: 'BUY_PROPERTY' });
    const { events, state } = f.snapshot();
    await render(<GameLog events={events} players={state.players} />);
    const feed = screen.getByTestId('event-feed');
    const first = within(feed).getByTestId(`log-entry-${events[0]!.id}`);
    expect(first).toHaveTextContent(/Asha bought Railway for ₹9,500/);
    expect(first).toHaveTextContent(/Asha · \d{1,2}:\d{2} (am|pm)/);
    expect(within(feed).getAllByTestId(/^log-entry-/)).toHaveLength(events.length);
    expect(within(first).getByText(events[0]!.message).props.numberOfLines).toBeUndefined();
    expect(feed).not.toHaveTextContent(new RegExp(f.ids.Asha!)); // never a raw id
  });

  it('shows only the latest events up to the limit and says so; an empty log has its own state', async () => {
    const f = new Fixture(['Asha', 'Bilal']).roll('Asha', 1, 2);
    const { events, state } = f.snapshot();
    const view = await render(<GameLog events={events} players={state.players} limit={2} />);
    expect(screen.getAllByTestId(/^log-entry-/)).toHaveLength(2);
    expect(screen.getByText('Showing the latest 2 events')).toBeTruthy();
    await view.rerender(<GameLog events={[]} players={state.players} />);
    expect(screen.queryByTestId('event-feed')).toBeNull();
    expect(screen.getByTestId('event-feed-empty')).toHaveTextContent(/Nothing has happened yet\./);
  });
});

describe('House rules & settings', () => {
  it('keeps every rule, in two labelled sections, and the leave control when a game is attached', async () => {
    const view = await render(<Settings />);
    expect(within(screen.getByTestId('confirmed-rules')).getByText('Confirmed for your physical board')).toBeTruthy();
    expect(within(screen.getByTestId('confirmed-rules')).getByText('Starting cash')).toBeTruthy();
    const assumed = screen.getByTestId('assumptions-list');
    expect(within(assumed).getByText('Configured assumptions — verify against your physical rulebook.')).toBeTruthy();
    for (const title of ['Players', 'Dice', 'Mortgage', 'Winning']) expect(within(assumed).getByText(title)).toBeTruthy();
    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.queryByTestId('leave-game')).toBeNull();
    await view.unmount();

    new Fixture(['Asha', 'Bilal']).loadAs('Asha');
    await render(<Settings />);
    expect(screen.getByTestId('leave-game')).toBeTruthy();
  });
});
