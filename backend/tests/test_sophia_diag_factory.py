"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import asyncio
import contextvars
from uuid import uuid4

import pytest
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from sophia_diag_fixture import SECRET_DETAIL, _assert_content_free, _events, _mock_store, _one
from sophia_diag_fixture import diag_logs as _diag_logs

from deerflow.sophia import diag

diag_logs = _diag_logs


def test_graph_factory_event_once_per_call_with_segments(diag_logs):
    store = _mock_store()

    @diag.timed_graph_factory("sophia_builder")
    def inner(config):
        diag.factory_segment_add("guard_init", 4)
        with diag.factory_segment("foundation_probe"):
            store.get_contract()
        diag.factory_mark("pre_compile")
        return "graph"

    @diag.timed_graph_factory("sophia_builder")
    def outer(config):
        return inner(config)

    config = {"configurable": {"run_id": str(uuid4()), "thread_id": str(uuid4())}}
    assert outer(config) == "graph"
    _, event = _one(diag_logs, "graph.factory")
    assert event["graph"] == "sophia_builder" and event["outcome"] == "ok" and event["for_execution"] is False
    assert event["guard_init_ms"] == 4 and isinstance(event["foundation_probe_ms"], int) and isinstance(event["compile_ms"], int)
    assert event["store_requests"] == 1 and event["run_id"] == config["configurable"]["run_id"]
    assert diag.current_run_diag() is None


def test_graph_factory_error_is_logged_and_reraised(diag_logs):
    @diag.timed_graph_factory("sophia_companion")
    def broken(config):
        raise ValueError(SECRET_DETAIL)

    with pytest.raises(ValueError, match=SECRET_DETAIL):
        broken({})
    _, event = _one(diag_logs, "graph.factory")
    assert event["outcome"] == "error" and event["error_type"] == "ValueError"
    _assert_content_free(diag_logs)


def test_async_factory_is_timed_at_entry_and_execution_run_keeps_accumulator(diag_logs):
    from contextlib import asynccontextmanager

    @diag.timed_graph_factory("sophia_builder")
    def sync_factory(config):
        return "graph"

    @diag.timed_graph_factory("sophia_builder")
    @asynccontextmanager
    async def factory(config):
        yield sync_factory(config)

    run_id = str(uuid4())
    config = {"configurable": {"run_id": run_id, "__is_for_execution__": True}}

    async def main():
        manager = factory(config)
        assert _events(diag_logs, "graph.factory") == []
        async with manager as graph:
            assert graph == "graph"
            # A run's accumulator stays current for the rest of the run task.
            run = diag.current_run_diag()
            assert run is not None and run.run_scoped
        return run

    contextvars.copy_context().run(asyncio.run, main())
    _, event = _one(diag_logs, "graph.factory")
    assert event["for_execution"] is True and event["run_id"] == run_id
    assert "since_run_start_ms" in diag.run_timing(run_id)
    assert diag.current_run_diag() is None


def test_registered_factories_keep_their_server_signature():
    from langgraph_api._factory_utils import _classify_factory

    from deerflow.agents.sophia_agent import make_sophia_agent
    from deerflow.agents.sophia_agent.builder_agent import make_sophia_builder, make_sophia_builder_with_distributed_tracing

    for factory in (make_sophia_agent, make_sophia_builder, make_sophia_builder_with_distributed_tracing):
        assert hasattr(factory, "__wrapped__")
        hook = _classify_factory(factory)
        assert hook({"configurable": {}}, object()) == {"config": {"configurable": {}}}


# ---------------------------------------------------------------------------
# Builder progress (langgraph POST, gateway receipt, canvas fan-out)
# ---------------------------------------------------------------------------
