"""Tests for ``BuilderArtifactMiddleware._build_ceiling_fallback`` — the
deliverable-recovery safety net used by both the hard-ceiling termination
path AND the consecutive-rejection short-circuit path.

Phase 4F (2026-05-16): the markdown deep-dive failure showed the previous
``_PROMOTE_EXTS`` list excluded ``.md`` and other plain-text deliverables,
so the fallback fell through to the apology branch even when a real
``.md`` was sitting in ``outputs/``. These tests lock the regression.
"""

from __future__ import annotations

import os
import time
import zipfile
from pathlib import Path

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)


def _state_with_outputs(outputs_dir: Path, *, started_ms: int | None = None) -> dict:
    """Build a minimal ``BuilderArtifactState`` pointing at a real outputs dir."""
    return {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_task_started_at_ms": started_ms,
    }


def _write_file(path: Path, content: str = "x", *, mtime_offset_s: float = 0.0) -> None:
    path.write_text(content)
    if mtime_offset_s:
        new_mtime = time.time() + mtime_offset_s
        os.utime(path, (new_mtime, new_mtime))


def _write_minimal_pptx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("_rels/.rels", "<Relationships></Relationships>")
        archive.writestr("ppt/presentation.xml", "<p:presentation></p:presentation>")
        archive.writestr("ppt/slides/slide1.xml", "<p:sld></p:sld>")
        archive.writestr("ppt/slideLayouts/slideLayout1.xml", "x" * 2048)


def test_ceiling_fallback_promotes_markdown(tmp_path: Path) -> None:
    """Phase 4F regression: a ``.md`` written during the run MUST be
    promoted by the ceiling fallback.

    Before this fix the ``_PROMOTE_EXTS`` list contained only binary
    deliverables, so a markdown deep dive would be ignored and the
    fallback fell through to the apology path (``artifact_path=None``,
    ``confidence=0.2``). Production failure on the Zep memory deep
    dive 2026-05-16; see plan §Phase 4F.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    md_path = outputs / "zep_memory_deep_dive.md"
    _write_file(md_path, "# Zep Memory Deep Dive\n\nLong-form content.")

    # ``builder_task_started_at_ms`` slightly in the past so the
    # mtime filter (>= start - 5s) keeps the just-written ``.md``.
    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=29, reason="consecutive_empty_emit_rejections=2"
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/zep_memory_deep_dive.md"
    assert fallback["artifact_type"] == "md"
    # Recovered confidence — NOT the 0.2 apology floor.
    assert fallback["confidence"] >= 0.4
    assert fallback["steps_completed"] == 29


def test_ceiling_fallback_prefers_binary_over_markdown(tmp_path: Path) -> None:
    """A ``.pdf`` written more recently than a ``.md`` MUST win.

    The mtime sort takes precedence — newer wins regardless of extension
    priority order. This locks the ordering contract: extension priority
    is a tiebreaker, not the primary sort key, but for files at the
    same mtime the binary extension lists first.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    md = outputs / "report.md"
    pdf = outputs / "report.pdf"
    # Write markdown FIRST (older mtime), then PDF (newer).
    _write_file(md, "older")
    time.sleep(0.05)
    _write_file(pdf, b"%PDF-1.4 fake".decode("latin-1"))

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=10, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/report.pdf"
    assert fallback["artifact_type"] == "pdf"


def test_ceiling_fallback_promotes_json_too(tmp_path: Path) -> None:
    """Phase 4F: ``.json`` deliverables (data reports, specs) are also recovered."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    json_path = outputs / "spec.json"
    _write_file(json_path, '{"k": "v"}')

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=5, reason="hard_ceiling"
    )
    assert fallback["artifact_path"] == "/mnt/user-data/outputs/spec.json"
    assert fallback["artifact_type"] == "json"


def test_ceiling_fallback_apology_when_no_deliverables(tmp_path: Path) -> None:
    """When outputs/ has nothing promotable (no binary, no text, no generator),
    the fallback returns the apology shape — confidence=0.2, artifact_path=None.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    # Only a hidden / non-promotable file (starts with underscore-non-generator).
    _write_file(outputs / "_scratch.tmp", "ignore me")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=20, reason="hard_ceiling"
    )
    assert fallback["artifact_path"] is None
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_pptx_promotes_valid_powerpoint(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_minimal_pptx(outputs / "deck.pptx")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
    state["builder_pptx_diagnostics"] = {
        "pptx_generator_attempt_count": 1,
        "pptx_generator_success_count": 0,
        "pptx_generator_error_class": "pptx_generation_error",
    }

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] == "/mnt/user-data/outputs/deck.pptx"
    assert fallback["artifact_type"] == "pptx"


def test_ceiling_fallback_pptx_rejects_native_scratch_base(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    scratch = outputs / ".builder" / "deck_native"
    scratch.mkdir(parents=True)
    _write_minimal_pptx(scratch / "base.pptx")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
    state["builder_pptx_diagnostics"] = {
        "pptx_generator_attempt_count": 1,
        "pptx_generator_success_count": 0,
        "pptx_generator_error_class": "deck_native_patch_failed",
    }

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] is None
    assert fallback["requested_artifact_ext"] == "pptx"
    assert fallback["fallback_reason"] == "hard_ceiling"
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_pptx_rejects_tiny_deck_and_refuses_markdown_swap(tmp_path: Path) -> None:
    """Format-swapped promotion is disabled: a pptx request never completes
    with a .md artifact — the build reports an honest failure instead."""
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"hello")
    _write_file(outputs / "deck.md", "# Slide outline\n\nA real degraded fallback.")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
    state["builder_pptx_diagnostics"] = {
        "pptx_generator_attempt_count": 1,
        "pptx_generator_success_count": 0,
        "pptx_generator_error_class": "pptx_generation_error",
    }

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] is None
    assert fallback["requested_artifact_ext"] == "pptx"
    assert fallback["fallback_reason"] == "pptx_generation_not_completed"
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_pptx_refuses_html_swap_with_failure_metadata(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_file(
        outputs / "deck.html",
        "<!doctype html><html><head><title>Deck</title><style>body{font-family:sans-serif}</style></head>"
        "<body><section><h1>Research deck fallback</h1><p>Complete browser-viewable slide content.</p></section>"
        "<section><h2>Visual summary</h2><svg viewBox='0 0 120 60'><rect width='80' height='40'/></svg>"
        "<p>Charts and diagrams are represented inline.</p></section></body></html>",
    )

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
    state["delegation_context"] = {"task": "Build a slide deck with charts and diagrams"}
    state["builder_pptx_diagnostics"] = {
        "pptx_generator_attempt_count": 1,
        "pptx_generator_success_count": 0,
        "pptx_generator_error_class": "pptx_generation_error",
    }

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    # Format-swapped promotion is disabled: an HTML file is never delivered
    # as the completion artifact for a pptx request.
    assert fallback["artifact_path"] is None
    assert fallback["requested_artifact_ext"] == "pptx"
    assert fallback["fallback_reason"] == "pptx_generation_not_completed"
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_pptx_rejects_code_fenced_html_fallback(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_file(
        outputs / "deck.html",
        "```html\n<!doctype html><html><head><title>Deck</title></head><body><h1>Deck</h1></body></html>\n```",
    )

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
    state["delegation_context"] = {"task": "Build a slide deck with charts and diagrams"}

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] is None
    assert fallback["artifact_type"] == "presentation"
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_pptx_refuses_generator_script(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_file(outputs / "_generate_deck.py", "print('deck')")

    started_ms = int((time.time() - 10) * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)
    state["builder_artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=12, reason="hard_ceiling"
    )

    assert fallback["artifact_path"] is None
    assert fallback["artifact_type"] == "presentation"
    assert fallback["confidence"] == 0.2


def test_ceiling_fallback_mtime_filter_excludes_stale_md(tmp_path: Path) -> None:
    """A ``.md`` written BEFORE the builder task started must not be promoted —
    it would surface a stale file from a previous run.
    """
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    stale = outputs / "old_report.md"
    _write_file(stale, "old run")
    # Backdate the file to well before our "task start".
    os.utime(stale, (time.time() - 3600, time.time() - 3600))

    # Builder task started "now".
    started_ms = int(time.time() * 1000)
    state = _state_with_outputs(outputs, started_ms=started_ms)

    fallback = BuilderArtifactMiddleware._build_ceiling_fallback(
        state, steps_completed=8, reason="hard_ceiling"
    )
    # Stale file filtered out → apology fallback.
    assert fallback["artifact_path"] is None


# ---- Phase 4L: upload-before-webhook on the two ceiling-fallback sites
#
# Both ceiling-fallback call sites (consecutive-rejection short-circuit and
# hard-ceiling termination) used to fire the completion webhook WITHOUT
# uploading the promoted file to Supabase first. Result: signed-URL mint
# 404'd downstream, Telegram delivery degraded to plaintext. The new
# helper `_upload_fallback_and_fire` ensures upload happens before the
# webhook on both paths. These tests lock the contract.


def test_upload_fallback_and_fire_calls_upload_before_webhook(monkeypatch) -> None:
    """Primary unit lock for the new helper.

    Mocks both ``_upload_builder_outputs_to_supabase`` and
    ``fire_completion_webhook_from_artifact`` and asserts the upload is
    called FIRST, then the webhook. Records the call order so a future
    refactor that accidentally inverts the order fails loudly.
    """
    from types import SimpleNamespace

    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba_module

    call_order: list[str] = []

    def _stub_upload(*, thread_id, outputs_host_path, artifact_args):
        call_order.append("upload")
        # Sanity: helper should pass the parent thread_id from
        # delegation_context (not the builder thread).
        assert thread_id == "parent-thread-xyz"

    def _stub_fire(*, state, runtime, artifact, status):
        call_order.append("fire")
        assert status == "completed"
        assert artifact["artifact_path"] == "/mnt/user-data/outputs/recovered.md"

    monkeypatch.setattr(
        ba_module, "_upload_builder_outputs_to_supabase", _stub_upload
    )
    monkeypatch.setattr(
        ba_module, "fire_completion_webhook_from_artifact", _stub_fire
    )

    state: dict = {
        "thread_data": {"outputs_path": "/mnt/user-data/outputs"},
        "delegation_context": {"parent_thread_id": "parent-thread-xyz"},
    }
    runtime = SimpleNamespace(context={"thread_id": "builder-thread-abc"})
    fallback = {
        "artifact_path": "/mnt/user-data/outputs/recovered.md",
        "artifact_type": "document",
        "confidence": 0.4,
    }

    BuilderArtifactMiddleware._upload_fallback_and_fire(
        state=state, runtime=runtime, fallback=fallback, status="completed"
    )

    assert call_order == ["upload", "fire"], (
        f"upload must run BEFORE webhook fire; got order={call_order}"
    )


def test_upload_fallback_and_fire_falls_back_to_builder_thread_when_parent_missing(
    monkeypatch,
) -> None:
    """When ``delegation_context.parent_thread_id`` is absent (e.g. a
    Builder-as-Main run that never had a companion parent), the helper
    must fall back to ``runtime.context["thread_id"]``. This mirrors
    the resolution logic in the normal happy path."""
    from types import SimpleNamespace

    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba_module

    captured: dict = {}

    def _stub_upload(*, thread_id, outputs_host_path, artifact_args):
        captured["thread_id"] = thread_id

    monkeypatch.setattr(
        ba_module, "_upload_builder_outputs_to_supabase", _stub_upload
    )
    monkeypatch.setattr(
        ba_module, "fire_completion_webhook_from_artifact", lambda **kw: None
    )

    state: dict = {
        "thread_data": {"outputs_path": "/mnt/user-data/outputs"},
        # No delegation_context.
    }
    runtime = SimpleNamespace(context={"thread_id": "builder-only-thread"})
    fallback = {"artifact_path": "/mnt/user-data/outputs/x.md", "artifact_type": "document"}

    BuilderArtifactMiddleware._upload_fallback_and_fire(
        state=state, runtime=runtime, fallback=fallback, status="completed"
    )
    assert captured["thread_id"] == "builder-only-thread"


def test_upload_fallback_and_fire_safe_when_artifact_path_is_none(monkeypatch) -> None:
    """``_upload_builder_outputs_to_supabase`` is documented as safe to
    call with ``artifact_args["artifact_path"]=None``; this test locks
    that the new helper doesn't add defensive logic that would break
    that contract (e.g., raising on missing path)."""
    from types import SimpleNamespace

    from deerflow.agents.sophia_agent.middlewares import builder_artifact as ba_module

    monkeypatch.setattr(
        ba_module, "_upload_builder_outputs_to_supabase", lambda **kw: None
    )
    monkeypatch.setattr(
        ba_module, "fire_completion_webhook_from_artifact", lambda **kw: None
    )

    state: dict = {
        "thread_data": {"outputs_path": "/mnt/user-data/outputs"},
        "delegation_context": {"parent_thread_id": "p-1"},
    }
    runtime = SimpleNamespace(context={"thread_id": "b-1"})
    fallback = {"artifact_path": None, "artifact_type": "unknown", "confidence": 0.2}

    # Must not raise.
    BuilderArtifactMiddleware._upload_fallback_and_fire(
        state=state, runtime=runtime, fallback=fallback, status="completed"
    )
