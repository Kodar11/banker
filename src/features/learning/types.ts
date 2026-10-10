import type { CreditEventType, PropertyGroup } from '@/engine/index.ts';

/**
 * The Financial Learning lesson model. A lesson is DATA: a situation, one decision with two or
 * three choices, and one outcome per choice. The lesson player renders any lesson from it; a new
 * lesson needs a new entry in lessons.ts, and a new scene component only if it draws something
 * none of the existing scene kinds can.
 */

export type CollectionId = 'cash' | 'property' | 'debt' | 'strategy';

export interface LessonCollection {
  id: CollectionId;
  title: string;
  icon: string;
  blurb: string;
}

/** The people in the stories. "you" is always the learner. */
export type CastId = 'you' | 'meera' | 'kabir' | 'bank';

/** A story property card. Sample properties, never a deed from a live game. */
export interface StoryCard {
  name: string;
  group: PropertyGroup;
  /** A short fact printed on the card (a price, "2 houses"). */
  detail?: string;
  /** A state the card is in (Mortgaged, New, Sold). Always text, never colour alone. */
  tag?: string;
  /** Drawn faded: no longer held, or inactive. */
  faded?: boolean;
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad';

/** A cash balance and the signed movements that change it, top to bottom. */
export interface CashScene {
  kind: 'cash';
  title?: string;
  start: number;
  startLabel?: string;
  /** Positive = money in, negative = money out. */
  movements: { label: string; amount: number }[];
  endLabel?: string;
  /** Cash that should stay untouched for a known need; the scene says whether the end balance covers it. */
  reserve?: { label: string; amount: number };
}

/** Who holds which properties (and how much cash). */
export interface HoldingsScene {
  kind: 'holdings';
  title?: string;
  holders: { who: CastId; cash?: number; cards: StoryCard[]; note?: string }[];
}

/** What each side of a deal hands over, and whether the deal happened. */
export interface TradeScene {
  kind: 'trade';
  title?: string;
  left: { who: CastId; gives: TradeItem[] };
  right: { who: CastId; gives: TradeItem[] };
  status: 'proposed' | 'accepted' | 'declined';
  statusNote?: string;
}
export type TradeItem = { card: StoryCard } | { cash: number };

/** A run of bids and how the auction ended. */
export interface AuctionScene {
  kind: 'auction';
  card: StoryCard;
  bids: { who: CastId; amount: number }[];
  /** null = the learner did not bid; nobody in the story is shown winning. */
  winner: CastId | null;
  /** Bidding is still running (the situation, before the learner decides). */
  open?: boolean;
  /** The learner's own maximum, drawn as a line the bids cross (or do not). */
  limit?: { label: string; amount: number };
}

/** A payment today against a later one, with the later one discounted back to today. */
export interface PresentValueScene {
  kind: 'presentValue';
  today: number;
  future: number;
  years: number;
  ratePercent: number;
  /** Which side of the comparison the chosen option took. */
  taken: 'today' | 'future' | 'both';
  /** The situation shows the two payments only; the discounted value is the consequence. */
  hideDiscount?: boolean;
}

/** An amount growing year by year at a stated, hypothetical rate — optionally beside other predefined paths. */
export interface GrowthScene {
  kind: 'growth';
  title: string;
  principal: number;
  ratePercent: number;
  years: number;
  /** What the growing amount is (a hypothetical investment, an illustrative property value). */
  subject: string;
  /** Other explicit, predefined outcomes. Never random. */
  alternatives?: { label: string; ratePercent: number }[];
}

/** A fixed-rate loan beside a variable-rate one, with labelled hypothetical paths for the variable rate. */
export interface LoanComparisonScene {
  kind: 'loanComparison';
  principal: number;
  years: number;
  fixedRatePercent: number;
  /** Each path gives the variable loan's rate in every year. */
  variablePaths: { label: string; ratesByYear: number[] }[];
  focus: 'fixed' | 'variable' | 'both';
}

/** Dated payments: what is due, overdue, paid or still to come. */
export interface ScheduleScene {
  kind: 'schedule';
  title: string;
  rows: { when: string; label: string; amount?: number; status: 'paid' | 'due' | 'overdue' | 'upcoming' | 'info' }[];
}

/** A sample credit score moved by the game's configured events. */
export interface CreditScene {
  kind: 'credit';
  title?: string;
  start: number;
  steps: { label: string; event: CreditEventType; conditional?: boolean }[];
}

/** Alternatives side by side. */
export interface CompareScene {
  kind: 'compare';
  title?: string;
  columns: { title: string; tag?: string; rows: { label: string; value: string }[] }[];
}

/** A stated assumption, limit or caution. */
export interface NoteScene {
  kind: 'note';
  tone: Tone;
  text: string;
}

export type SceneBlock =
  | CashScene
  | HoldingsScene
  | TradeScene
  | AuctionScene
  | PresentValueScene
  | GrowthScene
  | LoanComparisonScene
  | ScheduleScene
  | CreditScene
  | CompareScene
  | NoteScene;

export type SceneKind = SceneBlock['kind'];

export type ChoiceId = 'a' | 'b' | 'c';

export interface LessonChoice {
  id: ChoiceId;
  label: string;
  description: string;
  outcome: {
    /** One line: what happened. Also shown, briefly, under "the other options" when another choice was made. */
    headline: string;
    /** One or two sentences on the trade-off. Never a verdict on the learner. */
    text: string;
    scene: SceneBlock[];
  };
}

export interface Lesson {
  id: string;
  slug: string;
  number: number;
  title: string;
  collectionId: CollectionId;
  estimatedDurationSeconds: number;
  summary: string;
  /** The scene kind that carries the lesson's main idea. */
  visualType: SceneKind;
  situation: { title: string; text: string; scene: SceneBlock[] };
  decisionPrompt: string;
  choices: LessonChoice[];
  boardLesson: string;
  realLifeConnection: string;
}

export const LESSON_STAGES = ['situation', 'decision', 'consequence', 'takeaway'] as const;
export type LessonStage = (typeof LESSON_STAGES)[number];
