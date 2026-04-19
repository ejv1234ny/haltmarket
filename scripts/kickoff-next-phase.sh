#!/usr/bin/env bash
# Auto-kickoff the next unmerged phase.
#
# Reads docs/progress.md to find the latest merged phase, picks the next
# numbered phase prompt from docs/phase-prompts/phase-N.md, and launches
# Claude Code with it.
#
# Usage:
#   bash scripts/kickoff-next-phase.sh              # picks next phase automatically
#   bash scripts/kickoff-next-phase.sh 4            # force a specific phase
#   bash scripts/kickoff-next-phase.sh 7-cleanup    # or a named variant
#
# Requires: claude (in PATH), docs/progress.md present, ANTHROPIC_API_KEY
# optionally set (otherwise Claude Code will prompt for OAuth on first run).

set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "[kickoff] claude not found on PATH."
  echo "[kickoff] The devcontainer postCreateCommand should install it."
  echo "[kickoff] If you're in a bare shell, run: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

PROMPT_DIR="docs/phase-prompts"

# If the user passed a phase number/name, use it directly.
if [ "$#" -ge 1 ]; then
  PHASE="$1"
  PROMPT_FILE="${PROMPT_DIR}/phase-${PHASE}.md"
  if [ ! -f "${PROMPT_FILE}" ]; then
    echo "[kickoff] Prompt file not found: ${PROMPT_FILE}"
    ls "${PROMPT_DIR}/" || true
    exit 2
  fi
else
  # Auto-detect: find latest "## Phase N" line in progress.md, then pick N+1.
  if [ ! -f docs/progress.md ]; then
    echo "[kickoff] docs/progress.md missing — cannot auto-detect next phase."
    echo "[kickoff] Pass a phase explicitly: bash scripts/kickoff-next-phase.sh 4"
    exit 3
  fi

  LAST=$(grep -oE '## Phase [0-9]+' docs/progress.md | awk '{print $NF}' | sort -n | tail -1)
  if [ -z "${LAST:-}" ]; then
    NEXT=0
  else
    NEXT=$((LAST + 1))
  fi

  PHASE="${NEXT}"
  PROMPT_FILE="${PROMPT_DIR}/phase-${PHASE}.md"

  # Fall back to a cleanup variant if a regular phase prompt isn't there yet.
  if [ ! -f "${PROMPT_FILE}" ]; then
    if [ -f "${PROMPT_DIR}/phase-${PHASE}-cleanup.md" ]; then
      PROMPT_FILE="${PROMPT_DIR}/phase-${PHASE}-cleanup.md"
    else
      echo "[kickoff] No prompt file found for phase ${PHASE}."
      echo "[kickoff] Available prompts:"
      ls "${PROMPT_DIR}/" | grep -E '^phase-' || true
      exit 4
    fi
  fi
fi

echo "[kickoff] Using prompt: ${PROMPT_FILE}"
echo "[kickoff] Launching Claude Code in dangerously-skip-permissions mode..."
echo

# Main event. Uses -p for one-shot mode; Claude will drive itself to PR completion
# and exit. For a fully interactive session instead, drop -p and pipe the file in.
exec claude --dangerously-skip-permissions -p "$(cat "${PROMPT_FILE}")"
