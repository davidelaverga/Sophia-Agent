from unittest.mock import MagicMock

import httpx
import pytest

from deerflow.sophia.storage import gateway_notify


class TestLoadConfig:
    def test_returns_none_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_notify._load_config() is None

    def test_returns_none_when_secret_empty(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "   ")
        assert gateway_notify._load_config() is None

    def test_returns_config_when_both_set(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "shh")
        cfg = gateway_notify._load_config()
        assert cfg is not None
        assert cfg.base_url == "http://gateway:8001"
        assert cfg.secret == "shh"

    def test_strips_trailing_slash(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gateway:8001///")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "shh")
        cfg = gateway_notify._load_config()
        assert cfg.base_url == "http://gateway:8001"


class TestIsConfigured:
    def test_false_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_notify.is_configured() is False

    def test_true_when_env_present(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        assert gateway_notify.is_configured() is True


class TestNotifyBuilderTaskStatus:
    def test_no_op_when_not_configured(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_GATEWAY_INTERNAL_URL", raising=False)
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        assert gateway_notify.notify_builder_task_status("abc", {"status": "completed"}) is False

    def test_no_op_when_task_id_blank(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        assert gateway_notify.notify_builder_task_status("", {"status": "completed"}) is False
        assert gateway_notify.notify_builder_task_status("   ", {"status": "completed"}) is False

    def test_posts_json_with_bearer(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw:8001")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s3cret")

        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 204
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = mock_resp

        payload = {"status": "completed", "builder_result": {"ok": True}}
        ok = gateway_notify.notify_builder_task_status("task-42", payload, client=mock_client)

        assert ok is True
        mock_client.post.assert_called_once()
        url, = mock_client.post.call_args.args
        kwargs = mock_client.post.call_args.kwargs
        assert url == "http://gw:8001/internal/builder_tasks/task-42"
        assert kwargs["json"] == payload
        assert kwargs["headers"]["Authorization"] == "Bearer s3cret"
        assert kwargs["headers"]["Content-Type"] == "application/json"

    def test_returns_false_on_non_204(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 401
        mock_resp.text = "bad token"
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = mock_resp
        ok = gateway_notify.notify_builder_task_status("t", {"status": "completed"}, client=mock_client)
        assert ok is False

    def test_returns_false_on_transport_exception(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.side_effect = httpx.ConnectError("nope")
        ok = gateway_notify.notify_builder_task_status("t", {"status": "completed"}, client=mock_client)
        assert ok is False

    def test_encodes_task_id(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_GATEWAY_INTERNAL_URL", "http://gw")
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 204
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = mock_resp

        gateway_notify.notify_builder_task_status("task id/with slash", {"status": "completed"}, client=mock_client)
        url = mock_client.post.call_args.args[0]
        # quote with safe='' encodes both spaces and slashes
        assert "task%20id%2Fwith%20slash" in url
