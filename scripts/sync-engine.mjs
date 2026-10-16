// Copies the canonical engine (src/engine) and the bot decision engine (src/bots) into the Edge Function
// bundle (supabase/functions/_shared/engine and _shared/bots) so client and server run identical rules and
// identical bots. tests/engine/sourceSync.test.ts fails if a copy drifts.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['engine', 'bots']) {
  const src = join(root, 'src', name);
  const dest = join(root, 'supabase/functions/_shared', name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src)) {
    if (file.endsWith('.ts')) cpSync(join(src, file), join(dest, file));
  }
  writeFileSync(join(dest, 'README.md'), `GENERATED — do not edit. Copied from src/${name} by \`npm run sync:engine\`.\n`);
  console.log(`Synced ${name} → ${dest}`);
}
