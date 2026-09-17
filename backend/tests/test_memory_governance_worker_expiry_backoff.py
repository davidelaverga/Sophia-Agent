"""A failing retention expiry must not become a per-second retry storm.

Observed in production on 2026-09-17: `permission denied for function
sophia_memory_expire_candidates` was logged roughly once per second,
continuously, producing ~73,000 Postgres errors in 24 hours and putting the
Supabase project into an Unhealthy state.

Two compounding causes, both fixed here and both present on the shared branch:

1. `_last_expiry_at` was stamped only after a *successful* call, so a failing
   expiry never advanced it. The surrounding poll loop runs every second, so the
   hourly job retried every second forever -- roughly 3,600x its intended rate.
2. The exception escaped `run_once`, which skipped the extraction and projection
   workers underneath it for as long as expiry kept failing.
"""

import asyncio
import time
from unittest.mock import Mock

import pytest

from app.gateway.workers.memory_governance import MemoryGovernanceWorker


class _Extraction:
    def __init__(self, expire_side_effect=None, expire_return=0):
        self.governance_store = Mock()
        if expire_side_effect is not None:
            self.governance_store.expire_candidates = Mock(side_effect=expire_side_effect)
        else:
            self.governance_store.expire_candidates = Mock(return_value=expire_return)
        self.run_once = Mock(return_value=False)
        self.recover_finalized_sessions = Mock(return_value=0)


def _worker(extraction, projection=None):
    return MemoryGovernanceWorker(extraction=extraction, projection=projection, recovery_principals=())


def test_failing_expiry_is_attempted_once_per_interval_not_once_per_poll():
    extraction = _Extraction(expire_side_effect=RuntimeError("permission denied for function"))
    worker = _worker(extraction)

    for _ in range(50):
        asyncio.run(worker.run_once())

    # Before the fix this was 50: every poll retried the failing RPC.
    assert extraction.governance_store.expire_candidates.call_count == 1


def test_failing_expiry_does_not_stop_extraction_and_projection():
    extraction = _Extraction(expire_side_effect=RuntimeError("permission denied for function"))
    projection = Mock()
    projection.run_once = Mock(return_value=False)
    worker = _worker(extraction, projection)

    asyncio.run(worker.run_once())

    # Before the fix the raise escaped run_once and both were skipped.
    assert extraction.run_once.call_count == 1
    assert projection.run_once.call_count == 1


def test_expiry_runs_again_once_the_interval_has_elapsed(monkeypatch):
    extraction = _Extraction(expire_side_effect=RuntimeError("still denied"))
    worker = _worker(extraction)

    asyncio.run(worker.run_once())
    assert extraction.governance_store.expire_candidates.call_count == 1

    # Pretend an hour passed. The attempt is retried, but only now.
    real_monotonic = time.monotonic
    monkeypatch.setattr(
        "app.gateway.workers.memory_governance.time.monotonic",
        lambda: real_monotonic() + 3601,
    )
    asyncio.run(worker.run_once())
    assert extraction.governance_store.expire_candidates.call_count == 2


def test_successful_expiry_still_reports_work():
    extraction = _Extraction(expire_return=7)
    worker = _worker(extraction)

    assert asyncio.run(worker.run_once()) is True
    assert extraction.governance_store.expire_candidates.call_count == 1


@pytest.mark.parametrize("failure", [RuntimeError("boom"), TimeoutError("slow"), ValueError("bad")])
def test_any_expiry_failure_is_contained(failure):
    extraction = _Extraction(expire_side_effect=failure)
    worker = _worker(extraction)

    # No exception escapes, whatever the store raises.
    assert asyncio.run(worker.run_once()) is False

def test_cancellation_is_not_swallowed_by_the_expiry_guard():
    """Containment must not turn a shutdown into a caught error.

    asyncio.CancelledError derives from BaseException, not Exception, so the
    guard cannot catch it -- but that is a property of the language the fix
    depends on, so it is pinned here rather than assumed.
    """
    extraction = _Extraction(expire_side_effect=asyncio.CancelledError())
    worker = _worker(extraction)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(worker.run_once())


def test_expiry_guard_does_not_touch_the_recovery_stage():
    """Recovery runs before expiry and must be unaffected by its failure."""
    extraction = _Extraction(expire_side_effect=RuntimeError("denied"))
    worker = MemoryGovernanceWorker(
        extraction=extraction, projection=None, recovery_principals=("owner-a",)
    )

    asyncio.run(worker.run_once())

    assert extraction.recover_finalized_sessions.call_count == 1
    assert extraction.run_once.call_count == 1
