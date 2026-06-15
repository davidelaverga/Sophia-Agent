"""Tests for ``start_builder_task`` — the deepagents-native async wrapper.

Covers dispatch shape, duplicate-launch protection, live-context embedding,
SDK failure fallback, and user_id resolution. Mirrors patterns from
``test_switch_to_builder_tool.py`` and ``test_sophia_builder_flow.py`` for
runtime/state mocking.
"""

from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from langgraph.types import Command


def _make_runtime(
    state: dict,
    thread_id: str = "thread-1",
    user_id: str | None = None,
    context_user_id: str | None = None,
    tool_call_id: str = "tc-test",
) -> SimpleNamespace:
    """Stand-in for ``ToolRuntime``.

    ``tool_call_id`` is read from ``runtime.tool_call_id`` by
    ``_start_builder_task_impl`` (production path: LangGraph's tool executor
    populates it). Pass ``tool_call_id=""`` to exercise the refuse-to-launch
    guard.
    """
    configurable: dict = {"thread_id": thread_id}
    if user_id is not None:
        configurable["user_id"] = user_id
    context: dict = {"thread_id": thread_id}
    if context_user_id is not None:
        context["user_id"] = context_user_id
    return SimpleNamespace(
        state=state,
        context=context,
        config={
            "configurable": configurable,
            "metadata": {"model_name": "claude-haiku-4-5-20251001", "trace_id": "trace-1"},
        },
        tool_call_id=tool_call_id,
    )


def _make_fake_sdk_client(
    *,
    thread_id: str = "asgi-thread-1",
    run_id: str = "asgi-run-1",
    captured: dict | None = None,
):
    """Build an AsyncMock LangGraph SDK client that records the run kwargs."""
    captured = captured if captured is not None else {}

    threads = MagicMock()
    threads.create = AsyncMock(return_value={"thread_id": thread_id})

    async def _create_run(**kwargs):
        captured["run_kwargs"] = kwargs
        return {"run_id": run_id}

    runs = MagicMock()
    runs.create = AsyncMock(side_effect=_create_run)

    client = MagicMock()
    client.threads = threads
    client.runs = runs
    return client, captured


class _FakeThreadPaths:
    def __init__(self, root: Path):
        self.root = root

    def ensure_thread_dirs(self, thread_id: str) -> None:
        (self.root / thread_id / "workspace").mkdir(parents=True, exist_ok=True)
        (self.root / thread_id / "outputs").mkdir(parents=True, exist_ok=True)

    def sandbox_work_dir(self, thread_id: str) -> Path:
        return self.root / thread_id / "workspace"


# ---------- dispatch shape ---------------------------------------------------


def test_start_builder_task_dispatches_via_asgi(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client(thread_id="asgi-1", run_id="run-1")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "user_id": "alice",
            "current_artifact": {"tone_estimate": 1.8, "active_tone_band": "grief_fear"},
            "injected_memory_contents": [
                "Prefers concise slide headlines",
                "Avoids cluttered visuals",
            ],
            "active_ritual": "prepare",
            "ritual_phase": "prepare.pitch_materials",
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Build a 5-slide investor deck.",
            task_type="presentation",
            runtime=runtime,
        )
    )

    assert isinstance(response, Command)
    update = response.update
    assert "asgi-1" in update["async_tasks"]
    task = update["async_tasks"]["asgi-1"]
    assert task["agent_name"] == "sophia_builder"
    assert task["status"] == "running"
    assert task["thread_id"] == "asgi-1"
    assert task["run_id"] == "run-1"
    assert task["task_type"] == "presentation"
    assert task["demo_mode"] is False
    # ToolMessage echoes the runtime's tool_call_id (test default = "tc-test";
    # production: LangGraph's tool executor populates ``runtime.tool_call_id``).
    tool_msg = update["messages"][0]
    assert tool_msg.tool_call_id == "tc-test"
    assert tool_msg.name == "start_builder_task"
    assert "task_id: asgi-1" in tool_msg.content

    # The dispatched run config MUST carry the new builder thread_id in
    # configurable so the builder's ThreadDataMiddleware can locate
    # workspace/uploads/outputs directories. Without this propagation the
    # builder fails with "Thread ID is required" on its first turn.
    config_payload = captured["run_kwargs"]["config"]
    assert config_payload["configurable"]["thread_id"] == "asgi-1"
    # Codex P1 review 2026-05-22: configurable must also include
    # ``graph_id`` so tools running inside the builder run (notably
    # write_file_tool's auto-prefix gate) can identify the builder
    # context deterministically. langgraph_api propagates this
    # server-side for logging but does NOT guarantee it appears in
    # runtime.config["configurable"] at tool-execution time.
    assert config_payload["configurable"]["graph_id"] == "sophia_builder"


def test_edit_source_resolves_last_builder_artifact():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    source = module._resolve_edit_source_artifact(
        {
            "last_builder_artifact": {
                "artifact_path": "mnt/user-data/outputs/final-report.html",
                "task_id": "task-old",
                "run_id": "run-old",
                "task_type": "frontend",
            }
        },
        artifact_path=None,
        task_id=None,
    )

    assert source is not None
    assert source["artifact_path"] == "/mnt/user-data/outputs/final-report.html"
    assert source["artifact_ext"] == "html"
    assert source["source"] == "last_builder_artifact"


def test_edit_source_materializes_from_parent_supabase(monkeypatch, tmp_path):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    calls: list[tuple[str, str]] = []

    def _download(thread_id: str, relative_path: str):
        calls.append((thread_id, relative_path))
        return b"<!doctype html><html><body>Base</body></html>", "text/html"

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact",
        _download,
    )
    monkeypatch.setattr(
        "deerflow.config.paths.get_paths",
        lambda: _FakeThreadPaths(tmp_path),
    )

    result = module._materialize_edit_source_artifact(
        parent_thread_id="parent-thread",
        builder_thread_id="builder-thread",
        edit_context={"source_artifact_path": "mnt/user-data/outputs/final-report.html"},
    )

    assert calls == [("parent-thread", "final-report.html")]
    assert result["source_artifact_path"] == "/mnt/user-data/outputs/final-report.html"
    assert result["materialized_source_path"] == (
        "/mnt/user-data/workspace/source_artifact/final-report.html"
    )
    materialized = tmp_path / "builder-thread" / "workspace" / "source_artifact" / "final-report.html"
    assert materialized.read_bytes() == b"<!doctype html><html><body>Base</body></html>"


def test_edit_source_materializes_from_durable_object_path(monkeypatch, tmp_path):
    # Codex P2 PR #131: in production the durable bytes live at
    # storage_object_path (the registry object path), and after an
    # ephemeral-disk wipe the legacy {thread}/{relative} mirror + local disk
    # are gone. The edit flow must recover from the durable object path first.
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    object_calls: list[str] = []
    legacy_calls: list[tuple[str, str]] = []

    def _download_object(object_path: str):
        object_calls.append(object_path)
        return b"<!doctype html><html><body>Durable</body></html>", "text/html"

    def _download_legacy(thread_id: str, relative_path: str):
        legacy_calls.append((thread_id, relative_path))
        return None  # legacy mirror was never written / wiped

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact_object",
        _download_object,
    )
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact",
        _download_legacy,
    )
    monkeypatch.setattr(
        "deerflow.config.paths.get_paths",
        lambda: _FakeThreadPaths(tmp_path),
    )

    result = module._materialize_edit_source_artifact(
        parent_thread_id="parent-thread",
        builder_thread_id="builder-thread",
        edit_context={
            "source_artifact_path": "mnt/user-data/outputs/final-report.html",
            "source_object_path": "artifacts/alice/session-1/artifact-1/final-report.html",
        },
    )

    # Durable object path used, and used BEFORE the legacy relative key.
    assert object_calls == ["artifacts/alice/session-1/artifact-1/final-report.html"]
    assert legacy_calls == []
    assert result["source_artifact_path"] == "/mnt/user-data/outputs/final-report.html"
    materialized = tmp_path / "builder-thread" / "workspace" / "source_artifact" / "final-report.html"
    assert materialized.read_bytes() == b"<!doctype html><html><body>Durable</body></html>"


def test_edit_source_falls_back_to_legacy_mirror_without_object_path(monkeypatch, tmp_path):
    # When no durable object path is recorded (older records), the legacy
    # {thread}/{relative} mirror path still works unchanged.
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    object_calls: list[str] = []
    legacy_calls: list[tuple[str, str]] = []

    def _download_object(object_path: str):
        object_calls.append(object_path)
        return b"unused", "text/html"

    def _download_legacy(thread_id: str, relative_path: str):
        legacy_calls.append((thread_id, relative_path))
        return b"<!doctype html><html><body>Legacy</body></html>", "text/html"

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact_object",
        _download_object,
    )
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact",
        _download_legacy,
    )
    monkeypatch.setattr(
        "deerflow.config.paths.get_paths",
        lambda: _FakeThreadPaths(tmp_path),
    )

    module._materialize_edit_source_artifact(
        parent_thread_id="parent-thread",
        builder_thread_id="builder-thread",
        edit_context={"source_artifact_path": "mnt/user-data/outputs/final-report.html"},
    )

    assert object_calls == []  # no object path → durable lookup skipped
    assert legacy_calls == [("parent-thread", "final-report.html")]
    materialized = tmp_path / "builder-thread" / "workspace" / "source_artifact" / "final-report.html"
    assert materialized.read_bytes() == b"<!doctype html><html><body>Legacy</body></html>"


def test_edit_source_resolves_storage_object_path_from_builder_result():
    # The resolved edit source must carry storage_object_path so the dispatch
    # can thread it into edit_context["source_object_path"].
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    source = module._resolve_edit_source_artifact(
        {
            "last_builder_artifact": {
                "artifact_path": "mnt/user-data/outputs/final-report.html",
                "storage_object_path": "artifacts/alice/session-1/artifact-1/final-report.html",
            }
        },
        artifact_path=None,
        task_id=None,
    )

    assert source is not None
    assert source["storage_object_path"] == (
        "artifacts/alice/session-1/artifact-1/final-report.html"
    )


def test_edit_builder_artifact_dispatch_materializes_source(monkeypatch, tmp_path):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client(thread_id="edit-builder", run_id="run-edit")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.download_artifact",
        lambda thread_id, relative_path: (b"# Base\n\nKeep this.", "text/markdown"),
    )
    monkeypatch.setattr(
        "deerflow.config.paths.get_paths",
        lambda: _FakeThreadPaths(tmp_path),
    )

    runtime = _make_runtime(
        {
            "user_id": "alice",
            "last_builder_artifact": {
                "artifact_path": "mnt/user-data/outputs/brief.md",
                "task_id": "source-task",
                "run_id": "source-run",
                "task_type": "document",
            },
        },
        thread_id="parent-thread",
    )

    response = asyncio.run(
        module.edit_builder_artifact.coroutine(
            message="Change the conclusion only.",
            runtime=runtime,
        )
    )

    assert isinstance(response, Command)
    update = response.update
    assert "edit-builder" in update["async_tasks"]
    task = update["async_tasks"]["edit-builder"]
    assert task["edit_mode"] == "edit_existing_artifact"
    assert task["source_artifact_path"] == "/mnt/user-data/outputs/brief.md"
    assert task["artifact_target_path"].endswith(".md")

    run_input = captured["run_kwargs"]["input"]
    edit_context = run_input["delegation_context"]["edit_context"]
    assert edit_context["mode"] == "edit_existing_artifact"
    assert edit_context["source_artifact_path"] == "/mnt/user-data/outputs/brief.md"
    assert edit_context["materialized_source_path"] == "/mnt/user-data/workspace/source_artifact/brief.md"
    assert "Change the conclusion only." in run_input["messages"][0]["content"]
    materialized = tmp_path / "edit-builder" / "workspace" / "source_artifact" / "brief.md"
    assert materialized.read_text() == "# Base\n\nKeep this."


def test_dispatch_sets_stream_resumable_true(monkeypatch):
    """Phase 4F regression: ``stream_resumable=True`` MUST be set on
    ``client.runs.create`` so the gateway-side ``BuilderProgressSubscriber``
    (HTTP ``runs.join_stream``) can replay events to a late joiner.

    Default for ``langgraph_sdk.RunsClient.create`` is
    ``stream_resumable=False``. With that default the run produces events
    internally but the server does not buffer them for HTTP subscribers,
    so the subscriber sees ``chunks=0`` and the placeholder times out on
    silence. Production failure 2026-05-16; see plan §Phase 4F.
    """
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client(thread_id="asgi-2", run_id="run-2")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime({"user_id": "bob"})
    asyncio.run(
        module.start_builder_task.coroutine(
            description="Markdown deep dive on Zep memory.",
            task_type="research",
            runtime=runtime,
        )
    )

    run_kwargs = captured["run_kwargs"]
    assert run_kwargs.get("stream_resumable") is True, (
        "start_builder_task MUST call runs.create(stream_resumable=True). "
        "Without it, runs.join_stream returns 200 OK but never yields chunks, "
        "and the BuilderProgressSubscriber places a misleading '[ Done ]' edit "
        "after the per-event timeout fires."
    )


def test_visual_report_html_request_targets_html_file():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "visual_report",
        "Build a concise HTML document with charts and diagrams about GEPA SkillOpt.",
    )

    assert target.endswith(".html")


def test_explicit_html_artifact_phrase_targets_html_file():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "document",
        "Create a real HTML artifact with a polished visual landing page.",
    )

    assert target.endswith(".html")


def test_pdf_request_with_html_charts_still_targets_pdf():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "visual_report",
        "Make a PDF report with HTML charts about GEPA SkillOpt.",
    )

    assert target.endswith(".pdf")


def test_powerpoint_request_beats_incidental_pdf_context():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "presentation",
        "Create a PowerPoint slide presentation. Prior artifact: open-claw-report.pdf.",
    )

    assert target.endswith(".pptx")


def test_presentation_in_pdf_format_targets_pdf():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "presentation",
        "Create a presentation in PDF format for the leadership review.",
    )

    assert target.endswith(".pdf")


def test_simple_product_review_pdf_targets_stable_filename():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "document",
        "Create a simple product review PDF artifact.",
    )

    assert target == "/mnt/user-data/outputs/simple-product-review.pdf"


def test_pdf_source_mentions_do_not_force_pdf_output():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "document",
        "Summarize these PDFs into a concise research brief with recommendations.",
    )

    assert target.endswith(".md")


def test_pdf_source_material_with_markdown_request_targets_markdown():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "research",
        "Read the attached PDF source material and write the final brief in markdown.",
    )

    assert target.endswith(".md")


def test_incidental_html_charts_do_not_override_visual_report_pdf_default():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "visual_report",
        "Build a concise visual report with HTML charts and diagrams about GEPA SkillOpt.",
    )

    assert target.endswith(".pdf")


def test_visual_report_without_html_request_still_targets_pdf():
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    target = module._suggest_artifact_target_path(
        "visual_report",
        "Build a concise visual report with charts and diagrams about GEPA SkillOpt.",
    )

    assert target.endswith(".pdf")


# ---------- duplicate protection --------------------------------------------


def test_start_builder_task_duplicate_protection(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    def _fail(_url=None):  # pragma: no cover — must not be called
        raise AssertionError("SDK client must not be created on duplicate launch")

    monkeypatch.setattr("langgraph_sdk.get_client", _fail)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "existing-1": {
                    "task_id": "existing-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "existing-1",
                    "run_id": "r-existing",
                    "status": "running",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another deck",
            task_type="presentation",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "already in progress" in response
    assert "existing-1" in response


def test_duplicate_launch_text_enumerates_all_four_lifecycle_tools(monkeypatch):
    """The duplicate-rejection ToolMessage must teach the model the full
    lifecycle-tool matrix so it picks the right alternative instead of
    looping on start_builder_task / check_async_task."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    monkeypatch.setattr(
        "langgraph_sdk.get_client",
        lambda url=None: (_ for _ in ()).throw(
            AssertionError("SDK client must not be created on duplicate launch")
        ),
    )

    runtime = _make_runtime(
        {
            "async_tasks": {
                "abc-uuid-123": {
                    "task_id": "abc-uuid-123",
                    "agent_name": "sophia_builder",
                    "thread_id": "abc-uuid-123",
                    "run_id": "r-existing",
                    "status": "running",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another deck",
            task_type="presentation",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    for tool_name in (
        "update_async_task",
        "check_async_task",
        "cancel_async_task",
        "list_async_tasks",
    ):
        assert tool_name in response, f"{tool_name} missing from rejection text"
    # Each lifecycle alternative must include the FULL task_id verbatim so the
    # model can copy-paste the call shape without hallucinating an id.
    # Note: list_async_tasks() takes no task_id, so we expect >= 3 (update,
    # check, cancel).
    assert response.count("abc-uuid-123") >= 3
    # At least one ack example per alternative branch.
    assert "Got it, updating" in response
    assert "Let me check" in response
    assert "cancelling the build" in response
    assert "Pulling up your in-flight builds" in response
    # Regression guard: the recall path must NOT hard-code
    # ``status_filter="running"`` — pending and interrupted are also active
    # in our terminal-blacklist model, so a "running"-only filter would
    # report no in-flight builds even when a build is still active.
    assert 'status_filter="running"' not in response


def test_duplicate_launch_text_does_not_truncate_task_id(monkeypatch):
    """Regression guard: deepagents docs call out task_id truncation as a
    common failure mode. The rejection text must always carry the FULL id."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    monkeypatch.setattr(
        "langgraph_sdk.get_client",
        lambda url=None: (_ for _ in ()).throw(
            AssertionError("SDK client must not be created on duplicate launch")
        ),
    )

    full_task_id = "019fbe43-2c1a-4d7b-91d8-77ae1f6c5e22"
    runtime = _make_runtime(
        {
            "async_tasks": {
                full_task_id: {
                    "task_id": full_task_id,
                    "agent_name": "sophia_builder",
                    "thread_id": full_task_id,
                    "run_id": "r-existing",
                    "status": "running",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another deck",
            task_type="presentation",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert full_task_id in response
    # No ellipsis-style truncation patterns.
    assert "…" not in response
    assert "..." not in response


def test_start_builder_task_duplicate_protection_allows_after_terminal(monkeypatch):
    """Terminal status (completed/failed/etc.) must not block a new launch."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, _captured = _make_fake_sdk_client(thread_id="new-1", run_id="r-new")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "old-1": {
                    "task_id": "old-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "old-1",
                    "run_id": "r-old",
                    "status": "completed",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, Command)
    assert "new-1" in response.update["async_tasks"]


def test_start_builder_task_duplicate_protection_ignores_other_agents(monkeypatch):
    """A non-builder async task in flight must NOT block a builder launch."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, _captured = _make_fake_sdk_client(thread_id="b-1", run_id="r-b")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "researcher-1": {
                    "task_id": "researcher-1",
                    "agent_name": "researcher",
                    "thread_id": "researcher-1",
                    "run_id": "r-researcher",
                    "status": "running",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, Command)
    assert "b-1" in response.update["async_tasks"]


# ---------- live-context embedding ------------------------------------------


def test_start_builder_task_live_context_embedding(monkeypatch):
    """Memories, emotional context, ritual, and explicit URLs land in the brief."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "user_id": "alice",
            "current_artifact": {
                "tone_estimate": 2.3,
                "active_goal": "Land the first paying user this week",
            },
            "injected_memory_contents": [
                "Prefers headlines, not paragraphs",
                "Hates jargon",
            ],
            "active_ritual": "debrief",
            "ritual_phase": "debrief.step2_what_worked",
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description=("Compare AR glasses launching in 2026. Use https://example.com/ar-roundup-2026 as a starting source."),
            task_type="research",
            runtime=runtime,
        )
    )
    assert isinstance(response, Command)

    run_kwargs = captured["run_kwargs"]
    sent_messages = run_kwargs["input"]["messages"]
    assert len(sent_messages) == 1
    _assert_live_context_brief(sent_messages[0]["content"])
    _assert_live_context_state(run_kwargs["input"])


def _assert_live_context_brief(body: str) -> None:
    assert body.startswith("[research]")
    for expected in (
        "Relevant memories from this session:",
        "Prefers headlines",
        "Hates jargon",
        "tone=2.3",
        "Land the first paying user",
        "Active ritual: debrief",
        "debrief.step2_what_worked",
        "https://example.com/ar-roundup-2026",
    ):
        assert expected in body


def _assert_live_context_state(input_state: dict) -> None:
    delegation = input_state["delegation_context"]
    expected_delegation = {
        "task_type": "research",
        "allow_web_research": True,
        "explicit_user_urls": ["https://example.com/ar-roundup-2026"],
        "active_ritual": "debrief",
        "parent_thread_id": "thread-1",
        "parent_user_id": "alice",
    }
    for key, value in expected_delegation.items():
        assert delegation[key] == value
    assert delegation["relevant_memories"][:2] == [
        "Prefers headlines, not paragraphs",
        "Hates jargon",
    ]
    assert input_state["allow_web_research"] is True
    assert input_state["explicit_user_urls"] == ["https://example.com/ar-roundup-2026"]
    assert isinstance(input_state["builder_web_budget"], dict)


def test_start_builder_task_prefix_idempotent(monkeypatch):
    """If the model already prefixed the description, don't double-prefix."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime({"user_id": "alice"})

    asyncio.run(
        module.start_builder_task.coroutine(
            description="[document] Write a one-pager about X",
            task_type="document",
            runtime=runtime,
        )
    )
    body = captured["run_kwargs"]["input"]["messages"][0]["content"]
    # Exactly one [document] prefix.
    assert body.count("[document]") == 1


# ---------- SDK failure -----------------------------------------------------


def test_start_builder_task_sdk_failure_returns_string(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    failing = MagicMock()
    failing.threads.create = AsyncMock(side_effect=RuntimeError("ASGI down"))
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: failing)

    runtime = _make_runtime({"user_id": "alice"})

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "Failed to launch" in response
    assert "ASGI down" in response


# ---------- demo-prompt normalization ---------------------------------------


def test_start_builder_task_normalizes_demo_request(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "user_id": "alice",
            "current_artifact": {
                "session_goal": "Testing builder mode",
                "takeaway": "User is in test/exploration mode for builder functionality",
            },
        }
    )

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Build a sample project so the user can see the feature working.",
            task_type="frontend",
            runtime=runtime,
        )
    )
    assert isinstance(response, Command)
    body = captured["run_kwargs"]["input"]["messages"][0]["content"]
    # Demo path forces task_type=document and embeds the deterministic brief.
    assert body.startswith("[document]")
    assert "builder-demo.md" in body
    delegation = captured["run_kwargs"]["input"]["delegation_context"]
    assert delegation["task_type"] == "document"

    # The async_tasks entry records demo_mode=True so the gateway can log it.
    task_id = next(iter(response.update["async_tasks"]))
    assert response.update["async_tasks"][task_id]["demo_mode"] is True


def test_start_builder_task_keeps_web_research_available_for_frontend(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Build an HTML document about the Meta Harness framework.",
            task_type="frontend",
            runtime=_make_runtime({"user_id": "alice"}),
        )
    )

    assert isinstance(response, Command)
    run_input = captured["run_kwargs"]["input"]
    delegation = run_input["delegation_context"]
    assert delegation["task_type"] == "frontend"
    assert delegation["allow_web_research"] is True
    assert run_input["allow_web_research"] is True
    assert isinstance(run_input["builder_web_budget"], dict)


# ---------- user_id resolution ----------------------------------------------


def test_start_builder_task_prefers_runtime_config_user_id(monkeypatch):
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime({}, user_id="alice_from_config")

    asyncio.run(
        module.start_builder_task.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    config_payload = captured["run_kwargs"]["config"]
    assert config_payload["configurable"]["user_id"] == "alice_from_config"


def test_make_start_builder_task_tool_uses_bound_user_id_when_runtime_sources_missing(monkeypatch):
    """The factory's bound user_id wins when no trusted runtime source exists."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    bound_tool = module.make_start_builder_task_tool("bound_authenticated_user")

    # Runtime carries no user_id (config + context + state all empty).
    runtime = SimpleNamespace(
        state={},
        context={"thread_id": "thread-x"},
        config={
            "configurable": {"thread_id": "thread-x"},
            "metadata": {},
        },
        tool_call_id="tc-bound",
    )

    asyncio.run(
        bound_tool.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    config_payload = captured["run_kwargs"]["config"]
    assert config_payload["configurable"]["user_id"] == "bound_authenticated_user"


def test_start_builder_task_tool_arg_user_id_does_not_override_runtime_config(monkeypatch, caplog):
    """LLM-supplied user_id must NOT override an authenticated runtime user_id."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, captured = _make_fake_sdk_client()
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime({}, user_id="trusted_alice")

    with caplog.at_level("WARNING"):
        asyncio.run(
            module.start_builder_task.coroutine(
                description="Make a doc",
                task_type="document",
                user_id="hallucinated_bob",
                runtime=runtime,
            )
        )

    # Trusted source wins.
    config_payload = captured["run_kwargs"]["config"]
    assert config_payload["configurable"]["user_id"] == "trusted_alice"
    # Mismatch is logged for audit.
    assert any("tool-arg user_id mismatch" in record.message for record in caplog.records), "expected mismatch WARNING for prompt-injection audit"


# ---------- tool_call_id fallback -------------------------------------------


def test_start_builder_task_refuses_launch_without_tool_call_id(monkeypatch):
    """Empty ``tool_call_id`` must NOT launch a builder run.

    Codex bot review on PR-A: the previous fallback launched the SDK run
    and then returned a JSON string without writing ``async_tasks``,
    leaving the run untracked and unmanageable. Refusing to launch keeps
    state consistent — no orphans.
    """
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    def _fail(_url=None):  # pragma: no cover — must not be called
        raise AssertionError("SDK client must not be created when tool_call_id is empty")

    monkeypatch.setattr("langgraph_sdk.get_client", _fail)

    # Runtime carries empty tool_call_id — production equivalent of
    # LangGraph's tool executor failing to populate it.
    runtime = _make_runtime({"user_id": "alice"}, tool_call_id="")

    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make a doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "tool_call_id was not available" in response
    assert "No background work was started" in response or "no background work" in response.lower()


# ---------- status-set coverage (terminal-blacklist semantics) --------------


def test_start_builder_task_treats_pending_status_as_active(monkeypatch):
    """LangGraph SDK can write ``status="pending"`` via check_async_task.

    The previous whitelist (``{"queued", "running", "started"}``) missed
    pending, so a duplicate launch could slip through after a status check.
    Codex bot review on PR-A flagged this; the inverted terminal-status
    blacklist now treats pending as active.
    """
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    def _fail(_url=None):  # pragma: no cover
        raise AssertionError("SDK client must not be created on duplicate launch")

    monkeypatch.setattr("langgraph_sdk.get_client", _fail)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "pending-1": {
                    "task_id": "pending-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "pending-1",
                    "run_id": "r-pending",
                    "status": "pending",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )
    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "already in progress" in response
    assert "pending-1" in response


def test_start_builder_task_treats_interrupted_status_as_active(monkeypatch):
    """``interrupted`` is also a non-terminal LangGraph SDK run status."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    def _fail(_url=None):  # pragma: no cover
        raise AssertionError("SDK client must not be created on duplicate launch")

    monkeypatch.setattr("langgraph_sdk.get_client", _fail)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "int-1": {
                    "task_id": "int-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "int-1",
                    "run_id": "r-int",
                    "status": "interrupted",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )
    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "already in progress" in response


def test_start_builder_task_treats_unknown_status_as_active(monkeypatch):
    """Default-active: any new/unknown status blocks duplicate launches.

    Sentinel for forward-compat — when LangGraph SDK adds a new status we
    don't yet know about, the conservative behaviour is to treat it as
    "still running" rather than to allow a second concurrent launch.
    """
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")

    def _fail(_url=None):  # pragma: no cover
        raise AssertionError("SDK client must not be created on duplicate launch")

    monkeypatch.setattr("langgraph_sdk.get_client", _fail)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "future-1": {
                    "task_id": "future-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "future-1",
                    "run_id": "r-future",
                    "status": "some_brand_new_langgraph_status",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )
    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Make another doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, str)
    assert "already in progress" in response


def test_start_builder_task_treats_failed_status_as_terminal(monkeypatch):
    """``failed`` (and other terminal statuses) must NOT block a new launch."""
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    fake_client, _captured = _make_fake_sdk_client(thread_id="new-1", run_id="r-new")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)

    runtime = _make_runtime(
        {
            "async_tasks": {
                "old-1": {
                    "task_id": "old-1",
                    "agent_name": "sophia_builder",
                    "thread_id": "old-1",
                    "run_id": "r-old",
                    "status": "failed",
                    "created_at": "2026-04-24T00:00:00Z",
                    "last_checked_at": "2026-04-24T00:00:00Z",
                    "last_updated_at": "2026-04-24T00:00:00Z",
                }
            }
        }
    )
    response = asyncio.run(
        module.start_builder_task.coroutine(
            description="Retry the doc",
            task_type="document",
            runtime=runtime,
        )
    )
    assert isinstance(response, Command)
    assert "new-1" in response.update["async_tasks"]


# ---- visual expectations brief line (editable visual decks, 2026-06-13) -----


def test_presentation_brief_gains_visual_expectations_line():
    from deerflow.sophia.tools.start_builder_task import _visual_expectations_line

    line = _visual_expectations_line("Build an investor deck about our roadmap", "presentation")
    assert line is not None
    assert "Visual expectations" in line
    assert "deck editable rather than image-only" in line
    assert "Excalidraw-style diagrams" in line


def test_plain_deck_brief_gets_opt_out_line():
    from deerflow.sophia.tools.start_builder_task import _visual_expectations_line

    line = _visual_expectations_line("A plain text-only deck please", "presentation")
    assert line is not None
    assert "do NOT use generated imagery" in line


def test_explaining_deck_does_not_trigger_plain_opt_out_line():
    from deerflow.sophia.tools.start_builder_task import _visual_expectations_line

    line = _visual_expectations_line("Build a deck explaining OpenClaw", "presentation")
    assert line is not None
    assert "do NOT use generated imagery" not in line
    assert "deck editable rather than image-only" in line


def test_style_keywords_surface_in_brief():
    from deerflow.sophia.tools.start_builder_task import _visual_expectations_line

    line = _visual_expectations_line("A bold modern investor deck", "presentation")
    assert line is not None
    assert "bold" in line and "modern" in line


def test_document_brief_gets_no_visual_line():
    from deerflow.sophia.tools.start_builder_task import _visual_expectations_line

    assert _visual_expectations_line("Write a markdown report", "document") is None
