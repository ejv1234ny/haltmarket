from haltmarket_resolver.main import run


def test_run_returns_zero() -> None:
    assert run() == 0
