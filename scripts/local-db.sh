#!/usr/bin/env bash
# Starts a throwaway local Postgres (no Docker, no `supabase start`) and applies
# the migrations, so the Edge Function handler can be integration-tested.
# Usage: npm run db:local   then   DATABASE_URL=postgres://postgres@127.0.0.1:54329/banker npm run test:server
set -euo pipefail

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA_DIR="${LOCAL_PG_DIR:-/tmp/banker-pg}"
PORT="${LOCAL_PG_PORT:-54329}"
DB=banker
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_pg() {
  if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi
}

if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
  mkdir -p "$DATA_DIR"
  [ "$(id -u)" = "0" ] && chown postgres "$DATA_DIR"
  run_pg "$PGBIN/initdb -D $DATA_DIR -U postgres --auth=trust >/dev/null"
fi

if ! run_pg "$PGBIN/pg_ctl -D $DATA_DIR status" >/dev/null 2>&1; then
  run_pg "$PGBIN/pg_ctl -D $DATA_DIR -o '-p $PORT -k /tmp' -l $DATA_DIR/log.txt start -w" >/dev/null
fi

PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -d postgres -c "drop database if exists $DB" -c "create database $DB"
# Supabase provides these roles in the cloud; create them locally so grants/revokes apply.
$PSQL -d $DB <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
SQL
# Supabase also provides the auth schema (users, identities, auth.uid()); a minimal stand-in for tests.
$PSQL -d $DB -f "$ROOT/scripts/local-auth-stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  $PSQL -d $DB -f "$f"
done
echo "Local Postgres ready: postgres://postgres@127.0.0.1:$PORT/$DB"
