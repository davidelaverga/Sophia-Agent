from __future__ import annotations

import contextlib
import hashlib
import os
import sys
from pathlib import PurePosixPath
from typing import Any

from deerflow.sandbox.tools import get_thread_data

DEFAULT_DECK_ROUTE = "deck_ir_html_raster"
DEFAULT_DECK_COMPILE_MODE = "html_screenshot_fallback"
NATIVE_DECK_COMPILE_MODE = "native_html2patch"
DEFAULT_ARTIFACT_TARGET_EXT = ".pptx"


def stable_hash(value: object) -> str | None:
    if value is None:
        return None
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def basename(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return PurePosixPath(value.replace("\\", "/")).name


def safe_excerpt(value: object, limit: int = 600) -> str | None:
    if value is None:
        return None
    text = str(value)
    text = text.replace(os.getenv("OPENAI_API_KEY", "") or "\0", "[redacted]")
    text = text.replace(os.getenv("LANGSMITH_API_KEY", "") or "\0", "[redacted]")
    text = text.replace(os.getenv("LANGCHAIN_API_KEY", "") or "\0", "[redacted]")
    if len(text) > limit:
        return text[:limit] + "...[truncated]"
    return text


def _compact_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in payload.items()
        if value is not None and value != "" and value != [] and value != {}
    }


def base_metadata(
    *,
    runtime: Any,
    build_id: str,
    visual_policy: str,
    status: str,
    slide_count: int,
    deck_route: str | None = None,
    deck_compile_mode: str | None = None,
    artifact_target_ext: str | None = None,
) -> dict[str, Any]:
    raw_state = getattr(runtime, "state", None)
    state = raw_state if isinstance(raw_state, dict) else {}
    thread_data = get_thread_data(runtime) or {}
    thread_id = state.get("thread_id") or thread_data.get("thread_id")
    session_id = state.get("session_id") or state.get("parent_thread_id") or state.get("companion_session_id")
    task_id = state.get("task_id") or state.get("builder_task_id")
    run_id = state.get("run_id") or state.get("builder_run_id")
    return _compact_metadata(
        {
            "sophia_schema": "deck_trace_v2",
            "thread_id": thread_id,
            "session_id": session_id,
            "user_id_hash": stable_hash(state.get("user_id")),
            "task_id": task_id,
            "run_id": run_id,
            "build_id": build_id,
            "deck_route": deck_route or DEFAULT_DECK_ROUTE,
            "deck_compile_mode": deck_compile_mode or DEFAULT_DECK_COMPILE_MODE,
            "artifact_target_ext": artifact_target_ext or DEFAULT_ARTIFACT_TARGET_EXT,
            "artifact_type": "presentation",
            "builder_thread_id": thread_id,
            "builder_task_id": task_id,
            "builder_run_id": run_id,
            "parent_thread_id": state.get("parent_thread_id"),
            # Compatibility keys kept while downstream dashboards migrate to deck_trace_v2.
            "deck_build_id": build_id,
            "deck_schema_version": "sophia-deck-build/v1",
            "deck_visual_policy": visual_policy,
            "deck_requested_slide_count": slide_count,
            "deck_status": status,
            "render_git_commit": os.getenv("RENDER_GIT_COMMIT"),
        }
    )


@contextlib.contextmanager
def deck_span(
    name: str,
    *,
    runtime: Any,
    build_id: str,
    visual_policy: str,
    status: str,
    slide_count: int,
    run_type: str = "chain",
    inputs: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    deck_route: str | None = None,
    deck_compile_mode: str | None = None,
    artifact_target_ext: str | None = None,
):
    try:
        from langsmith import trace
        from langsmith.run_helpers import get_current_run_tree
    except Exception:
        yield None
        return

    parent_run = get_current_run_tree()
    parent = getattr(parent_run, "dotted_order", None) if parent_run is not None else None
    meta = {
        **base_metadata(
            runtime=runtime,
            build_id=build_id,
            visual_policy=visual_policy,
            status=status,
            slide_count=slide_count,
            deck_route=deck_route,
            deck_compile_mode=deck_compile_mode,
            artifact_target_ext=artifact_target_ext,
        ),
        **(metadata or {}),
    }
    try:
        manager = trace(
            name,
            run_type=run_type,
            inputs=inputs or {},
            metadata=meta,
            tags=["sophia", "deck_build", *(tags or [])],
            parent=parent,
        )
        run = manager.__enter__()
    except Exception:
        yield None
        return

    try:
        yield run
    except BaseException:
        manager.__exit__(*sys.exc_info())
        raise
    else:
        manager.__exit__(None, None, None)


def finish_span(run: Any, outputs: dict[str, Any]) -> None:
    if run is None:
        return
    try:
        run.end(outputs=outputs)
    except Exception:
        pass
