"""Explicit synthetic dispatch authority for isolated SDK/worker unit tests."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from deerflow.sophia.memory_governance.extraction_dispatch import ExtractionDispatchAuthority
from deerflow.sophia.memory_governance.models import ExtractionRun


def dispatch_receipt(payload, *, session_id, thread_id):
    now = datetime.now(UTC)
    return {
        "schema": "mem00.extraction-dispatch.v1",
        "owner_id": payload["p_user_id"],
        "session_id": session_id,
        "thread_id": thread_id,
        "extraction_run_id": payload["p_extraction_run_id"],
        "lease_token": payload["p_lease_token"],
        "attempt_id": payload["p_attempt_id"],
        "event_id": str(uuid4()),
        "input_manifest_ref": payload["p_input_manifest_ref"],
        "extractor_input_ref": payload["p_extractor_input_ref"],
        "memory_clear_epoch": 0,
        "accepted_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=5)).isoformat(),
        "single_use": True,
        "sdk_max_retries": 0,
        "dispatch_observed": False,
    }


def dispatch_authority(owner, session, input_ref, *, store=None):
    run = ExtractionRun(
        extraction_run_id=uuid4(),
        user_id=owner,
        session_id=session,
        thread_id="synthetic-thread",
        transcript_revision=1,
        sequence_start=1,
        sequence_end=1,
        input_manifest_ref="hmac-sha256:transcript-manifest:" + "a" * 64,
        extractor_input_ref=input_ref,
        extractor_contract_version="mem00.extract.v1",
        state="leased",
        lease_token=uuid4(),
    )
    if store is None:
        store = SimpleNamespace(authorize_extraction_dispatch=lambda **payload: dispatch_receipt(payload, session_id=session, thread_id=run.thread_id))
    return ExtractionDispatchAuthority(run=run, store=store)
