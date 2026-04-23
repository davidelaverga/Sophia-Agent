import logging
import os
import warnings
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.gateway.config import get_gateway_config
from app.gateway.routers import (
    agents,
    artifacts,
    bootstrap,
    channels,
    internal_artifacts,
    mcp,
    memory,
    models,
    sessions,
    skills,
    suggestions,
    uploads,
    voice,
)
from deerflow.config.app_config import get_app_config

# Narrow suppression: LangChain middleware emits a recurring
# ``PydanticSerializationUnexpectedValue`` warning on the ``context``
# RunnableConfig field (harmless — the field is serialised elsewhere with
# ``exclude=None``). The warning fires on every turn and drowns real
# log signal. Suppress ONLY messages that match the ``context`` field
# pattern; unrelated Pydantic warnings are left intact.
warnings.filterwarnings(
    "ignore",
    message=r".*PydanticSerializationUnexpectedValue.*context.*",
    category=UserWarning,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler."""

    # Load config and check necessary environment variables at startup
    try:
        get_app_config()
        logger.info("Configuration loaded successfully")
    except Exception as e:
        error_msg = f"Failed to load configuration during gateway startup: {e}"
        logger.exception(error_msg)
        raise RuntimeError(error_msg) from e
    config = get_gateway_config()
    logger.info(f"Starting API Gateway on {config.host}:{config.port}")

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

    # Start Sophia inactivity watcher
    try:
        from app.gateway.inactivity_watcher import start_watcher

        await start_watcher()
        logger.info("Sophia inactivity watcher started")
    except Exception:
        logger.exception("Failed to start inactivity watcher")

    yield

    # Stop inactivity watcher
    try:
        from app.gateway.inactivity_watcher import stop_watcher

        await stop_watcher()
    except Exception:
        logger.exception("Failed to stop inactivity watcher")

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

    # Internal artifact replication endpoint (LangGraph → Gateway)
    # Only active when SOPHIA_INTERNAL_SECRET is set (Render split-disk topology).
    if internal_artifacts._load_secret():
        app.include_router(internal_artifacts.router)

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

    # Channels API is mounted at /api/channels
    app.include_router(channels.router)

    # Sophia API is mounted at /api/sophia
    from app.gateway.routers import sophia
    app.include_router(sophia.router)

    @app.get("/health", tags=["health"])
    async def health_check() -> dict:
        """Health check endpoint.

        Returns:
            Service health status information.
        """
        return {"status": "healthy", "service": "deer-flow-gateway"}

    return app


# Create app instance for uvicorn
app = create_app()
