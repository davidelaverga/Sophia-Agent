"""Sophia bootstrap stubs.

Development stubs for /api/v1/bootstrap/* endpoints.
Returns valid response shapes so the frontend dashboard can load.
"""

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/bootstrap", tags=["bootstrap"])


class EmotionalContext(BaseModel):
    last_emotion: str | None = None
    trend: str | None = None


class BootstrapOpenerResponse(BaseModel):
    opener_text: str
    suggested_ritual: str | None = None
    emotional_context: EmotionalContext | None = None
    has_opener: bool


class BootstrapStatusResponse(BaseModel):
    has_opener: bool
    user_id: str


@router.get("/opener", response_model=BootstrapOpenerResponse)
async def get_opener() -> BootstrapOpenerResponse:
    """Get pre-computed session opener (dev stub — no opener available)."""
    return BootstrapOpenerResponse(
        opener_text="",
        suggested_ritual=None,
        emotional_context=None,
        has_opener=False,
    )


@router.get("/status", response_model=BootstrapStatusResponse)
async def get_status() -> BootstrapStatusResponse:
    """Check if opener is available (dev stub)."""
    return BootstrapStatusResponse(has_opener=False, user_id="dev-user")
