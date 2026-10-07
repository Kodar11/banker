// Copies the canonical engine (src/engine) into the Edge Function bundle
// (supabase/functions/_shared/engine) so client and server run identical rules.
// tests/engine/engineSync.test.ts fails if the copy drifts.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/engine');
const dest = join(root, 'supabase/functions/_shared/engine');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  if (file.endsWith('.ts')) cpSync(join(src, file), join(dest, file));
}
writeFileSync(
  join(dest, 'README.md'),
  'GENERATED — do not edit. Copied from src/engine by `npm run sync:engine`.\n',
);
console.log(`Synced engine → ${dest}`);
