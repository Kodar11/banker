/// <reference types="jest" />
/**
 * Whole games played by the real engine, with the real game screen mounted on
 * one phone the entire time. After every action the new snapshot is applied to
 * the store exactly like the app does it; a render that throws for ANY reachable
 * game state (any square, any pending decision, either seat) fails the test.
 */
import { act, render, screen } from '@testing-library/react-native';
import { isGameError, minimumNextBid, type GameAction } from '@/engine/index.ts';
import { GameScreen } from '@/features/game/GameScreen';
import { PAY_ACTION } from '@/features/game/gameFocus';
import { useGameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { Fixture } from './fixtures';

/** Small deterministic PRNG so a failure can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Phone() {
  const view = useGameView();
  return view ? <GameScreen view={view} /> : null;
}

const nameOf = (f: Fixture, id: string | null) => f.state.players.find((p) => p.id === id)!.name;

/** The next thing some player would plausibly do. null = game over. */
function nextMove(f: Fixture, rnd: () => number): { who: string; action: GameAction } | 'roll' | null {
  const { state } = f;
  if (state.status !== 'ACTIVE') return null;
  const { turn } = state;
  const current = state.players.find((p) => p.id === turn.playerId)!;
  const who = current.name;
  const auction = state.auction?.status === 'OPEN' ? state.auction : null;
  if (turn.phase === 'AUCTION' && auction) {
    const open = auction.participantIds.filter((id) => !auction.passedIds.includes(id) && id !== auction.highBidderId);
    const bidderId = open[0];
    if (!bidderId) return { who, action: { type: 'CLOSE_AUCTION', auctionId: auction.id } };
    const bidder = state.players.find((p) => p.id === bidderId)!;
    const min = minimumNextBid(auction);
    return bidder.balance >= min && rnd() < 0.4
      ? { who: bidder.name, action: { type: 'PLACE_BID', auctionId: auction.id, amount: min } }
      : { who: bidder.name, action: { type: 'PASS_AUCTION', auctionId: auction.id } };
  }
  switch (turn.phase) {
    case 'AWAITING_ROLL':
      if (current.inJail) return { who, action: { type: current.balance >= 500 && rnd() < 0.5 ? 'PAY_JAIL_FINE' : 'STAY_IN_JAIL' } };
      return 'roll';
    case 'AWAITING_DECISION':
      return { who, action: { type: turn.pending?.kind === 'BUY' && current.balance >= turn.pending.price && rnd() < 0.75 ? 'BUY_PROPERTY' : 'DECLINE_PROPERTY' } };
    case 'AWAITING_PAYMENT':
      if (turn.pending?.kind !== 'PAYMENT') return null;
      return { who, action: { type: current.balance >= turn.pending.amount ? PAY_ACTION[turn.pending.reason] : 'DECLARE_BANKRUPTCY' } };
    case 'AWAITING_CARD':
      return { who, action: { type: 'RESOLVE_CARD', resolution: 'NONE' } };
    case 'TURN_COMPLETE':
      return { who, action: { type: 'END_TURN' } };
    default:
      return null;
  }
}

async function playOn(phone: string, names: string[], seed: number, maxActions: number) {
  const rnd = mulberry32(seed);
  const die = () => 1 + Math.floor(rnd() * 6);
  const f = new Fixture(names).loadAs(phone);
  await render(<Phone />);
  expect(screen.getByTestId('classic-board')).toBeTruthy();
  const seen = new Set<string>();
  let actions = 0;
  for (; actions < maxActions; actions += 1) {
    const move = nextMove(f, rnd);
    if (!move) break;
    const before = f.state.version;
    try {
      if (move === 'roll') f.roll(nameOf(f, f.state.turn.playerId), die(), die());
      else f.act(move.who, move.action);
    } catch (e) {
      // The engine refusing a scripted move is fine (the script is naive); a UI crash is not.
      if (!isGameError(e)) throw e;
      if (f.state.version === before) {
        const who = nameOf(f, f.state.turn.playerId);
        f.act(who, { type: f.state.turn.phase === 'TURN_COMPLETE' ? 'END_TURN' : 'DECLARE_BANKRUPTCY' });
      }
    }
    seen.add(`${f.state.turn.phase}:${f.state.turn.pending?.kind ?? '-'}`);
    await act(async () => {
      useGameStore.getState().applySnapshot(f.snapshot());
    });
    // The screen is still the game screen, on the authoritative version, after every single action.
    expect(screen.getByTestId('game-screen')).toBeTruthy();
    expect(useGameStore.getState().snapshot?.state.version).toBe(f.state.version);
  }
  return { actions, seen, f };
}

beforeEach(() => {
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('the game screen survives whole games', () => {
  it.each([
    ['Tanmay', 1],
    ['Guru', 1],
    ['Guru', 2],
  ])('two players, on %s’s phone, seed %i', async (phone, seed) => {
    const { actions, seen } = await playOn(phone, ['Tanmay', 'Guru'], seed, 160);
    expect(actions).toBeGreaterThan(50);
    expect(seen.has('AWAITING_DECISION:BUY')).toBe(true);
  }, 120_000);

  it('four players sharing squares, from the last seat', async () => {
    const { actions } = await playOn('Dev', ['Asha', 'Bilal', 'Chitra', 'Dev'], 7, 160);
    expect(actions).toBeGreaterThan(50);
  }, 120_000);

  it('the exact reported sequence: Tanmay rolls and finishes, then Guru rolls — for every dice total', async () => {
    for (let a = 1; a <= 6; a += 1) {
      for (let b = 1; b <= 6; b += 1) {
        useGameStore.getState().reset(null);
        const f = new Fixture(['Tanmay', 'Guru']).loadAs('Guru');
        const view = await render(<Phone />);
        const apply = () =>
          act(async () => {
            useGameStore.getState().applySnapshot(f.snapshot());
          });
        f.roll('Tanmay', 1, 2);
        await apply();
        // Tanmay resolves whatever he landed on and passes the dice.
        for (let i = 0; i < 6 && f.state.turn.playerId === f.ids.Tanmay; i += 1) {
          const move = nextMove(f, () => 0);
          if (!move || move === 'roll') break;
          f.act(move.who, move.action);
          await apply();
        }
        expect(f.state.turn.playerId).toBe(f.ids.Guru);
        f.roll('Guru', a, b);
        await apply();
        expect(screen.getByTestId('game-screen')).toBeTruthy();
        expect(screen.getByTestId(`board-token-${f.ids.Guru}`)).toBeTruthy();
        await view.unmount();
      }
    }
  }, 120_000);
});
