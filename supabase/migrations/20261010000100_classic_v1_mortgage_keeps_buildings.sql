-- Classic Mode V1 (rule set CLASSIC-V1): mortgaging a property keeps its houses / hotel attached.
-- They are inactive while it is mortgaged (the engine charges no rent and refuses building or
-- selling), and are restored as they were when it is unmortgaged.
--
-- The first schema forbade a mortgaged property from having buildings. That check is dropped.
-- It was declared without a name, so it is found by its definition. The other two property checks
-- (no hotel together with houses; a bank-owned property is undeveloped and unmortgaged) stay.
-- Existing rows already satisfy the looser rule, so no data changes.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.properties'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%mortgaged%'
      and pg_get_constraintdef(oid) like '%hotel%'
      and pg_get_constraintdef(oid) not like '%owner_player_id%'
  loop
    execute format('alter table public.properties drop constraint %I', c.conname);
  end loop;
end $$;
