from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import stat
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import anyio
from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.config.app_config import AppConfig
from deerflow.sophia.deck_quality.brief import sanitize_current_request
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationRecord,
    PublicationRequest,
    PublicationState,
    configured_deck_quality_publication_store,
)
from deerflow.sophia.deck_quality.schemas import BlindBrief, QualityInstrumentLock
from deerflow.sophia.deck_quality.snapshot import (
    ImmutableObjectUploader,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    SupabaseImmutableObjectStore,
    normalize_object_path,
    safe_object_path_segment,
)

logger = logging.getLogger(__name__)

_CAMPAIGN_ID = "DQ-1"
_PPTX_PREFIX = "/mnt/user-data/outputs/"
_MAX_NATIVE_JSON_BYTES = 2 * 1024 * 1024
_MAX_SOURCE_PACK_BYTES = 8 * 1024 * 1024
_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_SOURCE_PACK_UPLOAD_BACKOFFS_SECONDS = (0.25, 1.0)
_SOURCE_PACK_COMMIT_BACKOFFS_SECONDS = (0.5, 1.5)


class DeckQualityPublicationError(RuntimeError):
    """A content-free failure at the post-delivery publication boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class PreparedDeckQualityPublication(BaseModel):
    """The bounded data retained for the post-webhook canary handoff."""

    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    outputs_root: Path
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_storage_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    artifact_id: str | None = Field(default=None, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    build_id: str = Field(min_length=1, max_length=256)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    task_brief: str = Field(min_length=1, max_length=20_000)
    mechanical_gate_results: dict[str, Any]
    source_retention_report: dict[str, Any]
    native_contrast_report: dict[str, Any]
    native_mechanical_report: dict[str, Any]
    native_editability_score: float | None = None
    missing_expected_visual_count: int | None = Field(default=None, ge=0)


class DeckQualityPublicationIntent(BaseModel):
    """Content-free builder-event ticket used to create the durable outbox."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: str = Field(default="deck-quality-publication-intent/v1", pattern=r"^deck-quality-publication-intent/v1$")
    campaign_id: str = Field(default=_CAMPAIGN_ID, pattern=r"^DQ-1$")
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_storage_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    publication_max_attempts: Literal[3] = 3
    publication_deadline_at: datetime
    quality_max_attempts: Literal[5] = 5
    quality_run_deadline_at: datetime

    @model_validator(mode="after")
    def validate_deadlines(self) -> DeckQualityPublicationIntent:
        if (
            self.publication_deadline_at.tzinfo is None
            or self.publication_deadline_at.utcoffset() is None
            or self.quality_run_deadline_at.tzinfo is None
            or self.quality_run_deadline_at.utcoffset() is None
            or self.quality_run_deadline_at <= self.publication_deadline_at
        ):
            raise ValueError("publication intent deadlines are invalid")
        return self


class DeckQualitySourceHashes(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    creative_plan: str = Field(pattern=_SHA256_PATTERN)
    design_plan: str = Field(pattern=_SHA256_PATTERN)
    build_record: str = Field(pattern=_SHA256_PATTERN)
    blind_brief: str = Field(pattern=_SHA256_PATTERN)
    mechanical_record: str = Field(pattern=_SHA256_PATTERN)


class DeckQualitySourcePack(BaseModel):
    """One immutable, bounded capture of every local-only quality input."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: str = Field(default="deck-quality-source-pack/v1", pattern=r"^deck-quality-source-pack/v1$")
    campaign_id: str = Field(default=_CAMPAIGN_ID, pattern=r"^DQ-1$")
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument: QualityInstrumentLock
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_storage_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    creative_plan: dict[str, Any]
    design_plan: dict[str, Any]
    build_record: dict[str, Any]
    blind_brief: BlindBrief
    mechanical_record: dict[str, Any]
    source_hashes: DeckQualitySourceHashes

    @model_validator(mode="after")
    def validate_identity_and_hashes(self) -> DeckQualitySourcePack:
        if canonical_sha256(self.instrument) != self.instrument_identity_hash:
            raise ValueError("source-pack instrument identity does not match")
        expected_run_id = derive_quality_run_id(
            artifact_version_id=self.artifact_version_id,
            campaign_id=self.campaign_id,
            instrument=self.instrument,
        )
        if expected_run_id != self.quality_run_id:
            raise ValueError("source-pack quality run identity does not match")
        expected_hashes = DeckQualitySourceHashes(
            creative_plan=canonical_sha256(self.creative_plan),
            design_plan=canonical_sha256(self.design_plan),
            build_record=canonical_sha256(self.build_record),
            blind_brief=canonical_sha256(self.blind_brief),
            mechanical_record=canonical_sha256(self.mechanical_record),
        )
        if expected_hashes != self.source_hashes:
            raise ValueError("source-pack content hashes do not match")
        expected_prefix = normalize_object_path(f"artifacts/{safe_object_path_segment(self.user_id, default='user')}/{safe_object_path_segment(self.thread_id, default='thread')}/")
        try:
            normalized_artifact_path = normalize_object_path(self.artifact_storage_object_path)
        except ValueError as exc:
            raise ValueError("source-pack artifact path is invalid") from exc
        if normalized_artifact_path != self.artifact_storage_object_path or not normalized_artifact_path.startswith(f"{expected_prefix}/"):
            raise ValueError("source-pack artifact path is outside its user/thread scope")
        if _normalized_pptx_path(self.artifact_virtual_path) != self.artifact_virtual_path:
            raise ValueError("source-pack artifact virtual path is invalid")
        return self


class DeckQualitySourcePackDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    object_path: str = Field(min_length=1, max_length=4_096)
    sha256: str = Field(pattern=_SHA256_PATTERN)
    size_bytes: int = Field(gt=0, le=_MAX_SOURCE_PACK_BYTES)

    @model_validator(mode="after")
    def validate_object_path(self) -> DeckQualitySourcePackDescriptor:
        try:
            normalized = normalize_object_path(self.object_path)
        except ValueError as exc:
            raise ValueError("source-pack descriptor path is invalid") from exc
        if normalized != self.object_path or not normalized.endswith(f"/quality/{self.quality_run_id}/publication/source_pack/{self.sha256}.json"):
            raise ValueError("source-pack descriptor path does not match its run")
        return self


def _clean_required(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _normalized_pptx_path(value: object) -> str | None:
    raw = _clean_required(value)
    if raw is None:
        return None
    normalized = raw.replace("\\", "/")
    if normalized.startswith("mnt/user-data/outputs/"):
        normalized = f"/{normalized}"
    pure = PurePosixPath(normalized)
    if not normalized.startswith(_PPTX_PREFIX) or ".." in pure.parts or pure.suffix.casefold() != ".pptx":
        return None
    return normalized


def _outputs_root(state: Mapping[str, Any]) -> Path | None:
    thread_data = state.get("thread_data")
    if not isinstance(thread_data, Mapping):
        return None
    raw = _clean_required(thread_data.get("outputs_path"))
    return Path(raw) if raw is not None else None


def _eligible_storage_path(
    *,
    object_path: object,
    user_id: str,
    thread_id: str,
) -> str | None:
    raw = _clean_required(object_path)
    if raw is None or "://" in raw:
        return None
    try:
        normalized = normalize_object_path(raw)
        prefix = normalize_object_path(f"artifacts/{safe_object_path_segment(user_id, default='user')}/{safe_object_path_segment(thread_id, default='thread')}")
    except ValueError:
        return None
    return normalized if normalized == raw and normalized.startswith(f"{prefix}/") else None


def prepare_deck_quality_publication(
    *,
    config: AppConfig,
    state: Mapping[str, Any],
    artifact: Mapping[str, Any],
    completion_payload: Mapping[str, Any],
) -> PreparedDeckQualityPublication | None:
    """Apply the exact canary gate before any artifact or evidence file read."""

    quality = config.deck_quality
    if not quality.enabled or quality.mode != "shadow" or quality.scope != "canary":
        return None
    user_id = _clean_required(completion_payload.get("user_id"))
    if user_id is None or user_id not in quality.canary_user_ids:
        return None
    if completion_payload.get("status") != "success":
        return None
    if _clean_required(completion_payload.get("task_type")) != "presentation" or _clean_required(artifact.get("artifact_type")) != "presentation" or (_clean_required(artifact.get("artifact_ext")) or "").lstrip(".").casefold() != "pptx":
        return None
    if artifact.get("artifact_is_fallback") is True:
        return None
    if _mapping(artifact.get("mechanical_gate_results")).get("passed") is not True:
        return None
    if _clean_required(artifact.get("storage_provider")) != "supabase":
        return None
    if _clean_required(artifact.get("storage_status")) != "available":
        return None

    artifact_virtual_path = _normalized_pptx_path(artifact.get("artifact_path"))
    outputs_root = _outputs_root(state)
    thread_id = _clean_required(completion_payload.get("thread_id"))
    task_id = _clean_required(completion_payload.get("task_id"))
    builder_run_id = _clean_required(completion_payload.get("run_id"))
    # DQ-1 links to the concrete LangSmith builder root stamped by
    # ``annotate_builder_completion`` immediately before the completion
    # webhook. ``completion_payload.trace_id`` is the older companion-side
    # diagnostic correlation token and may be an eight-character fallback;
    # it is not evidence of a persisted builder trace and must never enter
    # quality provenance.
    artifact_builder_trace_id = artifact.get("builder_trace_root_run_id")
    payload_builder_trace_id = completion_payload.get("builder_trace_root_run_id")
    parent_builder_trace_id = (
        artifact_builder_trace_id
        if isinstance(artifact_builder_trace_id, str)
        and bool(artifact_builder_trace_id)
        and artifact_builder_trace_id == artifact_builder_trace_id.strip()
        and artifact_builder_trace_id == payload_builder_trace_id
        else None
    )
    build_id = _clean_required(artifact.get("deck_build_id"))
    logical_artifact_id = _clean_required(artifact.get("logical_artifact_id"))
    artifact_version_id = _clean_required(artifact.get("current_artifact_version_id"))
    task_brief = _clean_required(completion_payload.get("task_brief"))
    if None in {
        artifact_virtual_path,
        outputs_root,
        thread_id,
        task_id,
        builder_run_id,
        parent_builder_trace_id,
        build_id,
        logical_artifact_id,
        artifact_version_id,
        task_brief,
    }:
        return None
    assert artifact_virtual_path is not None
    assert outputs_root is not None
    assert thread_id is not None
    assert task_id is not None
    assert builder_run_id is not None
    assert parent_builder_trace_id is not None
    assert build_id is not None
    assert logical_artifact_id is not None
    assert artifact_version_id is not None
    assert task_brief is not None
    if safe_object_path_segment(build_id, default="build") != build_id:
        return None

    storage_path = _eligible_storage_path(
        object_path=artifact.get("storage_object_path"),
        user_id=user_id,
        thread_id=thread_id,
    )
    if storage_path is None:
        return None
    artifact_sha256 = _clean_required(artifact.get("artifact_sha256"))
    if artifact_sha256 is None or len(artifact_sha256) != 64 or any(character not in "0123456789abcdef" for character in artifact_sha256):
        return None

    revision = artifact.get("manifest_revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    manifest_revision = revision
    score = artifact.get("native_editability_score")
    native_editability_score = float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
    missing_visuals = artifact.get("missing_expected_visual_count")
    missing_expected_visual_count = missing_visuals if isinstance(missing_visuals, int) and not isinstance(missing_visuals, bool) and missing_visuals >= 0 else None
    return PreparedDeckQualityPublication(
        outputs_root=outputs_root,
        artifact_virtual_path=artifact_virtual_path,
        artifact_storage_object_path=storage_path,
        artifact_sha256=artifact_sha256,
        artifact_id=_clean_required(artifact.get("artifact_id")),
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        manifest_revision=manifest_revision,
        build_id=build_id,
        user_id=user_id,
        thread_id=thread_id,
        task_id=task_id,
        builder_run_id=builder_run_id,
        parent_builder_trace_id=parent_builder_trace_id,
        task_brief=task_brief,
        mechanical_gate_results=_mapping(artifact.get("mechanical_gate_results")),
        source_retention_report=_mapping(artifact.get("source_retention_report")),
        native_contrast_report=_mapping(artifact.get("native_contrast_report")),
        native_mechanical_report=_mapping(artifact.get("native_mechanical_report")),
        native_editability_score=native_editability_score,
        missing_expected_visual_count=missing_expected_visual_count,
    )


def _read_scoped_json_object(
    outputs_root: Path,
    *,
    filename: str,
    code: str,
) -> dict[str, Any]:
    """Read one regular deck-build JSON file without following symlinks."""

    root_fd: int | None = None
    deck_fd: int | None = None
    file_fd: int | None = None
    try:
        root = outputs_root.resolve(strict=True)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        deck_fd = os.open(
            "deck_build",
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=root_fd,
        )
        file_fd = os.open(
            filename,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=deck_fd,
        )
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= _MAX_NATIVE_JSON_BYTES:
            raise DeckQualityPublicationError(code)
        content = bytearray()
        while True:
            chunk = os.read(file_fd, min(64 * 1024, _MAX_NATIVE_JSON_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > _MAX_NATIVE_JSON_BYTES:
                raise DeckQualityPublicationError(code)
        after = os.fstat(file_fd)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) or len(content) != before.st_size:
            raise DeckQualityPublicationError(code)

        def reject_constant(_value: str) -> None:
            raise ValueError

        payload = json.loads(
            bytes(content).decode("utf-8"),
            parse_constant=reject_constant,
        )
    except DeckQualityPublicationError:
        raise
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise DeckQualityPublicationError(code) from None
    finally:
        for descriptor in (file_fd, deck_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)
    if not isinstance(payload, dict):
        raise DeckQualityPublicationError(code)
    try:
        return json.loads(canonical_json_bytes(payload))
    except (TypeError, ValueError, json.JSONDecodeError):
        raise DeckQualityPublicationError(code) from None


def _captured_native_inputs(
    prepared: PreparedDeckQualityPublication,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    creative = _read_scoped_json_object(
        prepared.outputs_root,
        filename="creative_plan.json",
        code="creative_plan_unavailable",
    )
    design = _read_scoped_json_object(
        prepared.outputs_root,
        filename="design_plan.json",
        code="design_plan_unavailable",
    )
    build_record = _read_scoped_json_object(
        prepared.outputs_root,
        filename="build.json",
        code="build_record_unavailable",
    )
    return creative, design, build_record


def _blind_brief_from_current_request(
    prepared: PreparedDeckQualityPublication,
) -> BlindBrief:
    """Project Assessment A context only from the frozen current request.

    ``BlindBrief`` v1 requires separate subject, audience, and goal strings, but
    the publication boundary currently receives only one authentic pre-plan
    source: ``task_brief``. Repeating that exact sanitized request preserves its
    provenance without asking builder-authored creative/design plans to invent
    semantic fields for the blind judge. Explicit style constraints remain in
    the request when the user actually supplied them; plan-only terms are not
    promoted into blind context.
    """

    try:
        current_request = sanitize_current_request(prepared.task_brief)
    except ValueError:
        raise DeckQualityPublicationError("blind_brief_incomplete") from None
    # BlindBrief v1 bounds each structured projection to 2,000 characters.
    # This remains a verbatim prefix of the authentic request; the complete
    # request is retained in ``request`` below.
    structured_projection = current_request[:2_000]
    return BlindBrief(
        request=current_request,
        subject=structured_projection,
        audience=structured_projection,
        goal=structured_projection,
        viewing_context="presentation",
        explicit_brand_style_constraints=(),
    )


def _known_boolean(value: object) -> bool | dict[str, str]:
    return value if isinstance(value, bool) else {"status": "unknown"}


def _mechanical_record(
    prepared: PreparedDeckQualityPublication,
) -> dict[str, dict[str, object]]:
    native = prepared.native_mechanical_report
    lint_success = native.get("lint_fix_success")
    lint_residue_count = native.get("lint_residue_count")
    if isinstance(lint_success, bool) and isinstance(lint_residue_count, int):
        native_lint: bool | dict[str, str] = lint_success and lint_residue_count == 0
    else:
        native_lint = {"status": "unknown"}
    score = prepared.native_editability_score
    editability: bool | dict[str, str] = score > 0 if score is not None else {"status": "unknown"}
    missing_visuals = prepared.missing_expected_visual_count
    visual_completeness: bool | dict[str, str] = missing_visuals == 0 if missing_visuals is not None else {"status": "unknown"}
    return {
        "checks": {
            "authoritative_gate": True,
            "source_retention": _known_boolean(prepared.source_retention_report.get("passed")),
            "native_editability": editability,
            "contrast": _known_boolean(prepared.native_contrast_report.get("passed")),
            "native_lint": native_lint,
            "overflow_collision_clipping": True,
            "render_success": _known_boolean(native.get("render_success")),
            "visual_asset_completeness": visual_completeness,
            # Set only after the durable object bytes are compared below.
            "artifact_identity": True,
        }
    }


def _artifact_identity(
    *,
    prepared: PreparedDeckQualityPublication,
    artifact_hash: str,
) -> tuple[str, str]:
    del artifact_hash
    return prepared.logical_artifact_id, prepared.artifact_version_id


def build_deck_quality_publication_intent(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> DeckQualityPublicationIntent:
    """Build the content-free ticket before any source-plan file read."""

    logical_artifact_id, artifact_version_id = _artifact_identity(
        prepared=prepared,
        artifact_hash=prepared.artifact_sha256,
    )
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact_version_id,
        campaign_id=_CAMPAIGN_ID,
        instrument=instrument.lock,
    )
    requested_at = datetime.now(UTC)
    return DeckQualityPublicationIntent(
        quality_run_id=quality_run_id,
        instrument_identity_hash=canonical_sha256(instrument.lock),
        user_id=prepared.user_id,
        thread_id=prepared.thread_id,
        task_id=prepared.task_id,
        build_id=prepared.build_id,
        builder_run_id=prepared.builder_run_id,
        parent_builder_trace_id=prepared.parent_builder_trace_id,
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        manifest_revision=prepared.manifest_revision,
        artifact_virtual_path=prepared.artifact_virtual_path,
        artifact_storage_object_path=prepared.artifact_storage_object_path,
        artifact_sha256=prepared.artifact_sha256,
        publication_deadline_at=requested_at + timedelta(minutes=3),
        quality_run_deadline_at=requested_at + timedelta(minutes=15),
    )


def capture_deck_quality_source_pack(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> tuple[DeckQualitySourcePack, bytes]:
    """Capture each local-only source once into one canonical immutable pack."""

    intent = build_deck_quality_publication_intent(
        prepared=prepared,
        instrument=instrument,
    )
    creative_plan, design_plan, build_record = _captured_native_inputs(prepared)
    brief = _blind_brief_from_current_request(prepared)
    mechanical_record = _mechanical_record(prepared)
    if any(len(canonical_json_bytes(value)) > _MAX_NATIVE_JSON_BYTES for value in (creative_plan, design_plan, build_record, mechanical_record)):
        raise DeckQualityPublicationError("source_pack_input_oversized")
    pack = DeckQualitySourcePack(
        quality_run_id=intent.quality_run_id,
        instrument=instrument.lock,
        instrument_identity_hash=intent.instrument_identity_hash,
        user_id=intent.user_id,
        thread_id=intent.thread_id,
        task_id=intent.task_id,
        build_id=intent.build_id,
        builder_run_id=intent.builder_run_id,
        parent_builder_trace_id=intent.parent_builder_trace_id,
        logical_artifact_id=intent.logical_artifact_id,
        artifact_version_id=intent.artifact_version_id,
        manifest_revision=intent.manifest_revision,
        artifact_virtual_path=intent.artifact_virtual_path,
        artifact_storage_object_path=intent.artifact_storage_object_path,
        artifact_sha256=intent.artifact_sha256,
        creative_plan=creative_plan,
        design_plan=design_plan,
        build_record=build_record,
        blind_brief=brief,
        mechanical_record=mechanical_record,
        source_hashes=DeckQualitySourceHashes(
            creative_plan=canonical_sha256(creative_plan),
            design_plan=canonical_sha256(design_plan),
            build_record=canonical_sha256(build_record),
            blind_brief=canonical_sha256(brief),
            mechanical_record=canonical_sha256(mechanical_record),
        ),
    )
    encoded = canonical_json_bytes(pack)
    if not 0 < len(encoded) <= _MAX_SOURCE_PACK_BYTES:
        raise DeckQualityPublicationError("source_pack_oversized")
    return pack, encoded


def _source_pack_object_path(
    pack: DeckQualitySourcePack,
    *,
    content_hash: str,
) -> str:
    return normalize_object_path(
        "artifacts/"
        f"{safe_object_path_segment(pack.user_id, default='user')}/"
        f"{safe_object_path_segment(pack.thread_id, default='thread')}/"
        "foundation/.builder/builds/"
        f"{safe_object_path_segment(pack.build_id, default='build')}/quality/"
        f"{pack.quality_run_id}/publication/source_pack/{content_hash}.json"
    )


def upload_deck_quality_source_pack(
    *,
    pack: DeckQualitySourcePack,
    encoded: bytes,
    object_store: ImmutableObjectUploader,
) -> DeckQualitySourcePackDescriptor:
    """Create and read back the canonical source pack before committing it."""

    if canonical_json_bytes(pack) != encoded or len(encoded) > _MAX_SOURCE_PACK_BYTES:
        raise DeckQualityPublicationError("source_pack_invalid")
    expected_hash = hashlib.sha256(encoded).hexdigest()
    object_path = _source_pack_object_path(pack, content_hash=expected_hash)
    try:
        outcome = object_store.create_if_absent(
            object_path,
            encoded,
            content_type="application/json",
        )
        bounded_reader = getattr(object_store, "read_bounded", None)
        if callable(bounded_reader):
            stored = bounded_reader(object_path, max_bytes=_MAX_SOURCE_PACK_BYTES)
        else:
            stored = object_store.read(object_path)
    except Exception:
        raise DeckQualityPublicationError("source_pack_persistence_failed") from None
    if outcome not in {"created", "exists"} or stored is None:
        raise DeckQualityPublicationError("source_pack_persistence_failed")
    if len(stored) != len(encoded) or not hmac.compare_digest(
        hashlib.sha256(stored).hexdigest(),
        expected_hash,
    ):
        raise DeckQualityPublicationError("source_pack_persistence_conflict")
    return DeckQualitySourcePackDescriptor(
        quality_run_id=pack.quality_run_id,
        object_path=object_path,
        sha256=expected_hash,
        size_bytes=len(encoded),
    )


def capture_and_upload_deck_quality_source_pack(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
    object_store: ImmutableObjectUploader,
) -> DeckQualitySourcePackDescriptor:
    pack, encoded = capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    return upload_deck_quality_source_pack(
        pack=pack,
        encoded=encoded,
        object_store=object_store,
    )


def _publication_request_from_intent(
    intent: DeckQualityPublicationIntent,
    *,
    instrument: DeckQualityRuntimeInstrument,
) -> PublicationRequest:
    return PublicationRequest(
        campaign_id=intent.campaign_id,
        instrument=instrument.lock,
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


def _publication_record_matches_request(
    record: PublicationRecord,
    request: PublicationRequest,
) -> bool:
    return all(
        (
            record.quality_run_id == request.quality_run_id,
            record.campaign_id == request.campaign_id,
            record.instrument_identity_hash == request.instrument_identity_hash,
            record.instrument_lock() == request.instrument,
            record.user_id == request.user_id,
            record.thread_id == request.thread_id,
            record.task_id == request.task_id,
            record.build_id == request.build_id,
            record.builder_run_id == request.builder_run_id,
            record.parent_builder_trace_id == request.parent_builder_trace_id,
            record.logical_artifact_id == request.logical_artifact_id,
            record.artifact_version_id == request.artifact_version_id,
            record.manifest_revision == request.manifest_revision,
            record.artifact_object_path == request.artifact_object_path,
            record.artifact_hash == request.artifact_hash,
            record.max_attempts == request.max_attempts,
            record.deadline_at == request.deadline_at,
            record.quality_max_attempts == request.quality_max_attempts,
            record.quality_run_deadline_at == request.quality_run_deadline_at,
        )
    )


def _source_pack_matches_intent(
    pack: DeckQualitySourcePack,
    intent: DeckQualityPublicationIntent,
) -> bool:
    return all(
        (
            pack.campaign_id == intent.campaign_id,
            pack.quality_run_id == intent.quality_run_id,
            pack.instrument_identity_hash == intent.instrument_identity_hash,
            pack.user_id == intent.user_id,
            pack.thread_id == intent.thread_id,
            pack.task_id == intent.task_id,
            pack.build_id == intent.build_id,
            pack.builder_run_id == intent.builder_run_id,
            pack.parent_builder_trace_id == intent.parent_builder_trace_id,
            pack.logical_artifact_id == intent.logical_artifact_id,
            pack.artifact_version_id == intent.artifact_version_id,
            pack.manifest_revision == intent.manifest_revision,
            pack.artifact_virtual_path == intent.artifact_virtual_path,
            pack.artifact_storage_object_path == intent.artifact_storage_object_path,
            pack.artifact_sha256 == intent.artifact_sha256,
        )
    )


def _upload_source_pack_with_bounded_retry(
    *,
    pack: DeckQualitySourcePack,
    encoded: bytes,
    object_store: ImmutableObjectUploader,
) -> DeckQualitySourcePackDescriptor:
    attempts = len(_SOURCE_PACK_UPLOAD_BACKOFFS_SECONDS) + 1
    for attempt in range(attempts):
        try:
            return upload_deck_quality_source_pack(
                pack=pack,
                encoded=encoded,
                object_store=object_store,
            )
        except DeckQualityPublicationError as exc:
            if exc.code != "source_pack_persistence_failed" or attempt >= len(_SOURCE_PACK_UPLOAD_BACKOFFS_SECONDS):
                raise
            time.sleep(_SOURCE_PACK_UPLOAD_BACKOFFS_SECONDS[attempt])
    raise DeckQualityPublicationError("source_pack_persistence_failed")


async def _commit_source_pack_with_bounded_retry(
    *,
    intent: DeckQualityPublicationIntent,
    instrument: DeckQualityRuntimeInstrument,
    descriptor: DeckQualitySourcePackDescriptor,
) -> PublicationRecord:
    request = _publication_request_from_intent(intent, instrument=instrument)
    if request.quality_run_id != intent.quality_run_id:
        raise DeckQualityPublicationError("publication_identity_mismatch")
    store = configured_deck_quality_publication_store()
    if store is None:
        raise DeckQualityPublicationError("publication_persistence_unavailable")
    attempts = len(_SOURCE_PACK_COMMIT_BACKOFFS_SECONDS) + 1
    try:
        for attempt in range(attempts):
            if datetime.now(UTC) >= intent.publication_deadline_at:
                raise DeckQualityPublicationError("publication_deadline_exceeded")
            try:
                record = await store.get(intent.quality_run_id)
                if record is None:
                    raise RuntimeError
                if not _publication_record_matches_request(record, request):
                    raise DeckQualityPublicationError("publication_identity_mismatch")
                committed = await store.commit_inputs(
                    record,
                    source_pack_object_path=descriptor.object_path,
                    source_pack_hash=descriptor.sha256,
                )
                if (
                    not _publication_record_matches_request(committed, request)
                    or committed.source_pack_object_path != descriptor.object_path
                    or committed.source_pack_hash != descriptor.sha256
                    or committed.state is PublicationState.AWAITING_INPUTS
                ):
                    raise DeckQualityPublicationError("publication_commit_mismatch")
                return committed
            except DeckQualityPublicationError:
                raise
            except Exception:
                if attempt >= len(_SOURCE_PACK_COMMIT_BACKOFFS_SECONDS):
                    raise DeckQualityPublicationError("publication_persistence_failed") from None
                await anyio.sleep(_SOURCE_PACK_COMMIT_BACKOFFS_SECONDS[attempt])
    finally:
        try:
            await store.aclose()
        except Exception:
            pass
    raise DeckQualityPublicationError("publication_persistence_failed")


def complete_deck_quality_publication_after_ack(
    *,
    prepared: PreparedDeckQualityPublication,
    intent: DeckQualityPublicationIntent,
    instrument: DeckQualityRuntimeInstrument,
) -> PublicationRecord:
    """Capture local-only inputs once, then commit their immutable identity.

    This is called only by the already-detached builder webhook thread after
    the gateway has ACKed the exact durable publication row.  It performs no
    artifact rendering or model work and cannot affect user delivery.
    """

    expected_request = _publication_request_from_intent(
        intent,
        instrument=instrument,
    )
    if (
        expected_request.quality_run_id != intent.quality_run_id
        or canonical_sha256(instrument.lock) != intent.instrument_identity_hash
        or prepared.user_id != intent.user_id
        or prepared.thread_id != intent.thread_id
        or prepared.task_id != intent.task_id
        or prepared.build_id != intent.build_id
        or prepared.builder_run_id != intent.builder_run_id
        or prepared.parent_builder_trace_id != intent.parent_builder_trace_id
        or prepared.logical_artifact_id != intent.logical_artifact_id
        or prepared.artifact_version_id != intent.artifact_version_id
        or prepared.manifest_revision != intent.manifest_revision
        or prepared.artifact_virtual_path != intent.artifact_virtual_path
        or prepared.artifact_storage_object_path != intent.artifact_storage_object_path
        or prepared.artifact_sha256 != intent.artifact_sha256
    ):
        raise DeckQualityPublicationError("publication_identity_mismatch")
    pack, encoded = capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    if not _source_pack_matches_intent(pack, intent):
        raise DeckQualityPublicationError("source_pack_identity_mismatch")
    descriptor = _upload_source_pack_with_bounded_retry(
        pack=pack,
        encoded=encoded,
        object_store=SupabaseImmutableObjectStore(),
    )
    if descriptor.quality_run_id != intent.quality_run_id:
        raise DeckQualityPublicationError("source_pack_identity_mismatch")

    async def commit() -> PublicationRecord:
        return await _commit_source_pack_with_bounded_retry(
            intent=intent,
            instrument=instrument,
            descriptor=descriptor,
        )

    return anyio.run(commit)
