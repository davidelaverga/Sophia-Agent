"""start_builder_task copies parent uploads + surfaces them in delegation_context.

Locks the cross-sandbox transfer: each LangGraph thread has its own
sandbox via ``ThreadDataMiddleware``, so the builder cannot read the
companion's filesystem directly. ``_copy_parent_uploaded_images`` copies
image files at dispatch and populates ``delegation_context.uploaded_image_paths``
so ``BuilderTaskMiddleware`` can name them in the builder briefing.

Documents are intentionally NOT copied — they're handled on the
companion side via ``read_user_document`` and the builder typically
generates its own text deliverables. This test pins the narrow scope so
a "let's copy everything" refactor would have to revisit the spec.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from deerflow.sophia.tools import start_builder_task as sbt


def test_copy_skips_when_parent_thread_id_missing() -> None:
    assert sbt._copy_parent_uploaded_images(parent_thread_id=None, builder_thread_id="b1") == []
    assert sbt._copy_parent_uploaded_images(parent_thread_id="", builder_thread_id="b1") == []


def test_copy_returns_empty_when_parent_uploads_dir_absent(tmp_path: Path, monkeypatch) -> None:
    """The parent thread exists but never received any uploads."""
    fake_paths = SimpleNamespace(
        sandbox_uploads_dir=lambda _tid: tmp_path / "missing-uploads",
    )
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: fake_paths)
    assert sbt._copy_parent_uploaded_images(parent_thread_id="p1", builder_thread_id="b1") == []


def test_copy_filters_to_image_extensions(tmp_path: Path, monkeypatch) -> None:
    """Images that upstream ``view_image_tool`` accepts are copied; other
    file types (documents, hidden files, and unsupported image formats
    like GIF) are NOT copied."""
    parent_uploads = tmp_path / "parent" / "uploads"
    parent_uploads.mkdir(parents=True)
    builder_uploads = tmp_path / "builder" / "uploads"

    # Mix of image and non-image files in the parent's uploads.
    (parent_uploads / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (parent_uploads / "scan.jpg").write_bytes(b"\xff\xd8\xff")
    (parent_uploads / "art.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
    # GIF must NOT be copied — upstream view_image_tool rejects it
    # (`.gif` isn't in valid_extensions), so surfacing the path in the
    # builder briefing would teach the model to make a
    # guaranteed-failing tool call. Codex P3 on PR #132.
    (parent_uploads / "loop.gif").write_bytes(b"GIF89a")
    (parent_uploads / "spec.pdf").write_bytes(b"%PDF-1.4")
    (parent_uploads / "notes.md").write_text("# notes")
    # Hidden files must be skipped (mirrors the macOS .DS_Store / dotfile
    # convention so we don't ship metadata into the builder sandbox).
    (parent_uploads / ".DS_Store").write_text("junk")

    def _resolve_dir(tid: str) -> Path:
        return parent_uploads if tid == "p1" else builder_uploads

    fake_paths = SimpleNamespace(sandbox_uploads_dir=_resolve_dir)
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: fake_paths)

    virtual_paths = sbt._copy_parent_uploaded_images(parent_thread_id="p1", builder_thread_id="b1")

    assert sorted(virtual_paths) == [
        "/mnt/user-data/uploads/art.webp",
        "/mnt/user-data/uploads/photo.png",
        "/mnt/user-data/uploads/scan.jpg",
    ]
    # Builder sandbox now holds the copies.
    assert (builder_uploads / "photo.png").is_file()
    assert (builder_uploads / "scan.jpg").is_file()
    assert (builder_uploads / "art.webp").is_file()
    # GIF, documents, and hidden files must NOT have been copied.
    assert not (builder_uploads / "loop.gif").exists(), (
        "GIF must not be copied — view_image_tool rejects it and the "
        "builder would loop on the unsupported-format error."
    )
    assert not (builder_uploads / "spec.pdf").exists()
    assert not (builder_uploads / "notes.md").exists()
    assert not (builder_uploads / ".DS_Store").exists()


def test_copy_extensions_subset_of_view_image_tool_accepted_set() -> None:
    """Lock invariant: every extension we copy must be one view_image_tool will read.

    Pulls the upstream-accepted set out of view_image_tool's source so a
    future upstream bump that drops an extension (or our future addition
    here without a matching upstream change) trips this guard. Codex P3
    motivated the assertion — keeping the two sets in lock-step prevents
    the "advertised path → guaranteed-failing tool call" trap.
    """
    import importlib
    import inspect

    vit_mod = importlib.import_module("deerflow.tools.builtins.view_image_tool")
    src = inspect.getsource(vit_mod)
    # Parse the literal set assigned to `valid_extensions` — the file
    # has exactly one such literal. Robust enough for the regression
    # guard; an upstream rewrite would simply require updating this
    # parser, which is a fine forcing function.
    import re

    match = re.search(r"valid_extensions\s*=\s*\{([^}]+)\}", src)
    assert match, "Could not locate `valid_extensions` literal in view_image_tool source"
    accepted = {
        ext.strip().strip('"').strip("'")
        for ext in match.group(1).split(",")
        if ext.strip()
    }
    unsupported = sbt._BUILDER_COPY_IMAGE_EXTENSIONS - accepted
    assert not unsupported, (
        f"_BUILDER_COPY_IMAGE_EXTENSIONS includes {sorted(unsupported)} which "
        f"view_image_tool does not accept (its valid_extensions = {sorted(accepted)}). "
        "Copying those across would make the builder briefing list paths "
        "that view_image_tool will refuse to read."
    )


def test_builder_task_middleware_injects_uploads_block_when_present(monkeypatch) -> None:
    """When delegation_context carries uploaded_image_paths, the builder
    briefing must surface them so the model knows to call view_image_tool."""
    from deerflow.agents.sophia_agent.middlewares import builder_task as bt_mod

    state = {
        "messages": [],
        "delegation_context": {
            "companion_artifact": {},
            "task_type": "research",
            "uploaded_image_paths": [
                "/mnt/user-data/uploads/diagram.png",
                "/mnt/user-data/uploads/screenshot.jpg",
            ],
        },
        "system_prompt_blocks": [],
    }

    mw = bt_mod.BuilderTaskMiddleware()
    update = mw.before_agent(state, runtime=None)
    assert update is not None
    briefing = update["system_prompt_blocks"][-1]
    assert "<uploaded_images>" in briefing
    assert "/mnt/user-data/uploads/diagram.png" in briefing
    assert "/mnt/user-data/uploads/screenshot.jpg" in briefing
    assert "view_image_tool" in briefing, (
        "The uploads block must explicitly name view_image_tool so the model "
        "knows which tool to call — otherwise the prompt lists paths without "
        "telling the builder how to consume them."
    )


def test_builder_task_middleware_omits_uploads_block_when_absent(monkeypatch) -> None:
    """No uploaded_image_paths key → no uploads block (keeps prompt lean)."""
    from deerflow.agents.sophia_agent.middlewares import builder_task as bt_mod

    state = {
        "messages": [],
        "delegation_context": {
            "companion_artifact": {},
            "task_type": "document",
        },
        "system_prompt_blocks": [],
    }

    mw = bt_mod.BuilderTaskMiddleware()
    update = mw.before_agent(state, runtime=None)
    assert update is not None
    briefing = "\n".join(update["system_prompt_blocks"])
    assert "<uploaded_images>" not in briefing
