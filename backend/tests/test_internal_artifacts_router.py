"""Tests for the internal artifact replication router."""

import asyncio
import hashlib
import os
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.gateway.routers import internal_artifacts


@pytest.fixture
def secret_env(monkeypatch):
    monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "test-secret-42")


@pytest.fixture
def no_secret_env(monkeypatch):
    monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)


class TestRequireSecret:
    def test_raises_503_when_secret_not_set(self):
        req = type("R", (), {"headers": {}})()
        with pytest.raises(HTTPException) as exc:
            internal_artifacts._require_secret(req)
        assert exc.value.status_code == 503

    def test_raises_401_when_missing_bearer(self, secret_env):
        req = type("R", (), {"headers": {}})()
        with pytest.raises(HTTPException) as exc:
            internal_artifacts._require_secret(req)
        assert exc.value.status_code == 401

    def test_raises_401_when_wrong_secret(self, secret_env):
        req = type("R", (), {"headers": {"authorization": "Bearer wrong"}})()
        with pytest.raises(HTTPException) as exc:
            internal_artifacts._require_secret(req)
        assert exc.value.status_code == 401

    def test_succeeds_with_correct_secret(self, secret_env):
        req = type("R", (), {"headers": {"authorization": "Bearer test-secret-42"}})()
        # should not raise
        internal_artifacts._require_secret(req)


class TestConstantTimeCompare:
    def test_equal_strings(self):
        assert internal_artifacts._constant_time_compare("abc", "abc") is True

    def test_different_length(self):
        assert internal_artifacts._constant_time_compare("ab", "abc") is False

    def test_different_content(self):
        assert internal_artifacts._constant_time_compare("abc", "abd") is False


class TestReplicateArtifact:
    def test_returns_204_and_writes_file(self, tmp_path, monkeypatch, secret_env):
        monkeypatch.setattr(
            internal_artifacts,
            "_resolve_safe_path",
            lambda thread_id, path: tmp_path / path,
        )
        async def _body(self):
            return b"hello builder"

        req = type("MockRequest", (), {
            "body": _body,
            "headers": {"authorization": "Bearer test-secret-42"},
        })()
        resp = asyncio.run(internal_artifacts.replicate_artifact(req, "t-1", "report.md"))
        assert resp.status_code == 204
        assert (tmp_path / "report.md").read_bytes() == b"hello builder"

    def test_rejects_missing_secret(self, no_secret_env):
        from fastapi import Request
        req = Request({
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "query_string": b"",
        })
        with pytest.raises(HTTPException) as exc:
            asyncio.run(internal_artifacts.replicate_artifact(req, "t-1", "report.md"))
        assert exc.value.status_code == 503


class TestCheckArtifact:
    def test_returns_200_and_etag_when_file_exists(self, tmp_path, monkeypatch, secret_env):
        artifact = tmp_path / "report.md"
        artifact.write_bytes(b"hello")
        monkeypatch.setattr(
            internal_artifacts,
            "_resolve_safe_path",
            lambda thread_id, path: artifact,
        )
        req = type("MockRequest", (), {"headers": {"authorization": "Bearer test-secret-42"}})()
        resp = asyncio.run(internal_artifacts.check_artifact(req, "t-1", "report.md", x_content_sha256=None))
        assert resp.status_code == 200
        expected_etag = hashlib.sha256(b"hello").hexdigest()
        assert resp.headers["ETag"] == expected_etag

    def test_returns_404_when_file_missing(self, tmp_path, monkeypatch, secret_env):
        monkeypatch.setattr(
            internal_artifacts,
            "_resolve_safe_path",
            lambda thread_id, path: tmp_path / "missing.md",
        )
        req = type("MockRequest", (), {"headers": {"authorization": "Bearer test-secret-42"}})()
        with pytest.raises(HTTPException) as exc:
            asyncio.run(internal_artifacts.check_artifact(req, "t-1", "missing.md", x_content_sha256=None))
        assert exc.value.status_code == 404

    def test_returns_409_on_hash_mismatch(self, tmp_path, monkeypatch, secret_env):
        artifact = tmp_path / "report.md"
        artifact.write_bytes(b"hello")
        monkeypatch.setattr(
            internal_artifacts,
            "_resolve_safe_path",
            lambda thread_id, path: artifact,
        )
        req = type("MockRequest", (), {"headers": {"authorization": "Bearer test-secret-42"}})()
        resp = asyncio.run(
            internal_artifacts.check_artifact(
                req,
                "t-1",
                "report.md",
                x_content_sha256="0000000000000000000000000000000000000000000000000000000000000000",
            )
        )
        assert resp.status_code == 409
