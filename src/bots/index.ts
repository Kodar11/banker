/**
 * Bots — the decision engine for seats the game plays by itself. Pure TypeScript with no dependency
 * but the game engine: the same code runs on the device (local solo games), on the server (Supabase Edge
 * Functions, where scripts/sync-engine.mjs copies it next to the engine) and in the simulations.
 *
 * The engine decides what is legal; a bot only decides which legal action it prefers. See docs/bots.
 */
export * from './types.ts';
export * from './config.ts';
export * from './dice.ts';
export * from './random.ts';
export * from './observation.ts';
export * from './movement.ts';
export * from './horizon.ts';
export * from './valuation.ts';
export * from './engineAccess.ts';
export * from './scoring.ts';
export * from './finance.ts';
export * from './auction.ts';
export * from './trading.ts';
export * from './policy.ts';
export * from './runner.ts';
