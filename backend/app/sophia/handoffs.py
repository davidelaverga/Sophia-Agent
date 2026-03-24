"""Handoff management — write/read users/{user_id}/handoffs/latest.md.

Always overwritten, never accumulated. Contains YAML frontmatter
with smart_opener and session summary.
"""

from __future__ import annotations

from pathlib import Path

HANDOFF_DIR = "users/{user_id}/handoffs"


def write_handoff(user_id: str, content: str) -> None:
    """Write handoff to users/{user_id}/handoffs/latest.md."""
    path = Path(HANDOFF_DIR.format(user_id=user_id))
    path.mkdir(parents=True, exist_ok=True)
    (path / "latest.md").write_text(content)


def load_handoff(user_id: str) -> str | None:
    """Load latest handoff if it exists."""
    path = Path(HANDOFF_DIR.format(user_id=user_id)) / "latest.md"
    if path.exists():
        return path.read_text()
    return None
