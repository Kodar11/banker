import { describe, expect, it } from 'vitest';
import { checkNickname, NICKNAME_MAX, nicknameLength, nicknameProblem, normalizeNickname } from '@/features/account/nickname';
import { accountStatusOf, PLAYER_ID_PATTERN, toProfile, type Profile } from '@/features/account/types';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZERO_WIDTH_SPACE = cp(0x200b);
const ZWJ = cp(0x200d);
const NBSP = cp(0xa0);
const RTL_OVERRIDE = cp(0x202e);
const TAB = cp(0x9);

describe('nickname normalisation', () => {
  it('trims and collapses every kind of space to one ordinary space', () => {
    expect(normalizeNickname(`  Asha${NBSP}${NBSP} ${TAB} Rao  `)).toBe('Asha Rao');
    expect(normalizeNickname(`${cp(0x3000)}Priya${cp(0x2003)}K`)).toBe('Priya K');
  });

  it('normalises to NFC so the same name is always the same string', () => {
    const decomposed = `Jose${cp(0x301)}`; // e + combining acute
    expect(normalizeNickname(decomposed)).toBe(`Jos${cp(0xe9)}`);
    expect(nicknameLength(normalizeNickname(decomposed))).toBe(4);
  });
});

describe('nickname validation', () => {
  it('accepts ordinary names, Indian scripts and emoji', () => {
    for (const name of ['Asha', 'Player4827', 'Asha Rao', cp(0x924, 0x928, 0x94d, 0x92e, 0x92f), `Ria ${cp(0x1f3b2)}`, 'abc']) {
      expect(checkNickname(name)).toEqual({ ok: true, nickname: name });
    }
  });

  it('rejects empty and whitespace-only values', () => {
    expect(checkNickname('')).toEqual({ ok: false, problem: 'NICKNAME_EMPTY' });
    expect(checkNickname(`  ${NBSP}${TAB} `)).toEqual({ ok: false, problem: 'NICKNAME_EMPTY' });
  });

  it('enforces 3 to 20 characters, counted as code points after trimming', () => {
    expect(checkNickname(' ab ')).toEqual({ ok: false, problem: 'NICKNAME_TOO_SHORT' });
    expect(checkNickname('a'.repeat(NICKNAME_MAX)).ok).toBe(true);
    expect(checkNickname('a'.repeat(NICKNAME_MAX + 1))).toEqual({ ok: false, problem: 'NICKNAME_TOO_LONG' });
    // 20 emoji are 40 UTF-16 units but 20 characters.
    expect(checkNickname(cp(0x1f600).repeat(20)).ok).toBe(true);
    expect(checkNickname(cp(0x1f600).repeat(21))).toEqual({ ok: false, problem: 'NICKNAME_TOO_LONG' });
  });

  it('does not let spaces or joiners stand in for visible characters', () => {
    expect(nicknameProblem('a b')).toBe('NICKNAME_TOO_SHORT');
    expect(nicknameProblem(`a${ZWJ}${ZWJ}b`)).toBe('NICKNAME_TOO_SHORT');
  });

  it('rejects control characters and invisible formatting marks', () => {
    for (const bad of [`As${ZERO_WIDTH_SPACE}ha`, `Asha${RTL_OVERRIDE}`, `As${cp(0x7)}ha`, `Asha${cp(0xfeff)}x`, `A${cp(0xad)}sha`]) {
      expect(checkNickname(bad)).toEqual({ ok: false, problem: 'NICKNAME_INVALID_CHARACTERS' });
    }
  });
});

describe('Player ID and account status', () => {
  it('accepts RR- plus six unambiguous symbols and nothing else', () => {
    expect(PLAYER_ID_PATTERN.test('RR-7K4P9X')).toBe(true);
    for (const bad of ['RR-7K4P9', 'RR-7K4P9XA', 'rr-7K4P9X', 'RR-7K4P90', 'RR-7K4P9O', 'RR-7K4P91', 'RR-7K4P9I', 'RX-7K4P9X', 'RR7K4P9X']) {
      expect(PLAYER_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  it('reads a server profile and refuses a malformed one', () => {
    expect(toProfile({ user_id: 'u1', player_id: 'RR-7K4P9X', nickname: 'Asha', google_linked: true, extra: 1 })).toEqual({
      userId: 'u1',
      playerId: 'RR-7K4P9X',
      nickname: 'Asha',
      googleLinked: true,
    });
    expect(toProfile({ user_id: 'u1', player_id: 'RR-000000', nickname: 'Asha', google_linked: false })).toBeNull();
    expect(toProfile({ user_id: 'u1', player_id: 'RR-7K4P9X', nickname: 'Asha' })).toBeNull();
    expect(toProfile(null)).toBeNull();
  });

  it('derives the status only from a profile the server confirmed in this run', () => {
    const profile: Profile = { userId: 'u1', playerId: 'RR-7K4P9X', nickname: 'Asha', googleLinked: true };
    expect(accountStatusOf(profile, true)).toBe('google');
    expect(accountStatusOf({ ...profile, googleLinked: false }, true)).toBe('guest');
    // Remembered from an earlier run: never shown as linked (or as guest).
    expect(accountStatusOf(profile, false)).toBeNull();
    expect(accountStatusOf(null, true)).toBeNull();
  });
});
