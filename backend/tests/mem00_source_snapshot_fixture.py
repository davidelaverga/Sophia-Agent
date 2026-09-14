"""Explicit synthetic epoch authority for focused worker tests, never autouse."""
from deerflow.sophia.memory_governance.source_snapshot import SourceSnapshot


def source_snapshot_fixture(session, messages, *, epoch):
    return SourceSnapshot.model_validate({
        "schema": "mem00.source-snapshot.v1", "snapshot_id": "mem00-source-snapshot-" + "a" * 32,
        "owner_id": session.user_id, "session_id": session.session_id, "thread_id": session.thread_id,
        "transcript_revision": session.message_revision, "memory_clear_epoch": epoch, "context_mode": session.context_mode,
        "status": {"open": "active", "paused": "resumable"}.get(session.status, session.status), "ended_at": session.ended_at,
        "sources": [{"message_id": m.message_id, "sequence": m.sequence, "source_version": m.memory_source_version,
            "acceptance_epoch": epoch, "accepted_version": m.memory_source_version if epoch else None, "eligibility": "eligible"}
            for m in sorted(messages, key=lambda row: (row.sequence, row.message_id)) if m.final is True
            and m.role in {"user", "assistant"} and m.content.strip(" ") != ""],
    }).model_dump(mode="json", by_alias=True)
