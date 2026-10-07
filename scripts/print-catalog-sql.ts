// Prints the board_properties catalog insert from the versioned TS source.
// Usage: node --experimental-strip-types scripts/print-catalog-sql.ts > supabase/migrations/<ts>_catalog.sql
import { PROPERTY_DEEDS, PROPERTY_KEYS, RULES_VERSION } from '../src/engine/businessBoard.ts';

const rows = PROPERTY_KEYS.map((k) => {
  const d = PROPERTY_DEEDS[k];
  return `  ('${RULES_VERSION}', '${k}', '${d.name.replace(/'/g, "''")}', '${d.group}')`;
});
console.log(`-- Generated from src/engine/businessBoard.ts (scripts/print-catalog-sql.ts). Keys/names only.
insert into public.board_properties (rules_version, property_key, name, property_group) values
${rows.join(',\n')}
on conflict (rules_version, property_key) do update set name = excluded.name, property_group = excluded.property_group;`);
