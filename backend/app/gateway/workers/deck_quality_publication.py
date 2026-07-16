"""Gateway admission boundary for the durable DQ-1 publication outbox.

The dedicated authenticated publication endpoint carries a minimal,
content-free admission envelope. This module independently rechecks canary
scope and every immutable identity before creating the service-role-only
outbox row. It never reads artifact bytes or model-facing evidence.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from deerflow.config.app_config import get_app_config
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.instrument import compile_runtime_instrument
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationRecord,
    PublicationRequest,
)
from deerflow.sophia.deck_quality.publisher import DeckQualityPublicationIntent
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.storage.supabase_artifact_store import normalize_object_path

_STORE_ATTR = "_deck_quality_publication_store"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class DeckQualityPublicationAdmissionError(RuntimeError):
    """Content-free failure to establish the eligible durable outbox row."""


class DeckQualityPublicationAck(BaseModel):
    """Content-free proof that this gateway durably understands the intent."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-publication-ack/v1"] = "deck-quality-publication-ack/v1"
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    state: Literal["requested", "reconciled"]


@runtime_checkable
class DeckQualityPublicationAdmissionStore(Protocol):
    async def request(self, request: PublicationRequest) -> PublicationRecord: ...

    async def get(self, quality_run_id: str) -> PublicationRecord | None: ...


def install_deck_quality_publication_store(
    app: Any,
    store: DeckQualityPublicationAdmissionStore | None,
) -> None:
    setattr(app.state, _STORE_ATTR, store)


def get_deck_quality_publication_store_or_none(
    app: Any,
) -> DeckQualityPublicationAdmissionStore | None:
    value = getattr(app.state, _STORE_ATTR, None)
    return value if isinstance(value, DeckQualityPublicationAdmissionStore) else None


def get_deck_quality_publication_store(app: Any) -> DeckQualityPublicationAdmissionStore:
    store = get_deck_quality_publication_store_or_none(app)
    if store is None:
        raise DeckQualityPublicationAdmissionError("publication_persistence_unavailable")
    return store


def _wire_virtual_path_matches(intent_path: str, payload_path: object) -> bool:
    if not isinstance(payload_path, str) or not payload_path:
        return False
    path = PurePosixPath(intent_path)
    if not intent_path.startswith("/mnt/user-data/outputs/") or ".." in path.parts or path.suffix.casefold() != ".pptx":
        return False
    # The builder event wire format intentionally removes the leading slash
    # from /mnt/user-data/outputs paths.  No other normalization is accepted.
    return payload_path == intent_path.removeprefix("/")


def _builder_payload_is_eligible(payload: Mapping[str, Any]) -> bool:
    artifact_path = payload.get("artifact_path")
    if not isinstance(artifact_path, str):
        return False
    path = PurePosixPath(artifact_path)
    mechanical = payload.get("mechanical_gate_results")
    storage_path = payload.get("storage_object_path")
    artifact_hash = payload.get("artifact_sha256")
    return (
        payload.get("status") in {"success", "completed"}
        and artifact_path.startswith("mnt/user-data/outputs/")
        and ".." not in path.parts
        and path.suffix.casefold() == ".pptx"
        and payload.get("artifact_type") == "presentation"
        and isinstance(payload.get("artifact_ext"), str)
        and str(payload["artifact_ext"]).lstrip(".").casefold() == "pptx"
        and payload.get("artifact_is_fallback") is not True
        and payload.get("storage_provider") == "supabase"
        and payload.get("storage_status") == "available"
        and isinstance(mechanical, Mapping)
        and mechanical.get("passed") is True
        and isinstance(storage_path, str)
        and bool(storage_path)
        and isinstance(artifact_hash, str)
        and _SHA256_RE.fullmatch(artifact_hash) is not None
    )


def _intent_matches_builder_payload(
    intent: DeckQualityPublicationIntent,
    payload: Mapping[str, Any],
) -> bool:
    exact_fields = (
        (intent.user_id, payload.get("user_id")),
        (intent.thread_id, payload.get("thread_id")),
        (intent.task_id, payload.get("task_id")),
        (intent.build_id, payload.get("deck_build_id")),
        (intent.builder_run_id, payload.get("run_id")),
        (
            intent.parent_builder_trace_id,
            payload.get("builder_trace_root_run_id"),
        ),
        (intent.logical_artifact_id, payload.get("logical_artifact_id")),
        (intent.artifact_version_id, payload.get("current_artifact_version_id")),
        (intent.manifest_revision, payload.get("manifest_revision")),
        (intent.artifact_storage_object_path, payload.get("storage_object_path")),
        (intent.artifact_sha256, payload.get("artifact_sha256")),
    )
    if any(expected != actual for expected, actual in exact_fields):
        return False
    if not _wire_virtual_path_matches(
        intent.artifact_virtual_path,
        payload.get("artifact_path"),
    ):
        return False
    try:
        return normalize_object_path(intent.artifact_storage_object_path) == intent.artifact_storage_object_path
    except ValueError:
        return False


def _request_from_intent(
    intent: DeckQualityPublicationIntent,
    *,
    instrument: QualityInstrumentLock,
) -> PublicationRequest:
    return PublicationRequest(
        campaign_id=intent.campaign_id,
        instrument=instrument,
        user_id=intent.user_id,
        thread_id=intent.thread_id,
        task_id=intent.task_id,
        build_id=intent.build_id,
        builder_run_id=intent.builder_run_id,
        parent_builder_trace_id=intent.parent_builder_trace_id,
        logical_artifact_id=intent.logical_artifact_id,
        artifact_version_id=intent.artifact_version_id,
        manifest_revision=intent.manifest_revision,
        artifact_object_path=intent.artifact_storage_object_path,
        artifact_hash=intent.artifact_sha256,
        max_attempts=intent.publication_max_attempts,
        deadline_at=intent.publication_deadline_at,
        quality_max_attempts=intent.quality_max_attempts,
        quality_run_deadline_at=intent.quality_run_deadline_at,
    )


def _record_matches_request(
    record: PublicationRecord,
    request: PublicationRequest,
) -> bool:
    return (
        record.quality_run_id == request.quality_run_id
        and record.campaign_id == request.campaign_id
        and record.instrument_identity_hash == request.instrument_identity_hash
        and record.instrument_lock() == request.instrument
        and record.user_id == request.user_id
        and record.thread_id == request.thread_id
        and record.task_id == request.task_id
        and record.build_id == request.build_id
        and record.builder_run_id == request.builder_run_id
        and record.parent_builder_trace_id == request.parent_builder_trace_id
        and record.logical_artifact_id == request.logical_artifact_id
        and record.artifact_version_id == request.artifact_version_id
        and record.manifest_revision == request.manifest_revision
        and record.artifact_object_path == request.artifact_object_path
        and record.artifact_hash == request.artifact_hash
        and record.max_attempts == request.max_attempts
        and record.deadline_at == request.deadline_at
        and record.quality_max_attempts == request.quality_max_attempts
        and record.quality_run_deadline_at == request.quality_run_deadline_at
    )


async def admit_deck_quality_publication(
    app: Any,
    *,
    raw_intent: Mapping[str, Any] | None,
    builder_payload: Mapping[str, Any],
) -> DeckQualityPublicationAck | None:
    """Request or reconcile one exact canary publication intent.

    A missing, disabled, or noncanary intent is an ordinary builder event and
    causes no persistence calls.  Once the payload itself proves exact canary
    eligibility, every invalid or unavailable admission path fails closed.
    """

    if raw_intent is None:
        return None

    try:
        config = get_app_config()
        quality = config.deck_quality
    except Exception:
        raise DeckQualityPublicationAdmissionError("publication_configuration_unavailable") from None

    payload_user_id = builder_payload.get("user_id")
    if not quality.enabled or quality.mode != "shadow" or quality.scope != "canary" or not isinstance(payload_user_id, str) or payload_user_id not in quality.canary_user_ids:
        return None
    if not _builder_payload_is_eligible(builder_payload):
        return None

    try:
        intent = DeckQualityPublicationIntent.model_validate(raw_intent)
        runtime_instrument = compile_runtime_instrument(config)
        if canonical_sha256(runtime_instrument.lock) != intent.instrument_identity_hash:
            raise ValueError("instrument identity mismatch")
        if not _intent_matches_builder_payload(intent, builder_payload):
            raise ValueError("builder identity mismatch")
        publication_request = _request_from_intent(
            intent,
            instrument=runtime_instrument.lock,
        )
        if publication_request.quality_run_id != intent.quality_run_id:
            raise ValueError("quality-run identity mismatch")
        store = get_deck_quality_publication_store(app)
    except DeckQualityPublicationAdmissionError:
        raise
    except Exception:
        raise DeckQualityPublicationAdmissionError("publication_intent_invalid") from None

    try:
        record = await store.request(publication_request)
        if not _record_matches_request(record, publication_request):
            raise DeckQualityPublicationAdmissionError("publication_request_response_mismatch")
        return DeckQualityPublicationAck(
            quality_run_id=intent.quality_run_id,
            state="requested",
        )
    except DeckQualityPublicationAdmissionError:
        raise
    except Exception:
        pass

    # A request can commit durably while its HTTP response is lost.  Reconcile
    # by the deterministic run ID before asking the builder webhook to retry.
    try:
        existing = await store.get(publication_request.quality_run_id)
        if existing is not None and _record_matches_request(
            existing,
            publication_request,
        ):
            return DeckQualityPublicationAck(
                quality_run_id=intent.quality_run_id,
                state="reconciled",
            )
    except Exception:
        pass
    raise DeckQualityPublicationAdmissionError("publication_persistence_failed") from None
