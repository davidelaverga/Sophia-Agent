from __future__ import annotations

import importlib
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import app.gateway.routers.sessions as sessions_router
from app.gateway.auth import require_authorized_user_scope
from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.config.sandbox_config import SandboxConfig
from deerflow.sophia.session_store import SessionStore


@pytest.fixture(autouse=True)
def _gateway_test_app_config():
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
        )
    )
    yield
    reset_app_config()


def test_gateway_app_mounts_sessions_and_bootstrap_routes(tmp_path, monkeypatch):
    from app.gateway.app import create_app

    monkeypatch.setattr(sessions_router, "_store", SessionStore(tmp_path / "users"))

    app = create_app()
    with TestClient(app) as client:
        active_response = client.get("/api/v1/sessions/active")
        opener_response = client.get("/api/v1/bootstrap/opener")

    assert active_response.status_code == 200
    assert active_response.json() == {"has_active_session": False, "session": None}

    assert opener_response.status_code == 200
    assert opener_response.json() == {
        "opener_text": "",
        "suggested_ritual": None,
        "emotional_context": None,
        "has_opener": False,
    }


def test_gateway_mounts_legacy_public_builder_completion_stream_for_compatibility():
    from app.gateway.app import create_app

    app = create_app()
    with TestClient(app) as client:
        response = client.get("/api/threads/thread-1/builder-events/last")

    assert response.status_code == 204


def test_gateway_exposes_no_public_deck_quality_route():
    from app.gateway.app import create_app

    app = create_app()
    with TestClient(app) as client:
        response = client.get("/api/deck-quality/runs/quality_" + "a" * 64)

    assert response.status_code == 404


def test_deck_quality_probe_failure_does_not_take_down_gateway() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
    from app.gateway.workers.deck_quality_dispatcher import (
        get_deck_quality_dispatcher_or_none,
    )

    class FailingDispatcher:
        def __init__(self) -> None:
            self.stopped = False

        async def probe(self) -> None:
            raise RuntimeError("safe synthetic probe failure")

        def start(self) -> None:
            raise AssertionError("failed probe must not start dispatcher")

        async def stop(self) -> None:
            self.stopped = True

    candidate = FailingDispatcher()
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
            deck_quality=DeckQualityConfig(
                enabled=True,
                mode="shadow",
                canary_user_ids={"canary-user"},
                max_quality_cost_usd=Decimal("0.60"),
            ),
        )
    )
    with (
        patch.object(
            gateway_app,
            "compile_runtime_instrument",
            return_value=SimpleNamespace(lock=object()),
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
            return_value=candidate,
        ),
    ):
        app = gateway_app.create_app()
        with TestClient(app) as client:
            response = client.get("/health")
            assert get_deck_quality_dispatcher_or_none(app) is None

    assert response.status_code == 200
    assert candidate.stopped is True


def test_deck_quality_publication_probe_failure_disables_admission_only() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
    from app.gateway.workers.deck_quality_publication import (
        get_deck_quality_publication_store_or_none,
    )
    from app.gateway.workers.deck_quality_publication_worker import (
        get_deck_quality_publication_worker_or_none,
    )

    class FailingPublicationWorker:
        def __init__(self) -> None:
            self.stopped = False

        async def probe(self) -> None:
            raise RuntimeError("safe synthetic publication probe failure")

        def start(self) -> None:
            raise AssertionError("failed probe must not start publication worker")

        async def stop(self) -> None:
            self.stopped = True

    candidate = FailingPublicationWorker()
    store = SimpleNamespace(aclose=AsyncMock())
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
            deck_quality=DeckQualityConfig(
                enabled=True,
                mode="shadow",
                canary_user_ids={"canary-user"},
                max_quality_cost_usd=Decimal("0.60"),
            ),
        )
    )
    with (
        patch.object(
            gateway_app,
            "compile_runtime_instrument",
            return_value=SimpleNamespace(lock=object()),
        ),
        patch.object(
            gateway_app,
            "configured_deck_quality_publication_store",
            return_value=store,
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_publication_worker",
            return_value=candidate,
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
            return_value=None,
        ),
    ):
        app = gateway_app.create_app()
        with TestClient(app) as client:
            response = client.get("/health")
            assert get_deck_quality_publication_store_or_none(app) is None
            assert get_deck_quality_publication_worker_or_none(app) is None

    assert response.status_code == 200
    assert candidate.stopped is True
    store.aclose.assert_not_awaited()


def test_gateway_app_mounts_voice_connect_route(monkeypatch):
    from app.gateway.app import create_app

    monkeypatch.setenv("STREAM_API_KEY", "test-api-key")
    monkeypatch.setenv("STREAM_API_SECRET", "test-api-secret")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "legacy_cascade")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "false")

    app = create_app()
    app.dependency_overrides[require_authorized_user_scope] = lambda: "test_user"
    with patch(
        "app.gateway.routers.voice._dispatch_voice_agent",
        new_callable=AsyncMock,
        return_value="test-session-id",
    ):
        with TestClient(app) as client:
            response = client.post(
                "/api/sophia/test_user/voice/connect",
                json={"platform": "voice", "context_mode": "life"},
            )

    assert response.status_code == 200
    payload = response.json()
    assert payload["api_key"] == "test-api-key"
    assert payload["session_id"] == "test-session-id"
    assert payload["call_type"] == "default"


def test_gateway_migration_maintenance_mode_blocks_mutations(monkeypatch):
    from app.gateway.app import create_app

    monkeypatch.setenv("SOPHIA_MIGRATION_MAINTENANCE_MODE", "true")
    app = create_app()
    with TestClient(app) as client:
        blocked = client.post("/api/maintenance-probe")
        readable = client.get("/health")

    assert blocked.status_code == 503
    assert blocked.headers["retry-after"] == "60"
    assert readable.status_code == 200
