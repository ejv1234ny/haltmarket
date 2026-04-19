# Phase prompts

Each file here is a ready-to-paste Claude Code prompt for one phase of the AGENTS.md build plan. The `scripts/kickoff-next-phase.sh` helper auto-detects the next unmerged phase and launches Claude Code with the right prompt.

## Usage

From inside a Codespace on `main`:

```bash
bash scripts/kickoff-next-phase.sh
```

It reads `docs/progress.md` for the latest merged phase, picks the next one from this directory, and runs:

```bash
claude --dangerously-skip-permissions -p "$(cat docs/phase-prompts/phase-N.md)"
```

When the autonomous run opens a PR, the `.github/workflows/next-phase-notify.yml` workflow will fire on merge and announce the next phase is ready (optionally auto-kick via a self-hosted runner — see that workflow's comment).

## Phases

- `phase-4.md` — `place-bet` edge function
- `phase-5.md` — Resolution worker (ADR-0002 closest-to-pin math)
- `phase-6.md` — Web Push notifications
- `phase-7-cleanup.md` — Swap Phase 7 frontend mocks for real Supabase reads (after Phases 3-5 land)
- `phase-8.md` — Deposit / withdrawal scaffolding (StubProvider)
- `phase-9.md` — Admin page + observability runbooks
- `phase-10.md` — End-to-end integration harness

## Amending a prompt

If you want to change a prompt BEFORE it's been executed: edit the file and open a PR with prefix `docs(phase-prompts):`. Do not edit AFTER a phase is merged — prompts are the audit trail of what the autonomous build was actually instructed to do.
