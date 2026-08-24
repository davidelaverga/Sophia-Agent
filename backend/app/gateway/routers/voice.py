"""Voice session API — Stream token generation, agent dispatch, and call lifecycle."""

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import UUID

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from dotenv import dotenv_values
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.gateway.auth import require_authorized_user_scope
from app.gateway.sophia_realtime_context import (
    REALTIME_DYNAMIC_MEMORY_RETRIEVAL_SCHEMA,
    REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER,
    RealtimeContextRequest,
    build_degraded_realtime_context_response,
    build_sophia_realtime_context,
    create_realtime_memory_retrieval_grant,
)
from app.gateway.voice_lab_capability import (
    VOICE_LAB_CAPABILITY_HEADER,
    VoiceLabClaims,
    VoiceLabProviderCleanupClaims,
    assert_voice_lab_session_record,
    capability_for_gateway_action,
    capability_for_voice_connect,
    mint_provider_cleanup_token,
    sign_retention_reaper_runtime_capability,
    sign_runtime_capability,
    voice_internal_auth_headers,
)
from app.gateway.workers.voice_lab_retention import (
    get_voice_lab_retention_reaper_or_none,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/sophia",
    tags=["voice"],
    dependencies=[Depends(require_authorized_user_scope)],
)

SUPPORTED_PLATFORMS = {"voice", "text", "ios_voice"}
SUPPORTED_CONTEXT_MODES = {"work", "gaming", "life"}
VOICE_SERVER_DISPATCH_TIMEOUT = 10.0
VOICE_SERVER_WARMUP_TIMEOUT = 5.0
VOICE_SERVER_DOGFOOD_TIMEOUT = 15.0
VOICE_SERVER_DOGFOOD_SIDEBAND_TIMEOUT = 30.0
VOICE_SERVER_PRODUCTION_RUNTIME_TIMEOUT = 15.0
GEMINI_PRECONNECT_CLIENT_TTL_MS = 30_000
GEMINI_PRECONNECT_SERVER_CLEANUP_SECONDS = 65.0
GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG = "SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED"
VOICE_LAB_TRACE_FAULT_SCENARIO_ID = "V-L01"
VOICE_LAB_TRACE_FAULT_MODE = "langsmith_unavailable"
BACKEND_DIR = Path(__file__).resolve().parents[3]
REPO_ROOT = BACKEND_DIR.parent


@dataclass(frozen=True)
class ActiveVoiceSession:
    call_id: str
    session_id: str
    runtime: str = "legacy_cascade"
    voice_lab_binding: dict[str, object] | None = None


@dataclass(frozen=True)
class GeminiProductionDisconnectResult:
    disconnected: bool
    trace_fault: dict[str, object] | None = None

    def __bool__(self) -> bool:
        return self.disconnected


class _FinalizingStreamingResponse(StreamingResponse):
    """Run an async owner finalizer even before the body's first iteration."""

    def __init__(
        self,
        *args: Any,
        finalizer: Callable[[], Awaitable[None]],
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._owner_finalizer = finalizer

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # The detached task survives cancellation of the ASGI sender.  The
            # finalizer is idempotent, so the body generator may invoke it too.
            cleanup = asyncio.create_task(self._owner_finalizer())
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                raise


_active_voice_sessions: dict[str, ActiveVoiceSession] = {}
_active_voice_session_locks: dict[str, asyncio.Lock] = {}
_active_voice_session_locks_guard = asyncio.Lock()

# Background tasks for fire-and-forget preflight disconnects.
# Held in a module-level set so asyncio doesn't GC them mid-flight.
_background_disconnect_tasks: set[asyncio.Task] = set()


def _schedule_background_disconnect(call_id: str, session_id: str) -> None:
    """Fire-and-forget disconnect of a previous voice session.

    Avoids blocking /voice/connect on the voice server's DELETE response.
    Progressive latency accumulation (1-3s → 5s → 8s → 10s) observed by
    users is caused by awaiting this disconnect while the previous session's
    Cartesia/Deepgram/Stream resources are still tearing down.
    """
    try:
        task = asyncio.create_task(_disconnect_voice_session(call_id, session_id))
    except RuntimeError:
        # No running event loop — nothing to do (shouldn't happen in FastAPI path).
        logger.warning(
            "voice.connect: cannot schedule background disconnect (no loop) call_id=%s",
            call_id,
        )
        return
    _background_disconnect_tasks.add(task)
    task.add_done_callback(_background_disconnect_tasks.discard)


def _schedule_background_active_session_disconnect(
    session: ActiveVoiceSession,
    *,
    runtime_capability: str | None = None,
) -> None:
    try:
        if session.runtime == "gemini_live":
            task = asyncio.create_task(
                _disconnect_gemini_production_session(
                    session.session_id,
                    capability=runtime_capability,
                )
            )
        else:
            task = asyncio.create_task(_disconnect_voice_session(session.call_id, session.session_id))
    except RuntimeError:
        logger.warning(
            "voice.connect: cannot schedule background disconnect (no loop) runtime=%s session_id=%s",
            session.runtime,
            session.session_id,
        )
        return
    _background_disconnect_tasks.add(task)
    task.add_done_callback(_background_disconnect_tasks.discard)


def _get_voice_server_url() -> str:
    return os.getenv("VOICE_SERVER_URL", "http://localhost:8000").rstrip("/")


def _voice_lab_active_binding(claims: VoiceLabClaims) -> dict[str, object]:
    return {
        **claims.synthetic_context(),
        "expected_deployment": dict(claims.expected_deployment),
    }


def _provider_cleanup_voice_lab_claims(
    cleanup_claims: VoiceLabProviderCleanupClaims,
    *,
    user_id: str,
    provider_session_id: str,
) -> VoiceLabClaims:
    """Project settlement-only claims into the exact canonical run binding.

    The browser cleanup token is independently signed and deliberately
    survives the short interactive capability.  It is never promoted back to
    product authority: this projection is used only by provider settlement and
    by the cleanup-only Voice runtime capability minted after the browser's
    exact socket proof has been persisted.
    """

    if (
        cleanup_claims.principal_id != user_id
        or cleanup_claims.provider_session_id != provider_session_id
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_cleanup_binding_mismatch"},
        )
    return VoiceLabClaims(
        principal_id=cleanup_claims.principal_id,
        test_run_id=cleanup_claims.test_run_id,
        scenario_id=cleanup_claims.scenario_id,
        scenario_version=cleanup_claims.scenario_version,
        environment=cleanup_claims.environment,
        retention_hours=cleanup_claims.retention_hours,
        cleanup_obligation_id=cleanup_claims.cleanup_obligation_id,
        provider_expires_at=cleanup_claims.provider_expires_at,
        allowed_ops=("provider:settle",),
        expected_deployment=dict(cleanup_claims.expected_deployment),
        issued_at=cleanup_claims.issued_at,
        not_before=cleanup_claims.not_before,
        expires_at=cleanup_claims.expires_at,
        jti=cleanup_claims.jti,
        nonce=cleanup_claims.jti,
        raw=dict(cleanup_claims.raw),
        provider_session_id=cleanup_claims.provider_session_id,
        voice_lab_run_id_sha256=cleanup_claims.voice_lab_run_id_sha256,
        browser_worker_id_sha256=cleanup_claims.browser_worker_id_sha256,
        browser_lease_epoch=cleanup_claims.browser_lease_epoch,
        browser_context_id_sha256=cleanup_claims.browser_context_id_sha256,
    )


def _provider_cleanup_claims_for_disconnect(
    request: Request,
    *,
    user_id: str,
    provider_session_id: str,
) -> tuple[VoiceLabClaims, str] | None:
    """Validate the standalone cleanup token against durable product state.

    A deleted canonical session is allowed only for an exact settlement replay;
    the content-free obligation digest performs that check later.  While the
    session exists, every signed and provider-owned field is joined before any
    settlement mutation or Voice call.
    """

    cleanup_claims = getattr(
        request.state,
        "voice_lab_provider_cleanup_claims",
        None,
    )
    if cleanup_claims is None:
        return None
    if not isinstance(cleanup_claims, VoiceLabProviderCleanupClaims):
        raise HTTPException(
            status_code=401,
            detail={"code": "voice_lab_provider_cleanup_malformed"},
        )
    claims = _provider_cleanup_voice_lab_claims(
        cleanup_claims,
        user_id=user_id,
        provider_session_id=provider_session_id,
    )

    from app.gateway.routers.sessions import _store

    record = _store.find_session_by_cleanup_obligation_id(
        cleanup_claims.cleanup_obligation_id
    )
    if record is not None:
        assert_voice_lab_session_record(record, claims)
        metadata = getattr(record, "metadata", None)
        synthetic = (
            metadata.get("synthetic_voice_lab")
            if isinstance(metadata, dict)
            else None
        )
        current_retention_expires_at = (
            synthetic.get("retention_expires_at")
            if isinstance(synthetic, dict)
            else None
        )
        try:
            token_retention_deadline = datetime.fromisoformat(
                cleanup_claims.retention_expires_at.replace("Z", "+00:00")
            ).astimezone(UTC)
            current_retention_deadline = datetime.fromisoformat(
                str(current_retention_expires_at).replace("Z", "+00:00")
            ).astimezone(UTC)
        except (TypeError, ValueError):
            token_retention_deadline = None
            current_retention_deadline = None
        if (
            not isinstance(synthetic, dict)
            or synthetic.get("voice_runtime_session_id") != provider_session_id
            or synthetic.get("cleanup_provider_admission_id")
            != cleanup_claims.cleanup_provider_admission_id
            or token_retention_deadline is None
            or current_retention_deadline is None
            or token_retention_deadline > current_retention_deadline
            or metadata.get("expected_deployment")
            != cleanup_claims.expected_deployment
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_cleanup_binding_mismatch"},
            )
    return claims, cleanup_claims.cleanup_provider_admission_id


def _persisted_provider_trace_fault_restore_receipt(
    claims: VoiceLabClaims,
    *,
    provider_session_id: str,
    cleanup_provider_admission_id: str,
) -> dict[str, object] | None:
    """Read the exact owning Voice relay-zero receipt from canonical state."""

    from app.gateway.routers.sessions import _store
    from app.gateway.routers.voice_lab_recovery import (
        _canonical_provider_trace_fault_restore_receipt,
    )

    record = _store.find_session_by_cleanup_obligation_id(
        claims.cleanup_obligation_id
    )
    if record is None:
        return None
    assert_voice_lab_session_record(record, claims)
    metadata = getattr(record, "metadata", None)
    synthetic = (
        metadata.get("synthetic_voice_lab")
        if isinstance(metadata, dict)
        else None
    )
    if (
        not isinstance(synthetic, dict)
        or synthetic.get("voice_runtime_session_id") != provider_session_id
        or synthetic.get("cleanup_provider_admission_id")
        != cleanup_provider_admission_id
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_cleanup_binding_mismatch"},
        )
    stored = synthetic.get("voice_provider_trace_fault_restore_receipt")
    if stored is None:
        return None
    if (
        not isinstance(stored, dict)
        or set(stored)
        != {
            "schema",
            "cleanup_obligation_id",
            "cleanup_provider_admission_id",
            "provider_session_id",
            "trace_fault",
        }
        or stored.get("schema")
        != "sophia_voice_lab_provider_trace_fault_terminal_v1"
        or stored.get("cleanup_obligation_id") != claims.cleanup_obligation_id
        or stored.get("cleanup_provider_admission_id")
        != cleanup_provider_admission_id
        or stored.get("provider_session_id") != provider_session_id
        or not isinstance(stored.get("trace_fault"), dict)
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_trace_fault_restore_receipt_invalid"},
        )
    return _canonical_provider_trace_fault_restore_receipt(
        record,
        stored["trace_fault"],
    )


def _canonical_voice_lab_session_for_connect(
    user_id: str,
    logical_session_id: str | None,
    claims: VoiceLabClaims,
) -> Any:
    if not logical_session_id:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_canonical_session_required"},
        )
    from app.gateway.routers.sessions import _store

    record = _store.get(user_id, logical_session_id)
    if record is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_session_record_not_found"},
        )
    assert_voice_lab_session_record(record, claims)
    return record


def _bind_synthetic_provider_session(
    user_id: str,
    canonical_session_id: str,
    provider_session_id: str,
    claims: VoiceLabClaims,
    cleanup_admission: Any,
    provider_connection_epoch: int,
    provider_resource_expires_at: datetime,
    voice_runtime_instance_id_sha256: str | None = None,
    voice_runtime_instance_public_key_spki_base64: str | None = None,
) -> bool:
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import bind_cleanup_provider_session

    record = _store.get(user_id, canonical_session_id)
    if record is None:
        return False
    assert_voice_lab_session_record(record, claims)
    synthetic = dict(record.metadata.get("synthetic_voice_lab") or {})
    if (
        getattr(cleanup_admission, "resource_id", None) != provider_session_id
        or getattr(cleanup_admission, "resource_expires_at", None)
        != provider_resource_expires_at
    ):
        return False
    provider_owner: dict[str, str] | None = None
    if claims.scenario_id == "V-D02":
        expected_deployment = record.metadata.get("expected_deployment")
        voice_deployment = (
            expected_deployment.get("voice")
            if isinstance(expected_deployment, dict)
            else None
        )
        try:
            public_bytes = (
                base64.b64decode(
                    voice_runtime_instance_public_key_spki_base64,
                    validate=True,
                )
                if isinstance(
                    voice_runtime_instance_public_key_spki_base64, str
                )
                else b""
            )
            public_key = serialization.load_der_public_key(public_bytes)
        except (TypeError, ValueError):
            return False
        if (
            not isinstance(public_key, Ed25519PublicKey)
            or not isinstance(voice_runtime_instance_id_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", voice_runtime_instance_id_sha256)
            or hashlib.sha256(public_bytes).hexdigest()
            != voice_runtime_instance_id_sha256
            or base64.b64encode(public_bytes).decode("ascii")
            != voice_runtime_instance_public_key_spki_base64
            or not isinstance(voice_deployment, str)
            or not re.fullmatch(r"[a-f0-9]{40}", voice_deployment)
        ):
            return False
        provider_owner = {
            "voice_runtime_owner_deployment_sha": voice_deployment,
            "voice_runtime_instance_id_sha256": voice_runtime_instance_id_sha256,
            "voice_runtime_instance_public_key_spki_base64": (
                voice_runtime_instance_public_key_spki_base64
            ),
        }
    elif (
        voice_runtime_instance_id_sha256 is not None
        or voice_runtime_instance_public_key_spki_base64 is not None
    ):
        provider_owner = None
    bound = bind_cleanup_provider_session(
        cleanup_admission,
        user_id=user_id,
        session_id=canonical_session_id,
        provider_connection_epoch=provider_connection_epoch,
        provider_owner=provider_owner,
        existing_synthetic=synthetic,
        local_persist=lambda expected, updates: (
            _persist_synthetic_provider_metadata_if_unchanged(
                _store,
                user_id=user_id,
                session_id=canonical_session_id,
                expected=expected,
                updates=updates,
            )
        ),
    )
    return bound.status == "credential_minted"


def _abort_unpublished_synthetic_provider_session(
    user_id: str,
    canonical_session_id: str,
    provider_session_id: str,
    claims: VoiceLabClaims,
    cleanup_admission: Any,
    provider_connection_epoch: int,
) -> bool:
    """Atomically close a bound credential that no browser could receive."""

    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        abort_unpublished_cleanup_provider_session,
    )

    record = _store.get(user_id, canonical_session_id)
    if record is None:
        return False
    assert_voice_lab_session_record(record, claims)
    metadata = getattr(record, "metadata", None)
    synthetic = (
        dict(metadata.get("synthetic_voice_lab") or {})
        if isinstance(metadata, dict)
        else {}
    )
    retention_expires_at = synthetic.get("retention_expires_at")
    aborted = abort_unpublished_cleanup_provider_session(
        cleanup_admission,
        user_id=user_id,
        session_id=canonical_session_id,
        expected_pending_epoch=provider_connection_epoch,
        existing_synthetic=synthetic,
        retention_expires_at=retention_expires_at,
        provider_expires_at=claims.provider_expires_at,
        local_persist=lambda expected, updates: (
            _persist_synthetic_provider_metadata_if_unchanged(
                _store,
                user_id=user_id,
                session_id=canonical_session_id,
                expected=expected,
                updates=updates,
            )
        ),
    )
    return aborted.status == "activation_aborted"


def _persist_synthetic_provider_metadata_if_unchanged(
    store: object,
    *,
    user_id: str,
    session_id: str,
    expected: dict[str, object],
    updates: dict[str, object],
) -> bool:
    """CAS provider-owned keys without overwriting finalization metadata."""

    current = store.get(user_id, session_id)
    current_metadata = getattr(current, "metadata", None)
    current_synthetic = (
        current_metadata.get("synthetic_voice_lab")
        if isinstance(current_metadata, dict)
        else None
    )
    if not isinstance(current_synthetic, dict) or any(
        current_synthetic.get(key) != value for key, value in expected.items()
    ):
        return False
    next_synthetic = dict(current_synthetic)
    next_synthetic.update(updates)
    next_metadata = dict(current_metadata)
    next_metadata["synthetic_voice_lab"] = next_synthetic
    return store.update(user_id, session_id, metadata=next_metadata) is not None


def _record_synthetic_browser_provider_activation(
    claims: VoiceLabClaims,
    provider_session_id: str,
    receipt: "GeminiBrowserProviderActivationReceipt",
) -> dict[str, object]:
    """Promote only the exact browser-open candidate into the canonical epoch."""

    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        activate_cleanup_provider_session,
        cleanup_admissions,
    )

    record = _store.find_session_by_cleanup_obligation_id(
        claims.cleanup_obligation_id
    )
    if record is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_session_record_not_found"},
        )
    assert_voice_lab_session_record(record, claims)
    metadata = dict(record.metadata)
    synthetic = dict(metadata.get("synthetic_voice_lab") or {})
    admission_id = synthetic.get("cleanup_provider_admission_id")
    current_epoch = synthetic.get("voice_provider_connection_epoch")
    pending_epoch = synthetic.get("voice_provider_pending_connection_epoch")
    expected_previous_epoch = current_epoch if isinstance(current_epoch, int) else 0
    idempotent_activation = (
        synthetic.get("voice_provider_resource_state") == "active"
        and current_epoch == receipt.candidate_epoch
        and pending_epoch is None
        and receipt.previous_activated_epoch == receipt.candidate_epoch - 1
    )
    pending_activation = (
        pending_epoch == receipt.candidate_epoch
        and receipt.previous_activated_epoch == expected_previous_epoch
        and receipt.candidate_epoch == expected_previous_epoch + 1
    )
    if (
        receipt.session_id != provider_session_id
        or synthetic.get("voice_runtime_session_id") != provider_session_id
        or not isinstance(admission_id, str)
        or not (pending_activation or idempotent_activation)
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_activation_binding_mismatch"},
        )
    try:
        opened_at = datetime.fromisoformat(
            receipt.websocket_opened_at.replace("Z", "+00:00")
        ).astimezone(UTC)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_provider_activation_receipt_malformed"},
        ) from None
    if (
        opened_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        != receipt.websocket_opened_at
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_provider_activation_receipt_malformed"},
        )
    previous_close = receipt.previous_socket_close_receipt
    if receipt.previous_activated_epoch == 0:
        if previous_close is not None:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_activation_previous_close_unexpected"},
            )
        canonical_previous_close: dict[str, object] | None = None
    else:
        if (
            previous_close is None
            or previous_close.session_id != provider_session_id
            or previous_close.provider_connection_epoch
            != receipt.previous_activated_epoch
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_activation_previous_close_missing"},
            )
        try:
            previous_closed_at = datetime.fromisoformat(
                previous_close.websocket_closed_at.replace("Z", "+00:00")
            ).astimezone(UTC)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_provider_activation_receipt_malformed"},
            ) from None
        if (
            previous_closed_at.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            )
            != previous_close.websocket_closed_at
        ):
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_provider_activation_receipt_malformed"},
            )
        canonical_previous_close = previous_close.model_dump(mode="json")
    canonical_receipt = {
        "schema": receipt.schema,
        "activation_id": str(receipt.activation_id),
        "session_id": provider_session_id,
        "previous_activated_epoch": receipt.previous_activated_epoch,
        "candidate_epoch": receipt.candidate_epoch,
        "websocket_open_observed": True,
        "close_observer_attached": True,
        "websocket_opened_at": receipt.websocket_opened_at,
        "previous_socket_close_receipt": canonical_previous_close,
    }
    matches = [
        admission
        for admission in cleanup_admissions(claims.cleanup_obligation_id)
        if admission.admission_id == admission_id
        and admission.resource_kind == "provider"
        and admission.resource_id == provider_session_id
    ]
    if len(matches) != 1 or matches[0].status not in {
        "credential_minted",
        "browser_active",
    }:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_admission_binding_missing"},
        )
    stored_receipt = synthetic.get("voice_provider_activation_receipt")
    expected_synthetic = {
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "cleanup_provider_admission_id": admission_id,
        "voice_runtime_session_id": provider_session_id,
        "voice_provider_resource_state": synthetic.get(
            "voice_provider_resource_state"
        ),
        "voice_provider_connection_epoch": current_epoch,
        "voice_provider_pending_connection_epoch": pending_epoch,
        "voice_provider_activation_receipt": stored_receipt,
    }
    if idempotent_activation:
        if stored_receipt != canonical_receipt or matches[0].status != "browser_active":
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_activation_receipt_conflict"},
            )
    else:
        synthetic.update(
            {
                "voice_provider_resource_state": "active",
                "voice_provider_connection_epoch": receipt.candidate_epoch,
                "voice_provider_pending_connection_epoch": None,
                "voice_provider_activated_at": datetime.now(UTC).isoformat(
                    timespec="milliseconds"
                ).replace("+00:00", "Z"),
                "voice_provider_activation_receipt": canonical_receipt,
            }
        )
        metadata["synthetic_voice_lab"] = synthetic
    try:
        activate_cleanup_provider_session(
            matches[0],
            user_id=record.user_id,
            session_id=record.session_id,
            metadata=metadata,
            expected_synthetic=expected_synthetic,
            local_persist=lambda expected, updates: (
                _persist_synthetic_provider_metadata_if_unchanged(
                    _store,
                    user_id=record.user_id,
                    session_id=record.session_id,
                    expected=expected,
                    updates=updates,
                )
            ),
        )
    except Exception as exc:  # noqa: BLE001 - one atomic fail-closed transition.
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_provider_activation_persistence_failed"},
        ) from exc
    return canonical_receipt


def _canonical_browser_provider_settlement(
    provider_session_id: str,
    close_receipts: list["GeminiBrowserProviderCloseReceipt"],
    activation_abort_receipts: list["GeminiBrowserProviderActivationAbortReceipt"],
) -> tuple[list[dict[str, object]], list[dict[str, object]], str]:
    close_by_epoch: dict[int, dict[str, object]] = {}
    for receipt in close_receipts:
        if (
            receipt.session_id != provider_session_id
            or receipt.provider_connection_epoch in close_by_epoch
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_browser_close_binding_mismatch"},
            )
        try:
            closed_at = datetime.fromisoformat(
                receipt.websocket_closed_at.replace("Z", "+00:00")
            ).astimezone(UTC)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_browser_close_receipt_malformed"},
            ) from None
        if (
            closed_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            != receipt.websocket_closed_at
        ):
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_browser_close_receipt_malformed"},
            )
        close_by_epoch[receipt.provider_connection_epoch] = receipt.model_dump(
            mode="json"
        )

    abort_by_epoch: dict[int, dict[str, object]] = {}
    for receipt in activation_abort_receipts:
        if (
            receipt.session_id != provider_session_id
            or receipt.candidate_epoch in abort_by_epoch
            or receipt.candidate_epoch != receipt.previous_activated_epoch + 1
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_activation_abort_binding_mismatch"},
            )
        try:
            aborted_at = datetime.fromisoformat(
                receipt.aborted_at.replace("Z", "+00:00")
            ).astimezone(UTC)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_provider_activation_abort_malformed"},
            ) from None
        if (
            aborted_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            != receipt.aborted_at
        ):
            raise HTTPException(
                status_code=422,
                detail={"code": "voice_lab_provider_activation_abort_malformed"},
            )
        abort_by_epoch[receipt.candidate_epoch] = receipt.model_dump(mode="json")

    if set(close_by_epoch).intersection(abort_by_epoch):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_settlement_conflict"},
        )
    canonical_close_receipts = [
        close_by_epoch[epoch] for epoch in sorted(close_by_epoch)
    ]
    canonical_abort_receipts = [
        abort_by_epoch[epoch] for epoch in sorted(abort_by_epoch)
    ]
    encoded = json.dumps(
        {
            "browser_provider_close_receipts": canonical_close_receipts,
            "browser_provider_activation_abort_receipts": canonical_abort_receipts,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return (
        canonical_close_receipts,
        canonical_abort_receipts,
        hashlib.sha256(encoded).hexdigest(),
    )


def _record_synthetic_browser_provider_close(
    claims: VoiceLabClaims,
    provider_session_id: str,
    close_receipts: list["GeminiBrowserProviderCloseReceipt"],
    activation_abort_receipts: list["GeminiBrowserProviderActivationAbortReceipt"],
    *,
    expected_cleanup_provider_admission_id: str | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Persist exact closure/abort proof for every potentially live epoch."""

    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        close_cleanup_provider_session,
        verify_cleanup_provider_settlement_replay,
    )

    (
        canonical_close_receipts,
        canonical_abort_receipts,
        settlement_sha256,
    ) = _canonical_browser_provider_settlement(
        provider_session_id,
        close_receipts,
        activation_abort_receipts,
    )
    close_by_epoch = {
        int(receipt["provider_connection_epoch"]): receipt
        for receipt in canonical_close_receipts
    }
    abort_by_epoch = {
        int(receipt["candidate_epoch"]): receipt
        for receipt in canonical_abort_receipts
    }
    record = _store.find_session_by_cleanup_obligation_id(
        claims.cleanup_obligation_id
    )
    if record is None:
        try:
            replay_matches = verify_cleanup_provider_settlement_replay(
                claims.cleanup_obligation_id,
                settlement_sha256,
            )
        except Exception as exc:  # noqa: BLE001 - fail closed on replay lookup.
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_provider_settlement_replay_unavailable"},
            ) from exc
        if replay_matches:
            return canonical_close_receipts, canonical_abort_receipts
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_session_record_not_found"},
        )
    assert_voice_lab_session_record(record, claims)
    metadata = dict(record.metadata)
    synthetic = dict(metadata.get("synthetic_voice_lab") or {})
    admission_id = synthetic.get("cleanup_provider_admission_id")
    expected_provider_session_id = synthetic.get("voice_runtime_session_id")
    expected_provider_state = synthetic.get("voice_provider_resource_state")
    activated_epoch = synthetic.get("voice_provider_connection_epoch")
    pending_epoch = synthetic.get("voice_provider_pending_connection_epoch")
    expected_activation_receipt = synthetic.get("voice_provider_activation_receipt")
    if (
        expected_provider_session_id != provider_session_id
        or not isinstance(admission_id, str)
        or (
            expected_cleanup_provider_admission_id is not None
            and admission_id != expected_cleanup_provider_admission_id
        )
        or expected_provider_state not in {"credential_minted", "active", "closed"}
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_browser_close_binding_mismatch"},
        )
    stored_close_receipts = synthetic.get("voice_provider_browser_close_receipts")
    stored_abort_receipts = synthetic.get("voice_provider_activation_abort_receipts")
    if expected_provider_state == "closed":
        if (
            stored_close_receipts != canonical_close_receipts
            or stored_abort_receipts != canonical_abort_receipts
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_browser_close_receipt_conflict"},
            )
        try:
            replay_matches = verify_cleanup_provider_settlement_replay(
                claims.cleanup_obligation_id,
                settlement_sha256,
            )
        except Exception as exc:  # noqa: BLE001 - fail closed on replay lookup.
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_provider_settlement_replay_unavailable"},
            ) from exc
        if not replay_matches:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_browser_close_receipt_conflict"},
            )
        return canonical_close_receipts, canonical_abort_receipts
    expected_epochs = {
        epoch
        for epoch in (activated_epoch, pending_epoch)
        if isinstance(epoch, int) and epoch > 0
    }
    if not expected_epochs:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_browser_close_epoch_missing"},
        )

    expected_previous_epoch = activated_epoch if isinstance(activated_epoch, int) else 0
    if any(
        epoch != pending_epoch
        or int(receipt["previous_activated_epoch"]) != expected_previous_epoch
        for epoch, receipt in abort_by_epoch.items()
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_activation_abort_binding_mismatch"},
        )
    settled_epochs = set(close_by_epoch).union(abort_by_epoch)
    stored_activation = synthetic.get("voice_provider_activation_receipt")
    allowed_previous_close: dict[str, object] | None = None
    if isinstance(stored_activation, dict):
        candidate = stored_activation.get("previous_socket_close_receipt")
        if isinstance(candidate, dict):
            allowed_previous_close = candidate
    extra_epochs = settled_epochs - expected_epochs
    if extra_epochs:
        allowed_extra_epochs: set[int] = set()
        if allowed_previous_close is not None:
            previous_close_epoch = allowed_previous_close.get(
                "provider_connection_epoch"
            )
            if (
                isinstance(previous_close_epoch, int)
                and close_by_epoch.get(previous_close_epoch)
                == allowed_previous_close
            ):
                allowed_extra_epochs.add(previous_close_epoch)
        if (
            expected_provider_state == "active"
            and isinstance(activated_epoch, int)
            and not isinstance(pending_epoch, int)
        ):
            speculative_candidate = activated_epoch + 1
            speculative_abort = abort_by_epoch.get(speculative_candidate)
            if (
                speculative_abort is not None
                and speculative_abort.get("previous_activated_epoch")
                == activated_epoch
            ):
                # The browser initiated this exact continuation but may lose the
                # staged response. Closing under the obligation lock makes a
                # queued stage lose while proving no candidate socket existed.
                allowed_extra_epochs.add(speculative_candidate)
        if not extra_epochs.issubset(allowed_extra_epochs):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_settlement_epoch_mismatch"},
            )
    if not expected_epochs.issubset(settled_epochs):
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_settlement_incomplete"},
        )

    matches = [
        admission
        for admission in cleanup_admissions(claims.cleanup_obligation_id)
        if admission.admission_id == admission_id
        and admission.resource_kind == "provider"
        and admission.resource_id == provider_session_id
    ]
    if len(matches) != 1 or matches[0].status not in {
        "credential_minted",
        "browser_active",
        "activation_aborted",
        "browser_closed",
    }:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provider_admission_binding_missing"},
        )
    retention_expires_at = synthetic.get("retention_expires_at")
    initial_activation_aborted = (
        expected_provider_state == "credential_minted"
        and not isinstance(activated_epoch, int)
        and isinstance(pending_epoch, int)
        and pending_epoch in abort_by_epoch
        and not close_by_epoch
    ) or (
        expected_provider_state == "credential_minted"
        and activated_epoch == 0
        and isinstance(pending_epoch, int)
        and pending_epoch in abort_by_epoch
        and not close_by_epoch
    )
    terminal_status = (
        "activation_aborted" if initial_activation_aborted else "browser_closed"
    )
    synthetic.update(
        {
            "voice_provider_resource_state": "closed",
            "voice_provider_closed_at": datetime.now(UTC).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z"),
            "voice_provider_pending_connection_epoch": None,
            "voice_provider_browser_close_receipts": canonical_close_receipts,
            "voice_provider_activation_abort_receipts": canonical_abort_receipts,
        }
    )
    metadata["synthetic_voice_lab"] = synthetic

    try:
        close_cleanup_provider_session(
            matches[0],
            user_id=record.user_id,
            session_id=record.session_id,
            metadata=metadata,
            expected_provider_state=str(expected_provider_state),
            expected_activated_epoch=(
                activated_epoch if isinstance(activated_epoch, int) else None
            ),
            expected_pending_epoch=(
                pending_epoch if isinstance(pending_epoch, int) else None
            ),
            expected_activation_receipt=expected_activation_receipt,
            terminal_status=terminal_status,
            settlement_sha256=settlement_sha256,
            retention_expires_at=retention_expires_at,
            provider_expires_at=claims.provider_expires_at,
            local_persist=lambda expected, updates: (
                _persist_synthetic_provider_metadata_if_unchanged(
                    _store,
                    user_id=record.user_id,
                    session_id=record.session_id,
                    expected=expected,
                    updates=updates,
                )
            ),
        )
    except Exception as exc:  # noqa: BLE001 - one atomic fail-closed transition.
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_browser_close_fence_unavailable"},
        ) from exc
    return canonical_close_receipts, canonical_abort_receipts


def _stage_synthetic_provider_connection_epoch(
    claims: VoiceLabClaims,
    provider_session_id: str,
    *,
    expected_epoch: int,
    next_epoch: int,
) -> bool:
    """Persist one minted candidate without advancing the activated epoch."""

    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        stage_cleanup_provider_candidate,
    )

    record = _store.find_session_by_cleanup_obligation_id(
        claims.cleanup_obligation_id
    )
    if record is None:
        return False
    assert_voice_lab_session_record(record, claims)
    metadata = dict(record.metadata)
    synthetic = dict(metadata.get("synthetic_voice_lab") or {})
    admission_id = synthetic.get("cleanup_provider_admission_id")
    if (
        synthetic.get("voice_provider_resource_state") != "active"
        or synthetic.get("voice_runtime_session_id") != provider_session_id
        or synthetic.get("voice_provider_connection_epoch") != expected_epoch
        or synthetic.get("voice_provider_resource_expires_at")
        != claims.provider_expires_at
        or not isinstance(admission_id, str)
        or next_epoch != expected_epoch + 1
    ):
        return False
    if synthetic.get("voice_provider_pending_connection_epoch") not in {None, next_epoch}:
        return False
    expected_pending_epoch = synthetic.get("voice_provider_pending_connection_epoch")
    matches = [
        admission
        for admission in cleanup_admissions(claims.cleanup_obligation_id)
        if admission.admission_id == admission_id
        and admission.resource_kind == "provider"
        and admission.resource_id == provider_session_id
        and admission.status == "browser_active"
    ]
    if len(matches) != 1:
        return False
    try:
        stage_cleanup_provider_candidate(
            matches[0],
            user_id=record.user_id,
            session_id=record.session_id,
            expected_epoch=expected_epoch,
            expected_pending_epoch=(
                expected_pending_epoch
                if isinstance(expected_pending_epoch, int)
                else None
            ),
            next_epoch=next_epoch,
            local_persist=lambda expected, updates: (
                _persist_synthetic_provider_metadata_if_unchanged(
                    _store,
                    user_id=record.user_id,
                    session_id=record.session_id,
                    expected=expected,
                    updates=updates,
                )
            ),
        )
    except Exception:  # noqa: BLE001 - one fail-closed persistence boundary.
        return False
    return True


def _voice_lab_claims_for_active_session(
    request: Request,
    user_id: str,
    session_id: str,
    *,
    required_operation: str,
) -> VoiceLabClaims | None:
    claims = capability_for_gateway_action(
        request,
        user_id,
        required_operation=required_operation,
    )
    active_session = _active_voice_sessions.get(user_id)
    if claims is None:
        if active_session is not None and active_session.voice_lab_binding is not None:
            raise HTTPException(
                status_code=401,
                detail={"code": "voice_lab_capability_missing"},
            )
        return None
    if (
        active_session is None
        or active_session.runtime != "gemini_live"
        or active_session.session_id != session_id
        or active_session.voice_lab_binding != _voice_lab_active_binding(claims)
    ):
        from app.gateway.routers.sessions import _store

        record = _store.find_session_by_cleanup_obligation_id(
            claims.cleanup_obligation_id
        )
        if record is not None:
            assert_voice_lab_session_record(record, claims)
            record_metadata = getattr(record, "metadata", None)
            synthetic = (
                record_metadata.get("synthetic_voice_lab")
                if isinstance(record_metadata, dict)
                else None
            )
            if (
                isinstance(synthetic, dict)
                and synthetic.get("voice_runtime_session_id") == session_id
            ):
                if required_operation == "session:finalize":
                    return claims
                admission_id = synthetic.get("cleanup_provider_admission_id")
                if isinstance(admission_id, str):
                    try:
                        from deerflow.sophia.cleanup_fence import (
                            inspect_cleanup_admission,
                        )

                        admission = inspect_cleanup_admission(
                            admission_id=admission_id,
                            cleanup_obligation_id=claims.cleanup_obligation_id,
                            resource_kind="provider",
                            resource_id=session_id,
                        )
                    except Exception:  # noqa: BLE001 - CLOSED is fail-closed.
                        pass
                    else:
                        if admission.status in {
                            "credential_minted",
                            "browser_active",
                        }:
                            return claims
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_active_session_binding_mismatch"},
        )
    return claims


def _voice_auth_request_kwargs(extra: dict[str, str] | None = None) -> dict[str, dict[str, str]]:
    headers = voice_internal_auth_headers(extra)
    return {"headers": headers} if headers else {}


def _voice_event_cursor(request: Request) -> int | None:
    candidates = (
        request.headers.get("last-event-id"),
        request.query_params.get("last_event_id"),
        request.query_params.get("lastEventId"),
    )
    for raw_cursor in candidates:
        if raw_cursor is None:
            continue
        try:
            cursor = int(raw_cursor)
        except (TypeError, ValueError):
            continue
        if cursor >= 0:
            return cursor
    return None


def _voice_event_upstream_request(
    url: str,
    cursor: int | None,
) -> tuple[str, dict[str, str]]:
    headers = voice_internal_auth_headers({"Accept": "text/event-stream"})
    if cursor is None:
        return url, headers

    separator = "&" if "?" in url else "?"
    headers["Last-Event-ID"] = str(cursor)
    return f"{url}{separator}last_event_id={cursor}", headers


async def _get_active_voice_session_lock(user_id: str) -> asyncio.Lock:
    async with _active_voice_session_locks_guard:
        return _active_voice_session_locks.setdefault(user_id, asyncio.Lock())


class VoiceConnectRequest(BaseModel):
    """Request body for establishing a voice session."""

    platform: str = Field(..., description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(default=None, description="Active ritual: prepare | debrief | vent | reset | None")
    session_id: str | None = Field(
        default=None,
        description="Frontend companion session ID for continuity",
    )
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID to reuse for this voice session",
    )
    preconnect: bool = Field(
        default=False,
        description=(
            "Best-effort frontend warmup request. Legacy returns a Stream session; "
            "Gemini production returns a short-lived browser bootstrap without opening "
            "the user's microphone or provider WebSocket."
        ),
    )


class VoiceConnectResponse(BaseModel):
    """Credentials the frontend needs to join the Stream call."""

    runtime: Literal["legacy_cascade"] = "legacy_cascade"
    voice_runtime: Literal["legacy_cascade"] = "legacy_cascade"
    api_key: str
    token: str
    call_type: str
    call_id: str
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID associated with this voice session",
    )
    stream_url: str | None = Field(
        default=None,
        description="Browser-facing SSE endpoint for Sophia transcript and artifact events",
    )
    session_id: str | None = Field(
        default=None,
        description="Voice agent session ID (from Vision Agents server)",
    )


class GeminiVoiceConnectResponse(BaseModel):
    """Production Gemini browser Live bootstrap returned only when explicitly enabled."""

    runtime: Literal["gemini_live"]
    voice_runtime: Literal["gemini_live"]
    production_route: Literal[True]
    session_id: str
    logical_session_id: str | None = None
    voice_runtime_session_id: str | None = None
    voice_runtime_instance_id_sha256: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$"
    )
    voice_runtime_instance_public_key_spki_base64: str | None = None
    thread_id: str | None = None
    stream_url: str
    event_stream_url: str
    provider_event_relay_url: str
    disconnect_url: str
    browser_audio: str
    transport: str
    websocket_url: str
    websocket_auth: str
    ephemeral_token: dict[str, Any]
    setup: dict[str, Any]
    public_event_boundary: str | None = None
    gemini_voice_name: str | None = None
    gemini_voice_source: str | None = None
    gemini_voice_configured: bool | None = None
    gemini_voice_configured_value_valid: bool | None = None
    gemini_voice_diagnostic: str | None = None
    langsmith_trace_id: str | None = None
    langsmith_trace_unavailable_reason: Literal[
        "synthetic_isolation_policy",
        "governed_synthetic_fault",
    ] | None = None
    trace_fault: dict[str, Any] | None = None
    audio_capture_enabled: bool = False
    backendCoreviewFlagParsed: bool | None = None
    backendStillFrameFlagParsed: bool | None = None
    preconnect: bool = False
    preconnect_ttl_ms: int | None = None
    preconnect_expires_at: str | None = None
    provider_connection_epoch: int = 1
    continuation_bootstrap_url: str | None = None
    provider_activation_url: str | None = None
    provider_cleanup_token: str | None = None
    provider_cleanup_expires_at: str | None = None
    synthetic_test: dict[str, str | bool | int] | None = None


class GeminiVoicePreconnectSkippedResponse(BaseModel):
    """Safe no-op response for background Gemini preconnect attempts."""

    runtime: Literal["gemini_live"] = "gemini_live"
    voice_runtime: Literal["gemini_live"] = "gemini_live"
    production_route: Literal[True] = True
    preconnect: Literal[True] = True
    preconnect_skipped: Literal[True] = True
    preconnect_skipped_reason: Literal["already_active"] = "already_active"
    active_voice_session_exists: Literal[True] = True
    session_id: str | None = None
    thread_id: str | None = None


class VoiceDisconnectRequest(BaseModel):
    """Request body for ending a voice session."""

    call_id: str = Field(..., description="The call_id returned from /voice/connect")
    session_id: str = Field(..., description="The session_id returned from /voice/connect")
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID associated with the session",
    )


class VoiceWarmupRequest(BaseModel):
    """Request body for backend warmup on an active voice session."""

    call_id: str = Field(..., description="The call_id returned from /voice/connect")
    session_id: str = Field(..., description="The session_id returned from /voice/connect")


class OpenAIBrowserDogfoodStartRequest(BaseModel):
    """Start a protected OpenAI browser WebRTC dogfood session."""

    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")
    instructions: str | None = Field(default=None, description="Optional provider session instructions override")


class OpenAISidebandAttachRequest(BaseModel):
    """Attach the protected backend sideband to a browser OpenAI call."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")
    call_id: str | None = Field(default=None, description="OpenAI Realtime rtc_* call id")
    location: str | None = Field(default=None, description="Raw Location header from POST /v1/realtime/calls")
    webrtc_readiness: dict[str, object] | None = Field(
        default=None,
        description="Browser-observed WebRTC readiness evidence collected before sideband attach",
    )


class OpenAIBrowserDogfoodDisconnectRequest(BaseModel):
    """Close a protected OpenAI browser WebRTC dogfood session."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")


class GeminiBrowserDogfoodStartRequest(BaseModel):
    """Start a protected Gemini browser Live WebSocket dogfood session."""

    session_id: str | None = Field(default=None, description="Optional deterministic dogfood session id")


class GeminiSyntheticToolEvidenceRequest(BaseModel):
    """Browser-authored exact effect/input binding; safe identifiers only."""

    model_config = ConfigDict(extra="forbid")

    schema: Literal["sophia_synthetic_tool_evidence_v1"]
    test_run_id: str = Field(min_length=1, max_length=512)
    scenario_id: str = Field(min_length=1, max_length=512)
    scenario_version: str = Field(min_length=1, max_length=512)
    operation_id: str = Field(min_length=1, max_length=512)
    utterance_id: str = Field(min_length=1, max_length=512)
    provider_input_sequence: int = Field(gt=0)
    public_utterance_id: str | None = Field(default=None, min_length=1, max_length=512)
    tool_call_id: str = Field(min_length=1, max_length=512)
    effect_id: str = Field(pattern=r"^effect:[0-9a-f-]{36}$")
    provider_connection_epoch: int = Field(gt=0)
    relay_correlation_id: str = Field(min_length=1, max_length=512)
    tool_name: str = Field(min_length=1, max_length=256)
    received_at: str = Field(min_length=1, max_length=64)


class GeminiBrowserDogfoodRelayRequest(BaseModel):
    """Relay one browser-captured Gemini Live server message."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")
    event: dict[str, object] = Field(..., description="Raw Gemini Live server message payload")
    provider_receive_sequence: int | None = Field(
        default=None,
        gt=0,
        description="Browser-assigned monotonic Gemini WebSocket receive sequence for this provider message",
    )
    provider_relay_sequence: int | None = Field(
        default=None,
        gt=0,
        description="Browser-assigned monotonic sequence for relayed Gemini provider messages",
    )
    provider_connection_epoch: int | None = Field(
        default=None,
        gt=0,
        description="Browser-authored provider connection generation for this message",
    )
    provider_received_at: str | None = Field(
        default=None,
        description="Browser ISO timestamp recorded when the provider WebSocket message was received",
    )
    relay_correlation_id: str | None = Field(
        default=None,
        description="Browser-stable relay correlation id derived at provider receive time",
    )
    provider_primary_category: str | None = Field(
        default=None,
        description="Browser-classified primary provider event category",
    )
    provider_categories: list[str] | None = Field(
        default=None,
        description="Browser-classified provider event categories",
    )
    artifact_review_context: dict[str, object] | None = Field(
        default=None,
        description="Browser-safe artifact review context for suppressing review-only artifact churn",
    )
    synthetic_tool_evidence: list[GeminiSyntheticToolEvidenceRequest] = Field(
        default_factory=list,
        max_length=16,
        description="Exact browser-authored synthetic operation/effect bindings for tool calls in this event",
    )

    def voice_relay_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "event": _apply_artifact_review_tool_defaults(
                self.event,
                self.artifact_review_context,
            )
        }
        for key in (
            "provider_receive_sequence",
            "provider_relay_sequence",
            "provider_connection_epoch",
            "provider_received_at",
            "relay_correlation_id",
            "provider_primary_category",
            "provider_categories",
        ):
            value = getattr(self, key)
            if value is not None:
                payload[key] = value
        if self.synthetic_tool_evidence:
            payload["synthetic_tool_evidence"] = [
                item.model_dump(mode="json") for item in self.synthetic_tool_evidence
            ]
        return payload


class GeminiBrowserDogfoodDisconnectRequest(BaseModel):
    """Close a protected Gemini browser Live WebSocket dogfood session."""

    session_id: str = Field(..., description="Dogfood session id returned by browser-session")
    conversation_audio_base64: str | None = Field(
        default=None,
        max_length=28_000_000,
        description="Optional browser-recorded combined conversation audio",
    )
    conversation_audio_mime_type: str = Field(
        default="audio/webm",
        description="MIME type for the optional combined conversation recording",
    )
    browser_provider_close_receipt: "GeminiBrowserProviderCloseReceipt | None" = None
    browser_provider_close_receipts: list["GeminiBrowserProviderCloseReceipt"] = Field(
        default_factory=list,
        max_length=8,
    )
    browser_provider_activation_abort_receipts: list[
        "GeminiBrowserProviderActivationAbortReceipt"
    ] = Field(default_factory=list, max_length=8)


class GeminiBrowserProviderCloseReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema: Literal["sophia_gemini_browser_provider_close_v1"]
    receipt_id: UUID
    session_id: str = Field(min_length=1, max_length=128)
    provider_connection_epoch: int = Field(gt=0)
    websocket_close_observed: Literal[True]
    websocket_close_code: int = Field(ge=1000, le=4999)
    websocket_closed_at: str = Field(
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
    )


class GeminiBrowserProviderActivationAbortReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema: Literal["sophia_gemini_browser_provider_activation_abort_v1"]
    receipt_id: UUID
    session_id: str = Field(min_length=1, max_length=128)
    previous_activated_epoch: int = Field(ge=0)
    candidate_epoch: int = Field(gt=0)
    websocket_created: Literal[False]
    aborted_at: str = Field(
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
    )


class GeminiBrowserProviderActivationReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema: Literal["sophia_gemini_browser_provider_activation_v1"]
    activation_id: UUID
    session_id: str = Field(min_length=1, max_length=128)
    previous_activated_epoch: int = Field(ge=0)
    candidate_epoch: int = Field(gt=0)
    websocket_open_observed: Literal[True]
    close_observer_attached: Literal[True]
    websocket_opened_at: str = Field(
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
    )
    previous_socket_close_receipt: GeminiBrowserProviderCloseReceipt | None


class GeminiContinuationBootstrapRequest(BaseModel):
    expected_epoch: int = Field(..., gt=0)
    handle_present: bool = False
    secret_generation: int = Field(default=0, ge=0)


@lru_cache(maxsize=1)
def _get_voice_env_fallback() -> dict[str, str]:
    values: dict[str, str] = {}

    for env_file in (REPO_ROOT / "voice" / ".env", BACKEND_DIR / ".env", REPO_ROOT / ".env"):
        if not env_file.exists():
            continue

        for key, value in dotenv_values(env_file).items():
            if key in values or value is None:
                continue

            stripped = value.strip()
            if stripped:
                values[key] = stripped

    return values


def _get_configured_env(name: str) -> str:
    direct_value = os.getenv(name, "").strip()
    if direct_value:
        return direct_value

    return _get_voice_env_fallback().get(name, "")


def _get_configured_bool(name: str, default: bool = False) -> bool:
    value = _get_configured_env(name)
    if not value:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_configured_voice_runtime_mode() -> str:
    configured_mode = _get_configured_env("SOPHIA_VOICE_RUNTIME_MODE")
    if configured_mode:
        return configured_mode.strip().lower().replace("-", "_")

    if _gemini_production_route_enabled():
        return "gemini_live"

    return "legacy_cascade"


def _gemini_production_route_enabled() -> bool:
    return _get_configured_bool(GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG, False)


def _get_stream_api_key() -> str:
    key = _get_configured_env("STREAM_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="STREAM_API_KEY not configured")
    return key


def _get_stream_api_secret() -> str:
    secret = _get_configured_env("STREAM_API_SECRET")
    if not secret:
        raise HTTPException(status_code=503, detail="STREAM_API_SECRET not configured")
    return secret


def _sanitize_call_id_fragment(value: str) -> str:
    """Normalize user-derived fragments to the voice server's call_id charset."""

    normalized = re.sub(r"[^a-z0-9_-]+", "-", value.lower()).strip("-_")
    return normalized or "user"


def _build_voice_events_stream_url(user_id: str, call_id: str, session_id: str | None) -> str | None:
    if not session_id:
        return None

    encoded_user_id = quote(user_id, safe="")
    encoded_call_id = quote(call_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return (
        f"/api/sophia/{encoded_user_id}/voice/events"
        f"?call_id={encoded_call_id}&session_id={encoded_session_id}"
    )


def _build_openai_dogfood_events_stream_url(user_id: str, session_id: str) -> str:
    encoded_user_id = quote(user_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/{encoded_user_id}/voice/dogfood/openai/events?session_id={encoded_session_id}"


def _build_gemini_dogfood_events_stream_url(user_id: str, session_id: str) -> str:
    encoded_user_id = quote(user_id, safe="")
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/{encoded_user_id}/voice/dogfood/gemini/events?session_id={encoded_session_id}"


def _build_gemini_production_events_stream_url(session_id: str) -> str:
    encoded_session_id = quote(session_id, safe="")
    return f"/api/sophia/voice/gemini/events?session_id={encoded_session_id}"


def _build_gemini_production_relay_url() -> str:
    return "/api/sophia/voice/gemini/relay"


def _build_gemini_production_disconnect_url() -> str:
    return "/api/sophia/voice/gemini/disconnect"


def _safe_prefix(value: object, *, length: int = 24) -> str | None:
    return value[:length] if isinstance(value, str) and value else None


def _safe_voice_error_detail(detail: object) -> str | None:
    if isinstance(detail, str) and detail:
        return detail[:240]
    return None


def _gemini_relay_log_context(
    *,
    user_id: str,
    session_id: str,
    body: "GeminiBrowserDogfoodRelayRequest",
) -> dict[str, object]:
    return {
        "user_id": user_id,
        "session_id_prefix": _safe_prefix(session_id),
        "relay_correlation_id": _safe_prefix(body.relay_correlation_id),
        "provider_receive_sequence": body.provider_receive_sequence,
        "provider_relay_sequence": body.provider_relay_sequence,
        "provider_primary_category": body.provider_primary_category,
        "provider_categories": list(body.provider_categories or [])[:6],
    }


GEMINI_EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME = "read_artifact_text"
GEMINI_REVIEW_BLOCKED_TOOL_NAMES = {
    "emit_artifact",
    "edit_builder_artifact",
    "start_builder_task",
}
GEMINI_REVIEW_GENERIC_BUILDER_REDIRECT_TOOL_NAMES = {
    "start_builder_task",
    "edit_builder_artifact",
    "check_async_task",
    "update_async_task",
    "cancel_async_task",
    "list_async_tasks",
}
ARTIFACT_REVIEW_EMIT_SUPPRESSED_REASON = "artifact_review_emit_artifact_suppressed"
ARTIFACT_REVIEW_GENERIC_BUILDER_SUPPRESSED_REASON = "artifact_review_generic_builder_tool_suppressed"
ARTIFACT_REVIEW_UPDATE_ONLY_REASON = "update_only_review_request"


def _record_from_any_key(value: object, *keys: str) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, dict):
            return candidate
    return None


def _array_from_any_key(value: object, *keys: str) -> list[object]:
    if not isinstance(value, dict):
        return []

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def _read_gemini_function_calls(event: dict[str, object]) -> list[dict[str, object]]:
    tool_call = _record_from_any_key(event, "toolCall", "tool_call")
    calls = [
        call
        for call in _array_from_any_key(tool_call, "functionCalls", "function_calls")
        if isinstance(call, dict)
    ]

    server_content = _record_from_any_key(event, "serverContent", "server_content")
    model_turn = _record_from_any_key(server_content, "modelTurn", "model_turn")
    for part in _array_from_any_key(model_turn, "parts"):
        function_call = _record_from_any_key(part, "functionCall", "function_call")
        if function_call is not None:
            calls.append(function_call)

    return calls


def _artifact_review_builder_update_intent(context: dict[str, object] | None) -> bool:
    return bool(context and context.get("builder_update_intent_detected") is True)


def _artifact_review_selected_update_context(context: dict[str, object] | None) -> bool:
    return bool(
        _artifact_review_context_active(context)
        and _artifact_review_context_artifact_id(context)
        and (
            context.get("selected_artifact_update_context") is True
            or _artifact_review_builder_update_intent(context)
            or _artifact_review_user_intent(context) in {"create_update", "unknown"}
        )
    )


def _artifact_review_generic_builder_redirect(
    tool_name: str,
    context: dict[str, object] | None,
) -> bool:
    return (
        tool_name in GEMINI_REVIEW_GENERIC_BUILDER_REDIRECT_TOOL_NAMES
        and _artifact_review_selected_update_context(context)
    )


def _is_artifact_review_blocked_call(
    call: object,
    context: dict[str, object] | None,
) -> bool:
    if not isinstance(call, dict):
        return False

    tool_name = _string_from_any_key(call, "name") or ""
    if tool_name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
        return (
            _artifact_review_user_intent(context) != "create_update"
            or _artifact_review_builder_update_intent(context)
        )
    if tool_name in GEMINI_REVIEW_GENERIC_BUILDER_REDIRECT_TOOL_NAMES:
        return (
            _artifact_review_generic_builder_redirect(tool_name, context)
            or (
                _artifact_review_user_intent(context) != "create_update"
                and tool_name in GEMINI_REVIEW_BLOCKED_TOOL_NAMES
            )
        )
    return (
        _artifact_review_user_intent(context) != "create_update"
        and tool_name in GEMINI_REVIEW_BLOCKED_TOOL_NAMES
    )


def _string_from_any_key(value: object, *keys: str) -> str | None:
    if not isinstance(value, dict):
        return None

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _artifact_review_context_active(context: dict[str, object] | None) -> bool:
    return bool(context and context.get("active") is True)


def _artifact_review_user_intent(context: dict[str, object] | None) -> str:
    value = context.get("user_intent") if context else None
    return value if isinstance(value, str) and value else "unknown"


def _artifact_review_context_artifact_id(context: dict[str, object] | None) -> str | None:
    return _string_from_any_key(context, "artifact_id", "artifactId")


def _apply_artifact_review_defaults_to_function_call(
    call: object,
    *,
    artifact_id: str | None,
) -> tuple[dict[str, object] | None, bool]:
    if not isinstance(call, dict):
        return None, False
    if not artifact_id:
        return dict(call), False
    if (_string_from_any_key(call, "name") or "") != GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME:
        return dict(call), False

    raw_args = call.get("args")
    if isinstance(raw_args, dict):
        if _string_from_any_key(raw_args, "artifact_id", "artifactId"):
            return dict(call), False
        next_args = dict(raw_args)
    else:
        next_args = {}

    next_args["artifact_id"] = artifact_id
    next_call = dict(call)
    next_call["args"] = next_args
    return next_call, True


def _event_key(payload: dict[str, object], camel: str, snake: str) -> str | None:
    if camel in payload:
        return camel
    if snake in payload:
        return snake
    return None


def _apply_artifact_review_defaults_to_call_list(
    calls: object,
    *,
    artifact_id: str,
) -> tuple[list[object], bool]:
    raw_calls = calls if isinstance(calls, list) else []
    next_calls: list[object] = []
    mutated = False

    for call in raw_calls:
        next_call, call_mutated = _apply_artifact_review_defaults_to_function_call(
            call,
            artifact_id=artifact_id,
        )
        next_calls.append(next_call if next_call is not None else call)
        mutated = mutated or call_mutated

    return next_calls, mutated


def _apply_artifact_review_defaults_to_tool_call_event(
    event: dict[str, object],
    *,
    artifact_id: str,
) -> tuple[str | None, dict[str, object] | None]:
    tool_call_key = _event_key(event, "toolCall", "tool_call")
    raw_tool_call = event.get(tool_call_key) if tool_call_key else None

    if tool_call_key is None or not isinstance(raw_tool_call, dict):
        return None, None

    function_calls_key = _event_key(raw_tool_call, "functionCalls", "function_calls")
    if function_calls_key is None:
        return None, None

    next_function_calls, mutated = _apply_artifact_review_defaults_to_call_list(
        raw_tool_call.get(function_calls_key),
        artifact_id=artifact_id,
    )
    if not mutated:
        return None, None

    next_tool_call = dict(raw_tool_call)
    next_tool_call[function_calls_key] = next_function_calls
    return tool_call_key, next_tool_call


def _apply_artifact_review_defaults_to_model_part(
    part: object,
    *,
    artifact_id: str,
) -> tuple[object, bool]:
    if not isinstance(part, dict):
        return part, False

    function_call_key = _event_key(part, "functionCall", "function_call")
    if function_call_key is None:
        return part, False

    next_call, call_mutated = _apply_artifact_review_defaults_to_function_call(
        part.get(function_call_key),
        artifact_id=artifact_id,
    )
    if not call_mutated:
        return part, False

    next_part = dict(part)
    next_part[function_call_key] = next_call
    return next_part, True


def _apply_artifact_review_defaults_to_model_parts(
    parts: object,
    *,
    artifact_id: str,
) -> tuple[list[object], bool]:
    if not isinstance(parts, list):
        return [], False

    next_parts: list[object] = []
    mutated = False
    for part in parts:
        next_part, part_mutated = _apply_artifact_review_defaults_to_model_part(
            part,
            artifact_id=artifact_id,
        )
        next_parts.append(next_part)
        mutated = mutated or part_mutated

    return next_parts, mutated


def _apply_artifact_review_defaults_to_server_content_event(
    event: dict[str, object],
    *,
    artifact_id: str,
) -> tuple[str | None, dict[str, object] | None]:
    server_content_key = _event_key(event, "serverContent", "server_content")
    raw_server_content = event.get(server_content_key) if server_content_key else None

    if server_content_key is None or not isinstance(raw_server_content, dict):
        return None, None

    model_turn_key = _event_key(raw_server_content, "modelTurn", "model_turn")
    raw_model_turn = raw_server_content.get(model_turn_key) if model_turn_key else None

    if model_turn_key is None or not isinstance(raw_model_turn, dict):
        return None, None

    next_parts, mutated = _apply_artifact_review_defaults_to_model_parts(
        raw_model_turn.get("parts"),
        artifact_id=artifact_id,
    )
    if not mutated:
        return None, None

    next_model_turn = dict(raw_model_turn)
    next_model_turn["parts"] = next_parts
    next_server_content = dict(raw_server_content)
    next_server_content[model_turn_key] = next_model_turn
    return server_content_key, next_server_content


def _apply_artifact_review_tool_defaults(
    event: dict[str, object],
    context: dict[str, object] | None,
) -> dict[str, object]:
    if not _artifact_review_context_active(context):
        return event

    artifact_id = _artifact_review_context_artifact_id(context)
    if not artifact_id:
        return event

    mutated = False
    next_event = dict(event)

    tool_call_key, next_tool_call = _apply_artifact_review_defaults_to_tool_call_event(
        event,
        artifact_id=artifact_id,
    )
    if tool_call_key and next_tool_call is not None:
        next_event[tool_call_key] = next_tool_call
        mutated = True

    server_content_key, next_server_content = _apply_artifact_review_defaults_to_server_content_event(
        event,
        artifact_id=artifact_id,
    )
    if server_content_key and next_server_content is not None:
        next_event[server_content_key] = next_server_content
        mutated = True

    return next_event if mutated else event


def _suppressed_review_tool_calls(
    body: GeminiBrowserDogfoodRelayRequest,
) -> list[dict[str, object]]:
    if not _artifact_review_context_active(body.artifact_review_context):
        return []

    function_calls = _read_gemini_function_calls(body.event)
    if not function_calls:
        return []

    blocked_calls = [
        call
        for call in function_calls
        if _is_artifact_review_blocked_call(call, body.artifact_review_context)
    ]
    if not blocked_calls:
        return []

    return blocked_calls


def _artifact_review_batch_has_allowed_calls(body: GeminiBrowserDogfoodRelayRequest) -> bool:
    function_calls = _read_gemini_function_calls(body.event)
    return any(
        not _is_artifact_review_blocked_call(call, body.artifact_review_context)
        for call in function_calls
    )


def _without_blocked_artifact_review_calls(
    event: dict[str, object],
    context: dict[str, object] | None,
) -> dict[str, object]:
    next_event = dict(event)
    _remove_blocked_top_level_tool_calls(next_event, context)
    _remove_blocked_model_turn_tool_calls(next_event, context)
    return next_event


def _remove_blocked_top_level_tool_calls(
    event: dict[str, object],
    context: dict[str, object] | None,
) -> None:
    tool_call_key = _event_key(event, "toolCall", "tool_call")
    raw_tool_call = event.get(tool_call_key) if tool_call_key else None
    if tool_call_key is None or not isinstance(raw_tool_call, dict):
        return

    function_calls_key = _event_key(raw_tool_call, "functionCalls", "function_calls")
    raw_calls = raw_tool_call.get(function_calls_key) if function_calls_key else None
    if function_calls_key is None or not isinstance(raw_calls, list):
        return

    next_tool_call = dict(raw_tool_call)
    next_tool_call[function_calls_key] = [
        call for call in raw_calls if not _is_artifact_review_blocked_call(call, context)
    ]
    event[tool_call_key] = next_tool_call


def _remove_blocked_model_turn_tool_calls(
    event: dict[str, object],
    context: dict[str, object] | None,
) -> None:
    server_content_key = _event_key(event, "serverContent", "server_content")
    raw_server_content = event.get(server_content_key) if server_content_key else None
    if server_content_key is None or not isinstance(raw_server_content, dict):
        return

    model_turn_key = _event_key(raw_server_content, "modelTurn", "model_turn")
    raw_model_turn = raw_server_content.get(model_turn_key) if model_turn_key else None
    if model_turn_key is None or not isinstance(raw_model_turn, dict):
        return

    parts = raw_model_turn.get("parts")
    if not isinstance(parts, list):
        return

    next_model_turn = dict(raw_model_turn)
    next_model_turn["parts"] = [
        part for part in parts if not _model_part_has_blocked_artifact_review_call(part, context)
    ]
    next_server_content = dict(raw_server_content)
    next_server_content[model_turn_key] = next_model_turn
    event[server_content_key] = next_server_content


def _model_part_has_blocked_artifact_review_call(
    part: object,
    context: dict[str, object] | None,
) -> bool:
    if not isinstance(part, dict):
        return False
    function_call = _record_from_any_key(part, "functionCall", "function_call")
    return _is_artifact_review_blocked_call(function_call, context)


def _voice_relay_payload_for_event(
    body: GeminiBrowserDogfoodRelayRequest,
    event: dict[str, object],
) -> dict[str, object]:
    payload = body.voice_relay_payload()
    payload["event"] = _apply_artifact_review_tool_defaults(
        event,
        body.artifact_review_context,
    )
    return payload


def _merge_artifact_review_guard_payload(
    payload: dict[str, object],
    guard_payload: dict[str, object] | None,
) -> dict[str, object]:
    if guard_payload is None:
        return payload

    for key in ("client_actions", "tool_diagnostics"):
        existing = payload.get(key)
        payload[key] = [
            *(existing if isinstance(existing, list) else []),
            *(guard_payload.get(key) if isinstance(guard_payload.get(key), list) else []),
        ]

    diagnostics = payload.get("diagnostics")
    guard_diagnostics = guard_payload.get("diagnostics")
    if isinstance(diagnostics, dict) and isinstance(guard_diagnostics, dict):
        payload["diagnostics"] = {**diagnostics, "artifact_review_guard": guard_diagnostics}
    elif isinstance(guard_diagnostics, dict):
        payload["diagnostics"] = {"artifact_review_guard": guard_diagnostics}

    return payload


def _artifact_review_emit_suppression_payload(
    body: GeminiBrowserDogfoodRelayRequest,
) -> dict[str, object] | None:
    blocked_calls = _suppressed_review_tool_calls(body)
    if not blocked_calls:
        return None

    function_responses: list[dict[str, object]] = []
    tool_diagnostics: list[dict[str, object]] = []

    for index, call in enumerate(blocked_calls):
        tool_call_id = _string_from_any_key(call, "id") or f"artifact-review-emit-{index + 1}"
        tool_name = _string_from_any_key(call, "name") or GEMINI_EMIT_ARTIFACT_TOOL_NAME
        generic_builder_redirect = _artifact_review_generic_builder_redirect(
            tool_name,
            body.artifact_review_context,
        )
        update_only_review_request = (
            tool_name == GEMINI_EMIT_ARTIFACT_TOOL_NAME
            and _artifact_review_builder_update_intent(body.artifact_review_context)
        )
        generic_builder_status_check = tool_name in {"check_async_task", "list_async_tasks"}
        rejection_reason = (
            ARTIFACT_REVIEW_GENERIC_BUILDER_SUPPRESSED_REASON
            if generic_builder_redirect
            else ARTIFACT_REVIEW_EMIT_SUPPRESSED_REASON
        )
        safe_reason = (
            ARTIFACT_REVIEW_UPDATE_ONLY_REASON
            if update_only_review_request
            else rejection_reason
        )
        guidance = (
            "Use coreview_get_builder_status for selected-artifact update status during Review with Sophia."
            if generic_builder_status_check
            else "Use coreview_request_artifact_update for selected-artifact update requests during Review with Sophia."
            if generic_builder_redirect or update_only_review_request
            else (
                "Artifact review is active. Use read_artifact_text for exact artifact text and answer from the "
                "existing artifact unless the user explicitly asks to create or update an artifact."
            )
        )
        response = {
            "ok": False,
            "status": "rejected",
            "safe_reason": safe_reason,
            "rejection_reason": rejection_reason,
            "recovery_guidance": guidance,
            "suppressed_tool_name": tool_name,
            "selected_artifact_update_context": _artifact_review_selected_update_context(
                body.artifact_review_context,
            ),
            "coreview_builder_update_intent_detected": _artifact_review_builder_update_intent(
                body.artifact_review_context,
            ),
            "update_only_review_request": update_only_review_request,
            "generic_async_tool_blocked_reason": (
                "use_coreview_get_builder_status"
                if generic_builder_status_check
                else "use_coreview_request_artifact_update"
                if generic_builder_redirect
                else None
            ),
            "generic_async_tool_responded_safely": generic_builder_redirect,
            "raw_artifact_text_excluded": True,
            "raw_comment_text_excluded": True,
            "raw_frame_excluded": True,
        }
        function_responses.append({
            "id": tool_call_id,
            "name": tool_name,
            "response": response,
        })
        tool_diagnostics.append({
            "id": tool_call_id,
            "name": tool_name,
            "success": False,
            "execution_rejected": True,
            "rejection_reason": rejection_reason,
            "recovery_guidance": guidance,
            "response": response,
        })

    return {
        "accepted": True,
        "client_actions": [
            {
                "type": "gemini_tool_response",
                "payload": {
                    "toolResponse": {
                        "functionResponses": function_responses,
                    },
                },
                "result_summary": "Review-only artifact/builder tool call suppressed.",
            },
        ],
        "tool_diagnostics": tool_diagnostics,
        "diagnostics": {
            "schema": "artifact_review_tool_guard_v1",
            "artifact_review_active": True,
            "artifact_review_user_intent": _artifact_review_user_intent(body.artifact_review_context),
            "coreview_builder_update_intent_detected": _artifact_review_builder_update_intent(
                body.artifact_review_context,
            ),
            "selected_artifact_update_context": _artifact_review_selected_update_context(
                body.artifact_review_context,
            ),
            "review_tool_churn_detected": True,
            "suppressed_tool_count": len(blocked_calls),
            "suppressed_tools": sorted({
                _string_from_any_key(call, "name") or GEMINI_EMIT_ARTIFACT_TOOL_NAME
                for call in blocked_calls
            }),
            "raw_artifact_text_excluded": True,
        },
    }


async def _raise_voice_dogfood_error(response: httpx.Response) -> None:
    try:
        payload = response.json()
        detail = payload.get("detail") if isinstance(payload, dict) else None
    except ValueError:
        detail = response.text[:300]

    if not detail:
        detail = f"Voice dogfood request failed with HTTP {response.status_code}."

    status_code = response.status_code if response.status_code in {400, 404, 409, 422} else 502
    raise HTTPException(status_code=status_code, detail=detail)


async def _proxy_voice_dogfood_json(
    method: str,
    path: str,
    *,
    json_body: dict[str, object] | None = None,
    timeout: float = VOICE_SERVER_DOGFOOD_TIMEOUT,
    capability: str | None = None,
) -> dict[str, object]:
    voice_url = _get_voice_server_url()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{voice_url}{path}",
                json=json_body,
                **_voice_auth_request_kwargs(
                    {VOICE_LAB_CAPABILITY_HEADER: capability} if capability else None,
                ),
            )
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice dogfood request timed out.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood request failed.",
        ) from exc

    if response.status_code >= 400:
        await _raise_voice_dogfood_error(response)

    if response.status_code == 202 and not response.content:
        return {"accepted": True}

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Voice dogfood server returned invalid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail="Voice dogfood server returned a non-object payload.",
        )

    return dict(payload)


async def _raise_voice_runtime_error(response: httpx.Response) -> None:
    try:
        payload = response.json()
        detail = payload.get("detail") if isinstance(payload, dict) else None
    except ValueError:
        detail = response.text[:300]

    if not detail:
        detail = f"Voice runtime request failed with HTTP {response.status_code}."

    status_code = response.status_code if response.status_code in {400, 404, 409, 422} else 502
    raise HTTPException(status_code=status_code, detail=detail)


async def _proxy_voice_runtime_json(
    method: str,
    path: str,
    *,
    json_body: dict[str, object] | None = None,
    timeout: float = VOICE_SERVER_PRODUCTION_RUNTIME_TIMEOUT,
    capability: str | None = None,
) -> dict[str, object]:
    voice_url = _get_voice_server_url()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{voice_url}{path}",
                json=json_body,
                **_voice_auth_request_kwargs(
                    {VOICE_LAB_CAPABILITY_HEADER: capability} if capability else None,
                ),
            )
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice runtime server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice runtime request timed out.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice runtime request failed.",
        ) from exc

    if response.status_code >= 400:
        await _raise_voice_runtime_error(response)

    if response.status_code == 202 and not response.content:
        return {"accepted": True}

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned invalid JSON.",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned a non-object payload.",
        )

    return dict(payload)


def _generate_stream_token(api_secret: str, user_id: str) -> str:
    """Generate a Stream user token using the getstream SDK.

    Falls back to a JWT-signed token if the SDK is unavailable.
    """
    try:
        from getstream import Stream

        client = Stream(api_key=_get_stream_api_key(), api_secret=api_secret)
        return client.create_token(user_id)
    except ImportError:
        pass

    # Fallback: manual JWT signing (Stream tokens are HS256 JWTs)
    import hashlib
    import hmac
    import json
    from base64 import urlsafe_b64encode

    header = urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).rstrip(b"=")
    payload = urlsafe_b64encode(
        json.dumps({"user_id": user_id, "iat": int(time.time())}).encode()
    ).rstrip(b"=")
    signing_input = header + b"." + payload
    signature = urlsafe_b64encode(
        hmac.new(api_secret.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")
    return (signing_input + b"." + signature).decode()


def _is_gemini_production_runtime_selected() -> bool:
    return _get_configured_voice_runtime_mode() == "gemini_live"


def _utc_iso_from_epoch(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, UTC).isoformat().replace("+00:00", "Z")


async def _start_gemini_production_voice_session(
    user_id: str,
    body: VoiceConnectRequest,
    request_base_url: str | None = None,
    voice_lab_claims: VoiceLabClaims | None = None,
    synthetic_trace_mode: str | None = None,
    reserved_provider_session_id: str | None = None,
    cleanup_admission_id: str | None = None,
    cleanup_admission_expires_at: str | None = None,
    cleanup_resource_expires_at: str | None = None,
) -> GeminiVoiceConnectResponse:
    if not _gemini_production_route_enabled():
        raise HTTPException(
            status_code=409,
            detail=(
                "SOPHIA_VOICE_RUNTIME_MODE='gemini_live' is selected for the production "
                "voice route, but SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=true is not set. "
                "Set the promotion flag to use Gemini here, or reset SOPHIA_VOICE_RUNTIME_MODE "
                "to 'legacy_cascade' to roll back."
            ),
        )

    logical_session_id = body.session_id or str(uuid.uuid4())
    session_id = reserved_provider_session_id or f"gemini-prod-{uuid.uuid4().hex}"
    realtime_context = await _build_gemini_realtime_context_payload(
        user_id=user_id,
        body=body,
        session_id=logical_session_id,
        request_base_url=request_base_url,
        voice_lab_claims=voice_lab_claims,
    )
    runtime_capability = sign_runtime_capability(voice_lab_claims) if voice_lab_claims else None
    synthetic_test = voice_lab_claims.synthetic_context() if voice_lab_claims else None
    proxy_kwargs: dict[str, Any] = {
        "json_body": {
            "user_id": user_id,
            "session_id": session_id,
            "logical_session_id": logical_session_id,
            "thread_id": body.thread_id,
            "platform": body.platform,
            "context_mode": body.context_mode,
            "ritual": body.ritual,
            "realtime_context": realtime_context,
            **({"synthetic_test": synthetic_test} if synthetic_test else {}),
            **(
                {
                    "cleanup_admission_id": cleanup_admission_id,
                    "cleanup_admission_expires_at": cleanup_admission_expires_at,
                    "cleanup_resource_expires_at": cleanup_resource_expires_at,
                }
                if (
                    cleanup_admission_id
                    and cleanup_admission_expires_at
                    and cleanup_resource_expires_at
                )
                else {}
            ),
            **(
                {"synthetic_trace_mode": synthetic_trace_mode}
                if synthetic_trace_mode
                else {}
            ),
            **(
                {
                    "preconnect": True,
                    "preconnect_ttl_seconds": GEMINI_PRECONNECT_SERVER_CLEANUP_SECONDS,
                }
                if body.preconnect
                else {}
            ),
        },
    }
    if runtime_capability:
        proxy_kwargs["capability"] = runtime_capability
    payload = await _proxy_voice_runtime_json(
        "POST",
        "/production/realtime/gemini/browser-sessions",
        **proxy_kwargs,
    )

    returned_session_id = payload.get("session_id")
    if not isinstance(returned_session_id, str):
        raise HTTPException(
            status_code=502,
            detail="Voice runtime server returned a Gemini bootstrap without session_id.",
        )
    if voice_lab_claims is not None:
        ephemeral_token = payload.get("ephemeral_token")
        if (
            not isinstance(ephemeral_token, dict)
            or ephemeral_token.get("expireTime")
            != voice_lab_claims.provider_expires_at
        ):
            await _disconnect_gemini_production_session(
                returned_session_id,
                capability=sign_runtime_capability(voice_lab_claims),
            )
            raise HTTPException(
                status_code=502,
                detail={"code": "voice_lab_provider_deadline_mismatch"},
            )

    stream_url = _build_gemini_production_events_stream_url(returned_session_id)
    payload["runtime"] = "gemini_live"
    payload["voice_runtime"] = "gemini_live"
    payload["production_route"] = True
    payload["thread_id"] = body.thread_id
    payload["logical_session_id"] = logical_session_id
    payload["voice_runtime_session_id"] = returned_session_id
    payload["stream_url"] = stream_url
    payload["event_stream_url"] = stream_url
    payload["provider_event_relay_url"] = _build_gemini_production_relay_url()
    payload["disconnect_url"] = _build_gemini_production_disconnect_url()
    payload["continuation_bootstrap_url"] = (
        "/api/sophia/voice/gemini/continuation-bootstrap"
        f"?session_id={quote(returned_session_id, safe='')}"
    )
    if voice_lab_claims is not None:
        payload["provider_activation_url"] = "/api/sophia/voice/gemini/activate"
    payload["preconnect"] = body.preconnect
    if synthetic_test:
        payload["synthetic_test"] = synthetic_test
    if body.preconnect:
        payload["preconnect_ttl_ms"] = GEMINI_PRECONNECT_CLIENT_TTL_MS
        payload["preconnect_expires_at"] = _utc_iso_from_epoch(
            time.time() + (GEMINI_PRECONNECT_CLIENT_TTL_MS / 1000),
        )
    return GeminiVoiceConnectResponse.model_validate(payload)


async def _build_gemini_realtime_context_payload(
    *,
    user_id: str,
    body: VoiceConnectRequest,
    session_id: str,
    request_base_url: str | None = None,
    voice_lab_claims: VoiceLabClaims | None = None,
) -> dict[str, Any]:
    request = RealtimeContextRequest(
        thread_id=body.thread_id,
        session_id=session_id,
        platform=body.platform,
        context_mode=body.context_mode,
        ritual=body.ritual,
    )
    if voice_lab_claims is not None:
        context = build_degraded_realtime_context_response(
            reason="synthetic_test_memory_isolation",
            limit=request.limit,
        )
        payload = context.model_dump(mode="json")
        diagnostics = payload.setdefault("diagnostics", {})
        if isinstance(diagnostics, dict):
            diagnostics["dynamic_retrieve_configured"] = False
            diagnostics["synthetic_test"] = True
            diagnostics["memory_retrieval_disabled"] = True
        payload["synthetic_test"] = voice_lab_claims.synthetic_context()
        return payload
    try:
        context = await asyncio.to_thread(
            build_sophia_realtime_context,
            user_id=user_id,
            request=request,
        )
    except Exception:
        logger.warning("voice.gemini.context_fetch_failed user_id=%s", user_id, exc_info=True)
        context = build_degraded_realtime_context_response(
            reason="gateway_context_fetch_failed",
            limit=request.limit,
        )
    payload = context.model_dump(mode="json")
    diagnostics = payload.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict):
        diagnostics["dynamic_retrieve_configured"] = False
    if request_base_url:
        grant = create_realtime_memory_retrieval_grant(
            user_id=user_id,
            session_id=session_id,
        )
        base_url = _canonicalize_gemini_callback_base_url(request_base_url)
        payload["dynamic_memory_retrieval"] = {
            "schema": REALTIME_DYNAMIC_MEMORY_RETRIEVAL_SCHEMA,
            "endpoint_url": f"{base_url}/internal/sophia-realtime/memories/retrieve",
            "token": grant.token,
            "token_header": REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER,
            "expires_at": grant.expires_at_iso,
            "source": "gateway",
        }
        if isinstance(diagnostics, dict):
            diagnostics["dynamic_retrieve_configured"] = True
            diagnostics["dynamic_retrieve_source"] = "gateway"
            diagnostics["dynamic_retrieve_token_excluded"] = True
    return payload


def _canonicalize_gemini_callback_base_url(base_url: str) -> str:
    cleaned = base_url.strip().rstrip("/")
    if not cleaned:
        return cleaned
    if "://" not in cleaned:
        cleaned = f"https://{cleaned}"

    parsed = urlsplit(cleaned)
    if parsed.hostname and parsed.hostname.lower().endswith(".onrender.com"):
        parsed = parsed._replace(scheme="https")
    return urlunsplit(parsed).rstrip("/")


@router.post(
    "/{user_id}/voice/connect",
    response_model=VoiceConnectResponse | GeminiVoiceConnectResponse | GeminiVoicePreconnectSkippedResponse,
    summary="Start a voice session",
    description="Generate Stream credentials for the frontend and signal the Voice Agent to join.",
)
async def voice_connect(
    user_id: str,
    body: VoiceConnectRequest,
    request: Request,
) -> VoiceConnectResponse | GeminiVoiceConnectResponse | GeminiVoicePreconnectSkippedResponse:
    """Create a Stream call, dispatch the voice agent, and return credentials."""

    voice_lab_claims = capability_for_voice_connect(request, user_id)
    if voice_lab_claims is not None:
        retention_reaper = get_voice_lab_retention_reaper_or_none(request.app)
        retention_readiness = (
            retention_reaper.readiness() if retention_reaper is not None else None
        )
        if (
            retention_readiness is None
            or retention_readiness.get("running") is not True
            or retention_readiness.get("status") != "ready"
        ):
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_retention_plane_not_ready"},
            )
    synthetic_trace_mode: str | None = None
    if (
        voice_lab_claims is not None
        and voice_lab_claims.scenario_id == VOICE_LAB_TRACE_FAULT_SCENARIO_ID
    ):
        # V-L01 must carry a second, explicit fault authority. This check is
        # deliberately before canonical/provider allocation and the mode is
        # server-derived rather than accepted from a browser request body.
        capability_for_gateway_action(
            request,
            user_id,
            required_operation="trace:fault",
        )
        synthetic_trace_mode = VOICE_LAB_TRACE_FAULT_MODE

    if body.platform not in SUPPORTED_PLATFORMS:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid platform '{body.platform}'. Must be one of: {', '.join(sorted(SUPPORTED_PLATFORMS))}",
        )

    if body.context_mode not in SUPPORTED_CONTEXT_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid context_mode '{body.context_mode}'. Must be one of: {', '.join(sorted(SUPPORTED_CONTEXT_MODES))}",
        )

    if voice_lab_claims is not None and not _is_gemini_production_runtime_selected():
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_requires_gemini_runtime"},
        )

    if _is_gemini_production_runtime_selected():
        canonical_voice_lab_record = None
        if voice_lab_claims is not None:
            canonical_voice_lab_record = _canonical_voice_lab_session_for_connect(
                user_id,
                body.session_id,
                voice_lab_claims,
            )
        lock = await _get_active_voice_session_lock(user_id)
        async with lock:
            previous_session = _active_voice_sessions.get(user_id)
            if (
                voice_lab_claims is not None
                and previous_session is not None
                and previous_session.voice_lab_binding
                != _voice_lab_active_binding(voice_lab_claims)
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "voice_lab_active_session_binding_mismatch"},
                )
            if body.preconnect and previous_session is not None:
                logger.info(
                    "voice.connect preconnect skipped because active session exists user_id=%s runtime=%s session_id=%s",
                    user_id,
                    previous_session.runtime,
                    previous_session.session_id,
                )
                return GeminiVoicePreconnectSkippedResponse(
                    session_id=previous_session.session_id,
                    thread_id=body.thread_id,
                )

            cleanup_admission = None
            reserved_provider_session_id = None
            if voice_lab_claims is not None:
                from deerflow.sophia.cleanup_fence import (
                    CleanupFenceError,
                    reserve_cleanup_admission,
                )

                metadata = getattr(canonical_voice_lab_record, "metadata", None)
                synthetic = (
                    metadata.get("synthetic_voice_lab")
                    if isinstance(metadata, dict)
                    else None
                )
                retention_expires_at = (
                    synthetic.get("retention_expires_at")
                    if isinstance(synthetic, dict)
                    else None
                )
                reserved_provider_session_id = f"gemini-prod-{uuid.uuid4().hex}"
                try:
                    cleanup_admission = await asyncio.to_thread(
                        reserve_cleanup_admission,
                        voice_lab_claims.cleanup_obligation_id,
                        retention_expires_at,
                        provider_expires_at=voice_lab_claims.provider_expires_at,
                        resource_kind="provider",
                        resource_id=reserved_provider_session_id,
                        resource_expires_at=voice_lab_claims.provider_expires_at,
                    )
                except CleanupFenceError as exc:
                    raise HTTPException(
                        status_code=409,
                        detail={"code": "voice_lab_cleanup_obligation_closed"},
                    ) from exc

            gemini_response = await _start_gemini_production_voice_session(
                user_id,
                body,
                request_base_url=str(request.base_url),
                voice_lab_claims=voice_lab_claims,
                synthetic_trace_mode=synthetic_trace_mode,
                reserved_provider_session_id=reserved_provider_session_id,
                cleanup_admission_id=(
                    cleanup_admission.admission_id
                    if cleanup_admission is not None
                    else None
                ),
                cleanup_admission_expires_at=(
                    cleanup_admission.lease_expires_at.astimezone(UTC)
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z")
                    if cleanup_admission is not None
                    else None
                ),
                cleanup_resource_expires_at=(
                    cleanup_admission.resource_expires_at.astimezone(UTC)
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z")
                    if cleanup_admission is not None
                    and cleanup_admission.resource_expires_at is not None
                    else None
                ),
            )
            if cleanup_admission is not None:
                from deerflow.sophia.cleanup_fence import (
                    cleanup_admission_authorized,
                    close_cleanup_obligation,
                )

                async def close_provider_admission() -> None:
                    try:
                        await asyncio.to_thread(
                            close_cleanup_obligation,
                            cleanup_admission.cleanup_obligation_id,
                            retention_expires_at,
                            voice_lab_claims.provider_expires_at,
                        )
                    except Exception:  # noqa: BLE001 - never release on ambiguity.
                        logger.exception(
                            "voice_lab.provider_admission_close_failed admission_id=%s",
                            cleanup_admission.admission_id,
                        )

                async def abort_unpublished_provider_credential() -> bool:
                    try:
                        return await asyncio.to_thread(
                            _abort_unpublished_synthetic_provider_session,
                            user_id,
                            str(body.session_id),
                            gemini_response.session_id,
                            voice_lab_claims,
                            cleanup_admission,
                            gemini_response.provider_connection_epoch,
                        )
                    except Exception:  # noqa: BLE001 - retain admission on ambiguity.
                        logger.exception(
                            "voice_lab.provider_admission_abort_failed admission_id=%s",
                            cleanup_admission.admission_id,
                        )
                        return False

                if gemini_response.session_id != reserved_provider_session_id:
                    await close_provider_admission()
                    for provider_session_id in dict.fromkeys(
                        (
                            reserved_provider_session_id,
                            gemini_response.session_id,
                        )
                    ):
                        if not isinstance(provider_session_id, str) or not provider_session_id:
                            continue
                        await _disconnect_gemini_production_session(
                            provider_session_id,
                            capability=sign_runtime_capability(voice_lab_claims),
                        )
                    raise HTTPException(
                        status_code=502,
                        detail={"code": "voice_lab_provider_session_identity_mismatch"},
                    )

                authorized = await asyncio.to_thread(
                    cleanup_admission_authorized,
                    cleanup_admission,
                )
                if not authorized:
                    await close_provider_admission()
                    await _disconnect_gemini_production_session(
                        gemini_response.session_id,
                        capability=sign_runtime_capability(voice_lab_claims),
                    )
                    raise HTTPException(
                        status_code=409,
                        detail={"code": "voice_lab_cleanup_obligation_closed"},
                    )
                try:
                    provider_bound = _bind_synthetic_provider_session(
                        user_id,
                        str(body.session_id),
                        gemini_response.session_id,
                        voice_lab_claims,
                        cleanup_admission,
                        gemini_response.provider_connection_epoch,
                        cleanup_admission.resource_expires_at,
                        gemini_response.voice_runtime_instance_id_sha256,
                        gemini_response.voice_runtime_instance_public_key_spki_base64,
                    )
                except Exception:  # noqa: BLE001 - reservation remains on failed cleanup.
                    provider_bound = False
                if not provider_bound:
                    await close_provider_admission()
                    await _disconnect_gemini_production_session(
                        gemini_response.session_id,
                        capability=sign_runtime_capability(voice_lab_claims),
                    )
                    raise HTTPException(
                        status_code=503,
                        detail={"code": "voice_lab_provider_binding_persistence_failed"},
                    )
                # The atomic bind already promoted allocating ->
                # credential_minted with the canonical provider-key merge.
                # Recheck OPEN once after that transaction; repeating the
                # promotion in a second transaction lets CLOSED win between
                # them and strands an unpublished credential.
                authorization_unavailable = False
                try:
                    authorized_after_bind = await asyncio.to_thread(
                        cleanup_admission_authorized,
                        cleanup_admission,
                    )
                except Exception:  # noqa: BLE001 - compensate an ambiguous bind.
                    logger.exception(
                        "voice_lab.provider_post_bind_authorization_failed admission_id=%s",
                        cleanup_admission.admission_id,
                    )
                    authorized_after_bind = False
                    authorization_unavailable = True
                if not authorized_after_bind:
                    compensated = await abort_unpublished_provider_credential()
                    await _disconnect_gemini_production_session(
                        gemini_response.session_id,
                        capability=sign_runtime_capability(voice_lab_claims),
                    )
                    if not compensated:
                        raise HTTPException(
                            status_code=503,
                            detail={
                                "code": "voice_lab_provider_compensation_pending"
                            },
                        )
                    raise HTTPException(
                        status_code=503 if authorization_unavailable else 409,
                        detail={
                            "code": (
                                "voice_lab_provider_authorization_unavailable"
                                if authorization_unavailable
                                else "voice_lab_cleanup_obligation_closed"
                            )
                        },
                    )
                try:
                    cleanup_authority = mint_provider_cleanup_token(
                        voice_lab_claims,
                        gemini_response.session_id,
                        cleanup_admission.admission_id,
                        str(retention_expires_at),
                    )
                except Exception as exc:  # noqa: BLE001 - bound provider must fail closed.
                    compensated = await abort_unpublished_provider_credential()
                    await _disconnect_gemini_production_session(
                        gemini_response.session_id,
                        capability=sign_runtime_capability(voice_lab_claims),
                    )
                    if not compensated:
                        raise HTTPException(
                            status_code=503,
                            detail={
                                "code": "voice_lab_provider_compensation_pending"
                            },
                        ) from exc
                    raise HTTPException(
                        status_code=503,
                        detail={"code": "voice_lab_provider_cleanup_authority_unavailable"},
                    ) from exc
                gemini_response = gemini_response.model_copy(
                    update={
                        "provider_cleanup_token": cleanup_authority.token,
                        "provider_cleanup_expires_at": (
                            cleanup_authority.cleanup_expires_at
                        ),
                    }
                )
                # The provider admission becomes a durable bound-resource
                # heartbeat in the SQL trigger. The owning Voice replica
                # releases it only after its local provider session is closed;
                # a load-balanced 404 from another replica is never global zero.
            previous_session = _active_voice_sessions.get(user_id)
            if previous_session is not None:
                logger.info(
                    "voice.connect closing previous session (background) user_id=%s runtime=%s call_id=%s session_id=%s",
                    user_id,
                    previous_session.runtime,
                    previous_session.call_id,
                    previous_session.session_id,
                )
                _schedule_background_active_session_disconnect(
                    previous_session,
                    runtime_capability=(
                        sign_runtime_capability(voice_lab_claims)
                        if voice_lab_claims is not None
                        else None
                    ),
                )
            _active_voice_sessions[user_id] = ActiveVoiceSession(
                call_id=gemini_response.session_id,
                session_id=gemini_response.session_id,
                runtime="gemini_live",
                voice_lab_binding=(
                    _voice_lab_active_binding(voice_lab_claims)
                    if voice_lab_claims is not None
                    else None
                ),
            )

        logger.info(
            "voice.connect user_id=%s runtime=gemini_live preconnect=%s platform=%s context_mode=%s ritual=%s session_id=%s",
            user_id,
            body.preconnect,
            body.platform,
            body.context_mode,
            body.ritual,
            gemini_response.session_id,
        )
        return gemini_response

    api_key = _get_stream_api_key()
    api_secret = _get_stream_api_secret()

    call_id = f"sophia-{_sanitize_call_id_fragment(user_id)}-{uuid.uuid4().hex[:8]}"
    call_type = "default"
    token = _generate_stream_token(api_secret, user_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        previous_session = _active_voice_sessions.get(user_id)
        if previous_session is not None:
            logger.info(
                "voice.connect closing previous session (background) user_id=%s call_id=%s session_id=%s",
                user_id,
                previous_session.call_id,
                previous_session.session_id,
            )
            # Fire-and-forget: don't block the new connect on the previous
            # session's teardown. The previous call_id is independent of the
            # new one (Stream SFU routes by call_id), so there's no race.
            _schedule_background_active_session_disconnect(previous_session)
            if _active_voice_sessions.get(user_id) == previous_session:
                _active_voice_sessions.pop(user_id, None)

        session_id = await _dispatch_voice_agent(
            call_id=call_id,
            call_type=call_type,
            platform=body.platform,
            context_mode=body.context_mode,
            ritual=body.ritual,
            session_id=body.session_id,
            thread_id=body.thread_id,
        )

        if session_id:
            _active_voice_sessions[user_id] = ActiveVoiceSession(
                call_id=call_id,
                session_id=session_id,
                runtime="legacy_cascade",
            )

    logger.info(
        "voice.connect user_id=%s platform=%s context_mode=%s ritual=%s companion_session_id=%s thread_id=%s call_id=%s session_id=%s",
        user_id,
        body.platform,
        body.context_mode,
        body.ritual,
        body.session_id,
        body.thread_id,
        call_id,
        session_id,
    )

    return VoiceConnectResponse(
        api_key=api_key,
        token=token,
        call_type=call_type,
        call_id=call_id,
        thread_id=body.thread_id,
        stream_url=_build_voice_events_stream_url(user_id, call_id, session_id),
        session_id=session_id,
    )


@router.get(
    "/{user_id}/voice/events",
    summary="Stream voice session events",
    description="Proxy the voice service SSE stream to the authenticated browser client.",
)
async def voice_events(
    user_id: str,
    request: Request,
    call_id: str = Query(..., description="The voice call ID returned from /voice/connect"),
    session_id: str = Query(..., description="The voice session ID returned from /voice/connect"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions/{session_id}/events"
    url, upstream_headers = _voice_event_upstream_request(url, _voice_event_cursor(request))
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers=upstream_headers,
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/openai/browser-session",
    status_code=201,
    summary="Start an OpenAI browser WebRTC dogfood session",
    description="Internal dogfood path: mint an ephemeral OpenAI client secret and start normalized SSE routing.",
)
async def openai_browser_dogfood_session(
    user_id: str,
    body: OpenAIBrowserDogfoodStartRequest,
) -> dict[str, object]:
    payload = await _proxy_voice_dogfood_json(
        "POST",
        "/dogfood/realtime/openai/browser-sessions",
        json_body={
            "user_id": user_id,
            "session_id": body.session_id,
        },
    )
    session_id = payload.get("session_id")
    if isinstance(session_id, str):
        payload["stream_url"] = _build_openai_dogfood_events_stream_url(user_id, session_id)
    return payload


@router.post(
    "/{user_id}/voice/dogfood/openai/sideband",
    status_code=202,
    summary="Attach OpenAI browser WebRTC backend sideband",
)
async def openai_browser_dogfood_sideband(
    user_id: str,
    body: OpenAISidebandAttachRequest,
) -> dict[str, object]:
    encoded_session_id = quote(body.session_id, safe="")
    payload = await _proxy_voice_dogfood_json(
        "POST",
        f"/dogfood/realtime/openai/browser-sessions/{encoded_session_id}/sideband",
        json_body={
            "call_id": body.call_id,
            "location": body.location,
            "webrtc_readiness": body.webrtc_readiness,
        },
        timeout=VOICE_SERVER_DOGFOOD_SIDEBAND_TIMEOUT,
    )
    payload["stream_url"] = _build_openai_dogfood_events_stream_url(user_id, body.session_id)
    return payload


@router.get(
    "/{user_id}/voice/dogfood/openai/events",
    summary="Stream OpenAI browser dogfood normalized events",
    description="Proxy the voice service dogfood SSE stream to the authenticated browser client.",
)
async def openai_browser_dogfood_events(
    user_id: str,
    request: Request,
    session_id: str = Query(..., description="Dogfood session id returned by browser-session"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/dogfood/realtime/sessions/{encoded_session_id}/events"
    url, upstream_headers = _voice_event_upstream_request(url, _voice_event_cursor(request))
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers=upstream_headers,
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice dogfood session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice dogfood event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/openai/disconnect",
    status_code=204,
    summary="Close an OpenAI browser WebRTC dogfood session",
)
async def openai_browser_dogfood_disconnect(
    user_id: str,
    body: OpenAIBrowserDogfoodDisconnectRequest,
) -> None:
    encoded_session_id = quote(body.session_id, safe="")
    await _proxy_voice_dogfood_json(
        "DELETE",
        f"/dogfood/realtime/openai/browser-sessions/{encoded_session_id}",
    )


@router.post(
    "/{user_id}/voice/dogfood/gemini/browser-session",
    status_code=201,
    summary="Start a Gemini browser Live WebSocket dogfood session",
    description="Internal dogfood path: mint an ephemeral Gemini auth token and start normalized SSE routing.",
)
async def gemini_browser_dogfood_session(
    user_id: str,
    body: GeminiBrowserDogfoodStartRequest,
) -> dict[str, object]:
    payload = await _proxy_voice_dogfood_json(
        "POST",
        "/dogfood/realtime/gemini/browser-sessions",
        json_body={
            "user_id": user_id,
            "session_id": body.session_id,
        },
    )
    session_id = payload.get("session_id")
    if isinstance(session_id, str):
        payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, session_id)
    return payload


@router.post(
    "/{user_id}/voice/dogfood/gemini/relay",
    status_code=202,
    summary="Relay a Gemini browser Live server message",
)
async def gemini_browser_dogfood_relay(
    user_id: str,
    body: GeminiBrowserDogfoodRelayRequest,
) -> dict[str, object]:
    encoded_session_id = quote(body.session_id, safe="")
    guard_payload = _artifact_review_emit_suppression_payload(body)
    has_allowed_calls = _artifact_review_batch_has_allowed_calls(body) if guard_payload is not None else False
    if guard_payload is not None and not has_allowed_calls:
        guard_payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, body.session_id)
        return guard_payload

    relay_payload = (
        _voice_relay_payload_for_event(
            body,
            _without_blocked_artifact_review_calls(body.event, body.artifact_review_context),
        )
        if guard_payload is not None
        else body.voice_relay_payload()
    )

    payload = await _proxy_voice_dogfood_json(
        "POST",
        f"/dogfood/realtime/gemini/browser-sessions/{encoded_session_id}/provider-events",
        json_body=relay_payload,
    )
    payload = _merge_artifact_review_guard_payload(payload, guard_payload)
    payload["stream_url"] = _build_gemini_dogfood_events_stream_url(user_id, body.session_id)
    return payload


@router.get(
    "/{user_id}/voice/dogfood/gemini/events",
    summary="Stream Gemini browser dogfood normalized events",
    description="Proxy the voice service dogfood SSE stream to the authenticated browser client.",
)
async def gemini_browser_dogfood_events(
    user_id: str,
    request: Request,
    session_id: str = Query(..., description="Dogfood session id returned by browser-session"),
) -> StreamingResponse:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/dogfood/realtime/sessions/{encoded_session_id}/events"
    url, upstream_headers = _voice_event_upstream_request(url, _voice_event_cursor(request))
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )

    try:
        request = client.build_request(
            "GET",
            url,
            headers=upstream_headers,
        )
        response = await client.send(request, stream=True)
    except httpx.ConnectError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=503,
            detail="Voice dogfood event stream request failed.",
        ) from exc

    if response.status_code == 404:
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=404, detail="Voice dogfood session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await response.aclose()
            await client.aclose()

        raise HTTPException(
            status_code=502,
            detail=f"Voice dogfood event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        _proxy_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/dogfood/gemini/disconnect",
    status_code=204,
    summary="Close a Gemini browser Live WebSocket dogfood session",
)
async def gemini_browser_dogfood_disconnect(
    user_id: str,
    body: GeminiBrowserDogfoodDisconnectRequest,
) -> None:
    encoded_session_id = quote(body.session_id, safe="")
    await _proxy_voice_dogfood_json(
        "DELETE",
        f"/dogfood/realtime/gemini/browser-sessions/{encoded_session_id}",
        json_body=body.model_dump(exclude_none=True),
    )


@router.post(
    "/{user_id}/voice/gemini/relay",
    status_code=202,
    summary="Relay a production Gemini browser Live server message",
)
async def gemini_production_relay(
    user_id: str,
    body: GeminiBrowserDogfoodRelayRequest,
    request: Request,
) -> dict[str, object]:
    voice_lab_claims = _voice_lab_claims_for_active_session(
        request,
        user_id,
        body.session_id,
        required_operation="session:create",
    )
    runtime_capability = (
        sign_runtime_capability(voice_lab_claims)
        if voice_lab_claims is not None
        else None
    )
    encoded_session_id = quote(body.session_id, safe="")
    log_context = _gemini_relay_log_context(user_id=user_id, session_id=body.session_id, body=body)
    guard_payload = _artifact_review_emit_suppression_payload(body)
    has_allowed_calls = _artifact_review_batch_has_allowed_calls(body) if guard_payload is not None else False
    if guard_payload is not None and not has_allowed_calls:
        logger.info(
            "voice.gemini.relay suppressed review emit_artifact context=%s",
            log_context,
        )
        guard_payload["stream_url"] = _build_gemini_production_events_stream_url(body.session_id)
        return guard_payload

    relay_payload = (
        _voice_relay_payload_for_event(
            body,
            _without_blocked_artifact_review_calls(body.event, body.artifact_review_context),
        )
        if guard_payload is not None
        else body.voice_relay_payload()
    )

    from app.gateway.routers.voice_lab_d02_settlement import (
        gateway_d02_relay_lease,
    )

    relay_epoch = body.provider_connection_epoch
    if (
        voice_lab_claims is not None
        and voice_lab_claims.scenario_id == "V-D02"
        and (
            not isinstance(relay_epoch, int)
            or isinstance(relay_epoch, bool)
            or relay_epoch <= 0
        )
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_d02_provider_epoch_required"},
        )
    try:
        async with gateway_d02_relay_lease(
            cleanup_obligation_id=(
                voice_lab_claims.cleanup_obligation_id
                if voice_lab_claims is not None
                else ""
            ),
            provider_session_id=body.session_id,
            provider_connection_epoch=relay_epoch or 1,
            scenario_id=(
                voice_lab_claims.scenario_id
                if voice_lab_claims is not None
                else None
            ),
            relay_kind="provider_event",
        ) as relay_lease:
            payload = await _proxy_voice_runtime_json(
                "POST",
                f"/production/realtime/gemini/browser-sessions/{encoded_session_id}/provider-events",
                json_body=relay_payload,
                capability=runtime_capability,
            )
            await relay_lease.assert_live()
    except HTTPException as exc:
        logger.warning(
            "voice.gemini.relay failed status=%s detail=%s context=%s",
            exc.status_code,
            _safe_voice_error_detail(exc.detail),
            log_context,
        )
        raise
    logger.info(
        "voice.gemini.relay accepted status=202 context=%s",
        log_context,
    )
    payload = _merge_artifact_review_guard_payload(payload, guard_payload)
    payload["stream_url"] = _build_gemini_production_events_stream_url(body.session_id)
    return payload


@router.post(
    "/{user_id}/voice/gemini/activate",
    status_code=202,
    summary="Activate one browser-open synthetic Gemini provider epoch",
)
async def gemini_production_browser_activation(
    user_id: str,
    body: GeminiBrowserProviderActivationReceipt,
    request: Request,
) -> dict[str, object]:
    claims = _voice_lab_claims_for_active_session(
        request,
        user_id,
        body.session_id,
        required_operation="session:create",
    )
    if claims is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "provider_activation_receipt_not_allowed"},
        )
    if claims.scenario_id == "V-D02":
        from app.gateway.routers.voice_lab_d02_settlement import (
            assert_d02_producer_open,
        )

        await asyncio.to_thread(
            assert_d02_producer_open,
            claims.cleanup_obligation_id,
        )
    canonical_receipt = await asyncio.to_thread(
        _record_synthetic_browser_provider_activation,
        claims,
        body.session_id,
        body,
    )
    encoded_session_id = quote(body.session_id, safe="")
    activation = await _proxy_voice_runtime_json(
        "POST",
        f"/production/realtime/gemini/browser-sessions/{encoded_session_id}/activate",
        json_body={
            "previous_activated_epoch": body.previous_activated_epoch,
            "candidate_epoch": body.candidate_epoch,
        },
        capability=sign_runtime_capability(claims),
    )
    if (
        activation.get("activated") is not True
        or activation.get("session_id") != body.session_id
        or activation.get("provider_connection_epoch") != body.candidate_epoch
    ):
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_provider_activation_unconfirmed"},
        )
    return {
        "activated": True,
        "session_id": body.session_id,
        "provider_connection_epoch": body.candidate_epoch,
        "provider_activation_receipt": canonical_receipt,
    }


@router.post(
    "/{user_id}/voice/gemini/continuation-bootstrap",
    status_code=200,
    summary="Mint the next native Gemini Live continuation credential",
)
async def gemini_production_continuation_bootstrap(
    user_id: str,
    body: GeminiContinuationBootstrapRequest,
    request: Request,
    session_id: str = Query(..., description="Gemini voice runtime session id"),
) -> dict[str, object]:
    voice_lab_claims = _voice_lab_claims_for_active_session(
        request,
        user_id,
        session_id,
        required_operation="session:create",
    )
    voice_lab_retention_expires_at: str | None = None
    cleanup_provider_admission_id: str | None = None
    epoch_pre_reserved = False
    expected_voice_runtime_instance_id_sha256: str | None = None
    expected_voice_runtime_instance_public_key_spki_base64: str | None = None
    if voice_lab_claims is not None:
        from app.gateway.routers.sessions import _store

        record = _store.find_session_by_cleanup_obligation_id(
            voice_lab_claims.cleanup_obligation_id
        )
        if record is None:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_record_not_found"},
            )
        assert_voice_lab_session_record(record, voice_lab_claims)
        metadata = getattr(record, "metadata", None)
        synthetic = (
            metadata.get("synthetic_voice_lab")
            if isinstance(metadata, dict)
            else None
        )
        candidate = (
            synthetic.get("retention_expires_at")
            if isinstance(synthetic, dict)
            else None
        )
        if not isinstance(candidate, str):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_retention_missing"},
            )
        voice_lab_retention_expires_at = candidate
        admission_candidate = synthetic.get("cleanup_provider_admission_id")
        if (
            synthetic.get("voice_runtime_session_id") != session_id
            or synthetic.get("provider_expires_at")
            != voice_lab_claims.provider_expires_at
            or not isinstance(admission_candidate, str)
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_provider_continuation_binding_mismatch"},
            )
        cleanup_provider_admission_id = admission_candidate
        if voice_lab_claims.scenario_id == "V-D02":
            from app.gateway.routers.voice_lab_d02_settlement import (
                assert_d02_producer_open,
            )

            expected_voice_runtime_instance_id_sha256 = synthetic.get(
                "voice_runtime_instance_id_sha256"
            )
            expected_voice_runtime_instance_public_key_spki_base64 = synthetic.get(
                "voice_runtime_instance_public_key_spki_base64"
            )
            if (
                not isinstance(expected_voice_runtime_instance_id_sha256, str)
                or not isinstance(
                    expected_voice_runtime_instance_public_key_spki_base64, str
                )
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "voice_lab_d02_voice_owner_binding_missing"},
                )
            await asyncio.to_thread(
                assert_d02_producer_open,
                voice_lab_claims.cleanup_obligation_id,
            )
            epoch_pre_reserved = await asyncio.to_thread(
                _stage_synthetic_provider_connection_epoch,
                voice_lab_claims,
                session_id,
                expected_epoch=body.expected_epoch,
                next_epoch=body.expected_epoch + 1,
            )
            if not epoch_pre_reserved:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "voice_lab_d02_continuation_reservation_failed"},
                )
    encoded_session_id = quote(session_id, safe="")
    try:
        payload = await _proxy_voice_runtime_json(
            "POST",
            f"/production/realtime/gemini/browser-sessions/{encoded_session_id}/continuation-bootstrap",
            json_body=body.model_dump(),
            capability=(
                sign_runtime_capability(voice_lab_claims)
                if voice_lab_claims is not None
                else None
            ),
        )
    except Exception:
        if epoch_pre_reserved and voice_lab_claims is not None:
            from deerflow.sophia.cleanup_fence import close_cleanup_obligation

            try:
                await asyncio.to_thread(
                    close_cleanup_obligation,
                    voice_lab_claims.cleanup_obligation_id,
                    voice_lab_retention_expires_at,
                    voice_lab_claims.provider_expires_at,
                )
            except Exception:  # noqa: BLE001 - retain durable pending epoch.
                logger.exception(
                    "voice_lab.d02_continuation_compensation_failed cleanup_id=%s",
                    voice_lab_claims.cleanup_obligation_id,
                )
        raise
    returned_session_id = payload.get("session_id")
    if not isinstance(returned_session_id, str) or returned_session_id != session_id:
        raise HTTPException(
            status_code=502,
            detail="Voice runtime returned an invalid continuation session identity.",
        )
    if voice_lab_claims is not None:
        ephemeral_token = payload.get("ephemeral_token")
        next_epoch = payload.get("provider_connection_epoch")
        if (
            not isinstance(ephemeral_token, dict)
            or ephemeral_token.get("expireTime")
            != voice_lab_claims.provider_expires_at
            or not isinstance(next_epoch, int)
            or isinstance(next_epoch, bool)
            or next_epoch != body.expected_epoch + 1
            or (
                voice_lab_claims.scenario_id == "V-D02"
                and (
                    payload.get("voice_runtime_instance_id_sha256")
                    != expected_voice_runtime_instance_id_sha256
                    or payload.get(
                        "voice_runtime_instance_public_key_spki_base64"
                    )
                    != expected_voice_runtime_instance_public_key_spki_base64
                )
            )
        ):
            from deerflow.sophia.cleanup_fence import close_cleanup_obligation

            await asyncio.to_thread(
                close_cleanup_obligation,
                voice_lab_claims.cleanup_obligation_id,
                voice_lab_retention_expires_at,
                voice_lab_claims.provider_expires_at,
            )
            await _disconnect_gemini_production_session(
                session_id,
                capability=sign_runtime_capability(voice_lab_claims),
            )
            raise HTTPException(
                status_code=502,
                detail={"code": "voice_lab_provider_continuation_mismatch"},
            )
        try:
            epoch_persisted = epoch_pre_reserved or await asyncio.to_thread(
                _stage_synthetic_provider_connection_epoch,
                voice_lab_claims,
                session_id,
                expected_epoch=body.expected_epoch,
                next_epoch=next_epoch,
            )
        except Exception:  # noqa: BLE001 - close without claiming zero.
            epoch_persisted = False
        if not epoch_persisted:
            from deerflow.sophia.cleanup_fence import close_cleanup_obligation

            await asyncio.to_thread(
                close_cleanup_obligation,
                voice_lab_claims.cleanup_obligation_id,
                voice_lab_retention_expires_at,
                voice_lab_claims.provider_expires_at,
            )
            await _disconnect_gemini_production_session(
                session_id,
                capability=sign_runtime_capability(voice_lab_claims),
            )
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_provider_epoch_persistence_failed"},
            )
        try:
            cleanup_authority = mint_provider_cleanup_token(
                voice_lab_claims,
                session_id,
                str(cleanup_provider_admission_id),
                str(voice_lab_retention_expires_at),
            )
        except Exception as exc:  # noqa: BLE001 - staged credential must fail closed.
            from deerflow.sophia.cleanup_fence import close_cleanup_obligation

            await asyncio.to_thread(
                close_cleanup_obligation,
                voice_lab_claims.cleanup_obligation_id,
                voice_lab_retention_expires_at,
                voice_lab_claims.provider_expires_at,
            )
            await _disconnect_gemini_production_session(
                session_id,
                capability=sign_runtime_capability(voice_lab_claims),
            )
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_provider_cleanup_authority_unavailable"},
            ) from exc
        payload["provider_cleanup_token"] = cleanup_authority.token
        payload["provider_cleanup_expires_at"] = (
            cleanup_authority.cleanup_expires_at
        )
    payload["continuation_bootstrap_url"] = (
        "/api/sophia/voice/gemini/continuation-bootstrap"
        f"?session_id={encoded_session_id}"
    )
    if voice_lab_claims is not None:
        payload["provider_activation_url"] = "/api/sophia/voice/gemini/activate"
    return payload


@router.get(
    "/{user_id}/voice/gemini/events",
    summary="Stream production Gemini normalized events",
    description="Proxy the voice service Gemini production SSE stream to the authenticated browser client.",
)
async def gemini_production_events(
    user_id: str,
    request: Request,
    session_id: str = Query(..., description="Gemini production session id returned by /voice/connect"),
) -> StreamingResponse:
    voice_lab_claims = _voice_lab_claims_for_active_session(
        request,
        user_id,
        session_id,
        required_operation="session:finalize",
    )
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/production/realtime/gemini/sessions/{encoded_session_id}/events"
    url, upstream_headers = _voice_event_upstream_request(url, _voice_event_cursor(request))
    if voice_lab_claims is not None:
        upstream_headers[VOICE_LAB_CAPABILITY_HEADER] = sign_runtime_capability(
            voice_lab_claims
        )
    relay_epoch = 1
    if voice_lab_claims is not None and voice_lab_claims.scenario_id == "V-D02":
        from app.gateway.routers.sessions import _store

        record = _store.find_session_by_cleanup_obligation_id(
            voice_lab_claims.cleanup_obligation_id
        )
        metadata = getattr(record, "metadata", None)
        synthetic = (
            metadata.get("synthetic_voice_lab")
            if isinstance(metadata, dict)
            else None
        )
        candidate_epoch = (
            synthetic.get("voice_provider_connection_epoch")
            if isinstance(synthetic, dict)
            else None
        )
        if (
            record is None
            or not isinstance(candidate_epoch, int)
            or isinstance(candidate_epoch, bool)
            or candidate_epoch <= 0
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_d02_provider_epoch_unavailable"},
            )
        relay_epoch = candidate_epoch
    from app.gateway.routers.voice_lab_d02_settlement import (
        gateway_d02_relay_lease,
    )

    relay_context = gateway_d02_relay_lease(
        cleanup_obligation_id=(
            voice_lab_claims.cleanup_obligation_id
            if voice_lab_claims is not None
            else ""
        ),
        provider_session_id=session_id,
        provider_connection_epoch=relay_epoch,
        scenario_id=(
            voice_lab_claims.scenario_id
            if voice_lab_claims is not None
            else None
        ),
        relay_kind="event_stream",
    )
    relay_lease = await relay_context.__aenter__()
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
    )
    cleanup_lock = asyncio.Lock()
    cleaned = False
    response: httpx.Response | None = None

    async def _finalize_stream_owner() -> None:
        nonlocal cleaned
        async with cleanup_lock:
            if cleaned:
                return
            cleaned = True
            if response is not None:
                await response.aclose()
            await client.aclose()
            await relay_context.__aexit__(None, None, None)

    try:
        upstream_request = client.build_request(
            "GET",
            url,
            headers=upstream_headers,
        )
        response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError as exc:
        await _finalize_stream_owner()
        raise HTTPException(
            status_code=503,
            detail="Voice Gemini event stream unavailable.",
        ) from exc
    except httpx.RequestError as exc:
        await _finalize_stream_owner()
        raise HTTPException(
            status_code=503,
            detail="Voice Gemini event stream request failed.",
        ) from exc

    assert response is not None
    if response.status_code == 404:
        await _finalize_stream_owner()
        raise HTTPException(status_code=404, detail="Voice Gemini session not found.")

    if response.status_code >= 400:
        try:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:200]
        finally:
            await _finalize_stream_owner()

        raise HTTPException(
            status_code=502,
            detail=f"Voice Gemini event stream failed with HTTP {response.status_code}: {detail}",
        )

    async def _proxy_stream() -> AsyncIterator[bytes]:
        relay_lease.bind_current_task()
        try:
            await relay_lease.assert_live()
            async for chunk in response.aiter_bytes():
                await relay_lease.assert_live()
                yield chunk
        finally:
            await _finalize_stream_owner()

    return _FinalizingStreamingResponse(
        _proxy_stream(),
        finalizer=_finalize_stream_owner,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/{user_id}/voice/gemini/disconnect",
    status_code=202,
    summary="Close a production Gemini browser Live session",
)
async def gemini_production_disconnect(
    user_id: str,
    body: GeminiBrowserDogfoodDisconnectRequest,
    request: Request,
) -> dict[str, object]:
    cleanup_binding = _provider_cleanup_claims_for_disconnect(
        request,
        user_id=user_id,
        provider_session_id=body.session_id,
    )
    cleanup_provider_admission_id: str | None = None
    if cleanup_binding is not None:
        voice_lab_claims, cleanup_provider_admission_id = cleanup_binding
    else:
        voice_lab_claims = _voice_lab_claims_for_active_session(
            request,
            user_id,
            body.session_id,
            required_operation="session:finalize",
        )
    browser_close_receipts: list[dict[str, object]] | None = None
    browser_activation_abort_receipts: list[dict[str, object]] | None = None
    if voice_lab_claims is not None:
        submitted_close_receipts = list(body.browser_provider_close_receipts)
        if body.browser_provider_close_receipt is not None:
            submitted_close_receipts.append(body.browser_provider_close_receipt)
        if not submitted_close_receipts and not body.browser_provider_activation_abort_receipts:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_browser_provider_settlement_required"},
            )
        (
            browser_close_receipts,
            browser_activation_abort_receipts,
        ) = await asyncio.to_thread(
            _record_synthetic_browser_provider_close,
            voice_lab_claims,
            body.session_id,
            submitted_close_receipts,
            list(body.browser_provider_activation_abort_receipts),
            expected_cleanup_provider_admission_id=(
                cleanup_provider_admission_id
            ),
        )
    elif (
        body.browser_provider_close_receipt is not None
        or body.browser_provider_close_receipts
        or body.browser_provider_activation_abort_receipts
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "browser_provider_settlement_not_allowed"},
        )
    voice_disconnect_body = body.model_dump(
        exclude_none=True,
        exclude={
            "browser_provider_close_receipt",
            "browser_provider_close_receipts",
            "browser_provider_activation_abort_receipts",
        },
    )
    disconnect_result = await _disconnect_gemini_production_session(
        body.session_id,
        body=voice_disconnect_body,
        capability=(
            sign_retention_reaper_runtime_capability(
                voice_lab_claims,
                provider_session_id=body.session_id,
            )
            if cleanup_binding is not None
            else sign_runtime_capability(voice_lab_claims)
            if voice_lab_claims is not None
            else None
        ),
    )
    if (
        cleanup_provider_admission_id is not None
        and voice_lab_claims is not None
        and voice_lab_claims.scenario_id == VOICE_LAB_TRACE_FAULT_SCENARIO_ID
        and disconnect_result.trace_fault is None
    ):
        persisted_trace_fault = await asyncio.to_thread(
            _persisted_provider_trace_fault_restore_receipt,
            voice_lab_claims,
            provider_session_id=body.session_id,
            cleanup_provider_admission_id=cleanup_provider_admission_id,
        )
        if persisted_trace_fault is not None:
            disconnect_result = GeminiProductionDisconnectResult(
                disconnected=True,
                trace_fault=persisted_trace_fault,
            )
    if voice_lab_claims is not None and not disconnect_result:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_provider_disconnect_unconfirmed"},
        )
    if (
        voice_lab_claims is not None
        and voice_lab_claims.scenario_id == VOICE_LAB_TRACE_FAULT_SCENARIO_ID
        and disconnect_result.trace_fault is None
    ):
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_trace_fault_restore_receipt_missing"},
        )

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        active_session = _active_voice_sessions.get(user_id)
        if (
            active_session is not None
            and active_session.runtime == "gemini_live"
            and active_session.session_id == body.session_id
        ):
            _active_voice_sessions.pop(user_id, None)
    return {
        "ok": bool(disconnect_result),
        "closed": bool(disconnect_result),
        **(
            {
                "browser_provider_close_receipts": browser_close_receipts,
                "browser_provider_activation_abort_receipts": (
                    browser_activation_abort_receipts
                ),
            }
            if browser_close_receipts is not None
            else {}
        ),
        **(
            {"trace_fault": disconnect_result.trace_fault}
            if disconnect_result.trace_fault is not None
            else {}
        ),
    }


@router.post(
    "/{user_id}/voice/warmup",
    status_code=202,
    summary="Warm backend session path",
    description="Schedule a best-effort Sophia backend warmup for an active voice session.",
)
async def voice_warmup(user_id: str, body: VoiceWarmupRequest) -> None:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{body.call_id}/sessions/{body.session_id}/warmup"

    try:
        async with httpx.AsyncClient(timeout=VOICE_SERVER_WARMUP_TIMEOUT) as client:
            resp = await client.post(
                url,
                json={"user_id": user_id},
                **_voice_auth_request_kwargs(),
            )
            resp.raise_for_status()
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail="Voice warmup failed because the voice server is unreachable.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Voice warmup timed out.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Voice warmup failed with status {exc.response.status_code}.",
        ) from exc


async def _dispatch_voice_agent(
    call_id: str,
    call_type: str,
    platform: str,
    context_mode: str,
    ritual: str | None,
    session_id: str | None = None,
    thread_id: str | None = None,
) -> str | None:
    """Tell the Vision Agents voice server to spawn an agent for this call.

    Returns the session_id on success, or None if the voice server is unavailable
    (logged as a warning — the call proceeds without an agent so the frontend
    can display an appropriate error state rather than hanging).
    """
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions"

    try:
        async with httpx.AsyncClient(timeout=VOICE_SERVER_DISPATCH_TIMEOUT) as client:
            resp = await client.post(
                url,
                json={
                    "call_type": call_type,
                    "platform": platform,
                    "context_mode": context_mode,
                    "ritual": ritual,
                    "session_id": session_id,
                    "thread_id": thread_id,
                },
                **_voice_auth_request_kwargs(),
            )
            resp.raise_for_status()
            try:
                data = resp.json()
            except ValueError:
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid JSON for call_id=%s",
                    call_id,
                )
                return None

            if not isinstance(data, dict):
                logger.warning(
                    "voice.dispatch failed — voice server returned non-object payload for call_id=%s",
                    call_id,
                )
                return None

            session_id = data.get("session_id")
            if session_id is not None and not isinstance(session_id, str):
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid session_id for call_id=%s",
                    call_id,
                )
                return None

            logger.info("voice.dispatch call_id=%s session_id=%s", call_id, session_id)
            return session_id
    except httpx.ConnectError:
        logger.warning("voice.dispatch failed — voice server unreachable at %s", voice_url)
        return None
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.dispatch failed — voice server returned %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return None
    except httpx.TimeoutException:
        logger.warning("voice.dispatch timed out after %.1fs for call_id=%s", VOICE_SERVER_DISPATCH_TIMEOUT, call_id)
        return None
    except httpx.RequestError as exc:
        logger.warning(
            "voice.dispatch failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )
        return None


@router.post(
    "/{user_id}/voice/disconnect",
    status_code=204,
    summary="End a voice session",
    description="Signal the Voice Agent to leave the call. Falls back to idle timeout if unreachable.",
)
async def voice_disconnect(user_id: str, body: VoiceDisconnectRequest) -> None:
    """Request the voice server to close the agent session."""
    await _disconnect_voice_session(body.call_id, body.session_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        active_session = _active_voice_sessions.get(user_id)
        if active_session == ActiveVoiceSession(call_id=body.call_id, session_id=body.session_id):
            _active_voice_sessions.pop(user_id, None)

    logger.info(
        "voice.disconnect user_id=%s call_id=%s session_id=%s",
        user_id,
        body.call_id,
        body.session_id,
    )


async def _disconnect_voice_session(call_id: str, session_id: str) -> None:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions/{session_id}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.delete(url, **_voice_auth_request_kwargs())
            if resp.status_code == 404:
                logger.info(
                    "voice.disconnect session already gone call_id=%s session_id=%s",
                    call_id,
                    session_id,
                )
                return
            resp.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.disconnect — voice server unreachable, relying on idle timeout for call_id=%s",
            call_id,
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.disconnect failed — %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        logger.warning(
            "voice.disconnect failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )


async def _disconnect_gemini_production_session(
    session_id: str,
    *,
    body: dict[str, object] | None = None,
    capability: str | None = None,
) -> GeminiProductionDisconnectResult:
    voice_url = _get_voice_server_url()
    encoded_session_id = quote(session_id, safe="")
    url = f"{voice_url}/production/realtime/gemini/browser-sessions/{encoded_session_id}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.request(
                "DELETE",
                url,
                json=body,
                **_voice_auth_request_kwargs(
                    {VOICE_LAB_CAPABILITY_HEADER: capability}
                    if capability
                    else None
                ),
            )
            if resp.status_code == 404:
                logger.info(
                    "voice.gemini.disconnect session already gone session_id=%s",
                    session_id,
                )
                return GeminiProductionDisconnectResult(disconnected=True)
            resp.raise_for_status()
            trace_fault: dict[str, object] | None = None
            try:
                payload = resp.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("trace_fault"), dict):
                trace_fault = dict(payload["trace_fault"])
            return GeminiProductionDisconnectResult(
                disconnected=(
                    payload.get("closed") is True
                    if isinstance(payload, dict) and "closed" in payload
                    else True
                ),
                trace_fault=trace_fault,
            )
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.gemini.disconnect — voice server unreachable, relying on idle timeout for session_id=%s",
            session_id,
        )
        return GeminiProductionDisconnectResult(disconnected=False)
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.gemini.disconnect failed — %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return GeminiProductionDisconnectResult(disconnected=False)
    except httpx.RequestError as exc:
        logger.warning(
            "voice.gemini.disconnect failed — request error for session_id=%s: %s",
            session_id,
            exc,
        )
        return GeminiProductionDisconnectResult(disconnected=False)
