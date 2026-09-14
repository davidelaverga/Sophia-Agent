"""Staged explicit source intake, independent of late transcript snapshots.

SQL RPC grants remain closed until source/UI/planner integration is qualified.
No raw validation inputs or source text are returned in errors or receipts.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import TypeAdapter

from app.gateway.auth import require_authenticated_user
from deerflow.sophia.memory_governance.source_intake import ActionKey, SourceActionRequest, SourceIntakeService, UuidText
from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict, configured_memory_store


class SourceNoStoreRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def no_store(request):
            try:
                response = await handler(request)
            except HTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            response.headers["Cache-Control"] = "no-store"
            return response

        return no_store


router = APIRouter(prefix="/api/v1/sessions", tags=["memory-source"], route_class=SourceNoStoreRoute)


def _validated(kind, value):
    try:
        return TypeAdapter(kind).validate_python(value)
    except Exception:
        raise HTTPException(400, "Invalid memory source request", headers={"Cache-Control": "no-store"}) from None


async def _action(request: Request) -> SourceActionRequest:
    import json

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2 * 1024 * 1024:
            raise HTTPException(413, "Memory source request too large", headers={"Cache-Control": "no-store"})
    try:
        return SourceActionRequest.model_validate(json.loads(body))
    except Exception:
        raise HTTPException(400, "Invalid memory source request", headers={"Cache-Control": "no-store"}) from None


def _execute(owner, operation):
    try:
        service = SourceIntakeService(owner_id=owner, store=configured_memory_store())
        result = operation(service)
        return JSONResponse(result.model_dump(mode="json", by_alias=True), headers={"Cache-Control": "no-store"})
    except MemoryGovernanceConflict:
        raise HTTPException(409, "Memory source action conflict", headers={"Cache-Control": "no-store"}) from None
    except Exception:
        raise HTTPException(503, "Memory source authority unavailable", headers={"Cache-Control": "no-store"}) from None


@router.get("/{session_id}/memory-source-boundary")
def source_boundary(session_id: str, request: Request, owner: str = Depends(require_authenticated_user)):
    session = _validated(UuidText, session_id)
    thread = _validated(UuidText, request.query_params.get("thread_id"))
    return _execute(owner, lambda service: service.boundary(session_id=session, thread_id=thread))


@router.get("/{session_id}/memory-source-profile")
def source_profile(session_id: str, request: Request, owner: str = Depends(require_authenticated_user)):
    from app.gateway.routers.sessions import _store

    session = _validated(UuidText, session_id)
    thread = _validated(UuidText, request.query_params.get("thread_id"))
    if list(request.query_params.keys()) != ["thread_id"] or len(request.query_params.getlist("thread_id")) != 1:
        raise HTTPException(400, "Invalid memory source request")
    return _execute(owner, lambda service: service.profile(session_id=session, thread_id=thread, session_store=_store))


@router.post("/{session_id}/memory-source-actions")
def accept_source_action(session_id: str, action: SourceActionRequest = Depends(_action), owner: str = Depends(require_authenticated_user)):
    session = _validated(UuidText, session_id)
    return _execute(owner, lambda service: service.accept(session_id=session, action=action))


@router.get("/memory-source-actions/{command_key}")
def source_action_status(command_key: str, owner: str = Depends(require_authenticated_user)):
    key = _validated(ActionKey, command_key)
    return _execute(owner, lambda service: service.status(command_key=key))
