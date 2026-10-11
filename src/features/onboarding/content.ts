export type OnboardingSceneId = 'rivalry' | 'turn' | 'trade';

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
    action: "Let's Play",
    sceneLabel: 'Four players around the board. Two of them swap property cards and a coin to make a deal.',
  },
];

export const ONBOARDING_LABELS = {
  skip: 'Skip',
  skipHint: 'Skip onboarding',
  back: 'Back',
  backHint: 'Go back',
  step: (n: number, of: number) => `Step ${n} of ${of}`,
};
