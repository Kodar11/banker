// Database mapping for the game-action Edge Function.
// Runtime-agnostic (Deno in production, Node in integration tests).
import postgres from 'postgres';
import {
  BUSINESS_MVP_RULES,
  PROPERTY_KEYS,
  type AuctionState,
  type EngineResult,
  type GameEventRecord,
  type GameSnapshot,
  type GameState,
  type LoanState,
  type PlayerState,
  type PropertyKey,
  type PropertyState,
  type TradeOffer,
  type TransactionRecord,
} from '../_shared/engine/index.ts';

// deno-lint-ignore no-explicit-any
export type Sql = postgres.Sql<any>;
// deno-lint-ignore no-explicit-any
export type Tx = postgres.TransactionSql<any>;
type Row = Record<string, unknown>;

export function createSql(url: string, max = 3): Sql {
  return postgres(url, {
    max,
    prepare: false, // required behind Supabase's transaction pooler
    idle_timeout: 20,
    types: {
      // bigint (int8) → JS number. All money values are far below 2^53.
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function mapPlayer(r: Row): PlayerState {
  return {
    id: r.id as string,
    name: r.name as string,
    seat: r.seat as number,
    isHost: r.is_host as boolean,
    ready: r.ready as boolean,
    balance: Number(r.balance),
    position: r.position as number,
    status: r.status as PlayerState['status'],
    skipTurns: r.skip_turns as number,
    inJail: r.in_jail as boolean,
    jailTurnsLeft: Number(r.jail_turns_left ?? 0),
    circuits: Number(r.circuits ?? 0),
  };
}

function mapLoan(r: Row): LoanState {
  return {
    id: r.id as string,
    playerId: r.player_id as string,
    principal: Number(r.principal),
    interestRatePercent: Number(r.interest_rate_percent),
    interestAmount: Number(r.interest_amount),
    totalOwed: Number(r.total_owed),
    outstanding: Number(r.outstanding),
    status: r.status as LoanState['status'],
    createdAtCircuit: Number(r.created_at_circuit),
    interestCharges: Number(r.interest_charges),
    interestPaid: Number(r.interest_paid),
    createdAt: iso(r.created_at),
    closedAt: isoOrNull(r.closed_at),
  };
}

function mapAuction(r: Row): AuctionState {
  return {
    id: r.id as string,
    propertyKey: r.property_key as PropertyKey,
    status: r.status as AuctionState['status'],
    highBid: r.high_bid === null ? null : Number(r.high_bid),
    highBidderId: (r.high_bidder_id as string | null) ?? null,
    minimumOpeningBid: Number(r.minimum_opening_bid),
    minimumIncrement: Number(r.minimum_increment),
    endsAt: iso(r.ends_at),
    participantIds: (r.participant_ids as string[]) ?? [],
    passedIds: (r.passed_ids as string[]) ?? [],
    winnerId: (r.winner_player_id as string | null) ?? null,
    createdAt: iso(r.created_at),
    closedAt: isoOrNull(r.closed_at),
  };
}

function mapTrade(r: Row): TradeOffer {
  return {
    id: r.id as string,
    fromPlayerId: r.from_player_id as string,
    toPlayerId: r.to_player_id as string,
    offeredPropertyKeys: (r.offered_property_keys as PropertyKey[]) ?? [],
    requestedPropertyKeys: (r.requested_property_keys as PropertyKey[]) ?? [],
    offeredMoney: Number(r.offered_money),
    requestedMoney: Number(r.requested_money),
    status: r.status as TradeOffer['status'],
    createdAt: iso(r.created_at),
    resolvedAt: isoOrNull(r.resolved_at),
  };
}

/** Same bound the engine keeps in state (reducer.ts KEEP_RESOLVED_TRADES). */
const RESOLVED_TRADES_LOADED = 20;

function mapTransaction(r: Row): TransactionRecord {
  return {
    id: r.id as string,
    actionId: r.action_id as string,
    type: r.type as TransactionRecord['type'],
    fromPlayerId: (r.from_player_id as string | null) ?? null,
    toPlayerId: (r.to_player_id as string | null) ?? null,
    amount: Number(r.amount),
    propertyKey: (r.property_key as PropertyKey | null) ?? null,
    memo: r.memo as string,
    reversesTransactionId: (r.reverses_transaction_id as string | null) ?? null,
    createdAt: iso(r.created_at),
  };
}

function mapEvent(r: Row): GameEventRecord {
  return {
    id: r.id as string,
    type: r.type as string,
    actorId: (r.actor_player_id as string | null) ?? null,
    message: r.message as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: iso(r.created_at),
  };
}

/** Locks the game row for the rest of the transaction. */
export async function lockGame(tx: Tx, gameId: string): Promise<Row | undefined> {
  const [game] = await tx`select * from public.games where id = ${gameId} for update`;
  return game;
}

/** Assembles the authoritative engine state from the normalized tables. */
export async function loadState(tx: Tx, game: Row): Promise<GameState> {
  const id = game.id as string;
  const [players, props, loans, auctions, pendingTrades, resolvedTrades] = await Promise.all([
    tx`select * from public.players where game_id = ${id} order by seat`,
    tx`select * from public.properties where game_id = ${id}`,
    tx`select * from public.loans where game_id = ${id} order by created_at, id`,
    game.current_auction_id ? tx`select * from public.auctions where id = ${game.current_auction_id as string}` : Promise.resolve([]),
    tx`select * from public.trade_offers where game_id = ${id} and status = 'PENDING' order by created_at, id`,
    tx`select * from public.trade_offers where game_id = ${id} and status <> 'PENDING'
       order by resolved_at desc, id limit ${RESOLVED_TRADES_LOADED}`,
  ]);
  const trades = [...resolvedTrades.reverse(), ...pendingTrades].map(mapTrade);
  const properties = Object.fromEntries(
    PROPERTY_KEYS.map((key): [PropertyKey, PropertyState] => [key, { key, ownerId: null, houses: 0, hotel: false, mortgaged: false }]),
  ) as Record<PropertyKey, PropertyState>;
  for (const r of props) {
    const key = r.property_key as PropertyKey;
    properties[key] = {
      key,
      ownerId: (r.owner_player_id as string | null) ?? null,
      houses: Number(r.houses),
      hotel: r.hotel as boolean,
      mortgaged: r.mortgaged as boolean,
    };
  }
  const auctionRow = auctions[0];
  return {
    id,
    code: game.code as string,
    rulesVersion: game.rules_version as string,
    status: game.status as GameState['status'],
    pausedFrom: (game.paused_from as GameState['pausedFrom']) ?? null,
    pausedAt: isoOrNull(game.paused_at),
    version: game.state_version as number,
    hostPlayerId: (game.host_player_id as string | null) ?? null,
    winnerId: (game.winner_player_id as string | null) ?? null,
    players: players.map(mapPlayer),
    properties,
    loans: loans.map(mapLoan),
    auction: auctionRow ? mapAuction(auctionRow) : null,
    turn: game.turn as GameState['turn'],
    undoStack: (game.undo_stack as GameState['undoStack']) ?? [],
    undoRequest: (game.undo_request as GameState['undoRequest']) ?? null,
    trades,
    createdAt: iso(game.created_at),
    expiresAt: iso(game.expires_at),
  };
}

export async function loadSnapshot(tx: Tx, game: Row): Promise<GameSnapshot> {
  const id = game.id as string;
  const [state, events, transactions] = await Promise.all([
    loadState(tx, game),
    tx`select * from public.game_events where game_id = ${id} order by seq desc limit 60`,
    tx`select * from public.transactions where game_id = ${id} order by seq desc limit 400`,
  ]);
  return { state, events: events.map(mapEvent), transactions: transactions.map(mapTransaction), serverTime: new Date().toISOString() };
}

/** Inserts the rows for a brand-new game (after engine.createGame). */
export async function insertNewGame(tx: Tx, result: EngineResult, hostTokenHash: string): Promise<void> {
  const s = result.state;
  const host = s.players[0];
  if (!host) throw new Error('createGame produced no host');
  await tx`
    insert into public.games (id, code, rules_version, status, state_version, host_player_id, current_player_id,
      turn_phase, turn_number, turn, assumptions_version, created_at, expires_at)
    values (${s.id}, ${s.code}, ${s.rulesVersion}, ${s.status}, ${s.version}, ${host.id}, null,
      ${s.turn.phase}, ${s.turn.number}, ${tx.json(s.turn as unknown as postgres.JSONValue)},
      ${BUSINESS_MVP_RULES.rulesetVersion}, ${s.createdAt}, ${s.expiresAt})`;
  await insertPlayer(tx, s.id, host, hostTokenHash);
  const rows = PROPERTY_KEYS.map((key) => ({ game_id: s.id, rules_version: s.rulesVersion, property_key: key }));
  await tx`insert into public.properties ${tx(rows, 'game_id', 'rules_version', 'property_key')}`;
  await insertLedger(tx, s.id, result);
}

export async function insertPlayer(tx: Tx, gameId: string, p: PlayerState, tokenHash: string): Promise<void> {
  await tx`
    insert into public.players (id, game_id, name, seat, is_host, ready, balance, position, status, skip_turns, in_jail,
      jail_turns_left, circuits, token_hash)
    values (${p.id}, ${gameId}, ${p.name}, ${p.seat}, ${p.isHost}, ${p.ready}, ${p.balance}, ${p.position},
      ${p.status}, ${p.skipTurns}, ${p.inJail}, ${p.jailTurnsLeft}, ${p.circuits}, ${tokenHash})`;
}

async function insertLedger(tx: Tx, gameId: string, result: EngineResult): Promise<void> {
  const version = result.state.version;
  if (result.bids.length) {
    const rows = result.bids.map((b) => ({
      id: b.id,
      auction_id: b.auctionId,
      game_id: gameId,
      player_id: b.playerId,
      amount: b.amount,
      action_id: b.actionId,
      created_at: b.createdAt,
    }));
    await tx`insert into public.auction_bids ${tx(rows)}`;
  }
  // Insert one at a time to preserve order (seq) and self-references (reversals).
  for (const t of result.transactions) {
    await tx`
      insert into public.transactions (id, game_id, action_id, type, from_player_id, to_player_id, amount, property_key,
        memo, reverses_transaction_id, created_at)
      values (${t.id}, ${gameId}, ${t.actionId}, ${t.type}, ${t.fromPlayerId}, ${t.toPlayerId}, ${t.amount},
        ${t.propertyKey}, ${t.memo}, ${t.reversesTransactionId}, ${t.createdAt})`;
  }
  for (const e of result.events) {
    await tx`
      insert into public.game_events (id, game_id, state_version, type, actor_player_id, message, payload, created_at)
      values (${e.id}, ${gameId}, ${version}, ${e.type}, ${e.actorId}, ${e.message},
        ${tx.json(e.payload as postgres.JSONValue)}, ${e.createdAt})`;
  }
}

/**
 * Writes the engine result back. Runs inside the caller's transaction, after the
 * game row was locked. The `state_version = prevVersion` guard makes a lost
 * update impossible even if the lock were bypassed.
 */
export async function persistResult(tx: Tx, prevVersion: number, result: EngineResult): Promise<void> {
  const s = result.state;
  const json = (v: unknown) => (v === null || v === undefined ? null : tx.json(v as postgres.JSONValue));

  if (s.auction) {
    const a = s.auction;
    await tx`
      insert into public.auctions (id, game_id, property_key, status, high_bid, high_bidder_id, minimum_opening_bid,
        minimum_increment, ends_at, participant_ids, passed_ids, winner_player_id, created_at, closed_at)
      values (${a.id}, ${s.id}, ${a.propertyKey}, ${a.status}, ${a.highBid}, ${a.highBidderId}, ${a.minimumOpeningBid},
        ${a.minimumIncrement}, ${a.endsAt}, ${a.participantIds}::uuid[], ${a.passedIds}::uuid[], ${a.winnerId},
        ${a.createdAt}, ${a.closedAt})
      on conflict (id) do update set
        status = excluded.status, high_bid = excluded.high_bid, high_bidder_id = excluded.high_bidder_id,
        ends_at = excluded.ends_at, passed_ids = excluded.passed_ids, winner_player_id = excluded.winner_player_id,
        closed_at = excluded.closed_at`;
  }

  const updated = await tx`
    update public.games set
      status = ${s.status},
      state_version = ${s.version},
      host_player_id = ${s.hostPlayerId},
      winner_player_id = ${s.winnerId},
      current_player_id = ${s.turn.playerId},
      turn_phase = ${s.turn.phase},
      turn_number = ${s.turn.number},
      turn = ${json(s.turn)},
      paused_from = ${s.pausedFrom},
      paused_at = ${s.pausedAt},
      undo_stack = ${tx.json(s.undoStack as unknown as postgres.JSONValue)},
      undo_request = ${json(s.undoRequest)},
      current_auction_id = ${s.auction?.id ?? null},
      expires_at = ${s.expiresAt},
      updated_at = now()
    where id = ${s.id} and state_version = ${prevVersion}`;
  if (updated.count !== 1) throw new Error('STALE_WRITE');

  // START_GAME draws the turn order (seats), in this same transaction as status/turn. unique (game_id, seat)
  // is checked row by row, so the old seats are moved out of the way before the drawn ones are written.
  if (result.events.some((e) => e.type === 'GAME_STARTED')) {
    const seatRows = s.players.map((p) => ({ id: p.id, seat: p.seat }));
    await tx`update public.players set seat = seat + 1000 where game_id = ${s.id}`;
    await tx`
      update public.players p set seat = x.seat
      from jsonb_to_recordset(${json(seatRows)}) as x(id uuid, seat int)
      where p.id = x.id and p.game_id = ${s.id}`;
  }

  // LEAVE_GAME can hand the host role on. players_one_host_idx allows one host per game and is checked
  // row by row, so the old host is cleared before the new one is written below.
  if (result.events.some((e) => e.type === 'HOST_CHANGED')) {
    await tx`update public.players set is_host = false where game_id = ${s.id} and is_host and id <> ${s.hostPlayerId}`;
  }

  const playerRows = s.players.map((p) => ({
    id: p.id,
    is_host: p.isHost,
    ready: p.ready,
    balance: p.balance,
    position: p.position,
    status: p.status,
    skip_turns: p.skipTurns,
    in_jail: p.inJail,
    jail_turns_left: p.jailTurnsLeft,
    circuits: p.circuits,
  }));
  await tx`
    update public.players p set
      is_host = x.is_host, ready = x.ready, balance = x.balance, position = x.position, status = x.status,
      skip_turns = x.skip_turns, in_jail = x.in_jail, jail_turns_left = x.jail_turns_left, circuits = x.circuits
    from jsonb_to_recordset(${json(playerRows)}) as x(
      id uuid, is_host boolean, ready boolean, balance bigint, position int, status text, skip_turns int, in_jail boolean,
      jail_turns_left int, circuits int)
    where p.id = x.id and p.game_id = ${s.id}`;

  const propRows = PROPERTY_KEYS.map((k) => {
    const p = s.properties[k];
    return { property_key: k, owner_player_id: p.ownerId, houses: p.houses, hotel: p.hotel, mortgaged: p.mortgaged };
  });
  await tx`
    update public.properties p set
      owner_player_id = x.owner_player_id, houses = x.houses, hotel = x.hotel, mortgaged = x.mortgaged
    from jsonb_to_recordset(${json(propRows)}) as x(
      property_key text, owner_player_id uuid, houses smallint, hotel boolean, mortgaged boolean)
    where p.game_id = ${s.id} and p.property_key = x.property_key
      and (p.owner_player_id is distinct from x.owner_player_id or p.houses <> x.houses
           or p.hotel <> x.hotel or p.mortgaged <> x.mortgaged)`;

  for (const l of s.loans) {
    await tx`
      insert into public.loans (id, game_id, player_id, principal, interest_rate_percent, interest_amount, total_owed,
        outstanding, status, created_at_circuit, interest_charges, interest_paid, created_at, closed_at)
      values (${l.id}, ${s.id}, ${l.playerId}, ${l.principal}, ${l.interestRatePercent}, ${l.interestAmount}, ${l.totalOwed},
        ${l.outstanding}, ${l.status}, ${l.createdAtCircuit}, ${l.interestCharges}, ${l.interestPaid}, ${l.createdAt}, ${l.closedAt})
      on conflict (id) do update set outstanding = excluded.outstanding, status = excluded.status,
        closed_at = excluded.closed_at, interest_charges = excluded.interest_charges, interest_paid = excluded.interest_paid
      where public.loans.outstanding is distinct from excluded.outstanding
         or public.loans.status is distinct from excluded.status
         or public.loans.interest_charges is distinct from excluded.interest_charges
         or public.loans.interest_paid is distinct from excluded.interest_paid`;
  }

  for (const t of s.trades) {
    await tx`
      insert into public.trade_offers (id, game_id, from_player_id, to_player_id, offered_property_keys,
        requested_property_keys, offered_money, requested_money, status, created_at, resolved_at)
      values (${t.id}, ${s.id}, ${t.fromPlayerId}, ${t.toPlayerId}, ${t.offeredPropertyKeys}::text[],
        ${t.requestedPropertyKeys}::text[], ${t.offeredMoney}, ${t.requestedMoney}, ${t.status}, ${t.createdAt}, ${t.resolvedAt})
      on conflict (id) do update set status = excluded.status, resolved_at = excluded.resolved_at
      where public.trade_offers.status is distinct from excluded.status`;
  }

  await insertLedger(tx, s.id, result);
}
