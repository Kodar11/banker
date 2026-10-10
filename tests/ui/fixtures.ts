import {
  applyAction,
  createGame,
  joinGame,
  type EngineContext,
  type GameAction,
  type GameMode,
  type GameSnapshot,
  type GameState,
  type TransactionRecord,
  type GameEventRecord,
} from '@/engine/index.ts';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';

let n = 0;
const id = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TOKEN = 'a'.repeat(64);

/** Builds real snapshots by running the actual engine with scripted dice. */
export class Fixture {
  state: GameState;
  ids: Record<string, string> = {};
  transactions: TransactionRecord[] = [];
  events: GameEventRecord[] = [];
  private faces: number[] = [];
  private randoms: number[] = [];

  constructor(names = ['Asha', 'Bilal'], { start = true, mode, config }: { start?: boolean; mode?: GameMode; config?: unknown } = {}) {
    const [host, ...rest] = names;
    this.ids[host!] = id();
    this.state = this.absorb(createGame({ gameId: id(), code: '482915', hostPlayerId: this.ids[host!]!, hostName: host!, mode, config }, this.ctx()));
    for (const name of rest) {
      this.ids[name] = id();
      this.state = this.absorb(joinGame(this.state, { playerId: this.ids[name]!, name }, this.ctx()));
    }
    if (start) this.start();
  }

  /**
   * Host starts the game. The engine draws the turn order at random; fixtures pin the
   * draw to `order` (default: joining order) so tests can script turns by name.
   */
  start(order: string[] = Object.keys(this.ids)): this {
    const pool = Object.keys(this.ids);
    // Replays the engine's Fisher–Yates backwards: pick, for each slot from the last, the RNG value that puts `order` there.
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = pool.indexOf(order[i]!);
      this.randoms.push((j + 0.5) / (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return this.act(Object.keys(this.ids)[0]!, { type: 'START_GAME' });
  }

  ctx(): EngineContext {
    return {
      actionId: id(),
      now: new Date().toISOString(),
      random: () => {
        const raw = this.randoms.shift();
        if (raw !== undefined) return raw;
        const f = this.faces.shift();
        return f === undefined ? 0.5 : (f - 1) / 6 + 0.01;
      },
      newId: id,
    };
  }

  private absorb(r: { state: GameState; transactions: TransactionRecord[]; events: GameEventRecord[] }) {
    this.transactions = [...r.transactions.slice().reverse(), ...this.transactions];
    this.events = [...r.events.slice().reverse(), ...this.events];
    return r.state;
  }

  act(name: string, action: GameAction): this {
    this.state = this.absorb(applyAction(this.state, this.ids[name]!, action, this.ctx()));
    return this;
  }

  roll(name: string, a: number, b: number): this {
    this.faces.push(a, b);
    return this.act(name, { type: 'ROLL_DICE' });
  }

  snapshot(): GameSnapshot {
    return { state: this.state, events: this.events, transactions: this.transactions, serverTime: new Date().toISOString() };
  }

  /** Puts this snapshot in the stores as seen from `name`'s phone. */
  loadAs(name: string): this {
    useSessionStore.setState({ session: { gameId: this.state.id, playerId: this.ids[name]!, token: TOKEN }, hydrated: true });
    useGameStore.getState().reset(this.state.id);
    useGameStore.getState().applySnapshot(this.snapshot());
    useGameStore.getState().setConnection('live');
    return this;
  }
}

export function ok(snapshot: GameSnapshot) {
  return { ok: true as const, gameId: snapshot.state.id, playerId: 'x', snapshot };
}
