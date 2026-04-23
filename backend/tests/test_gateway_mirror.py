"""Tests for the Gateway artifact mirror client."""

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from deerflow.sophia.storage import gateway_mirror


class TestLoadConfig:
    def test_returns_none_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_mirror._load_config() is None

    def test_returns_none_when_url_empty(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        assert gateway_mirror._load_config() is None

    def test_returns_config_when_both_set(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "my-secret")
        cfg = gateway_mirror._load_config()
        assert cfg is not None
        assert cfg.base_url == "http://gateway:8001"
        assert cfg.secret == "my-secret"

    def test_strips_trailing_slash_from_url(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001/")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        cfg = gateway_mirror._load_config()
        assert cfg.base_url == "http://gateway:8001"


class TestIsConfigured:
    def test_false_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_mirror.is_configured() is False

    def test_true_when_env_present(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        assert gateway_mirror.is_configured() is True


class TestMirrorArtifact:
    def test_returns_false_when_not_configured(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/outputs/x.pdf", b"hi") is False

    def test_returns_false_when_path_not_under_outputs(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        assert gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/uploads/x.pdf", b"hi") is False

    def test_returns_false_on_http_error(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "boom"
        mock_client.post.return_value = mock_response
        assert gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/outputs/x.pdf", b"hi", client=mock_client) is False

    def test_returns_true_on_204(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MagicMock()
        mock_response.status_code = 204
        mock_client.post.return_value = mock_response
        assert gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/outputs/x.pdf", b"hi", client=mock_client) is True
        url = mock_client.post.call_args[0][0]
        assert url == "http://gateway:8001/internal/artifacts/t-1/x.pdf"
        headers = mock_client.post.call_args[1]["headers"]
        assert headers["Authorization"] == "Bearer secret"
        assert headers["Content-Type"] == "application/octet-stream"
        assert headers["X-Content-SHA256"] is not None

    def test_returns_false_on_transport_exception(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.side_effect = httpx.ConnectError("nope")
        assert gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/outputs/x.pdf", b"hi", client=mock_client) is False

    def test_encodes_path_with_spaces(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "secret")
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MagicMock()
        mock_response.status_code = 204
        mock_client.post.return_value = mock_response
        gateway_mirror.mirror_artifact("t-1", "/mnt/user-data/outputs/my file.pdf", b"hi", client=mock_client)
        url = mock_client.post.call_args[0][0]
        assert "my%20file.pdf" in url
