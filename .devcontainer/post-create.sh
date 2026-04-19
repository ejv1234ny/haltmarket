#!/usr/bin/env bash
# Runs once when the Codespace is created.
set -euxo pipefail

# Corepack + pnpm matching the repo's packageManager pin.
corepack enable
corepack prepare pnpm@10.33.0 --activate || true

# uv — Astral's fast Python package manager. Used by apps/monitor + apps/resolver.
curl -LsSf https://astral.sh/uv/install.sh | sh

# Supabase CLI — needed for `supabase link`, `supabase db push`, local stack.
# Install via the official release tarball (brew pipe doesn't work in devcontainers).
SUPABASE_VERSION="2.12.5"
curl -LsSf "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_amd64.tar.gz" \
  | tar -xz -C /tmp
sudo mv /tmp/supabase /usr/local/bin/supabase
sudo chmod +x /usr/local/bin/supabase
supabase --version

# Claude Code CLI — the whole point of this devcontainer.
# Installed globally so `claude` is on PATH everywhere.
npm install -g @anthropic-ai/claude-code

# Postgres client — used by scripts/ledger-integration.sh and the CI workflows.
sudo apt-get update
sudo apt-get install -y postgresql-client

# pnpm install at the repo root so editing starts fast.
if [ -f pnpm-workspace.yaml ]; then
  pnpm install --frozen-lockfile || pnpm install
fi

# Python app deps via uv (creates per-app .venv).
for app in apps/monitor apps/resolver; do
  if [ -f "$app/pyproject.toml" ]; then
    (cd "$app" && uv sync --all-extras) || true
  fi
done

echo ""
echo "=== Claude Code ready ==="
echo "Run:  bash scripts/kickoff-next-phase.sh"
echo "Or:   claude --dangerously-skip-permissions"
echo ""
