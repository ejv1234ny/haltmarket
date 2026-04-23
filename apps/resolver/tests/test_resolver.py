"""Unit tests for the Resolver class — fakes stand in for DB + Polygon.

No Postgres, no network. Exercises the branching logic between
`resolve`, `refund_timeout`, and the "Polygon returned nothing" path.
Integration tests in test_integration.py verify the SQL side of things
against a real database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from haltmarket_resolver.alerts import NullAlertSink
from haltmarket_resolver.db import RefundResult, ResolvableMarket, ResolveResult
from haltmarket_resolver.metrics import MetricsState
from haltmarket_resolver.polygon import ReopenPrice
from haltmarket_resolver.resolver import Resolver, ResolverConfig


@dataclass
class FakeDb:
    _is_leader: bool = True
    markets: list[ResolvableMarket] = field(default_factory=list)
    resolve_calls: list[tuple] = field(default_factory=list)
    refund_calls: list[tuple] = field(default_factory=list)
    global_sum_value: int = 0

    @property
    def is_leader(self) -> bool:
        return self._is_leader

    def list_resolvable_markets(
        self, *, cooldown_seconds: int, refund_deadline_minutes: int
    ) -> list[ResolvableMarket]:
        return list(self.markets)

    def resolve_market(
        self,
        halt_id: UUID,
        reopen_price: Decimal,
        reopen_at: datetime,
        reopen_source: str,
    ) -> ResolveResult:
        self.resolve_calls.append((halt_id, reopen_price, reopen_at, reopen_source))
        return ResolveResult(
            market_id=uuid4(),
            winning_bin_id=uuid4(),
            gross_pool_micro=1_000_000_000,
            fee_micro=50_000_000,
            closest_bonus_micro=70_000_000,
            closest_bonus_winner_user_id=uuid4(),
            main_payout_pool_micro=880_000_000,
            ledger_txn_id=uuid4(),
            idempotent_replay=False,
        )

    def refund_market(self, halt_id: UUID, reason: str) -> RefundResult:
        self.refund_calls.append((halt_id, reason))
        return RefundResult(
            market_id=uuid4(),
            refunded_bet_count=3,
            gross_refund_micro=3_000_000,
            ledger_txn_id=uuid4(),
            idempotent_replay=False,
        )

    def ledger_global_sum(self) -> int:
        return self.global_sum_value

    rehalt_at: datetime | None = None
    rehalt_calls: list[tuple] = field(default_factory=list)

    def latest_rehalt_after(
        self,
        symbol: str,
        after: datetime,
        exclude_halt_id: UUID,
    ) -> datetime | None:
        self.rehalt_calls.append((symbol, after, exclude_halt_id))
        return self.rehalt_at


@dataclass
class FakeFetcher:
    reopen: ReopenPrice | None = None
    calls: list[tuple] = field(default_factory=list)

    def fetch_reopen(
        self,
        symbol: str,
        since: datetime,
        opening_cross_window_seconds: int,
    ) -> ReopenPrice | None:
        self.calls.append((symbol, since, opening_cross_window_seconds))
        return self.reopen


@dataclass
class RecordingAlerts(NullAlertSink):
    warnings: list[str] = field(default_factory=list)
    criticals: list[str] = field(default_factory=list)
    infos: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def critical(self, message: str) -> None:
        self.criticals.append(message)

    def info(self, message: str) -> None:
        self.infos.append(message)


def _config() -> ResolverConfig:
    return ResolverConfig(
        post_reopen_cooldown_seconds=5,
        opening_cross_window_seconds=120,
        refund_deadline_minutes=15,
        rehalt_extension_minutes=5,
    )


def _market(
    action: str = "resolve",
    *,
    halt_end_time: datetime | None = None,
    locked_at: datetime | None = None,
) -> ResolvableMarket:
    now = datetime.now(UTC)
    return ResolvableMarket(
        market_id=uuid4(),
        halt_id=uuid4(),
        symbol="HMKT",
        halt_end_time=halt_end_time or now - timedelta(seconds=10),
        locked_at=locked_at or now - timedelta(seconds=10),
        total_pool_micro=1_000_000_000,
        action=action,
    )


def test_resolve_happy_path_calls_resolve_market() -> None:
    db = FakeDb(markets=[_market()])
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )
    metrics = MetricsState()
    alerts = RecordingAlerts()
    r = Resolver(db=db, trades_fetcher=fetcher, alerts=alerts, metrics=metrics, config=_config())

    actioned = r.run_once()

    assert actioned == 1
    assert len(db.resolve_calls) == 1
    assert db.refund_calls == []
    assert metrics.resolves_total == 1
    assert metrics.invariant_failures_total == 0
    assert alerts.criticals == []


def test_resolve_skipped_when_polygon_empty_and_deadline_not_crossed() -> None:
    now = datetime.now(UTC)
    # Locked only 5 minutes ago → 15-min refund deadline not yet crossed.
    db = FakeDb(markets=[_market(locked_at=now - timedelta(minutes=5))])
    fetcher = FakeFetcher(reopen=None)
    metrics = MetricsState()
    r = Resolver(
        db=db, trades_fetcher=fetcher, alerts=RecordingAlerts(),
        metrics=metrics, config=_config(),
    )

    actioned = r.run_once()

    assert actioned == 0
    assert db.resolve_calls == []
    assert db.refund_calls == []
    assert metrics.polygon_empty_total == 1


def test_refund_on_timeout_when_polygon_silent_beyond_deadline() -> None:
    now = datetime.now(UTC)
    # Locked 20 minutes ago → deadline crossed; trigger refund even if
    # list_resolvable_markets still tags it 'resolve' (race on the tick).
    db = FakeDb(markets=[_market(locked_at=now - timedelta(minutes=20))])
    fetcher = FakeFetcher(reopen=None)
    metrics = MetricsState()
    alerts = RecordingAlerts()
    r = Resolver(db=db, trades_fetcher=fetcher, alerts=alerts, metrics=metrics, config=_config())

    actioned = r.run_once()

    assert actioned == 1
    assert db.resolve_calls == []
    assert len(db.refund_calls) == 1
    assert db.refund_calls[0][1].startswith("refund_timeout")
    assert metrics.refunds_total == 1
    assert len(alerts.infos) == 1


def test_explicit_refund_action_short_circuits_polygon() -> None:
    db = FakeDb(markets=[_market(action="refund_timeout")])
    fetcher = FakeFetcher()  # should not be called
    metrics = MetricsState()
    r = Resolver(
        db=db, trades_fetcher=fetcher, alerts=RecordingAlerts(),
        metrics=metrics, config=_config(),
    )

    r.run_once()

    assert db.refund_calls
    assert fetcher.calls == []


def test_idempotent_replay_still_counts_as_action() -> None:
    db = FakeDb(markets=[_market()])
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )

    # Patch resolve_market to return idempotent_replay=True.
    original = db.resolve_market

    def replay_resolve(*args, **kwargs) -> ResolveResult:
        real = original(*args, **kwargs)
        return ResolveResult(**{**real.__dict__, "idempotent_replay": True})

    db.resolve_market = replay_resolve  # type: ignore[assignment]
    metrics = MetricsState()
    r = Resolver(
        db=db, trades_fetcher=fetcher, alerts=RecordingAlerts(),
        metrics=metrics, config=_config(),
    )

    assert r.run_once() == 1
    # Replay still increments the counter because the market was actioned.
    assert metrics.resolves_total == 1


def test_critical_alert_when_global_sum_nonzero_after_resolve() -> None:
    db = FakeDb(markets=[_market()], global_sum_value=-1)
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )
    metrics = MetricsState()
    alerts = RecordingAlerts()
    r = Resolver(db=db, trades_fetcher=fetcher, alerts=alerts, metrics=metrics, config=_config())

    r.run_once()

    assert metrics.invariant_failures_total == 1
    assert any("SUM != 0" in c for c in alerts.criticals)


def test_latency_warning_fires_over_120s() -> None:
    # Mark halt_end_time far in the past so the computed settlement is big.
    far = datetime.now(UTC) - timedelta(seconds=200)
    db = FakeDb(markets=[_market(halt_end_time=far, locked_at=far)])
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )
    metrics = MetricsState()
    alerts = RecordingAlerts()
    r = Resolver(db=db, trades_fetcher=fetcher, alerts=alerts, metrics=metrics, config=_config())

    r.run_once()

    assert any("latency" in w for w in alerts.warnings)


def test_batch_isolation_one_bad_market_does_not_kill_others() -> None:
    good = _market()
    bad = _market()

    class FlakyDb(FakeDb):
        def resolve_market(self, halt_id, reopen_price, reopen_at, reopen_source):  # type: ignore[override]
            if halt_id == bad.halt_id:
                raise RuntimeError("simulated transient failure")
            return super().resolve_market(halt_id, reopen_price, reopen_at, reopen_source)

    db = FlakyDb(markets=[bad, good])
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )
    metrics = MetricsState()
    r = Resolver(
        db=db, trades_fetcher=fetcher, alerts=RecordingAlerts(),
        metrics=metrics, config=_config(),
    )

    actioned = r.run_once()

    # The good market still actioned; the bad one counted as an error.
    assert actioned == 1
    assert metrics.resolve_errors_total == 1


def test_refund_deferred_when_rehalt_within_extension_window() -> None:
    now = datetime.now(UTC)
    market = _market(action="refund_timeout", locked_at=now - timedelta(minutes=20))
    db = FakeDb(markets=[market])
    # Re-halt landed 1 minute ago — within the 5-minute extension window.
    db.rehalt_at = now - timedelta(minutes=1)
    metrics = MetricsState()
    r = Resolver(
        db=db,
        trades_fetcher=FakeFetcher(),
        alerts=RecordingAlerts(),
        metrics=metrics,
        config=_config(),
    )

    actioned = r.run_once()

    assert actioned == 0
    assert db.refund_calls == []
    assert metrics.refunds_total == 0
    assert metrics.rehalt_extensions_total == 1


def test_refund_proceeds_when_rehalt_outside_extension_window() -> None:
    now = datetime.now(UTC)
    market = _market(action="refund_timeout", locked_at=now - timedelta(minutes=20))
    db = FakeDb(markets=[market])
    # Re-halt was 10 minutes ago — beyond the 5-minute window.
    db.rehalt_at = now - timedelta(minutes=10)
    metrics = MetricsState()
    r = Resolver(
        db=db,
        trades_fetcher=FakeFetcher(),
        alerts=RecordingAlerts(),
        metrics=metrics,
        config=_config(),
    )

    r.run_once()

    assert len(db.refund_calls) == 1
    assert metrics.rehalt_extensions_total == 0


def test_refund_deferred_via_polygon_silent_path() -> None:
    now = datetime.now(UTC)
    # action='resolve' but deadline passed and polygon empty. Re-halt present
    # → defer even though we reached the polygon-silent refund branch.
    market = _market(action="resolve", locked_at=now - timedelta(minutes=20))
    db = FakeDb(markets=[market])
    db.rehalt_at = now - timedelta(minutes=2)
    metrics = MetricsState()
    r = Resolver(
        db=db,
        trades_fetcher=FakeFetcher(reopen=None),
        alerts=RecordingAlerts(),
        metrics=metrics,
        config=_config(),
    )

    r.run_once()

    assert db.refund_calls == []
    assert metrics.rehalt_extensions_total == 1


@pytest.mark.parametrize("action", ["resolve", "refund_timeout"])
def test_runs_when_leader(action: str) -> None:
    db = FakeDb(markets=[_market(action=action)])
    fetcher = FakeFetcher(
        reopen=ReopenPrice(
            symbol="HMKT",
            price=Decimal("42.8700"),
            traded_at=datetime.now(UTC),
            source="polygon:opening_cross",
        )
    )
    metrics = MetricsState()
    r = Resolver(
        db=db, trades_fetcher=fetcher, alerts=RecordingAlerts(),
        metrics=metrics, config=_config(),
    )

    r.run_once()

    assert metrics.is_leader == 1
