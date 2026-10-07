-- Local-only seed (runs on `supabase db reset`).
-- The BUSINESS_V1 property catalog is seeded by a migration
-- (migrations/*_business_v1_catalog.sql) because production needs it too.
-- Games are temporary sessions created by players, so there is nothing else to seed.
select 1;
