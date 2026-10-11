import {
  BUSINESS_MVP_RULES as RULES,
  crisisOwed,
  economyOf,
  getDeed,
  isPledged,
  ledgerViolations,
  netWorth,
  playerViolations,
  PROPERTY_KEYS,
  propertyViolations,
  RESTING_PHASES,
  type EngineResult,
  type GameState,
  type TransactionRecord,
  type TransactionType,
} from '@/engine/index.ts';

/**
 * Invariants of the game engine, checked after every action of a test sequence (see
 * randomized.test.ts). Each function returns human-readable violations; an empty list means the
 * state is sound. Nothing here encodes a rule the engine does not have: where the game legitimately
 * creates or removes money, the source or sink is named below instead of assuming a fixed total.
 *
 * Deliberately NOT asserted, because the established rules allow it:
 *   - "even building" across a colour group (rules.building has no such rule);
 *   - buildings only where the whole group is owned (a trade or a resale moves a built property);
 *   - a LEFT player owning property and being paid rent (leaving freezes holdings, see leaveTable).
 */

type Flow = 'BANK_TO_PLAYER' | 'PLAYER_TO_BANK' | 'PLAYER_TO_PLAYER';

/**
 * Where money may come from and go to, per transaction type. The bank is the only source and the
 * only sink: STARTING_FUNDS, START_REWARD, CARD_REWARD, sales to the bank, MORTGAGE, loan
 * disbursements, COLLATERAL_SURPLUS and OBJECTIVE_REWARD create money; purchases, taxes, fines,
 * premiums, crisis bills, interest and repayments remove it. Everything else moves it between players.
 */
export const ALLOWED_FLOWS: Record<TransactionType, readonly Flow[]> = {
  STARTING_FUNDS: ['BANK_TO_PLAYER'],
  START_REWARD: ['BANK_TO_PLAYER'],
  CARD_REWARD: ['BANK_TO_PLAYER'],
  HOUSE_SALE: ['BANK_TO_PLAYER'],
  HOTEL_SALE: ['BANK_TO_PLAYER'],
  PROPERTY_SALE: ['BANK_TO_PLAYER'],
  MORTGAGE: ['BANK_TO_PLAYER'],
  LOAN_DISBURSEMENT: ['BANK_TO_PLAYER'],
  COLLATERAL_SURPLUS: ['BANK_TO_PLAYER'],
  OBJECTIVE_REWARD: ['BANK_TO_PLAYER'],
  PROPERTY_PURCHASE: ['PLAYER_TO_BANK'],
  TAX_PAYMENT: ['PLAYER_TO_BANK'],
  HOUSE_PURCHASE: ['PLAYER_TO_BANK'],
  HOTEL_PURCHASE: ['PLAYER_TO_BANK'],
  LOAN_REPAYMENT: ['PLAYER_TO_BANK'],
  LOAN_INTEREST: ['PLAYER_TO_BANK'],
  JAIL_FINE: ['PLAYER_TO_BANK'],
  UNMORTGAGE: ['PLAYER_TO_BANK'],
  INSURANCE_PREMIUM: ['PLAYER_TO_BANK'],
  CRISIS_PAYMENT: ['PLAYER_TO_BANK'],
  RENT_PAYMENT: ['PLAYER_TO_PLAYER'],
  PLAYER_TRANSFER: ['PLAYER_TO_PLAYER'],
  CARD_COLLECTION: ['PLAYER_TO_PLAYER'],
  CLUB_PAYMENT: ['PLAYER_TO_PLAYER'],
  REST_HOUSE_COLLECTION: ['PLAYER_TO_PLAYER'],
  TRADE_PAYMENT: ['PLAYER_TO_PLAYER'],
  // The bank's auction of an unowned property, or a player's resale.
  AUCTION_PAYMENT: ['PLAYER_TO_BANK', 'PLAYER_TO_PLAYER'],
  // "Pay the bank" cards and "pay each player" cards.
  CARD_PAYMENT: ['PLAYER_TO_BANK', 'PLAYER_TO_PLAYER'],
  // The bankrupt player's cash goes to the creditor: a player, or the bank.
  BANKRUPTCY_SETTLEMENT: ['PLAYER_TO_BANK', 'PLAYER_TO_PLAYER'],
  // A compensating entry mirrors whatever it reverses.
  UNDO_REVERSAL: ['BANK_TO_PLAYER', 'PLAYER_TO_BANK', 'PLAYER_TO_PLAYER'],
};

function flowOf(tx: TransactionRecord): Flow | null {
  if (tx.fromPlayerId === null && tx.toPlayerId !== null) return 'BANK_TO_PLAYER';
  if (tx.fromPlayerId !== null && tx.toPlayerId === null) return 'PLAYER_TO_BANK';
  if (tx.fromPlayerId !== null && tx.toPlayerId !== null) return 'PLAYER_TO_PLAYER';
  return null;
}

/** The whole append-only ledger: shape of every entry, direction per type, and the compensating-entry model of undo. */
export function ledgerEntryViolations(state: Pick<GameState, 'players'>, ledger: readonly TransactionRecord[]): string[] {
  const problems: string[] = [];
  const players = new Set(state.players.map((p) => p.id));
  const byId = new Map<string, TransactionRecord>();
  const reversed = new Set<string>();
  for (const tx of ledger) {
    if (byId.has(tx.id)) problems.push(`transaction ${tx.id} appears twice in the ledger`);
    const flow = flowOf(tx);
    if (!flow) problems.push(`${tx.type} ${tx.id}: bank to bank`);
    else if (!(ALLOWED_FLOWS[tx.type] ?? []).includes(flow)) problems.push(`${tx.type} ${tx.id}: unexpected direction ${flow}`);
    if (tx.fromPlayerId !== null && tx.fromPlayerId === tx.toPlayerId) problems.push(`${tx.type} ${tx.id}: a player paid themselves`);
    for (const id of [tx.fromPlayerId, tx.toPlayerId]) if (id !== null && !players.has(id)) problems.push(`${tx.type} ${tx.id}: unknown player ${id}`);
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) problems.push(`${tx.type} ${tx.id}: invalid amount ${tx.amount}`);
    if (tx.type === 'UNDO_REVERSAL') {
      const original = tx.reversesTransactionId ? byId.get(tx.reversesTransactionId) : undefined;
      if (!original) problems.push(`UNDO_REVERSAL ${tx.id}: reverses nothing that came before it`);
      else {
        if (original.type === 'UNDO_REVERSAL') problems.push(`UNDO_REVERSAL ${tx.id}: reverses a reversal`);
        if (original.amount !== tx.amount || original.fromPlayerId !== tx.toPlayerId || original.toPlayerId !== tx.fromPlayerId) {
          problems.push(`UNDO_REVERSAL ${tx.id}: is not the mirror image of ${original.type} ${original.id}`);
        }
        if (reversed.has(original.id)) problems.push(`${original.type} ${original.id}: reversed twice`);
        reversed.add(original.id);
      }
    } else if (tx.reversesTransactionId !== null) {
      problems.push(`${tx.type} ${tx.id}: only a reversal may name a reversed transaction`);
    }
    byId.set(tx.id, tx);
  }
  // Sources and sinks, stated on their own: all the money in play is what the bank paid out less what it took in.
  let created = 0;
  let removed = 0;
  for (const tx of ledger) {
    if (tx.fromPlayerId === null) created += tx.amount;
    if (tx.toPlayerId === null) removed += tx.amount;
  }
  const inPlay = state.players.reduce((sum, p) => sum + p.balance, 0);
  if (inPlay !== created - removed) problems.push(`money in play is ${inPlay}, but the bank paid out ${created} and took in ${removed}`);
  return problems;
}

/** Who owns what, and what may stand on it. */
export function ownershipViolations(state: GameState): string[] {
  const problems: string[] = [];
  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const key of PROPERTY_KEYS) {
    const prop = state.properties[key];
    if (!prop) continue;
    if (prop.key !== key) problems.push(`${key}: stored under the wrong key (${prop.key})`);
    const owner = prop.ownerId === null ? null : byId.get(prop.ownerId);
    if (owner && owner.status === 'BANKRUPT') problems.push(`${key}: owned by ${owner.name}, who is bankrupt`);
    const deed = getDeed(key);
    if (deed.kind !== 'CITY' && (prop.houses > 0 || prop.hotel)) problems.push(`${key}: buildings on a site that cannot be built on`);
    if (prop.houses > RULES.building.maxHouses) problems.push(`${key}: ${prop.houses} houses`);
    if (prop.ownerId === null && isPledged(state, key)) problems.push(`${key}: the bank's, but pledged as collateral`);
  }
  return problems;
}

/** Turn, phase and pending work agree with each other and with the players. */
export function turnViolations(state: GameState): string[] {
  const problems: string[] = [];
  const turn = state.turn;
  const active = state.players.filter((p) => p.status === 'ACTIVE');
  const seats = state.players.map((p) => p.seat);
  if (new Set(seats).size !== seats.length) problems.push('two players share a seat');
  if (new Set(state.players.map((p) => p.id)).size !== state.players.length) problems.push('a player appears twice');
  const hosts = state.players.filter((p) => p.isHost);
  if (hosts.length > 1) problems.push('more than one host');
  if (state.hostPlayerId === null ? hosts.length !== 0 : hosts.length !== 1 || hosts[0]!.id !== state.hostPlayerId) problems.push('hostPlayerId and the host flag disagree');
  // A bankrupt host keeps the role (they may still end the game, or leave and hand it on); a host who LEFT never does.
  if (state.hostPlayerId !== null && state.status !== 'FINISHED' && active.length > 0 && hosts[0] && hosts[0].status === 'LEFT') problems.push('the host has left the table');
  for (const p of state.players) {
    if (p.status === 'BANKRUPT' && p.balance !== 0) problems.push(`${p.name}: bankrupt with ${p.balance} in cash`);
    if (p.position < 0 || !Number.isInteger(p.position)) problems.push(`${p.name}: invalid position ${p.position}`);
    if (p.circuits < 0) problems.push(`${p.name}: negative circuits`);
  }
  if (state.status === 'WAITING') return problems;
  if (!RESTING_PHASES.has(turn.phase)) problems.push(`the turn rests in the transient phase ${turn.phase}`);
  if (state.status === 'ACTIVE' || state.status === 'PAUSED') {
    if (active.length < RULES.players.min) problems.push(`the game runs with ${active.length} active player(s)`);
    const current = state.players.find((p) => p.id === turn.playerId);
    if (!current) problems.push('nobody has the turn');
    // The one exception: the turn's owner left while the others are still bidding (leaveTable); closing passes it on.
    else if (current.status !== 'ACTIVE' && !(turn.phase === 'AUCTION' && state.auction?.status === 'OPEN' && current.status === 'LEFT')) {
      problems.push(`${current.name} has the turn but is ${current.status}`);
    }
    const pending = turn.pending;
    const resumesPayment = turn.phase === 'AUCTION' && state.auction?.resale?.resumePhase === 'AWAITING_PAYMENT';
    if (turn.phase === 'AWAITING_DECISION' && pending?.kind !== 'BUY') problems.push('AWAITING_DECISION without a property to decide on');
    if (turn.phase === 'AWAITING_PAYMENT' && pending?.kind !== 'PAYMENT') problems.push('AWAITING_PAYMENT without a payment');
    if (turn.phase === 'AWAITING_CARD' && pending?.kind !== 'CARD_MANUAL') problems.push('AWAITING_CARD without a card');
    if (pending && !['AWAITING_DECISION', 'AWAITING_PAYMENT', 'AWAITING_CARD'].includes(turn.phase) && !(resumesPayment && pending.kind === 'PAYMENT')) {
      problems.push(`${turn.phase} with a pending ${pending.kind}`);
    }
    if (turn.followUp && turn.phase !== 'AWAITING_PAYMENT' && !resumesPayment) problems.push(`${turn.phase} with a follow-up waiting`);
    if (pending?.kind === 'BUY' && state.properties[pending.propertyKey]?.ownerId !== null) problems.push('the property offered for sale already has an owner');
    if (pending?.kind === 'PAYMENT') {
      if (!Number.isInteger(pending.amount) || pending.amount <= 0) problems.push(`a pending payment of ${pending.amount}`);
      if (pending.toPlayerId !== null && !state.players.some((p) => p.id === pending.toPlayerId)) problems.push('a payment owed to nobody');
      if (pending.toPlayerId !== null && pending.toPlayerId === turn.playerId) problems.push('a payment owed to the payer');
      for (const id of pending.payeeIds ?? []) {
        if (id === turn.playerId) problems.push('the payer is among the payees');
        if (state.players.find((p) => p.id === id)?.status === 'BANKRUPT') problems.push('a share of the payment is owed to a bankrupt player');
      }
      if (pending.payeeIds?.length && pending.amount % pending.payeeIds.length !== 0) problems.push('a shared payment that does not divide among its payees');
    }
    if (turn.phase === 'AUCTION' && state.auction?.status !== 'OPEN') problems.push('AUCTION phase without an open auction');
    if (state.auction?.status === 'OPEN' && turn.phase !== 'AUCTION') problems.push(`an open auction during ${turn.phase}`);
  }
  if (state.status === 'PAUSED' ? state.pausedAt === null : state.pausedAt !== null) problems.push('pausedAt disagrees with the status');
  return problems;
}

/** The game's one auction. */
export function auctionViolations(state: GameState): string[] {
  const a = state.auction;
  if (!a) return [];
  const problems: string[] = [];
  const ids = new Set(state.players.map((p) => p.id));
  if ((a.highBid === null) !== (a.highBidderId === null)) problems.push('high bid and high bidder disagree');
  if (a.highBid !== null && a.highBid < a.minimumOpeningBid) problems.push(`high bid ${a.highBid} is below the opening bid ${a.minimumOpeningBid}`);
  if (new Set(a.participantIds).size !== a.participantIds.length) problems.push('a bidder is listed twice');
  for (const id of a.participantIds) if (!ids.has(id)) problems.push('a bidder who is not in the game');
  for (const id of a.passedIds) if (!a.participantIds.includes(id)) problems.push('someone passed who was never a bidder');
  if (a.highBidderId !== null && !a.participantIds.includes(a.highBidderId)) problems.push('the high bidder is not a bidder');
  if (a.resale) {
    if (a.participantIds.includes(a.resale.sellerId)) problems.push('the seller is among the bidders of their own auction');
    if (a.highBidderId === a.resale.sellerId) problems.push('the seller holds the high bid on their own property');
    if (a.highBid !== null && a.highBid < a.resale.reservePrice) problems.push('a bid below the reserve price was accepted');
    if ((a.status === 'CLOSED') !== (a.resale.outcome !== null)) problems.push('resale outcome and auction status disagree');
    if ((a.resale.outcome === 'SOLD') !== (a.status === 'CLOSED' && a.winnerId !== null)) problems.push('a resale is SOLD exactly when it has a winner');
  }
  if (a.status === 'OPEN') {
    if (a.winnerId !== null) problems.push('an open auction with a winner');
    if (a.closedAt !== null) problems.push('an open auction with a closing time');
    if (a.highBidderId !== null && a.passedIds.includes(a.highBidderId)) problems.push('the high bidder has passed');
    if (a.resale ? state.properties[a.propertyKey]?.ownerId !== a.resale.sellerId : state.properties[a.propertyKey]?.ownerId !== null) {
      problems.push('the property on auction is not held by its seller');
    }
  } else {
    if (a.closedAt === null) problems.push('a closed auction without a closing time');
    if (a.winnerId !== null && a.winnerId !== a.highBidderId) problems.push('the winner is not the high bidder');
  }
  return problems;
}

/** Classic bank loans, open trades, undo history and (Capital Mode) the economy document. */
export function obligationViolations(state: GameState): string[] {
  const problems: string[] = [];
  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const loan of state.loans) {
    if (!byId.has(loan.playerId)) problems.push(`loan ${loan.id}: unknown borrower`);
    if (loan.outstanding < 0 || loan.outstanding > loan.totalOwed) problems.push(`loan ${loan.id}: outstanding ${loan.outstanding} of ${loan.totalOwed}`);
    if (loan.status === 'REPAID' && loan.outstanding !== 0) problems.push(`loan ${loan.id}: repaid with ${loan.outstanding} outstanding`);
    if (loan.status === 'ACTIVE' && loan.outstanding === 0) problems.push(`loan ${loan.id}: active with nothing outstanding`);
    if (loan.status === 'ACTIVE' && byId.get(loan.playerId)?.status === 'BANKRUPT') problems.push(`loan ${loan.id}: active, but its borrower is bankrupt`);
    if (loan.interestPaid < 0 || loan.interestPaid > loan.interestCharges * loan.interestAmount) problems.push(`loan ${loan.id}: paid more interest than was charged`);
  }
  if (new Set(state.trades.map((t) => t.id)).size !== state.trades.length) problems.push('a trade offer appears twice');
  for (const t of state.trades) {
    if (t.status !== 'PENDING') continue;
    if (state.status === 'FINISHED') problems.push(`trade ${t.id}: still open after the game finished`);
    for (const id of [t.fromPlayerId, t.toPlayerId]) if (byId.get(id)?.status !== 'ACTIVE') problems.push(`trade ${t.id}: open with a player who is out of the game`);
  }
  if (state.trades.filter((t) => t.status === 'PENDING').length > RULES.trades.maxPendingPerGame) problems.push('too many open trade offers');
  if (state.undoStack.length > RULES.undo.maxDepth) problems.push('the undo history is longer than its limit');
  const req = state.undoRequest;
  if (req) {
    if (state.undoStack[state.undoStack.length - 1]?.actionId !== req.targetActionId) problems.push('an undo request for something that is not the newest undoable action');
    if (req.approverIds.length === 0) problems.push('an undo request nobody can approve');
    for (const id of req.approverIds) if (byId.get(id)?.status !== 'ACTIVE') problems.push('an undo request waiting on a player who is out of the game');
  }
  if (state.status === 'FINISHED' && (state.undoStack.length > 0 || req)) problems.push('undo history kept after the game finished');

  const eco = economyOf(state);
  if (state.mode === 'classic' && state.intermediate) problems.push('a Classic game with a Capital economy');
  if (state.mode === 'intermediate' && state.status !== 'WAITING' && !eco) problems.push('a Capital game without its economy');
  if (eco) {
    for (const loan of eco.loans) {
      if (!byId.has(loan.playerId)) problems.push(`Capital loan ${loan.id}: unknown borrower`);
      if (loan.status === 'ACTIVE' && byId.get(loan.playerId)?.status === 'BANKRUPT') problems.push(`Capital loan ${loan.id}: active, but its borrower is bankrupt`);
      if (loan.status === 'ACTIVE' && loan.collateralKey && state.properties[loan.collateralKey]?.ownerId !== loan.playerId) {
        problems.push(`Capital loan ${loan.id}: its collateral ${loan.collateralKey} is no longer the borrower's`);
      }
      if (loan.defaultBalance < 0) problems.push(`Capital loan ${loan.id}: negative default balance`);
      for (const i of loan.installments) if (i.principal < 0 || i.interest < 0) problems.push(`Capital loan ${loan.id}: negative installment`);
    }
    const pledged = eco.loans.filter((l) => l.collateralKey && (l.status === 'ACTIVE' || l.status === 'DEFAULTED')).map((l) => l.collateralKey);
    if (new Set(pledged).size !== pledged.length) problems.push('one property secures two open loans');
    for (const [key, entry] of Object.entries(eco.market)) if (!Number.isInteger(entry.value) || entry.value <= 0) problems.push(`${key}: market value ${entry.value}`);
    const insurance = eco.insurance;
    if (insurance) {
      const inForce = insurance.policies.filter((p) => p.status === 'ACTIVE').map((p) => `${p.propertyKey}:${p.ownerId}`);
      if (new Set(inForce).size !== inForce.length) problems.push('two active policies on one property for one owner');
      for (const c of insurance.crises) {
        if (c.paid < 0 || c.paid > c.amount) problems.push(`crisis ${c.id}: paid ${c.paid} of ${c.amount}`);
        if (c.status === 'PENDING') {
          if (state.status === 'FINISHED') problems.push(`crisis ${c.id}: still pending after the game finished`);
          if (!c.ownerId || byId.get(c.ownerId)?.status !== 'ACTIVE') problems.push(`crisis ${c.id}: pending on a player who is out of the game`);
        }
        if (c.status === 'PAID' && c.paid !== c.amount) problems.push(`crisis ${c.id}: PAID with ${c.paid} of ${c.amount}`);
      }
      for (const p of state.players) if (crisisOwed(eco, p.id) < 0) problems.push(`${p.name}: negative crisis debt`);
    }
  }
  return problems;
}

/** A finished game: a winner among the players still in it, with nobody above them, ties going to the first in the standings. */
export function completionViolations(state: GameState): string[] {
  if (state.status !== 'FINISHED') return state.winnerId === null ? [] : ['a winner before the game finished'];
  const problems: string[] = [];
  const active = state.players.filter((p) => p.status === 'ACTIVE');
  if (active.length === 0) {
    if (state.winnerId !== null) problems.push('a winner although nobody is left');
    return problems;
  }
  const winner = active.find((p) => p.id === state.winnerId);
  if (!winner) return ['the winner is not a player still in the game'];
  const best = Math.max(...active.map((p) => netWorth(state, p.id)));
  if (netWorth(state, winner.id) !== best) problems.push(`${winner.name} won with ${netWorth(state, winner.id)}, but the best net worth is ${best}`);
  return problems;
}

/** Every invariant of a state, given the full ledger that led to it. */
export function stateViolations(state: GameState, ledger: readonly TransactionRecord[]): string[] {
  return [
    ...ledgerViolations(state, ledger),
    ...ledgerEntryViolations(state, ledger),
    ...propertyViolations(state),
    ...playerViolations(state),
    ...ownershipViolations(state),
    ...turnViolations(state),
    ...auctionViolations(state),
    ...obligationViolations(state),
    ...completionViolations(state),
  ];
}

/** What one action may and may not do, judged against the state before it. */
export function stepViolations(before: GameState, result: EngineResult, actionId: string): string[] {
  const problems: string[] = [];
  const after = result.state;
  if (after.version !== before.version + 1) problems.push(`version went from ${before.version} to ${after.version}`);
  if (after.id !== before.id || after.mode !== before.mode || after.rulesVersion !== before.rulesVersion) problems.push('the identity of the game changed');
  for (const tx of result.transactions) if (tx.actionId !== actionId) problems.push(`transaction ${tx.id} belongs to another action`);
  if (before.status !== 'WAITING' && JSON.stringify(before.config) !== JSON.stringify(after.config)) problems.push('the settings changed after the game started');
  if (after.players.length !== before.players.length) problems.push('a player row appeared or vanished');
  for (const was of before.players) {
    const now = after.players.find((p) => p.id === was.id);
    if (!now) continue;
    if (was.status !== 'ACTIVE' && now.status !== was.status) problems.push(`${was.name}: came back from ${was.status}`);
    // Money never reaches or leaves a bankrupt player.
    if (was.status === 'BANKRUPT' && now.balance !== was.balance) problems.push(`${was.name}: balance moved after bankruptcy`);
  }
  // An auction is never dropped while it is open: it closes (sold, unsold or cancelled) first.
  if (before.auction?.status === 'OPEN' && (after.auction === null || after.auction.id !== before.auction.id)) problems.push('an open auction disappeared without closing');
  // A property changes hands for money in the same action, or not at all.
  const a = after.auction;
  if (a && a.status === 'CLOSED' && before.auction?.id === a.id && before.auction.status === 'OPEN') {
    const paid = result.transactions.filter((t) => t.type === 'AUCTION_PAYMENT');
    const ownerBefore = before.properties[a.propertyKey]?.ownerId ?? null;
    const ownerAfter = after.properties[a.propertyKey]?.ownerId ?? null;
    if (a.winnerId !== null) {
      if (paid.length !== 1 || paid[0]!.amount !== a.highBid || paid[0]!.fromPlayerId !== a.winnerId) problems.push('an auction was won without exactly one payment of the winning bid');
      if (paid[0] && paid[0].toPlayerId !== (a.resale ? a.resale.sellerId : null)) problems.push('the auction payment went to the wrong party');
      if (ownerAfter !== a.winnerId) problems.push('the winner did not receive the property');
      const was = before.properties[a.propertyKey];
      const now = after.properties[a.propertyKey];
      if (was && now && (was.houses !== now.houses || was.hotel !== now.hotel || was.mortgaged !== now.mortgaged)) problems.push('the buildings or mortgage changed when the property was sold');
    } else {
      if (paid.length !== 0) problems.push('an auction payment without a winner');
      if (ownerAfter !== ownerBefore) problems.push('the property moved although the auction sold nothing');
    }
  } else if (result.transactions.some((t) => t.type === 'AUCTION_PAYMENT')) {
    problems.push('an auction payment outside the closing of an auction');
  }
  return problems;
}
