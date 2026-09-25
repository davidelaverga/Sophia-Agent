from __future__ import annotations

import asyncio

import pytest
from voice.realtime.gemini_production_session import (
    GeminiProductionBrowserSessionManager,
    _ProviderCleanupWatch,
)


class BrowserSessions:
    exists = True
    closes = 0

    def session_exists(self, _session_id):
        return self.exists

    def trace_fault_for_session(self, _session_id):
        return None

    def provider_epoch_snapshot(self, _session_id):
        return (1,) if self.exists else ()

    async def close_session(self, _session_id, **_kwargs):
        previously = self.exists
        self.exists = False
        self.closes += 1
        return previously


def fixture():
    browser = BrowserSessions()
    manager = GeminiProductionBrowserSessionManager(browser)
    watch = _ProviderCleanupWatch(
        admission_id="admission-one",
        cleanup_obligation_id="obligation-one",
        resource_id="provider-one",
        reserved_lease_expires_at="2033-05-18T04:01:20.000Z",
        resource_expires_at="2033-05-18T04:03:20.000Z",
    )
    manager._cleanup_watches[watch.resource_id] = watch
    return browser, manager, watch


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["browser_closed", "activation_aborted", "browser_active", "credential_minted", "missing", "unknown", "wrong_deadline", "d02_freeze", "unavailable"])
async def test_settlement_requires_exact_receiving_proof(monkeypatch, status):
    browser, manager, watch = fixture()
    actions = []

    async def callback(observed_watch, action, **_kwargs):
        assert observed_watch == watch
        actions.append(action)
        if action == "complete":
            return {"completed": True}
        if status == "unavailable":
            return None
        return {
            "authorized": False,
            "status": "browser_closed" if status in {"wrong_deadline", "d02_freeze"} else status,
            "resource_expires_at": "wrong" if status == "wrong_deadline" else watch.resource_expires_at,
            **({"d02_freeze": {"frozen": True}} if status == "d02_freeze" else {}),
        }

    monkeypatch.setattr(manager, "_post_cleanup_callback", callback)
    expected = status in {"browser_closed", "activation_aborted"}
    assert await manager.settle_acknowledged_browser_cleanup(watch.resource_id) is expected
    assert browser.exists is not expected
    assert actions == (["authorize", "complete"] if expected else ["authorize"])
    assert (watch.resource_id not in manager._cleanup_watches) is expected


@pytest.mark.anyio
async def test_completion_failure_keeps_watch_and_retry_settles_without_inventing_close(monkeypatch):
    browser, manager, watch = fixture()
    completion = False

    async def callback(_watch, action, **_kwargs):
        return {"completed": completion} if action == "complete" else {"status": "browser_closed", "resource_expires_at": watch.resource_expires_at}

    monkeypatch.setattr(manager, "_post_cleanup_callback", callback)
    assert await manager.settle_acknowledged_browser_cleanup(watch.resource_id) is False
    assert browser.exists is False
    assert watch.resource_id in manager._cleanup_watches
    completion = True
    assert await manager.settle_acknowledged_browser_cleanup(watch.resource_id) is True
    assert watch.resource_id not in manager._cleanup_watches


@pytest.mark.anyio
async def test_concurrent_requests_share_owner_lock(monkeypatch):
    browser, manager, watch = fixture()

    async def callback(_watch, action, **_kwargs):
        await asyncio.sleep(0)
        return {"completed": True} if action == "complete" else {"status": "browser_closed", "resource_expires_at": watch.resource_expires_at}

    monkeypatch.setattr(manager, "_post_cleanup_callback", callback)
    assert await asyncio.gather(*(manager.settle_acknowledged_browser_cleanup(watch.resource_id) for _ in range(2))) == [True, False]
    assert browser.closes == 1


@pytest.mark.anyio
async def test_bounded_authority_timeout_keeps_owned_resource_for_recovery(monkeypatch):
    browser, manager, watch = fixture()

    async def callback(*_args, **_kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr(manager, "_post_cleanup_callback", callback)
    started = asyncio.get_running_loop().time()
    assert await manager.settle_acknowledged_browser_cleanup(watch.resource_id) is False
    assert asyncio.get_running_loop().time() - started < 4
    assert browser.exists
    assert watch.resource_id in manager._cleanup_watches
