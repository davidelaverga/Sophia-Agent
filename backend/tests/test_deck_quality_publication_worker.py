from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from pptx import Presentation
from pptx.util import Inches

from app.gateway.workers.deck_quality_publication_worker import (
    DeckQualityPublicationWorker,
    build_configured_deck_quality_publication_worker,
    get_deck_quality_publication_worker,
    get_deck_quality_publication_worker_or_none,
    install_deck_quality_publication_worker,
    start_deck_quality_publication_worker,
    stop_deck_quality_publication_worker,
)
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationErrorCode,
    PublicationLease,
    PublicationOperationKind,
    PublicationRecord,
    PublicationState,
    expected_publication_source_pack_path,
)
from deerflow.sophia.deck_quality.publisher import (
    DeckQualitySourceHashes,
    DeckQualitySourcePack,
)
from deerflow.sophia.deck_quality.schemas import BlindBrief, QualityInstrumentLock

CANARY_USER = "canary-user"
THREAD_ID = "thread-01"
BUILD_ID = "build-01"
ARTIFACT_VERSION_ID = "artifact-version-01"


def _instrument(**overrides: object) -> QualityInstrumentLock:
    values: dict[str, object] = {
        "rubric_version": "deck-rubric-v2",
        "rubric_hash": "a" * 64,
        "prompt_hashes": {
            "blind_visual": "b" * 64,
            "plan_realization": "c" * 64,
        },
        "judge_plan_hash": "d" * 64,
        "judge_profile_version": "v2",
        "evidence_preprocessor_version": "deck-evidence-v4",
        "judge_invoker_version": "deck-judge-invoker-v4",
        "assessment_schema_versions": {
            "blind_visual": "v4",
            "plan_realization": "v4",
        },
        "adjudication_policy_hash": "e" * 64,
    }
    values.update(overrides)
    return QualityInstrumentLock.model_validate(values)


def _config(*, users: frozenset[str] = frozenset({CANARY_USER})) -> DeckQualityConfig:
    return DeckQualityConfig(
        enabled=True,
        mode="shadow",
        scope="canary",
        canary_user_ids=users,
        max_quality_cost_usd=Decimal("0.60"),
    )


def _pptx_bytes() -> bytes:
    output = io.BytesIO()
    presentation = Presentation()
    blank = presentation.slide_layouts[6]
    first = presentation.slides.add_slide(blank)
    first.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1)).text = (
        "Observe, appraise, act"
    )
    second = presentation.slides.add_slide(blank)
    second.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1)).text = (
        "Close the loop"
    )
    presentation.save(output)
    return output.getvalue()


def _pack(
    artifact_bytes: bytes,
    *,
    instrument: QualityInstrumentLock | None = None,
    task_id: str = "task-01",
) -> DeckQualitySourcePack:
    instrument = instrument or _instrument()
    quality_run_id = derive_quality_run_id(
        artifact_version_id=ARTIFACT_VERSION_ID,
        campaign_id="DQ-1",
        instrument=instrument,
    )
    creative = {"subject_materials": ["control loops"], "signature": "cycle"}
    design = {"palette": ["ink", "paper"], "rhythm": "setup-mechanism-close"}
    build = {
        "build_id": BUILD_ID,
        "slides": [{"selector": "slide:1"}, {"selector": "slide:2"}],
    }
    brief = BlindBrief(
        request="Explain the control loop.",
        subject="Control loops",
        audience="AI engineers",
        goal="Explain the mechanism",
    )
    mechanical = {
        "checks": {
            "authoritative_gate": True,
            "native_editability": True,
            "render_success": True,
        }
    }
    return DeckQualitySourcePack(
        quality_run_id=quality_run_id,
        instrument=instrument,
        instrument_identity_hash=canonical_sha256(instrument),
        user_id=CANARY_USER,
        thread_id=THREAD_ID,
        task_id=task_id,
        build_id=BUILD_ID,
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        manifest_revision=1,
        artifact_virtual_path="/mnt/user-data/outputs/deck.pptx",
        artifact_storage_object_path=(
            f"artifacts/{CANARY_USER}/{THREAD_ID}/foundation/.builder/builds/"
            f"{BUILD_ID}/accepted/deck.pptx"
        ),
        artifact_sha256=hashlib.sha256(artifact_bytes).hexdigest(),
        creative_plan=creative,
        design_plan=design,
        build_record=build,
        blind_brief=brief,
        mechanical_record=mechanical,
        source_hashes=DeckQualitySourceHashes(
            creative_plan=canonical_sha256(creative),
            design_plan=canonical_sha256(design),
            build_record=canonical_sha256(build),
            blind_brief=canonical_sha256(brief),
            mechanical_record=canonical_sha256(mechanical),
        ),
    )


def _validated_update(record: PublicationRecord, **updates: object) -> PublicationRecord:
    payload = record.model_dump(mode="python")
    payload.update(updates)
    return PublicationRecord.model_validate(payload)


def _pending_record(
    pack: DeckQualitySourcePack,
    encoded: bytes,
    *,
    now: datetime,
    row_task_id: str = "task-01",
) -> PublicationRecord:
    source_hash = hashlib.sha256(encoded).hexdigest()
    instrument = pack.instrument
    return PublicationRecord(
        quality_run_id=pack.quality_run_id,
        campaign_id="DQ-1",
        scope_kind="canary",
        instrument_schema_version=instrument.schema_version,
        instrument_identity_hash=canonical_sha256(instrument),
        rubric_version=instrument.rubric_version,
        rubric_hash=instrument.rubric_hash,
        prompt_hashes=instrument.prompt_hashes,
        judge_plan_hash=instrument.judge_plan_hash,
        judge_profile_version=instrument.judge_profile_version,
        evidence_preprocessor_version=instrument.evidence_preprocessor_version,
        judge_invoker_version=instrument.judge_invoker_version,
        assessment_schema_versions=instrument.assessment_schema_versions,
        adjudication_policy_hash=instrument.adjudication_policy_hash,
        user_id=CANARY_USER,
        thread_id=THREAD_ID,
        task_id=row_task_id,
        build_id=BUILD_ID,
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        manifest_revision=1,
        artifact_object_path=pack.artifact_storage_object_path,
        artifact_hash=pack.artifact_sha256,
        source_pack_object_path=expected_publication_source_pack_path(
            user_id=CANARY_USER,
            thread_id=THREAD_ID,
            build_id=BUILD_ID,
            quality_run_id=pack.quality_run_id,
            source_pack_hash=source_hash,
        ),
        source_pack_hash=source_hash,
        state=PublicationState.PENDING,
        attempt_count=0,
        max_attempts=3,
        error_count=0,
        next_attempt_at=now,
        deadline_at=now + timedelta(minutes=3),
        quality_max_attempts=5,
        quality_run_deadline_at=now + timedelta(minutes=15),
        lease_epoch=0,
        requested_at=now,
        updated_at=now,
    )


class FakePublicationStore:
    def __init__(self, record: PublicationRecord, *, now: datetime) -> None:
        self.record = record
        self.now = now
        self.claim_calls: list[dict[str, object]] = []
        self.retry_calls: list[dict[str, object]] = []
        self.fail_calls: list[dict[str, object]] = []
        self.promote_calls: list[dict[str, object]] = []
        self.probe_calls = 0
        self.close_calls = 0
        self.get_calls = 0
        self.lose_claim_response_once = False
        self.lose_promote_response_once = False

    async def probe(self) -> None:
        self.probe_calls += 1

    async def aclose(self) -> None:
        self.close_calls += 1

    async def claim(
        self,
        *,
        lease_owner: str,
        claim_token: str,
        lease_seconds: int = 60,
        limit: int = 1,
    ) -> tuple[PublicationRecord, ...]:
        arguments = {
            "lease_owner": lease_owner,
            "claim_token": claim_token,
            "lease_seconds": lease_seconds,
            "limit": limit,
        }
        self.claim_calls.append(arguments)
        if self.record.state is PublicationState.RUNNING:
            if (
                self.record.lease_owner == lease_owner
                and self.record.claim_token == claim_token
            ):
                return (self.record,)
            return ()
        if self.record.state not in {
            PublicationState.PENDING,
            PublicationState.RETRY_WAIT,
        }:
            return ()
        claim_hash = canonical_sha256(arguments)
        self.record = _validated_update(
            self.record,
            state=PublicationState.RUNNING,
            attempt_count=self.record.attempt_count + 1,
            lease_owner=lease_owner,
            lease_epoch=self.record.lease_epoch + 1,
            lease_expires_at=self.now + timedelta(seconds=lease_seconds),
            claim_token=claim_token,
            claim_hash=claim_hash,
            started_at=self.record.started_at or self.now,
            updated_at=self.now,
            last_operation_kind=None,
            last_operation_token=None,
            last_operation_hash=None,
        )
        if self.lose_claim_response_once:
            self.lose_claim_response_once = False
            raise RuntimeError("simulated lost claim response")
        return (self.record,)

    async def retry(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
        delay_seconds: int = 15,
    ) -> PublicationRecord:
        assert lease.quality_run_id == self.record.quality_run_id
        self.retry_calls.append(
            {
                "operation_token": operation_token,
                "error_code": error_code,
                "error_stage": error_stage,
                "delay_seconds": delay_seconds,
            }
        )
        terminal = self.record.attempt_count >= self.record.max_attempts
        self.record = _validated_update(
            self.record,
            state=(PublicationState.FAILED if terminal else PublicationState.RETRY_WAIT),
            error_count=self.record.error_count + 1,
            next_attempt_at=self.now + timedelta(seconds=delay_seconds),
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind=PublicationOperationKind.RETRY,
            last_operation_token=operation_token,
            last_operation_hash="f" * 64,
            last_error_code=(
                PublicationErrorCode.ATTEMPT_LIMIT_EXHAUSTED
                if terminal
                else error_code
            ),
            last_error_stage=error_stage,
            last_error_at=self.now,
            finished_at=(self.now if terminal else None),
            updated_at=self.now,
        )
        return self.record

    async def fail(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
    ) -> PublicationRecord:
        assert lease.quality_run_id == self.record.quality_run_id
        self.fail_calls.append(
            {
                "operation_token": operation_token,
                "error_code": error_code,
                "error_stage": error_stage,
            }
        )
        self.record = _validated_update(
            self.record,
            state=PublicationState.FAILED,
            error_count=self.record.error_count + 1,
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind=PublicationOperationKind.FAIL,
            last_operation_token=operation_token,
            last_operation_hash="f" * 64,
            last_error_code=error_code,
            last_error_stage=error_stage,
            last_error_at=self.now,
            finished_at=self.now,
            updated_at=self.now,
        )
        return self.record

    async def promote(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        input_manifest_object_path: str,
        input_manifest_hash: str,
    ) -> PublicationRecord:
        assert lease.quality_run_id == self.record.quality_run_id
        self.promote_calls.append(
            {
                "operation_token": operation_token,
                "input_manifest_object_path": input_manifest_object_path,
                "input_manifest_hash": input_manifest_hash,
            }
        )
        self.record = _validated_update(
            self.record,
            state=PublicationState.PUBLISHED,
            input_manifest_object_path=input_manifest_object_path,
            input_manifest_hash=input_manifest_hash,
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind=PublicationOperationKind.PROMOTE,
            last_operation_token=operation_token,
            last_operation_hash="f" * 64,
            finished_at=self.now,
            updated_at=self.now,
        )
        if self.lose_promote_response_once:
            self.lose_promote_response_once = False
            raise RuntimeError("simulated lost promotion response")
        return self.record

    async def get(self, quality_run_id: str) -> PublicationRecord | None:
        self.get_calls += 1
        return self.record if quality_run_id == self.record.quality_run_id else None


class FakeObjects:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.reads: list[tuple[str, int]] = []
        self.creates: list[tuple[str, str]] = []
        self.fail_reads: set[str] = set()

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        self.reads.append((object_path, max_bytes))
        if object_path in self.fail_reads:
            raise RuntimeError("simulated read outage")
        value = self.objects.get(object_path)
        if value is not None and len(value) > max_bytes:
            raise RuntimeError("simulated oversize object")
        return bytes(value) if value is not None else None

    def read(self, object_path: str) -> bytes | None:
        value = self.objects.get(object_path)
        return bytes(value) if value is not None else None

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        self.creates.append((object_path, content_type))
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = bytes(content)
        return "created"


def _setup(
    tmp_path: Path,
    *,
    pack_task_id: str = "task-01",
    row_task_id: str = "task-01",
    config: DeckQualityConfig | None = None,
) -> tuple[
    DeckQualityPublicationWorker,
    FakePublicationStore,
    FakeObjects,
    DeckQualitySourcePack,
]:
    now = datetime.now(UTC).replace(microsecond=0)
    artifact = _pptx_bytes()
    pack = _pack(artifact, task_id=pack_task_id)
    encoded = canonical_json_bytes(pack)
    record = _pending_record(pack, encoded, now=now, row_task_id=row_task_id)
    assert record.source_pack_object_path is not None
    objects = FakeObjects(
        {
            record.source_pack_object_path: encoded,
            record.artifact_object_path: artifact,
        }
    )
    store = FakePublicationStore(record, now=now)
    tokens = iter(("claim-token-1", "claim-token-2", "claim-token-3"))
    worker = DeckQualityPublicationWorker(
        config=config or _config(),
        instrument=_instrument(),
        store=store,
        object_store=objects,
        lease_owner="publication-worker-1",
        materialization_root=tmp_path / "materialized",
        claim_token_factory=lambda: next(tokens),
        clock=lambda: store.now,
    )
    return worker, store, objects, pack


@pytest.mark.anyio
async def test_worker_materializes_v2_inputs_and_atomically_promotes(
    tmp_path: Path,
) -> None:
    worker, store, objects, pack = _setup(tmp_path)
    source_path = store.record.source_pack_object_path
    assert source_path is not None

    result = await worker.run_once()

    assert result.claimed == 1
    assert result.published == 1
    assert store.record.state is PublicationState.PUBLISHED
    assert store.claim_calls[0] == {
        "lease_owner": "publication-worker-1",
        "claim_token": "claim-token-1",
        "lease_seconds": 120,
        "limit": 2,
    }
    assert objects.reads[:2] == [
        (source_path, 8 * 1024 * 1024),
        (pack.artifact_storage_object_path, 32 * 1024 * 1024),
    ]
    assert len(store.promote_calls) == 1
    promoted = store.promote_calls[0]
    assert str(promoted["operation_token"]).startswith("dq1-pub-promote:")
    manifest_path = str(promoted["input_manifest_object_path"])
    manifest_hash = str(promoted["input_manifest_hash"])
    assert manifest_path == store.record.expected_input_manifest_object_path
    assert hashlib.sha256(objects.objects[manifest_path]).hexdigest() == manifest_hash
    manifest = json.loads(objects.objects[manifest_path])
    assert manifest["schema_version"] == "deck-quality-pre-render-input-manifest/v2"
    assert [item["role"] for item in manifest["objects"]] == [
        "accepted_artifact",
        "creative_plan",
        "design_plan",
        "build_record",
        "blind_brief",
        "mechanical_record",
    ]
    assert all(item["media_type"] != "application/pdf" for item in manifest["objects"])
    materialized = tmp_path / "materialized"
    assert materialized.is_dir() and list(materialized.iterdir()) == []


@pytest.mark.anyio
async def test_worker_rejects_source_identity_before_artifact_read(
    tmp_path: Path,
) -> None:
    worker, store, objects, _pack_value = _setup(
        tmp_path,
        pack_task_id="different-task",
        row_task_id="task-01",
    )
    source_path = store.record.source_pack_object_path

    result = await worker.run_once()

    assert result.failed == 1
    assert store.fail_calls[0]["error_code"] is PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE
    assert store.fail_calls[0]["error_stage"] == "source_identity"
    assert objects.reads == [(source_path, 8 * 1024 * 1024)]
    assert store.promote_calls == []


@pytest.mark.anyio
async def test_worker_rejects_noncanary_row_before_any_object_read(
    tmp_path: Path,
) -> None:
    worker, store, objects, _pack_value = _setup(
        tmp_path,
        config=_config(users=frozenset({"another-canary"})),
    )

    result = await worker.run_once()

    assert result.failed == 1
    assert store.fail_calls[0]["error_stage"] == "row_identity"
    assert objects.reads == []


@pytest.mark.anyio
async def test_worker_rejects_noncurrent_instrument_before_any_object_read(
    tmp_path: Path,
) -> None:
    _worker, store, objects, _pack_value = _setup(tmp_path)
    current_instrument = _instrument(rubric_hash="9" * 64)
    worker = DeckQualityPublicationWorker(
        config=_config(),
        instrument=current_instrument,
        store=store,
        object_store=objects,
        lease_owner="publication-worker-1",
        materialization_root=tmp_path / "instrument-mismatch",
        claim_token_factory=lambda: "instrument-claim-token",
        clock=lambda: store.now,
    )

    result = await worker.run_once()

    assert result.failed == 1
    assert store.fail_calls[0]["error_stage"] == "row_identity"
    assert objects.reads == []


@pytest.mark.anyio
async def test_worker_rejects_source_hash_before_artifact_reference_read(
    tmp_path: Path,
) -> None:
    worker, store, objects, _pack_value = _setup(tmp_path)
    source_path = store.record.source_pack_object_path
    assert source_path is not None
    objects.objects[source_path] += b"\n"

    result = await worker.run_once()

    assert result.failed == 1
    assert store.fail_calls[0]["error_code"] is PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE
    assert store.fail_calls[0]["error_stage"] == "source_hash"
    assert objects.reads == [(source_path, 8 * 1024 * 1024)]


@pytest.mark.anyio
async def test_worker_retries_transient_source_read_without_following_artifact(
    tmp_path: Path,
) -> None:
    worker, store, objects, _pack_value = _setup(tmp_path)
    source_path = store.record.source_pack_object_path
    assert source_path is not None
    objects.fail_reads.add(source_path)

    result = await worker.run_once()

    assert result.retry_scheduled == 1
    assert store.retry_calls[0]["error_code"] is PublicationErrorCode.PERSISTENCE_ERROR
    assert store.retry_calls[0]["error_stage"] == "source_read"
    assert objects.reads == [(source_path, 8 * 1024 * 1024)]
    assert store.promote_calls == []


@pytest.mark.anyio
async def test_worker_fails_deterministic_artifact_hash_mismatch(
    tmp_path: Path,
) -> None:
    worker, store, objects, pack = _setup(tmp_path)
    objects.objects[pack.artifact_storage_object_path] = b"different artifact"

    result = await worker.run_once()

    assert result.failed == 1
    assert store.fail_calls[0]["error_code"] is PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED
    assert store.fail_calls[0]["error_stage"] == "artifact_verify"
    assert len(objects.reads) == 2
    assert store.promote_calls == []


@pytest.mark.anyio
async def test_claim_and_promotion_response_loss_reconcile_without_duplicate_attempt(
    tmp_path: Path,
) -> None:
    worker, store, _objects, _pack_value = _setup(tmp_path)
    store.lose_claim_response_once = True
    store.lose_promote_response_once = True

    result = await worker.run_once()

    assert result.published == 1
    assert len(store.claim_calls) == 2
    assert store.claim_calls[0] == store.claim_calls[1]
    assert store.record.attempt_count == 1
    assert len(store.promote_calls) == 1
    assert store.get_calls == 1


@pytest.mark.anyio
async def test_worker_lifecycle_and_configuration_helpers(tmp_path: Path) -> None:
    worker, store, objects, _pack_value = _setup(tmp_path)
    app = SimpleNamespace(state=SimpleNamespace())

    install_deck_quality_publication_worker(app, worker)
    assert get_deck_quality_publication_worker(app) is worker
    assert get_deck_quality_publication_worker_or_none(app) is worker
    await worker.probe()
    assert store.probe_calls == 1

    # Make the row terminal so the background lifecycle only polls an empty
    # bounded claim and cannot perform another materialization.
    store.record = _validated_update(
        store.record,
        state=PublicationState.FAILED,
        last_error_code=PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
        last_error_stage="test_terminal",
        last_error_at=store.now,
        finished_at=store.now,
    )
    await start_deck_quality_publication_worker(worker)
    assert worker.running
    await stop_deck_quality_publication_worker(worker)
    assert not worker.running
    assert store.probe_calls == 2
    assert store.close_calls == 1

    disabled = DeckQualityConfig()
    assert build_configured_deck_quality_publication_worker(
        config=disabled,
        instrument=_instrument(),
        store=store,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
    ) is None
    with pytest.raises(ValueError, match="instrument"):
        DeckQualityPublicationWorker(
            config=_config(),
            instrument=_instrument(evidence_preprocessor_version="different-preprocessor"),
            store=store,
            object_store=objects,
        )
    with pytest.raises(ValueError, match="claim limit"):
        DeckQualityPublicationWorker(
            config=_config(),
            instrument=_instrument(),
            store=store,
            object_store=objects,
            claim_limit=3,
        )
