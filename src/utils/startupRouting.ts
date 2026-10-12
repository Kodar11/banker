/**
 * Home routes to an active lobby/game at most once per launch of the app's screens; afterwards Home
 * never redirects by itself (a player who went Home during a game stays there).
 *
 * "Launch" means the root layout mounting, not the JavaScript starting: Android can rebuild the
 * activity while the app's process, and with it this module, lives on. The screens then start again
 * at Home with nothing above it, and the player must be taken back to their game exactly as on a
 * cold start. The root layout therefore calls `reset` when it mounts.
 */
let done = false;

export const startupRouting = {
  isDone: () => done,
  markDone: () => {
    done = true;
  },
  /** A fresh launch of the screens: the root layout mounting (and tests simulating one). */
  reset: () => {
    done = false;
  },
};
