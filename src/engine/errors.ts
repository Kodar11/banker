export type GameErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_YOUR_TURN'
  | 'INVALID_PHASE'
  | 'GAME_NOT_STARTED'
  | 'GAME_NOT_ACTIVE'
  | 'GAME_PAUSED'
  | 'GAME_FINISHED'
  | 'GAME_EXPIRED'
  | 'GAME_FULL'
  | 'LOBBY_LOCKED'
  | 'NAME_TAKEN'
  | 'NOT_ENOUGH_PLAYERS'
  | 'INSUFFICIENT_FUNDS'
  | 'ALREADY_OWNED'
  | 'NOT_OWNER'
  | 'INVALID_BID'
  | 'AUCTION_CLOSED'
  | 'BUILD_NOT_ALLOWED'
  | 'MORTGAGE_NOT_ALLOWED'
  | 'LOAN_NOT_ALLOWED'
  | 'INSURANCE_NOT_ALLOWED'
  | 'UNDO_NOT_ALLOWED'
  | 'TRADE_NOT_ALLOWED'
  | 'STALE_STATE';

export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export function fail(code: GameErrorCode, message: string): never {
  throw new GameError(code, message);
}

export function isGameError(error: unknown): error is GameError {
  return error instanceof GameError || (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'GameError');
}
