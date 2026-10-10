import { formatINR } from './format.ts';
import { defaultGameConfig, MARKET_VOLATILITY_LABELS, type GameConfig } from './gameConfig.ts';
import { premiumForYear } from './insurance.ts';
import { INTERMEDIATE_RULES as IR, LOAN_PRODUCT_KEYS } from './intermediateConfig.ts';
import { realValue } from './intermediateFinance.ts';
import { objectiveTerms, OBJECTIVE_IDS, OBJECTIVES } from './objectives.ts';
import type { RuleEntry } from './rulebook.ts';

/**
 * The Intermediate Mode rules as players read them, written from INTERMEDIATE_RULES so the
 * text can never drift from what the engine enforces — including the host's settings for the
 * game being played. Shown only in an Intermediate game, after the Classic rules (which all still apply).
 */

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const L = IR.loans;
const C = IR.credit.events;
const I = IR.insurance;

function secretObjectivesEntry(config: GameConfig): RuleEntry {
  return {
    title: 'Secret objectives',
    lines: [
      'When the game starts each player is dealt one objective. Only you can see yours: it is shown to you when the game starts, and stays under More → My secret objective. It cannot be changed or swapped.',
      `The objectives in play: ${OBJECTIVE_IDS.map((id) => `${OBJECTIVES[id].name} (${formatINR(objectiveTerms(id, config.startingCash).reward)} bonus)`).join(', ')}.`,
      'When the game ends every objective is revealed and checked. A completed one pays its bonus from the bank before the winner is decided.',
      'A player who went bankrupt or left before the end earns no bonus.',
    ],
  };
}

export function intermediateRuleEntries(config: GameConfig = defaultGameConfig('intermediate')): readonly RuleEntry[] {
  return [
    {
      title: 'Financial years',
      lines: [
        `One calendar for the whole table. A new financial year begins each time the players have moved ${IR.year.spacesPerYear} spaces on average, counting dice moves only.`,
        'The count uses everyone who started the game, so it does not speed up when someone leaves or goes bankrupt.',
      ],
      example: `With 3 players, a year is ${3 * IR.year.spacesPerYear} spaces rolled in total.`,
    },
    {
      title: 'Property values',
      lines: [
        `Every new year each property's market value changes on its own: ${IR.market.profiles[config.marketVolatility].map((c) => `${signed(c.percent)}%`).join(', ')}, rounded to the nearest ${formatINR(IR.market.roundTo)}.`,
        `This game's market is ${MARKET_VOLATILITY_LABELS[config.marketVolatility].label}. ${MARKET_VOLATILITY_LABELS[config.marketVolatility].hint}`,
        'The bank sells unowned properties at the current market value. Rent, building costs, mortgage value and the sell-to-bank price stay as printed on the deed.',
        `The ${IR.market.projectionYears}-year figure on a deed is a projection from that property's expected trend, not a promise.`,
      ],
    },
    {
      title: 'Inflation',
      lines: [`Prices rise ${IR.inflation.ratePercent}% a year. Nothing is repriced by it: it shows what a value is worth in Year-1 money.`],
      example: `${formatINR(10000)} after one year buys what ${formatINR(realValue(10000, 1))} did.`,
    },
    {
      title: 'Loans',
      lines: [
        ...LOAN_PRODUCT_KEYS.map((key) => {
          const p = L.products[key];
          return `${p.name}: ${p.baseRatePercent}% ${p.rateType === 'FIXED' ? 'fixed' : 'to start, reviewed yearly'}, ${p.tenureYears} year${p.tenureYears === 1 ? '' : 's'}, up to ${formatINR(p.maxPrincipal)}${p.secured ? ', secured on a property' : ''}.`;
        }),
        `From ${formatINR(L.minAmount)} in steps of ${formatINR(L.step)}; at most ${formatINR(config.loanLimit)} owed in total. No fees.`,
        'One payment a year, the first a full financial year after borrowing. Interest is charged on the principal still owed.',
        'Repay early any time with no penalty: that principal plus the interest built up on it so far.',
      ],
    },
    {
      title: 'Credit score',
      lines: [
        `Everyone starts at ${IR.credit.start} (range ${IR.credit.min}–${IR.credit.max}). It sets the rate of new loans: ${IR.credit.bands.map((b) => `${b.min}+ ${b.adjustPercent === 0 ? 'base rate' : `${signed(b.adjustPercent)} points`}`).join(', ')}.`,
        `On-time payment ${signed(C.ON_TIME_PAYMENT)}, overdue ${signed(C.INSTALLMENT_OVERDUE)}, caught up ${signed(C.CAUGHT_UP)}, default ${signed(C.LOAN_DEFAULT)}, loan repaid ${signed(C.LOAN_REPAID)}, a year with a loan and nothing overdue ${signed(C.CLEAN_YEAR)}.`,
        'A loan you already signed keeps its rate whatever happens to your score.',
      ],
    },
    {
      title: 'Late payments and default',
      lines: [
        `A payment is on time for a quarter of a financial year after it falls due. Then it is overdue, and you cannot borrow until it is paid.`,
        `Unpaid for ${L.graceYears} more full year${L.graceYears === 1 ? '' : 's'}, the loan defaults: everything still owed is payable at once, with no further interest.`,
        'A secured loan in default costs you the pledged property: the bank takes it at market value, pays you any surplus, and you still owe any shortfall.',
        'Default is not bankruptcy. Bankruptcy follows the usual rule.',
      ],
    },
    {
      title: 'Mortgage or collateral — never both',
      lines: [
        'A mortgage works exactly as in Classic: the printed mortgage value, no rent while mortgaged, mortgage value + 10% to redeem.',
        `A Secured Loan pledges a property you own outright (no mortgage, no buildings) for up to ${L.collateralAdvancePercent}% of its market value. It keeps earning rent.`,
        'A pledged property cannot be mortgaged, sold, traded or built on, and a mortgaged property cannot be pledged.',
      ],
    },
    {
      title: 'Property insurance and crises',
      lines: [
        `After the first ${I.firstCrisisSpaces} spaces of average movement, and then every ${I.crisisIntervalSpaces}, a crisis strikes one owned property, picked at random across all players. Its owner owes the bank ${formatINR(I.crisisBill)} at once — whether or not the property is mortgaged.`,
        `Insurance is bought per property: ${formatINR(premiumForYear(1))} in Year 1, ${formatINR(I.premiumStepPerYear)} more each financial year, never above ${formatINR(I.premiumMax)}. You are shown the price and must confirm it.`,
        `A policy lasts ${I.coverageSpaces} spaces of average movement from the moment you buy it and waives one crisis bill on that property. Used or run out, it is over: no refund, no automatic renewal.`,
        'Insurance pays nothing else — not rent, taxes, loans or mortgages. A crisis leaves the property, its buildings and its mortgage exactly as they were. A policy protects the player who bought it, not a later owner.',
        'An unpaid crisis bill stops the game for everyone until it is settled. Raise the money the usual ways: sell a building, sell or mortgage a property, take a loan. Bankruptcy is possible only once none of those is left.',
      ],
      example: `Insuring three properties costs ${formatINR(3 * premiumForYear(1))} in Year 1 and ${formatINR(3 * premiumForYear(4))} in Year 4.`,
    },
    {
      title: 'Net worth',
      lines: ['Cash + properties at market value + buildings at cost − what it costs to redeem your mortgages − loans owed.', 'Net worth is not cash: only cash pays an installment.'],
    },
    ...(config.secretObjectives ? [secretObjectivesEntry(config)] : []),
  ];
}

/** The Intermediate rules at the standard settings. */
export const INTERMEDIATE_RULE_ENTRIES: readonly RuleEntry[] = intermediateRuleEntries();
