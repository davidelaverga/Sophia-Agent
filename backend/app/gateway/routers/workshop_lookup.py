"""Internal routes for the workshop guest-dispatch task resolution.

The companion's Telegram handler (Phase 2) calls
``POST /internal/workshop/resolve`` after it sends the summoning
message, storing ``(chat_id, summoning_message_id) → task_id`` in the
gateway-side ``TaskResolutionCache``. The workshop handler then calls
``GET /internal/workshop/resolve?chat_id=&message_id=`` from inside its
Telegram update handler.

Both routes are internal (under ``/internal``). Production deployments
bind the gateway to a non-public interface or guard ``/internal`` at
the reverse proxy.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §11.3.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.gateway.builder_events.task_resolution_cache import TaskResolutionCache

logger = logging.getLogger(__name__)


_CACHE_ATTR = "_task_resolution_cache"


def install_task_resolution_cache(app, *, cache: TaskResolutionCache | None = None) -> TaskResolutionCache:
    """Attach a TaskResolutionCache to ``app.state``."""
    target = cache or TaskResolutionCache()
    setattr(app.state, _CACHE_ATTR, target)
    return target


def get_task_resolution_cache(app) -> TaskResolutionCache:
    target = getattr(app.state, _CACHE_ATTR, None)
    if target is None:
        raise RuntimeError(
            "TaskResolutionCache is not installed on app.state. "
            "Did the gateway lifespan run?"
        )
    return target


router = APIRouter(prefix="/internal/workshop", tags=["workshop-lookup"])


class WorkshopResolveRequest(BaseModel):
    chat_id: int | str = Field(..., description="Telegram chat id")
    message_id: int | str = Field(..., description="Summoning message id (companion-sent)")
    task_id: str = Field(..., description="Builder task / thread id")
    user_id: str = Field(..., description="Sophia user_id")


class WorkshopResolveResponse(BaseModel):
    task_id: str
    user_id: str


@router.post(
    "/resolve",
    status_code=status.HTTP_201_CREATED,
    summary="Register (chat_id, message_id) → task_id for workshop guest dispatch",
)
async def register_resolution(body: WorkshopResolveRequest, request: Request) -> dict[str, str]:
    cache = get_task_resolution_cache(request.app)
    try:
        cache.register(
            chat_id=body.chat_id,
            message_id=body.message_id,
            task_id=body.task_id,
            user_id=body.user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"status": "registered"}


@router.get(
    "/resolve",
    response_model=WorkshopResolveResponse,
    summary="Resolve (chat_id, message_id) → task_id (workshop guest-dispatch lookup)",
    responses={404: {"description": "Mapping not found or expired"}},
)
async def resolve(
    chat_id: int | str,
    message_id: int | str,
    request: Request,
) -> WorkshopResolveResponse:
    cache = get_task_resolution_cache(request.app)
    result = cache.resolve(chat_id=chat_id, message_id=message_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task_id mapping not found or expired")
    task_id, user_id = result
    return WorkshopResolveResponse(task_id=task_id, user_id=user_id)
