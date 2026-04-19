#!/usr/bin/env bash
# Runs every time the Codespace starts (post-create AND on every resume).
set -euxo pipefail

# Refresh env if Codespaces secrets rotate.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[post-start] ANTHROPIC_API_KEY present — claude -p mode ready."
else
  echo "[post-start] WARNING: ANTHROPIC_API_KEY not set. Set via Codespaces secrets or run 'claude login' once."
fi

# Quick status — where are we in the phase plan?
if [ -f docs/progress.md ]; then
  LAST_MERGED=$(grep -oE '## Phase [0-9]+' docs/progress.md | tail -1)
  echo "[post-start] Latest merged per progress.md: ${LAST_MERGED:-unknown}"
fi

# Claude Code sanity check
if command -v claude >/dev/null 2>&1; then
  echo "[post-start] claude: $(claude --version 2>/dev/null || echo 'installed')"
else
  echo "[post-start] claude NOT installed — postCreateCommand didn't complete. Run: bash .devcontainer/post-create.sh"
fi
