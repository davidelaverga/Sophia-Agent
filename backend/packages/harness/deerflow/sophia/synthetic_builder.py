"""Canonical isolation metadata for VT00 synthetic Builder runs.

The voice runtime places a ``synthetic_test`` mapping in Builder input and
also projects its scalar fields into LangGraph configurable/trace metadata.
This module is the single Builder-side parser for that contract.  Ordinary
runs return ``None`` and preserve their historical behavior; any input that
declares itself synthetic is normalized, bounded, and required to carry the
complete isolation identity before Builder may continue.

Only safe identifiers and deployment metadata are retained.  No capability,
cookie, provider continuation handle, transcript, prompt, or raw artifact
content belongs in this structure.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any


class SyntheticBuilderContextError(ValueError):
    """Raised when a declared synthetic run lacks isolation identity."""


_REQUIRED_STRING_FIELDS = (
    "test_run_id",
    "test_principal_id",
    "scenario_id",
    "scenario_version",
    "environment",
    "cleanup_obligation_id",
    "provider_expires_at",
)
_ALIASES = {
    "test_principal_id": ("test_principal_id", "principal_id"),
}
_OPTIONAL_DEPLOYMENT_FIELDS = (
    "repository_sha",
    "frontend_deployment_id",
    "backend_deployment_id",
    "voice_deployment_id",
    "frontend_sha",
    "backend_sha",
    "voice_sha",
)
_DEPLOYMENT_ALIASES = {
    "repository_sha": ("repository_sha",),
    "frontend_deployment_id": ("frontend_deployment_id",),
    "backend_deployment_id": ("backend_deployment_id",),
    "voice_deployment_id": ("voice_deployment_id",),
    # Capability claims name the exact component SHAs frontend/backend/voice,
    # while product projections use the explicit *_sha names.  They are the
    # same authority dimension and must agree when both are present.
    "frontend_sha": ("frontend_sha", "frontend"),
    "backend_sha": ("backend_sha", "backend"),
    "voice_sha": ("voice_sha", "voice"),
}
_MIN_RETENTION_HOURS = 1
_MAX_RETENTION_HOURS = 168
_MAX_SAFE_VALUE_CHARS = 512
_CLEANUP_OBLIGATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_SYNTHETIC_BUILDER_JOIN_KEYS = frozenset(
    {
        "schema",
        "test_run_id",
        "scenario_id",
        "scenario_version",
        "operation_id",
        "utterance_id",
        "provider_input_sequence",
        "tool_call_id",
        "effect_id",
        "provider_connection_epoch",
        "relay_correlation_id",
        "tool_name",
        "tool_state",
        "builder_operation_id",
        "parent_thread_id",
        "task_id",
        "thread_id",
        "run_id",
        "build_id",
        "artifact_id",
        "artifact_path_sha256",
        "ui_projection_state",
        "cancel_count",
        "no_post_cancel_publication",
        "source_tool_received_at",
        "source_backend_accepted_at",
        "source_tool_response_sent_at",
        "source_builder_event_id",
        "source_builder_event_at",
        "source_ui_projected_at",
        "scenario_assertions",
    }
)


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _safe_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > _MAX_SAFE_VALUE_CHARS or "\x00" in normalized:
        return None
    return normalized


def _first_string(source: Mapping[str, Any], key: str) -> str | None:
    for candidate in _ALIASES.get(key, (key,)):
        value = _safe_string(source.get(candidate))
        if value is not None:
            return value
    return None


def _parse_utc(value: object) -> datetime | None:
    text = _safe_string(value)
    if text is None:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _canonical_utc_millis(value: datetime) -> str:
    return (
        value.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_exact_utc_millis(value: object) -> datetime | None:
    parsed = _parse_utc(value)
    text = _safe_string(value)
    if parsed is None or text is None:
        return None
    return parsed if _canonical_utc_millis(parsed) == text else None


def _candidate_sources(*sources: object) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for raw in sources:
        source = _mapping(raw)
        if not source:
            continue
        nested = _mapping(source.get("synthetic_test"))
        if nested:
            candidates.append(nested)
        candidates.append(source)
        configurable = _mapping(source.get("configurable"))
        metadata = _mapping(source.get("metadata"))
        if configurable:
            candidates.extend(_candidate_sources(configurable))
        if metadata:
            candidates.extend(_candidate_sources(metadata))
    return candidates


def declares_synthetic_builder_run(*sources: object) -> bool:
    """Return true when any source explicitly declares a synthetic run."""

    for source in _candidate_sources(*sources):
        if source.get("synthetic") is True or source.get("synthetic_test") is True:
            return True
    return False


def _deployment_identity(sources: list[dict[str, Any]]) -> dict[str, str]:
    deployment: dict[str, str] = {}
    for source in sources:
        nested = _mapping(source.get("deployment_identity"))
        expected = _mapping(source.get("expected_deployment"))
        for candidate in (nested, expected, source):
            for key, aliases in _DEPLOYMENT_ALIASES.items():
                if key in deployment:
                    continue
                for alias in aliases:
                    value = _safe_string(candidate.get(alias))
                    if value is not None:
                        deployment[key] = value
                        break

    builder_sha = _safe_string(os.getenv("RENDER_GIT_COMMIT"))
    builder_deployment_id = _safe_string(os.getenv("RENDER_DEPLOY_ID"))
    builder_service_id = _safe_string(os.getenv("RENDER_SERVICE_ID"))
    builder_service_name = _safe_string(os.getenv("RENDER_SERVICE_NAME"))
    if builder_sha:
        deployment["builder_sha"] = builder_sha
    if builder_deployment_id:
        deployment["builder_deployment_id"] = builder_deployment_id
    if builder_service_id:
        deployment["builder_service_id"] = builder_service_id
    if builder_service_name:
        deployment["builder_service_name"] = builder_service_name
    return deployment


def _identity_conflicts(sources: list[dict[str, Any]]) -> list[str]:
    """Return content-free names for disagreeing synthetic authorities.

    Builder receives the same identity through state, delegation, config, and
    completion payloads.  Precedence is unsafe here: accepting one value while
    silently discarding another can join or clean up the wrong run.  Compare
    every non-empty safe value before constructing the canonical projection.
    """

    conflicts: list[str] = []
    for key in _REQUIRED_STRING_FIELDS:
        values = {
            value
            for source in sources
            for alias in _ALIASES.get(key, (key,))
            if (value := _safe_string(source.get(alias))) is not None
        }
        if len(values) > 1:
            conflicts.append(key)

    deployment_values: dict[str, set[str]] = {
        key: set() for key in _OPTIONAL_DEPLOYMENT_FIELDS
    }
    for source in sources:
        containers = (
            _mapping(source.get("deployment_identity")),
            _mapping(source.get("expected_deployment")),
            source,
        )
        for key, aliases in _DEPLOYMENT_ALIASES.items():
            for container in containers:
                for alias in aliases:
                    value = _safe_string(container.get(alias))
                    if value is not None:
                        deployment_values[key].add(value)
    conflicts.extend(
        f"deployment_identity.{key}"
        for key, values in deployment_values.items()
        if len(values) > 1
    )
    retention_hours = {
        value
        for source in sources
        if isinstance((value := source.get("retention_hours")), int)
        and not isinstance(value, bool)
    }
    if len(retention_hours) > 1:
        conflicts.append("retention_hours")
    for key in (
        "retention_anchor",
        "retention_anchor_at",
        "retention_expires_at",
    ):
        values = {
            value
            for source in sources
            if (value := _safe_string(source.get(key))) is not None
        }
        if len(values) > 1:
            conflicts.append(key)
    return sorted(conflicts)


def _normalize_synthetic_builder_join(
    sources: list[dict[str, Any]],
    context: Mapping[str, Any],
) -> dict[str, Any] | None:
    joins = [
        dict(join)
        for source in sources
        if isinstance((join := source.get("synthetic_builder_join")), Mapping)
    ]
    if not joins:
        return None
    if any(set(join) != _SYNTHETIC_BUILDER_JOIN_KEYS for join in joins):
        raise SyntheticBuilderContextError("synthetic_builder_join_field_set_invalid")
    merged: dict[str, Any] = {}
    for key in _SYNTHETIC_BUILDER_JOIN_KEYS:
        values = [join.get(key) for join in joins if join.get(key) is not None]
        if any(value != values[0] for value in values[1:]):
            raise SyntheticBuilderContextError(
                f"synthetic_builder_join_conflict:{key}"
            )
        merged[key] = values[0] if values else None
    required_strings = (
        "test_run_id",
        "scenario_id",
        "scenario_version",
        "operation_id",
        "utterance_id",
        "tool_call_id",
        "effect_id",
        "relay_correlation_id",
        "tool_name",
        "tool_state",
        "builder_operation_id",
        "parent_thread_id",
        "task_id",
        "thread_id",
        "build_id",
        "source_tool_received_at",
        "source_backend_accepted_at",
    )
    nullable_strings = (
        "run_id",
        "artifact_id",
        "artifact_path_sha256",
        "ui_projection_state",
        "source_tool_response_sent_at",
        "source_builder_event_id",
        "source_builder_event_at",
        "source_ui_projected_at",
    )
    if (
        merged.get("schema") != "sophia_synthetic_builder_join_v1"
        or any(_safe_string(merged.get(key)) is None for key in required_strings)
        or any(
            merged.get(key) is not None and _safe_string(merged.get(key)) is None
            for key in nullable_strings
        )
        or not isinstance(merged.get("provider_input_sequence"), int)
        or isinstance(merged.get("provider_input_sequence"), bool)
        or merged["provider_input_sequence"] <= 0
        or not isinstance(merged.get("provider_connection_epoch"), int)
        or isinstance(merged.get("provider_connection_epoch"), bool)
        or merged["provider_connection_epoch"] <= 0
        or not isinstance(merged.get("cancel_count"), int)
        or isinstance(merged.get("cancel_count"), bool)
        or merged["cancel_count"] < 0
        or not isinstance(merged.get("no_post_cancel_publication"), bool)
        or not isinstance(merged.get("scenario_assertions"), Mapping)
        or merged.get("test_run_id") != context.get("test_run_id")
        or merged.get("scenario_id") != context.get("scenario_id")
        or merged.get("scenario_version") != context.get("scenario_version")
    ):
        raise SyntheticBuilderContextError("synthetic_builder_join_invalid")
    assertions = dict(merged["scenario_assertions"])
    if any(
        not isinstance(key, str)
        or not key
        or not isinstance(value, (bool, int, str, type(None)))
        for key, value in assertions.items()
    ):
        raise SyntheticBuilderContextError(
            "synthetic_builder_join_scenario_assertions_invalid"
        )
    merged["scenario_assertions"] = assertions
    return merged


def normalize_synthetic_builder_context(
    *sources: object,
    now: datetime | None = None,
    require_complete: bool = True,
) -> dict[str, Any] | None:
    """Return one canonical safe context, or ``None`` for an ordinary run.

    A declared synthetic run never degrades to an ordinary run.  With the
    default ``require_complete=True`` an incomplete identity raises a typed
    error so callers fail closed before memory, quality, or publication.
    ``require_complete=False`` is reserved for exclusion checks that must run
    even while reporting a malformed synthetic request.
    """

    candidates = _candidate_sources(*sources)
    if not any(
        source.get("synthetic") is True or source.get("synthetic_test") is True
        for source in candidates
    ):
        return None

    conflicts = _identity_conflicts(candidates)
    if conflicts:
        raise SyntheticBuilderContextError(
            "synthetic_builder_identity_conflict:" + ",".join(conflicts)
        )

    combined: dict[str, Any] = {}
    for source in reversed(candidates):
        combined.update(source)

    context: dict[str, Any] = {"synthetic": True}
    for key in _REQUIRED_STRING_FIELDS:
        value = _first_string(combined, key)
        if value is not None:
            context[key] = value
    principal_id = context.get("test_principal_id")
    if principal_id is not None:
        context["principal_id"] = principal_id
    cleanup_obligation_id = context.get("cleanup_obligation_id")
    if (
        cleanup_obligation_id is not None
        and not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
    ):
        if require_complete:
            raise SyntheticBuilderContextError(
                "synthetic_builder_cleanup_obligation_id_invalid"
            )
        context.pop("cleanup_obligation_id", None)

    current = (now or datetime.now(UTC)).astimezone(UTC)
    retention_hours = combined.get("retention_hours")
    raw_expiry = combined.get("retention_expires_at")
    if raw_expiry is None:
        raw_expiry = combined.get("retention_expiry")
    raw_anchor = combined.get("retention_anchor")
    raw_anchor_at = combined.get("retention_anchor_at")
    expiry = _parse_exact_utc_millis(raw_expiry)
    anchor_at = _parse_exact_utc_millis(raw_anchor_at)
    retention_invalid = False
    provider_expiry = _parse_exact_utc_millis(combined.get("provider_expires_at"))
    if (
        not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not _MIN_RETENTION_HOURS
        <= retention_hours
        <= _MAX_RETENTION_HOURS
    ):
        retention_invalid = True
    elif raw_expiry is None and raw_anchor is None and raw_anchor_at is None:
        anchor_at = current
        expiry = current + timedelta(hours=retention_hours)
    elif (
        raw_anchor != "builder_task_created_at_provisional"
        or anchor_at is None
        or expiry is None
        or expiry != anchor_at + timedelta(hours=retention_hours)
        or not current < expiry <= current + timedelta(hours=retention_hours)
    ):
        retention_invalid = True
    if not retention_invalid and anchor_at is not None and expiry is not None:
        if (
            provider_expiry is None
            or provider_expiry <= current
            or provider_expiry > expiry
        ):
            retention_invalid = True
    if not retention_invalid and anchor_at is not None and expiry is not None:
        context.update(
            {
                "retention_hours": retention_hours,
                "retention_anchor": "builder_task_created_at_provisional",
                "retention_anchor_at": _canonical_utc_millis(anchor_at),
                "retention_expires_at": _canonical_utc_millis(expiry),
                "provider_expires_at": _canonical_utc_millis(provider_expiry),
            }
        )
    context["deployment_identity"] = _deployment_identity(candidates)
    synthetic_builder_join = _normalize_synthetic_builder_join(candidates, context)
    if synthetic_builder_join is not None:
        context["synthetic_builder_join"] = synthetic_builder_join
    context.update(
        {
            "memory_retrieval_excluded": True,
            "memory_learning_excluded": True,
            "ordinary_artifact_publication_excluded": True,
            "ordinary_analytics_excluded": True,
            "deck_quality_publication_excluded": True,
            "langsmith_export_excluded": True,
            "langsmith_trace_status": "trace_unavailable",
            "langsmith_trace_unavailable_reason": "synthetic_isolation_policy",
        }
    )

    missing = [key for key in _REQUIRED_STRING_FIELDS if key not in context]
    if retention_invalid:
        context["isolation_status"] = "synthetic_retention_invalid"
        if require_complete:
            raise SyntheticBuilderContextError("synthetic_builder_retention_invalid")
        return context
    if missing:
        context["isolation_status"] = "synthetic_identity_incomplete"
        context["missing_identity_fields"] = missing
        if require_complete:
            raise SyntheticBuilderContextError(
                "synthetic_builder_identity_incomplete:" + ",".join(missing)
            )
    else:
        context["isolation_status"] = "isolated"
    return context


def synthetic_builder_projection(context: Mapping[str, Any] | None) -> dict[str, Any]:
    """Flatten a canonical context into event/task/artifact-safe fields."""

    if not isinstance(context, Mapping) or context.get("synthetic") is not True:
        return {}
    projection: dict[str, Any] = {
        "synthetic_test": True,
        "test_run_id": context.get("test_run_id"),
        "test_principal_id": context.get("test_principal_id"),
        "scenario_id": context.get("scenario_id"),
        "scenario_version": context.get("scenario_version"),
        "environment": context.get("environment"),
        "cleanup_obligation_id": context.get("cleanup_obligation_id"),
        "provider_expires_at": context.get("provider_expires_at"),
        "retention_hours": context.get("retention_hours"),
        "retention_anchor": context.get("retention_anchor"),
        "retention_anchor_at": context.get("retention_anchor_at"),
        "retention_expires_at": context.get("retention_expires_at"),
        "deployment_identity": dict(_mapping(context.get("deployment_identity"))),
        "isolation_status": context.get("isolation_status"),
        "memory_retrieval_excluded": True,
        "memory_learning_excluded": True,
        "ordinary_artifact_publication_excluded": True,
        "ordinary_analytics_excluded": True,
        "deck_quality_publication_excluded": True,
        "langsmith_export_excluded": True,
        "langsmith_trace_status": "trace_unavailable",
        "langsmith_trace_unavailable_reason": "synthetic_isolation_policy",
        "synthetic_builder_join": dict(
            _mapping(context.get("synthetic_builder_join"))
        ) or None,
    }
    return {key: value for key, value in projection.items() if value is not None}


def synthetic_retention_expired(value: object, *, now: datetime | None = None) -> bool:
    source = _mapping(value)
    expiry = _parse_utc(source.get("retention_expires_at") if source else value)
    if expiry is None:
        return True
    return expiry <= (now or datetime.now(UTC)).astimezone(UTC)


__all__ = [
    "SyntheticBuilderContextError",
    "declares_synthetic_builder_run",
    "normalize_synthetic_builder_context",
    "synthetic_builder_projection",
    "synthetic_retention_expired",
]
