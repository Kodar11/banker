import { getDeed, groupMembers, PROPERTY_KEYS, type ColorGroup, type PropertyKey } from './businessBoard.ts';
import { economyOf, isPledged, loanLiability, type GameMode, type IntermediateState } from './intermediateState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { GameState, LoanState, PlayerState, PropertyState, TradeOffer, UndoableRecord } from './types.ts';

type StateLike = Pick<GameState, 'properties'>;
/** Mode-aware selectors accept states that carry the mode; without one they read as Classic. */
type ModeAware = { mode?: GameMode; intermediate?: IntermediateState | null };

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

export function outstandingDebt(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && l.status === 'ACTIVE').reduce((sum, l) => sum + l.outstanding, 0);
}

export function outstandingPrincipal(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && l.status === 'ACTIVE').reduce((sum, l) => {
    // Principal still owed, proportional to what's left of the total.
    return sum + Math.ceil((l.principal * l.outstanding) / l.totalOwed);
  }, 0);
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
  return loans
    .filter((l) => l.playerId === playerId && l.status !== 'DEFAULTED')
    .reduce((sum, l) => sum + Math.max(0, l.interestCharges * l.interestAmount - l.interestPaid), 0);
}

/**
 * THE net worth (winner of an early end, standings, every screen):
 * cash + each property at its deed price (less its mortgage value while mortgaged)
 * + houses/hotels at what they cost to build − loan principal still owed
 * − loan interest already charged but not yet paid.
 */
export function netWorth(state: Pick<GameState, 'properties' | 'loans' | 'players'> & ModeAware, playerId: string): number {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 0;
  const eco = economyOf(state);
  if (eco) return intermediateNetAssets(state, eco, playerId) - intermediateDebt(eco, playerId);
  const props = ownedBy(state, playerId).reduce((sum, k) => {
    const p = state.properties[k];
    return p ? sum + propertyValue(p) : sum;
  }, 0);
  return player.balance + props - outstandingDebt(state.loans, playerId) - unpaidLoanInterest(state.loans, playerId);
}

// ---------------------------------------------------------------------------
// Intermediate Mode valuation (never reached in a Classic game)
// ---------------------------------------------------------------------------

/** What the bank charges for an unowned property: its market value in Intermediate Mode, the deed price in Classic. */
export function purchasePrice(state: ModeAware, key: PropertyKey): number {
  return economyOf(state)?.market[key]?.value ?? getDeed(key).price;
}

/** Everything a player owes on Intermediate loans today (principal, interest already due, defaulted balances). */
export function intermediateDebt(eco: IntermediateState, playerId: string): number {
  return eco.loans.filter((l) => l.playerId === playerId).reduce((sum, l) => sum + loanLiability(l), 0);
}

/**
 * Intermediate net asset value: cash + every owned property at its current market value
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

/** What a player owes the bank on loans, in either mode (Classic: loan principal still owed). */
export function totalDebt(state: Pick<GameState, 'loans'> & ModeAware, playerId: string): number {
  const eco = economyOf(state);
  return eco ? intermediateDebt(eco, playerId) : outstandingDebt(state.loans, playerId);
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
export function tradePropertyBlocker(state: StateLike & ModeAware, ownerId: string, key: PropertyKey): string | null {
  const prop = state.properties[key];
  const name = getDeed(key).name;
  if (!prop || prop.ownerId !== ownerId) return `${name} no longer belongs to that player.`;
  if (RULES.trades.requireNoBuildings && (prop.hotel || prop.houses > 0)) return `Sell the buildings on ${name} before trading it.`;
  if (!RULES.trades.allowMortgaged && prop.mortgaged) return `${name} is mortgaged.`;
  if (isPledged(state, key)) return `${name} is pledged as loan collateral.`;
  return null;
}

/**
 * Full validation of a trade against the CURRENT state (used when creating and
 * again when accepting). Returns the first problem, or null if it can execute.
 */
export function tradeBlocker(
  state: Pick<GameState, 'players' | 'properties' | 'status'> & ModeAware,
  trade: Pick<TradeOffer, 'fromPlayerId' | 'toPlayerId' | 'offeredPropertyKeys' | 'requestedPropertyKeys' | 'offeredMoney' | 'requestedMoney'>,
): string | null {
  if (state.status !== 'ACTIVE') return 'The game is not running.';
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
export function undoBlocker(state: Pick<GameState, 'properties' | 'players'> & ModeAware, record: UndoableRecord): string | null {
  for (const after of record.propertiesAfter) {
    if (isPledged(state, after.key)) return `${getDeed(after.key).name} is pledged as loan collateral — can’t undo.`;
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
  // Intermediate Mode: a property securing a loan can't take a second claim, change or leave its owner.
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

export function currentPlayer(state: GameState): PlayerState | undefined {
  return state.players.find((p) => p.id === state.turn.playerId);
}

export function totalMoneyInPlay(state: Pick<GameState, 'players'>): number {
  return state.players.reduce((sum, p) => sum + p.balance, 0);
}
