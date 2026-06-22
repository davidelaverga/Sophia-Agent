"""LangSmith observability helpers for Sophia's builder-only tracing."""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from contextlib import nullcontext
from typing import Any
from urllib.parse import urlparse

from langchain_core.runnables import Runnable

from deerflow.config.tracing_config import get_tracing_config

logger = logging.getLogger(__name__)

_BUILDER_RUN_NAME = "Sophia Builder"
_BUILDER_BASE_TAG = "sophia_builder"
_BUILDER_TRACING_ENV = "SOPHIA_BUILDER_LANGSMITH_TRACING"
_startup_status_logged = False


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
        stripped = value.strip()
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
        "project": config.project,
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
            "[tracing] builder_tracing_flag=%s langsmith_tracing_enabled=%s "
            "project=%s endpoint=%s api_key_present=%s",
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
        return LangChainTracer(
            project_name=tracing_config.project,
            client=client,
            tags=tags,
            metadata=metadata,
        )
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
    return bool(
        _true_artifact_fallback(artifact)
        or artifact.get("quality_warning")
        or _as_int(diagnostics.get("dropped_image_refs")) > 0
    )


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
    for key in ("thread_id", "task_id", "run_id", "parent_thread_id"):
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


def _tool_counts_by_name(state: dict[str, Any]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    summaries = state.get("builder_tool_turn_summaries") or []
    if not isinstance(summaries, list):
        return {}
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        for name in summary.get("tool_names") or []:
            if isinstance(name, str) and name.strip():
                counts[name.strip()] += 1
    return dict(sorted(counts.items()))


def _emit_rejection_count(state: dict[str, Any]) -> int:
    summaries = state.get("builder_tool_turn_summaries") or []
    if not isinstance(summaries, list):
        return 0
    return sum(
        1
        for summary in summaries
        if isinstance(summary, dict)
        and (
            summary.get("failure_stage") == "emit_rejected"
            or summary.get("emit_rejected") is True
        )
    )


def _slide_image_hashes(diagnostics: dict[str, Any]) -> list[str]:
    hashes: list[str] = []
    for key in ("qc_image_records", "image_output_records"):
        records = diagnostics.get(key)
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict):
                continue
            image_hash = record.get("image_hash")
            if isinstance(image_hash, str) and image_hash.strip() and image_hash not in hashes:
                hashes.append(image_hash.strip())
    return hashes[:24]


def _artifact_filename(artifact: dict[str, Any]) -> str | None:
    value = artifact.get("artifact_filename") or artifact.get("artifact_path")
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().replace("\\", "/").split("/")[-1] or None


def builder_observability_payload(
    state: dict[str, Any],
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
    """Build LangSmith metadata, tags, and QC feedback payloads."""

    diagnostics = _as_dict(state.get("builder_pptx_diagnostics"))
    delegation_context = _as_dict(state.get("delegation_context"))
    builder_task = _as_dict(state.get("builder_task"))
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
    tool_counts = _tool_counts_by_name(state)
    if tool_counts:
        metadata["tool_counts_by_name"] = tool_counts
    metadata["emit_rejection_count"] = _emit_rejection_count(state)
    _add_identity_metadata(
        metadata,
        artifact=artifact,
        builder_task=builder_task,
        delegation_context=delegation_context,
    )
    _add_artifact_metadata(metadata, artifact, diagnostics)
    _merge_safe_metadata(metadata, "artifact_filename", _artifact_filename(artifact))
    _merge_safe_metadata(metadata, "artifact_preview_filename", artifact.get("artifact_preview_filename"))
    if diagnostics.get("pptx_plan_json") is not None:
        metadata["deck_plan"] = diagnostics["pptx_plan_json"]
    slide_hashes = _slide_image_hashes(diagnostics)
    if slide_hashes:
        metadata["accepted_slide_image_hashes"] = slide_hashes
    _add_quality_metadata(metadata, artifact, diagnostics)

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
            neutral = (
                result.get("skipped") is True
                or result.get("advisory") is True
                or result.get("parser_error") is True
            )
            client.create_feedback(
                run_id=run_id,
                key="slide_qc",
                score=None if neutral else 1.0 if result.get("pass") is True else 0.0,
                comment=_feedback_comment(reasons if isinstance(reasons, list) else []),
            )
    except Exception:  # noqa: BLE001
        logger.debug("LangSmith QC feedback creation failed", exc_info=True)


def annotate_builder_completion(state: dict[str, Any], artifact: dict[str, Any]) -> bool:
    """Attach builder completion metadata/tags/feedback to the active run."""

    run_tree = _current_run_tree()
    if run_tree is None:
        if langsmith_builder_tracing_enabled():
            logger.warning(
                "Sophia builder LangSmith completion annotation skipped; no active run tree: %s",
                _langsmith_log_context(),
            )
        return False
    metadata, tags, qc_results = builder_observability_payload(state, artifact)
    _add_run_metadata(run_tree, metadata)
    _add_run_tags(run_tree, tags)
    _create_qc_feedback(run_tree, qc_results)
    logger.info(
        "Sophia builder LangSmith completion annotation attached: run_id=%s project=%s",
        getattr(run_tree, "id", None),
        get_tracing_config().project,
    )
    return True
