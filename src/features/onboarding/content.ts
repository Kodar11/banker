export type OnboardingSceneId = 'rivalry' | 'turn' | 'trade' | 'tycoon';

export interface OnboardingPage {
  scene: OnboardingSceneId;
  headline: string;
  description: string;
  /** The primary button. */
  action: string;
  /** What the animated scene shows, for screen readers (the scene itself is decorative). */
  sceneLabel: string;
}

/** All of the introduction's wording, in one place so it can be translated later. */
export const ONBOARDING_PAGES: readonly OnboardingPage[] = [
  {
    scene: 'rivalry',
    headline: 'Every roll starts a rivalry.',
    description: 'Buy properties. Build your empire. Outsmart your friends.',
    action: 'Continue',
    sceneLabel: 'Two dice roll across the board, a token moves to a property, buys it and builds a house.',
  },
  {
    scene: 'turn',
    headline: 'Roll. Buy. Collect. Repeat.',
    description: 'Claim properties, charge rent, and grow your wealth. Every move counts.',
    action: 'Continue',
    sceneLabel: 'One player rolls and buys a property. Another player lands on it and pays rent to the owner, who then builds a house.',
  },
  {
    scene: 'trade',
    headline: 'Every game tells a new story.',
    description: 'Trade, negotiate, take risks, and challenge your friends. Choose your style and make your move.',
    action: 'Continue',
    sceneLabel: 'Four players around the board. Two of them swap property cards and a coin to make a deal.',
  },
  {
    scene: 'tycoon',
    headline: 'More than just a roll of the dice.',
    description: 'Build your empire, make bold deals, protect your assets, and outsmart your rivals. Every decision can change your fortune.',
    action: "Let's Play",
    sceneLabel:
      'An owner builds houses up to a hotel and the rent rises, mortgages another property to the bank for cash, insures a property in Capital Mode, and then outbids a rival at an auction.',
  },
];

export const ONBOARDING_LABELS = {
  skip: 'Skip',
  skipHint: 'Skip onboarding',
  back: 'Back',
  backHint: 'Go back',
  /** Drawn in the finale, in front of an amount from the deed. */
  rent: 'Rent',
  step: (n: number, of: number) => `Step ${n} of ${of}`,
};
