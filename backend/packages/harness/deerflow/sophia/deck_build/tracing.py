from __future__ import annotations

import contextlib
import hashlib
import os
import sys
from pathlib import PurePosixPath
from typing import Any

from deerflow.sandbox.tools import get_thread_data
from deerflow.sophia.synthetic_builder import declares_synthetic_builder_run

DEFAULT_DECK_ROUTE = "deck_creative_html_native"
NOT_COMPILED_DECK_COMPILE_MODE = "not_compiled"
HTML_SCREENSHOT_FALLBACK_COMPILE_MODE = "html_screenshot_fallback"
HTML_SCREENSHOT_DEBUG_COMPILE_MODE = "html_screenshot_debug"
DEFAULT_DECK_COMPILE_MODE = NOT_COMPILED_DECK_COMPILE_MODE
NATIVE_DECK_COMPILE_MODE = "native_html2patch"
NATIVE_UNAVAILABLE_DECK_COMPILE_MODE = "native_unavailable"
FORBIDDEN_SCREENSHOT_COMPILE_MODES = frozenset(
    {
        HTML_SCREENSHOT_FALLBACK_COMPILE_MODE,
        HTML_SCREENSHOT_DEBUG_COMPILE_MODE,
    }
)
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


def _identity_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _identity_source_value(source: dict[str, Any], keys: tuple[str, ...]) -> Any:
    return next((source.get(key) for key in keys if source.get(key) not in (None, "")), None)


def _runtime_identity_value(runtime: Any, *keys: str) -> Any:
    state = _identity_dict(getattr(runtime, "state", None))
    config = _identity_dict(getattr(runtime, "config", None))
    execution_info = getattr(runtime, "execution_info", None)
    execution_source = {key: getattr(execution_info, key, None) for key in keys}
    sources = (
        state,
        _identity_dict(state.get("builder_task")),
        _identity_dict(state.get("delegation_context")),
        execution_source,
        _identity_dict(getattr(runtime, "context", None)),
        _identity_dict(config.get("configurable")),
        _identity_dict(config.get("metadata")),
    )
    for source in sources:
        if (value := _identity_source_value(source, keys)) is not None:
            return value
    return None


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
    thread_data = get_thread_data(runtime) or {}
    thread_id = _runtime_identity_value(runtime, "thread_id", "builder_thread_id") or thread_data.get("thread_id")
    session_id = _runtime_identity_value(runtime, "session_id", "parent_thread_id", "companion_session_id")
    task_id = _runtime_identity_value(runtime, "task_id", "builder_task_id")
    run_id = _runtime_identity_value(runtime, "run_id", "builder_run_id")
    user_id = _runtime_identity_value(runtime, "user_id", "parent_user_id")
    parent_thread_id = _runtime_identity_value(runtime, "parent_thread_id")
    return _compact_metadata(
        {
            "sophia_schema": "deck_trace_v2",
            "thread_id": thread_id,
            "session_id": session_id,
            "user_id_hash": stable_hash(user_id),
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
            "parent_thread_id": parent_thread_id,
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
    if declares_synthetic_builder_run(
        getattr(runtime, "state", None),
        getattr(runtime, "config", None),
        getattr(runtime, "context", None),
    ):
        yield None
        return
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
