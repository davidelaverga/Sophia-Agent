"""Behavior of the narrow companion tools view_user_image / read_user_document.

Covers spec acceptance #4 (file-type routing: images → vision, documents
→ text; vision NEVER receives a text PDF) plus filename validation,
whitelisted search dirs, and the read-only response shape.

Calls the underlying ``.func`` / ``.coroutine`` directly — the
``@tool``-decorated wrappers route through LangChain's tool executor
which requires a full ``ToolCall`` envelope. The internal callable is
the same code path the executor invokes, just with simpler test wiring.
"""

from __future__ import annotations

import base64
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage
from langgraph.types import Command


def _make_runtime(thread_id: str, thread_data: dict) -> SimpleNamespace:
    return SimpleNamespace(
        state={"thread_data": thread_data},
        context={"thread_id": thread_id},
        config={"configurable": {"thread_id": thread_id}},
        tool_call_id="tc-1",
    )


def _content(result: Command) -> str:
    msg = result.update["messages"][0]
    assert isinstance(msg, ToolMessage)
    return str(msg.content)


# ─── view_user_image ──────────────────────────────────────────────────────────


def test_view_user_image_rejects_paths(tmp_path: Path) -> None:
    from deerflow.sophia.tools.view_user_image import view_user_image

    runtime = _make_runtime("t1", {"uploads_path": str(tmp_path)})
    result = view_user_image.func(
        runtime=runtime,
        image_filename="../../etc/passwd",
        tool_call_id="tc-1",
    )
    assert "invalid filename" in _content(result).lower()


def test_view_user_image_rejects_non_image_extension(tmp_path: Path) -> None:
    from deerflow.sophia.tools.view_user_image import view_user_image

    runtime = _make_runtime("t1", {"uploads_path": str(tmp_path)})
    result = view_user_image.func(
        runtime=runtime,
        image_filename="report.pdf",
        tool_call_id="tc-1",
    )
    body = _content(result).lower()
    assert "unsupported image format" in body
    assert "read_user_document" in body, (
        "Error message must steer the user to read_user_document for non-image files "
        "— that's the §6 routing rule enforced at the tool boundary."
    )


def test_view_user_image_loads_png_from_uploads(tmp_path: Path, monkeypatch) -> None:
    """Happy path: a real PNG in uploads_path resolves to viewed_images."""
    from deerflow.sandbox import tools as sandbox_tools_mod

    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c63000100000005000100c92e1bd80000000049454e"
        "44ae426082"
    )
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "test.png").write_bytes(png_bytes)

    def _fake_replace(virtual: str, _td):
        if virtual.startswith("/mnt/user-data/uploads/"):
            return str(uploads / virtual.rsplit("/", 1)[-1])
        return str(tmp_path / "outputs" / virtual.rsplit("/", 1)[-1])

    monkeypatch.setattr(sandbox_tools_mod, "replace_virtual_path", _fake_replace)
    monkeypatch.setattr(sandbox_tools_mod, "get_thread_data", lambda _r: {"uploads_path": str(uploads)})

    from deerflow.sophia.tools.view_user_image import view_user_image

    runtime = _make_runtime("t1", {"uploads_path": str(uploads)})
    result = view_user_image.func(
        runtime=runtime,
        image_filename="test.png",
        tool_call_id="tc-1",
    )

    assert isinstance(result, Command)
    viewed = result.update["viewed_images"]
    key = "/mnt/user-data/uploads/test.png"
    assert key in viewed
    assert viewed[key]["mime_type"] == "image/png"
    # Decoded base64 must round-trip to the original PNG bytes.
    assert base64.b64decode(viewed[key]["base64"]) == png_bytes


def test_view_user_image_falls_through_to_outputs(tmp_path: Path, monkeypatch) -> None:
    """When the file isn't in uploads, search outputs (for artifact renders)."""
    from deerflow.sandbox import tools as sandbox_tools_mod

    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c63000100000005000100c92e1bd80000000049454e"
        "44ae426082"
    )
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "chart.png").write_bytes(png_bytes)

    def _fake_replace(virtual: str, _td):
        if "/uploads/" in virtual:
            return str(tmp_path / "missing-uploads" / virtual.rsplit("/", 1)[-1])
        if "/outputs/" in virtual:
            return str(outputs / virtual.rsplit("/", 1)[-1])
        return virtual

    monkeypatch.setattr(sandbox_tools_mod, "replace_virtual_path", _fake_replace)
    monkeypatch.setattr(sandbox_tools_mod, "get_thread_data", lambda _r: {})

    from deerflow.sophia.tools.view_user_image import view_user_image

    runtime = _make_runtime("t1", {})
    result = view_user_image.func(
        runtime=runtime,
        image_filename="chart.png",
        tool_call_id="tc-1",
    )

    viewed = result.update["viewed_images"]
    assert "/mnt/user-data/outputs/chart.png" in viewed


def test_view_user_image_rejects_oversized_image_before_base64(tmp_path: Path, monkeypatch) -> None:
    """Codex P2 on PR #132 — files above MAX_VIEWABLE_IMAGE_BYTES must
    be rejected before we read + base64-encode them, otherwise the
    next model turn fails with a provider 400 (request > 32 MB)
    instead of a clean tool-side error the model can relay."""
    from deerflow.sandbox import tools as sandbox_tools_mod
    from deerflow.sophia.tools import view_user_image as view_mod

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    big = uploads / "huge.png"
    # Write 1 byte past the cap. We don't need real PNG bytes for this
    # test — the size check fires before the base64 read.
    big.write_bytes(b"\x00" * (view_mod.MAX_VIEWABLE_IMAGE_BYTES + 1))

    monkeypatch.setattr(
        sandbox_tools_mod,
        "replace_virtual_path",
        lambda virtual, _td: str(uploads / virtual.rsplit("/", 1)[-1]),
    )
    monkeypatch.setattr(sandbox_tools_mod, "get_thread_data", lambda _r: {})

    runtime = _make_runtime("t1", {})
    result = view_mod.view_user_image.func(
        runtime=runtime,
        image_filename="huge.png",
        tool_call_id="tc-1",
    )

    assert isinstance(result, Command)
    # Codex P2 PR #132 (later iteration): every failure path now
    # actively CLEARS the per-session viewed_images registry by
    # returning ``viewed_images: {}`` (the merge reducer's "clear all"
    # sentinel — see ``merge_viewed_images`` in ``thread_state.py``).
    # The original concern — "don't inject the oversized image into
    # the next turn" — is still satisfied (we never base64-encoded
    # it), and we ALSO prevent the separate bug where a previously-
    # loaded image would persist into the next injection and mislead
    # Sophia. Defense in depth: ``SophiaViewImageMiddleware`` skips
    # injection entirely when ``viewed_images`` is empty.
    assert result.update.get("viewed_images") == {}, (
        "Oversized image must clear viewed_images via the empty-dict "
        "sentinel — otherwise a prior successful view persists into "
        "the next turn's injection. See _failure_update in "
        "view_user_image.py."
    )
    body = _content(result).lower()
    assert "above the" in body and "vision cap" in body
    assert "read_user_document" in body, (
        "Error message must steer the user toward read_user_document for "
        "text-extraction (no size cap) so they have a path forward when "
        "their image is actually a screenshot of a long document."
    )


def test_view_user_image_just_under_cap_passes(tmp_path: Path, monkeypatch) -> None:
    """Boundary check: a file exactly at the cap must still succeed."""
    from deerflow.sandbox import tools as sandbox_tools_mod
    from deerflow.sophia.tools import view_user_image as view_mod

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    # Use a fake-but-decodable PNG-extension file; the size check is what
    # we're exercising. base64 will just encode whatever bytes are present.
    edge = uploads / "edge.png"
    edge.write_bytes(b"\x00" * view_mod.MAX_VIEWABLE_IMAGE_BYTES)

    monkeypatch.setattr(
        sandbox_tools_mod,
        "replace_virtual_path",
        lambda virtual, _td: str(uploads / virtual.rsplit("/", 1)[-1]),
    )
    monkeypatch.setattr(sandbox_tools_mod, "get_thread_data", lambda _r: {})

    runtime = _make_runtime("t1", {})
    result = view_mod.view_user_image.func(
        runtime=runtime,
        image_filename="edge.png",
        tool_call_id="tc-1",
    )
    assert "viewed_images" in result.update, (
        "A file at exactly MAX_VIEWABLE_IMAGE_BYTES must pass — the "
        "comparison is strict greater-than, not greater-or-equal."
    )


def test_view_user_image_reports_not_found(tmp_path: Path, monkeypatch) -> None:
    from deerflow.sandbox import tools as sandbox_tools_mod

    def _fake_replace(virtual: str, _td):
        return str(tmp_path / "missing" / virtual.rsplit("/", 1)[-1])

    monkeypatch.setattr(sandbox_tools_mod, "replace_virtual_path", _fake_replace)
    monkeypatch.setattr(sandbox_tools_mod, "get_thread_data", lambda _r: {})

    from deerflow.sophia.tools.view_user_image import view_user_image

    runtime = _make_runtime("t1", {})
    result = view_user_image.func(
        runtime=runtime,
        image_filename="ghost.png",
        tool_call_id="tc-1",
    )
    assert "not found" in _content(result).lower()


# ─── read_user_document ──────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_read_user_document_returns_text_md(tmp_path: Path, monkeypatch) -> None:
    """The .md fast-path reads UTF-8 directly without invoking markitdown."""
    from deerflow.sophia.tools import read_user_document as rud_mod

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "notes.md").write_text("# Hello\n\nthis is a doc.", encoding="utf-8")

    fake_paths = SimpleNamespace(
        sandbox_uploads_dir=lambda _tid: uploads,
        sandbox_outputs_dir=lambda _tid: tmp_path / "outputs",
    )
    monkeypatch.setattr(rud_mod, "get_paths", lambda: fake_paths)

    runtime = _make_runtime("t1", {})
    result = await rud_mod.read_user_document.coroutine(
        runtime=runtime,
        document_filename="notes.md",
        tool_call_id="tc-1",
    )
    body = _content(result)
    assert "# Hello" in body
    assert "this is a doc." in body


@pytest.mark.anyio
async def test_read_user_document_routes_pdf_through_markitdown(tmp_path: Path, monkeypatch) -> None:
    """A .pdf must go through convert_file_to_markdown, NOT through vision.

    This is the spec §6 routing-rule test: text PDFs are NEVER routed to
    view_user_image. Asserting that the markitdown helper was invoked
    locks the rule at the tool boundary.
    """
    from deerflow.sophia.tools import read_user_document as rud_mod

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    fake_pdf = uploads / "doc.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 fake")

    called: dict = {}

    async def _fake_convert(path: Path):
        called["path"] = path
        md = uploads / "doc.md"
        md.write_text("# Converted PDF\n\nextracted text body.", encoding="utf-8")
        return md

    fake_paths = SimpleNamespace(
        sandbox_uploads_dir=lambda _tid: uploads,
        sandbox_outputs_dir=lambda _tid: tmp_path / "outputs",
    )
    monkeypatch.setattr(rud_mod, "get_paths", lambda: fake_paths)
    monkeypatch.setattr(rud_mod, "convert_file_to_markdown", _fake_convert)

    runtime = _make_runtime("t1", {})
    result = await rud_mod.read_user_document.coroutine(
        runtime=runtime,
        document_filename="doc.pdf",
        tool_call_id="tc-1",
    )

    assert called["path"] == fake_pdf, (
        "PDF must be passed to convert_file_to_markdown — the text-extraction "
        "path. Routing it to view_user_image instead would let the vision "
        "model hallucinate fine print (spec §6 routing rule violation)."
    )
    body = _content(result)
    assert "extracted text body" in body


@pytest.mark.anyio
async def test_read_user_document_rejects_unsupported_extension(tmp_path: Path, monkeypatch) -> None:
    from deerflow.sophia.tools import read_user_document as rud_mod

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "weird.zzz").write_text("?", encoding="utf-8")

    fake_paths = SimpleNamespace(
        sandbox_uploads_dir=lambda _tid: uploads,
        sandbox_outputs_dir=lambda _tid: tmp_path / "outputs",
    )
    monkeypatch.setattr(rud_mod, "get_paths", lambda: fake_paths)

    runtime = _make_runtime("t1", {})
    result = await rud_mod.read_user_document.coroutine(
        runtime=runtime,
        document_filename="weird.zzz",
        tool_call_id="tc-1",
    )
    body = _content(result).lower()
    assert "unsupported document format" in body
    assert "view_user_image" in body  # error steers user to the image path


@pytest.mark.anyio
async def test_read_user_document_rejects_paths(tmp_path: Path, monkeypatch) -> None:
    from deerflow.sophia.tools import read_user_document as rud_mod

    fake_paths = SimpleNamespace(
        sandbox_uploads_dir=lambda _tid: tmp_path,
        sandbox_outputs_dir=lambda _tid: tmp_path,
    )
    monkeypatch.setattr(rud_mod, "get_paths", lambda: fake_paths)

    runtime = _make_runtime("t1", {})
    result = await rud_mod.read_user_document.coroutine(
        runtime=runtime,
        document_filename="../etc/passwd",
        tool_call_id="tc-1",
    )
    assert "invalid filename" in _content(result).lower()
