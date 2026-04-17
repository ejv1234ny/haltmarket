#!/usr/bin/env bash
# scripts/ledger-integration.sh
#
# Applies the auth shim + every migration in supabase/migrations/ to the
# Postgres pointed at by LEDGER_TEST_DATABASE_URL, then runs the integration
# suites that need a live DB (@haltmarket/ledger-client + @haltmarket/markets-client).
#
# The filename is kept as "ledger-integration" for CI stability (the branch-
# protected `node` job references it), but its scope grows with each phase.
#
# Locally:
#   export LEDGER_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
#   ./scripts/ledger-integration.sh
#
# In CI: the `node` job in .github/workflows/ci.yml provisions postgres:17 as a
# service and calls this script.

set -euo pipefail

if [[ -z "${LEDGER_TEST_DATABASE_URL:-}" ]]; then
  echo "LEDGER_TEST_DATABASE_URL is required" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"

echo "▶ applying auth shim to $LEDGER_TEST_DATABASE_URL"
psql "$LEDGER_TEST_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  -f "$repo/scripts/ledger-integration-setup.sql"

shopt -s nullglob
migrations=("$repo"/supabase/migrations/*.sql)
if (( ${#migrations[@]} == 0 )); then
  echo "no migrations found under supabase/migrations/" >&2
  exit 1
fi
for f in "${migrations[@]}"; do
  echo "▶ applying $(basename "$f")"
  psql "$LEDGER_TEST_DATABASE_URL" \
    --set=ON_ERROR_STOP=1 \
    -f "$f"
done

echo "▶ running ledger-client integration suite"
pnpm --filter @haltmarket/ledger-client test:integration

echo "▶ running markets-client integration suite"
pnpm --filter @haltmarket/markets-client test:integration
