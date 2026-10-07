/** Home routes to an active lobby/game at most once per app launch; afterwards Home never redirects by itself. */
let done = false;

export const startupRouting = {
  isDone: () => done,
  markDone: () => {
    done = true;
  },
  /** Test helper: simulate a fresh app launch. */
  reset: () => {
    done = false;
  },
};
