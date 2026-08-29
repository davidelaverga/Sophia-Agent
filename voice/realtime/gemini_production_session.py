from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from voice.realtime.dogfood_session import RealtimeDogfoodConfigurationError
from voice.realtime.gemini_browser_dogfood import (
    GeminiBrowserDogfoodSession,
    GeminiBrowserDogfoodSessionManager,
    GeminiRelaySourceMetadata,
    validate_gemini_browser_dogfood_settings,
)
from voice.realtime.gemini_memory_context import (
    build_gemini_live_realtime_instructions_with_memory_context,
)
from voice.realtime.runtime_selection import (
    GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG,
    VoiceRuntimeMode,
)

# This key exists only for the lifetime of one Voice process boot.  Its SPKI
# fingerprint is bound into the canonical provider session before the browser
# receives credentials, so another replica (even one holding the same service
# secrets) cannot author the owning instance's terminal receipt.
_VOICE_RUNTIME_INSTANCE_PRIVATE_KEY = Ed25519PrivateKey.generate()
_VOICE_RUNTIME_INSTANCE_PUBLIC_KEY_DER = (
    _VOICE_RUNTIME_INSTANCE_PRIVATE_KEY.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
)
VOICE_RUNTIME_INSTANCE_PUBLIC_KEY_SPKI_BASE64 = base64.b64encode(
    _VOICE_RUNTIME_INSTANCE_PUBLIC_KEY_DER
).decode("ascii")
VOICE_RUNTIME_INSTANCE_ID_SHA256 = hashlib.sha256(
    _VOICE_RUNTIME_INSTANCE_PUBLIC_KEY_DER
).hexdigest()
VOICE_RUNTIME_INSTANCE_AUTHORITY_KEY_ID = (
    f"voice-runtime-{VOICE_RUNTIME_INSTANCE_ID_SHA256[:16]}"
)


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _voice_runtime_owner_payload() -> dict[str, str]:
    return {
        "voice_runtime_instance_id_sha256": VOICE_RUNTIME_INSTANCE_ID_SHA256,
        "voice_runtime_instance_public_key_spki_base64": (
            VOICE_RUNTIME_INSTANCE_PUBLIC_KEY_SPKI_BASE64
        ),
    }


def _sign_d02_terminal_receipt(
    *,
    watch: _ProviderCleanupWatch,
    provider_connection_epochs: tuple[int, ...],
) -> dict[str, object]:
    core: dict[str, object] = {
        "schema": "sophia_voice_lab_voice_provider_terminal_v1",
        "issuer": "sophia-voice",
        "audience": "sophia-gateway-d02-terminal",
        "authority_key_id": VOICE_RUNTIME_INSTANCE_AUTHORITY_KEY_ID,
        "cleanup_obligation_id": watch.cleanup_obligation_id,
        "provider_admission_id": watch.admission_id,
        "provider_session_id": watch.resource_id,
        "provider_connection_epochs": list(provider_connection_epochs),
        "voice_runtime_instance_id_sha256": VOICE_RUNTIME_INSTANCE_ID_SHA256,
        "voice_provider_session_absent": True,
        "voice_relay_state_absent": True,
        "observed_at": _canonical_utc_millis(datetime.now(UTC)),
        "jti": str(uuid.uuid4()),
        "signature_algorithm": "ed25519-sha256-canonical-json-v1",
    }
    receipt_sha256 = hashlib.sha256(_canonical_json(core).encode("utf-8")).hexdigest()
    signature = _VOICE_RUNTIME_INSTANCE_PRIVATE_KEY.sign(bytes.fromhex(receipt_sha256))
    return {
        **core,
        "receipt_sha256": receipt_sha256,
        "signature": base64.urlsafe_b64encode(signature)
        .rstrip(b"=")
        .decode("ascii"),
    }


@dataclass(frozen=True)
class GeminiProductionBrowserSession:
    browser_session: GeminiBrowserDogfoodSession

    @property
    def session_id(self) -> str:
        return self.browser_session.dogfood_session.session_id

    def as_public_payload(self) -> dict[str, Any]:
        session_id = self.session_id
        payload = self.browser_session.as_public_payload()
        payload.update(
            {
                "runtime": VoiceRuntimeMode.GEMINI_LIVE.value,
                "voice_runtime": VoiceRuntimeMode.GEMINI_LIVE.value,
                "production_route": True,
                "browser_audio": "gemini_live_websocket_production_candidate",
                "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
                "stream_url": f"/production/realtime/gemini/sessions/{session_id}/events",
                "event_stream_url": f"/production/realtime/gemini/sessions/{session_id}/events",
                "provider_event_relay_url": (
                    "/production/realtime/gemini/browser-sessions/"
                    f"{session_id}/provider-events"
                ),
                "disconnect_url": f"/production/realtime/gemini/browser-sessions/{session_id}",
                "continuation_bootstrap_url": (
                    f"/production/realtime/gemini/browser-sessions/{session_id}/continuation-bootstrap"
                ),
                "public_event_boundary": "SophiaEventNormalizer",
                **_voice_runtime_owner_payload(),
            }
        )
        return payload


@dataclass(frozen=True)
class _ProviderCleanupWatch:
    admission_id: str
    cleanup_obligation_id: str
    resource_id: str
    reserved_lease_expires_at: str
    resource_expires_at: str


class GeminiProductionBrowserSessionManager:
    def __init__(self, browser_sessions: GeminiBrowserDogfoodSessionManager) -> None:
        self._browser_sessions = browser_sessions
        self._cleanup_locks: dict[str, asyncio.Lock] = {}
        self._cleanup_closed_session_ids: dict[str, float] = {}
        self._cleanup_watch_tasks: dict[str, asyncio.Task[None]] = {}
        self._cleanup_watches: dict[str, _ProviderCleanupWatch] = {}
        self._cleanup_trace_fault_receipts: dict[str, dict[str, object]] = {}
        self._cleanup_terminal_epoch_snapshots: dict[str, tuple[int, ...]] = {}

    def _cleanup_lock(self, session_id: str) -> asyncio.Lock:
        return self._cleanup_locks.setdefault(session_id, asyncio.Lock())

    def _install_cleanup_watch(
        self,
        session_id: str,
        watch: _ProviderCleanupWatch,
    ) -> None:
        self._cleanup_watches[session_id] = watch
        current = self._cleanup_watch_tasks.get(session_id)
        if current is not None and not current.done():
            return
        task = asyncio.create_task(
            self._watch_cleanup_admission(session_id, watch),
            name=f"voice-lab-provider-cleanup-{session_id}",
        )
        self._cleanup_watch_tasks[session_id] = task
        task.add_done_callback(
            lambda completed, expected=session_id: (
                self._cleanup_watch_tasks.pop(expected, None)
                if self._cleanup_watch_tasks.get(expected) is completed
                else None
            )
        )

    def synthetic_context_for_session(self, session_id: str) -> dict[str, Any] | None:
        return self._browser_sessions.synthetic_context_for_session(session_id)

    def session_exists(self, session_id: str) -> bool:
        return self._browser_sessions.session_exists(session_id)

    def trace_fault_for_session(self, session_id: str) -> dict[str, object] | None:
        receipt = self._browser_sessions.trace_fault_for_session(session_id)
        if receipt is not None:
            return receipt
        terminal = self._cleanup_trace_fault_receipts.get(session_id)
        return dict(terminal) if terminal is not None else None

    @staticmethod
    def _restored_trace_fault_receipt(
        applied: Mapping[str, object] | None,
    ) -> dict[str, object] | None:
        if applied is None:
            return None
        return {
            **dict(applied),
            "phase": "restored",
            "restored_at": datetime.now(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
        }

    async def start_browser_session(
        self,
        settings: object,
        *,
        user_id: str,
        session_id: str | None = None,
        thread_id: str | None = None,
        platform: str = "voice",
        context_mode: str = "life",
        ritual: str | None = None,
        realtime_context: Mapping[str, Any] | None = None,
        preconnect_ttl_seconds: float | None = None,
        logical_session_id: str | None = None,
        trace_fault_receipt: Mapping[str, object] | None = None,
        cleanup_admission_expires_at_epoch: float | None = None,
        cleanup_resource_expires_at_epoch: float | None = None,
        cleanup_admission_id: str | None = None,
        cleanup_obligation_id: str | None = None,
    ) -> GeminiProductionBrowserSession:
        cleanup_lock = self._cleanup_lock(session_id) if session_id is not None else None

        async def allocate() -> GeminiProductionBrowserSession:
            validate_gemini_production_route_settings(settings)
            now = time.monotonic()
            self._cleanup_closed_session_ids = {
                key: expiry
                for key, expiry in self._cleanup_closed_session_ids.items()
                if expiry > now
            }
            if session_id is not None and session_id in self._cleanup_closed_session_ids:
                raise RealtimeDogfoodConfigurationError(
                    "Synthetic provider cleanup admission is closed."
                )
            watch: _ProviderCleanupWatch | None = None
            if cleanup_admission_id is not None:
                if session_id is None or cleanup_obligation_id is None:
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider cleanup admission binding is incomplete."
                    )
                watch = _ProviderCleanupWatch(
                    admission_id=cleanup_admission_id,
                    cleanup_obligation_id=cleanup_obligation_id,
                    resource_id=session_id,
                    reserved_lease_expires_at="",
                    resource_expires_at="",
                )
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="start",
                )
                watch = self._validated_start_authorization(
                    watch,
                    authorization,
                    expected_deadline_epoch=cleanup_admission_expires_at_epoch,
                    expected_resource_deadline_epoch=cleanup_resource_expires_at_epoch,
                )
                self._install_cleanup_watch(session_id, watch)
            instructions, memory_context = build_gemini_live_realtime_instructions_with_memory_context(
                user_id=user_id,
                platform=platform,
                context_mode=context_mode,
                ritual=ritual,
                backend_context=realtime_context,
            )
            browser_session = await self._browser_sessions.start_browser_session(
                settings,
                user_id=user_id,
                session_id=session_id,
                instructions=instructions,
                memory_context_diagnostics=memory_context.diagnostics,
                context_mode=context_mode,
                memory_retrieval_config=_dynamic_memory_retrieval_config(realtime_context),
                preconnect_ttl_seconds=preconnect_ttl_seconds,
                thread_id=thread_id,
                logical_session_id=logical_session_id,
                continuation_bootstrap_url=None,
                synthetic_context=(
                    realtime_context.get("synthetic_test")
                    if isinstance(realtime_context, Mapping)
                    and isinstance(realtime_context.get("synthetic_test"), Mapping)
                    else None
                ),
                trace_fault_receipt=trace_fault_receipt,
                token_expire_time=watch.resource_expires_at if watch is not None else None,
            )
            if watch is not None:
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="start",
                )
                try:
                    watch = self._validated_start_authorization(
                        watch,
                        authorization,
                        expected_deadline_epoch=cleanup_admission_expires_at_epoch,
                        expected_resource_deadline_epoch=cleanup_resource_expires_at_epoch,
                    )
                except RealtimeDogfoodConfigurationError:
                    self._cleanup_closed_session_ids[watch.resource_id] = (
                        time.monotonic() + 600
                    )
                    await self._browser_sessions.close_session(watch.resource_id)
                    await self._post_cleanup_callback(watch, "complete")
                    raise
                self._install_cleanup_watch(session_id, watch)
            return GeminiProductionBrowserSession(browser_session=browser_session)

        if cleanup_lock is None:
            return await allocate()
        async with cleanup_lock:
            return await allocate()

    async def fence_and_close_session(self, session_id: str) -> bool:
        """Make cleanup win against an already queued deterministic start."""

        async with self._cleanup_lock(session_id):
            self._cleanup_closed_session_ids[session_id] = time.monotonic() + 600
            return await self.close_session(session_id)

    async def request_browser_cleanup(self, session_id: str) -> bool:
        """Ask the owning browser to close the spend-bearing provider socket."""

        async with self._cleanup_lock(session_id):
            watch = self._cleanup_watches.get(session_id)
            if watch is None:
                return False
            self._cleanup_closed_session_ids[session_id] = time.monotonic() + 600
            requested = await self._browser_sessions.publish_provider_cleanup_control(
                session_id,
                admission_id=watch.admission_id,
                cleanup_obligation_id=watch.cleanup_obligation_id,
                resource_expires_at=watch.resource_expires_at,
            )
            if requested:
                return True

            # The owning Voice process can outlive a browser preconnect that
            # disappeared before consuming its durable cleanup admission.  In
            # that case there is no browser socket left to receive the control
            # message, but this process still owns the exact admission watch.
            # Close locally and publish the normal completion callback instead
            # of leaving the durable admission stranded until process loss.
            await self.close_session(session_id)
            return session_id not in self._cleanup_watches

    def _cleanup_callback_url(self, watch: _ProviderCleanupWatch, action: str) -> str:
        base_url = (os.getenv("SOPHIA_GATEWAY_URL") or "").strip().rstrip("/")
        if not base_url.startswith("https://") and not base_url.startswith("http://"):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup callback is unavailable."
            )
        return (
            f"{base_url}/internal/voice-lab/cleanup-admissions/"
            f"{watch.admission_id}/{action}"
        )

    def _cleanup_callback_headers(self) -> dict[str, str]:
        secret = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
        if len(secret.encode()) < 32:
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup callback authentication is unavailable."
            )
        return {"X-Sophia-Voice-Internal-Auth": secret}

    @staticmethod
    def _validated_start_authorization(
        watch: _ProviderCleanupWatch,
        authorization: Mapping[str, Any] | None,
        *,
        expected_deadline_epoch: float | None,
        expected_resource_deadline_epoch: float | None,
    ) -> _ProviderCleanupWatch:
        if (
            authorization is None
            or authorization.get("authorized") is not True
            or authorization.get("status") != "allocating"
        ):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup admission is unavailable."
            )
        raw_deadline = authorization.get("lease_expires_at")
        if not isinstance(raw_deadline, str) or not raw_deadline.endswith("Z"):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup admission deadline is invalid."
            )
        try:
            parsed_deadline = datetime.fromisoformat(
                raw_deadline.replace("Z", "+00:00")
            ).astimezone(UTC)
        except ValueError as exc:
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup admission deadline is invalid."
            ) from exc
        if (
            expected_deadline_epoch is None
            or abs(parsed_deadline.timestamp() - expected_deadline_epoch) > 0.0015
        ):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup admission deadline is inconsistent."
            )
        if watch.reserved_lease_expires_at not in {"", raw_deadline}:
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider cleanup admission deadline changed before bind."
            )
        raw_resource_deadline = authorization.get("resource_expires_at")
        if (
            not isinstance(raw_resource_deadline, str)
            or not raw_resource_deadline.endswith("Z")
        ):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider absolute deadline is invalid."
            )
        try:
            parsed_resource_deadline = datetime.fromisoformat(
                raw_resource_deadline.replace("Z", "+00:00")
            ).astimezone(UTC)
        except ValueError as exc:
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider absolute deadline is invalid."
            ) from exc
        if (
            expected_resource_deadline_epoch is None
            or abs(
                parsed_resource_deadline.timestamp()
                - expected_resource_deadline_epoch
            )
            > 0.0015
            or watch.resource_expires_at not in {"", raw_resource_deadline}
        ):
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider absolute deadline is inconsistent."
            )
        return _ProviderCleanupWatch(
            admission_id=watch.admission_id,
            cleanup_obligation_id=watch.cleanup_obligation_id,
            resource_id=watch.resource_id,
            reserved_lease_expires_at=raw_deadline,
            resource_expires_at=raw_resource_deadline,
        )

    async def _post_cleanup_callback(
        self,
        watch: _ProviderCleanupWatch,
        action: str,
        *,
        phase: str | None = None,
        trace_fault: Mapping[str, object] | None = None,
        terminal_receipt: Mapping[str, object] | None = None,
    ) -> dict[str, Any] | None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    self._cleanup_callback_url(watch, action),
                    headers=self._cleanup_callback_headers(),
                    json={
                        "cleanup_obligation_id": watch.cleanup_obligation_id,
                        "resource_kind": "provider",
                        "resource_id": watch.resource_id,
                        **({"phase": phase} if phase is not None else {}),
                        **(
                            {"basis": "server_relay_zero"}
                            if action == "complete"
                            else {}
                        ),
                        **(
                            {"trace_fault": dict(trace_fault)}
                            if action == "complete" and trace_fault is not None
                            else {}
                        ),
                        **(
                            {"terminal_receipt": dict(terminal_receipt)}
                            if action == "complete" and terminal_receipt is not None
                            else {}
                        ),
                    },
                )
            if response.status_code != 200:
                return None
            payload = response.json()
            return payload if isinstance(payload, dict) else None
        except (httpx.HTTPError, ValueError, RealtimeDogfoodConfigurationError):
            return None

    async def _terminalize_d02_freeze(
        self,
        session_id: str,
        watch: _ProviderCleanupWatch,
        freeze: Mapping[str, object],
    ) -> bool:
        """Close the exact frozen owner state and publish an Ed25519 zero proof."""

        frozen_epochs = freeze.get("frozen_provider_connection_epochs")
        if (
            freeze.get("schema")
            != "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1"
            or freeze.get("cleanup_obligation_id") != watch.cleanup_obligation_id
            or freeze.get("provider_session_id") != session_id
            or not isinstance(frozen_epochs, list)
            or not frozen_epochs
            or any(
                not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0
                for epoch in frozen_epochs
            )
            or sorted(set(frozen_epochs)) != frozen_epochs
        ):
            return False
        exact_epochs = tuple(frozen_epochs)
        if self._browser_sessions.session_exists(session_id):
            closed = await self._browser_sessions.freeze_and_close_provider_epochs(
                session_id,
                expected_epochs=exact_epochs,
            )
            if not closed:
                return False
            self._cleanup_terminal_epoch_snapshots[session_id] = exact_epochs
        else:
            prior_epochs = self._cleanup_terminal_epoch_snapshots.get(session_id)
            if (
                prior_epochs is None
                or not set(prior_epochs).issubset(exact_epochs)
                or not prior_epochs
            ):
                return False
        if not self._browser_sessions.terminal_state_absent(session_id):
            return False
        receipt = _sign_d02_terminal_receipt(
            watch=watch,
            provider_connection_epochs=exact_epochs,
        )
        completion = await self._post_cleanup_callback(
            watch,
            "complete",
            terminal_receipt=receipt,
        )
        if (
            completion is None
            or completion.get("d02_terminal_proof_persisted") is not True
        ):
            return False
        self._cleanup_watches.pop(session_id, None)
        self._cleanup_trace_fault_receipts.pop(session_id, None)
        self._cleanup_terminal_epoch_snapshots.pop(session_id, None)
        return True

    async def _watch_cleanup_admission(
        self,
        session_id: str,
        watch: _ProviderCleanupWatch,
    ) -> None:
        while self._cleanup_watches.get(session_id) == watch:
            authorization = await self._post_cleanup_callback(
                watch,
                "authorize",
                phase="heartbeat",
            )
            d02_freeze = (
                authorization.get("d02_freeze")
                if isinstance(authorization, Mapping)
                else None
            )
            if isinstance(d02_freeze, Mapping):
                async with self._cleanup_lock(session_id):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    terminal = await self._terminalize_d02_freeze(
                        session_id,
                        watch,
                        d02_freeze,
                    )
                if terminal:
                    return
                await asyncio.sleep(1.0)
                continue
            if (
                authorization is not None
                and authorization.get("authorized") is True
                and authorization.get("status") == "browser_active"
                and authorization.get("resource_expires_at")
                == watch.resource_expires_at
            ):
                await asyncio.sleep(1.0)
                continue
            if (
                authorization is not None
                and authorization.get("authorized") is True
                and authorization.get("status") in {
                    "reserved",
                    "allocating",
                    "credential_minted",
                }
                and authorization.get("lease_expires_at")
                == watch.reserved_lease_expires_at
                and authorization.get("resource_expires_at")
                == watch.resource_expires_at
            ):
                await asyncio.sleep(1.0)
                continue
            status = authorization.get("status") if authorization is not None else None
            if (
                status in {"reserved", "allocating"}
                and authorization is not None
                and authorization.get("expired") is True
            ):
                async with self._cleanup_lock(session_id):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    await self.close_session(session_id)
                await asyncio.sleep(1.0)
                continue
            if status not in {
                "browser_closed",
                "activation_aborted",
                "missing",
            }:
                await self.request_browser_cleanup(session_id)
                await asyncio.sleep(1.0)
                continue
            async with self._cleanup_lock(session_id):
                self._cleanup_closed_session_ids[session_id] = time.monotonic() + 600
                await self.close_session(session_id)
            while self._cleanup_watches.get(session_id) == watch:
                completion = await self._post_cleanup_callback(
                    watch,
                    "complete",
                    trace_fault=self._cleanup_trace_fault_receipts.get(session_id),
                )
                if completion is not None and completion.get("completed") is True:
                    self._cleanup_watches.pop(session_id, None)
                    self._cleanup_trace_fault_receipts.pop(session_id, None)
                    return
                await asyncio.sleep(1.0)

    async def close_all(self, *, timeout_seconds: float = 10.0) -> None:
        """Durably terminalize every owned provider before graceful shutdown.

        The per-boot D02 signing key is intentionally not shared with another
        Voice instance.  A graceful owner therefore must not exit after merely
        closing its in-memory provider: it first observes any committed D02
        freeze and persists the matching signed terminal receipt.  If the
        ordinary completion callback loses a race with a freeze, the retained
        epoch snapshot lets the same owner sign on the next authorization
        read.  Timeout or callback ambiguity fails shutdown closed.
        """

        sessions = tuple(self._cleanup_watches)
        if not sessions:
            return

        async def terminalize_owned_session(session_id: str) -> None:
            while session_id in self._cleanup_watches:
                watch = self._cleanup_watches[session_id]
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="heartbeat",
                )
                if authorization is None:
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider shutdown authority is unavailable."
                    )
                freeze = authorization.get("d02_freeze")
                if isinstance(freeze, Mapping):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    if not await self._terminalize_d02_freeze(
                        session_id,
                        watch,
                        freeze,
                    ):
                        raise RealtimeDogfoodConfigurationError(
                            "Synthetic D02 terminal proof was not persisted."
                        )
                    return

                await self.close_session(session_id)
                if session_id not in self._cleanup_watches:
                    return

                # The generic completion may have raced a just-committed D02
                # freeze or suffered an ambiguous response.  Re-read owning
                # Gateway truth while this boot key and the exact epoch
                # snapshot are still alive.
                await asyncio.sleep(0)

        tasks = {
            asyncio.create_task(
                terminalize_owned_session(session_id),
                name=f"voice-lab-provider-shutdown-{session_id}",
            )
            for session_id in sessions
        }
        done, pending = await asyncio.wait(tasks, timeout=timeout_seconds)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            raise RealtimeDogfoodConfigurationError(
                "Synthetic provider shutdown terminalization timed out."
            )
        if done:
            # Propagate any fail-closed authority or persistence error so the
            # graceful owner cannot silently discard its unique signing key.
            await asyncio.gather(*done)

    async def ingest_browser_provider_event(
        self,
        settings: object,
        *,
        session_id: str,
        event: dict[str, Any],
        source_metadata: GeminiRelaySourceMetadata | None = None,
    ) -> dict[str, object]:
        validate_gemini_production_route_settings(settings)
        return await self._browser_sessions.ingest_browser_provider_event(
            settings,
            dogfood_session_id=session_id,
            event=event,
            source_metadata=source_metadata,
        )

    async def continue_browser_session(
        self,
        settings: object,
        *,
        session_id: str,
        expected_epoch: int,
        handle_present: bool,
        secret_generation: int,
    ) -> GeminiProductionBrowserSession:
        validate_gemini_production_route_settings(settings)
        async with self._cleanup_lock(session_id):
            watch = self._cleanup_watches.get(session_id)
            if watch is not None:
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="heartbeat",
                )
                freeze = (
                    authorization.get("d02_freeze")
                    if isinstance(authorization, Mapping)
                    else None
                )
                if isinstance(freeze, Mapping):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    await self._terminalize_d02_freeze(
                        session_id,
                        watch,
                        freeze,
                    )
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic D02 provider termination is frozen."
                    )
                if (
                    authorization is None
                    or authorization.get("authorized") is not True
                    or authorization.get("status") != "browser_active"
                    or authorization.get("resource_expires_at")
                    != watch.resource_expires_at
                ):
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider continuation admission is unavailable."
                    )
            browser_session = await self._browser_sessions.continue_browser_session(
                settings,
                dogfood_session_id=session_id,
                expected_epoch=expected_epoch,
                handle_present=handle_present,
                secret_generation=secret_generation,
                continuation_bootstrap_url=(
                    f"/production/realtime/gemini/browser-sessions/{session_id}/continuation-bootstrap"
                ),
                token_expire_time=(
                    watch.resource_expires_at if watch is not None else None
                ),
            )
            if watch is not None:
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="heartbeat",
                )
                freeze = (
                    authorization.get("d02_freeze")
                    if isinstance(authorization, Mapping)
                    else None
                )
                if isinstance(freeze, Mapping):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    await self._terminalize_d02_freeze(
                        session_id,
                        watch,
                        freeze,
                    )
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic D02 provider termination closed during mint."
                    )
                if (
                    authorization is None
                    or authorization.get("authorized") is not True
                    or authorization.get("status") != "browser_active"
                    or authorization.get("resource_expires_at")
                    != watch.resource_expires_at
                ):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    await self.close_session(session_id)
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider continuation admission closed during mint."
                    )
            return GeminiProductionBrowserSession(browser_session=browser_session)

    async def activate_browser_session_epoch(
        self,
        *,
        session_id: str,
        previous_activated_epoch: int,
        candidate_epoch: int,
    ) -> int:
        """Promote a browser-open epoch only while its durable admission is active."""

        async with self._cleanup_lock(session_id):
            watch = self._cleanup_watches.get(session_id)
            if watch is not None:
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="heartbeat",
                )
                if (
                    authorization is None
                    or authorization.get("authorized") is not True
                    or authorization.get("status") != "browser_active"
                    or authorization.get("resource_expires_at")
                    != watch.resource_expires_at
                ):
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider activation admission is unavailable."
                    )
            activated = await self._browser_sessions.activate_browser_session_epoch(
                dogfood_session_id=session_id,
                previous_activated_epoch=previous_activated_epoch,
                candidate_epoch=candidate_epoch,
            )
            if watch is not None:
                authorization = await self._post_cleanup_callback(
                    watch,
                    "authorize",
                    phase="heartbeat",
                )
                if (
                    authorization is None
                    or authorization.get("authorized") is not True
                    or authorization.get("status") != "browser_active"
                    or authorization.get("resource_expires_at")
                    != watch.resource_expires_at
                ):
                    self._cleanup_closed_session_ids[session_id] = (
                        time.monotonic() + 600
                    )
                    raise RealtimeDogfoodConfigurationError(
                        "Synthetic provider activation closed during commit."
                    )
            return activated

    async def close_session(
        self,
        session_id: str,
        *,
        conversation_audio: bytes | None = None,
        conversation_audio_mime_type: str = "audio/webm",
        trace_fault_restore_receipt: Mapping[str, object] | None = None,
    ) -> bool:
        applied_trace_fault = self.trace_fault_for_session(session_id)
        provider_epochs = self._browser_sessions.provider_epoch_snapshot(session_id)
        if trace_fault_restore_receipt is not None:
            self._cleanup_trace_fault_receipts[session_id] = dict(
                trace_fault_restore_receipt
            )
        closed = await self._browser_sessions.close_session(
            session_id,
            conversation_audio=conversation_audio,
            conversation_audio_mime_type=conversation_audio_mime_type,
        )
        local_zero = closed or not self._browser_sessions.session_exists(session_id)
        if local_zero and provider_epochs:
            self._cleanup_terminal_epoch_snapshots[session_id] = provider_epochs
        watch = self._cleanup_watches.get(session_id)
        if watch is not None and local_zero:
            restored_trace_fault = self._cleanup_trace_fault_receipts.get(session_id)
            if restored_trace_fault is None:
                restored_trace_fault = self._restored_trace_fault_receipt(
                    applied_trace_fault
                )
                if restored_trace_fault is not None:
                    self._cleanup_trace_fault_receipts[session_id] = (
                        restored_trace_fault
                    )
            completion = await self._post_cleanup_callback(
                watch,
                "complete",
                trace_fault=restored_trace_fault,
            )
            if completion is not None and completion.get("completed") is True:
                self._cleanup_watches.pop(session_id, None)
                self._cleanup_trace_fault_receipts.pop(session_id, None)
                self._cleanup_terminal_epoch_snapshots.pop(session_id, None)
                task = self._cleanup_watch_tasks.get(session_id)
                if task is not None and task is not asyncio.current_task():
                    task.cancel()
        return closed


def validate_gemini_production_route_settings(settings: object) -> None:
    selection = settings.voice_runtime_selection
    if selection.mode != VoiceRuntimeMode.GEMINI_LIVE:
        raise RealtimeDogfoodConfigurationError(
            "Gemini production voice route requires SOPHIA_VOICE_RUNTIME_MODE=gemini_live."
        )

    if not bool(getattr(settings, "gemini_production_route_enabled", False)):
        raise RealtimeDogfoodConfigurationError(
            "Gemini production voice route requires "
            f"{GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG}=true."
        )

    validate_gemini_browser_dogfood_settings(settings)


def _dynamic_memory_retrieval_config(
    realtime_context: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(realtime_context, Mapping):
        return None
    config = realtime_context.get("dynamic_memory_retrieval")
    if not isinstance(config, Mapping):
        return None
    return dict(config)
