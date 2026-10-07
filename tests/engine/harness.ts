import {
  applyAction,
  createGame,
  joinGame,
  ledgerViolations,
  positionOfProperty,
  propertyViolations,
  type EngineContext,
  type EngineResult,
  type GameAction,
  type GameState,
  type PropertyKey,
  type TransactionRecord,
} from '@/engine/index.ts';

/** Random value that makes a d6 show `face`. */
export function faceToRandom(face: number): number {
  return (face - 1) / 6 + 0.01;
}

let idCounter = 0;
export function testId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Deterministic in-memory game for engine tests. Keeps the full append-only
 * ledger so the money invariant can be checked after every action.
 */
export class TestGame {
  state: GameState;
  ledger: TransactionRecord[] = [];
  results: EngineResult[] = [];
  ids: Record<string, string> = {};
  nowMs = Date.parse('2026-01-01T10:00:00.000Z');
  private queuedFaces: number[] = [];

  constructor(names: string[] = ['Asha', 'Bilal', 'Chitra'], { start = true } = {}) {
    const [host, ...others] = names;
    if (!host) throw new Error('need a host');
    this.ids[host] = testId();
    const created = createGame({ gameId: testId(), code: '123456', hostPlayerId: this.ids[host], hostName: host }, this.ctx());
    this.state = created.state;
    for (const name of others) {
      this.ids[name] = testId();
      this.absorb(joinGame(this.state, { playerId: this.ids[name], name }, this.ctx()));
    }
    if (start) this.act(host, { type: 'START_GAME' });
  }

  ctx(actionId: string = testId()): EngineContext {
    return {
      actionId,
      now: new Date(this.nowMs).toISOString(),
      random: () => {
        const face = this.queuedFaces.shift();
        return face === undefined ? 0.5 : faceToRandom(face);
      },
      newId: testId,
    };
  }

  id(name: string): string {
    const id = this.ids[name];
    if (!id) throw new Error(`no player ${name}`);
    return id;
  }

  player(name: string) {
    const p = this.state.players.find((x) => x.id === this.id(name));
    if (!p) throw new Error(`no player ${name}`);
    return p;
  }

  balance(name: string): number {
    return this.player(name).balance;
  }

  get current(): string {
    const p = this.state.players.find((x) => x.id === this.state.turn.playerId);
    if (!p) throw new Error('no current player');
    return p.name;
  }

  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  queueDice(...faces: number[]): void {
    this.queuedFaces.push(...faces);
  }

  private absorb(result: EngineResult): EngineResult {
    this.state = result.state;
    this.ledger.push(...result.transactions);
    this.results.push(result);
    this.assertInvariants();
    return result;
  }

  act(name: string, action: GameAction, actionId?: string): EngineResult {
    return this.absorb(applyAction(this.state, this.id(name), action, this.ctx(actionId)));
  }

  /** Roll with fixed dice faces. */
  roll(name: string, a: number, b: number): EngineResult {
    this.queueDice(a, b);
    return this.act(name, { type: 'ROLL_DICE' });
  }

  /** Teleport a player so their next roll of `a + b` lands on `key` (test setup only). */
  placeBefore(name: string, key: PropertyKey, total: number): void {
    const target = positionOfProperty(key);
    this.player(name).position = (target - total + 36 * 2) % 36;
  }

  /** Test-only state surgery that bypasses the ledger (use for ownership setup only). */
  give(name: string, key: PropertyKey, patch: Partial<GameState['properties'][PropertyKey]> = {}): void {
    this.state.properties[key] = { ...this.state.properties[key], ownerId: this.id(name), ...patch };
  }

  assertInvariants(): void {
    const money = ledgerViolations(this.state, this.ledger);
    const props = propertyViolations(this.state);
    if (money.length || props.length) throw new Error(`Invariant violated:\n${[...money, ...props].join('\n')}`);
  }
}
