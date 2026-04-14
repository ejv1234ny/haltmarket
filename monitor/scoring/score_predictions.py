"""Score user predictions after a halt resumes."""

from datetime import datetime, timezone

from supabase import create_client

from ..config import SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY


def _get_supabase():
    """Create a Supabase client with service-role credentials."""
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _parse_halt_id(halt_id):
    """Parse halt_id 'SYMBOL-YYYY-MM-DD-N' into (symbol, date, halt_number)."""
    parts = halt_id.rsplit('-', 1)
    halt_number = int(parts[1])
    rest = parts[0]  # 'SYMBOL-YYYY-MM-DD'
    # Date is always last 10 chars (YYYY-MM-DD)
    date = rest[-10:]
    symbol = rest[:-11]  # everything before '-YYYY-MM-DD'
    return symbol, date, halt_number


def score_predictions(halt_id, log=print):
    """Score all unscored user predictions for a resolved halt.

    For H2+ halts, also carries forward any unscored H1 predictions for the
    same symbol/date — the H2 resume IS the resolution of the H1 prediction.

    Args:
        halt_id: e.g. "AAPL-2026-04-13-2"
        log: callable for logging (default: print)
    """
    log(f"[SCORE] Starting score for {halt_id}")
    sb = _get_supabase()

    # 1. Get halt result
    halt_resp = (
        sb.table('active_halts')
        .select('halt_price, resume_price, symbol')
        .eq('halt_id', halt_id)
        .single()
        .execute()
    )
    halt = halt_resp.data

    if not halt or not halt.get('resume_price') or not halt.get('halt_price'):
        log(f"[SCORE] {halt_id} skipped — no resume price (halt={halt})")
        return

    actual_direction = 'UP' if halt['resume_price'] > halt['halt_price'] else 'DOWN'

    # 2. Get all unscored predictions for this halt
    preds_resp = (
        sb.table('user_predictions')
        .select('*')
        .eq('halt_id', halt_id)
        .is_('was_direction_correct', 'null')
        .execute()
    )
    preds = preds_resp.data or []

    # 2b. H2+ carry-forward: score unscored H1 predictions for this symbol today.
    #     The H2 resume IS the resolution of those H1 predictions.
    symbol, date, halt_number = _parse_halt_id(halt_id)
    carried = 0
    if halt_number > 1:
        h1_halt_id = f"{symbol}-{date}-1"
        h1_resp = (
            sb.table('user_predictions')
            .select('*')
            .eq('halt_id', h1_halt_id)
            .is_('was_direction_correct', 'null')
            .execute()
        )
        h1_preds = h1_resp.data or []
        if h1_preds:
            carried = len(h1_preds)
            preds = preds + h1_preds
            log(f"[SCORE] {halt_id} — carrying forward {carried} H1 predictions from {h1_halt_id}")

    log(f"[SCORE] Found {len(preds)} predictions to score for {halt_id}")

    if not preds:
        log(f"[SCORE] {halt_id} — no predictions to score")
        return

    # 3. Score each prediction — per-row try/except so one bad row doesn't
    # abort the whole batch, and every failure is logged loudly.
    scored_count = 0
    for pred in preds:
        try:
            correct = pred['predicted_direction'] == actual_direction
            elo_change = 16 if correct else -16

            # Get current elo from last elo_history row or default 800
            elo_resp = (
                sb.table('elo_history')
                .select('elo_after')
                .eq('user_id', pred['user_id'])
                .order('created_at', desc=True)
                .limit(1)
                .execute()
            )
            elo_row = elo_resp.data
            elo_before = elo_row[0]['elo_after'] if elo_row else 800
            elo_after = max(0, elo_before + elo_change)

            # Update prediction row
            (
                sb.table('user_predictions')
                .update({
                    'was_direction_correct': correct,
                    'elo_before': elo_before,
                    'elo_after': elo_after,
                    'elo_change': elo_change,
                    'actual_reopen_price': halt['resume_price'],
                    'resolved_at': datetime.now(timezone.utc).isoformat(),
                })
                .eq('id', pred['id'])
                .execute()
            )

            # Insert elo_history row
            (
                sb.table('elo_history')
                .insert({
                    'user_id': pred['user_id'],
                    'halt_id': halt_id,
                    'symbol': halt['symbol'],
                    'elo_before': elo_before,
                    'elo_after': elo_after,
                    'elo_change': elo_change,
                    'was_correct': correct,
                })
                .execute()
            )
            scored_count += 1
        except Exception as e:
            import traceback
            log(f"[SCORE ERROR] pred_id={pred.get('id')} user_id={pred.get('user_id')} "
                f"halt_id={halt_id} — {type(e).__name__}: {e}")
            traceback.print_exc()

    # 4. Mark halt scored
    (
        sb.table('active_halts')
        .update({
            't_predictions_scored': datetime.now(timezone.utc).isoformat(),
        })
        .eq('halt_id', halt_id)
        .execute()
    )

    carried_msg = f" ({carried} carried from earlier halts)" if carried else ""
    failed = len(preds) - scored_count
    fail_msg = f", {failed} failed" if failed else ""
    log(f"[SCORE] {halt_id} — scored {scored_count}/{len(preds)} predictions{carried_msg}{fail_msg}, direction={actual_direction}")
    log(f"[SCORE] Complete — direction={actual_direction}")
