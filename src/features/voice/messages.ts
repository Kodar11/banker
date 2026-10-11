import type { VoiceProblem } from './voiceController';

/** One short, actionable sentence per reason voice is not working. Never a provider error, a code or a stack. */
export function voiceMessage(problem: VoiceProblem | null | undefined): string {
  switch (problem) {
    case 'MIC_DENIED':
      return 'Microphone access is off. You can listen; allow the microphone to talk.';
    case 'MIC_BLOCKED':
      return 'Microphone access is blocked. Turn it on in Settings to talk.';
    case 'CONNECT_FAILED':
    case 'NETWORK':
    case 'TIMEOUT':
    case 'SERVER_ERROR':
      return 'Couldn’t connect to voice. The game carries on. Tap the mic to try again.';
    case 'RATE_LIMITED':
      return 'Too many voice attempts. Try again in a moment.';
    case 'NEEDS_DEV_BUILD':
    case 'NOT_CONFIGURED':
      return 'Voice chat isn’t available in this version of the app.';
    case 'LIMIT_REACHED':
      return 'Voice chat has reached this month’s limit for the experiment. The game carries on.';
    case 'GAME_LIMIT_REACHED':
      return 'This game has used all of its voice time. The game carries on.';
    case 'VOICE_DISABLED':
      return 'Voice chat is switched off for now. The game carries on.';
    case 'NOT_ENTITLED':
      return 'The host’s account can’t host voice chat.';
    case 'NOT_HOST':
      return 'Only the host can change voice chat.';
    case 'PUBLIC_GAME':
      return 'Voice chat is only for private games.';
    case 'ROOM_VOICE_OFF':
      return 'Voice chat is not turned on for this game.';
    case 'GAME_NOT_ACTIVE':
      return 'Voice chat starts when the game does.';
    case 'SESSION_ENDED':
      return 'Voice disconnected. Tap the mic to join again.';
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'VALIDATION':
      return 'Voice chat isn’t available for you in this game.';
    default:
      return 'Voice chat isn’t available right now.';
  }
}
