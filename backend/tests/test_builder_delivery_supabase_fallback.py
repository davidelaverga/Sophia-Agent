"""Tests for builder_delivery Supabase fallback path."""

from __future__ import annotations

import base64
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from deerflow.config.paths import Paths
from deerflow.sophia.tools.builder_delivery import (
    build_builder_delivery_payload,
    extract_builder_artifact_paths,
)


class TestExtractBuilderArtifactPaths:
    def test_extracts_primary_and_supporting(self):
        result = {
            "artifact_path": "/mnt/user-data/outputs/report.pdf",
            "supporting_files": [
                "/mnt/user-data/outputs/chart.png",
                "outputs/appendix.md",
            ],
        }
        paths = extract_builder_artifact_paths(result)
        assert paths == [
            "/mnt/user-data/outputs/report.pdf",
            "/mnt/user-data/outputs/chart.png",
            "/mnt/user-data/outputs/appendix.md",
        ]

    def test_deduplicates_and_maps_bare_filename(self):
        result = {
            "artifact_path": "/mnt/user-data/outputs/a.txt",
            "supporting_files": ["/mnt/user-data/outputs/a.txt", "sub/b.txt"],
        }
        paths = extract_builder_artifact_paths(result)
        # Deduplicates the primary path; bare filename "sub/b.txt" maps to
        # /mnt/user-data/outputs/b.txt (Path(...).name extracts the basename).
        assert paths == ["/mnt/user-data/outputs/a.txt", "/mnt/user-data/outputs/b.txt"]


class TestBuildBuilderDeliveryPayloadSupabaseFallback:
    def test_local_file_takes_precedence(self, monkeypatch, tmp_path):
        """When the artifact exists on local disk, it is used directly and
        Supabase is never consulted."""
        paths = Paths(str(tmp_path))
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths
        )

        thread_id = "thread-local"
        outputs_dir = paths.sandbox_outputs_dir(thread_id)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        artifact = outputs_dir / "report.txt"
        artifact.write_text("local content")

        builder_result = {"artifact_path": "/mnt/user-data/outputs/report.txt"}
        payload = build_builder_delivery_payload(
            thread_id=thread_id, builder_result=builder_result
        )

        assert payload is not None
        assert payload["source"] == "builder_result"
        assert len(payload["attachments"]) == 1
        att = payload["attachments"][0]
        assert att["virtual_path"] == "/mnt/user-data/outputs/report.txt"
        assert base64.b64decode(att["content_base64"]) == b"local content"

    def test_supabase_fallback_when_local_missing(self, monkeypatch, tmp_path):
        """When the artifact is missing locally but present in Supabase,
        the fallback succeeds and embeds the downloaded bytes."""
        paths = Paths(str(tmp_path))
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths
        )

        def _fake_download(thread_id: str, filename: str, **kwargs):
            assert thread_id == "thread-sb"
            assert filename == "report.txt"
            return (b"supabase bytes", "text/plain")

        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.download_artifact",
            _fake_download,
        )
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.is_configured",
            lambda: True,
        )

        builder_result = {"artifact_path": "/mnt/user-data/outputs/report.txt"}
        payload = build_builder_delivery_payload(
            thread_id="thread-sb", builder_result=builder_result
        )

        assert payload is not None
        att = payload["attachments"][0]
        assert att["filename"] == "report.txt"
        assert att["mime_type"] == "text/plain"
        assert base64.b64decode(att["content_base64"]) == b"supabase bytes"

    def test_supabase_not_consulted_when_unconfigured(self, monkeypatch, tmp_path):
        """When Supabase is not configured, the missing-local path returns None."""
        paths = Paths(str(tmp_path))
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths
        )
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.is_configured",
            lambda: False,
        )

        builder_result = {"artifact_path": "/mnt/user-data/outputs/missing.txt"}
        payload = build_builder_delivery_payload(
            thread_id="thread-nocfg", builder_result=builder_result
        )
        assert payload is None

    def test_supabase_fallback_skips_oversized_files(self, monkeypatch, tmp_path):
        """When the Supabase-downloaded file exceeds max_inline_bytes, it is
        skipped rather than embedded."""
        paths = Paths(str(tmp_path))
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths
        )

        large_content = b"x" * (16 * 1024 * 1024 + 1)

        def _fake_download(*args, **kwargs):
            return (large_content, "application/pdf")

        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.download_artifact",
            _fake_download,
        )
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.is_configured",
            lambda: True,
        )

        builder_result = {"artifact_path": "/mnt/user-data/outputs/huge.pdf"}
        payload = build_builder_delivery_payload(
            thread_id="thread-big", builder_result=builder_result, max_inline_bytes=15 * 1024 * 1024
        )
        assert payload is None

    def test_mixed_local_and_supabase_attachments(self, monkeypatch, tmp_path):
        """When one artifact is local and another is only in Supabase, both
        appear in the payload."""
        paths = Paths(str(tmp_path))
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths
        )

        thread_id = "thread-mixed"
        outputs_dir = paths.sandbox_outputs_dir(thread_id)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        (outputs_dir / "local.txt").write_text("local")

        def _fake_download(*args, **kwargs):
            return (b"remote", "text/markdown")

        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.download_artifact",
            _fake_download,
        )
        monkeypatch.setattr(
            "deerflow.sophia.tools.builder_delivery.supabase_artifact_store.is_configured",
            lambda: True,
        )

        builder_result = {
            "artifact_path": "/mnt/user-data/outputs/local.txt",
            "supporting_files": ["/mnt/user-data/outputs/remote.md"],
        }
        payload = build_builder_delivery_payload(
            thread_id=thread_id, builder_result=builder_result
        )

        assert payload is not None
        assert len(payload["attachments"]) == 2
        filenames = {a["filename"] for a in payload["attachments"]}
        assert filenames == {"local.txt", "remote.md"}

    def test_missing_thread_id_returns_none(self):
        assert build_builder_delivery_payload(
            thread_id=None, builder_result={"artifact_path": "/mnt/user-data/outputs/x.txt"}
        ) is None
