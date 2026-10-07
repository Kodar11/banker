import {
  applyAction,
  createGame,
  joinGame,
  type EngineContext,
  type GameAction,
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

  constructor(names = ['Asha', 'Bilal'], { start = true } = {}) {
    const [host, ...rest] = names;
    this.ids[host!] = id();
    this.state = this.absorb(createGame({ gameId: id(), code: '482915', hostPlayerId: this.ids[host!]!, hostName: host! }, this.ctx()));
    for (const name of rest) {
      this.ids[name] = id();
      this.state = this.absorb(joinGame(this.state, { playerId: this.ids[name]!, name }, this.ctx()));
    }
    if (start) this.act(host!, { type: 'START_GAME' });
  }

  ctx(): EngineContext {
    return {
      actionId: id(),
      now: new Date().toISOString(),
      random: () => {
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
