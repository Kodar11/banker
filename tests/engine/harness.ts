import {
  applyAction,
  BOARD_SIZE,
  createGame,
  joinGame,
  ledgerViolations,
  playerViolations,
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
  private queuedRandoms: number[] = [];

  /**
   * START_GAME draws the turn order at random. Unless a test asks for the raw draw
   * (`start: false`, then `queueRandom` + START_GAME), the harness pins it to the
   * joining order so every other test can script turns by name.
   */
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
    if (start) {
      this.queueRandom(...keepOrder(names.length));
      this.act(host, { type: 'START_GAME' });
    }
  }

  ctx(actionId: string = testId()): EngineContext {
    return {
      actionId,
      now: new Date(this.nowMs).toISOString(),
      random: () => {
        const raw = this.queuedRandoms.shift();
        if (raw !== undefined) return raw;
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

  /** Host starts a `start: false` game with the turn-order draw coming out as `order` (names, first to roll first). */
  startWith(order: string[]): EngineResult {
    const names = Object.keys(this.ids);
    this.queueRandom(...orderRandoms(names, order));
    return this.act(names[0]!, { type: 'START_GAME' });
  }

  /** Raw RNG values in [0, 1), consumed before any queued dice. */
  queueRandom(...values: number[]): void {
    this.queuedRandoms.push(...values);
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

  /** A new player joins the lobby. */
  join(name: string): EngineResult {
    const id = testId();
    const result = joinGame(this.state, { playerId: id, name }, this.ctx());
    this.ids[name] = id;
    return this.absorb(result);
  }

  /** Absorb a result produced outside `act` (e.g. applyCardDefinition). */
  absorbResult(result: EngineResult): EngineResult {
    return this.absorb(result);
  }

  /** Roll a total (2–12) with some pair of faces. */
  rollTotal(name: string, total: number): EngineResult {
    const [a, b] = facesFor(total);
    return this.roll(name, a, b);
  }

  /** Put `name` `total` squares before `position` and roll exactly `total`. */
  landOn(name: string, position: number, total: number): EngineResult {
    this.placeAt(name, (position - total + BOARD_SIZE * 2) % BOARD_SIZE);
    return this.rollTotal(name, total);
  }

  /** Roll with fixed dice faces. */
  roll(name: string, a: number, b: number): EngineResult {
    this.queueDice(a, b);
    return this.act(name, { type: 'ROLL_DICE' });
  }

  /** Teleport a player so their next roll of `a + b` lands on `key` (test setup only). */
  placeBefore(name: string, key: PropertyKey, total: number): void {
    const target = positionOfProperty(key);
    this.player(name).position = (target - total + BOARD_SIZE * 2) % BOARD_SIZE;
  }

  /** Teleport a player to a board index (test setup only — no Start reward). */
  placeAt(name: string, position: number): void {
    this.player(name).position = position;
  }

  /** Test-only state surgery that bypasses the ledger (use for ownership setup only). */
  give(name: string, key: PropertyKey, patch: Partial<GameState['properties'][PropertyKey]> = {}): void {
    this.state.properties[key] = { ...this.state.properties[key], ownerId: this.id(name), ...patch };
  }

  assertInvariants(): void {
    const money = ledgerViolations(this.state, this.ledger);
    const props = propertyViolations(this.state);
    const players = playerViolations(this.state);
    if (money.length || props.length || players.length) {
      throw new Error(`Invariant violated:\n${[...money, ...props, ...players].join('\n')}`);
    }
  }
}

/** RNG values that make START_GAME's shuffle of `players` players keep the joining order. */
export function keepOrder(players: number): number[] {
  return Array.from({ length: Math.max(0, players - 1) }, () => 0.999);
}

/** RNG values that make START_GAME's shuffle turn the joining order `names` into `order` (the engine's Fisher–Yates, replayed). */
export function orderRandoms(names: string[], order: string[]): number[] {
  const pool = [...names];
  const out: number[] = [];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = pool.indexOf(order[i]!);
    out.push((j + 0.5) / (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return out;
}

/** Dice faces that sum to `total` (2–12). */
export function facesFor(total: number): [number, number] {
  const a = Math.min(6, total - 1);
  return [a, total - a];
}
