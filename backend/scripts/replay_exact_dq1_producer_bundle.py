"""Fail-closed replay of an exact DQ-1 source pack into its producer inbox.

This recovery utility never reconstructs or rewrites the source pack, artifact,
or build manifest. It validates their existing immutable bytes and may create
only the canonical producer-inbox marker derived from those exact bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from deerflow.sophia.deck_quality.canonical import canonical_json_bytes
from deerflow.sophia.deck_quality.publisher import (
    DeckQualityProducerBundleDescriptor,
    DeckQualitySourcePack,
    deck_quality_producer_archive_path,
    deck_quality_producer_bundle_path,
    deck_quality_source_pack_path,
    encode_deck_quality_producer_bundle,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    ArtifactObjectSizeError,
    SupabaseImmutableObjectStore,
    normalize_object_path,
)

MAX_SOURCE_PACK_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
MAX_BUNDLE_BYTES = 64 * 1024
MAX_IDENTITY_FILE_BYTES = 16 * 1024


class ExactPackReplayError(RuntimeError):
    """A content-free recovery error safe to print."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class _SanitizedArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        self.exit(2, '{"reason":"arguments_invalid","status":"aborted"}\n')


class SourcePackIdentity(BaseModel):
    """Private identities sufficient to derive one canonical source path."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["dq1-exact-pack-replay-identity/v1"] = "dq1-exact-pack-replay-identity/v1"
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    source_pack_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ImmutableObjectStore(Protocol):
    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None: ...

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"]: ...


@dataclass(frozen=True, slots=True)
class PreparedExactPackReplay:
    pack: DeckQualitySourcePack
    source_pack_path: str
    source_pack_bytes: bytes
    source_pack_sha256: str
    artifact_size_bytes: int
    bundle_bytes: bytes
    bundle: DeckQualityProducerBundleDescriptor

    def report(self, *, status: str) -> dict[str, str | int]:
        """Return only explicitly safe hashes, sizes, status, and run ID."""

        return {
            "artifact_sha256": self.pack.artifact_sha256,
            "artifact_size_bytes": self.artifact_size_bytes,
            "bundle_sha256": self.bundle.sha256,
            "bundle_size_bytes": self.bundle.size_bytes,
            "quality_run_id": self.pack.quality_run_id,
            "source_pack_sha256": self.source_pack_sha256,
            "source_pack_size_bytes": len(self.source_pack_bytes),
            "status": status,
        }


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _reject_constant(_value: str) -> None:
    raise ValueError


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _read_identity(path: Path) -> SourcePackIdentity:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ValueError
            content = handle.read(MAX_IDENTITY_FILE_BYTES + 1)
        if not 0 < len(content) <= MAX_IDENTITY_FILE_BYTES:
            raise ValueError
        payload = json.loads(
            content.decode("utf-8"),
            parse_constant=_reject_constant,
            object_pairs_hook=_reject_duplicate_pairs,
        )
        return SourcePackIdentity.model_validate(payload)
    except (OSError, UnicodeError, ValueError, ValidationError):
        raise ExactPackReplayError("identity_invalid") from None


def resolve_source_pack_path(
    *,
    explicit_path: str | None,
    identity: SourcePackIdentity | None,
) -> str:
    """Resolve exactly one canonical source-pack path."""

    if (explicit_path is None) == (identity is None):
        raise ExactPackReplayError("source_locator_ambiguous")
    if identity is not None:
        try:
            return deck_quality_source_pack_path(
                user_id=identity.user_id,
                thread_id=identity.thread_id,
                build_id=identity.build_id,
                quality_run_id=identity.quality_run_id,
            )
        except ValueError:
            raise ExactPackReplayError("identity_invalid") from None
    assert explicit_path is not None
    try:
        normalized = normalize_object_path(explicit_path)
    except ValueError:
        raise ExactPackReplayError("source_path_invalid") from None
    if normalized != explicit_path:
        raise ExactPackReplayError("source_path_invalid")
    return normalized


def _read_required(
    store: ImmutableObjectStore,
    object_path: str,
    *,
    max_bytes: int,
    code: str,
) -> bytes:
    try:
        content = store.read_bounded(object_path, max_bytes=max_bytes)
    except Exception:
        raise ExactPackReplayError(code) from None
    if not isinstance(content, bytes) or not content or len(content) > max_bytes:
        raise ExactPackReplayError(code)
    return content


def _read_bundle_optional(
    store: ImmutableObjectStore,
    object_path: str,
) -> bytes | None:
    """Read one bounded bundle location, distinguishing absence from poison."""

    try:
        content = store.read_bounded(object_path, max_bytes=MAX_BUNDLE_BYTES)
    except ArtifactObjectSizeError:
        raise ExactPackReplayError("bundle_conflict") from None
    except Exception:
        raise ExactPackReplayError("bundle_reconciliation_failed") from None
    if content is None:
        return None
    if not isinstance(content, bytes) or not content or len(content) > MAX_BUNDLE_BYTES:
        raise ExactPackReplayError("bundle_conflict")
    return content


def _parse_exact_source_pack(content: bytes) -> DeckQualitySourcePack:
    try:
        # Reject duplicate keys and non-finite constants before model parsing.
        json.loads(
            content.decode("utf-8"),
            parse_constant=_reject_constant,
            object_pairs_hook=_reject_duplicate_pairs,
        )
        pack = DeckQualitySourcePack.model_validate_json(content)
    except (UnicodeError, ValueError, ValidationError):
        raise ExactPackReplayError("source_pack_invalid") from None
    if canonical_json_bytes(pack) != content:
        raise ExactPackReplayError("source_pack_noncanonical")
    return pack


def _require_identity(
    pack: DeckQualitySourcePack,
    identity: SourcePackIdentity | None,
) -> None:
    if identity is None:
        return
    if any(
        (
            pack.user_id != identity.user_id,
            pack.thread_id != identity.thread_id,
            pack.build_id != identity.build_id,
            pack.quality_run_id != identity.quality_run_id,
        )
    ):
        raise ExactPackReplayError("source_pack_identity_mismatch")


def prepare_exact_pack_replay(
    *,
    store: ImmutableObjectStore,
    explicit_path: str | None = None,
    identity: SourcePackIdentity | None = None,
) -> PreparedExactPackReplay:
    """Read and validate every immutable input without performing a write."""

    source_path = resolve_source_pack_path(
        explicit_path=explicit_path,
        identity=identity,
    )
    source_bytes = _read_required(
        store,
        source_path,
        max_bytes=MAX_SOURCE_PACK_BYTES,
        code="source_pack_unavailable",
    )
    source_sha256 = _sha256(source_bytes)
    if identity is not None and source_sha256 != identity.source_pack_sha256:
        raise ExactPackReplayError("source_pack_hash_mismatch")
    pack = _parse_exact_source_pack(source_bytes)
    _require_identity(pack, identity)
    expected_source_path = deck_quality_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    if source_path != expected_source_path:
        raise ExactPackReplayError("source_path_identity_mismatch")

    artifact = _read_required(
        store,
        pack.immutable_snapshot_object_path,
        max_bytes=MAX_ARTIFACT_BYTES,
        code="artifact_unavailable",
    )
    if _sha256(artifact) != pack.artifact_sha256:
        raise ExactPackReplayError("artifact_hash_mismatch")

    try:
        bundle_bytes, descriptor = encode_deck_quality_producer_bundle(
            pack=pack,
            source_pack_bytes=source_bytes,
        )
    except Exception:
        raise ExactPackReplayError("bundle_encoding_failed") from None
    expected_inbox = deck_quality_producer_bundle_path(pack.quality_run_id)
    if descriptor.object_path != expected_inbox or descriptor.sha256 != _sha256(bundle_bytes) or descriptor.size_bytes != len(bundle_bytes) or not 0 < len(bundle_bytes) <= MAX_BUNDLE_BYTES:
        raise ExactPackReplayError("bundle_encoding_failed")
    return PreparedExactPackReplay(
        pack=pack,
        source_pack_path=source_path,
        source_pack_bytes=source_bytes,
        source_pack_sha256=source_sha256,
        artifact_size_bytes=len(artifact),
        bundle_bytes=bundle_bytes,
        bundle=descriptor,
    )


def commit_exact_pack_replay(
    *,
    store: ImmutableObjectStore,
    prepared: PreparedExactPackReplay,
) -> dict[str, str | int]:
    """CAS-create only the canonical inbox marker and verify exact readback."""

    inbox_path = deck_quality_producer_bundle_path(prepared.pack.quality_run_id)
    archive_path = deck_quality_producer_archive_path(prepared.pack.quality_run_id)
    if prepared.bundle.object_path != inbox_path:
        raise ExactPackReplayError("bundle_path_invalid")

    # The gateway may already have acknowledged and archived the exact inbox
    # bytes. Terminal archive evidence wins without another create attempt,
    # while any contradictory live bytes remain a hard conflict.
    archived_before = _read_bundle_optional(store, archive_path)
    if archived_before is not None:
        if archived_before != prepared.bundle_bytes:
            raise ExactPackReplayError("bundle_conflict")
        inbox_before = _read_bundle_optional(store, inbox_path)
        if inbox_before is not None and inbox_before != prepared.bundle_bytes:
            raise ExactPackReplayError("bundle_conflict")
        return prepared.report(status="exact_archived")

    ambiguous = False
    try:
        outcome = store.create_if_absent(
            inbox_path,
            prepared.bundle_bytes,
            content_type="application/json",
        )
    except Exception:
        # A create-only request can commit before its response is lost. Exact
        # bounded readback is the only accepted ambiguity resolution.
        ambiguous = True
        outcome = None
    if not ambiguous and outcome not in {"created", "exists"}:
        raise ExactPackReplayError("bundle_persistence_failed")
    stored_inbox = _read_bundle_optional(store, inbox_path)
    if stored_inbox is not None and stored_inbox != prepared.bundle_bytes:
        raise ExactPackReplayError("bundle_conflict")
    archived_after = _read_bundle_optional(store, archive_path)
    if archived_after is not None and archived_after != prepared.bundle_bytes:
        raise ExactPackReplayError("bundle_conflict")
    if archived_after is not None:
        return prepared.report(status="archived_reconciled")
    if stored_inbox is None:
        raise ExactPackReplayError("bundle_persistence_failed")
    if ambiguous:
        status = "ambiguous_reconciled"
    elif outcome == "created":
        status = "created"
    else:
        status = "exact_existing"
    return prepared.report(status=status)


def preflight_exact_pack_replay(
    *,
    store: ImmutableObjectStore,
    prepared: PreparedExactPackReplay,
) -> dict[str, str | int]:
    """Classify the exact inbox/archive state without performing a write."""

    inbox_path = deck_quality_producer_bundle_path(prepared.pack.quality_run_id)
    archive_path = deck_quality_producer_archive_path(prepared.pack.quality_run_id)
    if prepared.bundle.object_path != inbox_path:
        raise ExactPackReplayError("bundle_path_invalid")

    archived = _read_bundle_optional(store, archive_path)
    if archived is not None and archived != prepared.bundle_bytes:
        raise ExactPackReplayError("bundle_conflict")
    inbox = _read_bundle_optional(store, inbox_path)
    if inbox is not None and inbox != prepared.bundle_bytes:
        raise ExactPackReplayError("bundle_conflict")
    if archived is not None:
        return prepared.report(status="dry_run_exact_archived")
    if inbox is not None:
        return prepared.report(status="dry_run_exact_existing")
    return prepared.report(status="dry_run_ready_to_create")


def execute_exact_pack_replay(
    *,
    store: ImmutableObjectStore,
    explicit_path: str | None = None,
    identity: SourcePackIdentity | None = None,
    dry_run: bool,
) -> dict[str, str | int]:
    prepared = prepare_exact_pack_replay(
        store=store,
        explicit_path=explicit_path,
        identity=identity,
    )
    if dry_run:
        return preflight_exact_pack_replay(store=store, prepared=prepared)
    return commit_exact_pack_replay(store=store, prepared=prepared)


def _parser() -> argparse.ArgumentParser:
    parser = _SanitizedArgumentParser(
        description="Replay an exact canonical DQ-1 source pack into its inbox.",
    )
    parser.add_argument("--identity-file", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--commit", action="store_true")
    return parser


def main(argv: tuple[str, ...] | None = None) -> int:
    args = _parser().parse_args(argv)
    # Imported storage helpers contain operational logs with private paths.
    # This CLI emits only the explicit sanitized JSON reports below.
    logging.disable(logging.CRITICAL)
    try:
        identity = _read_identity(args.identity_file) if args.identity_file is not None else None
        store = SupabaseImmutableObjectStore()
        report = execute_exact_pack_replay(
            store=store,
            identity=identity,
            dry_run=bool(args.dry_run),
        )
    except ExactPackReplayError as exc:
        print(
            json.dumps(
                {"reason": exc.code, "status": "aborted"},
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception:
        print('{"reason":"internal_error","status":"aborted"}')
        return 2
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(tuple(sys.argv[1:])))
