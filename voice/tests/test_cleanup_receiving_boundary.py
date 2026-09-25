"""Opt-in cross-component receiver test, never an optional import fallback.

Run from backend/ with SOPHIA_VOICE_LAB_CROSS_COMPONENT_TESTS=1, PYTHONPATH=.:..
and uv run --with-requirements ../voice/requirements-dev.txt pytest <this file>.
The opt-in requires both dependency graphs; missing imports then fail normally.
"""

# ruff: noqa: E402
import os
from pathlib import Path

import pytest

if os.getenv("SOPHIA_VOICE_LAB_CROSS_COMPONENT_TESTS") != "1":
    pytest.skip("Opt in with SOPHIA_VOICE_LAB_CROSS_COMPONENT_TESTS=1 and the documented combined dependency graph.", allow_module_level=True)

from backend.tests.test_voice_lab_capability import (
    _auth_request,
    _claims,
    _provider_close_receipt,
    _seed_provider_settlement,
    _sign,
    _verify,
    voice_lab_env,  # noqa: F401
)
from fastapi import FastAPI

from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers import voice as voice_router
from app.gateway.voice_lab_capability import mint_provider_cleanup_token


@pytest.mark.anyio
@pytest.mark.usefixtures("voice_lab_env")
@pytest.mark.parametrize("failure", [None, "wrong_admission", "unauthorized_callback"])
async def test_cleanup_token_crosses_real_voice_receiver_and_admission_callbacks(monkeypatch, failure):
    """Cross the real signer, Voice auth/DELETE, and exact callback routes."""
    import httpx

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    import voice.server as voice_server
    from voice.realtime.gemini_production_session import GeminiProductionBrowserSessionManager, _ProviderCleanupWatch

    from app.gateway.routers import voice_lab_recovery as recovery_router

    admission, record, _state = _seed_provider_settlement(monkeypatch)
    claims = _verify(_sign(_claims()))
    assert claims is not None
    authority = mint_provider_cleanup_token(claims, "provider-session-1", admission.admission_id, str(record.metadata["synthetic_voice_lab"]["retention_expires_at"]))

    class BrowserSessions:
        exists = True
        close_count = 0

        def session_exists(self, _session_id):
            return self.exists

        def synthetic_context_for_session(self, _session_id):
            return claims.synthetic_context() if self.exists else None

        def trace_fault_for_session(self, _session_id):
            return None

        def provider_epoch_snapshot(self, _session_id):
            return (1,) if self.exists else ()

        async def publish_provider_cleanup_control(self, _session_id, **_kwargs):
            return True

        async def close_session(self, _session_id, **_kwargs):
            previously = self.exists
            self.exists = False
            self.close_count += 1
            return previously

    browser = BrowserSessions()
    manager = GeminiProductionBrowserSessionManager(browser)
    manager._cleanup_watches["provider-session-1"] = _ProviderCleanupWatch(
        admission_id="00000000-0000-4000-8000-000000000001" if failure == "wrong_admission" else admission.admission_id,
        cleanup_obligation_id=claims.cleanup_obligation_id,
        resource_id="provider-session-1",
        reserved_lease_expires_at=admission.lease_expires_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        resource_expires_at=claims.provider_expires_at,
    )
    if failure == "unauthorized_callback":
        monkeypatch.setattr(manager, "_cleanup_callback_headers", lambda: {"X-Sophia-Voice-Internal-Auth": "wrong-secret"})
    monkeypatch.setattr(voice_server, "gemini_production_browser_sessions", manager)
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED", "true")
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "https://gateway.test")
    monkeypatch.setenv("VOICE_SERVER_URL", "https://voice.test")
    voice_app = FastAPI()
    voice_app.include_router(voice_server.production_realtime_router)
    callback_app = FastAPI()
    callback_app.include_router(recovery_router.router)
    transports = {"voice.test": httpx.ASGITransport(app=voice_app), "gateway.test": httpx.ASGITransport(app=callback_app)}
    observed = []

    async def route(request):
        observed.append((request.method, request.url.path))
        return await transports[request.url.host].handle_async_request(request)

    native_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: native_client(**kwargs, transport=httpx.MockTransport(route)))

    async def disconnect():
        request = _auth_request(None, route_path="/api/sophia/{user_id}/voice/gemini/disconnect", concrete_path="/api/sophia/voice-lab-user-1/voice/gemini/disconnect", provider_cleanup_token=authority.token)
        assert await require_authorized_user_scope(request) == "voice-lab-user-1"
        return await voice_router.gemini_production_disconnect("voice-lab-user-1", voice_router.GeminiBrowserDogfoodDisconnectRequest(session_id="provider-session-1", browser_provider_close_receipts=[_provider_close_receipt()]), request)

    if failure is not None:
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as error:
            await disconnect()
        assert error.value.status_code == 503
        assert browser.exists
        assert browser.close_count == 0
        return
    result = await disconnect()
    assert result["closed"] is True
    assert not browser.exists
    assert "provider-session-1" not in manager._cleanup_watches
    assert ("POST", f"/internal/voice-lab/cleanup-admissions/{admission.admission_id}/authorize") in observed
    assert ("POST", f"/internal/voice-lab/cleanup-admissions/{admission.admission_id}/complete") in observed
    assert (await disconnect())["closed"] is True
    assert browser.close_count == 1
