"""Unit tests for executor's terminal-state push to the Gateway registry.

Validates that persist_background_task_status_payload fires the gateway
notify hook for all four terminal SubagentStatus values (completed /
failed / timed_out / cancelled) and stays silent for non-terminal ones.

Uses the same circular-import workaround as ``test_subagent_executor.py``:
drops conftest's pre-mock for ``deerflow.subagents.executor`` and mocks
out the heavier agent dependency graph so the real executor module can
be imported.
"""

from __future__ import annotations

import sys
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

_MOCKED_MODULE_NAMES = [
    "deerflow.agents",
    "deerflow.agents.thread_state",
    "deerflow.agents.middlewares",
    "deerflow.agents.middlewares.thread_data_middleware",
    "deerflow.sandbox",
    "deerflow.sandbox.middleware",
    "deerflow.models",
]


@pytest.fixture(scope="module", autouse=True)
def _setup_real_executor():
    """Swap out the conftest pre-mock and import the real executor."""
    original_modules = {name: sys.modules.get(name) for name in _MOCKED_MODULE_NAMES}
    original_executor = sys.modules.get("deerflow.subagents.executor")

    if "deerflow.subagents.executor" in sys.modules:
        del sys.modules["deerflow.subagents.executor"]
    if "deerflow.subagents" in sys.modules:
        del sys.modules["deerflow.subagents"]

    for name in _MOCKED_MODULE_NAMES:
        sys.modules[name] = MagicMock()

    from deerflow.subagents import executor as real_executor
    from deerflow.subagents.executor import SubagentResult, SubagentStatus

    yield {
        "executor": real_executor,
        "SubagentResult": SubagentResult,
        "SubagentStatus": SubagentStatus,
    }

    # Restore
    for name in _MOCKED_MODULE_NAMES:
        if original_modules[name] is not None:
            sys.modules[name] = original_modules[name]
        elif name in sys.modules:
            del sys.modules[name]
    if original_executor is not None:
        sys.modules["deerflow.subagents.executor"] = original_executor
    elif "deerflow.subagents.executor" in sys.modules:
        del sys.modules["deerflow.subagents.executor"]


def _make_result(classes, status):
    SubagentResult = classes["SubagentResult"]
    SubagentStatus = classes["SubagentStatus"]
    return SubagentResult(
        task_id="task-1",
        trace_id="trace-1",
        status=status,
        owner_id=None,
        started_at=datetime.now(),
        completed_at=datetime.now() if status != SubagentStatus.PENDING else None,
        error="boom" if status == SubagentStatus.FAILED else None,
        final_state={"builder_result": {"artifact_path": "/x/y"}}
        if status == SubagentStatus.COMPLETED
        else None,
    )


class TestMaybeNotifyGatewayOfTerminal:
    def test_no_op_on_pending(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].PENDING)
            )
            mock_notify.assert_not_called()

    def test_no_op_on_running(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].RUNNING)
            )
            mock_notify.assert_not_called()

    def test_no_op_when_not_configured(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].COMPLETED)
            )
            mock_notify.assert_not_called()

    def test_fires_on_completed(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].COMPLETED)
            )
            mock_notify.assert_called_once()
            task_id, payload = mock_notify.call_args.args
            assert task_id == "task-1"
            assert payload["status"] == "completed"
            assert payload["builder_result"] == {"artifact_path": "/x/y"}
            assert payload["completed_at"] is not None

    def test_fires_on_failed(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].FAILED)
            )
            mock_notify.assert_called_once()
            _, payload = mock_notify.call_args.args
            assert payload["status"] == "failed"
            assert payload["error"] == "boom"

    def test_fires_on_timed_out(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].TIMED_OUT)
            )
            mock_notify.assert_called_once()
            _, payload = mock_notify.call_args.args
            assert payload["status"] == "timed_out"

    def test_fires_on_cancelled(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].CANCELLED)
            )
            mock_notify.assert_called_once()
            _, payload = mock_notify.call_args.args
            assert payload["status"] == "cancelled"

    def test_swallows_notify_exception(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch(
            "deerflow.sophia.storage.gateway_notify.notify_builder_task_status",
            side_effect=RuntimeError("boom"),
        ):
            classes["executor"]._maybe_notify_gateway_of_terminal(
                _make_result(classes, classes["SubagentStatus"].COMPLETED)
            )


class TestPersistBackgroundTaskStatusPayload:
    def test_no_owner_still_fires_notify(self, monkeypatch, _setup_real_executor):
        classes = _setup_real_executor
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        with patch("deerflow.sophia.storage.gateway_notify.notify_builder_task_status") as mock_notify:
            classes["executor"].persist_background_task_status_payload(
                _make_result(classes, classes["SubagentStatus"].COMPLETED)
            )
            mock_notify.assert_called_once()
