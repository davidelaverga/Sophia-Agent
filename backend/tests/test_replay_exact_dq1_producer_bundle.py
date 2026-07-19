from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import pytest

from deerflow.sophia.deck_quality.canonical import (
    canonical_json_bytes,
    canonical_sha256,
)
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.publisher import (
    DeckQualityProducerArbitrationRecord,
    DeckQualitySourceHashes,
    DeckQualitySourcePack,
    deck_quality_immutable_artifact_snapshot_path,
    deck_quality_producer_archive_path,
    deck_quality_producer_bundle_path,
    deck_quality_source_pack_path,
    encode_deck_quality_producer_bundle,
)
from deerflow.sophia.deck_quality.schemas import BlindBrief, QualityInstrumentLock
from scripts import replay_exact_dq1_producer_bundle as replay


class FakeStore:
    def __init__(
        self,
        objects: dict[str, bytes],
        *,
        raise_after_create: bool = False,
    ) -> None:
        self.objects = dict(objects)
        self.raise_after_create = raise_after_create
        self.read_calls: list[tuple[str, int]] = []
        self.create_calls: list[tuple[str, bytes, str]] = []

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        self.read_calls.append((object_path, max_bytes))
        content = self.objects.get(object_path)
        if content is not None and len(content) > max_bytes:
            raise ValueError("oversized")
        return content

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        self.create_calls.append((object_path, content, content_type))
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = content
        if self.raise_after_create:
            raise RuntimeError("response lost")
        return "created"


class ArchiveDuringCasStore(FakeStore):
    def __init__(
        self,
        objects: dict[str, bytes],
        *,
        archive_path: str,
        archive_bytes: bytes | None = None,
        remove_inbox: bool = True,
    ) -> None:
        super().__init__(objects)
        self.archive_path = archive_path
        self.archive_bytes = archive_bytes
        self.remove_inbox = remove_inbox

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        outcome = super().create_if_absent(
            object_path,
            content,
            content_type=content_type,
        )
        self.objects[self.archive_path] = self.archive_bytes or content
        if self.remove_inbox:
            self.objects.pop(object_path, None)
        return outcome


@dataclass(frozen=True)
class ExactPackFixture:
    pack: DeckQualitySourcePack
    source_path: str
    source_bytes: bytes
    artifact_path: str
    artifact_bytes: bytes
    identity: replay.SourcePackIdentity

    def store(self, *, raise_after_create: bool = False) -> FakeStore:
        return FakeStore(
            {
                self.source_path: self.source_bytes,
                self.artifact_path: self.artifact_bytes,
            },
            raise_after_create=raise_after_create,
        )


def _write_identity_file(
    root: Path,
    exact_pack: ExactPackFixture,
    *,
    mode: int = 0o600,
) -> Path:
    path = root / "dq1-replay-identity.json"
    path.write_bytes(canonical_json_bytes(exact_pack.identity))
    path.chmod(mode)
    return path


@pytest.fixture
def exact_pack() -> ExactPackFixture:
    instrument = QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash="a" * 64,
        prompt_hashes={
            "blind_visual": "b" * 64,
            "plan_realization": "c" * 64,
        },
        judge_plan_hash="d" * 64,
        judge_profile_version="deck-visual-judge-v1",
        evidence_preprocessor_version="deck-evidence-v2",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={
            "blind_visual": "deck-quality-blind-assessment/v4",
            "mechanical": "deck-quality-mechanical-projection/v1",
            "plan_realization": "deck-quality-plan-assessment/v4",
        },
        adjudication_policy_hash="e" * 64,
    )
    artifact_bytes = b"synthetic immutable presentation bytes"
    artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
    user_id = "canary-user"
    thread_id = "companion-thread"
    build_id = "build-01"
    artifact_version_id = "version-01"
    artifact_virtual_path = "/mnt/user-data/outputs/deck.pptx"
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact_version_id,
        campaign_id="DQ-1",
        instrument=instrument,
    )
    artifact_path = deck_quality_immutable_artifact_snapshot_path(
        user_id=user_id,
        thread_id=thread_id,
        build_id=build_id,
        logical_artifact_id="artifact-01",
        artifact_version_id=artifact_version_id,
        artifact_sha256=artifact_sha256,
        artifact_virtual_path=artifact_virtual_path,
    )
    creative_plan = {"concept": "synthetic concept"}
    design_plan = {"system": "synthetic system"}
    build_record = {"slides": 5}
    blind_brief = BlindBrief(
        request="Create a synthetic five-slide presentation.",
        subject="Synthetic subject",
        audience="Synthetic audience",
        goal="Synthetic goal",
    )
    mechanical_record = {"passed": True}
    pack = DeckQualitySourcePack(
        quality_run_id=quality_run_id,
        instrument=instrument,
        instrument_identity_hash=canonical_sha256(instrument),
        user_id=user_id,
        thread_id=thread_id,
        task_id="task-01",
        build_id=build_id,
        builder_run_id="builder-run-01",
        parent_builder_trace_id="trace-01",
        logical_artifact_id="artifact-01",
        artifact_version_id=artifact_version_id,
        manifest_revision=1,
        artifact_virtual_path=artifact_virtual_path,
        accepted_delivery_object_path=artifact_path,
        immutable_snapshot_object_path=artifact_path,
        artifact_sha256=artifact_sha256,
        creative_plan=creative_plan,
        design_plan=design_plan,
        build_record=build_record,
        blind_brief=blind_brief,
        mechanical_record=mechanical_record,
        source_hashes=DeckQualitySourceHashes(
            creative_plan=canonical_sha256(creative_plan),
            design_plan=canonical_sha256(design_plan),
            build_record=canonical_sha256(build_record),
            blind_brief=canonical_sha256(blind_brief),
            mechanical_record=canonical_sha256(mechanical_record),
        ),
    )
    source_path = deck_quality_source_pack_path(
        user_id=user_id,
        thread_id=thread_id,
        build_id=build_id,
        quality_run_id=quality_run_id,
    )
    return ExactPackFixture(
        pack=pack,
        source_path=source_path,
        source_bytes=canonical_json_bytes(pack),
        artifact_path=artifact_path,
        artifact_bytes=artifact_bytes,
        identity=replay.SourcePackIdentity(
            user_id=user_id,
            thread_id=thread_id,
            build_id=build_id,
            quality_run_id=quality_run_id,
            source_pack_sha256=hashlib.sha256(canonical_json_bytes(pack)).hexdigest(),
        ),
    )


def test_dry_run_reports_only_safe_hashes_sizes_and_quality_id(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()

    report = replay.execute_exact_pack_replay(
        store=store,
        explicit_path=exact_pack.source_path,
        dry_run=True,
    )

    assert set(report) == {
        "artifact_sha256",
        "artifact_size_bytes",
        "bundle_sha256",
        "bundle_size_bytes",
        "quality_run_id",
        "source_pack_sha256",
        "source_pack_size_bytes",
        "status",
    }
    assert report["status"] == "dry_run_ready_to_create"
    assert report["quality_run_id"] == exact_pack.pack.quality_run_id
    assert report["artifact_sha256"] == exact_pack.pack.artifact_sha256
    assert report["artifact_size_bytes"] == len(exact_pack.artifact_bytes)
    assert report["source_pack_sha256"] == hashlib.sha256(exact_pack.source_bytes).hexdigest()
    assert report["source_pack_size_bytes"] == len(exact_pack.source_bytes)
    assert store.create_calls == []
    assert store.objects == {
        exact_pack.source_path: exact_pack.source_bytes,
        exact_pack.artifact_path: exact_pack.artifact_bytes,
    }


def test_identity_derives_the_canonical_source_path(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=True,
    )

    assert report["status"] == "dry_run_ready_to_create"
    assert store.read_calls[0] == (
        exact_pack.source_path,
        replay.MAX_SOURCE_PACK_BYTES,
    )


def test_identity_source_pack_hash_mismatch_fails_before_pack_validation(
    exact_pack: ExactPackFixture,
) -> None:
    wrong_digest = exact_pack.identity.model_copy(update={"source_pack_sha256": "0" * 64})
    store = exact_pack.store()

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_pack_hash_mismatch$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            identity=wrong_digest,
            dry_run=True,
        )

    assert store.read_calls == [(exact_pack.source_path, replay.MAX_SOURCE_PACK_BYTES)]
    assert store.create_calls == []


def test_identity_mismatch_fails_before_artifact_read(
    exact_pack: ExactPackFixture,
) -> None:
    other_identity = exact_pack.identity.model_copy(update={"user_id": "different-canary-user"})
    other_source_path = replay.resolve_source_pack_path(
        explicit_path=None,
        identity=other_identity,
    )
    store = FakeStore({other_source_path: exact_pack.source_bytes})

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_pack_identity_mismatch$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            identity=other_identity,
            dry_run=True,
        )

    assert store.read_calls == [(other_source_path, replay.MAX_SOURCE_PACK_BYTES)]
    assert store.create_calls == []


def test_noncanonical_source_pack_bytes_are_rejected(
    exact_pack: ExactPackFixture,
) -> None:
    noncanonical = json.dumps(
        exact_pack.pack.model_dump(mode="json"),
        indent=2,
        sort_keys=True,
    ).encode()
    store = FakeStore({exact_pack.source_path: noncanonical})

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_pack_noncanonical$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            explicit_path=exact_pack.source_path,
            dry_run=True,
        )

    assert store.create_calls == []


def test_canonical_source_pack_with_changed_content_hash_is_rejected(
    exact_pack: ExactPackFixture,
) -> None:
    payload = exact_pack.pack.model_dump(mode="json")
    payload["creative_plan"] = {"concept": "content changed after hashing"}
    changed = canonical_json_bytes(payload)
    store = FakeStore({exact_pack.source_path: changed})

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_pack_invalid$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            explicit_path=exact_pack.source_path,
            dry_run=True,
        )

    assert store.create_calls == []


def test_explicit_path_must_match_the_identity_inside_the_pack(
    exact_pack: ExactPackFixture,
) -> None:
    wrong_path = "dq1/recovery/source-pack.json"
    store = FakeStore({wrong_path: exact_pack.source_bytes})

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_path_identity_mismatch$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            explicit_path=wrong_path,
            dry_run=True,
        )

    assert store.read_calls == [(wrong_path, replay.MAX_SOURCE_PACK_BYTES)]
    assert store.create_calls == []


def test_artifact_hash_mismatch_aborts_without_a_write(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    store.objects[exact_pack.artifact_path] = b"different artifact bytes"

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^artifact_hash_mismatch$",
    ):
        replay.execute_exact_pack_replay(
            store=store,
            explicit_path=exact_pack.source_path,
            dry_run=False,
        )

    assert store.create_calls == []


def test_commit_creates_only_canonical_inbox_and_reads_back_exact_bytes(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    original_objects = dict(store.objects)
    expected_bundle, _descriptor = encode_deck_quality_producer_bundle(
        pack=exact_pack.pack,
        source_pack_bytes=exact_pack.source_bytes,
    )
    inbox_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id)

    report = replay.execute_exact_pack_replay(
        store=store,
        explicit_path=exact_pack.source_path,
        dry_run=False,
    )

    assert report["status"] == "created"
    assert store.create_calls == [(inbox_path, expected_bundle, "application/json")]
    assert (inbox_path, replay.MAX_BUNDLE_BYTES) in store.read_calls
    assert store.read_calls[-1] == (
        deck_quality_producer_archive_path(exact_pack.pack.quality_run_id),
        replay.MAX_BUNDLE_BYTES,
    )
    assert store.objects == {**original_objects, inbox_path: expected_bundle}
    assert store.objects[exact_pack.source_path] == exact_pack.source_bytes
    assert store.objects[exact_pack.artifact_path] == exact_pack.artifact_bytes


def test_exact_archive_short_circuits_without_an_inbox_write(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    bundle, _descriptor = encode_deck_quality_producer_bundle(
        pack=exact_pack.pack,
        source_pack_bytes=exact_pack.source_bytes,
    )
    archive_path = deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store.objects[archive_path] = bundle

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=False,
    )

    assert report["status"] == "exact_archived"
    assert store.create_calls == []
    assert store.objects[archive_path] == bundle


@pytest.mark.parametrize(
    ("location", "expected_status"),
    (
        ("inbox", "dry_run_exact_existing"),
        ("archive", "dry_run_exact_archived"),
    ),
)
def test_dry_run_classifies_exact_existing_bundle_without_a_write(
    exact_pack: ExactPackFixture,
    location: str,
    expected_status: str,
) -> None:
    store = exact_pack.store()
    bundle, _descriptor = encode_deck_quality_producer_bundle(
        pack=exact_pack.pack,
        source_pack_bytes=exact_pack.source_bytes,
    )
    object_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id) if location == "inbox" else deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store.objects[object_path] = bundle

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=True,
    )

    assert report["status"] == expected_status
    assert store.create_calls == []


@pytest.mark.parametrize("conflict_location", ("inbox", "archive"))
def test_dry_run_rejects_conflicting_canonical_bundle_location(
    exact_pack: ExactPackFixture,
    conflict_location: str,
) -> None:
    store = exact_pack.store()
    object_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id) if conflict_location == "inbox" else deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store.objects[object_path] = canonical_json_bytes(
        DeckQualityProducerArbitrationRecord(
            candidate_digest="f" * 64,
            quality_run_id=exact_pack.pack.quality_run_id,
        )
    )

    with pytest.raises(replay.ExactPackReplayError, match="^bundle_conflict$"):
        replay.execute_exact_pack_replay(
            store=store,
            identity=exact_pack.identity,
            dry_run=True,
        )

    assert store.create_calls == []


def test_different_archive_conflicts_before_an_inbox_write(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    archive_path = deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store.objects[archive_path] = b"different archive bytes"

    with pytest.raises(replay.ExactPackReplayError, match="^bundle_conflict$"):
        replay.execute_exact_pack_replay(
            store=store,
            identity=exact_pack.identity,
            dry_run=False,
        )

    assert store.create_calls == []
    assert store.objects[archive_path] == b"different archive bytes"


def test_exact_archive_still_rejects_a_different_live_inbox(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    bundle, _descriptor = encode_deck_quality_producer_bundle(
        pack=exact_pack.pack,
        source_pack_bytes=exact_pack.source_bytes,
    )
    archive_path = deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    inbox_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id)
    store.objects[archive_path] = bundle
    store.objects[inbox_path] = b"different live bytes"

    with pytest.raises(replay.ExactPackReplayError, match="^bundle_conflict$"):
        replay.execute_exact_pack_replay(
            store=store,
            identity=exact_pack.identity,
            dry_run=False,
        )

    assert store.create_calls == []
    assert store.objects[archive_path] == bundle
    assert store.objects[inbox_path] == b"different live bytes"


def test_inbox_archive_race_reconciles_the_exact_archive(
    exact_pack: ExactPackFixture,
) -> None:
    archive_path = deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store = ArchiveDuringCasStore(
        {
            exact_pack.source_path: exact_pack.source_bytes,
            exact_pack.artifact_path: exact_pack.artifact_bytes,
        },
        archive_path=archive_path,
    )

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=False,
    )

    assert report["status"] == "archived_reconciled"
    assert len(store.create_calls) == 1
    assert store.objects[archive_path] == store.create_calls[0][1]
    assert deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id) not in store.objects


def test_conflicting_archive_created_during_cas_is_rejected(
    exact_pack: ExactPackFixture,
) -> None:
    archive_path = deck_quality_producer_archive_path(exact_pack.pack.quality_run_id)
    store = ArchiveDuringCasStore(
        {
            exact_pack.source_path: exact_pack.source_bytes,
            exact_pack.artifact_path: exact_pack.artifact_bytes,
        },
        archive_path=archive_path,
        archive_bytes=b"different racing archive bytes",
        remove_inbox=False,
    )

    with pytest.raises(replay.ExactPackReplayError, match="^bundle_conflict$"):
        replay.execute_exact_pack_replay(
            store=store,
            identity=exact_pack.identity,
            dry_run=False,
        )

    assert len(store.create_calls) == 1
    assert store.objects[archive_path] == b"different racing archive bytes"


def test_existing_exact_inbox_is_accepted_after_bounded_readback(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    inbox_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id)
    bundle, _descriptor = encode_deck_quality_producer_bundle(
        pack=exact_pack.pack,
        source_pack_bytes=exact_pack.source_bytes,
    )
    store.objects[inbox_path] = bundle

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=False,
    )

    assert report["status"] == "exact_existing"
    assert store.create_calls == [(inbox_path, bundle, "application/json")]
    assert (inbox_path, replay.MAX_BUNDLE_BYTES) in store.read_calls
    assert store.objects[inbox_path] == bundle


def test_existing_different_inbox_aborts_without_rewrite(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store()
    inbox_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id)
    conflicting_bytes = b"different immutable inbox bytes"
    store.objects[inbox_path] = conflicting_bytes

    with pytest.raises(replay.ExactPackReplayError, match="^bundle_conflict$"):
        replay.execute_exact_pack_replay(
            store=store,
            explicit_path=exact_pack.source_path,
            dry_run=False,
        )

    assert len(store.create_calls) == 1
    assert store.create_calls[0][0] == inbox_path
    assert store.objects[inbox_path] == conflicting_bytes


def test_ambiguous_create_response_succeeds_only_after_exact_readback(
    exact_pack: ExactPackFixture,
) -> None:
    store = exact_pack.store(raise_after_create=True)
    inbox_path = deck_quality_producer_bundle_path(exact_pack.pack.quality_run_id)

    report = replay.execute_exact_pack_replay(
        store=store,
        identity=exact_pack.identity,
        dry_run=False,
    )

    assert report["status"] == "ambiguous_reconciled"
    assert (inbox_path, replay.MAX_BUNDLE_BYTES) in store.read_calls
    assert store.objects[inbox_path] == store.create_calls[0][1]


@pytest.mark.parametrize(
    ("explicit_path", "identity"),
    (
        (None, None),
        ("dq1/source.json", "fixture_identity"),
    ),
)
def test_source_locator_must_be_exactly_one(
    exact_pack: ExactPackFixture,
    explicit_path: str | None,
    identity: str | None,
) -> None:
    supplied_identity = exact_pack.identity if identity is not None else None

    with pytest.raises(
        replay.ExactPackReplayError,
        match="^source_locator_ambiguous$",
    ):
        replay.resolve_source_pack_path(
            explicit_path=explicit_path,
            identity=supplied_identity,
        )


def test_cli_dry_run_emits_only_the_sanitized_report(
    exact_pack: ExactPackFixture,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    store = exact_pack.store()
    identity_path = _write_identity_file(tmp_path, exact_pack)
    monkeypatch.setattr(replay, "SupabaseImmutableObjectStore", lambda: store)
    try:
        result = replay.main(("--identity-file", str(identity_path), "--dry-run"))
    finally:
        logging.disable(logging.NOTSET)

    output = json.loads(capsys.readouterr().out)
    assert result == 0
    assert output["status"] == "dry_run_ready_to_create"
    assert set(output) == {
        "artifact_sha256",
        "artifact_size_bytes",
        "bundle_sha256",
        "bundle_size_bytes",
        "quality_run_id",
        "source_pack_sha256",
        "source_pack_size_bytes",
        "status",
    }
    assert exact_pack.source_path not in json.dumps(output)
    assert exact_pack.artifact_path not in json.dumps(output)
    assert store.create_calls == []


def test_cli_requires_an_explicit_non_mutating_or_commit_mode(
    exact_pack: ExactPackFixture,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = exact_pack.store()
    identity_path = _write_identity_file(tmp_path, exact_pack)
    monkeypatch.setattr(replay, "SupabaseImmutableObjectStore", lambda: store)

    with pytest.raises(SystemExit, match="^2$"):
        replay.main(("--identity-file", str(identity_path)))

    assert store.create_calls == []


def test_cli_failure_emits_only_a_sanitized_error(
    exact_pack: ExactPackFixture,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    store = FakeStore({})
    identity_path = _write_identity_file(tmp_path, exact_pack)
    monkeypatch.setattr(replay, "SupabaseImmutableObjectStore", lambda: store)
    try:
        result = replay.main(("--identity-file", str(identity_path), "--dry-run"))
    finally:
        logging.disable(logging.NOTSET)

    output = json.loads(capsys.readouterr().out)
    assert result == 2
    assert output == {"reason": "source_pack_unavailable", "status": "aborted"}
    assert exact_pack.source_path not in json.dumps(output)
    assert store.create_calls == []


def test_public_cli_rejects_a_direct_source_pack_path(
    exact_pack: ExactPackFixture,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    store = exact_pack.store()
    monkeypatch.setattr(replay, "SupabaseImmutableObjectStore", lambda: store)

    with pytest.raises(SystemExit, match="^2$"):
        replay.main(("--source-pack-path", exact_pack.source_path, "--dry-run"))

    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "reason": "arguments_invalid",
        "status": "aborted",
    }
    assert exact_pack.source_path not in captured.err
    assert store.read_calls == []
    assert store.create_calls == []


def test_cli_rejects_an_identity_file_visible_to_other_users(
    exact_pack: ExactPackFixture,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    store = exact_pack.store()
    identity_path = _write_identity_file(tmp_path, exact_pack, mode=0o644)
    monkeypatch.setattr(replay, "SupabaseImmutableObjectStore", lambda: store)
    try:
        result = replay.main(("--identity-file", str(identity_path), "--dry-run"))
    finally:
        logging.disable(logging.NOTSET)

    assert result == 2
    assert json.loads(capsys.readouterr().out) == {
        "reason": "identity_invalid",
        "status": "aborted",
    }
    assert store.read_calls == []
    assert store.create_calls == []
