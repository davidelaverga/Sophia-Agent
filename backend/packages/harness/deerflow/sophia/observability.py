"""LangSmith observability helpers for Sophia's builder-only tracing."""

from __future__ import annotations

import json
import logging
from contextlib import nullcontext
from typing import Any

from langchain_core.runnables import Runnable

logger = logging.getLogger(__name__)


def _tracing_context_factory() -> Any | None:
    try:
        from langsmith.run_helpers import tracing_context

        return tracing_context
    except Exception:  # noqa: BLE001 - optional dependency / SDK version guard.
        try:
            from langsmith import tracing_context

            return tracing_context
        except Exception:  # noqa: BLE001
            return None


def langsmith_tracing_disabled() -> Any:
    """Context manager that disables LangSmith tracing when the SDK exists."""

    tracing_context = _tracing_context_factory()
    if tracing_context is None:
        return nullcontext()
    return tracing_context(enabled=False)


class LangSmithTraceDisabledRunnable(Runnable[Any, Any]):
    """Proxy a graph/runnable while suppressing LangSmith around execution."""

    def __init__(self, runnable: Any) -> None:
        object.__setattr__(self, "_runnable", runnable)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runnable, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_runnable":
            object.__setattr__(self, name, value)
            return
        setattr(self._runnable, name, value)

    def invoke(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            return self._runnable.invoke(*args, **kwargs)

    async def ainvoke(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            return await self._runnable.ainvoke(*args, **kwargs)

    def batch(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            return self._runnable.batch(*args, **kwargs)

    async def abatch(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            return await self._runnable.abatch(*args, **kwargs)

    def stream(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            yield from self._runnable.stream(*args, **kwargs)

    async def astream(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_tracing_disabled():
            async for item in self._runnable.astream(*args, **kwargs):
                yield item


def disable_langsmith_tracing_for_runnable(runnable: Any) -> LangSmithTraceDisabledRunnable:
    return LangSmithTraceDisabledRunnable(runnable)


def _current_run_tree() -> Any | None:
    try:
        from langsmith.run_helpers import get_current_run_tree

        return get_current_run_tree()
    except Exception:  # noqa: BLE001
        try:
            from langsmith import get_current_run_tree

            return get_current_run_tree()
        except Exception:  # noqa: BLE001
            return None


def _feedback_client() -> Any:
    from langsmith import Client

    return Client()


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _final_artifact_ext(artifact: dict[str, Any]) -> str | None:
    path = artifact.get("artifact_path")
    if not isinstance(path, str) or "." not in path:
        return None
    return path.rsplit(".", 1)[-1].lower().strip() or None


def _first_positive_int(*values: Any) -> int:
    for value in values:
        parsed = _as_int(value)
        if parsed > 0:
            return parsed
    return 0


def _qc_results(diagnostics: dict[str, Any]) -> list[dict[str, Any]]:
    raw_results = diagnostics.get("qc_results")
    if not isinstance(raw_results, list):
        return []
    results: list[dict[str, Any]] = []
    for item in raw_results:
        if isinstance(item, dict):
            reasons = item.get("reasons")
            results.append(
                {
                    "pass": item.get("pass") is True,
                    "reasons": [str(reason) for reason in reasons] if isinstance(reasons, list) else [],
                }
            )
    return results


def _degraded(artifact: dict[str, Any], diagnostics: dict[str, Any]) -> bool:
    return bool(artifact.get("artifact_is_fallback") or artifact.get("quality_warning") or artifact.get("fallback_reason") or _as_int(diagnostics.get("dropped_image_refs")) > 0)


def builder_observability_payload(
    state: dict[str, Any],
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
    """Build LangSmith metadata, tags, and QC feedback payloads."""

    diagnostics = _as_dict(state.get("builder_pptx_diagnostics"))
    slide_count = _first_positive_int(
        diagnostics.get("pptx_plan_slide_count"),
        diagnostics.get("pptx_generator_slide_count"),
    )
    image_count = _as_int(diagnostics.get("image_generation_success_count"))
    qc_invocations = _as_int(diagnostics.get("qc_invocation_count"))
    image_forward = bool(slide_count > 0 and image_count >= slide_count)
    metadata: dict[str, Any] = {
        "slide_count": slide_count,
        "image_count": image_count,
        "image_forward": image_forward,
        "degraded": _degraded(artifact, diagnostics),
        "dropped_image_refs": _as_int(diagnostics.get("dropped_image_refs")),
        "qc_invocation_count": qc_invocations,
        "qc_pass_count": _as_int(diagnostics.get("qc_pass_count")),
        "qc_failure_count": _as_int(diagnostics.get("qc_failure_count")),
    }
    if diagnostics.get("pptx_plan_json") is not None:
        metadata["deck_plan"] = diagnostics["pptx_plan_json"]
    for key in ("quality_warning", "fallback_reason", "image_generation_error_class"):
        value = artifact.get(key) or diagnostics.get(key)
        if value:
            metadata[key] = str(value)

    artifact_ext = _final_artifact_ext(artifact)
    tags = [
        f"artifact:{artifact_ext}" if artifact_ext else "artifact:unknown",
        "image_forward" if image_forward else "mixed_or_fallback",
        "qc_ran" if qc_invocations > 0 else "qc_skipped",
    ]
    return metadata, tags, _qc_results(diagnostics)


def _add_run_metadata(run_tree: Any, metadata: dict[str, Any]) -> None:
    try:
        run_tree.add_metadata(metadata)
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith metadata attachment failed", exc_info=True)


def _add_run_tags(run_tree: Any, tags: list[str]) -> None:
    try:
        run_tree.add_tags(tags)
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith tag attachment failed", exc_info=True)


def _feedback_comment(reasons: list[str]) -> str:
    return json.dumps(reasons, ensure_ascii=False)


def _create_qc_feedback(run_tree: Any, qc_results: list[dict[str, Any]]) -> None:
    if not qc_results:
        return
    run_id = getattr(run_tree, "id", None)
    if run_id is None:
        return
    try:
        client = _feedback_client()
        for result in qc_results:
            reasons = result.get("reasons")
            client.create_feedback(
                run_id=run_id,
                key="slide_qc",
                score=1.0 if result.get("pass") is True else 0.0,
                comment=_feedback_comment(reasons if isinstance(reasons, list) else []),
            )
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith QC feedback creation failed", exc_info=True)


def annotate_builder_completion(state: dict[str, Any], artifact: dict[str, Any]) -> bool:
    """Attach builder completion metadata/tags/feedback to the active run."""

    run_tree = _current_run_tree()
    if run_tree is None:
        return False
    metadata, tags, qc_results = builder_observability_payload(state, artifact)
    _add_run_metadata(run_tree, metadata)
    _add_run_tags(run_tree, tags)
    _create_qc_feedback(run_tree, qc_results)
    return True
