import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { Credentials } from '@/lib/gameApi';

const STORAGE_KEY = 'business-banker.session.v1';

interface SessionState {
  session: Credentials | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSession: (session: Credentials) => Promise<void>;
  clearSession: () => Promise<void>;
}

/** The one temporary game this device is part of. No accounts — just a device token. */
export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  hydrated: false,
  hydrate: async () => {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Credentials) : null;
      set({ session: parsed?.gameId && parsed.playerId && parsed.token ? parsed : null, hydrated: true });
    } catch {
      set({ session: null, hydrated: true });
    }
  },
  setSession: async (session) => {
    set({ session });
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Still usable for this app run.
    }
  },
  clearSession: async () => {
    set({ session: null });
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
}));
