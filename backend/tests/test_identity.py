"""Tests for deerflow.sophia.identity — conditional identity file updater."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Stub heavy dependencies before importing the module under test
# ---------------------------------------------------------------------------
for _mod_name in (
    "cachetools",
    "mem0",
    "mem0.client",
    "anthropic",
    "langchain",
    "langchain.agents",
    "langchain.agents.middleware",
    "langgraph",
    "langgraph.runtime",
):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)

# Provide a minimal TTLCache so mem0_client can import
_cachetools_mod = sys.modules["cachetools"]
if not hasattr(_cachetools_mod, "TTLCache"):
    _cachetools_mod.TTLCache = lambda maxsize, ttl: {}  # type: ignore[attr-defined]

# Provide a default stub Anthropic class on the module
_anthropic_mod = sys.modules["anthropic"]
if not hasattr(_anthropic_mod, "Anthropic"):
    _anthropic_mod.Anthropic = MagicMock  # type: ignore[attr-defined]

from deerflow.sophia.identity import (  # noqa: E402
    _MARKER_FILENAME,
    _SESSION_UPDATE_INTERVAL,
    _atomic_write,
    _count_sessions,
    _extract_identity_content,
    _format_memories,
    _read_marker,
    maybe_update_identity,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def user_tree(tmp_path: Path, monkeypatch):
    """Set up a temporary user directory tree and patch USERS_DIR."""
    users_dir = tmp_path / "users"
    users_dir.mkdir()
    monkeypatch.setattr("deerflow.sophia.identity.USERS_DIR", users_dir)
    monkeypatch.setattr("deerflow.agents.sophia_agent.paths.USERS_DIR", users_dir)

    # Also patch the prompts directory to a temp location with a real template
    prompts_dir = tmp_path / "prompts"
    prompts_dir.mkdir()
    template = (
        "Update identity.\n"
        "{current_identity}\n"
        "{recent_handoffs}\n"
        "{mem0_memories_by_category}\n"
        "{current_date}\n"
        "{sessions_since_update}\n"
        "{update_trigger}\n"
    )
    (prompts_dir / "identity_file_update.md").write_text(template, encoding="utf-8")
    monkeypatch.setattr("deerflow.sophia.identity._PROMPTS_DIR", prompts_dir)

    return users_dir


def _create_trace_files(users_dir: Path, user_id: str, count: int):
    """Create *count* dummy trace JSON files."""
    traces_dir = users_dir / user_id / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)
    # Remove any existing files first so the count is exact
    for f in traces_dir.iterdir():
        f.unlink()
    for i in range(count):
        (traces_dir / f"session_{i}.json").write_text(
            json.dumps({"session_id": f"session_{i}"}),
            encoding="utf-8",
        )


def _make_anthropic_response(identity_text: str) -> MagicMock:
    """Build a mock Anthropic messages.create() return value."""
    block = MagicMock()
    block.text = f"---IDENTITY_FILE---\n{identity_text}\n---END_IDENTITY_FILE---"
    resp = MagicMock()
    resp.content = [block]
    return resp


def _mock_anthropic_client(response: MagicMock) -> MagicMock:
    """Create a mock Anthropic class whose instances return *response*."""
    mock_client_instance = MagicMock()
    mock_client_instance.messages.create.return_value = response
    mock_cls = MagicMock(return_value=mock_client_instance)
    return mock_cls


@pytest.fixture()
def patch_anthropic(monkeypatch):
    """Fixture that patches sys.modules['anthropic'].Anthropic and returns a setter.

    Usage in tests:
        def test_something(self, user_tree, patch_anthropic):
            patch_anthropic(_make_anthropic_response("content"))
            result = maybe_update_identity(...)
    """
    def _set_response(response: MagicMock):
        mock_cls = _mock_anthropic_client(response)
        monkeypatch.setattr(_anthropic_mod, "Anthropic", mock_cls)
        return mock_cls
    return _set_response


@pytest.fixture()
def patch_anthropic_error(monkeypatch):
    """Fixture that makes Anthropic() raise an exception."""
    def _set_error(exc: Exception | None = None):
        mock_cls = MagicMock(side_effect=exc or Exception("API down"))
        monkeypatch.setattr(_anthropic_mod, "Anthropic", mock_cls)
        return mock_cls
    return _set_error


# ---------------------------------------------------------------------------
# Test: _count_sessions
# ---------------------------------------------------------------------------

class TestCountSessions:
    def test_missing_dir(self, tmp_path: Path):
        assert _count_sessions(tmp_path / "nonexistent") == 0

    def test_empty_dir(self, tmp_path: Path):
        d = tmp_path / "traces"
        d.mkdir()
        assert _count_sessions(d) == 0

    def test_counts_only_json(self, tmp_path: Path):
        d = tmp_path / "traces"
        d.mkdir()
        (d / "a.json").write_text("{}")
        (d / "b.json").write_text("{}")
        (d / "c.txt").write_text("not counted")
        assert _count_sessions(d) == 2


# ---------------------------------------------------------------------------
# Test: _extract_identity_content
# ---------------------------------------------------------------------------

class TestExtractIdentityContent:
    def test_with_markers(self):
        text = "preamble\n---IDENTITY_FILE---\nHello\n---END_IDENTITY_FILE---\nend"
        assert _extract_identity_content(text) == "Hello"

    def test_no_markers_falls_back(self):
        assert _extract_identity_content("just plain text") == "just plain text"

    def test_open_marker_no_close(self):
        text = "---IDENTITY_FILE---\ncontent here"
        assert _extract_identity_content(text) == "content here"

    def test_empty_response(self):
        assert _extract_identity_content("") == ""


# ---------------------------------------------------------------------------
# Test: _format_memories
# ---------------------------------------------------------------------------

class TestFormatMemories:
    def test_empty_list(self):
        assert _format_memories([]) == "(No recent memories available)"

    def test_basic_format(self):
        mems = [
            {"category": "fact", "content": "User is an engineer", "importance": "structural"},
            {"category": "feeling", "memory": "Felt anxious"},
        ]
        result = _format_memories(mems)
        assert "[fact] User is an engineer (importance: structural)" in result
        assert "[feeling] Felt anxious" in result

    def test_metadata_nested(self):
        mems = [{"content": "test", "metadata": {"importance": "structural", "category": "decision"}}]
        result = _format_memories(mems)
        assert "[decision]" in result
        assert "(importance: structural)" in result


# ---------------------------------------------------------------------------
# Test: _atomic_write
# ---------------------------------------------------------------------------

class TestAtomicWrite:
    def test_creates_file(self, tmp_path: Path):
        target = tmp_path / "sub" / "file.md"
        _atomic_write(target, "hello")
        assert target.read_text(encoding="utf-8") == "hello"

    def test_overwrites_existing(self, tmp_path: Path):
        target = tmp_path / "file.md"
        target.write_text("old")
        _atomic_write(target, "new")
        assert target.read_text(encoding="utf-8") == "new"


# ---------------------------------------------------------------------------
# Test: maybe_update_identity — trigger logic
# ---------------------------------------------------------------------------

class TestTriggerLogic:
    """Verify that the correct conditions trigger (or skip) an update."""

    def test_10_sessions_triggers(self, user_tree: Path, patch_anthropic):
        user_id = "alice"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        patch_anthropic(_make_anthropic_response("## Profile\nAlice"))

        result = maybe_update_identity(user_id)

        assert result is True
        identity_path = user_tree / user_id / "identity.md"
        assert identity_path.exists()
        assert "Alice" in identity_path.read_text(encoding="utf-8")

    def test_5_sessions_no_structural_skips(self, user_tree: Path):
        user_id = "bob"
        _create_trace_files(user_tree, user_id, 5)

        result = maybe_update_identity(user_id)
        assert result is False
        assert not (user_tree / user_id / "identity.md").exists()

    def test_structural_memory_triggers(self, user_tree: Path, patch_anthropic):
        user_id = "carol"
        _create_trace_files(user_tree, user_id, 2)
        memories = [{"category": "fact", "content": "Carol is a doctor", "importance": "structural"}]
        patch_anthropic(_make_anthropic_response("## Profile\nCarol"))

        result = maybe_update_identity(user_id, extracted_memories=memories)

        assert result is True

    def test_structural_in_metadata_triggers(self, user_tree: Path, patch_anthropic):
        user_id = "dave"
        _create_trace_files(user_tree, user_id, 1)
        memories = [{"content": "Dave moved", "metadata": {"importance": "structural"}}]
        patch_anthropic(_make_anthropic_response("## Profile\nDave"))

        result = maybe_update_identity(user_id, extracted_memories=memories)

        assert result is True

    def test_force_always_updates(self, user_tree: Path, patch_anthropic):
        user_id = "eve"
        # No trace files, no structural memories — but force=True
        (user_tree / user_id).mkdir(parents=True, exist_ok=True)
        patch_anthropic(_make_anthropic_response("## Profile\nEve"))

        result = maybe_update_identity(user_id, force=True)

        assert result is True


# ---------------------------------------------------------------------------
# Test: maybe_update_identity — file I/O
# ---------------------------------------------------------------------------

class TestFileIO:
    def test_missing_identity_creates_from_scratch(self, user_tree: Path, patch_anthropic):
        user_id = "frank"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        patch_anthropic(_make_anthropic_response("## New Profile"))

        result = maybe_update_identity(user_id)

        assert result is True
        assert (user_tree / user_id / "identity.md").exists()

    def test_marker_updated_after_success(self, user_tree: Path, patch_anthropic):
        user_id = "grace"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        patch_anthropic(_make_anthropic_response("## Profile"))

        maybe_update_identity(user_id)

        marker_path = user_tree / user_id / _MARKER_FILENAME
        assert marker_path.exists()
        assert int(marker_path.read_text(encoding="utf-8").strip()) == _SESSION_UPDATE_INTERVAL

    def test_missing_traces_dir_zero_sessions(self, user_tree: Path):
        user_id = "hank"
        # Don't create any dirs — traces dir does not exist
        result = maybe_update_identity(user_id)
        assert result is False

    def test_second_run_respects_marker(self, user_tree: Path, patch_anthropic):
        """After an update at 10 sessions, adding 3 more should not trigger."""
        user_id = "iris"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        patch_anthropic(_make_anthropic_response("## V1"))

        assert maybe_update_identity(user_id) is True

        # Add 3 more sessions (total = 13)
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL + 3)

        # Should NOT trigger (only 3 since last update)
        result = maybe_update_identity(user_id)
        assert result is False


# ---------------------------------------------------------------------------
# Test: error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    def test_anthropic_failure_returns_false(self, user_tree: Path, patch_anthropic_error):
        user_id = "jake"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        patch_anthropic_error(Exception("API down"))

        result = maybe_update_identity(user_id)

        assert result is False
        # Identity file should not have been created
        assert not (user_tree / user_id / "identity.md").exists()

    def test_invalid_user_id_returns_false(self, user_tree: Path):
        result = maybe_update_identity("../../etc/passwd")
        assert result is False

    def test_empty_llm_response_returns_false(self, user_tree: Path, patch_anthropic):
        user_id = "kate"
        _create_trace_files(user_tree, user_id, _SESSION_UPDATE_INTERVAL)
        # Response with empty text
        block = MagicMock()
        block.text = ""
        resp = MagicMock()
        resp.content = [block]
        patch_anthropic(resp)

        result = maybe_update_identity(user_id)

        assert result is False


# ---------------------------------------------------------------------------
# Test: _read_marker edge cases
# ---------------------------------------------------------------------------

class TestReadMarker:
    def test_missing_marker_returns_zero(self, user_tree: Path):
        assert _read_marker("nobody") == 0

    def test_corrupt_marker_returns_zero(self, user_tree: Path):
        user_id = "lisa"
        marker_dir = user_tree / user_id
        marker_dir.mkdir(parents=True, exist_ok=True)
        (marker_dir / _MARKER_FILENAME).write_text("not_a_number")
        assert _read_marker(user_id) == 0

    def test_valid_marker(self, user_tree: Path):
        user_id = "mike"
        marker_dir = user_tree / user_id
        marker_dir.mkdir(parents=True, exist_ok=True)
        (marker_dir / _MARKER_FILENAME).write_text("15")
        assert _read_marker(user_id) == 15
