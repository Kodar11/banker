/**
 * The player-facing rulebook (Settings → House rules). One ranked list, written from the values the
 * engine enforces: every amount, limit and count below is read from BUSINESS_MVP_RULES or the deed
 * data, never typed in. Change a rule there and this text follows.
 */
import { getDeed, groupMembers, PROPERTY_KEYS, type PropertyDeed } from './businessBoard.ts';
import { formatINR } from './format.ts';
import { defaultGameConfig, type GameConfig } from './gameConfig.ts';
import { BUSINESS_MVP_RULES as R } from './rules.ts';
import { unmortgageCost } from './selectors.ts';

export interface RuleEntry {
  title: string;
  /** Short statements, most important first. */
  lines: readonly string[];
  /** A worked example for rules that need one. */
  example?: string;
}

export interface RuleSection {
  id: 'property-money' | 'squares-cards' | 'game-flow';
  title: string;
  /** Ranked: the rules needed most often, and argued about most, come first. */
  rules: readonly RuleEntry[];
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const times = (n: number) => (n === 2 ? 'doubles' : `multiplies by ${n}`);

const startReward = formatINR(R.start.passReward);
const groupSize = groupMembers('BLUE').length;
const sellBack = percent(R.building.sellBackRate);
const mortgageInterest = percent(R.mortgage.unmortgageInterestRate);
const loanRate = `${R.loans.interestRatePercent}%`;
const colourSet = R.rent.sameColorThreshold;

/** The host's settings the rulebook quotes. Outside a game: the standard values. */
export type RulebookConfig = Pick<GameConfig, 'startingCash' | 'loanLimit'>;
const STANDARD: RulebookConfig = defaultGameConfig('classic');

/** Worked examples use a real deed, so their numbers are the ones players will see in the game. */
const EXAMPLE = getDeed('MUMBAI');
const exampleLoan = 5000;

function transportRentLine(deed: PropertyDeed): string | null {
  if (deed.kind !== 'TRANSPORT_UTILITY') return null;
  const partner = getDeed(deed.rent.pairedWith).name;
  return deed.rent.type === 'FIXED'
    ? `${deed.name}: ${formatINR(deed.rent.base)}, or ${formatINR(deed.rent.pairedRent)} when the same owner also holds ${partner}.`
    : `${deed.name}: ${formatINR(deed.rent.multiplier)} × the dice total, or ${formatINR(deed.rent.pairedMultiplier)} × the dice total when the same owner also holds ${partner}.`;
}

/** The five rules that explain most of the game, for a game with these settings. Shown first, numbered. */
export function topRules(config: RulebookConfig = STANDARD): readonly RuleEntry[] {
  return [
    {
      title: 'Take turns, roll, and move',
      lines: [
        `Roll ${R.dice.count === 2 ? 'two' : R.dice.count} dice and move your token around the board.`,
        `Collect ${startReward} whenever a forward move passes or lands on Start.`,
        R.dice.doublesGrantExtraRoll ? 'Doubles give you another roll.' : 'Doubles do not give an extra roll.',
      ],
    },
    {
      title: 'Buy properties and collect rent',
      lines: [
        'Buy an available property when you land on it.',
        'If another player owns it, pay the rent shown on its deed.',
        'A mortgaged property collects no rent.',
      ],
    },
    {
      title: 'Own colour sets and build',
      lines: [
        `Owning ${colourSet} or more properties of one colour ${times(R.rent.sameColorMultiplier)} the rent on that colour.`,
        R.building.requireFullGroup
          ? `Own all ${groupSize} properties of a colour before you build on it.`
          : 'Build on any city property you own — you do not need the whole colour.',
        `Build up to ${R.building.maxHouses} houses, then upgrade to a hotel.`,
      ],
    },
    {
      title: 'Manage your money',
      lines: [
        `Everyone starts with ${formatINR(config.startingCash)}.`,
        'Pay rent, taxes and special-square charges when they fall due.',
        'Short of cash? Take a loan, mortgage, sell buildings or trade. If you still cannot pay, you go bankrupt.',
      ],
    },
    {
      title: 'Trade, negotiate, and win',
      lines: [
        'Offer properties and money to another player. Nothing changes until they accept.',
        'Keep track of your mortgages and loans.',
        'The last player not bankrupt wins. If the host ends the game early, the highest net worth wins.',
      ],
    },
  ];
}

/** The five top rules at the standard settings. */
export const TOP_RULES: readonly RuleEntry[] = topRules();

/** The full rulebook for a game with these settings. */
export function ruleSections(config: RulebookConfig = STANDARD): readonly RuleSection[] {
  return [
    {
      id: 'property-money',
      title: 'Property and money',
      rules: [
        {
          title: 'Buying and auctions',
          lines: [
            'When you land on a property nobody owns, you may buy it for the price on its deed.',
            `If you decline, it is auctioned. Every player still in the game may bid${R.auction.declinerMayBid ? ', including the player who declined' : ', except the player who declined'}.`,
            `The first bid must be at least ${formatINR(R.auction.minimumOpeningBid)}. Each later bid must be at least ${formatINR(R.auction.minimumIncrement)} higher. You cannot bid more than your cash.`,
            `A ${R.auction.openingTimerSeconds}-second countdown starts with the auction, and every accepted bid restarts it at ${R.auction.bidTimerSeconds} seconds.`,
            'When the countdown ends, or everyone else has passed, the highest bidder pays their bid and gets the property. With no bids, or if the winner no longer has the money, it stays with the bank.',
          ],
          example: `Bids of ${formatINR(R.auction.minimumOpeningBid)}, then ${formatINR(R.auction.minimumOpeningBid + R.auction.minimumIncrement)}: if nobody bids again within ${R.auction.bidTimerSeconds} seconds, the second bidder pays ${formatINR(R.auction.minimumOpeningBid + R.auction.minimumIncrement)}.`,
        },
        {
          title: 'Rent',
          lines: [
            'Rent is read from the deed: site only, 1, 2 or 3 houses, or hotel.',
            `If the owner holds ${colourSet} or more properties of that colour, the rent ${R.rent.sameColorMultiplier === 2 ? 'is doubled' : `is multiplied by ${R.rent.sameColorMultiplier}`} — with houses and hotels too.${R.rent.sameColorCountsMortgaged ? ` Mortgaged properties still count towards the ${colourSet}.` : ''}`,
            'A mortgaged property collects no rent, whatever is built on it.',
            'Landing on your own property costs nothing. An owner who is in Jail or resting still collects rent.',
          ],
          example: `${EXAMPLE.name} with 1 house: ${formatINR(EXAMPLE.kind === 'CITY' ? EXAMPLE.rent[1] : 0)}. If its owner holds ${colourSet} properties of that colour: ${formatINR((EXAMPLE.kind === 'CITY' ? EXAMPLE.rent[1] : 0) * R.rent.sameColorMultiplier)}.`,
        },
        {
          title: 'Transport and utility rent',
          lines: [
            ...PROPERTY_KEYS.map((key) => transportRentLine(getDeed(key))).filter((line): line is string => line !== null),
            R.property.pairCountsMortgagedPartner
              ? 'The higher rent applies even when the partner property is mortgaged.'
              : 'The higher rent applies only while the partner property is not mortgaged.',
            'These properties belong to no colour, so their rent is never doubled. Nothing can be built on them.',
          ],
        },
        {
          title: 'Mortgages',
          lines: [
            'Mortgage a property you own to receive the mortgage value printed on its deed.',
            'The property stays yours, and so do its houses or hotel. You are paid nothing extra for them.',
            'While it is mortgaged it collects no rent, and you cannot build on it, sell its buildings or sell it to the bank.',
            `To unmortgage, pay the mortgage value plus ${mortgageInterest}. Your buildings are active again at once — you do not buy them again.`,
          ],
          example: `${EXAMPLE.name} with 2 houses: mortgage it and receive ${formatINR(EXAMPLE.mortgageValue)}. You keep ${EXAMPLE.name} and both houses, but collect no rent. Pay ${formatINR(unmortgageCost(EXAMPLE.key))} to unmortgage, and both houses earn rent again.`,
        },
        {
          title: 'Building and selling',
          lines: [
            R.building.requireFullGroup
              ? `You can build on a property only when you own all ${groupSize} properties of its colour, during your own turn, and while that property is not mortgaged.`
              : 'You can build on any city property you own, even if it is your only one of that colour. Build during your own turn, and only while that property is not mortgaged.',
            `Each house costs the house price on the deed, up to ${R.building.maxHouses} houses. A hotel costs the hotel price and replaces the ${R.building.maxHouses} houses.`,
            `Sell buildings back to the bank for ${sellBack} of what they cost. Houses are sold one at a time.`,
            `A hotel is sold whole for ${sellBack} of the hotel price plus the ${R.building.maxHouses} houses it replaced, and leaves the site empty.`,
            'A property with no buildings and no mortgage can be sold to the bank for its mortgage value.',
          ],
          example:
            EXAMPLE.kind === 'CITY'
              ? `${EXAMPLE.name}: a house costs ${formatINR(EXAMPLE.houseCost)} and sells back for ${formatINR(Math.floor(EXAMPLE.houseCost * R.building.sellBackRate))}. Its hotel sells back for ${formatINR(Math.floor((EXAMPLE.hotelCost + EXAMPLE.houseCost * R.building.maxHouses) * R.building.sellBackRate))}.`
              : undefined,
        },
        {
          title: 'Loans',
          lines: [
            `Borrow from the bank at any time: at least ${formatINR(R.loans.minAmount)}, in steps of ${formatINR(R.loans.step)}, with no more than ${formatINR(config.loanLimit)} owed at once.`,
            `Interest is ${loanRate} of the amount you borrowed. It is charged ${R.loans.interestEveryCircuit ? 'each time' : 'once, the next time'} a forward move takes you past or onto Start.`,
            'Repay the whole loan before then and you pay no interest.',
            'Repay the amount you borrowed whenever you like, in part or in full.',
          ],
          example: `Borrow ${formatINR(exampleLoan)} and receive ${formatINR(exampleLoan)}. At your next Start you pay ${formatINR(Math.round((exampleLoan * R.loans.interestRatePercent) / 100))} interest${R.loans.interestEveryCircuit ? '' : ', once'}. You still owe ${formatINR(exampleLoan)} until you repay it.`,
        },
        {
          title: 'Trading',
          lines: [
            'Offer any mix of properties and money to another player, at any time. The trade must include at least one property.',
            'Nothing changes until the other player accepts. They may reject it, and you may cancel it.',
            R.trades.requireNoBuildings
              ? 'A property with houses or a hotel cannot be traded. Sell the buildings first.'
              : 'A property is traded together with its houses or hotel: they go to the new owner. The offer shows what is built on each property.',
            'If the buildings or mortgage on a property change after an offer is made, that offer is closed. Make a new one.',
            R.trades.allowMortgaged
              ? `A mortgaged property can be traded and stays mortgaged. The new owner pays the mortgage value plus ${mortgageInterest} to unmortgage it.`
              : 'A mortgaged property cannot be traded.',
            'If a property or the money in an offer is no longer there when it is accepted, the whole trade is refused.',
          ],
        },
        {
          title: 'Income Tax and Wealth Taxes',
          lines: [
            `Income Tax: ${formatINR(R.incomeTax.perProperty)} for every property you own, at most ${formatINR(R.incomeTax.max)}. Mortgaged properties count.`,
            `Wealth Taxes: ${formatINR(R.wealthTax.perHouse)} for every house and ${formatINR(R.wealthTax.perHotel)} for every hotel you own, at most ${formatINR(R.wealthTax.max)}. Buildings on mortgaged properties count.`,
            'With nothing to count, you pay nothing.',
          ],
          example: `${R.wealthTax.max / R.wealthTax.perHouse + 2} houses come to ${formatINR((R.wealthTax.max / R.wealthTax.perHouse + 2) * R.wealthTax.perHouse)}, so you pay the maximum of ${formatINR(R.wealthTax.max)}.`,
        },
        {
          title: 'Not enough money and bankruptcy',
          lines: [
            'If you owe more than you have, your turn waits while you raise money: sell buildings, mortgage, sell a property to the bank, take a loan or trade.',
            'If you still cannot pay, you declare bankruptcy and leave the game.',
            'Your remaining cash goes to the player you owe. If you owe the bank or several players at once, it goes to the bank.',
            'Your properties return to the bank with no buildings and no mortgage, and your loans are written off.',
            'Rest House and Birthday collections are the exception: a player who cannot pay their full share pays what they have, and owes nothing more.',
          ],
        },
      ],
    },
    {
      id: 'squares-cards',
      title: 'Special squares and cards',
      rules: [
        {
          title: 'Start',
          lines: [
            `Collect ${startReward} each time a forward move passes or lands on Start.`,
            'One move pays the reward once. Standing on Start pays nothing more.',
            'Interest on a bank loan is charged here.',
          ],
        },
        {
          title: 'Jail',
          lines: [
            'You go to Jail when you land on it or draw a Go to Jail card.',
            `At the start of each of your turns in Jail, choose: pay ${formatINR(R.jail.fine)} and roll as normal, or stay and miss the turn.`,
            `After ${R.jail.maxTurns} missed turns you are released, and you play your next turn as normal.`,
            'Doubles do not get you out. If you cannot pay the fine, you stay.',
          ],
        },
        {
          title: 'Rest House',
          lines: [
            `When your roll lands you here, collect ${formatINR(R.restHouse.collectFromEachPlayer)} from every other player, then miss your next ${R.restHouse.turnsSkippedOnLanding === 1 ? 'turn' : `${R.restHouse.turnsSkippedOnLanding} turns`}.`,
            'A player who cannot pay the full amount pays what they have.',
            'Sent here by a card? You miss your next turn but collect nothing.',
          ],
        },
        {
          title: 'Club',
          lines: [
            `Pay ${formatINR(R.club.payEachPlayer)} to every other player still in the game.`,
            'If you cannot pay it all, the rules for not enough money apply.',
          ],
          example: `With 4 players, landing on Club costs you ${formatINR(R.club.payEachPlayer * 3)}.`,
        },
        {
          title: 'Chance and Community Chest',
          lines: [
            'The dice total that brought you here picks your card: an even total uses the even table, an odd total the odd table, and the total is the card number.',
            'The app applies the card for you, once.',
            `If the app has no entry for that number, read the physical card and enter its amount (up to ${formatINR(R.cards.manualMaxAmount)}).`,
            'Birthday: a player who cannot pay the full amount pays what they have.',
          ],
        },
        {
          title: 'Card moves and the Start reward',
          lines: [
            `Go to Jail and Go to Rest House move you straight there. You do not pass Start and do not collect ${startReward}.`,
            R.cards.goBackToMumbaiDirection === 'FORWARD'
              ? `Go back to Bombay moves you forward to Mumbai, so you collect ${startReward} when you pass Start.`
              : `Go back to Bombay moves you backward to Mumbai, so you do not collect ${startReward}.`,
            R.cards.goBackToMumbaiResolvesLanding
              ? 'You then land on Mumbai as normal: buy it if it is free, or pay rent if another player owns it.'
              : 'Nothing more happens on Mumbai.',
          ],
        },
      ],
    },
    {
      id: 'game-flow',
      title: 'Game flow and resolution',
      rules: [
        {
          title: 'Turn order and dice',
          lines: [
            `${R.players.min} to ${R.players.max} players. When the host starts the game, the turn order is drawn at random and stays fixed.`,
            `On your turn you roll ${R.dice.count === 2 ? 'two' : R.dice.count} dice once, move, deal with the square you land on, then end your turn.`,
            R.dice.doublesGrantExtraRoll ? 'Doubles give you another roll.' : 'Doubles do not give an extra roll.',
            'Trades, loans and payments to other players can be made at any time, not only on your turn.',
            'Mortgaging and selling also work when it is not your turn, but wait while an auction is running.',
          ],
        },
        {
          title: 'Undo',
          lines: [
            'A mistake can be undone: purchases, rent, tax, Club and card money, Rest House collections, building, mortgages, sales, payments between players and trades.',
            `A player involved asks for the undo, and another player must approve it. The last ${R.undo.maxDepth} such actions are kept.`,
            'Undo works newest first: to undo an older action, undo the newer ones before it.',
            'An undo returns the money and puts the properties back exactly as they were. It never moves tokens or re-rolls dice.',
            'Loans, auctions, loan interest and the Jail fine cannot be undone. A bankruptcy clears the undo history.',
          ],
        },
        {
          title: 'Winning',
          lines: [
            'The game ends when only one player is not bankrupt. That player wins.',
            'The host can end the game at any time. The player with the highest net worth then wins.',
          ],
        },
        {
          title: 'Net worth',
          lines: [
            'Your cash,',
            'plus the deed price of every property you own (less its mortgage value if it is mortgaged),',
            `plus what your houses and hotels cost to build (a hotel counts its own price and the ${R.building.maxHouses} houses it replaced),`,
            'minus the bank loans you still owe and any loan interest charged but not yet paid.',
          ],
          example:
            EXAMPLE.kind === 'CITY'
              ? `${formatINR(10000)} cash, ${EXAMPLE.name} with 1 house, and a ${formatINR(exampleLoan)} loan: ${formatINR(10000)} + ${formatINR(EXAMPLE.price)} + ${formatINR(EXAMPLE.houseCost)} − ${formatINR(exampleLoan)} = ${formatINR(10000 + EXAMPLE.price + EXAMPLE.houseCost - exampleLoan)}.`
              : undefined,
        },
        {
          title: 'Leaving, pausing and expiry',
          lines: [
            'A player who leaves keeps their cash and properties, takes no more turns, and is still owed rent. If only one player remains, that player wins.',
            'Any player can pause the game. Nothing can be done while it is paused, and an auction countdown waits.',
            `A game with no activity for ${R.session.ttlHours} hours expires.`,
            `A single payment to another player can be at most ${formatINR(R.transfers.maxAmount)}.`,
          ],
        },
      ],
    },
  ];
}

/** The full rulebook at the standard settings. */
export const RULE_SECTIONS: readonly RuleSection[] = ruleSections();

/** Every rule in reading order — for searching the rulebook and for tests. */
export const ALL_RULES: readonly RuleEntry[] = [...TOP_RULES, ...RULE_SECTIONS.flatMap((s) => s.rules)];
