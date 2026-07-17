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
from deerflow.sophia.builder_event_auth import BUILDER_EVENT_HMAC_SECRET_ENV
from deerflow.sophia.deck_quality.producer_failure_signal import (
    ProducerFailureSignalReadiness,
)
from deerflow.sophia.session_store import SessionStore


@pytest.fixture(autouse=True)
def _gateway_test_app_config(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(
        BUILDER_EVENT_HMAC_SECRET_ENV,
        "gateway-test-builder-event-secret-" + "a" * 40,
    )
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
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["readiness"]["deck_quality"]["status"] == "degraded"
    assert payload["readiness"]["deck_quality"]["dispatcher"] == {
        "status": "degraded",
        "reason": "probe_failed",
        "error_type": "RuntimeError",
    }
    assert candidate.stopped is True


def test_deck_quality_publication_probe_failure_disables_worker_only() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
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
            assert get_deck_quality_publication_worker_or_none(app) is None

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["readiness"]["deck_quality"]["status"] == "degraded"
    assert payload["readiness"]["deck_quality"]["publication"] == {
        "status": "degraded",
        "reason": "probe_failed",
        "error_type": "RuntimeError",
    }
    assert candidate.stopped is True
    store.aclose.assert_not_awaited()


def test_persisted_producer_failure_signal_only_degrades_dq_readiness() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
    failure_store = SimpleNamespace(
        probe=AsyncMock(),
        readiness=AsyncMock(
            return_value=ProducerFailureSignalReadiness(
                persisted_count=2,
                unresolved_count=1,
                conflict_count=1,
                oldest_unresolved_at="2026-07-18T00:00:00Z",
            )
        ),
        aclose=AsyncMock(),
    )
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(
                use="deerflow.sandbox.local:LocalSandboxProvider"
            ),
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
            "configured_producer_failure_signal_store",
            return_value=failure_store,
        ),
        patch.object(
            gateway_app,
            "configured_deck_quality_publication_store",
            return_value=None,
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
            return_value=None,
        ),
    ):
        app = gateway_app.create_app()
        with TestClient(app) as client:
            first = client.get("/health")
            second = client.get("/health")

    assert first.status_code == second.status_code == 200
    payload = second.json()
    assert payload["status"] == "healthy"
    assert payload["readiness"]["deck_quality"]["status"] == "degraded"
    component = payload["readiness"]["deck_quality"]["producer_failure_signal"]
    assert component == {
        "status": "degraded",
        "reason": "producer_failure_signal_unresolved",
        "counts": {"persisted": 2, "unresolved": 1, "conflicts": 1},
        "transport": {"status": "ready"},
        "oldest_unresolved_at": "2026-07-18T00:00:00+00:00",
    }
    failure_store.probe.assert_awaited_once()
    failure_store.readiness.assert_awaited_once()
    failure_store.aclose.assert_awaited_once()


def test_missing_failure_signal_auth_only_degrades_dq_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway_app = importlib.import_module("app.gateway.app")
    monkeypatch.delenv(BUILDER_EVENT_HMAC_SECRET_ENV)
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(
                use="deerflow.sandbox.local:LocalSandboxProvider"
            ),
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
            "configured_producer_failure_signal_store",
        ) as signal_store_factory,
        patch.object(
            gateway_app,
            "configured_deck_quality_publication_store",
            return_value=None,
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

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["readiness"]["deck_quality"]["status"] == "degraded"
    component = payload["readiness"]["deck_quality"]["producer_failure_signal"]
    assert component == {
        "status": "degraded",
        "reason": "producer_failure_signal_auth_unavailable",
        "transport": {
            "status": "degraded",
            "reason": "producer_failure_signal_auth_unavailable",
            "error_type": "BuilderEventAuthenticationError",
        },
    }
    signal_store_factory.assert_not_called()


@pytest.mark.parametrize(
    "publication_readiness",
    (
        {
            "status": "degraded",
            "reason": "cycle_failed",
            "error_type": "RuntimeError",
        },
        {"status": "degraded", "reason": "heartbeat_stale"},
    ),
)
def test_health_contract_is_unchanged_when_live_publication_worker_degrades(
    publication_readiness: dict[str, str],
) -> None:
    gateway_app = importlib.import_module("app.gateway.app")
    publication_worker = SimpleNamespace(
        readiness=lambda: dict(publication_readiness)
    )
    dispatcher = SimpleNamespace(
        readiness=lambda: {
            "status": "ready",
            "last_success_at": "2026-07-16T12:00:00+00:00",
        }
    )
    app = gateway_app.create_app()

    with TestClient(app) as client:
        setattr(
            app.state,
            "_deck_quality_readiness",
            {
                "enabled": True,
                "status": "ready",
                "publication": {"status": "ready"},
                "dispatcher": {"status": "ready"},
            },
        )
        with (
            patch.object(
                gateway_app,
                "get_deck_quality_publication_worker_or_none",
                return_value=publication_worker,
            ),
            patch.object(
                gateway_app,
                "get_deck_quality_dispatcher_or_none",
                return_value=dispatcher,
            ),
        ):
            response = client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    readiness = payload["readiness"]["deck_quality"]
    assert readiness["status"] == "degraded"
    assert readiness["publication"] == publication_readiness
    assert readiness["dispatcher"]["status"] == "ready"


def test_enabled_deck_quality_static_instrument_error_fails_gateway_startup() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
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
            side_effect=ValueError("safe synthetic judge route mismatch"),
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_publication_worker",
        ) as publication_builder,
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
        ) as dispatcher_builder,
    ):
        app = gateway_app.create_app()
        with pytest.raises(ValueError, match="judge route mismatch"):
            with TestClient(app):
                pass

    publication_builder.assert_not_called()
    dispatcher_builder.assert_not_called()


def test_enabled_deck_quality_static_worker_config_error_fails_gateway_startup() -> None:
    gateway_app = importlib.import_module("app.gateway.app")
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
            side_effect=ValueError("safe synthetic instrument mismatch"),
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
        ) as dispatcher_builder,
    ):
        app = gateway_app.create_app()
        with pytest.raises(ValueError, match="instrument mismatch"):
            with TestClient(app):
                pass

    store.aclose.assert_awaited_once()
    dispatcher_builder.assert_not_called()


def test_enabled_deck_quality_static_dispatcher_config_error_fails_gateway_startup() -> None:
    gateway_app = importlib.import_module("app.gateway.app")

    class HealthyPublicationWorker:
        def __init__(self) -> None:
            self.started = False
            self.stopped = False

        async def probe(self) -> None:
            return None

        def start(self) -> None:
            self.started = True

        async def stop(self) -> None:
            self.stopped = True

    publication_worker = HealthyPublicationWorker()
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
            return_value=publication_worker,
        ),
        patch.object(
            gateway_app,
            "build_configured_deck_quality_dispatcher",
            side_effect=ValueError("safe synthetic deployed SHA mismatch"),
        ),
    ):
        app = gateway_app.create_app()
        with pytest.raises(ValueError, match="deployed SHA mismatch"):
            with TestClient(app):
                pass

    assert publication_worker.started is True
    assert publication_worker.stopped is True


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
