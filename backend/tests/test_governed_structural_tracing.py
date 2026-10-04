"""Governed (MEM00) Builder runs: excluded by default, structure-only when opted in.

The decisive property: under ``SOPHIA_GOVERNED_STRUCTURAL_TRACING`` nothing a
governed owner said or the Builder produced can reach LangSmith. Every payload
any LangSmith client would send is captured at two layers - the SDK's public
run/feedback entry points (``create_run``/``update_run``/``batch_ingest_runs``/
``multipart_ingest``/``create_feedback`` on the base ``Client``, which every
client, redacting or not, goes through) and the HTTP layer
(``request_with_retries``: ``/runs``, ``/runs/batch``, ``/runs/multipart``,
``/feedback``) - and searched for a sentinel injected into every content-bearing
place: user message, system prompt, tool arguments, tool result, model output,
exception message, run metadata and tags.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import socket
import uuid
from contextlib import ExitStack
from typing import Any

import langsmith
import pytest
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool
from langsmith import schemas as ls_schemas
from langsmith import traceable
from langsmith import utils as ls_utils
from langsmith.run_helpers import tracing_context
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name

from deerflow.config import tracing_config as tracing_module
from deerflow.sophia import governed_tracing, observability

SENTINEL = "SENTINEL_9f3c"
_BASE_METHODS = ("create_run", "update_run", "batch_ingest_runs", "multipart_ingest", "create_feedback")


class _Response:
    status_code = 200
    text = ""
    headers: dict[str, str] = {}

    def json(self) -> dict[str, Any]:
        return {}

    def raise_for_status(self) -> None:
        return None


class _Capture:
    def __init__(self) -> None:
        self.entry: list[tuple[str, str, Any]] = []
        self.wire: list[tuple[str, str, str, str]] = []

    def entry_blob(self) -> str:
        return json.dumps([item[2] for item in self.entry], default=str)

    def wire_blob(self) -> str:
        return "\n".join(item[3] for item in self.wire)

    def redacted_entries(self, method: str) -> list[dict[str, Any]]:
        return [item[2] for item in self.entry if item[0] == "StructuralRedactingClient" and item[1] == method]


def _flatten_body(data: Any) -> str:
    if hasattr(data, "to_string"):
        data = data.to_string()
    if isinstance(data, bytes):
        return data.decode("utf-8", "replace")
    return data if isinstance(data, str) else repr(data)


@pytest.fixture
def capture(monkeypatch) -> Any:
    def forbidden_network(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("NETWORK_NOT_ALLOWED")

    monkeypatch.setattr(socket.socket, "connect", forbidden_network)
    for name in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGSMITH_RUNS_ENDPOINTS", "LANGSMITH_WORKSPACE_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SOPHIA_GOVERNED_STRUCTURAL_TRACING", "true")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "synthetic-only")
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://trace.invalid")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    tracing_module._tracing_config = None
    ls_utils.get_env_var.cache_clear()
    monkeypatch.setattr(langsmith.run_trees, "_CLIENT", None, raising=False)
    observability._CLIENT_CACHE.clear()

    recorded = _Capture()

    def request_with_retries(self: Any, method: str, pathname: str, *_args: Any, request_kwargs: Any = None, **kwargs: Any) -> Any:
        body = (request_kwargs or {}).get("data")
        if body is None and "json" in (request_kwargs or {}):
            body = json.dumps(request_kwargs["json"], default=str)
        recorded.wire.append((type(self).__name__, method, pathname, _flatten_body(body) + json.dumps(kwargs.get("params"), default=str)))
        return _Response()

    monkeypatch.setattr(langsmith.Client, "request_with_retries", request_with_retries)
    monkeypatch.setattr(langsmith.Client, "info", property(lambda self: ls_schemas.LangSmithInfo()))
    for method in _BASE_METHODS:
        original = getattr(langsmith.Client, method)

        def recorder(self: Any, *args: Any, _original: Any = original, _method: str = method, **kwargs: Any) -> Any:
            # Snapshot: the SDK mutates run dicts in place while serialising.
            recorded.entry.append((type(self).__name__, _method, copy.deepcopy({"args": args, **kwargs})))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(langsmith.Client, method, recorder)
    yield recorded
    for client in list(observability._CLIENT_CACHE.values()):
        try:
            client.flush()
        except Exception:  # noqa: BLE001 - best-effort cleanup of the test client.
            pass
    observability._CLIENT_CACHE.clear()
    tracing_module._tracing_config = None
    ls_utils.get_env_var.cache_clear()


class _ScriptedChatModel(BaseChatModel):
    script: list[Any] = []

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return ChatResult(generations=[ChatGeneration(message=step)])

    def bind_tools(self, tools: Any, **kwargs: Any) -> _ScriptedChatModel:
        return self

    @property
    def _llm_type(self) -> str:
        return "structural-fake"


@traceable(name="inner_traceable")
def _inner_traceable(query: str) -> str:
    return f"{SENTINEL} traceable output for {query}"


@tool
def lookup(query: str) -> str:
    """Look up a record."""

    # A child whose callbacks were dropped (LangChain would build its own
    # tracer from the ambient context) and a @traceable child: neither may
    # produce an unredacted run.
    RunnableLambda(lambda value: f"{SENTINEL} inner output {value}").invoke(f"{SENTINEL} inner input", {"callbacks": []})
    _inner_traceable(f"{SENTINEL} traceable input")
    return f"{SENTINEL} tool result for {query}"


def _explicit_model_tracer() -> Any:
    """What ``deerflow.models.factory`` attaches to a model under LANGSMITH_TRACING=true:
    an explicit tracer on the default, unredacted client."""

    from langchain_core.tracers.langchain import LangChainTracer

    plain = langsmith.Client(api_url="https://trace.invalid", api_key="synthetic-only", auto_batch_tracing=False)
    return LangChainTracer(project_name="explicit-model-tracer", client=plain)


def _successful_agent() -> Any:
    model = _ScriptedChatModel(
        callbacks=[_explicit_model_tracer()],
        script=[
            AIMessage(
                content=f"{SENTINEL} thinking",
                tool_calls=[{"name": "lookup", "args": {"query": f"{SENTINEL} tool args"}, "id": "call_1"}],
                usage_metadata={"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
            ),
            AIMessage(
                content=f"{SENTINEL} final answer",
                usage_metadata={"input_tokens": 23, "output_tokens": 5, "total_tokens": 28},
            ),
        ],
    )
    return create_agent(model=model, tools=[lookup], system_prompt=f"{SENTINEL} system prompt")


def _failing_agent() -> Any:
    model = _ScriptedChatModel(callbacks=[_explicit_model_tracer()], script=[ValueError(f"{SENTINEL} provider exploded")])
    return create_agent(model=model, tools=[lookup], system_prompt=f"{SENTINEL} system prompt")


def _trace_config(thread_id: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread_id,
            "user_id": f"{SENTINEL}-owner",
            "voice_session_id": SENTINEL,
        },
        "metadata": {"note": SENTINEL},
    }


def _wrap(agent: Any, thread_id: str) -> Any:
    return observability.wrap_governed_builder_runnable(
        agent,
        model_name="structural-fake",
        model_source="test",
        trace_config=_trace_config(thread_id),
    )


_RUN_INPUT = {"messages": [{"role": "user", "content": f"{SENTINEL} user message"}]}
_RUN_CONFIG = {"metadata": {"note": SENTINEL, "user_id": f"{SENTINEL}-owner"}, "tags": [SENTINEL]}


def _ambient_context(mode: str, monkeypatch: Any, stack: ExitStack) -> None:
    if mode == "none":
        return
    plain = langsmith.Client(api_url="https://trace.invalid", api_key="synthetic-only", auto_batch_tracing=False)
    if mode == "env_autotrace":
        monkeypatch.setenv("LANGSMITH_TRACING", "true")
        monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
        ls_utils.get_env_var.cache_clear()
        tracing_module._tracing_config = None
        return
    if mode == "tracing_context":
        stack.enter_context(tracing_context(enabled=True, client=plain, project_name="ambient", metadata={"leak": SENTINEL}, tags=[SENTINEL]))
        return
    # "distributed_parent": the voice caller's restored trace parent with its
    # own client, inherited metadata/tags and a write replica.
    voice_root = langsmith.RunTree(name="gemini_live_conversation", inputs={"q": SENTINEL}, client=plain)
    voice_tool = voice_root.create_child(name="function_call:start_builder_task", run_type="tool", inputs={"q": SENTINEL})
    stack.enter_context(
        tracing_context(
            enabled=True,
            parent=voice_tool.to_headers(),
            client=plain,
            project_name="voice-project",
            metadata={"voice_note": SENTINEL},
            tags=[SENTINEL],
            replicas=[{"project_name": "replica-project", "updates": {"note": SENTINEL}}],
        )
    )


async def _drive(served: Any, failing: Any) -> None:
    # Exactly what langgraph_api's worker does with the copied graph.
    async for _chunk in served.astream(_RUN_INPUT, _RUN_CONFIG, stream_mode=["values", "messages", "debug", "updates"]):
        pass
    with pytest.raises(ValueError):
        async for _event in failing.astream_events(_RUN_INPUT, _RUN_CONFIG, version="v2"):
            pass


@pytest.mark.parametrize("ambient", ["none", "tracing_context", "env_autotrace", "distributed_parent"])
def test_governed_structural_trace_exports_structure_and_never_content(capture, monkeypatch, ambient) -> None:
    thread_id = str(uuid.uuid4())
    served = _wrap(_successful_agent(), thread_id).copy(update={"checkpointer": None, "store": None})
    failing = _wrap(_failing_agent(), thread_id).copy(update={})
    assert type(served) is observability.GovernedStructuralTraceRunnable

    with ExitStack() as stack:
        _ambient_context(ambient, monkeypatch, stack)
        asyncio.run(_drive(served, failing))
    observability._governed_structural_client().flush()

    # Every operation reached the SDK through the redacting client only.
    assert capture.entry, "structural tracing posted nothing"
    assert {item[0] for item in capture.entry} == {"StructuralRedactingClient"}
    assert {item[0] for item in capture.wire} == {"StructuralRedactingClient"}
    assert SENTINEL not in capture.entry_blob()
    assert SENTINEL not in capture.wire_blob()
    assert f"{SENTINEL}-owner" not in capture.wire_blob()

    creates = capture.redacted_entries("create_run")
    updates = capture.redacted_entries("update_run")
    names = {item["args"][0] for item in creates}
    run_types = {item["args"][2] for item in creates}
    assert {"Sophia Builder", "model", "tools", "lookup"} <= names
    assert {"chain", "llm", "tool"} <= run_types
    assert all(item["args"][1] == {} for item in creates)
    assert all(item.get("start_time") for item in creates)
    assert any(item.get("end_time") for item in updates)
    assert all(item["extra"]["metadata"]["sophia_trace_mode"] == "governed_structural" for item in creates + updates)
    assert all(item["extra"]["metadata"].get("thread_id") in {None, thread_id} for item in creates)

    usage = [item["outputs"]["usage_metadata"] for item in updates if item.get("outputs")]
    assert {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18} in usage
    assert {"input_tokens": 23, "output_tokens": 5, "total_tokens": 28} in usage
    errors = {item["error"] for item in updates if item.get("error")}
    assert errors == {"ValueError"}

    wire = capture.wire_blob()
    assert "Sophia Builder" in wire and "input_tokens" in wire and "governed_structural" in wire


def test_governed_builder_is_fully_excluded_when_structural_tracing_is_off(capture, monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_GOVERNED_STRUCTURAL_TRACING")
    thread_id = str(uuid.uuid4())
    served = _wrap(_successful_agent(), thread_id).copy(update={})
    failing = _wrap(_failing_agent(), thread_id).copy(update={})
    assert type(served) is observability.LangSmithTraceDisabledRunnable

    for ambient in ("tracing_context", "distributed_parent", "env_autotrace"):
        with ExitStack() as stack:
            _ambient_context(ambient, monkeypatch, stack)
            served = _wrap(_successful_agent(), thread_id).copy(update={})
            failing = _wrap(_failing_agent(), thread_id).copy(update={})
            asyncio.run(_drive(served, failing))

    assert capture.entry == []
    assert capture.wire == []


@pytest.mark.parametrize(
    "env",
    [
        {"SOPHIA_BUILDER_LANGSMITH_TRACING": "false"},
        {"LANGSMITH_API_KEY": ""},
    ],
)
def test_structural_mode_requires_configured_builder_tracing(capture, monkeypatch, env) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    tracing_module._tracing_config = None

    wrapped = _wrap(_successful_agent(), str(uuid.uuid4()))

    assert type(wrapped) is observability.LangSmithTraceDisabledRunnable


def test_structural_client_failure_falls_back_to_exclusion_not_a_plain_client(capture, monkeypatch, caplog) -> None:
    def unavailable(**_kwargs: Any) -> Any:
        raise RuntimeError(f"{SENTINEL} constructor detail")

    monkeypatch.setattr(observability, "build_structural_client", unavailable)
    caplog.set_level(logging.INFO, logger=observability.__name__)

    wrapped = _wrap(_successful_agent(), str(uuid.uuid4()))
    with tracing_context(enabled=True):
        asyncio.run(_drive(wrapped.copy(update={}), _wrap(_failing_agent(), str(uuid.uuid4()))))

    assert type(wrapped) is observability.LangSmithTraceDisabledRunnable
    assert capture.entry == [] and capture.wire == []
    assert "builder_langsmith_governed_structural status=unavailable error_class=RuntimeError" in caplog.text
    assert SENTINEL not in caplog.text


def test_synthetic_governed_builder_stays_excluded_with_structural_toggle_on(capture) -> None:
    wrapped = observability.wrap_governed_builder_runnable(
        _successful_agent(),
        model_name="structural-fake",
        model_source="test",
        trace_config={"configurable": {"synthetic_test": True, "test_run_id": "run-1", "test_principal_id": "p-1"}},
    )

    assert type(wrapped) is observability.LangSmithTraceDisabledRunnable


def test_redacting_client_public_ingest_and_feedback_entry_points(capture) -> None:
    client = observability._governed_structural_client()
    trace_id = uuid.uuid4()
    run = {
        "id": trace_id,
        "trace_id": trace_id,
        "dotted_order": f"20261004T000000000000Z{trace_id}",
        "name": "lookup",
        "run_type": "tool",
        "inputs": {"query": SENTINEL},
        "outputs": {"result": SENTINEL},
        "error": f"KeyError('{SENTINEL}')",
        "events": [{"name": "new_token", "kwargs": {"token": SENTINEL}}],
        "serialized": {"repr": SENTINEL},
        "tags": [SENTINEL, "sophia_builder"],
        "extra": {"metadata": {"note": SENTINEL, "langgraph_step": 2}, "invocation_params": {"system": SENTINEL}},
        "attachments": {"file": ("text/plain", SENTINEL.encode())},
        "session_name": "Sophia",
        "start_time": "2026-10-04T00:00:00+00:00",
    }

    client.batch_ingest_runs(create=[dict(run)], update=[dict(run)])
    client.multipart_ingest(create=[dict(run)], update=[dict(run)])
    client.create_feedback(
        trace_id,
        "builder_terminal_success",
        score=1.0,
        comment=SENTINEL,
        correction={"text": SENTINEL},
        value=SENTINEL,
        source_info={"note": SENTINEL},
        extra={"note": SENTINEL},
    )
    client.flush()

    assert capture.wire, "nothing reached the transport"
    assert SENTINEL not in capture.wire_blob()
    batch = capture.redacted_entries("batch_ingest_runs")
    assert batch and batch[0]["create"][0]["error"] == "KeyError"
    assert batch[0]["create"][0]["tags"] == ["sophia_builder"]
    assert batch[0]["create"][0]["extra"] == {"metadata": {"langgraph_step": 2, "sophia_trace_mode": "governed_structural"}}


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (f"ValueError('{SENTINEL}')\n\nTraceback (most recent call last): ...", "ValueError"),
        ("GraphRecursionError: recursion limit reached", "GraphRecursionError"),
        (f"{SENTINEL} happened", "error"),
        (f"{SENTINEL}Error: masquerading", "error"),
        ("Builder terminated: deck_authoring_deadline_exceeded", "error"),
        ("", None),
        (None, None),
    ],
)
def test_structural_error_keeps_exception_class_only(error, expected) -> None:
    assert governed_tracing.structural_error(error) == expected


def test_structural_metadata_and_tags_are_allowlisted() -> None:
    thread_id = str(uuid.uuid4())
    metadata = governed_tracing.structural_metadata(
        {
            "thread_id": thread_id,
            "run_id": SENTINEL,
            "build_id": "build_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
            "user_id": "owner-1",
            "langgraph_node": "SophiaSummarizationMiddleware.before_model",
            "terminal_reason": f"{SENTINEL} free text",
            "terminal_status": "failed",
            "slide_count": 3,
            "native_editability_score": float("nan"),
            "usage_metadata": {"input_tokens": 4, "output_tokens": 1, "total_tokens": 5, "note": SENTINEL},
            "note": SENTINEL,
        }
    )

    assert metadata == {
        "thread_id": thread_id,
        "build_id": "build_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
        "langgraph_node": "SophiaSummarizationMiddleware.before_model",
        "terminal_status": "failed",
        "slide_count": 3,
        "usage_metadata": {"input_tokens": 4, "output_tokens": 1, "total_tokens": 5},
        "sophia_trace_mode": "governed_structural",
    }
    assert governed_tracing.structural_tags(["sophia_builder", "seq:step:3", "artifact:pptx", SENTINEL, "artifact:Has Space", "builder_terminal:failed"]) == ["sophia_builder", "seq:step:3", "artifact:pptx", "builder_terminal:failed"]


def test_governed_structural_completion_annotation_is_content_free(monkeypatch) -> None:
    class _Root:
        id = "builder-root"
        trace_id = "builder-root"
        parent_run = None
        parent_run_id = None

        def __init__(self) -> None:
            self.metadata: dict[str, Any] = {"thread_id": "builder-thread"}
            self.tags: list[str] = []
            self.patched = 0

        def add_metadata(self, metadata: dict[str, Any]) -> None:
            self.metadata.update(metadata)

        def add_tags(self, tags: list[str]) -> None:
            self.tags.extend(tags)

        def patch(self, *, exclude_inputs: bool = False) -> None:
            self.patched += 1

    class _FeedbackRecorder:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        def create_feedback(self, **kwargs: Any) -> None:
            self.calls.append(kwargs)

    root = _Root()
    feedback = _FeedbackRecorder()
    monkeypatch.setattr(observability, "_current_run_tree", lambda: root)
    monkeypatch.setattr(observability, "_governed_structural_client", lambda *_args: feedback)
    monkeypatch.setattr(observability, "_feedback_client", lambda: pytest.fail("ordinary feedback client used"))
    state = {
        "thread_id": "builder-thread",
        "builder_pptx_diagnostics": {
            "pptx_plan_json": {"slides": [{"title": SENTINEL}]},
            "qc_invocation_count": 1,
            "qc_results": [{"pass": False, "reasons": [f"{SENTINEL} reviewer text"]}],
        },
    }
    artifact = {
        "artifact_path": "/mnt/user-data/outputs/deck.pptx",
        "artifact_type": "presentation",
        "terminal_status": "failed",
        "terminal_reason": "deck_prepare_execution_error",
        "root_failure_summary": f"{SENTINEL} model-written summary",
        "report_visual_grammar_problems": [f"{SENTINEL} problem"],
    }

    with governed_tracing.trace_policy_scope(governed_tracing.GOVERNED_STRUCTURAL_TRACE_MODE):
        assert observability.annotate_builder_completion(state, artifact) is True

    assert SENTINEL not in json.dumps(root.metadata) + json.dumps(root.tags)
    assert root.metadata["terminal_status"] == "failed"
    assert root.metadata["terminal_reason"] == "deck_prepare_execution_error"
    assert root.metadata["sophia_trace_mode"] == "governed_structural"
    assert "artifact:pptx" in root.tags
    assert root.patched == 1
    assert len(feedback.calls) == 1
    assert set(feedback.calls[0]) == {"run_id", "key", "feedback_id", "score"}
    assert artifact["builder_trace_root_run_id"] == "builder-root"


def test_real_builder_factory_routes_governed_owner_through_structural_policy(capture, monkeypatch, declare_memory_owners) -> None:  # noqa: F811 - pytest fixture
    owner = "synthetic-governed-structural-owner"
    declare_memory_owners({owner: "governed"})
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic")
    from deerflow.agents.sophia_agent import builder_agent as module

    class _InspectableAgent:
        recursion_limit = 0

        def with_config(self, config: dict[str, Any]) -> _InspectableAgent:
            self.config = config
            return self

    def capture_agent(**kwargs: Any) -> _InspectableAgent:
        from langgraph.graph import StateGraph

        fake = _InspectableAgent()
        fake.channels = StateGraph(kwargs["state_schema"]).channels
        return fake

    monkeypatch.setattr(module, "create_agent", capture_agent)
    cfg = {"user_id": owner, "langgraph_auth_user_id": owner, "thread_id": str(uuid.uuid4()), "platform": "text"}

    structural = module._create_builder_agent(user_id=owner, trace_config={"configurable": cfg})
    monkeypatch.setenv("SOPHIA_GOVERNED_STRUCTURAL_TRACING", "false")
    excluded = module._create_builder_agent(user_id=owner, trace_config={"configurable": cfg})

    assert type(structural) is observability.GovernedStructuralTraceRunnable
    tracer = structural.config["callbacks"][0]
    assert type(tracer.client).__name__ == "StructuralRedactingClient"
    assert structural.config["metadata"]["sophia_trace_mode"] == "governed_structural"
    assert type(excluded) is observability.LangSmithTraceDisabledRunnable
    assert "callbacks" not in excluded.config
