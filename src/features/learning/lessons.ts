import { BUSINESS_MVP_RULES as RULES, formatINR as inr, INTERMEDIATE_RULES as IR, type PropertyGroup } from '@/engine/index.ts';
import {
  cashAfter,
  classicLoanInterest,
  creditScoresAfter,
  futureValue,
  growthSeries,
  houseSellBack,
  incomeTaxFor,
  mortgageTerms,
  netCashFlow,
  presentValue,
  repaymentSchedule,
  totalRepaid,
} from './calc';
import type { CompareScene, Lesson, LessonCollection, NoteScene, SceneBlock, StoryCard } from './types';

/**
 * The 15 Financial Learning stories. Content only — every lesson is rendered by the one lesson
 * player. Each story is a fixed, self-contained scenario: its figures are stated here (or derived
 * from them by calc.ts and the game's own rule set) and never come from a live game.
 */

export const LESSON_COLLECTIONS: readonly LessonCollection[] = [
  { id: 'cash', title: 'Cash & Liquidity', icon: '💰', blurb: 'Having money when the bill arrives.' },
  { id: 'property', title: 'Property & Investment', icon: '🏘️', blurb: 'What an asset is worth, and to whom.' },
  { id: 'debt', title: 'Debt & Credit', icon: '🏦', blurb: 'Borrowing, repaying and what it costs.' },
  { id: 'strategy', title: 'Negotiation & Strategy', icon: '🤝', blurb: 'Deals, limits and looking ahead.' },
];

const card = (name: string, group: PropertyGroup, detail?: string, tag?: string, faded?: boolean): StoryCard => ({ name, group, detail, tag, faded });
const note = (text: string, tone: NoteScene['tone'] = 'neutral'): NoteScene => ({ kind: 'note', tone, text });
const percent = (n: number) => `${n}%`;
const DOUBLED = `Rent ×${RULES.rent.sameColorMultiplier}`;

// ---------------------------------------------------------------------------
// 01 — Rich on Paper, Broke in Cash
// ---------------------------------------------------------------------------

const L01 = (() => {
  const cash = 1000;
  const sites = 10;
  const tax = incomeTaxFor(sites);
  const hopedRent = 800;
  const small = { paid: 3000, mortgageValue: 1500 };
  const loan = RULES.loans.minAmount;
  const valuable = [card('Lake View', 'BLUE', inr(6000)), card('Hill Road', 'GREEN', inr(4500)), card('Market Street', 'PINK', inr(4000))];
  const afterTax = cashAfter(cash, [-tax]).end;
  const afterSale = cashAfter(cash, [small.mortgageValue, -tax]).end;
  const afterLoan = cashAfter(cash, [loan, -tax]).end;
  const lesson: Lesson = {
    id: 'L01',
    slug: 'rich-on-paper',
    number: 1,
    title: 'Rich on Paper, Broke in Cash',
    collectionId: 'cash',
    estimatedDurationSeconds: 45,
    summary: 'Three valuable sites, almost no cash, and a tax bill.',
    visualType: 'cash',
    situation: {
      title: 'Tax day',
      text: `You own ${sites} sites — three of them valuable — but only ${inr(cash)} in cash. You land on Income Tax: ${inr(tax)}. The ${inr(hopedRent)} rent you are hoping for has not arrived.`,
      scene: [
        { kind: 'holdings', holders: [{ who: 'you', cash, cards: valuable, note: `+ ${sites - valuable.length} smaller sites` }] },
        note(`Income Tax is ${inr(RULES.incomeTax.perProperty)} for every property you own, at most ${inr(RULES.incomeTax.max)}.`),
      ],
    },
    decisionPrompt: `How do you handle the ${inr(tax)} tax?`,
    choices: [
      {
        id: 'a',
        label: 'Keep everything, pay the tax',
        description: `Pay ${inr(tax)} from the cash you have.`,
        outcome: {
          headline: `Tax paid from cash: ${inr(afterTax)} left.`,
          text: `Every site is still yours, but only ${inr(afterTax)} stands between you and the next bill.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Income Tax', amount: -tax }] },
            note(`The ${inr(hopedRent)} rent is still only a possibility. It cannot pay a bill that is due today.`),
          ],
        },
      },
      {
        id: 'b',
        label: 'Sell a site',
        description: 'Give up an asset to hold more cash.',
        outcome: {
          headline: `A small site sold to the bank for ${inr(small.mortgageValue)}: ${inr(afterSale)} left after tax.`,
          text: `No player has made an offer, so the bank is the only buyer — and it pays the mortgage value, half of the ${inr(small.paid)} you paid.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Old Bazaar sold to the bank', amount: small.mortgageValue }, { label: 'Income Tax', amount: -tax }] },
            { kind: 'holdings', holders: [{ who: 'bank', cards: [card('Old Bazaar', 'PURPLE', `Paid ${inr(small.paid)}`, 'Sold', true)] }] },
            note(`The tax was payable without selling. The sale bought a bigger cushion at the price of a site and its rent.`),
          ],
        },
      },
      {
        id: 'c',
        label: 'Borrow from the bank',
        description: 'Take a loan — if you are eligible and the cost makes sense.',
        outcome: {
          headline: `Borrowed ${inr(loan)}: ${inr(afterLoan)} in cash, ${inr(loan)} owed.`,
          text: `You are eligible here: ${inr(loan)} is the smallest bank loan and you owe nothing else. It costs ${inr(classicLoanInterest(loan))} interest, and the ${inr(loan)} still has to be repaid.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Bank loan', amount: loan }, { label: 'Income Tax', amount: -tax }] },
            {
              kind: 'schedule',
              title: 'What the loan adds',
              rows: [
                { when: 'Next Start', label: `Interest (${percent(RULES.loans.interestRatePercent)})`, amount: classicLoanInterest(loan), status: 'upcoming' },
                { when: 'Later', label: 'Repay the loan', amount: loan, status: 'upcoming' },
              ],
            },
          ],
        },
      },
    ],
    boardLesson: 'Owning assets does not guarantee having cash available when a bill is due.',
    realLifeConnection: 'Net worth and liquidity are different. Valuable assets may not be easy to turn into cash immediately.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 02 — The Auction Temptation
// ---------------------------------------------------------------------------

const L02 = (() => {
  const cash = 6000;
  const reserve = { label: 'Upcoming tax and installment', amount: 2000 };
  const site = card('Harbour Road', 'BLUE');
  const planNote = note(`The ${inr(reserve.amount)} reserve is your own plan in this story. The game does not hold cash back for you.`);
  const lesson: Lesson = {
    id: 'L02',
    slug: 'auction-temptation',
    number: 2,
    title: 'The Auction Temptation',
    collectionId: 'cash',
    estimatedDurationSeconds: 45,
    summary: 'A valuable site, a rising price and bills on the way.',
    visualType: 'auction',
    situation: {
      title: 'Going once…',
      text: `A valuable site is up for auction. You have ${inr(cash)} — but a tax and a loan installment coming up may need ${inr(reserve.amount)}.`,
      scene: [
        { kind: 'auction', card: site, bids: [{ who: 'meera', amount: 3000 }], winner: null, open: true },
        { kind: 'cash', start: cash, movements: [], reserve },
      ],
    },
    decisionPrompt: 'How far do you go?',
    choices: [
      {
        id: 'a',
        label: `Bid up to ${inr(cash)}`,
        description: 'Use everything you have if that is what it takes.',
        outcome: {
          headline: `You win at ${inr(5000)} with ${inr(1000)} left — ${inr(1000)} short of your reserve.`,
          text: `The site is yours. If the ${inr(reserve.amount)} of bills arrive, you will have to raise ${inr(1000)} some other way.`,
          scene: [
            { kind: 'auction', card: site, bids: [{ who: 'meera', amount: 3000 }, { who: 'you', amount: 3500 }, { who: 'kabir', amount: 4500 }, { who: 'you', amount: 5000 }], winner: 'you' },
            { kind: 'cash', start: cash, movements: [{ label: 'Winning bid', amount: -5000 }], reserve },
            planNote,
          ],
        },
      },
      {
        id: 'b',
        label: `Set a ${inr(4000)} maximum`,
        description: `Decide your limit first and keep ${inr(reserve.amount)} back.`,
        outcome: {
          headline: `Kabir wins at ${inr(4500)}. You keep ${inr(cash)} and your reserve.`,
          text: 'You stopped where you had planned to. The site went to someone willing to pay more than your limit.',
          scene: [
            { kind: 'auction', card: site, bids: [{ who: 'meera', amount: 3000 }, { who: 'you', amount: 3500 }, { who: 'kabir', amount: 4500 }], winner: 'kabir', limit: { label: 'Your maximum', amount: 4000 } },
            { kind: 'cash', start: cash, movements: [], reserve },
            planNote,
          ],
        },
      },
      {
        id: 'c',
        label: 'Skip the auction',
        description: 'Keep all your cash for what is coming.',
        outcome: {
          headline: `You do not bid. Kabir buys it for ${inr(3500)}; you keep ${inr(cash)}.`,
          text: 'All your cash stays free for other needs — and a site that went for a modest price now belongs to Kabir.',
          scene: [
            { kind: 'auction', card: site, bids: [{ who: 'meera', amount: 3000 }, { who: 'kabir', amount: 3500 }], winner: 'kabir' },
            { kind: 'cash', start: cash, movements: [], reserve },
            planNote,
          ],
        },
      },
    ],
    boardLesson: 'Set a maximum bid before emotions influence the decision.',
    realLifeConnection: 'Opportunity cost: money spent on one opportunity cannot be used for another.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 03 — Income Is Not the Same as Cash Flow
// ---------------------------------------------------------------------------

const L03 = (() => {
  const cash = 1500;
  const rent = 2000;
  const tax = 500;
  const installment = 2000;
  const bills = tax + installment;
  const net = netCashFlow([rent], [tax, installment]);
  const house = 2000;
  const extra = 500;
  const netNote = note(`Rent received ${inr(rent)} − bills ${inr(bills)} = ${inr(net)} net, before any other transaction.`);
  const spent = cashAfter(cash, [rent, -house]).end;
  const reserved = cashAfter(cash, [rent, -tax, -installment]).end;
  const reduced = cashAfter(cash, [rent, -tax, -installment, -extra]).end;
  const lesson: Lesson = {
    id: 'L03',
    slug: 'income-vs-cash-flow',
    number: 3,
    title: 'Income Is Not the Same as Cash Flow',
    collectionId: 'cash',
    estimatedDurationSeconds: 45,
    summary: 'Rent comes in. Bigger bills are about to go out.',
    visualType: 'cash',
    situation: {
      title: 'Rent day',
      text: `Your properties bring in ${inr(rent)} of rent this round. A ${inr(tax)} tax and a ${inr(installment)} loan installment are also due. You started with ${inr(cash)}.`,
      scene: [
        { kind: 'cash', start: cash, movements: [{ label: 'Rent received', amount: rent }] },
        {
          kind: 'schedule',
          title: 'Due this round',
          rows: [
            { when: 'This round', label: 'Tax', amount: tax, status: 'due' },
            { when: 'This round', label: 'Loan installment', amount: installment, status: 'due' },
          ],
        },
      ],
    },
    decisionPrompt: `What do you do with the ${inr(rent)}?`,
    choices: [
      {
        id: 'a',
        label: 'Spend the rent',
        description: `Income arrived — build a ${inr(house)} house.`,
        outcome: {
          headline: `House built. ${inr(spent)} left against ${inr(bills)} of bills: ${inr(bills - spent)} short.`,
          text: 'The rent was real, but it was already spoken for.',
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Rent received', amount: rent }, { label: 'House built', amount: -house }] },
            note(`${inr(bills)} is due and you hold ${inr(spent)}. The bills cannot be paid from cash: you must first raise ${inr(bills - spent)} — mortgage, sell or borrow.`, 'warn'),
            netNote,
          ],
        },
      },
      {
        id: 'b',
        label: 'Reserve it for the bills',
        description: 'Pay what is due before anything else.',
        outcome: {
          headline: `Bills paid in full. Cash goes from ${inr(cash)} to ${inr(reserved)}.`,
          text: `${inr(rent)} came in and ${inr(bills)} went out. The ${inr(-net)} difference came from the cash you already had.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Rent received', amount: rent }, { label: 'Tax', amount: -tax }, { label: 'Loan installment', amount: -installment }] },
            netNote,
          ],
        },
      },
      {
        id: 'c',
        label: 'Pay the bills, then cut debt',
        description: 'Put some of what remains towards the loan — if enough is left.',
        outcome: {
          headline: `Bills paid, plus ${inr(extra)} extra off the loan. ${inr(reduced)} left.`,
          text: `After the bills ${inr(reserved)} remained — enough to pay ${inr(extra)} more. Less debt means less interest later, and a thinner cushion now.`,
          scene: [
            {
              kind: 'cash',
              start: cash,
              movements: [
                { label: 'Rent received', amount: rent },
                { label: 'Tax', amount: -tax },
                { label: 'Loan installment', amount: -installment },
                { label: 'Extra loan payment', amount: -extra },
              ],
            },
            netNote,
          ],
        },
      },
    ],
    boardLesson: 'Rent received is not necessarily money available to spend.',
    realLifeConnection: 'Cash flow is money received minus money paid. Timing matters as well as totals.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 04 — Present Value: ₹10,000 Today or Later?
// ---------------------------------------------------------------------------

const L04 = (() => {
  const today = 10000;
  const future = 12000;
  const years = 2;
  const ratePercent = 10;
  const pv = presentValue(future, ratePercent, years);
  const grown = futureValue(today, ratePercent, years);
  const scene = (taken: 'today' | 'future' | 'both'): SceneBlock[] => [
    { kind: 'presentValue', today, future, years, ratePercent, taken },
    note('An illustrative comparison. Real-life risk, taxes and whether the payment actually arrives can change the result.'),
  ];
  const lesson: Lesson = {
    id: 'L04',
    slug: 'present-value',
    number: 4,
    title: `Present Value: ${inr(today)} Today or Later?`,
    collectionId: 'cash',
    estimatedDurationSeconds: 60,
    summary: 'Is a bigger payment later really bigger?',
    visualType: 'presentValue',
    situation: {
      title: 'Now or later',
      text: `You can receive ${inr(today)} today or ${inr(future)} after ${years} years. Assume the later payment is guaranteed, and that money in hand could earn ${percent(ratePercent)} a year.`,
      scene: [{ kind: 'presentValue', today, future, years, ratePercent, taken: 'both', hideDiscount: true }],
    },
    decisionPrompt: 'Which do you take?',
    choices: [
      {
        id: 'a',
        label: `Take ${inr(today)} today`,
        description: 'Money now, to use or to grow.',
        outcome: {
          headline: `${inr(today)} in hand. At ${percent(ratePercent)} a year it could become ${inr(grown)} in ${years} years.`,
          text: `That is ${inr(grown - future)} more than the ${inr(future)} you turned down — if the ${percent(ratePercent)} return really is available.`,
          scene: scene('today'),
        },
      },
      {
        id: 'b',
        label: `Wait for ${inr(future)}`,
        description: `A larger amount, ${years} years away.`,
        outcome: {
          headline: `You wait ${years} years for ${inr(future)} — worth about ${inr(pv)} in today’s money.`,
          text: `At a ${percent(ratePercent)} alternative return, that is ${inr(today - pv)} less than the ${inr(today)} offered today. Waiting is not free.`,
          scene: scene('future'),
        },
      },
      {
        id: 'c',
        label: 'Compare both first',
        description: 'Put the two amounts on the same date before choosing.',
        outcome: {
          headline: `Side by side in today’s money: ${inr(today)} against about ${inr(pv)}.`,
          text: 'Under these assumptions the payment today is slightly ahead. A lower alternative return would tip it the other way.',
          scene: scene('both'),
        },
      },
    ],
    boardLesson: 'A larger future payment is not automatically the better deal.',
    realLifeConnection: 'Present value accounts for time and the return available on money today.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 05 — Complete the Colour Group?
// ---------------------------------------------------------------------------

const L05 = (() => {
  const cash = 4000;
  const greenRent = 300;
  const doubled = greenRent * RULES.rent.sameColorMultiplier;
  const lakeRent = 700;
  const counter = 3500;
  const greens = (detail: string, tag?: string) => [card('Green Park', 'GREEN', detail, tag), card('Garden Road', 'GREEN', detail, tag)];
  const lake = card('Lake View', 'BLUE', `Rent ${inr(lakeRent)}`);
  const forest = (detail = inr(3000), tag?: string) => card('Forest Lane', 'GREEN', detail, tag);
  const potential = note('Rent is potential, not guaranteed: it is paid only when another player lands on the site.');
  const lesson: Lesson = {
    id: 'L05',
    slug: 'complete-the-colour-group',
    number: 5,
    title: 'Complete the Colour Group?',
    collectionId: 'property',
    estimatedDurationSeconds: 60,
    summary: 'The third Green is on offer — for your best site.',
    visualType: 'trade',
    situation: {
      title: 'The missing third',
      text: `You own two Green sites; Meera owns the third. Owning ${RULES.rent.sameColorThreshold} sites of one colour doubles their rent — but Meera wants your valuable Lake View in exchange.`,
      scene: [
        { kind: 'holdings', holders: [{ who: 'you', cash, cards: [...greens(`Rent ${inr(greenRent)}`), lake] }, { who: 'meera', cards: [forest()] }] },
        { kind: 'trade', title: 'Meera’s offer', left: { who: 'you', gives: [{ card: lake }] }, right: { who: 'meera', gives: [{ card: forest() }] }, status: 'proposed' },
      ],
    },
    decisionPrompt: 'What do you say to Meera?',
    choices: [
      {
        id: 'a',
        label: 'Accept the trade',
        description: 'Lake View for Forest Lane.',
        outcome: {
          headline: `Trade done: three Greens at ${inr(doubled)} rent each. Lake View and its ${inr(lakeRent)} rent are now Meera’s.`,
          text: `You swapped a ${inr(6000)} site for a ${inr(3000)} one to unlock the group.`,
          scene: [
            { kind: 'trade', left: { who: 'you', gives: [{ card: lake }] }, right: { who: 'meera', gives: [{ card: forest() }] }, status: 'accepted' },
            {
              kind: 'holdings',
              title: 'After the trade',
              holders: [
                { who: 'you', cash, cards: [...greens(`Rent ${inr(doubled)}`, DOUBLED), forest(`Rent ${inr(doubled)}`, DOUBLED)] },
                { who: 'meera', cards: [lake] },
              ],
            },
            potential,
          ],
        },
      },
      {
        id: 'b',
        label: 'Make a counteroffer',
        description: `Offer ${inr(counter)} in cash instead of Lake View.`,
        outcome: {
          headline: `Counteroffer accepted: Forest Lane for ${inr(counter)}. You keep Lake View, with ${inr(cash - counter)} cash left.`,
          text: 'You kept your best site and completed the group — and paid with nearly all your cash.',
          scene: [
            {
              kind: 'trade',
              left: { who: 'you', gives: [{ cash: counter }] },
              right: { who: 'meera', gives: [{ card: forest() }] },
              status: 'accepted',
              statusNote: 'In this story Meera accepts. She could just as well have said no.',
            },
            {
              kind: 'holdings',
              title: 'After the trade',
              holders: [
                { who: 'you', cash: cash - counter, cards: [...greens(`Rent ${inr(doubled)}`, DOUBLED), forest(`Rent ${inr(doubled)}`, DOUBLED), lake] },
                { who: 'meera', cash: counter, cards: [] },
              ],
            },
            potential,
          ],
        },
      },
      {
        id: 'c',
        label: 'Keep what you have',
        description: 'Turn the offer down.',
        outcome: {
          headline: 'No trade. Every site stays where it was.',
          text: `Lake View keeps its ${inr(lakeRent)} rent. The Greens stay at ${inr(greenRent)} each, and Meera is free to deal with someone else.`,
          scene: [
            { kind: 'trade', left: { who: 'you', gives: [{ card: lake }] }, right: { who: 'meera', gives: [{ card: forest() }] }, status: 'declined' },
            { kind: 'holdings', holders: [{ who: 'you', cash, cards: [...greens(`Rent ${inr(greenRent)}`), lake] }, { who: 'meera', cards: [forest()] }] },
            potential,
          ],
        },
      },
    ],
    boardLesson: 'Completing a property group can create value, but not at any price.',
    realLifeConnection: 'Opportunity cost and strategic fit: an asset’s value depends partly on what it enables.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 06 — All Your Eggs in One Basket
// ---------------------------------------------------------------------------

const L06 = (() => {
  const cash = 6000;
  const big = 5000;
  const small = 2500;
  const purples = (tag?: string) => [card('Fort Road', 'PURPLE', undefined, tag), card('Palace Lane', 'PURPLE', undefined, tag)];
  const third = (tag?: string) => card('Temple Street', 'PURPLE', inr(big), tag);
  const canal = (tag?: string) => card('Canal Road', 'PINK', inr(small), tag);
  const station = (tag?: string) => card('Station Lane', 'GREEN', inr(small), tag);
  const compare = (chosen: number): CompareScene => ({
    kind: 'compare',
    title: 'Three ways to use the money',
    columns: [
      { title: 'Concentrate', rows: [{ label: 'Cash left', value: inr(cash - big) }, { label: 'Sites', value: '3 in one colour' }, { label: 'Potential rent', value: 'Doubled on all 3' }, { label: 'Exposure', value: 'One area of the board' }] },
      { title: 'Diversify', rows: [{ label: 'Cash left', value: inr(cash - 2 * small) }, { label: 'Sites', value: '4 across 3 colours' }, { label: 'Potential rent', value: 'Smaller, more squares' }, { label: 'Exposure', value: 'Spread out' }] },
      { title: 'Keep cash', rows: [{ label: 'Cash left', value: inr(cash - small) }, { label: 'Sites', value: '3 across 2 colours' }, { label: 'Potential rent', value: 'Smallest' }, { label: 'Exposure', value: 'Least invested' }] },
    ].map((column, i) => (i === chosen ? { ...column, tag: 'Your choice' } : column)),
  });
  const lesson: Lesson = {
    id: 'L06',
    slug: 'eggs-in-one-basket',
    number: 6,
    title: 'All Your Eggs in One Basket',
    collectionId: 'property',
    estimatedDurationSeconds: 50,
    summary: 'One big site in your colour, or two small ones elsewhere?',
    visualType: 'compare',
    situation: {
      title: `Two ways to spend ${inr(cash)}`,
      text: `You have ${inr(cash)} and own two Purple sites. You can buy the third Purple for ${inr(big)}, or two cheaper sites in other areas for ${inr(small)} each.`,
      scene: [
        { kind: 'holdings', holders: [{ who: 'you', cash, cards: purples() }, { who: 'bank', cards: [third(), canal(), station()], note: 'For sale' }] },
      ],
    },
    decisionPrompt: 'Where does the money go?',
    choices: [
      {
        id: 'a',
        label: 'Concentrate on Purple',
        description: `Buy the third Purple for ${inr(big)}.`,
        outcome: {
          headline: `Third Purple bought: rent doubles on all three. ${inr(cash - big)} cash left, everything in one colour.`,
          text: 'The reward is larger when someone lands on Purple — and nothing is earned when they land anywhere else.',
          scene: [{ kind: 'holdings', holders: [{ who: 'you', cash: cash - big, cards: [...purples(DOUBLED), third(DOUBLED)] }] }, compare(0)],
        },
      },
      {
        id: 'b',
        label: 'Diversify',
        description: `Buy two ${inr(small)} sites in different areas.`,
        outcome: {
          headline: `Two sites in new areas: four sites across three colours, ${inr(cash - 2 * small)} cash left.`,
          text: 'More squares can earn rent, each a smaller amount. Spreading out lowers the dependence on one area; it does not remove risk or promise more rent.',
          scene: [{ kind: 'holdings', holders: [{ who: 'you', cash: cash - 2 * small, cards: [...purples(), canal('New'), station('New')] }] }, compare(1)],
        },
      },
      {
        id: 'c',
        label: 'Keep some cash',
        description: `Buy one ${inr(small)} site and hold the rest.`,
        outcome: {
          headline: `One ${inr(small)} site bought. ${inr(cash - small)} stays in cash.`,
          text: 'Less is working for you on the board, and more is ready for a bill or a later opportunity.',
          scene: [{ kind: 'holdings', holders: [{ who: 'you', cash: cash - small, cards: [...purples(), canal('New')] }] }, compare(2)],
        },
      },
    ],
    boardLesson: 'Concentration can bring greater rewards and greater exposure.',
    realLifeConnection: 'Diversification spreads risk, but does not eliminate it or guarantee better returns.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 07 — Market Value vs. Purchase Price
// ---------------------------------------------------------------------------

const L07 = (() => {
  const paid = 5000;
  const market = 4000;
  const rent = 350;
  const hill = card('Hill Road', 'GREEN', `Paid ${inr(paid)}`, `Worth ${inr(market)} now`);
  const prices: CompareScene = {
    kind: 'compare',
    columns: [
      {
        title: 'Hill Road',
        rows: [
          { label: 'Purchase price (past)', value: inr(paid) },
          { label: 'Market value (today)', value: inr(market) },
          { label: 'Kabir’s offer', value: inr(market) },
        ],
      },
    ],
  };
  const lesson: Lesson = {
    id: 'L07',
    slug: 'market-value-vs-purchase-price',
    number: 7,
    title: 'Market Value vs. Purchase Price',
    collectionId: 'property',
    estimatedDurationSeconds: 50,
    summary: 'You paid ₹5,000. Today it is worth ₹4,000.',
    visualType: 'compare',
    situation: {
      title: 'An offer below what you paid',
      text: `You bought Hill Road for ${inr(paid)}. Today its market value is ${inr(market)} — and Kabir offers exactly that.`,
      scene: [{ kind: 'holdings', holders: [{ who: 'you', cards: [hill] }] }, prices],
    },
    decisionPrompt: 'How do you answer Kabir?',
    choices: [
      {
        id: 'a',
        label: `Refuse: you paid ${inr(paid)}`,
        description: 'Do not sell for less than it cost.',
        outcome: {
          headline: `Offer refused. Hill Road is still worth ${inr(market)} today.`,
          text: `Saying no did not bring back the ${inr(paid - market)}. What you paid is in the past; the open question is whether Hill Road is worth more to you than ${inr(market)} in cash.`,
          scene: [
            { kind: 'trade', left: { who: 'you', gives: [{ card: hill }] }, right: { who: 'kabir', gives: [{ cash: market }] }, status: 'declined' },
            prices,
          ],
        },
      },
      {
        id: 'b',
        label: 'Weigh the offer',
        description: `Compare ${inr(market)} now with what holding could bring.`,
        outcome: {
          headline: `Two paths compared: ${inr(market)} in cash now, or the rent and an unknown future price.`,
          text: `Neither column treats the ${inr(paid)} as something you can get back. The choice turns on what each path offers from here.`,
          scene: [
            {
              kind: 'compare',
              columns: [
                { title: 'If you sell', rows: [{ label: 'Cash received', value: inr(market) }, { label: 'Against what you paid', value: inr(market - paid) }, { label: 'Future rent', value: 'None' }, { label: 'Future price', value: 'No longer yours' }] },
                { title: 'If you hold', rows: [{ label: 'Cash received', value: inr(0) }, { label: 'Against what you paid', value: 'Not settled' }, { label: 'Future rent', value: `${inr(rent)} per landing, potential` }, { label: 'Future price', value: 'Unknown' }] },
              ],
            },
          ],
        },
      },
      {
        id: 'c',
        label: 'Hold for a recovery',
        description: 'Keep it and expect the price to come back.',
        outcome: {
          headline: 'You keep Hill Road. Its price may recover, hold or fall.',
          text: `Holding is a real choice with a real cost: the ${inr(market)} you could have used elsewhere. Nothing guarantees a recovery.`,
          scene: [
            {
              kind: 'compare',
              title: 'Three predefined possibilities',
              columns: [
                { title: 'It recovers', rows: [{ label: 'Value later', value: inr(paid) }] },
                { title: 'It holds', rows: [{ label: 'Value later', value: inr(market) }] },
                { title: 'It falls', rows: [{ label: 'Value later', value: inr(3500) }] },
              ],
            },
            note('Examples chosen for this story, not a forecast. Nobody knows which one will happen.'),
          ],
        },
      },
    ],
    boardLesson: 'The amount you paid and the amount an asset is worth now are different.',
    realLifeConnection: 'Sunk cost: past spending cannot be recovered merely by refusing to acknowledge a loss. Future prospects should drive the decision.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 08 — The Power of Compounding
// ---------------------------------------------------------------------------

const L08 = (() => {
  const amount = 5000;
  const ratePercent = 5;
  const years = 5;
  const series = growthSeries(amount, ratePercent, years);
  const final = series[years]!;
  const part = 3000;
  const partFinal = futureValue(part, ratePercent, years);
  const limits = note('Not included: fees, taxes, inflation and how a real investment actually performs. No real investment guarantees a fixed return.');
  const lesson: Lesson = {
    id: 'L08',
    slug: 'power-of-compounding',
    number: 8,
    title: 'The Power of Compounding',
    collectionId: 'property',
    estimatedDurationSeconds: 55,
    summary: 'What five years of reinvested returns can do.',
    visualType: 'growth',
    situation: {
      title: `${inr(amount)} to place`,
      text: `You have ${inr(amount)}. Keep it ready as cash, or put it in a hypothetical option that earns ${percent(ratePercent)} a year with every return reinvested.`,
      scene: [{ kind: 'cash', start: amount, movements: [] }, note(`A hypothetical ${percent(ratePercent)} a year, used only for this story.`)],
    },
    decisionPrompt: `What do you do with the ${inr(amount)}?`,
    choices: [
      {
        id: 'a',
        label: 'Keep it available',
        description: 'Cash you can use at any moment.',
        outcome: {
          headline: `${inr(amount)} stays ${inr(amount)} — ready the moment you need it.`,
          text: `You kept full flexibility and passed up a possible ${inr(final - amount)} of growth.`,
          scene: [
            {
              kind: 'compare',
              columns: [
                { title: 'Kept as cash', tag: 'Your choice', rows: [{ label: 'Today', value: inr(amount) }, { label: `After ${years} years`, value: inr(amount) }, { label: 'Available', value: 'Any time' }] },
                { title: 'If invested', rows: [{ label: 'Today', value: inr(amount) }, { label: `After ${years} years`, value: `About ${inr(final)}` }, { label: 'Available', value: `After ${years} years` }] },
              ],
            },
            limits,
          ],
        },
      },
      {
        id: 'b',
        label: 'Invest all of it',
        description: 'Aim for long-term growth.',
        outcome: {
          headline: `${inr(amount)} grows to about ${inr(final)} in ${years} years.`,
          text: `Each year’s return earns its own return: the first year adds ${inr(series[1]! - series[0]!)}, the last adds ${inr(final - series[years - 1]!)}. In this story the money is not available along the way.`,
          scene: [{ kind: 'growth', title: 'Year by year', subject: 'Hypothetical investment', principal: amount, ratePercent, years }, limits],
        },
      },
      {
        id: 'c',
        label: 'Invest what you can spare',
        description: `Invest ${inr(part)}; keep ${inr(amount - part)} for near-term needs.`,
        outcome: {
          headline: `${inr(part)} invested grows to about ${inr(partFinal)}; ${inr(amount - part)} stays ready as cash.`,
          text: `About ${inr(partFinal + amount - part)} in total after ${years} years — less growth than investing everything, with a cushion you can reach.`,
          scene: [
            { kind: 'growth', title: `The invested ${inr(part)}`, subject: 'Hypothetical investment', principal: part, ratePercent, years },
            { kind: 'cash', title: 'Kept ready', start: amount - part, movements: [] },
            limits,
          ],
        },
      },
    ],
    boardLesson: 'Small changes can accumulate over time.',
    realLifeConnection: 'Compounding earns returns on the original amount and on previously accumulated returns. Actual investments do not guarantee a fixed return.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 09 — The Loan That Looks Cheap
// ---------------------------------------------------------------------------

export const LOAN_STORY = {
  principal: 10000,
  years: 3,
  fixedRatePercent: 10,
  variableStartPercent: 7,
  variablePaths: [
    { label: 'Rates fall', ratesByYear: [7, 6, 5] },
    { label: 'Rates hold', ratesByYear: [7, 7, 7] },
    { label: 'Rates jump', ratesByYear: [7, 13, 16] },
  ],
};

const L09 = (() => {
  const { principal, years, fixedRatePercent, variableStartPercent, variablePaths } = LOAN_STORY;
  const fixed = repaymentSchedule(principal, Array.from({ length: years }, () => fixedRatePercent));
  const fixedTotal = totalRepaid(fixed);
  const [, hold, jump] = variablePaths.map((p) => totalRepaid(repaymentSchedule(principal, p.ratesByYear)));
  const firstVariable = repaymentSchedule(principal, variablePaths[1]!.ratesByYear)[0]!.payment;
  const scene = (focus: 'fixed' | 'variable' | 'both'): SceneBlock[] => [
    { kind: 'loanComparison', principal, years, fixedRatePercent, variablePaths, focus },
    note('The rate paths are hypothetical examples made for this story. They are not a forecast, and not the game’s own rate rules.'),
  ];
  const lesson: Lesson = {
    id: 'L09',
    slug: 'loan-that-looks-cheap',
    number: 9,
    title: 'The Loan That Looks Cheap',
    collectionId: 'debt',
    estimatedDurationSeconds: 60,
    summary: 'A 7% rate that can move, or 10% that cannot.',
    visualType: 'loanComparison',
    situation: {
      title: 'Two offers, one loan',
      text: `The bank will lend ${inr(principal)} over ${years} years: at a variable rate that starts at ${percent(variableStartPercent)}, or at a fixed ${percent(fixedRatePercent)}.`,
      scene: [
        {
          kind: 'compare',
          columns: [
            { title: 'Variable', rows: [{ label: 'Rate now', value: percent(variableStartPercent) }, { label: 'Rate later', value: 'Reviewed every year' }, { label: 'First payment', value: inr(firstVariable) }] },
            { title: 'Fixed', rows: [{ label: 'Rate now', value: percent(fixedRatePercent) }, { label: 'Rate later', value: `${percent(fixedRatePercent)}, unchanged` }, { label: 'First payment', value: inr(fixed[0]!.payment) }] },
          ],
        },
      ],
    },
    decisionPrompt: 'Which loan do you take?',
    choices: [
      {
        id: 'a',
        label: 'The lower starting rate',
        description: `Variable, from ${percent(variableStartPercent)}.`,
        outcome: {
          headline: `First payment ${inr(firstVariable)} instead of ${inr(fixed[0]!.payment)}. What follows depends on where rates go.`,
          text: `If rates hold you repay ${inr(hold!)} in total; in the sharp-rise example, ${inr(jump!)} — more than the fixed loan’s ${inr(fixedTotal)}.`,
          scene: scene('variable'),
        },
      },
      {
        id: 'b',
        label: 'The predictable fixed rate',
        description: `Fixed at ${percent(fixedRatePercent)} for every year.`,
        outcome: {
          headline: `About ${inr(fixed[0]!.payment)} a year, known in advance: ${inr(fixedTotal)} in total.`,
          text: `You pay for certainty. Had rates held at ${percent(variableStartPercent)}, the variable loan would have cost ${inr(fixedTotal - hold!)} less; in the sharp-rise example it costs ${inr(jump! - fixedTotal)} more.`,
          scene: scene('fixed'),
        },
      },
      {
        id: 'c',
        label: 'Compare the schedules',
        description: 'Test the variable loan against higher and lower rates.',
        outcome: {
          headline: 'Three hypothetical rate paths against one fixed schedule.',
          text: 'The variable loan costs less in two of these examples and more in one. The trade is a lower likely cost against a payment you can count on.',
          scene: scene('both'),
        },
      },
    ],
    boardLesson: 'The lowest starting rate does not necessarily mean the lowest eventual cost.',
    realLifeConnection: 'Compare total repayment, affordability, and exposure to interest-rate changes.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 10 — Borrowing vs. Waiting
// ---------------------------------------------------------------------------

const L10 = (() => {
  const price = 8000;
  const cash = 5000;
  const gap = price - cash;
  const product = IR.loans.products.PERSONAL;
  const schedule = repaymentSchedule(gap, Array.from({ length: product.tenureYears }, () => product.baseRatePercent));
  const installment = schedule[0]!.payment;
  const total = totalRepaid(schedule);
  const lapReward = RULES.start.passReward;
  const laps = Math.ceil(gap / lapReward);
  const income = 3000;
  const costs = 1200;
  const free = income - costs;
  const site = (tag?: string) => card('Harbour Road', 'BLUE', inr(price), tag);
  const repayments: SceneBlock = {
    kind: 'schedule',
    title: `Repaying ${inr(gap)} at ${percent(product.baseRatePercent)}`,
    rows: schedule.map((line) => ({ when: `Year ${line.year}`, label: 'Installment', amount: line.payment, status: 'upcoming' as const })),
  };
  const lesson: Lesson = {
    id: 'L10',
    slug: 'borrowing-vs-waiting',
    number: 10,
    title: 'Borrowing vs. Waiting',
    collectionId: 'debt',
    estimatedDurationSeconds: 55,
    summary: 'The site costs ₹3,000 more than you have.',
    visualType: 'schedule',
    situation: {
      title: `${inr(gap)} short`,
      text: `Harbour Road costs ${inr(price)}. You have ${inr(cash)}. A ${product.tenureYears}-year bank loan at ${percent(product.baseRatePercent)} would cover the ${inr(gap)} gap — and bring a yearly installment.`,
      scene: [
        { kind: 'holdings', holders: [{ who: 'you', cash, cards: [] }, { who: 'bank', cards: [site()], note: 'For sale' }] },
        { kind: 'compare', columns: [{ title: 'The gap', rows: [{ label: 'Price', value: inr(price) }, { label: 'Your cash', value: inr(cash) }, { label: 'Missing', value: inr(gap) }] }] },
      ],
    },
    decisionPrompt: 'Do you borrow to buy?',
    choices: [
      {
        id: 'a',
        label: 'Borrow and buy',
        description: `Take the ${inr(gap)} loan and buy now.`,
        outcome: {
          headline: `Harbour Road is yours. Cash ${inr(0)}, and about ${inr(installment)} due each year for ${product.tenureYears} years.`,
          text: `In total you repay ${inr(total)} — ${inr(total - gap)} of it interest. Being lent the money and being able to carry the payments are separate questions.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Bank loan', amount: gap }, { label: 'Harbour Road bought', amount: -price }] },
            { kind: 'holdings', holders: [{ who: 'you', cash: 0, cards: [site('New')] }] },
            repayments,
            note(`Eligible in this story: ${inr(gap)} is within this loan’s ${inr(product.maxPrincipal)} maximum and the ${inr(IR.loans.maxOutstandingPrincipal)} total a player may owe.`),
          ],
        },
      },
      {
        id: 'b',
        label: 'Wait and save',
        description: 'Build up the cash first.',
        outcome: {
          headline: `${laps} laps of Start rewards take you from ${inr(cash)} to ${inr(cash + laps * lapReward)} — if the site is still for sale.`,
          text: 'No debt and no interest. The cost of waiting is the chance that the opportunity is gone.',
          scene: [
            { kind: 'cash', start: cash, movements: Array.from({ length: laps }, (_, i) => ({ label: `Start reward, lap ${i + 1}`, amount: lapReward })), endLabel: 'Cash after saving' },
            note('Assumes nothing else is spent meanwhile. Harbour Road stays for sale during those laps: another player may buy it first — or may not.', 'warn'),
          ],
        },
      },
      {
        id: 'c',
        label: 'Buy only if cash flow supports it',
        description: 'Check the yearly payment against what you expect to earn.',
        outcome: {
          headline: `Projected: ${inr(free)} a year free against an installment of about ${inr(installment)} — a ${inr(free - installment)} margin.`,
          text: 'On these numbers the loan can be carried, so you buy. The margin is thin: one poor year of rent or one surprise bill would use it up.',
          scene: [
            {
              kind: 'compare',
              columns: [
                {
                  title: 'Projected, per year',
                  rows: [
                    { label: 'Expected income', value: inr(income) },
                    { label: 'Expected costs', value: inr(costs) },
                    { label: 'Free for the loan', value: inr(free) },
                    { label: 'Installment', value: inr(installment) },
                    { label: 'Margin', value: inr(free - installment) },
                  ],
                },
              ],
            },
            repayments,
            note('A projection: the income is expected, not guaranteed.'),
          ],
        },
      },
    ],
    boardLesson: 'Access to money is not the same as being able to afford a purchase.',
    realLifeConnection: 'Affordability depends on repayment capacity and uncertainty, not just lender approval.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 11 — Mortgage or Sell?
// ---------------------------------------------------------------------------

export const MORTGAGE_STORY = { mortgageValue: 5000, houses: 2, houseCost: 2000 };

const L11 = (() => {
  const { mortgageValue, houses, houseCost } = MORTGAGE_STORY;
  const cash = 500;
  const bill = 4000;
  const terms = mortgageTerms(mortgageValue);
  const perHouse = houseSellBack(houseCost);
  const housesTotal = perHouse * houses;
  const court = (tag: string, faded = false) => card('Hill Court', 'GREEN', `Mortgage value ${inr(mortgageValue)}`, tag, faded);
  const lesson: Lesson = {
    id: 'L11',
    slug: 'mortgage-or-sell',
    number: 11,
    title: 'Mortgage or Sell?',
    collectionId: 'debt',
    estimatedDurationSeconds: 55,
    summary: 'A bill is due and your cash is in bricks.',
    visualType: 'holdings',
    situation: {
      title: 'Raising cash',
      text: `A ${inr(bill)} bill is due and you hold ${inr(cash)}. Hill Court has a printed mortgage value of ${inr(mortgageValue)} and ${houses} houses on it.`,
      scene: [{ kind: 'holdings', holders: [{ who: 'you', cash, cards: [court(`${houses} houses`)] }] }],
    },
    decisionPrompt: 'How do you raise the money?',
    choices: [
      {
        id: 'a',
        label: 'Mortgage Hill Court',
        description: 'Take cash from the bank and keep the deed.',
        outcome: {
          headline: `${inr(terms.payout)} from the bank. Hill Court is still yours; its rent and both houses are inactive.`,
          text: `Nothing is paid for the houses, and they stay on the site. Switching the rent back on costs ${inr(terms.unmortgageCost)}.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Hill Court mortgaged', amount: terms.payout }, { label: 'Bill paid', amount: -bill }] },
            { kind: 'holdings', holders: [{ who: 'you', cards: [court(`Mortgaged · no rent · ${houses} houses inactive`, true)] }] },
            { kind: 'schedule', title: 'To undo it', rows: [{ when: 'Whenever you choose', label: `Unmortgage (${inr(mortgageValue)} + ${inr(terms.interest)})`, amount: terms.unmortgageCost, status: 'upcoming' }] },
          ],
        },
      },
      {
        id: 'b',
        label: 'Sell it',
        description: 'Give the asset up for cash.',
        outcome: {
          headline: `Sold to the bank: ${inr(housesTotal)} for the houses, ${inr(mortgageValue)} for the site. Hill Court is gone.`,
          text: `No player has made an offer, so the bank is the buyer: houses at half their cost, the site at its mortgage value. More cash today and nothing to repay — and no rent from Hill Court again.`,
          scene: [
            {
              kind: 'cash',
              start: cash,
              movements: [
                { label: `${houses} houses sold back`, amount: housesTotal },
                { label: 'Hill Court sold to the bank', amount: mortgageValue },
                { label: 'Bill paid', amount: -bill },
              ],
            },
            { kind: 'holdings', holders: [{ who: 'bank', cards: [court('Sold', true)] }] },
          ],
        },
      },
      {
        id: 'c',
        label: 'Review every option',
        description: 'List the ways to raise cash before picking one.',
        outcome: {
          headline: 'Four ways to raise cash, each with its own price.',
          text: `Selling only the houses raises ${inr(housesTotal)} — not enough for a ${inr(bill)} bill. The other three cover it, at different costs.`,
          scene: [
            {
              kind: 'compare',
              columns: [
                { title: 'Mortgage', rows: [{ label: 'Raises', value: inr(terms.payout) }, { label: 'Still yours', value: 'Yes' }, { label: 'Rent', value: 'Inactive' }, { label: 'Later cost', value: `${inr(terms.unmortgageCost)} to undo` }] },
                { title: 'Sell houses', rows: [{ label: 'Raises', value: inr(housesTotal) }, { label: 'Still yours', value: 'Site only' }, { label: 'Rent', value: 'Site rent only' }, { label: 'Later cost', value: `${inr(houseCost)} a house to rebuild` }] },
                { title: 'Sell all', rows: [{ label: 'Raises', value: inr(housesTotal + mortgageValue) }, { label: 'Still yours', value: 'No' }, { label: 'Rent', value: 'None' }, { label: 'Later cost', value: 'The asset itself' }] },
                { title: 'Bank loan', rows: [{ label: 'Raises', value: inr(bill) }, { label: 'Still yours', value: 'Yes' }, { label: 'Rent', value: 'Unchanged' }, { label: 'Later cost', value: `${inr(classicLoanInterest(bill))} interest + repayment` }] },
              ],
            },
          ],
        },
      },
    ],
    boardLesson: 'You may raise cash from an asset without giving up ownership.',
    realLifeConnection: 'Secured borrowing has trade-offs: it can provide liquidity but creates obligations and risks.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 12 — Credit Score: One Missed Payment
// ---------------------------------------------------------------------------

const L12 = (() => {
  const start = IR.credit.start;
  const installment = 1249;
  const cash = 3000;
  const [overdue, caughtUp, onTime] = creditScoresAfter(start, ['INSTALLMENT_OVERDUE', 'CAUGHT_UP', 'ON_TIME_PAYMENT']);
  const defaulted = creditScoresAfter(start, ['INSTALLMENT_OVERDUE', 'LOAN_DEFAULT'])[1]!;
  const sample = note('A sample score for this story. The game’s credit score is a teaching mechanic, not a real credit bureau score.');
  const lesson: Lesson = {
    id: 'L12',
    slug: 'one-missed-payment',
    number: 12,
    title: 'Credit Score: One Missed Payment',
    collectionId: 'debt',
    estimatedDurationSeconds: 50,
    summary: 'You had the money. You forgot the date.',
    visualType: 'credit',
    situation: {
      title: 'A missed reminder',
      text: `Your ${inr(installment)} loan installment was due and you forgot it. You have ${inr(cash)} — more than enough. The bank sends a reminder.`,
      scene: [
        { kind: 'schedule', title: 'Your loan', rows: [{ when: 'Year 2', label: 'Installment', amount: installment, status: 'overdue' }] },
        { kind: 'credit', start, steps: [{ label: 'Installment overdue', event: 'INSTALLMENT_OVERDUE' }] },
      ],
    },
    decisionPrompt: 'What do you do about the reminder?',
    choices: [
      {
        id: 'a',
        label: 'Ignore the reminder',
        description: 'Deal with it some other time.',
        outcome: {
          headline: `The payment stays overdue. Sample score ${overdue} — and a default would take it to ${defaulted}.`,
          text: 'A lower score makes new loans cost more in the game. The cash to avoid it was there the whole time.',
          scene: [
            { kind: 'schedule', title: 'Your loan', rows: [{ when: 'Year 2', label: 'Installment', amount: installment, status: 'overdue' }, { when: `After ${IR.loans.graceYears} more year unpaid`, label: 'The loan defaults', status: 'info' }] },
            {
              kind: 'credit',
              start,
              steps: [
                { label: 'Installment overdue', event: 'INSTALLMENT_OVERDUE' },
                { label: 'If it is still unpaid a year later: default', event: 'LOAN_DEFAULT', conditional: true },
              ],
            },
            sample,
          ],
        },
      },
      {
        id: 'b',
        label: 'Check the amount and pay now',
        description: 'Catch up while you still can.',
        outcome: {
          headline: `Paid within the grace period: the sample score recovers from ${overdue} to ${caughtUp}.`,
          text: `Catching up helps but does not erase the late mark: you are still ${start - caughtUp!} points below where you began.`,
          scene: [
            { kind: 'cash', start: cash, movements: [{ label: 'Overdue installment paid', amount: -installment }] },
            { kind: 'credit', start, steps: [{ label: 'Installment overdue', event: 'INSTALLMENT_OVERDUE' }, { label: 'Caught up', event: 'CAUGHT_UP' }] },
            sample,
          ],
        },
      },
      {
        id: 'c',
        label: 'Pay, then plan the next dates',
        description: 'Review the schedule so it does not happen again.',
        outcome: {
          headline: `Paid now, with the next two due dates on your calendar. An on-time payment would bring the score to ${onTime}.`,
          text: 'Each payment made on time adds a little back. Knowing the dates is what makes on-time possible.',
          scene: [
            {
              kind: 'schedule',
              title: 'Your loan',
              rows: [
                { when: 'Year 2', label: 'Installment (paid late)', amount: installment, status: 'paid' },
                { when: 'Year 3', label: 'Installment', amount: installment, status: 'upcoming' },
                { when: 'Year 4', label: 'Final installment', amount: installment, status: 'upcoming' },
              ],
            },
            {
              kind: 'credit',
              start,
              steps: [
                { label: 'Installment overdue', event: 'INSTALLMENT_OVERDUE' },
                { label: 'Caught up', event: 'CAUGHT_UP' },
                { label: 'If Year 3 is paid on time', event: 'ON_TIME_PAYMENT', conditional: true },
              ],
            },
            sample,
          ],
        },
      },
    ],
    boardLesson: 'Missed payments can affect future borrowing opportunities.',
    realLifeConnection: 'Payment history and financial habits matter. The game’s score is an educational mechanic, not a real credit bureau score.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 13 — The Deal Maker
// ---------------------------------------------------------------------------

const L13 = (() => {
  const cash = 2000;
  const kabirCash = 7000;
  const offer = 4000;
  const rent = 300;
  const rose = card('Rose Street', 'PINK', `Rent ${inr(rent)}`);
  const pinks = (tag?: string) => [card('Pink Avenue', 'PINK', undefined, tag), card('Bazaar Square', 'PINK', undefined, tag)];
  const depot = card('Waterfront Depot', 'TRANSPORT_UTILITY');
  const before: SceneBlock = { kind: 'holdings', holders: [{ who: 'you', cash, cards: [rose] }, { who: 'kabir', cash: kabirCash, cards: [...pinks(), depot] }] };
  const lesson: Lesson = {
    id: 'L13',
    slug: 'the-deal-maker',
    number: 13,
    title: 'The Deal Maker',
    collectionId: 'strategy',
    estimatedDurationSeconds: 55,
    summary: 'Kabir needs your site more than you do.',
    visualType: 'trade',
    situation: {
      title: 'Kabir makes an offer',
      text: `Kabir owns two Pink sites and needs your Rose Street for the third. He offers ${inr(offer)} in cash. Rose Street earns you ${inr(rent)} whenever someone lands on it.`,
      scene: [before, { kind: 'trade', title: 'Kabir’s offer', left: { who: 'you', gives: [{ card: rose }] }, right: { who: 'kabir', gives: [{ cash: offer }] }, status: 'proposed' }],
    },
    decisionPrompt: 'What is your answer?',
    choices: [
      {
        id: 'a',
        label: 'Accept the cash',
        description: `Rose Street for ${inr(offer)}.`,
        outcome: {
          headline: `Sold for ${inr(offer)}. Kabir’s three Pinks now charge double rent.`,
          text: `You turned a ${inr(rent)}-rent site into ${inr(offer)} of cash — and helped build a group you may land on.`,
          scene: [
            { kind: 'trade', left: { who: 'you', gives: [{ card: rose }] }, right: { who: 'kabir', gives: [{ cash: offer }] }, status: 'accepted' },
            {
              kind: 'holdings',
              title: 'After the deal',
              holders: [
                { who: 'you', cash: cash + offer, cards: [] },
                { who: 'kabir', cash: kabirCash - offer, cards: [...pinks(DOUBLED), card('Rose Street', 'PINK', undefined, DOUBLED), depot] },
              ],
            },
          ],
        },
      },
      {
        id: 'b',
        label: 'Counter: cash plus an asset',
        description: `Ask for ${inr(offer)} and his Waterfront Depot.`,
        outcome: {
          headline: `Counteroffer accepted: ${inr(offer)} and the Depot for Rose Street.`,
          text: 'In this story Kabir agrees, because the group is worth more to him than what he gives up. He could have refused — and then nothing would have changed.',
          scene: [
            {
              kind: 'trade',
              left: { who: 'you', gives: [{ card: rose }] },
              right: { who: 'kabir', gives: [{ cash: offer }, { card: depot }] },
              status: 'accepted',
              statusNote: 'Kabir’s acceptance is part of the story, not a certainty.',
            },
            {
              kind: 'holdings',
              title: 'After the deal',
              holders: [
                { who: 'you', cash: cash + offer, cards: [depot] },
                { who: 'kabir', cash: kabirCash - offer, cards: [...pinks(DOUBLED), card('Rose Street', 'PINK', undefined, DOUBLED)] },
              ],
            },
          ],
        },
      },
      {
        id: 'c',
        label: 'Walk away',
        description: 'Keep Rose Street.',
        outcome: {
          headline: 'No deal. You keep Rose Street; Kabir’s group stays incomplete.',
          text: `Your ${inr(rent)} rent continues and his rent does not double. The ${inr(offer)} offer may not come again.`,
          scene: [{ kind: 'trade', left: { who: 'you', gives: [{ card: rose }] }, right: { who: 'kabir', gives: [{ cash: offer }] }, status: 'declined' }, before],
        },
      },
    ],
    boardLesson: 'A property may be more valuable to one player than another.',
    realLifeConnection: 'Good negotiation considers incentives, alternatives, and the minimum acceptable deal.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 14 — When to Walk Away
// ---------------------------------------------------------------------------

const L14 = (() => {
  const cash = 7000;
  const planned = 4000;
  const reserve = { label: 'Bills you expect', amount: 2000 };
  const site = card('Corner Plaza', 'GREEN');
  const opening = [
    { who: 'you' as const, amount: 3000 },
    { who: 'meera' as const, amount: 3500 },
    { who: 'you' as const, amount: 4000 },
    { who: 'meera' as const, amount: 4500 },
  ];
  const recalculated = 5000;
  const lesson: Lesson = {
    id: 'L14',
    slug: 'when-to-walk-away',
    number: 14,
    title: 'When to Walk Away',
    collectionId: 'strategy',
    estimatedDurationSeconds: 50,
    summary: 'The bidding has passed the price you had in mind.',
    visualType: 'auction',
    situation: {
      title: 'Past your number',
      text: `Before the auction you decided Corner Plaza was worth ${inr(planned)} to you. Meera has just bid ${inr(4500)}. You have ${inr(cash)} and expect ${inr(reserve.amount)} of bills.`,
      scene: [{ kind: 'auction', card: site, bids: opening, winner: null, open: true, limit: { label: 'Your planned limit', amount: planned } }],
    },
    decisionPrompt: 'Meera is ahead. What now?',
    choices: [
      {
        id: 'a',
        label: 'Keep bidding',
        description: 'You do not want to lose this one.',
        outcome: {
          headline: `You win at ${inr(6000)} — ${inr(6000 - planned)} above your own valuation, with ${inr(cash - 6000)} left for ${inr(reserve.amount)} of bills.`,
          text: `Nothing about the site changed between ${inr(planned)} and ${inr(6000)}. Only the wish not to lose did.`,
          scene: [
            { kind: 'auction', card: site, bids: [...opening, { who: 'you', amount: 5000 }, { who: 'meera', amount: 5500 }, { who: 'you', amount: 6000 }], winner: 'you', limit: { label: 'Your planned limit', amount: planned } },
            { kind: 'cash', start: cash, movements: [{ label: 'Winning bid', amount: -6000 }], reserve },
          ],
        },
      },
      {
        id: 'b',
        label: 'Stop at your limit',
        description: `${inr(planned)} was the plan.`,
        outcome: {
          headline: `Meera wins at ${inr(4500)}. You keep ${inr(cash)}.`,
          text: `You did not get the site, and you did not pay more than it was worth to you.`,
          scene: [
            { kind: 'auction', card: site, bids: opening, winner: 'meera', limit: { label: 'Your planned limit', amount: planned } },
            { kind: 'cash', start: cash, movements: [], reserve },
          ],
        },
      },
      {
        id: 'c',
        label: 'Recalculate',
        description: 'Check the value and your cash needs again.',
        outcome: {
          headline: `New limit ${inr(recalculated)}, backed by value and cash. Meera bids ${inr(5500)} and you stop.`,
          text: `Raising a limit can be sound when the numbers support it. Here they supported ${inr(recalculated)} — and no more.`,
          scene: [
            {
              kind: 'compare',
              columns: [
                {
                  title: 'Checked again',
                  rows: [
                    { label: 'Value to you (it would be your third Green)', value: inr(recalculated) },
                    { label: 'Cash after expected bills', value: inr(cash - reserve.amount) },
                    { label: 'New limit', value: inr(recalculated) },
                  ],
                },
              ],
            },
            { kind: 'auction', card: site, bids: [...opening, { who: 'you', amount: recalculated }, { who: 'meera', amount: 5500 }], winner: 'meera', limit: { label: 'Your new limit', amount: recalculated } },
            { kind: 'cash', start: cash, movements: [], reserve },
          ],
        },
      },
    ],
    boardLesson: 'Winning an auction is not the same as making a good purchase.',
    realLifeConnection: 'Discipline and opportunity cost: evaluate the deal rather than allowing competition to dictate the price.',
  };
  return lesson;
})();

// ---------------------------------------------------------------------------
// 15 — Future Value: What Could This Become?
// ---------------------------------------------------------------------------

export const FUTURE_VALUE_STORY = {
  price: 5000,
  ratePercent: 5,
  years: 5,
  alternatives: [
    { label: 'Faster: 8% a year', ratePercent: 8 },
    { label: 'Slower: 2% a year', ratePercent: 2 },
    { label: 'Flat: 0% a year', ratePercent: 0 },
    { label: 'Falling: 3% a year', ratePercent: -3 },
  ],
};

const L15 = (() => {
  const { price, ratePercent, years, alternatives } = FUTURE_VALUE_STORY;
  const cash = 6000;
  const needs = { label: 'Other needs coming up', amount: 2000 };
  const projected = futureValue(price, ratePercent, years);
  const outcomes = alternatives.map((a) => futureValue(price, a.ratePercent, years));
  const growth = (withAlternatives: boolean): SceneBlock => ({
    kind: 'growth',
    title: `Illustrative ${percent(ratePercent)} a year`,
    subject: 'Illustrative property value',
    principal: price,
    ratePercent,
    years,
    alternatives: withAlternatives ? alternatives : undefined,
  });
  const model = note(
    'In Business Banker each property’s value takes its own unpredictable step every financial year. This constant-growth line is an illustration, not that model, and no future value from any game is shown here.',
  );
  const lesson: Lesson = {
    id: 'L15',
    slug: 'future-value',
    number: 15,
    title: 'Future Value: What Could This Become?',
    collectionId: 'strategy',
    estimatedDurationSeconds: 60,
    summary: 'A five-year projection — and what it leaves out.',
    visualType: 'growth',
    situation: {
      title: 'A tempting estimate',
      text: `Old Fort Road costs ${inr(price)} today. Assume — hypothetically — that its value grows ${percent(ratePercent)} a year for ${years} years. You have ${inr(cash)}.`,
      scene: [
        { kind: 'holdings', holders: [{ who: 'bank', cards: [card('Old Fort Road', 'PURPLE', `${inr(price)} today`)], note: 'For sale' }] },
        note(`A hypothetical average growth rate of ${percent(ratePercent)} a year.`),
      ],
    },
    decisionPrompt: 'How much weight do you give the estimate?',
    choices: [
      {
        id: 'a',
        label: 'Buy: the estimate looks good',
        description: 'Let the projection decide.',
        outcome: {
          headline: `Bought for ${inr(price)}. The estimate says about ${inr(projected)} in ${years} years; other paths say otherwise.`,
          text: `You own the site and its rent. The ${inr(projected - price)} gain exists only in the constant-growth scenario.`,
          scene: [{ kind: 'cash', start: cash, movements: [{ label: 'Old Fort Road bought', amount: -price }], reserve: needs }, growth(true), model],
        },
      },
      {
        id: 'b',
        label: 'Compare it with price and needs',
        description: 'Set the estimate beside what you pay and what you need.',
        outcome: {
          headline: `A possible ${inr(projected - price)} gain over ${years} years, against ${inr(cash - price)} left for ${inr(needs.amount)} of needs.`,
          text: 'The projection is one input. The price and your cash needs are known today; the gain is not.',
          scene: [
            {
              kind: 'compare',
              columns: [
                { title: 'The estimate', rows: [{ label: 'Price today', value: inr(price) }, { label: `Projected in ${years} years`, value: `About ${inr(projected)}` }, { label: 'Projected gain', value: `${inr(projected - price)}, hypothetical` }] },
                { title: 'Your position', rows: [{ label: 'Cash', value: inr(cash) }, { label: 'Other needs', value: inr(needs.amount) }, { label: 'Left if you buy', value: inr(cash - price) }] },
              ],
            },
            growth(false),
            model,
          ],
        },
      },
      {
        id: 'c',
        label: 'Do not rely on it alone',
        description: 'Look at what else could happen.',
        outcome: {
          headline: `Five predefined paths: from about ${inr(Math.min(...outcomes))} to about ${inr(Math.max(...outcomes))} after ${years} years.`,
          text: `The ${percent(ratePercent)} line is one scenario among several. Rent, price and your own cash needs are firmer ground for the decision.`,
          scene: [growth(true), model],
        },
      },
    ],
    boardLesson: 'A projection is a scenario, not a promise.',
    realLifeConnection: 'Future value estimates what an amount could be worth later. Actual market changes, inflation, and risk can produce different outcomes.',
  };
  return lesson;
})();

/** Every lesson, in order. All are available from the start — none unlocks another. */
export const LESSONS: readonly Lesson[] = [L01, L02, L03, L04, L05, L06, L07, L08, L09, L10, L11, L12, L13, L14, L15];
