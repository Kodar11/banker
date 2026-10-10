import {
  BUSINESS_MVP_RULES,
  DECK_LABELS,
  incomeTaxDue,
  wealthTaxDue,
  type GameState,
  type PlayerState,
  type SpecialSpaceType,
} from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';

const RULES = BUSINESS_MVP_RULES;

/** What a special square does, from the same rules the engine reads. Informational only. */
export function specialSquareInfo(type: SpecialSpaceType, state: GameState, me: PlayerState | null): string[] {
  const others = state.players.filter((p) => p.status === 'ACTIVE' && p.id !== me?.id).length;
  switch (type) {
    case 'START':
      return [
        `Collect ${formatINR(RULES.start.passReward)} every time you pass or land on Start.`,
        state.mode === 'intermediate'
          ? 'Loan payments follow the financial year, not Start: see Bank / Loan.'
          : `Interest on a bank loan is charged ${RULES.loans.interestEveryCircuit ? 'each time' : 'once, the next time'} you pass or land on Start.`,
      ];
    case 'JAIL':
      return [
        `Landing here locks you in Jail for up to ${RULES.jail.maxTurns} turns.`,
        `On each Jail turn: pay ${formatINR(RULES.jail.fine)} to leave and roll, or stay and miss the turn.`,
        `After ${RULES.jail.maxTurns} missed turns you are released. Doubles do not get you out.`,
      ];
    case 'CLUB':
      return [
        `Pay ${formatINR(RULES.club.payEachPlayer)} to every other player.`,
        ...(me ? [`Right now that would cost you ${formatINR(RULES.club.payEachPlayer * others)}.`] : []),
      ];
    case 'REST_HOUSE':
      return [
        `Collect ${formatINR(RULES.restHouse.collectFromEachPlayer)} from every other player, then miss your next turn.`,
        'Sent here by a card? You miss your next turn but collect nothing.',
      ];
    case 'INCOME_TAX':
      return [
        `${formatINR(RULES.incomeTax.perProperty)} for every property you own, at most ${formatINR(RULES.incomeTax.max)}.`,
        ...(me ? [`You would pay ${formatINR(incomeTaxDue(state, me.id).amount)} now.`] : []),
      ];
    case 'WEALTH_TAX':
      return [
        `${formatINR(RULES.wealthTax.perHouse)} per house and ${formatINR(RULES.wealthTax.perHotel)} per hotel you own, at most ${formatINR(RULES.wealthTax.max)}.`,
        ...(me ? [`You would pay ${formatINR(wealthTaxDue(state, me.id).amount)} now.`] : []),
      ];
    case 'CHANCE':
    case 'COMMUNITY_CHEST':
      return [
        `Draw a ${DECK_LABELS[type]} card: the dice total that brought you here picks the even or odd table, and the entry with that number.`,
      ];
  }
}
