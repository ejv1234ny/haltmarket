# HaltMarket Monitor — V2 Clean Async Rewrite
#
# KEY REQUIREMENTS (from CLAUDE.md):
# 1. asyncio.gather() — concurrent halt processing
# 2. return_exceptions=True — isolate failures
# 3. Rebuild ALL state from Supabase on startup
# 4. pipeline_update() MUST check HTTP status_code
# 5. Always store timestamps as UTC isoformat
# 6. Only field[9] triggers resolve (not field[8])
# 7. update_cutoff() AFTER full batch, not inside loop
# 8. ALLOWED_CODES = {'LUDP', 'LUDS', 'IPO'}
#
# TODO: implement in Phase 2.

from datetime import datetime, timezone


ALLOWED_CODES = {"LUDP", "LUDS", "IPO"}


def now_utc() -> str:
    """Return current time as UTC ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


async def main() -> None:
    raise NotImplementedError("monitor/main.py stub — implement in Phase 2")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
