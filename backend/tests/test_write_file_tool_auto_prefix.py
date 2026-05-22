"""Phase 2F.2: ``write_file_tool`` auto-prefixes bare filenames to
``/mnt/user-data/outputs/`` so the post-interrupt builder doesn't loop on
``Permission denied`` retries.

Production failure 2026-05-22 19:54-20:14 UTC: even after Phase 2E.1
reset the turn budget, the builder spent 20 minutes calling
``write_file_tool(path="test.md")`` and similar bare names — all
rejected by ``validate_local_tool_path`` because they don't start with
``/mnt/user-data/``. The model received error tool results but kept
retrying with similar bad paths. Eventually hit the 30-turn hard
ceiling and was coerced to phantom-success → error.

This module tests the ``_auto_prefix_bare_filename`` helper in
isolation. Integration with the rest of write_file_tool is covered by
the existing test_sandbox_tools.py mirror tests.
"""

from __future__ import annotations

from deerflow.sandbox.tools import _OUTPUTS_VIRTUAL_PREFIX, _auto_prefix_bare_filename

# ---- auto-prefix fires on bare filenames ---------------------------------


def test_auto_prefix_bare_markdown_filename():
    path, was_prefixed = _auto_prefix_bare_filename("recursive_llms_research.md")
    assert was_prefixed is True
    assert path == "/mnt/user-data/outputs/recursive_llms_research.md"
    assert path == _OUTPUTS_VIRTUAL_PREFIX + "recursive_llms_research.md"


def test_auto_prefix_bare_test_filename():
    """The specific failure mode observed in production: model writes
    to 'test.md' / 'test2.md' / 'report.md'. Auto-prefix elevates all
    of them to the outputs dir."""
    for bare in ("test.md", "test2.md", "report.md", "draft.md", "output.pdf"):
        path, was_prefixed = _auto_prefix_bare_filename(bare)
        assert was_prefixed is True, f"{bare} should have been prefixed"
        assert path == f"/mnt/user-data/outputs/{bare}"


def test_auto_prefix_bare_filename_with_special_chars():
    path, was_prefixed = _auto_prefix_bare_filename("recursive-llms_v2.md")
    assert was_prefixed is True
    assert path == "/mnt/user-data/outputs/recursive-llms_v2.md"


# ---- auto-prefix does NOT fire on explicit paths -------------------------


def test_no_prefix_on_absolute_outputs_path():
    """The canonical absolute path — model knows what it's doing, leave alone."""
    path, was_prefixed = _auto_prefix_bare_filename("/mnt/user-data/outputs/already.md")
    assert was_prefixed is False
    assert path == "/mnt/user-data/outputs/already.md"


def test_no_prefix_on_other_absolute_path():
    """Even paths outside /mnt/user-data are not elevated — let
    validate_local_tool_path reject them with a clear error.
    Elevating arbitrary absolute paths would mask real bugs."""
    path, was_prefixed = _auto_prefix_bare_filename("/etc/passwd")
    assert was_prefixed is False
    assert path == "/etc/passwd"


def test_no_prefix_on_relative_path_with_slash():
    """If the model intentionally used a directory component (even a
    relative one), respect that intent. Auto-prefix only catches the
    'bare filename' case."""
    path, was_prefixed = _auto_prefix_bare_filename("subdir/report.md")
    assert was_prefixed is False
    assert path == "subdir/report.md"


def test_no_prefix_on_windows_path():
    path, was_prefixed = _auto_prefix_bare_filename("subdir\\report.md")
    assert was_prefixed is False
    assert path == "subdir\\report.md"


def test_no_prefix_on_parent_directory_path():
    path, was_prefixed = _auto_prefix_bare_filename("../escape.md")
    assert was_prefixed is False
    assert path == "../escape.md"


# ---- defensive: malformed inputs -----------------------------------------


def test_no_prefix_on_empty_string():
    path, was_prefixed = _auto_prefix_bare_filename("")
    assert was_prefixed is False
    assert path == ""


def test_no_prefix_on_non_string():
    """None / int / dict / etc. — pass through unchanged so the caller's
    type validation surfaces a clear error rather than the auto-prefix
    masking the issue."""
    for bad in (None, 123, {"path": "x"}, ["foo.md"], 0.5):
        path, was_prefixed = _auto_prefix_bare_filename(bad)
        assert was_prefixed is False
        assert path == bad


# ---- the outputs prefix constant -----------------------------------------


def test_outputs_prefix_matches_virtual_path_convention():
    """Sanity: the prefix must match what BuilderArtifactMiddleware's
    _has_output_file scans for."""
    assert _OUTPUTS_VIRTUAL_PREFIX == "/mnt/user-data/outputs/"
    assert _OUTPUTS_VIRTUAL_PREFIX.endswith("/")
