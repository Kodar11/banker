/// <reference types="jest" />
import { render, screen } from '@testing-library/react-native';
import Home from '../../app/index';
import { useGameStore } from '@/store/gameStore';
import { useSessionStore } from '@/store/sessionStore';
import { startupRouting } from '@/utils/startupRouting';

beforeEach(() => {
  jest.clearAllMocks();
  startupRouting.reset();
  useSessionStore.setState({ session: null, hydrated: true });
  useGameStore.getState().reset(null);
});

describe('Home shows the app icon as its heading', () => {
  it('draws the bundled icon square and uncropped, in place of the old emoji', async () => {
    await render(<Home />);
    const logo = screen.getByTestId('home-logo');
    expect(logo.props.source).toBe(require('../../assets/splash-icon.png'));
    expect(logo.props.resizeMode).toBe('contain');
    const style = logo.props.style;
    expect(style.width).toBe(style.height);
    expect(style.width).toBeGreaterThanOrEqual(128);
    expect(style.width).toBeLessThanOrEqual(260);
    expect(screen.queryByText('🏦')).toBeNull();
  });

  it('the icon carries the name: it is not written a second time, and a screen reader still hears it', async () => {
    await render(<Home />);
    const logo = screen.getByTestId('home-logo');
    expect(screen.queryByText(/Clash of\s+Capitals/)).toBeNull();
    expect(logo.props.accessibilityLabel).toBe('Clash of Capitals');
    expect(logo.props.accessibilityRole).toBe('header');
    expect(screen.getByText('Roll, buy, build and outbid your rivals.')).toBeTruthy();
    expect(screen.queryByText(/real board/)).toBeNull();
    for (const testID of ['create-game', 'join-game', 'open-learning', 'open-rules']) expect(screen.getByTestId(testID)).toBeTruthy();
  });
});
