/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROPERTY_DEEDS, PROPERTY_KEYS, RULES_VERSION } from '@/engine/index.ts';

const root = join(__dirname, '..', '..');

describe('server/client share one engine', () => {
  it.each(['engine', 'bots'])('supabase/functions/_shared/%s is an exact copy of src/%s (run `npm run sync:engine`)', (name) => {
    const src = join(root, 'src', name);
    const copy = join(root, 'supabase/functions/_shared', name);
    const files = readdirSync(src).filter((f) => f.endsWith('.ts')).sort();
    expect(readdirSync(copy).filter((f) => f.endsWith('.ts')).sort()).toEqual(files);
    for (const f of files) expect(readFileSync(join(copy, f), 'utf8'), f).toBe(readFileSync(join(src, f), 'utf8'));
  });

  it('the bot engine imports only the engine and itself (it runs on the device, on the server and in Deno)', () => {
    for (const f of readdirSync(join(root, 'src/bots')).filter((x) => x.endsWith('.ts'))) {
      const imports = [...readFileSync(join(root, 'src/bots', f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) expect(spec === '../engine/index.ts' || /^\.\/[A-Za-z]+\.ts$/.test(spec), `${f} imports ${spec}`).toBe(true);
    }
  });

  it('board_properties catalog migration matches the TS source', () => {
    const dir = join(root, 'supabase/migrations');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('_catalog.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const rows = [...sql.matchAll(new RegExp(`\\('${RULES_VERSION}', '([A-Z_]+)', '([^']+)', '([A-Z_]+)'\\)`, 'g'))].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(PROPERTY_KEYS.map((k) => [k, PROPERTY_DEEDS[k].name, PROPERTY_DEEDS[k].group]));
  });
});
