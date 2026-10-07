import { getDeed, groupMembers, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { GameState, LoanState, PlayerState, PropertyState } from './types.ts';

type StateLike = Pick<GameState, 'properties'>;

export function ownedBy(state: StateLike, playerId: string): PropertyKey[] {
  return PROPERTY_KEYS.filter((k) => state.properties[k]?.ownerId === playerId);
}

/** Rent for a property at its current development, given the dice total that landed the payer there. */
export function computeRent(state: StateLike, key: PropertyKey, diceTotal: number): number {
  const prop = state.properties[key];
  if (!prop || prop.ownerId === null) return 0;
  if (prop.mortgaged && !RULES.property.rentWhenMortgaged) return 0;
  const deed = getDeed(key);
  if (deed.kind === 'CITY') {
    if (prop.hotel) return deed.hotelRent;
    const level = Math.min(Math.max(prop.houses, 0), 3);
    return deed.rent[level] ?? deed.rent[0];
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

export function outstandingDebt(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && l.status === 'ACTIVE').reduce((sum, l) => sum + l.outstanding, 0);
}

export function outstandingPrincipal(loans: LoanState[], playerId: string): number {
  return loans.filter((l) => l.playerId === playerId && l.status === 'ACTIVE').reduce((sum, l) => {
    // Principal still owed, proportional to what's left of the total.
    return sum + Math.ceil((l.principal * l.outstanding) / l.totalOwed);
  }, 0);
}

export function propertyValue(prop: PropertyState): number {
  const deed = getDeed(prop.key);
  let value = prop.mortgaged ? deed.price - deed.mortgageValue : deed.price;
  if (deed.kind === 'CITY') {
    if (prop.hotel) value += deed.houseCost * RULES.building.maxHouses + deed.hotelCost;
    else value += deed.houseCost * prop.houses;
  }
  return value;
}

/** Basic net worth (MVP definition): cash + property at cost (minus mortgage) + buildings at cost − loans owed. */
export function netWorth(state: Pick<GameState, 'properties' | 'loans' | 'players'>, playerId: string): number {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 0;
  const props = ownedBy(state, playerId).reduce((sum, k) => {
    const p = state.properties[k];
    return p ? sum + propertyValue(p) : sum;
  }, 0);
  return player.balance + props - outstandingDebt(state.loans, playerId);
}

export function ownsWholeGroup(state: StateLike, playerId: string, key: PropertyKey): boolean {
  const deed = getDeed(key);
  return groupMembers(deed.group).every((k) => state.properties[k]?.ownerId === playerId);
}

export function unmortgageCost(key: PropertyKey): number {
  const mv = getDeed(key).mortgageValue;
  return mv + Math.round(mv * RULES.mortgage.unmortgageInterestRate);
}

export function sellBuildingRefund(key: PropertyKey, prop: PropertyState): number {
  const deed = getDeed(key);
  if (deed.kind !== 'CITY') return 0;
  const cost = prop.hotel ? deed.hotelCost : deed.houseCost;
  return Math.floor(cost * RULES.building.sellBackRate);
}

export function loanTerms(amount: number): { principal: number; interest: number; totalOwed: number } {
  const interest = Math.round((amount * RULES.loans.interestRatePercent) / 100);
  return { principal: amount, interest, totalOwed: amount + interest };
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

  switch (kind) {
    case 'BUILD_HOUSE':
    case 'BUILD_HOTEL': {
      if (deed.kind !== 'CITY') return 'You can only build on city sites.';
      if (RULES.building.onlyOnOwnTurn && !isMyTurn) return 'You can only build during your turn.';
      if (prop.mortgaged) return 'Unmortgage this property first.';
      if (RULES.building.requireFullGroup && !ownsWholeGroup(state, playerId, key)) {
        return 'You need every site in this colour group first.';
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
      return null;
    case 'SELL_PROPERTY':
      if (prop.hotel || prop.houses > 0) return 'Sell the buildings first.';
      if (prop.mortgaged) return 'Unmortgage before selling.';
      return null;
    case 'MORTGAGE_PROPERTY':
      if (prop.mortgaged) return 'Already mortgaged.';
      if (prop.hotel || prop.houses > 0) return 'Sell the buildings first.';
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
