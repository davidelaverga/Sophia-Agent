"""Plan one exact source target for the canonical transactional aligner.

The returned witnesses are not standalone authorization. The database checks
the complete observed run set, current parent and database-issued row versions
under the owner/parent serialization boundary before applying any effect.
"""

from __future__ import annotations

import hmac
import json

from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord

from .extraction_input import capture_context, context_is_current, extraction_input_ref
from .models import ExtractionRun, SourceDependency
from .refs import keyed_ref, request_digest
from .store import MemoryGovernanceUnavailable


def dependencies(messages: list[SessionMessageRecord]) -> tuple[SourceDependency, ...]:
    try:
        return tuple(SourceDependency(message_id=m.message_id, sequence=m.sequence, source_version=m.memory_source_version) for m in messages)
    except Exception:
        raise MemoryGovernanceUnavailable("memory_source_versions_unavailable") from None


def build_source_target(*, session: SessionRecord, messages: list[SessionMessageRecord], runs: tuple[ExtractionRun, ...], extractor_model: str, ended_at: str | None = None) -> dict[str, object]:
    return _build_source_target(session=session, messages=messages, runs=runs, extractor_model=extractor_model, ended_at=ended_at)


def build_source_target_at_epoch(*, session: SessionRecord, messages: list[SessionMessageRecord], runs: tuple[ExtractionRun, ...], extractor_model: str, snapshot, ended_at: str | None = None) -> dict[str, object]:
    from .source_snapshot import SourceSnapshot

    # Revalidate even an existing model instance: callers may have used
    # model_copy/model_construct, which intentionally skip Pydantic validation.
    try:
        snapshot = SourceSnapshot.model_validate(snapshot.model_dump(mode="json", by_alias=True))
    except Exception:
        raise MemoryGovernanceUnavailable("memory_source_snapshot_unavailable") from None
    snapshot.match_complete_source(session, messages)
    return _build_source_target(session=session, messages=messages, runs=runs, extractor_model=extractor_model, ended_at=ended_at, snapshot=snapshot)


def _build_source_target(*, session, messages, runs, extractor_model, ended_at=None, snapshot=None):
    from .extraction_service import _manifest_ref, _serialize

    if len(messages) > 10000 or len(runs) > 10000 or len({m.message_id for m in messages}) != len(messages) or len({m.sequence for m in messages}) != len(messages):
        raise MemoryGovernanceUnavailable("memory_source_target_unavailable")
    messages = sorted(messages, key=lambda m: (m.sequence, m.message_id))
    all_dependencies = dependencies(messages)
    version_by_id = {d.message_id: d for d in all_dependencies}
    eligible = {row.sequence for row in snapshot.sources if row.eligibility == "eligible"} if snapshot is not None else {m.sequence for m in messages}
    reserved: set[int] = set()
    reused = []
    observed = []
    for run in sorted(runs, key=lambda r: str(r.extraction_run_id)):
        if (run.user_id, run.session_id, run.thread_id) != (session.user_id, session.session_id, session.thread_id) or run.state == "superseded":
            raise MemoryGovernanceUnavailable("memory_source_run_scope_invalid")
        observed.append({"extraction_run_id": str(run.extraction_run_id), "state": run.state, "input_manifest_ref": run.input_manifest_ref})
        if snapshot is not None:
            if type(run.memory_clear_epoch) is not int or not 0 <= run.memory_clear_epoch <= snapshot.memory_clear_epoch:
                raise MemoryGovernanceUnavailable("memory_source_run_epoch_unproven")
            if run.memory_clear_epoch < snapshot.memory_clear_epoch:
                # Historical runs remain in the complete observed CAS set, but
                # cannot cover or block genuinely new current-epoch input.
                continue
        if run.extractor_input_context is None or run.extractor_input_ref is None or run.source_dependencies is None:
            # The old transcript HMAC cannot prove runtime date/context. Never
            # silently re-extract an unproven historical review decision.
            raise MemoryGovernanceUnavailable("memory_historical_input_unproven")
        selected = [m for m in messages if run.sequence_start <= m.sequence <= run.sequence_end]
        current = tuple(version_by_id[m.message_id] for m in selected)
        manifest = _manifest_ref(user_id=session.user_id, session_id=session.session_id, transcript_revision=run.transcript_revision, messages=selected)
        if (
            selected
            and all(m.sequence in eligible for m in selected)
            and run.extractor_contract_version == "mem00.extract.v1"
            and run.extractor_model == extractor_model
            and run.extractor_prompt_version == "mem0_extraction.md:v1"
            and hmac.compare_digest(manifest, run.input_manifest_ref)
            and run.source_dependencies == current
            and context_is_current(run.extractor_input_context, context_mode=session.context_mode)
            and hmac.compare_digest(run.extractor_input_ref, extraction_input_ref(owner_id=session.user_id, session_id=session.session_id, messages=_serialize(selected), context=run.extractor_input_context, model=extractor_model))
        ):
            reused.append(
                {
                    "extraction_run_id": str(run.extraction_run_id),
                    "input_manifest_ref": manifest,
                    "extractor_input_ref": run.extractor_input_ref,
                    "extractor_input_context": run.extractor_input_context.model_dump(mode="json", by_alias=True),
                    "dependencies": [d.model_dump(mode="json") for d in current],
                }
            )
            reserved.update(m.sequence for m in selected)
    uncovered = []
    for message in messages:
        if message.sequence in reserved or message.sequence not in eligible:
            if uncovered:
                break
        else:
            uncovered.append(message)
    next_range = None
    if uncovered:
        context = capture_context(context_mode=session.context_mode)
        next_range = {
            "sequence_start": uncovered[0].sequence,
            "sequence_end": uncovered[-1].sequence,
            "extractor_input_context": context.model_dump(mode="json", by_alias=True),
            "extractor_input_ref": extraction_input_ref(owner_id=session.user_id, session_id=session.session_id, messages=_serialize(uncovered), context=context, model=extractor_model),
            "input_manifest_ref": _manifest_ref(user_id=session.user_id, session_id=session.session_id, transcript_revision=session.message_revision, messages=uncovered),
        }
    payload = {
        "p_user_id": session.user_id,
        "p_session_id": session.session_id,
        "p_thread_id": session.thread_id,
        "p_transcript_revision": session.message_revision,
        "p_target_manifest_ref": _manifest_ref(user_id=session.user_id, session_id=session.session_id, transcript_revision=session.message_revision, messages=messages),
        "p_observed_runs": observed,
        "p_reused_runs": reused,
        "p_next_range": next_range,
        "p_extractor_contract_version": "mem00.extract.v1",
        "p_extractor_model": extractor_model,
        "p_extractor_prompt_version": "mem0_extraction.md:v1",
        "p_modality": session.mode or "text",
        "p_ended_at": ended_at,
    }
    if snapshot is not None:
        payload["p_expected_clear_epoch"] = snapshot.memory_clear_epoch
        payload["p_source_snapshot"] = snapshot.model_dump(mode="json", by_alias=True)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    # New receipt version captures the complete content-free source witness.
    # An unchanged historical target may be revalidated without re-extraction;
    # never mutate/relabel its old receipt as if it already carried this proof.
    payload["p_idempotency_key"] = keyed_ref("source-target-at-epoch-v1" if snapshot is not None else "source-target-v2", encoded)
    payload["p_request_digest"] = request_digest(encoded.encode())
    return payload
