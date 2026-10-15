import { getDeed, groupMembers, PROPERTY_KEYS, type ColorGroup, type PropertyKey } from './businessBoard.ts';
import { formatINR } from './format.ts';
import { INTERMEDIATE_RULES as IR } from './intermediateConfig.ts';
import { crisisOwed, economyOf, isIntermediate, isPledged, loanLiability, pendingCrises, type GameMode, type IntermediateState } from './intermediateState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { AuctionState, GameState, LoanState, PlayerState, PropertyState, ResaleResumePhase, ResaleTerms, TradeOffer, TurnState, UndoableRecord } from './types.ts';

type StateLike = Pick<GameState, 'properties'>;
/** Mode-aware selectors accept states that carry the mode; without one they read as Classic. */
type ModeAware = { mode?: GameMode; intermediate?: IntermediateState | null };
/** Selectors that must respect a running resale auction accept states that carry the auction; without one nothing is listed. */
type AuctionAware = { auction?: AuctionState | null };

export function ownedBy(state: StateLike, playerId: string): PropertyKey[] {
  return PROPERTY_KEYS.filter((k) => state.properties[k]?.ownerId === playerId);
}

/** How many properties of a colour group a player owns (mortgaged ones count per rules.rent). */
export function sameColorCount(state: StateLike, playerId: string, group: ColorGroup): number {
  return groupMembers(group).filter((k) => {
    const p = state.properties[k];
    return !!p && p.ownerId === playerId && (RULES.rent.sameColorCountsMortgaged || !p.mortgaged);
  }).length;
}

/**
 * Colour-set multiplier for a city site: ×2 when its owner holds at least 3
 * properties of that colour (BUSINESS_MVP_RULES.rent). Transport/utility
 * properties have no colour group and are never doubled.
 */
export function rentMultiplier(state: StateLike, key: PropertyKey): number {
  const prop = state.properties[key];
  const deed = getDeed(key);
  if (!prop || prop.ownerId === null || deed.kind !== 'CITY') return 1;
  return sameColorCount(state, prop.ownerId, deed.group) >= RULES.rent.sameColorThreshold ? RULES.rent.sameColorMultiplier : 1;
}

/** Rent from the deed for the property's CURRENT development (site / 1–3 houses / hotel), before any multiplier. */
export function developmentRent(prop: PropertyState): number {
  const deed = getDeed(prop.key);
  if (deed.kind !== 'CITY') return 0;
  if (prop.hotel) return deed.hotelRent;
  const level = Math.min(Math.max(prop.houses, 0), 3);
  return deed.rent[level] ?? deed.rent[0];
}

/**
 * THE rent calculation (engine and UI both use it). Order:
 * current development rent → colour-set multiplier (3+ same colour ⇒ ×2).
 * Mortgaged properties charge nothing — whatever is built on them. Transport/utility use
 * their paired rule; a mortgaged partner does not raise the pair's rent.
 */
export function computeRent(state: StateLike, key: PropertyKey, diceTotal: number): number {
  const prop = state.properties[key];
  if (!prop || prop.ownerId === null) return 0;
  if (prop.mortgaged && !RULES.property.rentWhenMortgaged) return 0;
  const deed = getDeed(key);
  if (deed.kind === 'CITY') {
    return developmentRent(prop) * rentMultiplier(state, key);
  }
  const partner = state.properties[deed.rent.pairedWith];
  const paired =
    !!partner &&
    partner.ownerId === prop.ownerId &&
    (RULES.property.pairCountsMortgagedPartner || !partner.mortgaged);
  if (deed.rent.type === 'FIXED') {
    return paired ? deed.rent.pairedRent : deed.rent.base;
  }
  return (paired ? deed.rent.pairedMultiplier : deed.rent.multiplier) * diceTotal;
}

/** Rent table for display, by development level. */
export function rentTable(key: PropertyKey): { label: string; amount: string }[] {
  const deed = getDeed(key);
  if (deed.kind === 'CITY') {
    return [
      { label: 'Site only', amount: String(deed.rent[0]) },
      { label: '1 house', amount: String(deed.rent[1]) },
      { label: '2 houses', amount: String(deed.rent[2]) },
      { label: '3 houses', amount: String(deed.rent[3]) },
      { label: 'Hotel', amount: String(deed.hotelRent) },
    ];
  }
  const partnerName = getDeed(deed.rent.pairedWith).name;
  if (deed.rent.type === 'FIXED') {
    return [
      { label: 'Rent', amount: String(deed.rent.base) },
      { label: `With ${partnerName}`, amount: String(deed.rent.pairedRent) },
    ];
  }
  return [
    { label: 'Rent', amount: `${deed.rent.multiplier} × dice` },
    { label: `With ${partnerName}`, amount: `${deed.rent.pairedMultiplier} × dice` },
  ];
}

export function buildingCount(state: StateLike, playerId: string): { houses: number; hotels: number } {
  let houses = 0;
  let hotels = 0;
  for (const key of ownedBy(state, playerId)) {
    const p = state.properties[key];
    if (!p) continue;
    if (p.hotel) hotels += 1;
    else houses += p.houses;
  }
  return { houses, hotels };
}

/** Income Tax: ₹50 per property/site owned (mortgaged ones are still owned), capped. */
export function incomeTaxDue(state: StateLike, playerId: string): { properties: number; amount: number } {
  const properties = ownedBy(state, playerId).length;
  return { properties, amount: Math.min(properties * RULES.incomeTax.perProperty, RULES.incomeTax.max) };
}

/** Wealth Taxes: ₹100 per house + ₹200 per hotel owned (a hotel is not also counted as houses), capped. */
export function wealthTaxDue(state: StateLike, playerId: string): { houses: number; hotels: number; amount: number } {
  const { houses, hotels } = buildingCount(state, playerId);
  const amount = Math.min(houses * RULES.wealthTax.perHouse + hotels * RULES.wealthTax.perHotel, RULES.wealthTax.max);
  return { houses, hotels, amount };
}

/**
 * A Classic loan the bank can still collect: being repaid, or in default while the borrower plays.
 * (A loan closed when the borrower's estate was settled keeps the unpaid part on record only.)
 */
export function isEnforceableLoan(loan: LoanState): boolean {
  return loan.status === 'ACTIVE' || (loan.status === 'DEFAULTED' && loan.closedAt === null);
}

/** Classic principal still owed and collectable: active loans and loans in default. */
export function outstandingDebt(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && isEnforceableLoan(l)).reduce((sum, l) => sum + l.outstanding, 0);
}

/** Principal that counts against the loan limit. */
export function outstandingPrincipal(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && isEnforceableLoan(l)).reduce((sum, l) => {
    // Principal still owed, proportional to what's left of the total.
    return sum + Math.ceil((l.principal * l.outstanding) / l.totalOwed);
  }, 0);
}

/**
 * Where a Classic loan stands, judged by the borrower's completed circuits (laps):
 *   CURRENT      principal not due yet (or a loan signed before loans had a maturity)
 *   DUE          the borrower has reached the maturity Start: repay it
 *   OVERDUE      one Start since it fell due without repayment — the next Start defaults it
 *   DEFAULTED    two Starts in a row missed: still owed, borrowing blocked until cleared
 *   CLOSED       repaid, or closed when the borrower's estate was settled
 */
export type ClassicLoanStanding = 'CURRENT' | 'DUE' | 'OVERDUE' | 'DEFAULTED' | 'CLOSED';

export function classicLoanStanding(loan: LoanState, borrowerCircuits: number): ClassicLoanStanding {
  if (!isEnforceableLoan(loan)) return 'CLOSED';
  if (loan.status === 'DEFAULTED') return 'DEFAULTED';
  if (loan.maturityCircuit === null || borrowerCircuits < loan.maturityCircuit) return 'CURRENT';
  return borrowerCircuits >= loan.maturityCircuit + RULES.loans.overdueAfterCircuits ? 'OVERDUE' : 'DUE';
}

/** Why this Classic player may not borrow right now because of an earlier loan, or null. */
export function classicBorrowingBlock(state: Pick<GameState, 'loans' | 'players'>, playerId: string): string | null {
  const circuits = state.players.find((p) => p.id === playerId)?.circuits ?? 0;
  const standings = state.loans.filter((l) => l.playerId === playerId).map((l) => classicLoanStanding(l, circuits));
  if (standings.includes('DEFAULTED')) return 'You have a loan in default. Repay it before borrowing again.';
  if (standings.includes('OVERDUE')) return 'You have an overdue loan. Repay it before borrowing again.';
  return null;
}

/** The borrower's circuit count at which this loan's next interest is charged, or null if none will be. */
export function nextInterestCircuit(loan: LoanState): number | null {
  if (loan.status !== 'ACTIVE') return null;
  if (loan.interestCharges > 0 && !RULES.loans.interestEveryCircuit) return null;
  return loan.createdAtCircuit + 1 + loan.interestCharges;
}

/** Active loans of a player whose interest checkpoint has been reached at `circuits` completed circuits. */
export function loansWithInterestDue(loans: LoanState[], playerId: string, circuits: number): LoanState[] {
  return loans.filter((l) => {
    if (l.playerId !== playerId) return false;
    const next = nextInterestCircuit(l);
    return next !== null && circuits >= next;
  });
}

/**
 * What the buildings standing on a property cost to build (deed costs): each house at the house
 * cost; a hotel at the hotel cost plus the 3 houses it replaced. The one building valuation —
 * net worth uses it at full cost, selling back to the bank pays building.sellBackRate of it.
 */
export function buildingCost(prop: PropertyState): number {
  const deed = getDeed(prop.key);
  if (deed.kind !== 'CITY') return 0;
  return prop.hotel ? deed.hotelCost + deed.houseCost * RULES.building.maxHouses : deed.houseCost * prop.houses;
}

/** A property's worth to its owner: deed price (less the mortgage value while mortgaged) + its buildings at cost. */
export function propertyValue(prop: PropertyState): number {
  const deed = getDeed(prop.key);
  return (prop.mortgaged ? deed.price - deed.mortgageValue : deed.price) + buildingCost(prop);
}

/** Loan interest that has been charged at Start but not paid yet (the player is still raising the money). */
export function unpaidLoanInterest(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && isEnforceableLoan(l)).reduce((sum, l) => sum + loanInterestUnpaid(l), 0);
}

export function loanInterestUnpaid(loan: LoanState): number {
  return Math.max(0, loan.interestCharges * loan.interestAmount - loan.interestPaid);
}

/**
 * A player's financial position, the same way in both modes. Every screen, the standings and the
 * winner read it, so they can never disagree.
 *
 *   assets       cash + properties + buildings at what they cost to build (100%: the bank's 50% is
 *                what selling one pays, not what it is worth to its owner)
 *                  Classic: each property at its deed price · Capital: at its current market value
 *   liabilities  mortgages — Classic: the mortgage value · Capital: the cost to redeem it
 *                + loans — what would close each one today (Classic: principal still owed + interest
 *                  charged at Start and unpaid; Capital: loanPayoff)
 *                + crisis bills still owed (Capital)
 *   net worth    assets − liabilities
 *
 * Each obligation is counted once, in one line. A player's credit score is not money and is not in it.
 */
export interface BalanceSheet {
  cash: number;
  propertyValue: number;
  buildingValue: number;
  assets: number;
  mortgages: number;
  loans: number;
  crisisBills: number;
  liabilities: number;
  netWorth: number;
}

export function balanceSheet(state: Pick<GameState, 'properties' | 'players'> & { loans?: LoanState[] } & ModeAware, playerId: string): BalanceSheet {
  const cash = state.players.find((p) => p.id === playerId)?.balance ?? 0;
  const eco = economyOf(state);
  let propertyValue = 0;
  let buildingValue = 0;
  let mortgages = 0;
  for (const key of ownedBy(state, playerId)) {
    const p = state.properties[key];
    propertyValue += eco ? (eco.market[key]?.value ?? getDeed(key).price) : getDeed(key).price;
    buildingValue += buildingCost(p);
    if (p.mortgaged) mortgages += eco ? unmortgageCost(key) : getDeed(key).mortgageValue;
  }
  const classic = state.loans ?? [];
  const loans = eco ? intermediateDebt(eco, playerId) : outstandingDebt(classic, playerId) + unpaidLoanInterest(classic, playerId);
  const crisisBills = eco ? crisisOwed(eco, playerId) : 0;
  const assets = cash + propertyValue + buildingValue;
  const liabilities = mortgages + loans + crisisBills;
  return { cash, propertyValue, buildingValue, assets, mortgages, loans, crisisBills, liabilities, netWorth: assets - liabilities };
}

/** THE net worth (the final standings, the winner, every screen): balanceSheet(…).netWorth. */
export function netWorth(state: Pick<GameState, 'properties' | 'loans' | 'players'> & ModeAware, playerId: string): number {
  if (!state.players.some((p) => p.id === playerId)) return 0;
  return balanceSheet(state, playerId).netWorth;
}

/** One place in the final standings. */
export interface Standing {
  playerId: string;
  netWorth: number;
  /** Total outstanding liabilities (balanceSheet): the tie-breaker. */
  liabilities: number;
  /** 1 = winner. Players level on both net worth and liabilities share a rank. */
  rank: number;
}

/**
 * THE final ranking. Only players still in the game are ranked — a bankrupt or departed player
 * cannot win, whatever is left on record in their name. Highest net worth first; on exactly equal
 * net worth, lower total liabilities first; equal on both, the players share the place (and, at the
 * top, the victory). Seat order, player ids and chance never decide anything: players sharing a rank
 * are listed in seat order for display only.
 */
export function rankStandings(state: Pick<GameState, 'properties' | 'loans' | 'players'> & ModeAware): Standing[] {
  const rows = state.players
    .filter((p) => p.status === 'ACTIVE')
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const sheet = balanceSheet(state, p.id);
      return { playerId: p.id, netWorth: sheet.netWorth, liabilities: sheet.liabilities, rank: 0 };
    })
    .sort((a, b) => b.netWorth - a.netWorth || a.liabilities - b.liabilities);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.netWorth === row.netWorth && prev.liabilities === row.liabilities ? prev.rank : i + 1;
  });
  return rows;
}

/** The players ranked first: one winner, several when they share the victory, none when nobody is left. */
export function winnersOf(standings: readonly Standing[]): string[] {
  return standings.filter((s) => s.rank === 1).map((s) => s.playerId);
}

// ---------------------------------------------------------------------------
// Capital Mode valuation (never reached in a Classic game)
// ---------------------------------------------------------------------------

/** What the bank charges for an unowned property: its market value in Capital Mode, the deed price in Classic. */
export function purchasePrice(state: ModeAware, key: PropertyKey): number {
  return economyOf(state)?.market[key]?.value ?? getDeed(key).price;
}

/** Everything a player owes on Capital loans today: each loan's payoff (principal, interest due or accrued, defaulted balances). */
export function intermediateDebt(eco: IntermediateState, playerId: string): number {
  return eco.loans.filter((l) => l.playerId === playerId).reduce((sum, l) => sum + loanLiability(eco, l), 0);
}

/**
 * Capital net asset value: cash + every owned property at its current market value
 * + its buildings at what they cost to build − what it would cost to redeem each mortgage
 * (mortgage value + the redemption charge). Loans are not subtracted here.
 */
export function intermediateNetAssets(state: Pick<GameState, 'properties' | 'players'>, eco: IntermediateState, playerId: string): number {
  const cash = state.players.find((p) => p.id === playerId)?.balance ?? 0;
  return ownedBy(state, playerId).reduce((sum, k) => {
    const p = state.properties[k];
    if (!p) return sum;
    return sum + (eco.market[k]?.value ?? getDeed(k).price) + buildingCost(p) - (p.mortgaged ? unmortgageCost(k) : 0);
  }, cash);
}

/** What a player owes the bank on loans, in either mode: the loans line of their balance sheet. */
export function totalDebt(state: Pick<GameState, 'loans'> & ModeAware, playerId: string): number {
  const eco = economyOf(state);
  return eco ? intermediateDebt(eco, playerId) : outstandingDebt(state.loans, playerId) + unpaidLoanInterest(state.loans, playerId);
}

export function ownsWholeGroup(state: StateLike, playerId: string, key: PropertyKey): boolean {
  const deed = getDeed(key);
  return groupMembers(deed.group).every((k) => state.properties[k]?.ownerId === playerId);
}

export function unmortgageCost(key: PropertyKey): number {
  const mv = getDeed(key).mortgageValue;
  return mv + Math.round(mv * RULES.mortgage.unmortgageInterestRate);
}

/**
 * What ONE sale back to the bank pays (SELL_BUILDING): building.sellBackRate of the original cost.
 * Houses are sold one at a time. A hotel is sold whole — the hotel and the 3 houses it replaced —
 * and leaves the site empty, so those houses can never be refunded a second time.
 */
export function sellBuildingRefund(key: PropertyKey, prop: PropertyState): number {
  const deed = getDeed(key);
  if (deed.kind !== 'CITY') return 0;
  const cost = prop.hotel ? buildingCost(prop) : prop.houses > 0 ? deed.houseCost : 0;
  return Math.floor(cost * RULES.building.sellBackRate);
}

/**
 * THE mortgage payout (BUSINESS_MVP_RULES.mortgage): the deed's printed mortgage value and nothing
 * else. Houses/hotel on the site are not paid for — they stay attached, inactive, until unmortgaged.
 */
export function mortgagePayout(key: PropertyKey): number {
  return getDeed(key).mortgageValue;
}

/** Loan amounts. Interest is NOT owed at borrowing time — it is charged at the next Start. */
export function loanTerms(amount: number): { principal: number; interest: number; totalOwed: number } {
  const interest = Math.round((amount * RULES.loans.interestRatePercent) / 100);
  return { principal: amount, interest, totalOwed: amount };
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** What stands on a property, in words ("1 house", "2 houses", "hotel"), or null when nothing does. */
export function buildingLabel(prop: Pick<PropertyState, 'houses' | 'hotel'> | undefined): string | null {
  if (!prop) return null;
  if (prop.hotel) return 'hotel';
  return prop.houses > 0 ? `${prop.houses} house${prop.houses === 1 ? '' : 's'}` : null;
}

/** A property as it is named in a trade: with what is built on it, so nobody trades buildings away unseen. */
export function tradePropertyLabel(state: StateLike, key: PropertyKey): string {
  const built = buildingLabel(state.properties[key]);
  return built ? `${getDeed(key).name} (${built})` : getDeed(key).name;
}

/** Why one side's property can't be traded right now, or null. */
export function tradePropertyBlocker(state: StateLike & ModeAware & AuctionAware, ownerId: string, key: PropertyKey): string | null {
  const prop = state.properties[key];
  const name = getDeed(key).name;
  if (!prop || prop.ownerId !== ownerId) return `${name} no longer belongs to that player.`;
  // Capital Mode: a property its owner is auctioning goes to the auction's winner or stays put.
  if (openResaleFor(state, key)) return `${name} is up for auction.`;
  if (RULES.trades.requireNoBuildings && (prop.hotel || prop.houses > 0)) return `Sell the buildings on ${name} before trading it.`;
  if (!RULES.trades.allowMortgaged && prop.mortgaged) return `${name} is mortgaged.`;
  if (isPledged(state, key)) return `${name} is pledged as loan collateral.`;
  return null;
}

// ---------------------------------------------------------------------------
// Mandatory payments and raising money
// ---------------------------------------------------------------------------

/** Selectors that must know about a payment awaited on the turn accept states that carry the turn; without one nothing is owed on it. */
type TurnAware = { turn?: Pick<TurnState, 'playerId' | 'pending'> | null };

/**
 * What a player owes right now on game-generated payments they have not settled: the payment their
 * turn is waiting on (rent, tax, a card, Club, loan interest) and, in Capital Mode, crisis bills.
 * Not loans — those have their own schedule. While this is above zero the player may not give money away.
 */
export function mandatoryPaymentsOwed(state: TurnAware & ModeAware, playerId: string): number {
  const pending = state.turn?.playerId === playerId ? state.turn.pending : null;
  const onTurn = pending?.kind === 'PAYMENT' ? pending.amount : 0;
  const crises = pendingCrises(state)
    .filter((c) => c.ownerId === playerId)
    .reduce((sum, c) => sum + c.amount - c.paid, 0);
  return onTurn + crises;
}

/**
 * What one property could still raise from the bank, at the bank's own prices: every building sold
 * back (building.sellBackRate of its cost, as SELL_BUILDING pays it) and then the property mortgaged
 * for its mortgage value (selling it to the bank pays the same). Nothing for a property that is
 * already mortgaged (its buildings are frozen with it) or pledged as loan collateral.
 */
export function propertyLiquidationValue(state: StateLike & ModeAware, key: PropertyKey): number {
  const prop = state.properties[key];
  if (!prop || prop.ownerId === null || prop.mortgaged || isPledged(state, key)) return 0;
  const deed = getDeed(key);
  const buildings = deed.kind !== 'CITY' ? 0 : prop.hotel ? sellBuildingRefund(key, prop) : prop.houses * sellBuildingRefund(key, { ...prop, houses: 1 });
  return buildings + mortgagePayout(key);
}

/** Cash plus everything the player's properties could raise from the bank. Borrowing is not counted: it is never required. */
export function raisableFunds(state: Pick<GameState, 'players' | 'properties'> & ModeAware, playerId: string): number {
  const cash = state.players.find((p) => p.id === playerId)?.balance ?? 0;
  return ownedBy(state, playerId).reduce((sum, key) => sum + propertyLiquidationValue(state, key), cash);
}

/**
 * The anti-asset-stripping rule for a player who owes a mandatory payment: a trade must not leave them
 * able to raise less from the bank than before. What they receive (cash + what the properties they get
 * could raise) must be at least what they give up (cash + what the properties they hand over could
 * raise). A fair or generous deal goes through — including selling for more than the bank would pay —
 * but handing property to a friend for a token sum, out of the creditor's reach, does not.
 * Values are the bank's (propertyLiquidationValue): no appraisal of anyone's opinion of a price.
 */
export function tradeStripsDebtor(
  state: StateLike & ModeAware,
  side: { giveKeys: readonly PropertyKey[]; giveMoney: number; getKeys: readonly PropertyKey[]; getMoney: number },
): boolean {
  const value = (keys: readonly PropertyKey[]) => keys.reduce((sum, k) => sum + propertyLiquidationValue(state, k), 0);
  return side.getMoney + value(side.getKeys) < side.giveMoney + value(side.giveKeys);
}

/**
 * Full validation of a trade against the CURRENT state (used when creating and
 * again when accepting). Returns the first problem, or null if it can execute.
 */
export function tradeBlocker(
  state: Pick<GameState, 'players' | 'properties' | 'status'> & ModeAware & AuctionAware & TurnAware,
  trade: Pick<TradeOffer, 'fromPlayerId' | 'toPlayerId' | 'offeredPropertyKeys' | 'requestedPropertyKeys' | 'offeredMoney' | 'requestedMoney'>,
): string | null {
  if (state.status !== 'ACTIVE') return 'The game is not running.';
  // Capital Mode: nothing changes hands while a crisis bill is unsettled.
  if (pendingCrises(state).length) return 'A crisis bill must be settled first.';
  const from = state.players.find((p) => p.id === trade.fromPlayerId);
  const to = state.players.find((p) => p.id === trade.toPlayerId);
  if (!from || !to) return 'That player is not in this game.';
  if (from.id === to.id) return 'Choose another player.';
  if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE') return 'Both players must still be in the game.';
  const all = [...trade.offeredPropertyKeys, ...trade.requestedPropertyKeys];
  if (new Set(all).size !== all.length) return 'A property can only appear once in a trade.';
  if (all.length === 0) return 'A trade must include at least one property.';
  if (trade.offeredPropertyKeys.length === 0 && trade.offeredMoney <= 0) return 'Offer something.';
  if (trade.requestedPropertyKeys.length === 0 && trade.requestedMoney <= 0) return 'Ask for something in return.';
  for (const key of trade.offeredPropertyKeys) {
    const why = tradePropertyBlocker(state, from.id, key);
    if (why) return why;
  }
  for (const key of trade.requestedPropertyKeys) {
    const why = tradePropertyBlocker(state, to.id, key);
    if (why) return why;
  }
  if (from.balance < trade.offeredMoney) return `${from.name} doesn't have the offered money.`;
  if (to.balance < trade.requestedMoney) return `${to.name} doesn't have the requested money.`;
  // Ordinary trades are never restricted. Only a player with a payment to settle is held to a fair exchange.
  const fromSide = { giveKeys: trade.offeredPropertyKeys, giveMoney: trade.offeredMoney, getKeys: trade.requestedPropertyKeys, getMoney: trade.requestedMoney };
  const toSide = { giveKeys: trade.requestedPropertyKeys, giveMoney: trade.requestedMoney, getKeys: trade.offeredPropertyKeys, getMoney: trade.offeredMoney };
  for (const [player, side] of [[from, fromSide], [to, toSide]] as const) {
    if (mandatoryPaymentsOwed(state, player.id) > 0 && tradeStripsDebtor(state, side)) {
      return `${player.name} has a payment to settle: a trade can’t leave them with less than the bank would pay for what they give up.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export function topUndoable(state: Pick<GameState, 'undoStack'>): UndoableRecord | null {
  return state.undoStack[state.undoStack.length - 1] ?? null;
}

function sameProperty(a: PropertyState | undefined, b: PropertyState): boolean {
  return !!a && a.ownerId === b.ownerId && a.houses === b.houses && a.hotel === b.hotel && a.mortgaged === b.mortgaged;
}

/**
 * Why an undo record can't be applied safely to the current state, or null.
 * A record is superseded when any property it touched has changed since, or
 * when a player it touched is no longer in the game.
 */
export function undoBlocker(state: Pick<GameState, 'properties' | 'players'> & ModeAware & AuctionAware, record: UndoableRecord): string | null {
  for (const after of record.propertiesAfter) {
    if (isPledged(state, after.key)) return `${getDeed(after.key).name} is pledged as loan collateral — can’t undo.`;
    // Bidders are bidding on the property as it was listed: nothing about it is taken back meanwhile.
    if (openResaleFor(state, after.key)) return `${getDeed(after.key).name} is up for auction — can’t undo.`;
    if (!sameProperty(state.properties[after.key], after)) return `${getDeed(after.key).name} has changed since — can’t undo.`;
  }
  for (const id of [record.actorId, ...record.counterpartyIds]) {
    if (state.players.find((p) => p.id === id)?.status !== 'ACTIVE') return 'A player involved is out of the game — can’t undo.';
  }
  return null;
}

export type PropertyActionKind =
  | 'BUILD_HOUSE'
  | 'BUILD_HOTEL'
  | 'SELL_BUILDING'
  | 'SELL_PROPERTY'
  | 'MORTGAGE_PROPERTY'
  | 'UNMORTGAGE_PROPERTY';

/**
 * Why a property action is not allowed, or null if allowed.
 * Used by the engine to validate and by the UI to decide which buttons to show.
 */
export function propertyActionBlocker(
  state: GameState,
  playerId: string,
  key: PropertyKey,
  kind: PropertyActionKind,
): string | null {
  const prop = state.properties[key];
  const player = state.players.find((p) => p.id === playerId);
  if (!prop || !player) return 'Unknown property.';
  if (state.status !== 'ACTIVE') return state.status === 'PAUSED' ? 'Game is paused.' : 'Game is not running.';
  if (player.status !== 'ACTIVE') return 'You are out of the game.';
  if (prop.ownerId !== playerId) return "You don't own this property.";
  if (state.turn.phase === 'AUCTION') return 'Wait for the auction to finish.';
  const deed = getDeed(key);
  const isMyTurn = state.turn.playerId === playerId;
  // Capital Mode: while a crisis bill is unsettled only the player who owes it may act, and only to raise money.
  const crises = pendingCrises(state);
  if (crises.length) {
    if (!crises.some((c) => c.ownerId === playerId)) return 'A crisis bill must be settled before play continues.';
    if (kind === 'BUILD_HOUSE' || kind === 'BUILD_HOTEL' || kind === 'UNMORTGAGE_PROPERTY') return 'Settle your crisis bill first.';
  }
  // Capital Mode: a property securing a loan can't take a second claim, change or leave its owner.
  if (isPledged(state, key)) {
    if (kind === 'MORTGAGE_PROPERTY') return 'Pledged as loan collateral — it can’t also be mortgaged.';
    if (kind === 'SELL_PROPERTY') return 'Pledged as loan collateral — repay that loan first.';
    if (kind === 'BUILD_HOUSE' || kind === 'BUILD_HOTEL') return 'Pledged as loan collateral — repay that loan before building.';
  }

  switch (kind) {
    case 'BUILD_HOUSE':
    case 'BUILD_HOTEL': {
      if (deed.kind !== 'CITY') return 'You can only build on city sites.';
      if (RULES.building.onlyOnOwnTurn && !isMyTurn) return 'You can only build during your turn.';
      if (prop.mortgaged) return 'Unmortgage this property first.';
      if (RULES.building.requireFullGroup && !ownsWholeGroup(state, playerId, key)) {
        return 'Own every property of this colour to build here.';
      }
      if (prop.hotel) return 'This site already has a hotel.';
      if (kind === 'BUILD_HOUSE') {
        if (prop.houses >= RULES.building.maxHouses) return 'Maximum houses built — build a hotel next.';
        if (player.balance < deed.houseCost) return 'Not enough money for a house.';
      } else {
        if (RULES.building.hotelRequiresMaxHouses && prop.houses < RULES.building.maxHouses) {
          return `Build ${RULES.building.maxHouses} houses first.`;
        }
        if (player.balance < deed.hotelCost) return 'Not enough money for a hotel.';
      }
      return null;
    }
    case 'SELL_BUILDING':
      if (deed.kind !== 'CITY' || (!prop.hotel && prop.houses === 0)) return 'Nothing built here.';
      // Buildings on a mortgaged site are frozen with it.
      if (prop.mortgaged) return 'Unmortgage this property first.';
      return null;
    case 'SELL_PROPERTY':
      if (prop.hotel || prop.houses > 0) return 'Sell the buildings first.';
      if (prop.mortgaged) return 'Unmortgage before selling.';
      return null;
    case 'MORTGAGE_PROPERTY':
      // Buildings are allowed: they stay on the site, inactive, until it is unmortgaged.
      if (prop.mortgaged) return 'Already mortgaged.';
      return null;
    case 'UNMORTGAGE_PROPERTY':
      if (!prop.mortgaged) return 'Not mortgaged.';
      if (player.balance < unmortgageCost(key)) return 'Not enough money to unmortgage.';
      return null;
  }
}

// ---------------------------------------------------------------------------
// Property resale auctions (Capital Mode)
// ---------------------------------------------------------------------------

/** The resale terms of an auction, or null for the bank's auction of an unowned property. */
export function resaleOf(auction: Pick<AuctionState, 'resale'> | null | undefined): ResaleTerms | null {
  return auction?.resale ?? null;
}

/** The open resale auction this property is listed in, or null. */
export function openResaleFor(state: AuctionAware, key: PropertyKey): AuctionState | null {
  const auction = state.auction;
  return auction && auction.status === 'OPEN' && auction.resale && auction.propertyKey === key ? auction : null;
}

/**
 * Server-clock ms at which the first bid is accepted. A resale starts with a short "get ready"
 * (INTERMEDIATE_RULES.resale.startCountdownSeconds) so the auction is on every phone before
 * bidding opens; the bank's auction of an unowned property opens the moment it is created.
 */
export function auctionOpensAt(auction: Pick<AuctionState, 'createdAt' | 'resale'>): number {
  return Date.parse(auction.createdAt) + (auction.resale ? IR.resale.startCountdownSeconds * 1000 : 0);
}

/** The phases of their own turn in which a player may list a property; the turn returns to the same one afterwards. */
export const RESALE_START_PHASES: readonly ResaleResumePhase[] = ['AWAITING_ROLL', 'AWAITING_PAYMENT', 'TURN_COMPLETE'];

/** Why `amount` can't be a reserve price, or null. The seller chooses it freely within the game's money rules. */
export function reservePriceBlocker(amount: number): string | null {
  if (!Number.isInteger(amount) || amount <= 0) return 'Enter a reserve price in whole rupees.';
  if (amount > IR.resale.maxReservePrice) return `The reserve price can be at most ${formatINR(IR.resale.maxReservePrice)}.`;
  return null;
}

/**
 * Why this player can't put this property up for auction right now, or null.
 * The engine runs it when the auction is created; the screens show the same answer.
 */
export function resaleBlocker(state: GameState, playerId: string, key: PropertyKey): string | null {
  if (!isIntermediate(state)) return 'Property auctions are only available in Capital Mode.';
  const prop = state.properties[key];
  const player = state.players.find((p) => p.id === playerId);
  if (!prop || !player) return 'Unknown property.';
  if (state.status !== 'ACTIVE') return state.status === 'PAUSED' ? 'Game is paused.' : 'Game is not running.';
  if (player.status !== 'ACTIVE') return 'You are out of the game.';
  if (prop.ownerId === null) return 'This property belongs to the bank.';
  if (prop.ownerId !== playerId) return "You don't own this property.";
  if (openResaleFor(state, key)) return 'Already up for auction.';
  if (state.turn.phase === 'AUCTION') return 'Wait for the auction to finish.';
  const crisis = pendingCrises(state)[0];
  if (crisis) return crisis.ownerId === playerId ? 'Settle your crisis bill first.' : 'A crisis bill must be settled before play continues.';
  if (prop.mortgaged) return 'Mortgaged — unmortgage it before auctioning it.';
  if (isPledged(state, key)) return 'Pledged as loan collateral — repay that loan first.';
  if (state.turn.playerId !== playerId) return 'You can auction a property during your own turn.';
  if (!(RESALE_START_PHASES as readonly string[]).includes(state.turn.phase)) return 'Finish your current action first.';
  if (!state.players.some((p) => p.id !== playerId && p.status === 'ACTIVE')) return 'Nobody else is left to bid.';
  return null;
}

/**
 * Why a closing resale auction does not sell the property, or null when the sale goes through.
 * Everything is judged against the state as it is NOW — the bid, the reserve, the buyer's cash,
 * who owns the property and what is on it — so nothing agreed earlier is taken on trust.
 */
export function resaleSaleBlocker(state: GameState, auction: AuctionState): string | null {
  const resale = auction.resale;
  if (!resale || !isIntermediate(state)) return 'this auction cannot sell a player’s property';
  if (auction.highBid === null || auction.highBidderId === null) return 'no bids';
  if (auction.highBid < resale.reservePrice) return 'reserve price not met';
  const winner = state.players.find((p) => p.id === auction.highBidderId);
  if (!winner || winner.id === resale.sellerId || !auction.participantIds.includes(winner.id)) return 'the highest bid was not valid';
  if (winner.status !== 'ACTIVE') return `${winner.name} ${winner.status === 'LEFT' ? 'left the game' : 'is out of the game'}`;
  const prop = state.properties[auction.propertyKey];
  if (!prop || prop.ownerId !== resale.sellerId) return 'the seller no longer owns it';
  if (prop.mortgaged) return 'it was mortgaged';
  if (isPledged(state, auction.propertyKey)) return 'it was pledged as loan collateral';
  if (prop.houses !== resale.houses || prop.hotel !== resale.hotel) return 'its buildings changed';
  if (winner.balance < auction.highBid) return `${winner.name} couldn't pay`;
  return null;
}

export function currentPlayer(state: GameState): PlayerState | undefined {
  return state.players.find((p) => p.id === state.turn.playerId);
}

export function totalMoneyInPlay(state: Pick<GameState, 'players'>): number {
  return state.players.reduce((sum, p) => sum + p.balance, 0);
}
