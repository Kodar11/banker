import type { PropertyKey } from './businessBoard.ts';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { canTransition, canTransitionStatus } from './stateMachine.ts';
import type {
  BidRecord,
  EngineContext,
  EngineResult,
  GameEventRecord,
  GameState,
  GameStatus,
  PlayerState,
  TransactionRecord,
  TransactionType,
  TurnPhase,
} from './types.ts';

export interface TransferInput {
  type: TransactionType;
  /** null = bank */
  from: string | null;
  /** null = bank */
  to: string | null;
  amount: number;
  propertyKey?: PropertyKey | null;
  memo: string;
  reversesTransactionId?: string | null;
}

/**
 * Mutable working copy of the game state for one action.
 * `transfer` is the ONLY way balances change, and it always appends a transaction.
 */
export class Draft {
  readonly state: GameState;
  readonly ctx: EngineContext;
  readonly transactions: TransactionRecord[] = [];
  readonly events: GameEventRecord[] = [];
  readonly bids: BidRecord[] = [];
  readonly transitions: { from: TurnPhase; to: TurnPhase }[] = [];

  constructor(state: GameState, ctx: EngineContext) {
    this.state = structuredClone(state);
    this.ctx = ctx;
  }

  player(id: string): PlayerState {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) fail('NOT_FOUND', 'That player is not in this game.');
    return p;
  }

  name(id: string | null): string {
    if (id === null) return 'Bank';
    return this.state.players.find((x) => x.id === id)?.name ?? 'Unknown';
  }

  activePlayers(): PlayerState[] {
    return this.state.players.filter((p) => p.status === 'ACTIVE');
  }

  transfer(input: TransferInput): TransactionRecord {
    const { amount } = input;
    if (!Number.isInteger(amount) || amount <= 0) {
      fail('VALIDATION', 'Amount must be a positive whole number of rupees.');
    }
    if (input.from !== null && input.from === input.to) {
      fail('VALIDATION', 'Cannot pay yourself.');
    }
    if (input.from !== null) {
      const payer = this.player(input.from);
      if (payer.balance < amount) {
        fail('INSUFFICIENT_FUNDS', `${payer.name} doesn't have enough money (needs ${formatINR(amount)}).`);
      }
      payer.balance -= amount;
    }
    if (input.to !== null) {
      this.player(input.to).balance += amount;
    }
    const tx: TransactionRecord = {
      id: this.ctx.newId(),
      actionId: this.ctx.actionId,
      type: input.type,
      fromPlayerId: input.from,
      toPlayerId: input.to,
      amount,
      propertyKey: input.propertyKey ?? null,
      memo: input.memo,
      reversesTransactionId: input.reversesTransactionId ?? null,
      createdAt: this.ctx.now,
    };
    this.transactions.push(tx);
    return tx;
  }

  event(type: string, actorId: string | null, message: string, payload: Record<string, unknown> = {}): void {
    this.events.push({ id: this.ctx.newId(), type, actorId, message, payload, createdAt: this.ctx.now });
  }

  setPhase(to: TurnPhase): void {
    const from = this.state.turn.phase;
    if (from === to) return;
    if (!canTransition(from, to)) {
      fail('INVALID_PHASE', `Invalid transition ${from} → ${to}.`);
    }
    this.transitions.push({ from, to });
    this.state.turn.phase = to;
  }

  setStatus(to: GameStatus): void {
    const from = this.state.status;
    if (!canTransitionStatus(from, to)) {
      fail('INVALID_PHASE', `Invalid game transition ${from} → ${to}.`);
    }
    this.state.status = to;
  }

  result(): EngineResult {
    return {
      state: this.state,
      transactions: this.transactions,
      events: this.events,
      bids: this.bids,
      transitions: this.transitions,
    };
  }
}
