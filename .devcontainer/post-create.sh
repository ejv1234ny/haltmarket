#!/usr/bin/env bash
# Runs once when the Codespace is created.
set -euxo pipefail

# Corepack + pnpm matching the repo's packageManager pin.
corepack enable
corepack prepare pnpm@10.33.0 --activate || true

# Node is already installed via the devcontainer feature — npm is on PATH.
# Install Claude Code CLI FIRST so the Codespace is usable even if any later
# install step fails. This is the whole point of the devcontainer.
npm install -g @anthropic-ai/claude-code

# Postgres client — used by scripts/ledger-integration.sh and the CI workflows.
sudo apt-get update
sudo apt-get install -y postgresql-client

# uv — Astral's fast Python package manager. Used by apps/monitor + apps/resolver.
curl -LsSf https://astral.sh/uv/install.sh | sh

# Supabase CLI — needed for `supabase link`, `supabase db push`, local stack.
# Install via npm (tracks latest stable; no version drift in the dockerfile).
# Wrapped in `|| true` so a transient npm hiccup doesn't break the Codespace.
npm install -g supabase || echo "[post-create] Supabase CLI install failed — install manually with: npm install -g supabase"

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
