# haltmarket-resolver

Python worker that polls Polygon `/v3/trades/{symbol}` for post-halt opening-cross prints, runs the parimutuel settlement, and posts the multi-leg ledger transfer. Phase-5 deliverable per `AGENTS.md`.

## Local dev

```bash
uv sync --all-extras
uv run haltmarket-resolver
uv run pytest
uv run ruff check .
uv run mypy
```
