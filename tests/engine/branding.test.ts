/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '@/constants/app';
import { defaultGameConfig, GAME_MODE_LABELS, GAME_MODE_NAMES, GAME_MODES, gameConfigSummary, normalizeGameMode } from '@/engine/index.ts';
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

  it('the identifiers a phone and the stores know the app by stay what they are', () => {
    // Changing either makes a different app: it could not be installed over, or published as an update to, this one.
    expect(appJson.android.package).toBe('com.clashofcapitals.app');
    expect(appJson.ios.bundleIdentifier).toBe('com.clashofcapitals.app');
    expect(appJson.slug).toBe('clash-of-capitals');
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
