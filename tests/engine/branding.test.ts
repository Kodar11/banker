/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_SCHEME, joinLink, parseJoinCode } from '@/constants/app';
import { defaultGameConfig, GAME_MODE_LABELS, GAME_MODE_NAMES, GAME_MODES, gameConfigSummary, normalizeGameMode } from '@/engine/index.ts';
import { AUTH_CALLBACK_PATH } from '@/features/account/oauthCallback';
import { gameShareMessage } from '@/features/social/logic';

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const appJson = JSON.parse(read('app.json')).expo;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the app is called Clash of Capitals', () => {
  it('the installed name and the name the app writes are the same', () => {
    expect(APP_NAME).toBe('Clash of Capitals');
    expect(appJson.name).toBe(APP_NAME);
    expect(gameShareMessage('classic', '482193')).toContain('Open Clash of Capitals and enter this code');
  });

  it('the identifiers a phone, the stores and sign-in already know did not change with the name', () => {
    expect(appJson.slug).toBe('board-game-bank');
    expect(appJson.android.package).toBe('com.boardgamebank.businessbanker');
    expect(appJson.ios.bundleIdentifier).toBe('com.boardgamebank.businessbanker');
    expect(appJson.extra.eas.projectId).toBe('7bb101a8-80ea-414b-a1d0-3936c8af0bcb');
  });

  it('deep links and the sign-in return address still use the scheme the server allows', () => {
    expect(appJson.scheme).toBe(APP_SCHEME);
    expect(APP_SCHEME).toBe('businessbanker');
    expect(parseJoinCode(joinLink('482193'))).toBe('482193');
    expect(read('supabase/config.toml')).toContain(`"${APP_SCHEME}://${AUTH_CALLBACK_PATH}"`);
  });
});

describe('the two modes are Classic Mode and Capital Mode', () => {
  it('names them in one place', () => {
    expect(GAME_MODE_NAMES).toEqual({ classic: 'Classic Mode', intermediate: 'Capital Mode' });
    expect(GAME_MODE_LABELS).toEqual({ classic: 'Classic', intermediate: 'Capital' });
    expect(gameConfigSummary('intermediate', defaultGameConfig('intermediate'))[0]).toMatchObject({ value: 'Capital' });
  });

  it('the stored mode values are the ones existing games carry', () => {
    expect(GAME_MODES).toEqual(['classic', 'intermediate']);
    expect(normalizeGameMode('intermediate')).toBe('intermediate');
    expect(normalizeGameMode('classic')).toBe('classic');
    // A value no game was ever stored with is not a mode: the new name is a label only.
    expect(normalizeGameMode('capital')).toBe('classic');
    expect(normalizeGameMode(undefined)).toBe('classic');
  });
});

describe('nothing in the app still shows an old name', () => {
  // The standalone words only: identifiers (IntermediateState, isIntermediate) and the stored value 'intermediate' stay.
  it.each(sourceFiles('app').concat(sourceFiles('src')))('%s', (path) => {
    expect(read(path)).not.toMatch(/\bIntermediate\b|Business Banker/);
  });
});
