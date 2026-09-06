"""Exact owner/session containment for local recap derivatives."""

from pathlib import Path

from deerflow.agents.sophia_agent.utils import validate_user_id


def recap_path(base_dir: Path, user_id: str, session_id: str) -> Path:
    validate_user_id(user_id)
    validate_user_id(session_id)
    if user_id == "." or session_id == ".":
        raise ValueError("Invalid recap scope")
    base = base_dir.resolve()
    owner = base / user_id
    directory = owner / "recaps"
    target = directory / f"{session_id}.json"
    if any(path.is_symlink() for path in (owner, directory, target)) or target.resolve().parent != directory:
        raise ValueError("Invalid recap scope")
    return target


def source_revision(record, user_id: str, session_id: str) -> tuple | None:
    if record is None or record.user_id != user_id or record.session_id != session_id:
        return None
    if record.metadata.get("synthetic_voice_lab", {}).get("synthetic") is True:
        return None
    return (record.session_id, record.thread_id, record.message_revision)
