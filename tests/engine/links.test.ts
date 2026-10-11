/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_CALLBACK_PATH, readAuthCallback } from '@/features/account/oauthCallback';
import { gameShareMessage } from '@/features/social/logic';
import { APP_SCHEME, authCallbackLink, JOIN_PATH, joinLink, parseJoinCode } from '@/utils/links';

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const appJson = JSON.parse(read('app.json')).expo;

function files(dir: string, match: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) return files(path, match);
    return match.test(name) ? [path] : [];
  });
}

describe('links the app writes', () => {
  it('a join link uses the current scheme and the join route', () => {
    expect(APP_SCHEME).toBe('clashofcapitals');
    expect(joinLink('482193')).toBe('clashofcapitals://join-game?code=482193');
    expect(read(`app/${JOIN_PATH}.tsx`)).toContain('parseJoinCode');
  });

  it('the share sheet sends the same link the QR code holds', () => {
    expect(gameShareMessage('classic', '482193').split('\n').pop()).toBe(joinLink('482193'));
  });

  it('Google sign-in returns to the current scheme, on the route that exists', () => {
    expect(authCallbackLink()).toBe('clashofcapitals://auth-callback');
    expect(read(`app/${AUTH_CALLBACK_PATH}.tsx`)).toContain('export default');
    expect(readAuthCallback(`${authCallbackLink()}?code=abc-123`)).toEqual({ ok: true, value: 'abc-123' });
  });

  it('every link starts with the one scheme', () => {
    expect(joinLink('482193').startsWith(`${APP_SCHEME}://`)).toBe(true);
    expect(authCallbackLink().startsWith(`${APP_SCHEME}://`)).toBe(true);
  });
});

describe('links the app reads', () => {
  it('a code survives being written and read back, leading zeros included', () => {
    for (const code of ['482193', '000000', '000001', '999999', '012340']) expect(parseJoinCode(joinLink(code))).toBe(code);
  });

  it('reads the forms a phone may hand over', () => {
    expect(parseJoinCode('482193')).toBe('482193');
    expect(parseJoinCode('  482193\n')).toBe('482193');
    expect(parseJoinCode('clashofcapitals:///join-game?code=482193')).toBe('482193');
    expect(parseJoinCode('ClashOfCapitals://join-game?code=482193')).toBe('482193');
    expect(parseJoinCode('clashofcapitals://join-game/?code=482193')).toBe('482193');
    expect(parseJoinCode('clashofcapitals://join-game?utm=x&code=482193#top')).toBe('482193');
  });

  it('rejects links that are not this app’s join link', () => {
    for (const value of [
      'https://example.com/join-game?code=482193',
      'otherapp://join-game?code=482193',
      // The app's previous name is not a scheme of this app.
      'businessbanker://join-game?code=482193',
      'xclashofcapitals://join-game?code=482193',
      'clashofcapitals://auth-callback?code=482193',
      'clashofcapitals://join-game-now?code=482193',
      'clashofcapitals://lobby/482193',
      'see clashofcapitals://join-game?code=482193',
    ]) {
      expect(parseJoinCode(value), value).toBeNull();
    }
  });

  it('rejects malformed codes', () => {
    for (const value of [
      '',
      '48219',
      '4821930',
      '48219a',
      '482 193',
      '-48219',
      '４８２１９３',
      'clashofcapitals://join-game',
      'clashofcapitals://join-game?code=',
      'clashofcapitals://join-game?code=48219',
      'clashofcapitals://join-game?code=4821930',
      'clashofcapitals://join-game?code=48219a',
      'clashofcapitals://join-game?code=482193%20',
      'clashofcapitals://join-game?xcode=482193',
      'clashofcapitals://join-game?code=482193&code=111111',
      'clashofcapitals://join-game#code=482193',
    ]) {
      expect(parseJoinCode(value), value).toBeNull();
    }
  });

  it('rejects what is not text at all (a repeated link parameter arrives as a list)', () => {
    for (const value of [undefined, null, 482193, ['482193'], ['482193', '111111'], {}]) expect(parseJoinCode(value)).toBeNull();
  });
});

describe('the phone, the server config and the code agree', () => {
  it('app.json registers that one scheme and no other — for Android and iOS alike', () => {
    expect(appJson.scheme).toBe(APP_SCHEME);
    // No platform lists schemes of its own: both get exactly the one above.
    expect(appJson.android.scheme).toBeUndefined();
    expect(appJson.ios.scheme).toBeUndefined();
  });

  it('Supabase’s local redirect allow-list has the address sign-in returns to', () => {
    const line = read('supabase/config.toml')
      .split('\n')
      .find((l) => l.startsWith('additional_redirect_urls'));
    // The only app address in it: no other scheme may receive a sign-in.
    expect(line!.match(/"[a-z][a-z0-9+.-]*:\/\/auth-callback"/g)).toEqual([`"${authCallbackLink()}"`]);
  });

  it('the end-to-end flows drive the app this project builds', () => {
    const flows = files('.maestro', /\.yaml$/).filter((path) => /^appId:/m.test(read(path)));
    expect(flows.length).toBeGreaterThan(0);
    for (const path of flows) expect(read(path), path).toMatch(new RegExp(`^appId: ${appJson.android.package.replace(/\./g, '\\.')}$`, 'm'));
  });

  it('links are written in one place: no other source file names a scheme', () => {
    const others = files('app', /\.tsx?$/)
      .concat(files('src', /\.tsx?$/))
      .filter((path) => path !== 'src/utils/links.ts');
    const writesLink = new RegExp(`['"\`](?:${APP_SCHEME}|businessbanker)(?:://|['"\`])|\\$\\{APP_SCHEME\\}`);
    for (const path of others) expect(read(path), path).not.toMatch(writesLink);
  });
});
