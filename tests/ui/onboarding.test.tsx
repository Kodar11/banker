/// <reference types="jest" />
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { router, useLocalSearchParams, usePathname } from 'expo-router';
import Home from '../../app/index';
import JoinGame from '../../app/join-game';
import Onboarding from '../../app/onboarding';
import Settings from '../../app/settings';
import { computeRent, getDeed, positionOfProperty, spaceName } from '@/engine/index.ts';
import { ONBOARDING_PAGES } from '@/features/onboarding/content';
import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow';
import { BOUGHT, DESTINATION_INDEX, OFFERED, RENT, ROLL, STRIP } from '@/features/onboarding/pieces';
import { ease, onboardingMotion, track } from '@/features/onboarding/timeline';
import { gameApi } from '@/lib/gameApi';
import { useGameStore } from '@/store/gameStore';
import { ONBOARDING_STORAGE_KEY, onboardingDecision, useOnboardingStore } from '@/store/onboardingStore';
import { useSessionStore } from '@/store/sessionStore';
import { startupRouting } from '@/utils/startupRouting';
import { Fixture } from './fixtures';

const api = gameApi as jest.Mocked<typeof gameApi>;
const storage = SecureStore as jest.Mocked<typeof SecureStore>;
const pathname = usePathname as jest.Mock;
const [FIRST, SECOND, THIRD] = ONBOARDING_PAGES as [(typeof ONBOARDING_PAGES)[number], (typeof ONBOARDING_PAGES)[number], (typeof ONBOARDING_PAGES)[number]];

const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));
const headline = () => screen.getByTestId('onboarding-headline');
/** The screen measuring the area the scene is drawn in, as a `width` × `height` phone would. */
const layOut = (width = 360, height = 300) => fireEvent(screen.getByTestId('onboarding-art'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
/** A fresh install: nothing stored, storage read at launch as the root layout does. */
const firstLaunch = () => act(() => useOnboardingStore.getState().hydrate());
const expectNoGameTouched = () => {
  for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  expect(useGameStore.getState().snapshot).toBeNull();
  expect(useSessionStore.getState().session).toBeNull();
};

beforeEach(async () => {
  jest.clearAllMocks();
  await SecureStore.deleteItemAsync(ONBOARDING_STORAGE_KEY);
  jest.clearAllMocks();
  startupRouting.reset();
  pathname.mockReturnValue('/');
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
  useOnboardingStore.setState({ status: 'unknown' });
  // Stepping through pages needs no waiting, and scenes are seen finished; tests that are about motion turn it back on.
  onboardingMotion.enabled = false;
  onboardingMotion.useNativeDriver = false;
  onboardingMotion.tapGuardMs = 0;
});

afterAll(() => {
  onboardingMotion.enabled = true;
  onboardingMotion.tapGuardMs = 350;
});

describe('First launch and returning launches', () => {
  it('a first-time player is shown the introduction instead of Home', async () => {
    await firstLaunch();
    expect(useOnboardingStore.getState().status).toBe('pending');
    await render(<Home />);
    expect(screen.getByTestId('onboarding-screen')).toBeTruthy();
    expect(screen.queryByTestId('home-screen')).toBeNull();
    expect(headline()).toHaveTextContent(FIRST.headline);
  });

  it('a player who has seen it goes straight to Home', async () => {
    await SecureStore.setItemAsync(ONBOARDING_STORAGE_KEY, '1');
    await firstLaunch();
    expect(useOnboardingStore.getState().status).toBe('done');
    await render(<Home />);
    expect(screen.getByTestId('home-screen')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-screen')).toBeNull();
  });

  it('Skip remembers it, lands on Home, and the next launch does not show it again', async () => {
    await firstLaunch();
    await render(<Home />);
    await press('onboarding-skip');
    expect(screen.getByTestId('home-screen')).toBeTruthy();
    expect(screen.getByTestId('create-game')).toBeTruthy();
    expect(await SecureStore.getItemAsync(ONBOARDING_STORAGE_KEY)).toBe('1');
    // Next launch.
    useOnboardingStore.setState({ status: 'unknown' });
    await firstLaunch();
    expect(useOnboardingStore.getState().status).toBe('done');
    expectNoGameTouched();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("Let's Play on the last page remembers it and lands on Home, where the player chooses how to play", async () => {
    await firstLaunch();
    await render(<Home />);
    await press('onboarding-next');
    await press('onboarding-next');
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent("Let's Play");
    await press('onboarding-next');
    expect(screen.getByTestId('home-screen')).toBeTruthy();
    expect(screen.getByTestId('create-game')).toBeTruthy();
    expect(screen.getByTestId('join-game')).toBeTruthy();
    expect(storage.setItemAsync).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY, '1');
    expectNoGameTouched();
  });

  it('storage that cannot be read does not show the introduction on every launch, or block Home', async () => {
    storage.getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
    await firstLaunch();
    expect(useOnboardingStore.getState().status).toBe('done');
    await render(<Home />);
    expect(screen.getByTestId('home-screen')).toBeTruthy();
  });

  it('storage that cannot be written does not trap the player in the introduction', async () => {
    await firstLaunch();
    storage.setItemAsync.mockRejectedValueOnce(new Error('disk full'));
    await render(<Home />);
    await press('onboarding-skip');
    expect(screen.getByTestId('home-screen')).toBeTruthy();
    expect(useOnboardingStore.getState().status).toBe('done');
  });

  it('finishing more than once is stored once', async () => {
    await firstLaunch();
    const { complete } = useOnboardingStore.getState();
    complete();
    complete();
    complete();
    expect(storage.setItemAsync).toHaveBeenCalledTimes(1);
  });
});

describe('Startup ordering: session, deep links and games in progress', () => {
  it('nothing is decided, and neither Home nor the introduction flashes, until both stores have answered', async () => {
    useSessionStore.setState({ session: null, hydrated: false });
    const view = await render(<Home />);
    expect(screen.getByTestId('home-loading')).toBeTruthy();
    // The introduction's answer arrives first: still waiting for the session.
    await firstLaunch();
    await view.rerender(<Home />);
    expect(screen.getByTestId('home-loading')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-screen')).toBeNull();
    await act(async () => useSessionStore.setState({ hydrated: true }));
    expect(screen.getByTestId('onboarding-screen')).toBeTruthy();
  });

  it('the decision is the same whichever store answers first', () => {
    const base = { sessionHydrated: true, hasSession: false, pathname: '/' };
    expect(onboardingDecision({ ...base, status: 'unknown' })).toBe('wait');
    expect(onboardingDecision({ ...base, status: 'pending', sessionHydrated: false })).toBe('wait');
    expect(onboardingDecision({ ...base, status: 'pending' })).toBe('show');
    expect(onboardingDecision({ ...base, status: 'pending', hasSession: true })).toBe('defer');
    expect(onboardingDecision({ ...base, status: 'pending', pathname: '/join-game' })).toBe('defer');
    expect(onboardingDecision({ ...base, status: 'deferred' })).toBe('none');
    expect(onboardingDecision({ ...base, status: 'done', hasSession: true })).toBe('none');
  });

  it('a first launch from an invite link opens the join screen with its code; the introduction waits for another launch', async () => {
    await firstLaunch();
    pathname.mockReturnValue('/join-game');
    (useLocalSearchParams as jest.Mock).mockReturnValue({ code: '482915' });
    await render(
      <>
        <Home />
        <JoinGame />
      </>,
    );
    expect(screen.queryByTestId('onboarding-screen')).toBeNull();
    expect(screen.getByTestId('join-code').props.value).toBe('482915');
    expect(useOnboardingStore.getState().status).toBe('deferred');
    // Nothing was stored: it is still unseen, and a later launch on Home shows it.
    expect(storage.setItemAsync).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    (useLocalSearchParams as jest.Mock).mockReturnValue({});
    // Coming back to Home in this same run does not spring it on the player either.
    pathname.mockReturnValue('/');
    await screen.rerender(
      <>
        <Home />
      </>,
    );
    expect(screen.getByTestId('home-screen')).toBeTruthy();
  });

  it('a device with a game in progress is taken to it, not into the introduction', async () => {
    await firstLaunch();
    const f = new Fixture().loadAs('Asha');
    await render(<Home />);
    expect(screen.queryByTestId('onboarding-screen')).toBeNull();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/game/${f.state.id}`));
    expect(useOnboardingStore.getState().status).toBe('deferred');
  });
});

describe('The three pages', () => {
  const open = async (onFinish = jest.fn()) => {
    await render(<OnboardingFlow onFinish={onFinish} />);
    return onFinish;
  };

  it('each shows its approved headline and description, in order', async () => {
    await open();
    expect(headline()).toHaveTextContent('Every roll starts a rivalry.');
    expect(screen.getByTestId('onboarding-description')).toHaveTextContent('Buy properties. Build your empire. Outsmart your friends.');
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent('Continue');
    await press('onboarding-next');
    expect(headline()).toHaveTextContent('Roll. Buy. Collect. Repeat.');
    expect(screen.getByTestId('onboarding-description')).toHaveTextContent('Claim properties, charge rent, and grow your wealth. Every move counts.');
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent('Continue');
    await press('onboarding-next');
    expect(headline()).toHaveTextContent('Every game tells a new story.');
    expect(screen.getByTestId('onboarding-description')).toHaveTextContent('Trade, negotiate, take risks, and challenge your friends. Choose your style and make your move.');
    expect(screen.getByTestId('onboarding-next')).toHaveTextContent("Let's Play");
  });

  it('Skip is offered on the first two pages, Back on the last two', async () => {
    await open();
    expect(screen.getByTestId('onboarding-skip')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-back')).toBeNull();
    await press('onboarding-next');
    expect(screen.getByTestId('onboarding-skip')).toBeTruthy();
    expect(screen.getByTestId('onboarding-back')).toBeTruthy();
    await press('onboarding-next');
    expect(screen.queryByTestId('onboarding-skip')).toBeNull();
    expect(screen.getByTestId('onboarding-back')).toBeTruthy();
  });

  it('Back returns to the previous page and nothing is finished', async () => {
    const onFinish = await open();
    await press('onboarding-next');
    await press('onboarding-next');
    await press('onboarding-back');
    expect(headline()).toHaveTextContent(SECOND.headline);
    await press('onboarding-back');
    expect(headline()).toHaveTextContent(FIRST.headline);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('two taps in quick succession move one page, never two', async () => {
    onboardingMotion.tapGuardMs = 350;
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    await open();
    await press('onboarding-next');
    await press('onboarding-next');
    expect(headline()).toHaveTextContent(SECOND.headline);
    now.mockReturnValue(10_400);
    await press('onboarding-next');
    expect(headline()).toHaveTextContent(THIRD.headline);
    now.mockRestore();
  });

  it("repeated taps on Skip or Let's Play finish exactly once", async () => {
    const onFinish = await open();
    await press('onboarding-skip');
    await press('onboarding-skip');
    await press('onboarding-next');
    expect(onFinish).toHaveBeenCalledTimes(1);
    // Nothing moves once it is over.
    expect(headline()).toHaveTextContent(FIRST.headline);
  });

  it('is labelled for screen readers: the controls, the page and what the scene shows', async () => {
    await open();
    await layOut();
    expect(screen.getByLabelText('Skip onboarding')).toBeTruthy();
    expect(screen.getByLabelText('Continue')).toBeTruthy();
    expect(screen.getByLabelText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByLabelText(FIRST.sceneLabel)).toBeTruthy();
    expect(screen.getByRole('header')).toHaveTextContent(FIRST.headline);
    // The pieces themselves are decoration: none of them is read out.
    expect(screen.queryByText(BOUGHT.name)).toBeNull();
    expect(screen.getByText(BOUGHT.name, { includeHiddenElements: true })).toBeTruthy();
    const announce = AccessibilityInfo.announceForAccessibility as jest.Mock;
    await press('onboarding-next');
    expect(screen.getByLabelText('Go back')).toBeTruthy();
    expect(screen.getByLabelText('Step 2 of 3')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(`Step 2 of 3. ${SECOND.headline}`);
    await press('onboarding-next');
    expect(screen.getByLabelText("Let's Play")).toBeTruthy();
  });
});

describe('The scenes', () => {
  const shown = (name: string) => screen.queryByText(name, { includeHiddenElements: true });

  it('only the scene of the page on screen exists, and it is drawn once the screen has been measured', async () => {
    await render(<OnboardingFlow onFinish={jest.fn()} />);
    expect(screen.queryByTestId('onboarding-scene-rivalry', { includeHiddenElements: true })).toBeNull();
    await layOut();
    expect(screen.getByTestId('onboarding-scene-rivalry', { includeHiddenElements: true })).toBeTruthy();
    await press('onboarding-next');
    expect(screen.queryByTestId('onboarding-scene-rivalry', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('onboarding-scene-turn', { includeHiddenElements: true })).toBeTruthy();
    await press('onboarding-next');
    expect(screen.getByTestId('onboarding-scene-trade', { includeHiddenElements: true })).toBeTruthy();
    // Back to a page: its scene is there again (mounted afresh, so it plays again).
    await press('onboarding-back');
    expect(screen.getByTestId('onboarding-scene-turn', { includeHiddenElements: true })).toBeTruthy();
  });

  it('keeps its proportions on a small phone, a typical phone and a tablet: scaled, never stretched', async () => {
    await render(<OnboardingFlow onFinish={jest.fn()} />);
    for (const [width, height] of [
      [320, 170],
      [392, 330],
      [800, 700],
    ] as const) {
      await layOut(width, height);
      const { style } = screen.getByTestId('onboarding-scene-rivalry', { includeHiddenElements: true }).props;
      expect(style.width / style.height).toBeCloseTo(320 / 236, 5);
      expect(style.width).toBeLessThanOrEqual(width - 40);
      expect(style.height).toBeLessThanOrEqual(height - 16);
    }
  });

  it('the buttons work while a scene is still playing', async () => {
    onboardingMotion.enabled = true;
    const onFinish = jest.fn();
    await render(<OnboardingFlow onFinish={onFinish} />);
    await layOut();
    await press('onboarding-next');
    expect(headline()).toHaveTextContent(SECOND.headline);
    await press('onboarding-skip');
    expect(onFinish).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('with reduced motion every page still shows its whole picture and works the same', async () => {
    onboardingMotion.enabled = true;
    const reduce = AccessibilityInfo.isReduceMotionEnabled as jest.Mock;
    reduce.mockResolvedValue(true);
    const onFinish = jest.fn();
    await render(<OnboardingFlow onFinish={onFinish} />);
    await layOut();
    await waitFor(() => expect(reduce).toHaveBeenCalled());
    expect(shown(BOUGHT.name)).toBeTruthy();
    await press('onboarding-next');
    expect(screen.getByText(/\+₹/, { includeHiddenElements: true })).toBeTruthy();
    await press('onboarding-next');
    // Its square on the board, and its title deed in the trade.
    expect(screen.getAllByText(OFFERED.name, { includeHiddenElements: true })).toHaveLength(2);
    await press('onboarding-next');
    expect(onFinish).toHaveBeenCalledTimes(1);
    reduce.mockResolvedValue(false);
  });

  it('draws real squares of the board, in board order, with the game’s own names and prices', () => {
    const end = positionOfProperty(BOUGHT.key);
    expect(STRIP.map((tile) => tile.name)).toEqual(STRIP.map((_, i) => spaceName(end - DESTINATION_INDEX + i)));
    expect(BOUGHT).toBe(getDeed(BOUGHT.key));
    expect(OFFERED).toBe(getDeed(OFFERED.key));
    // The token walks exactly what the dice show.
    expect(ROLL[0] + ROLL[1]).toBe(DESTINATION_INDEX);
  });

  it('charges the rent the rules charge: one site, no colour set, paid to its owner', () => {
    const f = new Fixture();
    const owner = f.state.players[0]!.id;
    const state = { ...f.state, properties: { ...f.state.properties, [BOUGHT.key]: { ...f.state.properties[BOUGHT.key], ownerId: owner } } };
    expect(RENT).toBe(computeRent(state, BOUGHT.key, ROLL[0] + ROLL[1]));
    expect(RENT).toBeGreaterThan(0);
  });
});

describe('Scene timing', () => {
  it('a track holds its start, makes each move in turn and holds its end, on a clock that only runs forward', () => {
    const { inputRange, outputRange } = track(1000, 5, [
      [100, 300, 20, ease.linear],
      [300, 300, 0],
      [600, 800, 9, ease.pop],
    ]);
    expect(inputRange[0]).toBe(0);
    expect(inputRange[inputRange.length - 1]).toBe(1);
    expect(outputRange[0]).toBe(5);
    expect(outputRange[outputRange.length - 1]).toBe(9);
    for (let i = 1; i < inputRange.length; i++) expect(inputRange[i]!).toBeGreaterThan(inputRange[i - 1]!);
    // Still at its start value when the first move begins.
    expect(outputRange[inputRange.findIndex((time) => time >= 0.1)]).toBe(5);
  });
});

describe('Replay from House rules', () => {
  it('House rules offers it, with or without a game', async () => {
    await render(<Settings />);
    await press('replay-onboarding');
    expect(router.push).toHaveBeenCalledWith('/onboarding');
  });

  it('watching it again mid-game closes back to where it was opened and leaves the game exactly as it was', async () => {
    useOnboardingStore.setState({ status: 'done' });
    await SecureStore.setItemAsync(ONBOARDING_STORAGE_KEY, '1');
    const f = new Fixture().loadAs('Asha');
    const before = { snapshot: useGameStore.getState().snapshot, session: useSessionStore.getState().session };
    await render(<Onboarding />);
    await press('onboarding-next');
    await press('onboarding-next');
    await press('onboarding-next');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(useGameStore.getState().snapshot).toBe(before.snapshot);
    expect(useSessionStore.getState().session).toBe(before.session);
    expect(useGameStore.getState().snapshot?.state.id).toBe(f.state.id);
    expect(useOnboardingStore.getState().status).toBe('done');
    expect(await SecureStore.getItemAsync(ONBOARDING_STORAGE_KEY)).toBe('1');
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  });

  it('skipping a replay also just closes it', async () => {
    useOnboardingStore.setState({ status: 'done' });
    await render(<Onboarding />);
    await press('onboarding-skip');
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
