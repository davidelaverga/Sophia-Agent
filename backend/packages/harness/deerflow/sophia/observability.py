"""LangSmith observability helpers for Sophia's builder-only tracing."""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from contextlib import nullcontext
from typing import Any
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid5
from weakref import WeakSet

from langchain_core.runnables import Runnable

from deerflow.config.tracing_config import get_tracing_config

logger = logging.getLogger(__name__)

_BUILDER_RUN_NAME = "Sophia Builder"
_BUILDER_BASE_TAG = "sophia_builder"
_BUILDER_TRACING_ENV = "SOPHIA_BUILDER_LANGSMITH_TRACING"
_startup_status_logged = False
_ACTIVE_BUILDER_TRACERS: WeakSet[Any] = WeakSet()


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


def _env_flag_value(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


def langsmith_builder_tracing_requested() -> bool:
    """Resolve the builder-specific tracing flag, inheriting global tracing when unset."""

    builder_flag = _env_flag_value(_BUILDER_TRACING_ENV)
    if builder_flag is not None:
        return builder_flag
    try:
        return bool(get_tracing_config().enabled)
    except Exception:  # noqa: BLE001 - config should never block builder execution.
        logger.warning("Could not resolve LangSmith tracing config", exc_info=True)
        return False


def langsmith_builder_tracing_enabled() -> bool:
    """Return whether the builder graph should opt into LangSmith tracing."""

    if not langsmith_builder_tracing_requested():
        return False
    try:
        return bool(get_tracing_config().api_key)
    except Exception:  # noqa: BLE001 - config should never block builder execution.
        logger.warning("Could not resolve LangSmith tracing config", exc_info=True)
        return False


def _safe_metadata_value(value: Any) -> str | int | float | bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        stripped = value.strip().strip('"').strip("'").strip()
        return stripped[:512] if stripped else None
    return None


def _merge_safe_metadata(target: dict[str, Any], key: str, value: Any) -> None:
    safe_value = _safe_metadata_value(value)
    if safe_value is not None:
        target[key] = safe_value


def _safe_tags(tags: list[str] | tuple[str, ...] | None) -> list[str]:
    deduped: list[str] = []
    for tag in [_BUILDER_BASE_TAG, *(tags or [])]:
        if not isinstance(tag, str):
            continue
        clean = tag.strip()
        if clean and clean not in deduped:
            deduped.append(clean[:256])
    return deduped


def _endpoint_host(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    return parsed.netloc or parsed.path or endpoint


def _langsmith_log_context() -> dict[str, Any]:
    config = get_tracing_config()
    return {
        "project": _safe_metadata_value(config.project),
        "endpoint_host": _endpoint_host(config.endpoint),
        "api_key_present": bool(config.api_key),
        "workspace_id_present": bool(config.workspace_id),
        "project_uuid_present": bool(config.project_uuid),
        "langsmith_tracing_enabled": config.enabled,
        "builder_tracing_flag": langsmith_builder_tracing_requested(),
        "builder_tracing_env_present": _env_flag_value(_BUILDER_TRACING_ENV) is not None,
    }


def log_builder_tracing_startup_status() -> None:
    """Emit the resolved builder tracing state once per worker process."""

    global _startup_status_logged
    if _startup_status_logged:
        return
    _startup_status_logged = True
    try:
        config = get_tracing_config()
        logger.info(
            "[tracing] builder_tracing_flag=%s langsmith_tracing_enabled=%s project=%s endpoint=%s api_key_present=%s",
            langsmith_builder_tracing_requested(),
            config.enabled,
            config.project,
            config.endpoint,
            bool(config.api_key),
        )
    except Exception:  # noqa: BLE001 - startup logging must never block graph import.
        logger.warning("[tracing] builder tracing startup status unavailable", exc_info=True)


def _langsmith_client(config: Any | None = None) -> Any:
    from langsmith import Client

    tracing_config = config or get_tracing_config()
    kwargs: dict[str, Any] = {
        "api_url": tracing_config.endpoint,
        "api_key": tracing_config.api_key,
    }
    if tracing_config.workspace_id:
        kwargs["workspace_id"] = tracing_config.workspace_id
    return Client(**kwargs)


def builder_trace_metadata(
    *,
    model_name: str | None = None,
    model_source: str | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build safe metadata for the root Sophia builder trace."""

    metadata: dict[str, Any] = {"sophia_component": "builder"}
    tracing_config = get_tracing_config()
    _merge_safe_metadata(metadata, "LANGSMITH_PROJECT", tracing_config.project)
    _merge_safe_metadata(metadata, "langsmith_project", tracing_config.project)
    _merge_safe_metadata(metadata, "langsmith_endpoint_host", _endpoint_host(tracing_config.endpoint))
    _merge_safe_metadata(metadata, "langsmith_project_uuid", tracing_config.project_uuid)
    _merge_safe_metadata(metadata, "builder_model_name", model_name)
    _merge_safe_metadata(metadata, "builder_model_source", model_source)

    render_service = os.getenv("RENDER_SERVICE_NAME")
    render_region = os.getenv("RENDER_REGION")
    render_commit = os.getenv("RENDER_GIT_COMMIT")
    _merge_safe_metadata(metadata, "render_service_name", render_service)
    _merge_safe_metadata(metadata, "render_region", render_region)
    _merge_safe_metadata(metadata, "render_git_commit", render_commit)

    runtime_config = config if isinstance(config, dict) else {}
    configurable = _as_dict(runtime_config.get("configurable"))
    config_metadata = _as_dict(runtime_config.get("metadata"))
    for source in (configurable, config_metadata):
        for key in ("thread_id", "task_id", "run_id", "parent_thread_id"):
            if key not in metadata:
                _merge_safe_metadata(metadata, key, source.get(key))
    if "parent_trace_id" not in metadata:
        _merge_safe_metadata(metadata, "parent_trace_id", config_metadata.get("trace_id"))
    if "task_id" not in metadata and metadata.get("thread_id") is not None:
        metadata["task_id"] = metadata["thread_id"]
    return metadata


def builder_trace_tags(
    *,
    model_name: str | None = None,
    model_source: str | None = None,
) -> list[str]:
    tags = []
    if model_source:
        tags.append(f"builder_model_source:{model_source}")
    if model_name:
        tags.append(f"builder_model:{model_name}")
    return _safe_tags(tags)


def _builder_langsmith_tracer(
    *,
    metadata: dict[str, Any],
    tags: list[str],
) -> Any | None:
    if not langsmith_builder_tracing_enabled():
        return None
    try:
        from langchain_core.tracers.langchain import LangChainTracer

        tracing_config = get_tracing_config()
        client = _langsmith_client(tracing_config)
        tracer = LangChainTracer(
            project_name=tracing_config.project,
            client=client,
            tags=tags,
            metadata=metadata,
        )
        _ACTIVE_BUILDER_TRACERS.add(tracer)
        return tracer
    except Exception:  # noqa: BLE001 - tracing must not break builder creation.
        logger.warning(
            "Sophia builder LangSmith tracer creation failed: %s",
            _langsmith_log_context(),
            exc_info=True,
        )
        return None


def langsmith_builder_tracing_context(
    *,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> Any:
    """Context manager that enables tracing only for builder graph execution."""

    if not langsmith_builder_tracing_enabled():
        return nullcontext()
    tracing_context = _tracing_context_factory()
    if tracing_context is None:
        return nullcontext()
    try:
        tracing_config = get_tracing_config()
        return tracing_context(
            enabled=True,
            project_name=tracing_config.project,
            client=_langsmith_client(tracing_config),
            tags=_safe_tags(tags),
            metadata=metadata or {},
        )
    except Exception:  # noqa: BLE001 - tracing must not break builder execution.
        logger.warning(
            "Sophia builder LangSmith tracing context creation failed: %s",
            _langsmith_log_context(),
            exc_info=True,
        )
        return nullcontext()


class LangSmithTraceDisabledRunnable(Runnable[Any, Any]):
    """Proxy a runnable while suppressing LangSmith around its own execution."""

    def __init__(self, runnable: Any) -> None:
        object.__setattr__(self, "_runnable", runnable)

    @property
    def __class__(self) -> type[Any]:  # type: ignore[override]
        """Expose the wrapped type to middleware that checks model classes."""

        return self._runnable.__class__

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

    def bind(self, *args: Any, **kwargs: Any) -> LangSmithTraceDisabledRunnable:
        return LangSmithTraceDisabledRunnable(self._runnable.bind(*args, **kwargs))

    def bind_tools(self, *args: Any, **kwargs: Any) -> LangSmithTraceDisabledRunnable:
        return LangSmithTraceDisabledRunnable(self._runnable.bind_tools(*args, **kwargs))


def disable_langsmith_tracing_for_runnable(runnable: Any) -> LangSmithTraceDisabledRunnable:
    return LangSmithTraceDisabledRunnable(runnable)


def _is_langgraph_pregel(runnable: Any) -> bool:
    """Return whether LangGraph API will accept this object as a graph."""

    try:
        from langgraph.pregel import Pregel

        if isinstance(runnable, Pregel):
            return True
    except Exception:  # noqa: BLE001 - optional import/version guard.
        pass

    try:
        from langgraph.pregel.remote import BaseRemotePregel

        return isinstance(runnable, BaseRemotePregel)
    except Exception:  # noqa: BLE001 - optional import/version guard.
        return False


class LangSmithBuilderTraceRunnable(Runnable[Any, Any]):
    """Proxy the builder graph while enabling LangSmith only for that runnable."""

    def __init__(
        self,
        runnable: Any,
        *,
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> None:
        object.__setattr__(self, "_runnable", runnable)
        object.__setattr__(self, "_metadata", metadata or {})
        object.__setattr__(self, "_tags", _safe_tags(tags))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runnable, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"_runnable", "_metadata", "_tags"}:
            object.__setattr__(self, name, value)
            return
        setattr(self._runnable, name, value)

    def invoke(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            return self._runnable.invoke(*args, **kwargs)

    async def ainvoke(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            return await self._runnable.ainvoke(*args, **kwargs)

    def batch(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            return self._runnable.batch(*args, **kwargs)

    async def abatch(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            return await self._runnable.abatch(*args, **kwargs)

    def stream(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            yield from self._runnable.stream(*args, **kwargs)

    async def astream(self, *args: Any, **kwargs: Any) -> Any:
        with langsmith_builder_tracing_context(metadata=self._metadata, tags=self._tags):
            async for item in self._runnable.astream(*args, **kwargs):
                yield item

    def bind(self, *args: Any, **kwargs: Any) -> LangSmithBuilderTraceRunnable:
        return LangSmithBuilderTraceRunnable(
            self._runnable.bind(*args, **kwargs),
            metadata=self._metadata,
            tags=self._tags,
        )

    def bind_tools(self, *args: Any, **kwargs: Any) -> LangSmithBuilderTraceRunnable:
        return LangSmithBuilderTraceRunnable(
            self._runnable.bind_tools(*args, **kwargs),
            metadata=self._metadata,
            tags=self._tags,
        )


def enable_langsmith_tracing_for_builder_runnable(
    runnable: Any,
    *,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> Any:
    metadata = dict(metadata or {})
    tags = _safe_tags(tags)
    if not langsmith_builder_tracing_enabled():
        logger.info(
            "Sophia builder LangSmith tracing disabled: %s",
            _langsmith_log_context(),
        )
        return runnable
    tracer = _builder_langsmith_tracer(metadata=metadata, tags=tags)
    if tracer is None:
        return runnable
    if _is_langgraph_pregel(runnable):
        configured = runnable.with_config(
            {
                "callbacks": [tracer],
                "run_name": _BUILDER_RUN_NAME,
                "tags": tags,
                "metadata": metadata,
            }
        )
        if hasattr(runnable, "recursion_limit"):
            configured.recursion_limit = runnable.recursion_limit
        logger.info(
            "Sophia builder LangSmith tracing attached to Pregel graph: %s",
            _langsmith_log_context(),
        )
        return configured
    logger.info(
        "Sophia builder LangSmith tracing attached to runnable proxy: %s",
        _langsmith_log_context(),
    )
    return LangSmithBuilderTraceRunnable(runnable, metadata=metadata, tags=tags)


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


def _completion_identity(state: dict[str, Any], artifact: dict[str, Any]) -> dict[str, str]:
    identity: dict[str, str] = {}
    nested_sources = (
        _as_dict(state.get("builder_task")),
        _as_dict(state.get("delegation_context")),
    )
    key_aliases = {
        "thread_id": ("thread_id", "builder_thread_id"),
        "task_id": ("task_id",),
        "run_id": ("builder_run_id", "run_id"),
        "parent_thread_id": ("parent_thread_id",),
        "build_id": ("builder_build_id", "build_id", "deck_build_id"),
        "operation_id": ("builder_operation_id", "operation_id"),
    }
    for identity_key, aliases in key_aliases.items():
        for source in (artifact, state, *nested_sources):
            value = next((source.get(alias) for alias in aliases if source.get(alias) is not None), None)
            if isinstance(value, str) and value.strip():
                identity[identity_key] = value.strip()
                break
    return identity


def _run_metadata(run: Any) -> dict[str, Any]:
    metadata = _as_dict(getattr(run, "metadata", None))
    if metadata:
        return metadata
    return _as_dict(_as_dict(getattr(run, "extra", None)).get("metadata"))


def _active_pregel_run_tree(state: dict[str, Any], artifact: dict[str, Any]) -> Any | None:
    """Find the concrete active root captured by Pregel's LangChain tracer."""

    candidates: list[Any] = []
    for tracer in list(_ACTIVE_BUILDER_TRACERS):
        try:
            runs = list(getattr(tracer, "run_map", {}).values())
        except (AttributeError, RuntimeError):
            continue
        run_ids = {str(getattr(run, "id", "")) for run in runs}
        candidates.extend(run for run in runs if not getattr(run, "parent_run_id", None) or str(getattr(run, "parent_run_id", "")) not in run_ids)
    if not candidates:
        return None

    identity = _completion_identity(state, artifact)
    if identity:
        scored = [
            (
                sum(_run_metadata(run).get(key) == value for key, value in identity.items()),
                run,
            )
            for run in candidates
        ]
        best_score = max(score for score, _run in scored)
        best = [run for score, run in scored if score == best_score and score > 0]
        if len(best) == 1:
            return best[0]
    return candidates[0] if len(candidates) == 1 else None


def _feedback_client() -> Any:
    return _langsmith_client()


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


def _normalized_artifact_ext(artifact: dict[str, Any]) -> str | None:
    value = artifact.get("artifact_ext") or _final_artifact_ext(artifact)
    if not isinstance(value, str):
        return None
    return value.strip().lstrip(".").lower() or None


def _true_artifact_fallback(artifact: dict[str, Any]) -> bool:
    return artifact.get("artifact_is_fallback") is True


def _requested_artifact_ext_for_metadata(artifact: dict[str, Any], final_ext: str | None) -> str | None:
    if final_ext and not _true_artifact_fallback(artifact):
        return final_ext
    value = artifact.get("requested_artifact_ext")
    if not isinstance(value, str):
        return final_ext
    return value.strip().lstrip(".").lower() or final_ext


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
                    "skipped": item.get("skipped") is True,
                    "advisory": item.get("advisory") is True,
                    "parser_error": item.get("parser_error") is True,
                    "reasons": [str(reason) for reason in reasons] if isinstance(reasons, list) else [],
                }
            )
    return results


def _degraded(artifact: dict[str, Any], diagnostics: dict[str, Any]) -> bool:
    return bool(_true_artifact_fallback(artifact) or artifact.get("quality_warning") or _as_int(diagnostics.get("dropped_image_refs")) > 0)


def _fallback_reason_for_metadata(artifact: dict[str, Any], diagnostics: dict[str, Any]) -> str | None:
    if not _true_artifact_fallback(artifact):
        return None
    value = artifact.get("fallback_reason") or diagnostics.get("fallback_reason")
    if value:
        return str(value)
    return None


def _add_identity_metadata(
    metadata: dict[str, Any],
    *,
    artifact: dict[str, Any],
    builder_task: dict[str, Any],
    delegation_context: dict[str, Any],
) -> None:
    for key in ("thread_id", "task_id", "run_id", "builder_run_id", "parent_thread_id", "build_id", "operation_id"):
        for source in (artifact, builder_task, delegation_context):
            if key not in metadata:
                _merge_safe_metadata(metadata, key, source.get(key))


def _add_artifact_metadata(
    metadata: dict[str, Any],
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    final_artifact_ext = _normalized_artifact_ext(artifact)
    requested_artifact_ext = _requested_artifact_ext_for_metadata(artifact, final_artifact_ext)
    _merge_safe_metadata(metadata, "artifact_type", artifact.get("artifact_type"))
    _merge_safe_metadata(metadata, "requested_artifact_ext", requested_artifact_ext)
    _merge_safe_metadata(metadata, "final_artifact_ext", final_artifact_ext)
    metadata["artifact_is_fallback"] = bool(artifact.get("artifact_is_fallback"))
    fallback_reason = _fallback_reason_for_metadata(artifact, diagnostics)
    if fallback_reason:
        metadata["fallback_reason"] = fallback_reason


def _add_quality_metadata(
    metadata: dict[str, Any],
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    for key in ("quality_warning", "image_generation_error_class"):
        value = artifact.get(key) or diagnostics.get(key)
        if value:
            metadata[key] = str(value)


def _summary_tool_names(summary: object) -> list[str]:
    if not isinstance(summary, dict):
        return []
    names = summary.get("tool_names") or []
    if not isinstance(names, list):
        return []
    cleaned: list[str] = []
    for item in names:
        name = _clean_tool_name(item)
        if name:
            cleaned.append(name)
    return cleaned


def _clean_tool_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _tool_counts_by_name(state: dict[str, Any]) -> dict[str, int]:
    summaries = state.get("builder_tool_turn_summaries") or []
    if not isinstance(summaries, list):
        return {}
    counts: Counter[str] = Counter()
    for summary in summaries:
        counts.update(_summary_tool_names(summary))
    return dict(sorted(counts.items()))


def _emit_rejection_count(state: dict[str, Any]) -> int:
    summaries = state.get("builder_tool_turn_summaries") or []
    if not isinstance(summaries, list):
        return 0
    return sum(1 for summary in summaries if isinstance(summary, dict) and (summary.get("failure_stage") == "emit_rejected" or summary.get("emit_rejected") is True))


def _image_hashes_from_records(records: object) -> list[str]:
    hashes: list[str] = []
    if not isinstance(records, list):
        return hashes
    for record in records:
        if not isinstance(record, dict):
            continue
        image_hash = record.get("image_hash")
        if isinstance(image_hash, str) and image_hash.strip():
            hashes.append(image_hash.strip())
    return hashes


def _slide_image_hashes(diagnostics: dict[str, Any]) -> list[str]:
    hashes: list[str] = []
    for key in ("qc_image_records", "image_output_records"):
        for image_hash in _image_hashes_from_records(diagnostics.get(key)):
            if image_hash not in hashes:
                hashes.append(image_hash)
    return hashes[:24]


def _visual_grammar_counts_from_state(state: dict[str, Any]) -> dict[str, int]:
    visual = _as_dict(state.get("builder_visual_diagnostics"))
    records = visual.get("visual_figure_records")
    if not isinstance(records, list):
        return {}
    counts: Counter[str] = Counter()
    for record in records:
        grammar = _visual_record_grammar(record)
        if grammar:
            counts[grammar] += 1
    return dict(sorted(counts.items()))


def _visual_record_grammar(record: Any) -> str | None:
    if not isinstance(record, dict):
        return None
    for key in ("grammar", "family", "visual_type", "chart_family", "chart_tool"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _deck_gate_tag(state: dict[str, Any], artifact_ext: str | None, image_forward: bool) -> str | None:
    diagnostics = _as_dict(state.get("builder_pptx_diagnostics"))
    if artifact_ext == "pptx" and (image_forward or state.get("builder_presentation_terminal_ready") is True or _as_int(diagnostics.get("pptx_generator_success_count")) > 0):
        return "deck_latch_passed"
    return None


def _artifact_is_pdf(artifact: dict[str, Any], artifact_ext: str | None) -> bool:
    return artifact_ext == "pdf" or str(artifact.get("artifact_type") or "").lower() == "pdf"


def _artifact_pdf_layout_failed(artifact: dict[str, Any]) -> bool:
    failure_code = str(artifact.get("failure_code") or artifact.get("acceptance_failure_code") or artifact.get("error_reason") or "")
    return failure_code == "pdf_page_count_off_target" or artifact.get("artifact_acceptance_status") == "failed"


def _pdf_layout_gate_tag(
    state: dict[str, Any],
    artifact: dict[str, Any],
    artifact_ext: str | None,
) -> str | None:
    if not _artifact_is_pdf(artifact, artifact_ext):
        return None
    if _artifact_pdf_layout_failed(artifact):
        return "pdf_layout_failed"
    if _as_dict(state.get("builder_pdf_render_result")).get("success") is True:
        return "pdf_layout_passed"
    return None


def _report_variety_gate_tag(
    state: dict[str, Any],
    artifact: dict[str, Any],
    artifact_ext: str | None,
) -> str | None:
    grammar_counts = artifact.get("report_visual_grammar_counts") or _visual_grammar_counts_from_state(state)
    grammar_problems = artifact.get("report_visual_grammar_problems")
    if artifact_ext == "pdf" and (grammar_counts or grammar_problems):
        return "report_variety_failed" if grammar_problems else "report_variety_passed"
    return None


def _builder_gate_tags(
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
    artifact_ext: str | None,
    image_forward: bool,
) -> list[str]:
    tags = [
        tag
        for tag in (
            _deck_gate_tag(state, artifact_ext, image_forward),
            _pdf_layout_gate_tag(state, artifact, artifact_ext),
            _report_variety_gate_tag(state, artifact, artifact_ext),
        )
        if tag
    ]
    if not tags:
        tags.append("qc_not_applicable")
    return tags


def _artifact_filename(artifact: dict[str, Any]) -> str | None:
    value = artifact.get("artifact_filename") or artifact.get("artifact_path")
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().replace("\\", "/").split("/")[-1] or None


def _add_terminal_gate_metadata(
    metadata: dict[str, Any],
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    _add_pptx_terminal_metadata(metadata, diagnostics)
    _add_deck_fidelity_metadata(metadata, artifact=artifact, diagnostics=diagnostics)
    _add_pdf_layout_metadata(metadata, state=state, artifact=artifact)
    _add_artifact_acceptance_metadata(metadata, artifact)
    _add_report_grammar_metadata(metadata, state=state, artifact=artifact)


def _add_pptx_terminal_metadata(metadata: dict[str, Any], diagnostics: dict[str, Any]) -> None:
    for key in (
        "slide_assets_ready_at_turn",
        "compile_forced_at_turn",
        "pptx_terminal_ready_at_turn",
        "time_to_first_valid_artifact_ms",
        "primary_image_batch_status",
        "primary_image_batch_error_class",
        "image_generation_startup_attempt_count",
        "image_generation_startup_error_class",
        "image_generation_exit_code",
        "expected_generated_visual_count",
        "successful_generated_visual_count",
        "referenced_visual_count",
        "missing_expected_visual_count",
        "first_prepare_turn",
        "prepare_call_count",
        "prepare_emitted_call_count",
        "prepare_execution_count",
        "prepare_normalized_call_count",
        "prepare_schema_failure_count",
        "prepare_parallel_call_count",
        "prepare_service_call_count",
        "prepare_service_result_count",
        "prepare_result_count",
        "prepare_retry_executed",
        "prepare_policy_result_count",
        "prepare_repair_count",
        "dangling_prepare_call_count",
        "creative_plan_accepted",
        "prepare_latch_activated_at_turn",
        "deck_authoring_contract",
        "authoring_contract",
        "build_event_store_status",
        "builder_trace_run_id",
        "builder_trace_root_run_id",
        "deck_authoring_elapsed_ms",
        "deck_repair_elapsed_ms",
        "deck_service_elapsed_ms",
        "terminal_cleanup_elapsed_ms",
        "presentation_preflight_status",
        "presentation_preflight_elapsed_ms",
        "deck_authoring_started_at_ms",
        "deck_authoring_budget_ms",
        "deck_authoring_remaining_ms",
        "deck_authoring_prompt_bytes",
        "deck_authoring_prompt_estimated_tokens",
        "deck_authoring_tool_schema_bytes",
        "deck_authoring_context_bytes",
        "deck_authoring_output_bytes",
        "authoring_tool_call_started",
        "prepare_force_reason",
        "deck_html_fragment_count",
        "deck_assembled_html_bytes",
        "deck_stylesheet_hash",
    ):
        _merge_safe_metadata(metadata, key, diagnostics.get(key))


def _add_deck_fidelity_metadata(
    metadata: dict[str, Any],
    *,
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    retention = _as_dict(diagnostics.get("source_retention_report") or artifact.get("source_retention_report"))
    contrast = _as_dict(diagnostics.get("native_contrast_report") or artifact.get("native_contrast_report"))
    for key in (
        "passed",
        "missing_required_count",
        "duplicate_source_id_count",
    ):
        _merge_safe_metadata(metadata, f"source_retention_{key}", retention.get(key))
    _merge_safe_metadata(
        metadata,
        "source_retention_low_count",
        len(retention.get("low_retention") or []) if retention else None,
    )
    for key in (
        "passed",
        "checked_run_count",
        "required_issue_count",
        "indeterminate_required_count",
    ):
        _merge_safe_metadata(metadata, f"native_contrast_{key}", contrast.get(key))


def _add_pdf_layout_metadata(
    metadata: dict[str, Any],
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
) -> None:
    pdf_result = _as_dict(state.get("builder_pdf_render_result"))
    for key in (
        "requested_page_count",
        "requested_min_pages",
        "requested_max_pages",
        "page_count",
        "layout_quality",
        "layout_warning",
        "report_contract_status",
        "report_contract_version",
        "expected_section_count",
        "found_section_count",
        "expected_body_section_count",
        "found_body_section_count",
        "expected_visual_count",
        "found_visual_count",
        "minimum_word_count",
        "source_word_count",
        "cover_present",
        "toc_present",
        "conclusion_present",
        "references_present",
    ):
        _merge_safe_metadata(metadata, f"pdf_{key}", pdf_result.get(key))
    requested = pdf_result.get("requested_page_count") or artifact.get("requested_pages")
    actual = pdf_result.get("page_count") or artifact.get("actual_pages")
    if isinstance(requested, int) and isinstance(actual, int):
        metadata["pdf_page_delta"] = actual - requested


def _add_artifact_acceptance_metadata(metadata: dict[str, Any], artifact: dict[str, Any]) -> None:
    for key in (
        "artifact_acceptance_status",
        "failure_code",
        "requested_pages",
        "actual_pages",
        "page_delta",
        "report_visual_grammar_count",
        "terminal_status",
        "terminal_reason",
        "first_prepare_turn",
        "prepare_call_count",
        "prepare_emitted_call_count",
        "prepare_execution_count",
        "prepare_normalized_call_count",
        "prepare_schema_failure_count",
        "prepare_parallel_call_count",
        "prepare_service_call_count",
        "prepare_service_result_count",
        "prepare_result_count",
        "prepare_retry_executed",
        "dangling_prepare_call_count",
        "creative_plan_accepted",
        "deck_authoring_contract",
        "authoring_contract",
        "build_event_store_status",
        "deck_authoring_elapsed_ms",
        "deck_repair_elapsed_ms",
        "deck_service_elapsed_ms",
        "terminal_cleanup_elapsed_ms",
        "presentation_preflight_status",
        "presentation_preflight_elapsed_ms",
        "deck_authoring_started_at_ms",
        "deck_authoring_budget_ms",
        "deck_authoring_remaining_ms",
        "deck_authoring_prompt_bytes",
        "deck_authoring_prompt_estimated_tokens",
        "deck_authoring_tool_schema_bytes",
        "deck_authoring_context_bytes",
        "deck_authoring_output_bytes",
        "authoring_tool_call_started",
        "prepare_force_reason",
        "root_failure_code",
        "root_failure_summary",
        "last_prepare_failure_code",
        "last_prepare_failure_summary",
        "report_contract_status",
        "report_contract_version",
        "expected_section_count",
        "found_section_count",
        "expected_body_section_count",
        "found_body_section_count",
        "expected_visual_count",
        "found_visual_count",
        "minimum_word_count",
        "source_word_count",
        "cover_present",
        "toc_present",
        "conclusion_present",
        "references_present",
        "source_retention_report",
        "native_contrast_report",
    ):
        _merge_safe_metadata(metadata, key, artifact.get(key))


def _add_report_grammar_metadata(
    metadata: dict[str, Any],
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
) -> None:
    _add_report_grammar_count_metadata(metadata, artifact)
    _add_report_grammar_problem_metadata(metadata, artifact)
    grammar_counts = _visual_grammar_counts_from_state(state)
    if grammar_counts and "report_visual_grammar_counts" not in metadata:
        metadata["report_visual_grammar_counts"] = grammar_counts
        metadata["report_visual_grammar_count"] = len(grammar_counts)


def _add_report_grammar_count_metadata(metadata: dict[str, Any], artifact: dict[str, Any]) -> None:
    artifact_grammar_counts = artifact.get("report_visual_grammar_counts")
    if isinstance(artifact_grammar_counts, dict):
        metadata["report_visual_grammar_counts"] = {str(key): int(value) for key, value in artifact_grammar_counts.items() if isinstance(value, int)}


def _add_report_grammar_problem_metadata(metadata: dict[str, Any], artifact: dict[str, Any]) -> None:
    artifact_grammar_problems = artifact.get("report_visual_grammar_problems")
    if isinstance(artifact_grammar_problems, list):
        metadata["report_visual_grammar_problems"] = [str(problem)[:240] for problem in artifact_grammar_problems[:8] if isinstance(problem, str) and problem.strip()]


def _image_forward_stats(diagnostics: dict[str, Any]) -> tuple[int, int, int, bool]:
    slide_count = _first_positive_int(
        diagnostics.get("pptx_plan_slide_count"),
        diagnostics.get("pptx_generator_slide_count"),
    )
    image_count = _as_int(diagnostics.get("image_generation_success_count"))
    qc_invocations = _as_int(diagnostics.get("qc_invocation_count"))
    return slide_count, image_count, qc_invocations, bool(slide_count > 0 and image_count >= slide_count)


def _base_builder_metadata(
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
    *,
    slide_count: int,
    image_count: int,
    qc_invocations: int,
    image_forward: bool,
) -> dict[str, Any]:
    payload = {
        "slide_count": slide_count,
        "image_count": image_count,
        "image_forward": image_forward,
        "degraded": _degraded(artifact, diagnostics),
        "dropped_image_refs": _as_int(diagnostics.get("dropped_image_refs")),
        "qc_invocation_count": qc_invocations,
        "qc_pass_count": _as_int(diagnostics.get("qc_pass_count")),
        "qc_failure_count": _as_int(diagnostics.get("qc_failure_count")),
    }
    deck_route = diagnostics.get("deck_route") or ("deck_creative_html_native" if diagnostics.get("deck_build_id") else None)
    if deck_route:
        payload["deck_route"] = deck_route
    deck_compile_mode = diagnostics.get("deck_compile_mode")
    if deck_compile_mode:
        payload["deck_compile_mode"] = deck_compile_mode
    if deck_compile_mode in {"html_screenshot_fallback", "html_screenshot_debug"}:
        payload["deck_forbidden_compile_mode"] = True
    native_editability_score = diagnostics.get("native_editability_score")
    if isinstance(native_editability_score, (int, float)) and not isinstance(native_editability_score, bool):
        payload["native_editability_score"] = native_editability_score
    for key in ("native_text_shape_count", "picture_shape_count", "full_slide_picture_count"):
        value = diagnostics.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            payload[key] = value
    if diagnostics.get("generated_visuals_complete") is not None:
        payload["generated_visuals_complete"] = diagnostics.get("generated_visuals_complete")
    return payload


def _safe_lifecycle_markers(markers: Any) -> dict[str, Any]:
    if not isinstance(markers, dict):
        return {}
    return {str(key): value for key, value in markers.items() if _safe_metadata_value(key) is not None and _safe_metadata_value(value) is not None}


def _add_state_summary_metadata(metadata: dict[str, Any], state: dict[str, Any]) -> None:
    tool_counts = _tool_counts_by_name(state)
    if tool_counts:
        metadata["tool_counts_by_name"] = tool_counts
    metadata["emit_rejection_count"] = _emit_rejection_count(state)
    lifecycle_markers = _safe_lifecycle_markers(state.get("builder_lifecycle_markers"))
    if lifecycle_markers:
        metadata["builder_lifecycle_markers"] = lifecycle_markers
    _merge_safe_metadata(metadata, "builder_terminal_halt_reason", state.get("builder_terminal_halt_reason"))
    metadata["builder_graph_halted"] = state.get("builder_graph_halted") is True


def _add_artifact_detail_metadata(
    metadata: dict[str, Any],
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    _add_artifact_metadata(metadata, artifact, diagnostics)
    _merge_safe_metadata(metadata, "artifact_filename", _artifact_filename(artifact))
    _merge_safe_metadata(metadata, "artifact_preview_filename", artifact.get("artifact_preview_filename"))
    if diagnostics.get("pptx_plan_json") is not None:
        metadata["deck_plan"] = diagnostics["pptx_plan_json"]
    slide_hashes = _slide_image_hashes(diagnostics)
    if slide_hashes:
        metadata["accepted_slide_image_hashes"] = slide_hashes
    _add_quality_metadata(metadata, artifact, diagnostics)
    _add_deck_build_metadata(metadata, artifact, diagnostics)
    _add_terminal_gate_metadata(
        metadata,
        state=state,
        artifact=artifact,
        diagnostics=diagnostics,
    )


def _add_deck_build_metadata(
    metadata: dict[str, Any],
    artifact: dict[str, Any],
    diagnostics: dict[str, Any],
) -> None:
    native_editability_score = diagnostics.get("native_editability_score")
    if native_editability_score is None:
        native_editability_score = artifact.get("native_editability_score")
    native_text_shape_count = diagnostics.get("native_text_shape_count")
    if native_text_shape_count is None:
        native_text_shape_count = artifact.get("native_text_shape_count")
    picture_shape_count = diagnostics.get("picture_shape_count")
    if picture_shape_count is None:
        picture_shape_count = artifact.get("picture_shape_count")
    full_slide_picture_count = diagnostics.get("full_slide_picture_count")
    if full_slide_picture_count is None:
        full_slide_picture_count = artifact.get("full_slide_picture_count")
    for key, source in {
        "deck_build_id": _first_present(diagnostics.get("deck_build_id"), artifact.get("deck_build_id")),
        "deck_schema_version": _first_present(diagnostics.get("deck_schema_version"), artifact.get("deck_schema_version")),
        "deck_status": _first_present(diagnostics.get("deck_status"), artifact.get("deck_status")),
        "deck_register": _first_present(diagnostics.get("deck_register"), artifact.get("deck_register")),
        "deck_visual_policy": _first_present(diagnostics.get("deck_visual_policy"), artifact.get("deck_visual_policy")),
        "deck_route": _first_present(diagnostics.get("deck_route"), artifact.get("deck_route")),
        "deck_compile_mode": _first_present(diagnostics.get("deck_compile_mode"), artifact.get("deck_compile_mode")),
        "deck_failure_code": _first_present(diagnostics.get("deck_failure_code"), artifact.get("deck_failure_code"), artifact.get("failure_code")),
        "root_failure_code": _first_present(diagnostics.get("deck_root_failure_code"), artifact.get("root_failure_code")),
        "root_failure_summary": _first_present(diagnostics.get("deck_root_failure_summary"), artifact.get("root_failure_summary")),
        "last_prepare_failure_code": _first_present(diagnostics.get("last_prepare_failure_code"), artifact.get("last_prepare_failure_code")),
        "last_prepare_failure_summary": _first_present(diagnostics.get("last_prepare_failure_summary"), artifact.get("last_prepare_failure_summary")),
        "deck_template_renderer_version": _first_present(diagnostics.get("deck_template_renderer_version"), artifact.get("deck_template_renderer_version")),
        "deck_quality_status": _first_present(diagnostics.get("deck_quality_status"), artifact.get("deck_quality_status")),
        "creative_plan_path": _first_present(diagnostics.get("creative_plan_path"), artifact.get("creative_plan_path")),
        "native_required": _first_present(diagnostics.get("native_required"), artifact.get("native_required")),
        "legacy_screenshot_debug": _first_present(diagnostics.get("legacy_screenshot_debug"), artifact.get("legacy_screenshot_debug")),
        "native_editability_score": native_editability_score,
        "native_text_shape_count": native_text_shape_count,
        "picture_shape_count": picture_shape_count,
        "full_slide_picture_count": full_slide_picture_count,
        "mechanical_gate_results": _first_present(diagnostics.get("mechanical_gate_results"), artifact.get("mechanical_gate_results")),
        "html_source_validation": _first_present(diagnostics.get("html_source_validation"), artifact.get("html_source_validation")),
        "source_retention_report": _first_present(diagnostics.get("source_retention_report"), artifact.get("source_retention_report")),
        "native_contrast_report": _first_present(diagnostics.get("native_contrast_report"), artifact.get("native_contrast_report")),
    }.items():
        _merge_safe_metadata(metadata, key, source)
    for key, source in {
        "deck_expected_visual_count": _first_present(diagnostics.get("expected_generated_visual_count"), artifact.get("expected_generated_visual_count")),
        "deck_successful_visual_count": _first_present(diagnostics.get("successful_generated_visual_count"), artifact.get("successful_generated_visual_count")),
        "deck_missing_visual_count": _first_present(diagnostics.get("missing_expected_visual_count"), artifact.get("missing_expected_visual_count")),
    }.items():
        value = _as_int(source)
        if source is not None:
            metadata[key] = value


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _builder_observability_tags(
    *,
    state: dict[str, Any],
    artifact: dict[str, Any],
    artifact_ext: str | None,
    image_forward: bool,
    qc_invocations: int,
) -> list[str]:
    terminal_status = str(artifact.get("terminal_status") or artifact.get("status") or "").strip()
    dangling_prepare_calls = _as_int(artifact.get("dangling_prepare_call_count") or _as_dict(state.get("builder_pptx_diagnostics")).get("dangling_prepare_call_count"))
    tags = [
        f"artifact:{artifact_ext}" if artifact_ext else "artifact:unknown",
        f"builder_terminal:{terminal_status}" if terminal_status else None,
        "deck_prepare_result_missing" if dangling_prepare_calls > 0 else None,
        "image_forward" if image_forward else "mixed_or_fallback",
        "qc_ran" if qc_invocations > 0 else None,
        "deck_screenshot_forbidden" if (_as_dict(state.get("builder_pptx_diagnostics")).get("deck_compile_mode") or artifact.get("deck_compile_mode")) in {"html_screenshot_fallback", "html_screenshot_debug"} else None,
        *_builder_gate_tags(
            state=state,
            artifact=artifact,
            artifact_ext=artifact_ext,
            image_forward=image_forward,
        ),
    ]
    return [tag for tag in tags if tag]


def builder_observability_payload(
    state: dict[str, Any],
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
    """Build LangSmith metadata, tags, and QC feedback payloads."""

    diagnostics = _as_dict(state.get("builder_pptx_diagnostics"))
    delegation_context = _as_dict(state.get("delegation_context"))
    builder_task = _as_dict(state.get("builder_task"))
    slide_count, image_count, qc_invocations, image_forward = _image_forward_stats(diagnostics)
    metadata = _base_builder_metadata(
        artifact,
        diagnostics,
        slide_count=slide_count,
        image_count=image_count,
        qc_invocations=qc_invocations,
        image_forward=image_forward,
    )
    _add_state_summary_metadata(metadata, state)
    _add_identity_metadata(
        metadata,
        artifact=artifact,
        builder_task=builder_task,
        delegation_context=delegation_context,
    )
    _add_artifact_detail_metadata(
        metadata,
        state=state,
        artifact=artifact,
        diagnostics=diagnostics,
    )

    artifact_ext = _final_artifact_ext(artifact)
    tags = _builder_observability_tags(
        state=state,
        artifact=artifact,
        artifact_ext=artifact_ext,
        image_forward=image_forward,
        qc_invocations=qc_invocations,
    )
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


def _root_run_tree(run_tree: Any) -> Any:
    current = run_tree
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parent = getattr(current, "parent_run", None)
        if parent is None:
            return current
        current = parent
    return run_tree


def _completion_run_tree(state: dict[str, Any], artifact: dict[str, Any]) -> Any | None:
    """Prefer the run tree whose chain carries this builder's identity."""

    current = _current_run_tree()
    active = _active_pregel_run_tree(state, artifact)
    candidates = [candidate for candidate in (active, current) if candidate is not None]
    if not candidates:
        return None
    identity = _completion_identity(state, artifact)
    scored = [(_run_chain_identity_score(candidate, identity), index, candidate) for index, candidate in enumerate(candidates)]
    best_score = max(score for score, _index, _candidate in scored)
    if best_score > 0:
        # Active Pregel is listed first and wins a tie over a detached current span.
        return min((item for item in scored if item[0] == best_score), key=lambda item: item[1])[2]
    return current or active


def _run_chain_identity_score(run_tree: Any, identity: dict[str, str]) -> int:
    if not identity:
        return 0
    score = 0
    current = run_tree
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        metadata = _run_metadata(current)
        score = max(score, sum(str(metadata.get(key) or "") == value for key, value in identity.items()))
        current = getattr(current, "parent_run", None)
    return score


def _patch_run_tree(run_tree: Any) -> None:
    try:
        run_tree.patch(exclude_inputs=True)
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith root patch failed", exc_info=True)


def _run_descends_from_root(run: Any, root_id: str, by_id: dict[str, Any]) -> bool:
    current = run
    seen: set[str] = set()
    while current is not None:
        current_id = str(getattr(current, "id", "") or "")
        if current_id == root_id:
            return True
        if not current_id or current_id in seen:
            return False
        seen.add(current_id)
        current = by_id.get(str(getattr(current, "parent_run_id", "") or ""))
    return False


def _close_builder_model_run(run: Any, terminal_status: str, terminal_reason: str) -> None:
    try:
        run.end(
            error=None if terminal_status == "completed" else f"Builder terminated: {terminal_reason}",
            metadata={"builder_terminal_status": terminal_status, "builder_terminal_reason": terminal_reason},
        )
        run.patch(exclude_inputs=True)
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith canceled model span closure failed", exc_info=True)


def _close_open_builder_model_runs(root_run: Any, artifact: dict[str, Any]) -> None:
    """Close canceled LLM descendants before publishing terminal feedback."""

    root_id = str(getattr(root_run, "id", "") or "")
    if not root_id:
        return
    terminal_status = str(artifact.get("terminal_status") or artifact.get("status") or "failed")
    terminal_reason = str(artifact.get("terminal_reason") or "builder_terminal")[:256]
    for tracer in list(_ACTIVE_BUILDER_TRACERS):
        try:
            runs = list(getattr(tracer, "run_map", {}).values())
        except (AttributeError, RuntimeError):
            continue
        by_id = {str(getattr(run, "id", "") or ""): run for run in runs}
        for run in runs:
            is_open_model = (
                str(getattr(run, "run_type", "") or "").lower() == "llm"
                and getattr(run, "end_time", None) is None
            )
            if is_open_model and _run_descends_from_root(run, root_id, by_id):
                _close_builder_model_run(run, terminal_status, terminal_reason)


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
            neutral = result.get("skipped") is True or result.get("advisory") is True or result.get("parser_error") is True
            client.create_feedback(
                run_id=run_id,
                key="slide_qc",
                score=None if neutral else 1.0 if result.get("pass") is True else 0.0,
                comment=_feedback_comment(reasons if isinstance(reasons, list) else []),
            )
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith QC feedback creation failed", exc_info=True)


def _create_terminal_feedback(run_tree: Any, artifact: dict[str, Any]) -> None:
    terminal_status = str(artifact.get("terminal_status") or artifact.get("status") or "").strip()
    if terminal_status not in {"completed", "failed", "timed_out"}:
        return
    run_id = getattr(run_tree, "id", None)
    if run_id is None:
        return
    terminal_reason = str(artifact.get("terminal_reason") or "unknown")[:256]
    feedback_id = uuid5(
        NAMESPACE_URL,
        f"sophia-builder-terminal:{run_id}:{terminal_reason}",
    )
    try:
        _feedback_client().create_feedback(
            run_id=run_id,
            key="builder_terminal_success",
            feedback_id=feedback_id,
            score=1.0 if terminal_status == "completed" else 0.0,
            comment=json.dumps(
                {
                    "terminal_status": terminal_status,
                    "terminal_reason": terminal_reason,
                },
                ensure_ascii=False,
            ),
        )
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith terminal feedback creation failed", exc_info=True)


def annotate_builder_completion(state: dict[str, Any], artifact: dict[str, Any]) -> bool:
    """Attach builder completion metadata/tags/feedback to the active run."""

    identity = _completion_identity(state, artifact)
    run_tree = _completion_run_tree(state, artifact)
    if run_tree is None:
        if langsmith_builder_tracing_enabled():
            logger.warning(
                "Sophia builder LangSmith completion annotation skipped; no active run tree: %s",
                _langsmith_log_context(),
            )
        return False
    builder_run_id = identity.get("run_id")
    if builder_run_id:
        artifact.setdefault("builder_run_id", builder_run_id)
    metadata, tags, qc_results = builder_observability_payload(state, artifact)
    root_run = _root_run_tree(run_tree)
    _merge_safe_metadata(metadata, "builder_run_id", builder_run_id)
    _merge_safe_metadata(metadata, "build_id", identity.get("build_id"))
    _merge_safe_metadata(metadata, "operation_id", identity.get("operation_id"))
    _merge_safe_metadata(metadata, "builder_thread_id", identity.get("thread_id"))
    artifact.setdefault("builder_trace_run_id", str(getattr(run_tree, "id", "") or "") or None)
    artifact.setdefault("builder_trace_root_run_id", str(getattr(root_run, "id", "") or "") or None)
    _merge_safe_metadata(metadata, "builder_trace_run_id", artifact.get("builder_trace_run_id"))
    _merge_safe_metadata(metadata, "builder_trace_root_run_id", artifact.get("builder_trace_root_run_id"))
    _add_run_metadata(run_tree, metadata)
    _add_run_tags(run_tree, tags)
    if root_run is not run_tree:
        _add_run_metadata(root_run, metadata)
        _add_run_tags(root_run, tags)
    _close_open_builder_model_runs(root_run, artifact)
    _patch_run_tree(root_run)
    _create_qc_feedback(root_run, qc_results)
    _create_terminal_feedback(root_run, artifact)
    logger.info(
        "Sophia builder LangSmith completion annotation attached: run_id=%s root_run_id=%s builder_run_id=%s project=%s",
        getattr(run_tree, "id", None),
        getattr(root_run, "id", None),
        builder_run_id,
        _safe_metadata_value(get_tracing_config().project),
    )
    return True
