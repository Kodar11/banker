import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

export const LEARNING_STORAGE_KEY = 'business-banker.learning.v1';

type Stage = 'situation' | 'decision' | 'consequence' | 'takeaway';
const STAGES: readonly Stage[] = ['situation', 'decision', 'consequence', 'takeaway'];

/** Where a lesson was left: the last stage reached and, once a choice was made, which one. */
export interface LessonResume {
  stage: Stage;
  choiceId: string | null;
}

interface Stored {
  completed: string[];
  inProgress: Record<string, LessonResume>;
}

interface LearningState extends Stored {
  hydrated: boolean;
  /** The post-game lesson suggestion was dismissed. For this app run only — never stored. */
  suggestionDismissed: boolean;
  hydrate: () => Promise<void>;
  /** Remembers where a lesson is, so leaving and coming back resumes there. Never marks it completed. */
  saveResume: (lessonId: string, resume: LessonResume) => void;
  /** Forgets where a lesson was left (skip, replay, or after completing it). */
  clearResume: (lessonId: string) => void;
  /** The learner acknowledged the takeaway. Counted once, however often the lesson is replayed. */
  complete: (lessonId: string) => void;
  /** Explicit "reset progress": every completion and resume point is forgotten. */
  resetProgress: () => void;
  dismissSuggestion: () => void;
}

function parse(raw: string | null): Stored {
  const empty: Stored = { completed: [], inProgress: {} };
  if (!raw) return empty;
  const data = JSON.parse(raw) as Partial<Stored> | null;
  if (!data || typeof data !== 'object') return empty;
  const completed = Array.isArray(data.completed) ? [...new Set(data.completed.filter((id): id is string => typeof id === 'string'))] : [];
  const inProgress: Record<string, LessonResume> = {};
  for (const [id, resume] of Object.entries(data.inProgress && typeof data.inProgress === 'object' ? data.inProgress : {})) {
    if (resume && STAGES.includes(resume.stage)) inProgress[id] = { stage: resume.stage, choiceId: typeof resume.choiceId === 'string' ? resume.choiceId : null };
  }
  return { completed, inProgress };
}

function persist(state: Stored): void {
  // Best effort: if the device cannot store it, the lessons still work for this app run.
  SecureStore.setItemAsync(LEARNING_STORAGE_KEY, JSON.stringify({ completed: state.completed, inProgress: state.inProgress })).catch(() => undefined);
}

/**
 * Financial Learning progress. Kept on this device only and entirely apart from the game: it
 * never reads or writes the game store, the session or the server, and needs no account.
 */
export const useLearningStore = create<LearningState>((set, get) => ({
  completed: [],
  inProgress: {},
  hydrated: false,
  suggestionDismissed: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const stored = parse(await SecureStore.getItemAsync(LEARNING_STORAGE_KEY));
      // Anything done before storage answered is kept on top of what was stored.
      set((s) => ({ completed: [...new Set([...stored.completed, ...s.completed])], inProgress: { ...stored.inProgress, ...s.inProgress }, hydrated: true }));
    } catch {
      set({ hydrated: true });
    }
  },
  saveResume: (lessonId, resume) => {
    const current = get().inProgress[lessonId];
    if (current?.stage === resume.stage && current.choiceId === resume.choiceId) return;
    set((s) => ({ inProgress: { ...s.inProgress, [lessonId]: resume } }));
    persist(get());
  },
  clearResume: (lessonId) => {
    if (!get().inProgress[lessonId]) return;
    set((s) => {
      const inProgress = { ...s.inProgress };
      delete inProgress[lessonId];
      return { inProgress };
    });
    persist(get());
  },
  complete: (lessonId) => {
    set((s) => {
      const inProgress = { ...s.inProgress };
      delete inProgress[lessonId];
      return { completed: s.completed.includes(lessonId) ? s.completed : [...s.completed, lessonId], inProgress };
    });
    persist(get());
  },
  resetProgress: () => {
    set({ completed: [], inProgress: {} });
    persist(get());
  },
  dismissSuggestion: () => set({ suggestionDismissed: true }),
}));
