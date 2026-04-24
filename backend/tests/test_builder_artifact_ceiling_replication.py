"""Tests for BuilderArtifactMiddleware ceiling-fallback replication."""

import os
import time
from unittest.mock import MagicMock, patch

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _replicate_builder_outputs,
)


class TestReplicateBuilderOutputs:
    def test_skips_when_thread_id_or_outputs_missing(self):
        diag = _replicate_builder_outputs(None, "/tmp/outputs", {"artifact_path": "/mnt/user-data/outputs/x.pdf"})
        assert diag["mirror"] == "skipped"
        assert diag["supabase"] == "skipped"

    def test_skips_when_path_not_under_outputs(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        diag = _replicate_builder_outputs("t-1", str(tmp_path), {"artifact_path": "/mnt/user-data/uploads/x.pdf"})
        assert diag["mirror"] == "skipped"
        assert diag["supabase"] == "skipped"

    def test_mirrors_and_uploads_when_files_exist(self, tmp_path, monkeypatch):
        outputs = tmp_path / "outputs"
        outputs.mkdir()
        (outputs / "report.pdf").write_bytes(b"pdf-data")

        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")

        with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.gateway_mirror.mirror_artifact", return_value=True) as mock_mirror:
            with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.supabase_artifact_store.is_configured", return_value=False):
                diag = _replicate_builder_outputs("t-1", str(outputs), {"artifact_path": "/mnt/user-data/outputs/report.pdf"})
        assert diag["mirror"] == "ok"
        assert diag["supabase"] == "skipped"
        mock_mirror.assert_called_once()
        args = mock_mirror.call_args.kwargs
        assert args["thread_id"] == "t-1"
        assert args["virtual_path"] == "/mnt/user-data/outputs/report.pdf"
        assert args["content"] == b"pdf-data"

    def test_records_failed_mirror(self, tmp_path, monkeypatch):
        outputs = tmp_path / "outputs"
        outputs.mkdir()
        (outputs / "report.pdf").write_bytes(b"pdf-data")

        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")

        with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.gateway_mirror.mirror_artifact", return_value=False) as mock_mirror:
            with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.supabase_artifact_store.is_configured", return_value=False):
                diag = _replicate_builder_outputs("t-1", str(outputs), {"artifact_path": "/mnt/user-data/outputs/report.pdf"})
        assert diag["mirror"] == "failed"

    def test_supabase_ok_when_configured(self, tmp_path, monkeypatch):
        outputs = tmp_path / "outputs"
        outputs.mkdir()
        (outputs / "report.pdf").write_bytes(b"pdf-data")

        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)

        with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.supabase_artifact_store.is_configured", return_value=True):
            with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.supabase_artifact_store.upload_artifact", return_value="report.pdf") as mock_up:
                diag = _replicate_builder_outputs("t-1", str(outputs), {"artifact_path": "/mnt/user-data/outputs/report.pdf"})
        assert diag["mirror"] == "skipped"
        assert diag["supabase"] == "ok"
        mock_up.assert_called_once()


class TestBuilderArtifactCeilingFallback:
    def test_ceiling_promotion_replicates_file(self, tmp_path, monkeypatch):
        """When the builder hits the hard ceiling and a file is promoted, the
        middleware should replicate it before returning the fallback result."""
        outputs = tmp_path / "outputs"
        outputs.mkdir()
        (outputs / "report.pdf").write_bytes(b"pdf-data")
        # Make it recent enough to pass the mtime filter
        now = time.time()
        os.utime(outputs / "report.pdf", (now, now))

        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")

        middleware = BuilderArtifactMiddleware()
        runtime = MagicMock()
        runtime.context = {"thread_id": "t-1"}

        msg = MagicMock()
        msg.type = "ai"
        msg.tool_calls = [{"name": "write_file", "args": {"path": "/mnt/user-data/outputs/report.pdf"}}]

        state = {
            "builder_result": None,
            "messages": [msg],
            "builder_non_artifact_turns": 20,
            "builder_task_started_at_ms": int((now - 10) * 1000),
            "thread_data": {"outputs_path": str(outputs)},
        }

        with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.gateway_mirror.mirror_artifact", return_value=True) as mock_mirror:
            with patch("deerflow.agents.sophia_agent.middlewares.builder_artifact.supabase_artifact_store.is_configured", return_value=False):
                result = middleware.after_model(state, runtime)

        assert result is not None
        assert result["jump_to"] == "end"
        fallback = result["builder_result"]
        assert fallback["artifact_path"] == "/mnt/user-data/outputs/report.pdf"
        assert fallback["replication"]["mirror"] == "ok"
        mock_mirror.assert_called_once()
