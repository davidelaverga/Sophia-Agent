"""Structure-only, redacted LangSmith tracing for memory-governed Builder runs.

Policy (product owner approved): a governed (MEM00) owner's Builder graph may
be traced with run names, run types, timings, status and token counts only.
Inputs, outputs, error text, prompts, tool arguments and results, and any
metadata or tags outside the allowlists below never leave the process. The
companion stays untraced. The mode is opt-in through
``SOPHIA_GOVERNED_STRUCTURAL_TRACING`` (default off: fully excluded).

Redaction is enforced inside the LangSmith client (``structural_client_class``)
rather than at each caller. Every run the SDK can send enters through
``create_run``/``update_run`` (``RunTree.post``/``patch`` and
``LangChainTracer`` use these, including write replicas), or through the public
``batch_ingest_runs``/``multipart_ingest``. Each override rebuilds the payload
from an allowlist before the SDK serialises it, so the background batch and
multipart threads only ever see redacted operations. ``create_feedback`` keeps
the key, score and ids only. The SDK's own ``hide_inputs``/``hide_outputs``/
``hide_metadata`` hooks and ``omit_traced_runtime_info`` are set as well, as a
second layer for any path that still runs ``Client._run_transform``.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from typing import Any

GOVERNED_STRUCTURAL_TRACING_ENV = "SOPHIA_GOVERNED_STRUCTURAL_TRACING"
GOVERNED_STRUCTURAL_TRACE_MODE = "governed_structural"
TRACE_MODE_METADATA_KEY = "sophia_trace_mode"
# Excluded governed runs carry this constant marker in their run metadata and
# report it as the typed ``langsmith_trace_unavailable_reason``.
MEMORY_GOVERNANCE_EXCLUSION_REASON = "memory_governance_policy"
TRACE_EXCLUSION_METADATA_KEY = "sophia_trace_exclusion"

# Set by the governed Builder wrapper for the duration of each run, so code
# inside the run (completion annotation) knows which trace policy applies.
_ACTIVE_TRACE_POLICY: ContextVar[str | None] = ContextVar("sophia_builder_trace_policy", default=None)

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_MONOTONIC_ID_RE = re.compile(r"^(?:build|op)_[0-9A-HJKMNP-TV-Z]{26}$")
# Lower-case machine codes: statuses, reasons, model ids, extensions.
_CODE_RE = re.compile(r"^[a-z0-9_.:-]{1,128}$")
# LangGraph node names are code identifiers (middleware class names included).
_NODE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_RUN_NAME_RE = re.compile(r"^[A-Za-z0-9 _.:/<>()\[\]-]{1,128}$")
_ERROR_CLASS_RE = re.compile(r"^\s*([A-Z][A-Za-z0-9]{0,63}(?:Error|Exception|Interrupt|Exit|Cancelled|Timeout))(?=\(|:|\s|$)")
_FEEDBACK_KEY_RE = re.compile(r"^[a-z_]{1,64}$")
_USAGE_DETAIL_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")

_ID_METADATA_KEYS = {
    "thread_id": _UUID_RE,
    "run_id": _UUID_RE,
    "build_id": _MONOTONIC_ID_RE,
    "operation_id": _MONOTONIC_ID_RE,
}
_CODE_METADATA_KEYS = frozenset(
    {
        "sophia_component",
        "builder_model_name",
        "builder_model_source",
        "ls_provider",
        "ls_model_name",
        "ls_model_type",
        "artifact_type",
        "requested_artifact_ext",
        "final_artifact_ext",
        "terminal_status",
        "terminal_reason",
        "builder_terminal_status",
        "builder_terminal_reason",
        "builder_terminal_halt_reason",
        "failure_code",
        "deck_failure_code",
        "root_failure_code",
        "deck_route",
        "deck_compile_mode",
        "quality_warning",
        "image_generation_error_class",
    }
)
_NUMERIC_METADATA_KEYS = frozenset(
    {
        "langgraph_step",
        "slide_count",
        "image_count",
        "image_forward",
        "degraded",
        "dropped_image_refs",
        "qc_invocation_count",
        "qc_pass_count",
        "qc_failure_count",
        "emit_rejection_count",
        "builder_graph_halted",
        "artifact_is_fallback",
        "native_editability_score",
        "native_text_shape_count",
        "picture_shape_count",
        "full_slide_picture_count",
        "generated_visuals_complete",
        "deck_expected_visual_count",
        "deck_successful_visual_count",
        "deck_missing_visual_count",
        "time_to_first_valid_artifact_ms",
        "deck_authoring_elapsed_ms",
        "deck_repair_elapsed_ms",
        "deck_service_elapsed_ms",
        "terminal_cleanup_elapsed_ms",
    }
)
_EXACT_TAGS = frozenset(
    {
        "sophia_builder",
        "image_forward",
        "mixed_or_fallback",
        "qc_ran",
        "qc_not_applicable",
        "deck_prepare_result_missing",
        "deck_screenshot_forbidden",
        "deck_latch_passed",
        "pdf_layout_failed",
        "pdf_layout_passed",
        "report_variety_failed",
        "report_variety_passed",
        "langsmith:hidden",
        "langsmith:nostream",
    }
)
_TAG_PATTERNS = (
    re.compile(r"^(?:seq|graph):step:\d{1,6}$"),
    re.compile(r"^(?:artifact|builder_terminal|builder_model_source|builder_model):[a-z0-9_.-]{1,64}$"),
)
_USAGE_TOTAL_KEYS = ("input_tokens", "output_tokens", "total_tokens")
_USAGE_DETAIL_KEYS = ("input_token_details", "output_token_details")
_RUN_PASSTHROUGH_KEYS = ("id", "trace_id", "dotted_order", "parent_run_id", "start_time", "end_time", "session_name", "session_id")
_AUTH_PASSTHROUGH_KEYS = ("service_key", "tenant_id", "authorization", "cookie")
_USAGE_WALK_BUDGET = 4096


def governed_structural_tracing_enabled() -> bool:
    """Opt-in toggle; anything but an explicit truthy value keeps governed runs excluded."""

    return (os.getenv(GOVERNED_STRUCTURAL_TRACING_ENV) or "").strip().lower() in {"1", "true", "yes", "on"}


@contextmanager
def trace_policy_scope(policy: str) -> Iterator[None]:
    """Mark the enclosed execution as running under ``policy``."""

    previous = _ACTIVE_TRACE_POLICY.get()
    _ACTIVE_TRACE_POLICY.set(policy)
    try:
        yield
    finally:
        # ``set`` rather than ``reset(token)``: an async generator that owns
        # this scope may be finalised from a different context.
        _ACTIVE_TRACE_POLICY.set(previous)


def active_trace_policy() -> str | None:
    """Trace policy of the governed Builder run executing in this context, if any.

    The wrapper's context variable is authoritative. The constant marker the
    graph carries in its ``with_config`` metadata survives ``copy()``, but
    LangGraph's ``ensure_config`` replaces that metadata whenever the run
    passes its own (LangGraph API always does), so it is only a fallback for
    direct invocations where the variable did not propagate.
    """

    policy = _ACTIVE_TRACE_POLICY.get()
    if policy:
        return policy
    try:
        from langchain_core.runnables.config import var_child_runnable_config

        config = var_child_runnable_config.get()
    except Exception:  # noqa: BLE001 - optional dependency / SDK version guard.
        return None
    metadata = config.get("metadata") if isinstance(config, Mapping) else None
    if not isinstance(metadata, Mapping):
        return None
    if metadata.get(TRACE_EXCLUSION_METADATA_KEY) == MEMORY_GOVERNANCE_EXCLUSION_REASON:
        return MEMORY_GOVERNANCE_EXCLUSION_REASON
    if metadata.get(TRACE_MODE_METADATA_KEY) == GOVERNED_STRUCTURAL_TRACE_MODE:
        return GOVERNED_STRUCTURAL_TRACE_MODE
    return None


def _finite_number(value: Any) -> int | float | bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return None


def _token_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return int(value) if value >= 0 else None


def _numeric_usage(value: Any) -> dict[str, Any] | None:
    """Keep only numeric token counts (and numeric per-kind token details)."""

    if not isinstance(value, Mapping):
        return None
    usage: dict[str, Any] = {}
    for key in _USAGE_TOTAL_KEYS:
        count = _token_count(value.get(key))
        if count is not None:
            usage[key] = count
    for key in _USAGE_DETAIL_KEYS:
        details = value.get(key)
        if isinstance(details, Mapping):
            numeric = {str(name): count for name, raw in details.items() if isinstance(name, str) and _USAGE_DETAIL_KEY_RE.match(name) and (count := _token_count(raw)) is not None}
            if numeric:
                usage[key] = numeric
    return usage or None


def _merge_usage(total: dict[str, Any], usage: Mapping[str, Any]) -> None:
    for key in _USAGE_TOTAL_KEYS:
        if key in usage:
            total[key] = total.get(key, 0) + usage[key]
    for key in _USAGE_DETAIL_KEYS:
        details = usage.get(key)
        if isinstance(details, Mapping):
            merged = total.setdefault(key, {})
            for name, count in details.items():
                merged[name] = merged.get(name, 0) + count


def structural_usage(outputs: Any) -> dict[str, Any] | None:
    """Sum ``usage_metadata`` token counts found in an LLM run's outputs."""

    if not isinstance(outputs, Mapping):
        return None
    top_level = _numeric_usage(outputs.get("usage_metadata"))
    if top_level is not None:
        return top_level
    total: dict[str, Any] = {}
    stack: list[Any] = [outputs]
    budget = _USAGE_WALK_BUDGET
    while stack and budget > 0:
        budget -= 1
        node = stack.pop()
        if isinstance(node, Mapping):
            for key, value in node.items():
                if key == "usage_metadata":
                    usage = _numeric_usage(value)
                    if usage is not None:
                        _merge_usage(total, usage)
                elif isinstance(value, (Mapping, list, tuple)):
                    stack.append(value)
        elif isinstance(node, (list, tuple)):
            stack.extend(item for item in node if isinstance(item, (Mapping, list, tuple)))
    return total or None


def structural_outputs(outputs: Any, run_type: Any) -> dict[str, Any] | None:
    """LLM runs keep numeric token usage only; every other run sends no outputs."""

    if run_type != "llm":
        return None
    usage = structural_usage(outputs)
    return {"usage_metadata": usage} if usage else None


def _hide_outputs_hook(outputs: Any) -> dict[str, Any]:
    usage = _numeric_usage(outputs.get("usage_metadata")) if isinstance(outputs, Mapping) else None
    return {"usage_metadata": usage} if usage else {}


def _safe_metadata_value(key: str, value: Any) -> Any:
    if key in _ID_METADATA_KEYS:
        return value if isinstance(value, str) and _ID_METADATA_KEYS[key].match(value) else None
    if key in _CODE_METADATA_KEYS:
        return value if isinstance(value, str) and _CODE_RE.match(value) else None
    if key == "langgraph_node":
        return value if isinstance(value, str) and _NODE_RE.match(value) else None
    if key in _NUMERIC_METADATA_KEYS:
        return _finite_number(value)
    if key == "usage_metadata":
        return _numeric_usage(value)
    return None


def structural_metadata(metadata: Any) -> dict[str, Any]:
    """Allowlisted run metadata, always marked with the governed trace mode."""

    result: dict[str, Any] = {}
    if isinstance(metadata, Mapping):
        for key, value in metadata.items():
            if not isinstance(key, str):
                continue
            safe = _safe_metadata_value(key, value)
            if safe is not None:
                result[key] = safe
    result[TRACE_MODE_METADATA_KEY] = GOVERNED_STRUCTURAL_TRACE_MODE
    return result


def structural_tags(tags: Any) -> list[str]:
    if not isinstance(tags, Sequence) or isinstance(tags, (str, bytes)):
        return []
    kept: list[str] = []
    for tag in tags:
        if not isinstance(tag, str) or tag in kept:
            continue
        if tag in _EXACT_TAGS or any(pattern.match(tag) for pattern in _TAG_PATTERNS):
            kept.append(tag)
    return kept


def structural_error(error: Any) -> str | None:
    """Exception class name only; anything that is not a recognisable class is ``error``."""

    if error is None:
        return None
    if not isinstance(error, str):
        return "error"
    if not error.strip():
        return None
    match = _ERROR_CLASS_RE.match(error)
    return match.group(1) if match else "error"


def structural_run_name(name: Any) -> str:
    return name if isinstance(name, str) and _RUN_NAME_RE.match(name) else "run"


def structural_run_type(run_type: Any) -> str:
    return run_type if isinstance(run_type, str) and _CODE_RE.match(run_type) else "chain"


def _redacted_fields(fields: Mapping[str, Any], *, run_type: Any) -> dict[str, Any]:
    """Allowlisted run fields shared by create/update/batch payloads."""

    payload: dict[str, Any] = {key: fields[key] for key in _RUN_PASSTHROUGH_KEYS if fields.get(key) is not None}
    extra = fields.get("extra")
    payload["extra"] = {"metadata": structural_metadata(extra.get("metadata") if isinstance(extra, Mapping) else None)}
    payload["tags"] = structural_tags(fields.get("tags"))
    error = structural_error(fields.get("error"))
    if error is not None:
        payload["error"] = error
    outputs = structural_outputs(fields.get("outputs"), run_type)
    if outputs is not None:
        payload["outputs"] = outputs
    return payload


def redact_run_dict(run: Any, *, update: bool = False) -> dict[str, Any]:
    """Redact one run for the public batch/multipart ingest entry points."""

    if hasattr(run, "model_dump") and callable(run.model_dump):
        raw = run.model_dump()
    elif isinstance(run, Mapping):
        raw = dict(run)
    else:
        raw = {}
    run_type = raw.get("run_type")
    payload = _redacted_fields(raw, run_type=run_type)
    payload["name"] = structural_run_name(raw.get("name"))
    if run_type is not None:
        payload["run_type"] = structural_run_type(run_type)
    if not update:
        payload["inputs"] = {}
    return payload


class _StructuralRedactingClientMixin:
    """LangSmith client that can only ever send structure-only runs."""

    def create_run(
        self,
        name: str,
        inputs: dict[str, Any],
        run_type: Any,
        *,
        project_name: str | None = None,
        revision_id: Any = None,
        dangerously_allow_filesystem: bool = False,
        api_key: str | None = None,
        api_url: str | None = None,
        **kwargs: Any,
    ) -> None:
        payload = _redacted_fields(kwargs, run_type=run_type)
        payload.update({key: kwargs[key] for key in _AUTH_PASSTHROUGH_KEYS if kwargs.get(key) is not None})
        if kwargs.get("is_run_ops_buffer_flush"):
            payload["is_run_ops_buffer_flush"] = True
        return super().create_run(
            structural_run_name(name),
            {},
            structural_run_type(run_type),
            project_name=project_name,
            api_key=api_key,
            api_url=api_url,
            **payload,
        )

    def update_run(self, run_id: Any, **kwargs: Any) -> None:
        run_type = kwargs.get("run_type")
        payload = _redacted_fields(kwargs, run_type=run_type)
        payload.pop("id", None)
        if kwargs.get("name") is not None:
            payload["name"] = structural_run_name(kwargs["name"])
        if run_type is not None:
            payload["run_type"] = structural_run_type(run_type)
        for key in ("api_key", "api_url", *_AUTH_PASSTHROUGH_KEYS):
            if kwargs.get(key) is not None:
                payload[key] = kwargs[key]
        if kwargs.get("is_run_ops_buffer_flush"):
            payload["is_run_ops_buffer_flush"] = True
        return super().update_run(run_id, **payload)

    # Attachments never survive redaction, so the filesystem opt-in and any
    # other ingest option is dropped rather than forwarded.
    def batch_ingest_runs(self, create: Any = None, update: Any = None, **_kwargs: Any) -> None:
        return super().batch_ingest_runs(
            create=[redact_run_dict(run) for run in create or []] or None,
            update=[redact_run_dict(run, update=True) for run in update or []] or None,
        )

    def multipart_ingest(self, create: Any = None, update: Any = None, **_kwargs: Any) -> None:
        return super().multipart_ingest(
            create=[redact_run_dict(run) for run in create or []] or None,
            update=[redact_run_dict(run, update=True) for run in update or []] or None,
        )

    def create_feedback(self, run_id: Any = None, key: str = "unnamed", **kwargs: Any) -> Any:
        score = kwargs.get("score")
        safe_kwargs: dict[str, Any] = {
            "score": score if score is None or _finite_number(score) is not None else None,
        }
        for name in ("trace_id", "feedback_id", "stop_after_attempt"):
            if kwargs.get(name) is not None:
                safe_kwargs[name] = kwargs[name]
        safe_key = key if isinstance(key, str) and _FEEDBACK_KEY_RE.match(key) else "structural"
        return super().create_feedback(run_id, safe_key, **safe_kwargs)

@lru_cache(maxsize=1)
def structural_client_class() -> type:
    """Build the redacting ``langsmith.Client`` subclass (imported lazily)."""

    from langsmith import Client

    class StructuralRedactingClient(_StructuralRedactingClientMixin, Client):
        pass

    return StructuralRedactingClient

@lru_cache(maxsize=1)
def structural_tracer_class() -> type:
    """The only tracer allowed to export inside a governed structural scope."""

    from langchain_core.tracers.langchain import LangChainTracer

    class StructuralLangChainTracer(LangChainTracer):
        def _start_trace(self, run: Any) -> None:
            super()._start_trace(run)
            # The governed scope runs with LangSmith tracing disabled, which
            # marks every tracer's runs ``__disabled`` (LangChainTracer
            # ._start_trace). Only this tracer, bound to the redacting client,
            # re-enables its own runs; any other tracer - implicit, from an
            # outer tracing_v2_enabled, or attached explicitly to a model on
            # the default client - stays inert.
            run.extra.pop("__disabled", None)

    return StructuralLangChainTracer


def build_structural_tracer(
    *,
    client: Any,
    project_name: str | None,
    tags: list[str],
    metadata: dict[str, Any],
) -> Any:
    if not isinstance(client, structural_client_class()):
        raise TypeError("structural tracer requires the redacting client")
    return structural_tracer_class()(project_name=project_name, client=client, tags=tags, metadata=metadata)


def build_structural_client(
    *,
    endpoint: str,
    api_key: str | None,
    workspace_id: str | None = None,
    tracing_error_callback: Any | None = None,
    **overrides: Any,
) -> Any:
    """Construct a redacting client; callers must never fall back to a plain client."""

    kwargs: dict[str, Any] = {
        "api_url": endpoint,
        "api_key": api_key,
        "hide_inputs": True,
        "hide_outputs": _hide_outputs_hook,
        "hide_metadata": structural_metadata,
        "omit_traced_runtime_info": True,
    }
    if workspace_id:
        kwargs["workspace_id"] = workspace_id
    if tracing_error_callback is not None:
        kwargs["tracing_error_callback"] = tracing_error_callback
    kwargs.update(overrides)
    return structural_client_class()(**kwargs)
