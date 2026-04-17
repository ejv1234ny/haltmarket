#!/usr/bin/env bash
# scripts/ledger-integration.sh
#
# Applies supabase/migrations/0001_ledger.sql to the Postgres pointed at by
# LEDGER_TEST_DATABASE_URL and runs the @haltmarket/ledger-client integration
# suite against it.
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

echo "▶ applying auth shim + migration to $LEDGER_TEST_DATABASE_URL"
psql "$LEDGER_TEST_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  -f "$repo/scripts/ledger-integration-setup.sql"

psql "$LEDGER_TEST_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  -f "$repo/supabase/migrations/0001_ledger.sql"

echo "▶ running ledger-client integration suite"
pnpm --filter @haltmarket/ledger-client test:integration
