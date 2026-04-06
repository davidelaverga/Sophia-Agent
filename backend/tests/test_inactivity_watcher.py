"""Tests for the Sophia inactivity watcher."""

import asyncio
import time
from unittest.mock import patch

import pytest

from app.gateway.inactivity_watcher import (
    INACTIVITY_TIMEOUT,
    _active_threads,
    _check_inactive_threads,
    get_active_thread_count,
    register_activity,
    unregister_thread,
)
from app.gateway.inactivity_watcher import (
    reset_watcher as reset_watcher_state,
)


@pytest.fixture(autouse=True)
def reset_watcher():
    """Reset watcher state between tests."""
    reset_watcher_state()
    yield
    reset_watcher_state()


class TestRegisterActivity:
    def test_registers_new_thread(self):
        register_activity("t1", "user1", "sess1", "work")
        assert "t1" in _active_threads
        assert _active_threads["t1"]["user_id"] == "user1"
        assert _active_threads["t1"]["session_id"] == "sess1"
        assert _active_threads["t1"]["context_mode"] == "work"

    def test_updates_existing_thread(self):
        register_activity("t1", "user1", "sess1")
        first_time = _active_threads["t1"]["last_active"]
        time.sleep(0.01)
        register_activity("t1", "user1", "sess1")
        assert _active_threads["t1"]["last_active"] > first_time

    def test_multiple_threads(self):
        register_activity("t1", "user1", "sess1")
        register_activity("t2", "user2", "sess2")
        assert get_active_thread_count() == 2


class TestUnregisterThread:
    def test_removes_existing(self):
        register_activity("t1", "user1", "sess1")
        unregister_thread("t1")
        assert "t1" not in _active_threads

    def test_removes_nonexistent_is_noop(self):
        unregister_thread("nonexistent")  # should not raise


class TestCheckInactiveThreads:
    def test_fires_pipeline_for_idle_thread(self):
        register_activity("t1", "user1", "sess1", "work")
        _active_threads["t1"]["last_active"] = time.time() - INACTIVITY_TIMEOUT - 60

        with patch("deerflow.sophia.offline_pipeline.run_offline_pipeline") as mock_pipeline:
            asyncio.run(_check_inactive_threads())
            mock_pipeline.assert_called_once_with("user1", "sess1", "t1", None)

        assert "t1" not in _active_threads

    def test_does_not_fire_for_active_thread(self):
        register_activity("t1", "user1", "sess1")

        with patch("deerflow.sophia.offline_pipeline.run_offline_pipeline") as mock_pipeline:
            asyncio.run(_check_inactive_threads())
            mock_pipeline.assert_not_called()

    def test_pipeline_failure_still_removes_thread(self):
        register_activity("t1", "user1", "sess1")
        _active_threads["t1"]["last_active"] = time.time() - INACTIVITY_TIMEOUT - 60

        with patch("deerflow.sophia.offline_pipeline.run_offline_pipeline", side_effect=Exception("fail")):
            asyncio.run(_check_inactive_threads())

        assert "t1" not in _active_threads
