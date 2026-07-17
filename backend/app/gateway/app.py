import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.gateway.config import get_gateway_config
from app.gateway.logging_security import install_gateway_logging_safety
from app.gateway.routers import (
    agents,
    artifacts,
    bootstrap,
    builder_canvas,
    builder_events,
    channels,
    mcp,
    memory,
    models,
    sessions,
    skills,
    suggestions,
    telegram_link,
    uploads,
    voice,
)
from app.gateway.supabase_project import validate_expected_supabase_project
from app.gateway.workers.builder_canvas import install_builder_canvas_worker
from app.gateway.workers.builder_events import install_builder_events_worker
from app.gateway.workers.companion_wakeup import install_companion_wakeup
from app.gateway.workers.deck_quality_dispatcher import (
    build_configured_deck_quality_dispatcher,
    get_deck_quality_dispatcher_or_none,
    install_deck_quality_dispatcher,
)
from app.gateway.workers.deck_quality_publication_worker import (
    build_configured_deck_quality_publication_worker,
    get_deck_quality_publication_worker_or_none,
    install_deck_quality_publication_worker,
    stop_deck_quality_publication_worker,
)
from deerflow.config.app_config import get_app_config
from deerflow.sophia.builder_event_auth import probe_builder_event_auth
from deerflow.sophia.deck_quality.instrument import compile_runtime_instrument
from deerflow.sophia.deck_quality.producer_failure_signal import (
    configured_producer_failure_signal_store,
)
from deerflow.sophia.deck_quality.publication_persistence import (
    configured_deck_quality_publication_store,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
install_gateway_logging_safety()

logger = logging.getLogger(__name__)
_ARTIFACT_UPSERT_AUTH_PATCH = "artifact_upsert_auth_v2"
_DECK_QUALITY_READINESS_ATTR = "_deck_quality_readiness"


def _deck_quality_component(
    status: str,
    *,
    reason: str | None = None,
    error_type: str | None = None,
) -> dict[str, str]:
    component = {"status": status}
    if reason is not None:
        component["reason"] = reason
    if error_type is not None:
        component["error_type"] = error_type
    return component


def _initial_deck_quality_readiness(*, enabled: bool | None) -> dict[str, object]:
    if enabled is False:
        return {
            "enabled": False,
            "status": "disabled",
            "publication": _deck_quality_component("disabled"),
            "dispatcher": _deck_quality_component("disabled"),
            "producer_failure_signal": _deck_quality_component("disabled"),
        }
    return {
        "enabled": enabled,
        "status": "starting" if enabled else "not_started",
        "publication": _deck_quality_component("starting" if enabled else "not_started"),
        "dispatcher": _deck_quality_component("starting" if enabled else "not_started"),
        "producer_failure_signal": _deck_quality_component(
            "starting" if enabled else "not_started"
        ),
    }


def _gateway_version_metadata() -> dict[str, str | None]:
    commit_sha = os.getenv("RENDER_GIT_COMMIT") or os.getenv("RENDER_GIT_COMMIT_SHA") or os.getenv("GIT_COMMIT_SHA") or os.getenv("SOURCE_COMMIT")
    return {
        "commit_sha": commit_sha,
        "build_timestamp": os.getenv("RENDER_BUILD_TIMESTAMP") or os.getenv("BUILD_TIMESTAMP"),
        "artifact_upsert_auth_patch": _ARTIFACT_UPSERT_AUTH_PATCH,
    }


def _live_deck_quality_readiness(
    app: FastAPI,
    snapshot: dict[str, object],
) -> dict[str, object]:
    """Overlay startup status with live, content-free worker heartbeats."""

    result = dict(snapshot)
    result["publication"] = dict(snapshot.get("publication") or {})
    result["dispatcher"] = dict(snapshot.get("dispatcher") or {})
    result["producer_failure_signal"] = dict(
        snapshot.get("producer_failure_signal") or {}
    )
    if snapshot.get("enabled") is not True:
        return result
    publication_worker = get_deck_quality_publication_worker_or_none(app)
    dispatcher = get_deck_quality_dispatcher_or_none(app)
    if publication_worker is not None:
        result["publication"] = publication_worker.readiness()
    elif result["publication"].get("status") == "ready":
        result["publication"] = _deck_quality_component(
            "degraded",
            reason="worker_not_running",
        )
    if dispatcher is not None:
        result["dispatcher"] = dispatcher.readiness()
    elif result["dispatcher"].get("status") == "ready":
        result["dispatcher"] = _deck_quality_component(
            "degraded",
            reason="worker_not_running",
        )
    producer_failure_signal = (
        builder_events.get_producer_failure_signal_readiness(app)
    )
    if producer_failure_signal is not None:
        result["producer_failure_signal"] = producer_failure_signal
    component_statuses = {
        str(component.get("status"))
        for component in (
            result["publication"],
            result["dispatcher"],
            result["producer_failure_signal"],
        )
        if isinstance(component, dict)
    }
    result["status"] = (
        "ready" if component_statuses == {"ready"} else "degraded"
    )
    return result


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler."""

    # Load config and check necessary environment variables at startup
    try:
        app_config = get_app_config()
        validate_expected_supabase_project()
        logger.info("Configuration loaded successfully")
    except Exception as e:
        error_msg = f"Failed to load configuration during gateway startup: {e}"
        logger.exception(error_msg)
        raise RuntimeError(error_msg) from e
    config = get_gateway_config()
    logger.info(f"Starting API Gateway on {config.host}:{config.port}")

    deck_quality_readiness = _initial_deck_quality_readiness(enabled=app_config.deck_quality.enabled)
    setattr(app.state, _DECK_QUALITY_READINESS_ATTR, deck_quality_readiness)

    # Resolve and lock every static judge input outside the best-effort worker
    # startup boundaries. An enabled service with an invalid route, profile,
    # rubric, prompt pack, or campaign configuration must never advertise a
    # live gateway with DQ-1 silently disabled.
    deck_quality_runtime_instrument = None
    if app_config.deck_quality.enabled:
        deck_quality_runtime_instrument = compile_runtime_instrument(app_config)

    # Install the builder-events worker on app.state. The router endpoints
    # use ``get_builder_events_worker(app)`` to fan completion events out
    # to webapp SSE subscribers and channel adapters.
    install_builder_events_worker(app)
    logger.info("Builder events worker installed")
    install_builder_canvas_worker(app)
    logger.info("Builder canvas worker installed")

    # Install the companion wakeup worker. When a builder completion
    # event arrives, this worker triggers a synthetic empty turn on the
    # companion's LangGraph thread so Sophia proactively surfaces the
    # artifact in chat without the user having to send another message.
    # See ``app/gateway/workers/companion_wakeup.py`` for the rationale.
    install_companion_wakeup(app)
    logger.info("Companion wakeup worker installed")

    # This is the independent fallback when the producer outbox and its
    # object-store failure marker both fail. It owns no delivery path and no
    # content; unresolved rows remain readiness-degrading across restarts.
    producer_failure_signal_store = None
    if app_config.deck_quality.enabled:
        failure_signal_startup_phase = "auth"
        try:
            probe_builder_event_auth()
            failure_signal_startup_phase = "setup"
            producer_failure_signal_store = (
                configured_producer_failure_signal_store()
            )
            if producer_failure_signal_store is None:
                raise RuntimeError(
                    "enabled DQ1 producer failure signal requires durable persistence"
                )
            failure_signal_startup_phase = "probe"
            await producer_failure_signal_store.probe()
            failure_signal_startup_phase = "readiness"
            failure_signal_readiness = (
                await producer_failure_signal_store.readiness()
            )
            failure_signal_component = failure_signal_readiness.component()
            deck_quality_readiness["producer_failure_signal"] = (
                failure_signal_component
            )
            builder_events.set_producer_failure_signal_readiness(
                app,
                failure_signal_component,
            )
            logger.info(
                "DQ1 producer failure signal channel ready contentExcluded=true"
            )
        except Exception as exc:  # noqa: BLE001 - delivery stays authoritative.
            logger.error(
                "DQ1 producer failure signal channel unavailable at startup phase=%s error_type=%s contentExcluded=true",
                failure_signal_startup_phase,
                exc.__class__.__name__,
                exc_info=False,
            )
            if producer_failure_signal_store is not None:
                try:
                    await producer_failure_signal_store.aclose()
                except Exception:
                    logger.error(
                        "DQ1 producer failure signal store cleanup failed contentExcluded=true",
                        exc_info=False,
                    )
            producer_failure_signal_store = None
            failure_signal_reason = (
                "producer_failure_signal_auth_unavailable"
                if failure_signal_startup_phase == "auth"
                else f"{failure_signal_startup_phase}_failed"
            )
            failure_signal_component: dict[str, object] = {
                "status": "degraded",
                "reason": failure_signal_reason,
                "transport": {
                    "status": "degraded",
                    "reason": failure_signal_reason,
                    "error_type": exc.__class__.__name__,
                },
            }
            deck_quality_readiness["producer_failure_signal"] = (
                failure_signal_component
            )
            builder_events.set_producer_failure_signal_readiness(
                app,
                failure_signal_component,
            )
    builder_events.install_producer_failure_signal_store(
        app,
        producer_failure_signal_store,
    )

    # DQ-1 publication discovers immutable producer bundles and atomically
    # materializes their pre-render inputs. It is independently isolated from
    # ordinary delivery; the RPC store is owned only by this worker.
    deck_quality_publication_worker = None
    if app_config.deck_quality.enabled:
        candidate_publication_store = None
        candidate_publication_worker = None
        publication_startup_phase = "setup"
        try:
            candidate_publication_store = configured_deck_quality_publication_store()
            if candidate_publication_store is None:
                raise RuntimeError("enabled DQ1 publication worker requires durable persistence")
            candidate_publication_worker = build_configured_deck_quality_publication_worker(
                config=app_config.deck_quality,
                instrument=deck_quality_runtime_instrument.lock,
                store=candidate_publication_store,
            )
            if candidate_publication_worker is None:
                raise RuntimeError("enabled DQ1 publication worker was not constructed")
            publication_startup_phase = "probe"
            await candidate_publication_worker.probe()
            publication_startup_phase = "start"
            candidate_publication_worker.start()
            deck_quality_publication_worker = candidate_publication_worker
            deck_quality_readiness["publication"] = _deck_quality_component("ready")
            logger.info("DQ1 canary shadow publication worker started contentExcluded=true")
        except Exception as exc:  # noqa: BLE001 - shadow startup cannot take down delivery
            logger.error(
                "DQ1 canary shadow publication worker unavailable at startup phase=%s error_type=%s contentExcluded=true",
                publication_startup_phase,
                exc.__class__.__name__,
                exc_info=False,
            )
            if candidate_publication_worker is not None:
                try:
                    await stop_deck_quality_publication_worker(candidate_publication_worker)
                except Exception:
                    logger.error(
                        "DQ1 publication worker cleanup failed contentExcluded=true",
                        exc_info=False,
                    )
            elif candidate_publication_store is not None:
                try:
                    await candidate_publication_store.aclose()
                except Exception:
                    logger.error(
                        "DQ1 publication store cleanup failed contentExcluded=true",
                        exc_info=False,
                    )
            if publication_startup_phase == "setup" and isinstance(exc, ValueError):
                # Constructor ValueError denotes a deterministic mismatch
                # between the enabled configuration and immutable instrument.
                if producer_failure_signal_store is not None:
                    try:
                        await producer_failure_signal_store.aclose()
                    except Exception:
                        logger.error(
                            "DQ1 producer failure signal cleanup after static publication failure failed contentExcluded=true",
                            exc_info=False,
                        )
                    producer_failure_signal_store = None
                raise
            deck_quality_readiness["publication"] = _deck_quality_component(
                "degraded",
                reason=f"{publication_startup_phase}_failed",
                error_type=exc.__class__.__name__,
            )
    install_deck_quality_publication_worker(
        app,
        deck_quality_publication_worker,
    )

    # The metadata-only dispatcher claims promoted canary rows and starts the
    # isolated quality graph. The publication worker above may read the
    # bounded source pack and accepted PPTX solely to freeze immutable input
    # provenance; rendering, judge payload construction, model invocation, and
    # the OpenAI credential remain exclusively in sophia-langgraph.
    deck_quality_dispatcher = None
    if app_config.deck_quality.enabled:
        candidate_dispatcher = None
        dispatcher_startup_phase = "setup"
        try:
            candidate_dispatcher = build_configured_deck_quality_dispatcher(
                config=app_config.deck_quality,
                instrument=deck_quality_runtime_instrument.lock,
                langgraph_url=os.getenv("LANGGRAPH_URL") or "http://localhost:2024",
            )
            if candidate_dispatcher is None:
                raise RuntimeError("enabled DQ1 dispatcher was not constructed")
            dispatcher_startup_phase = "probe"
            await candidate_dispatcher.probe()
            dispatcher_startup_phase = "start"
            candidate_dispatcher.start()
            deck_quality_dispatcher = candidate_dispatcher
            deck_quality_readiness["dispatcher"] = _deck_quality_component("ready")
            logger.info("DQ1 canary shadow dispatcher started contentExcluded=true")
        except Exception as exc:  # noqa: BLE001 - shadow startup cannot take down delivery
            logger.error(
                "DQ1 canary shadow dispatcher unavailable at startup phase=%s error_type=%s contentExcluded=true",
                dispatcher_startup_phase,
                exc.__class__.__name__,
                exc_info=False,
            )
            if candidate_dispatcher is not None:
                try:
                    await candidate_dispatcher.stop()
                except Exception:
                    logger.error(
                        "DQ1 failed dispatcher cleanup error contentExcluded=true",
                        exc_info=False,
                    )
            if dispatcher_startup_phase == "setup" and isinstance(exc, ValueError):
                # Missing deployment identity or an invalid enabled worker
                # configuration is deterministic and must fail startup.
                if deck_quality_publication_worker is not None:
                    try:
                        await stop_deck_quality_publication_worker(deck_quality_publication_worker)
                    except Exception:
                        logger.error(
                            "DQ1 publication worker cleanup after static dispatcher failure failed contentExcluded=true",
                            exc_info=False,
                        )
                if producer_failure_signal_store is not None:
                    try:
                        await producer_failure_signal_store.aclose()
                    except Exception:
                        logger.error(
                            "DQ1 producer failure signal cleanup after static dispatcher failure failed contentExcluded=true",
                            exc_info=False,
                        )
                    producer_failure_signal_store = None
                raise
            deck_quality_readiness["dispatcher"] = _deck_quality_component(
                "degraded",
                reason=f"{dispatcher_startup_phase}_failed",
                error_type=exc.__class__.__name__,
            )
    install_deck_quality_dispatcher(app, deck_quality_dispatcher)

    if app_config.deck_quality.enabled:
        component_statuses = {
            str(component["status"])
            for component in (
                deck_quality_readiness["publication"],
                deck_quality_readiness["dispatcher"],
                deck_quality_readiness["producer_failure_signal"],
            )
        }
        deck_quality_readiness["status"] = "ready" if component_statuses == {"ready"} else "degraded"

    # NOTE: MCP tools initialization is NOT done here because:
    # 1. Gateway doesn't use MCP tools - they are used by Agents in the LangGraph Server
    # 2. Gateway and LangGraph Server are separate processes with independent caches
    # MCP tools are lazily initialized in LangGraph Server when first needed

    # Start IM channel service if any channels are configured
    try:
        from app.channels.service import start_channel_service

        channel_service = await start_channel_service()
        logger.info("Channel service started: %s", channel_service.get_status())
    except Exception:
        logger.exception("No IM channels configured or channel service failed to start")

    # Rehydrate Telegram chat -> canonical user bindings from Supabase so
    # cross-platform identity resolution survives gateway restarts/deploys.
    # Best-effort: never block startup on a Supabase outage.
    try:
        from app.gateway import telegram_link_store

        loaded = telegram_link_store.load_bindings_from_supabase()
        if loaded:
            logger.info("Rehydrated %d Telegram user bindings from Supabase", loaded)
    except Exception:
        logger.exception("Failed to rehydrate Telegram user bindings from Supabase")

    # Start Sophia inactivity watcher
    try:
        from app.gateway.inactivity_watcher import start_watcher

        await start_watcher()
        logger.info("Sophia inactivity watcher started")
    except Exception:
        logger.exception("Failed to start inactivity watcher")

    # Start Telegram-side session tracker (mirrors the web watcher but
    # keys on chat_id; fires the offline pipeline + memory-review
    # notification on 10-min Telegram idle).
    try:
        from app.channels.telegram_session_tracker import start_watcher as start_tg_watcher

        await start_tg_watcher()
        logger.info("Telegram session tracker started")
    except Exception:
        logger.exception("Failed to start Telegram session tracker")

    yield

    if deck_quality_publication_worker is not None:
        try:
            await stop_deck_quality_publication_worker(deck_quality_publication_worker)
            logger.info("DQ1 canary shadow publication worker stopped")
        except Exception:
            logger.error(
                "DQ1 publication worker shutdown failed contentExcluded=true",
                exc_info=False,
            )

    if deck_quality_dispatcher is not None:
        try:
            await deck_quality_dispatcher.stop()
            logger.info("DQ1 canary shadow dispatcher stopped")
        except Exception:
            logger.error("DQ1 dispatcher shutdown failed contentExcluded=true", exc_info=False)

    if producer_failure_signal_store is not None:
        try:
            await producer_failure_signal_store.aclose()
            logger.info("DQ1 producer failure signal store closed")
        except Exception:
            logger.error(
                "DQ1 producer failure signal store shutdown failed contentExcluded=true",
                exc_info=False,
            )

    # Stop watchers
    try:
        from app.channels.telegram_session_tracker import stop_watcher as stop_tg_watcher
        from app.gateway.inactivity_watcher import stop_watcher

        await stop_watcher()
        await stop_tg_watcher()
    except Exception:
        logger.exception("Failed to stop watchers")

    # Stop channel service on shutdown
    try:
        from app.channels.service import stop_channel_service

        await stop_channel_service()
    except Exception:
        logger.exception("Failed to stop channel service")
    logger.info("Shutting down API Gateway")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Returns:
        Configured FastAPI application instance.
    """

    app = FastAPI(
        title="DeerFlow API Gateway",
        description="""
## DeerFlow API Gateway

API Gateway for DeerFlow - A LangGraph-based AI agent backend with sandbox execution capabilities.

### Features

- **Models Management**: Query and retrieve available AI models
- **MCP Configuration**: Manage Model Context Protocol (MCP) server configurations
- **Memory Management**: Access and manage global memory data for personalized conversations
- **Skills Management**: Query and manage skills and their enabled status
- **Artifacts**: Access thread artifacts and generated files
- **Health Monitoring**: System health check endpoints

### Architecture

LangGraph requests are handled by nginx reverse proxy.
This gateway provides custom endpoints for models, MCP configuration, skills, and artifacts.
        """,
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        openapi_tags=[
            {
                "name": "models",
                "description": "Operations for querying available AI models and their configurations",
            },
            {
                "name": "mcp",
                "description": "Manage Model Context Protocol (MCP) server configurations",
            },
            {
                "name": "memory",
                "description": "Access and manage global memory data for personalized conversations",
            },
            {
                "name": "skills",
                "description": "Manage skills and their configurations",
            },
            {
                "name": "artifacts",
                "description": "Access and download thread artifacts and generated files",
            },
            {
                "name": "uploads",
                "description": "Upload and manage user files for threads",
            },
            {
                "name": "agents",
                "description": "Create and manage custom agents with per-agent config and prompts",
            },
            {
                "name": "suggestions",
                "description": "Generate follow-up question suggestions for conversations",
            },
            {
                "name": "channels",
                "description": "Manage IM channel integrations (Feishu, Slack, Telegram)",
            },
            {
                "name": "sophia",
                "description": "Sophia companion: memory review, reflect, journal, visual artifacts",
            },
            {
                "name": "health",
                "description": "Health check and system status endpoints",
            },
        ],
    )
    setattr(
        app.state,
        _DECK_QUALITY_READINESS_ATTR,
        _initial_deck_quality_readiness(enabled=None),
    )

    # CORS — nginx handles this in Docker, but on Render there's no nginx.
    # Enable FastAPI CORS for direct browser → gateway requests in production.
    from starlette.middleware.cors import CORSMiddleware

    cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def migration_maintenance_mode(request, call_next):
        enabled = os.getenv("SOPHIA_MIGRATION_MAINTENANCE_MODE", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if enabled and request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            from fastapi.responses import JSONResponse

            return JSONResponse(
                status_code=503,
                content={"detail": "Sophia is temporarily read-only during a database migration."},
                headers={"Retry-After": "60"},
            )
        return await call_next(request)

    # Include routers
    # Models API is mounted at /api/models
    app.include_router(models.router)

    # MCP API is mounted at /api/mcp
    app.include_router(mcp.router)

    # Memory API is mounted at /api/memory
    app.include_router(memory.router)

    # Skills API is mounted at /api/skills
    app.include_router(skills.router)

    # Artifacts API is mounted at /api/threads/{thread_id}/artifacts
    app.include_router(artifacts.router)

    # Uploads API is mounted at /api/threads/{thread_id}/uploads
    app.include_router(uploads.router)

    # Agents API is mounted at /api/agents
    app.include_router(agents.router)

    # Suggestions API is mounted at /api/threads/{thread_id}/suggestions
    app.include_router(suggestions.router)

    # Bootstrap API is mounted at /api/v1/bootstrap
    app.include_router(bootstrap.router)

    # Sessions API is mounted at /api/v1/sessions
    app.include_router(sessions.router)

    # Voice API is mounted at /api/sophia/{user_id}/voice/*
    app.include_router(voice.router)

    # Telegram link API is mounted at /api/sophia/{user_id}/telegram/*
    app.include_router(telegram_link.router)

    # Channels API is mounted at /api/channels
    app.include_router(channels.router)

    # Sophia API is mounted at /api/sophia
    from app.gateway.routers import sophia

    app.include_router(sophia.router)
    app.include_router(sophia.internal_router)
    app.include_router(builder_canvas.router)

    # Builder events: keep the legacy public SSE mounted for cached clients
    # and internal consumers while the authenticated builder-canvas route is
    # the primary browser path.
    app.include_router(builder_events.public_router)
    app.include_router(builder_events.internal_router)

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, object]:
        """Health check endpoint.

        Returns:
            Service health status information.
        """
        deck_quality_snapshot = getattr(
            app.state,
            _DECK_QUALITY_READINESS_ATTR,
            _initial_deck_quality_readiness(enabled=None),
        )
        deck_quality_readiness = _live_deck_quality_readiness(
            app,
            deck_quality_snapshot,
        )
        return {
            # DQ-1 is canary-only shadow observation. Its readiness is visible
            # below but must never change the baseline health contract.
            "status": "healthy",
            "service": "deer-flow-gateway",
            "readiness": {"deck_quality": deck_quality_readiness},
            **_gateway_version_metadata(),
        }

    @app.get("/version", tags=["health"])
    async def version_check() -> dict:
        """Return safe build metadata for deployment verification."""
        return {
            "service": "deer-flow-gateway",
            **_gateway_version_metadata(),
        }

    return app


# Create app instance for uvicorn
app = create_app()
