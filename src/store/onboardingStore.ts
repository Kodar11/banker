import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

export const ONBOARDING_STORAGE_KEY = 'business-banker.onboarding.v1';

/**
 * unknown  — storage has not answered yet.
 * pending  — this device has never finished (or skipped) the introduction.
 * deferred — still unseen, but this launch went somewhere more important (an invite link, a game
 *            in progress); it is offered again on a later launch. Never stored.
 * done     — finished or skipped; never shown again by itself.
 */
export type OnboardingStatus = 'unknown' | 'pending' | 'deferred' | 'done';

interface OnboardingState {
  status: OnboardingStatus;
  hydrate: () => Promise<void>;
  /** Finished or skipped. Safe to call any number of times. */
  complete: () => void;
  /** Not now: something else owns this launch. */
  defer: () => void;
}

/**
 * Whether this device has seen the first-launch introduction. Kept on this device only and
 * entirely apart from the game: it never reads or writes the game store, the session or the server.
 */
export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: 'unknown',
  hydrate: async () => {
    if (get().status !== 'unknown') return;
    let next: OnboardingStatus;
    try {
      next = (await SecureStore.getItemAsync(ONBOARDING_STORAGE_KEY)) ? 'done' : 'pending';
    } catch {
      // Storage unavailable: better to skip the introduction than to show it on every launch.
      next = 'done';
    }
    // Anything decided before storage answered (skip, defer) is kept.
    set((s) => (s.status === 'unknown' ? { status: next } : s));
  },
  complete: () => {
    if (get().status === 'done') return;
    set({ status: 'done' });
    // Best effort: if the device cannot store it, the app still moves on for this run.
    SecureStore.setItemAsync(ONBOARDING_STORAGE_KEY, '1').catch(() => undefined);
  },
  defer: () => {
    if (get().status === 'pending') set({ status: 'deferred' });
  },
}));

interface Launch {
  status: OnboardingStatus;
  /** The device's game session has been read from storage. */
  sessionHydrated: boolean;
  hasSession: boolean;
  pathname: string;
}

/**
 * What Home does about the introduction, decided from the launch as a whole so it cannot race
 * with session restoration or an incoming link:
 *  - wait  — not enough is known yet; show nothing.
 *  - show  — a first launch that landed on Home with no game to go back to.
 *  - defer — a first launch that opened an invite / deep link or has a game in progress: that wins.
 *  - none  — carry on as usual.
 */
export function onboardingDecision({ status, sessionHydrated, hasSession, pathname }: Launch): 'wait' | 'show' | 'defer' | 'none' {
  if (status === 'unknown') return 'wait';
  if (status !== 'pending') return 'none';
  if (!sessionHydrated) return 'wait';
  return pathname === '/' && !hasSession ? 'show' : 'defer';
}
