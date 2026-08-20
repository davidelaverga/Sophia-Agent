from __future__ import annotations

import os
import time
import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from voice.realtime.dogfood_session import (
    RealtimeDogfoodConfigurationError,
    RealtimeDogfoodSession,
    RealtimeDogfoodSessionManager,
)
from voice.realtime.coreview import (
    is_coreview_enabled,
    is_coreview_still_frame_enabled,
)
from voice.realtime.events import ProviderEvent, ProviderEventType
from voice.realtime.gemini_live import DEFAULT_GEMINI_LIVE_MODEL
from voice.realtime.gemini_memory_context import (
    build_gemini_live_realtime_instructions_with_memory_context,
)
from voice.realtime.gemini_tool_loop import (
    GEMINI_EMIT_ARTIFACT_TOOL_NAME,
    GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
    GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME,
    GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
    GEMINI_LIST_ASYNC_TASKS_TOOL_NAME,
    GEMINI_RETRIEVE_MEMORIES_TOOL_NAME,
    GEMINI_START_BUILDER_TASK_TOOL_NAME,
    GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
    GeminiDogfoodToolError,
    GeminiDogfoodToolExecution,
    GeminiDogfoodToolExecutor,
    GeminiLiveFunctionCall,
    extract_gemini_live_function_calls,
    extract_gemini_tool_call_cancellation_ids,
    gemini_tool_response_client_action,
)
from voice.realtime.gemini_langsmith_tracing import GeminiLiveTraceRecorder
from voice.realtime.runtime_selection import VoiceRuntimeMode

logger = logging.getLogger(__name__)

GEMINI_LIVE_API_KEY_ENVS = ("GOOGLE_API_KEY", "GEMINI_API_KEY")
GEMINI_LIVE_AUTH_TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
GEMINI_LIVE_WEBSOCKET_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained"
)

_GEMINI_LIVE_SERVER_EVENT_KEYS = frozenset(
    {
        "setupComplete",
        "setup_complete",
        "serverContent",
        "server_content",
        "toolCall",
        "tool_call",
        "toolCallCancellation",
        "tool_call_cancellation",
        "goAway",
        "go_away",
        "sessionResumptionUpdate",
        "session_resumption_update",
        "usageMetadata",
        "usage_metadata",
        "error",
    }
)

_RETRIEVE_MEMORIES_SAFE_DIAGNOSTIC_KEYS = frozenset(
    {
        "any_result_exact_query_terms_present",
        "cache_status",
        "count",
        "has_results",
        "latency_ms",
        "max_query_terms_matched_count",
        "provider_reason",
        "provider_status",
        "provider_transport",
        "query_fingerprint",
        "query_length",
        "query_term_count",
        "raw_memory_text_excluded",
        "raw_query_excluded",
        "result_categories",
        "result_fingerprints",
        "result_preview_included",
        "result_text_lengths",
        "status",
        "trusted_user_id_source",
    }
)
_GEMINI_LIVE_ZERO_FIELD_SERVER_EVENT_KEYS = frozenset({"setupComplete", "setup_complete"})


class GeminiBrowserDogfoodError(RuntimeError):
    """Base error for internal Gemini browser Live dogfood setup."""


class GeminiEphemeralTokenMintError(GeminiBrowserDogfoodError):
    """Raised when the trusted backend cannot mint a Gemini auth token."""


class GeminiBrowserRelayError(GeminiBrowserDogfoodError):
    """Raised when a browser-relayed Gemini event is not acceptable."""


@dataclass(frozen=True)
class GeminiRelaySourceMetadata:
    provider_receive_sequence: int
    provider_relay_sequence: int | None = None
    provider_received_at: str | None = None
    relay_correlation_id: str | None = None
    provider_primary_category: str | None = None
    provider_categories: tuple[str, ...] = ()

    @classmethod
    def from_relay_fields(
        cls,
        *,
        provider_receive_sequence: int | None,
        provider_relay_sequence: int | None = None,
        provider_received_at: str | None = None,
        relay_correlation_id: str | None = None,
        provider_primary_category: str | None = None,
        provider_categories: list[str] | tuple[str, ...] | None = None,
    ) -> "GeminiRelaySourceMetadata | None":
        if provider_receive_sequence is None:
            return None
        if not isinstance(provider_receive_sequence, int) or provider_receive_sequence <= 0:
            raise ValueError("provider_receive_sequence must be a positive integer.")
        if provider_relay_sequence is not None and (
            not isinstance(provider_relay_sequence, int) or provider_relay_sequence <= 0
        ):
            raise ValueError("provider_relay_sequence must be a positive integer when provided.")
        if provider_received_at is not None and not isinstance(provider_received_at, str):
            raise ValueError("provider_received_at must be an ISO timestamp string when provided.")
        if relay_correlation_id is not None and not isinstance(relay_correlation_id, str):
            raise ValueError("relay_correlation_id must be a string when provided.")
        categories = tuple(
            category
            for category in (provider_categories or ())
            if isinstance(category, str) and category
        )
        return cls(
            provider_receive_sequence=provider_receive_sequence,
            provider_relay_sequence=provider_relay_sequence,
            provider_received_at=provider_received_at,
            relay_correlation_id=relay_correlation_id,
            provider_primary_category=provider_primary_category if isinstance(provider_primary_category, str) else None,
            provider_categories=categories,
        )

    def as_event_context(self) -> dict[str, Any]:
        return {
            "provider_receive_sequence": self.provider_receive_sequence,
            "provider_relay_sequence": self.provider_relay_sequence,
            "provider_received_at": self.provider_received_at,
            "relay_correlation_id": self.relay_correlation_id,
            "provider_primary_category": self.provider_primary_category,
            "provider_categories": list(self.provider_categories),
        }

    @property
    def ordering_sequence(self) -> int:
        return self.provider_relay_sequence or self.provider_receive_sequence


@dataclass
class GeminiReliabilityDiagnostics:
    session_id: str
    raw_provider_events_accepted: int = 0
    provider_category_counts: dict[str, int] = field(default_factory=dict)
    provider_category_last_at: dict[str, float] = field(default_factory=dict)
    function_calls_extracted: dict[str, str] = field(default_factory=dict)
    cancellation_ids_observed: list[str] = field(default_factory=list)
    tool_execution_counts: dict[str, int] = field(default_factory=dict)
    tool_execution_recent: list[dict[str, Any]] = field(default_factory=list)
    provider_events_pushed_into_mapper: int = 0
    provider_event_mapping_outputs: dict[str, int] = field(default_factory=dict)
    public_sophia_emitted_counts: dict[str, int] = field(default_factory=dict)
    public_sophia_last_at: dict[str, float] = field(default_factory=dict)
    latest_provider_receive_sequence: int | None = None
    latest_backend_applied_sequence: int | None = None
    transcript_sequence_buffered: int = 0
    transcript_sequence_applied: int = 0
    transcript_sequence_stale_rejected: int = 0
    transcript_boundary_stale_rejected: int = 0
    source_sequence_stale_rejected: int = 0
    memory_context: dict[str, Any] = field(default_factory=dict)
    artifact_emission_attempt_count: int = 0
    artifact_emission_completed_count: int = 0
    artifact_emission_cancelled_count: int = 0
    artifact_duplicate_suppressed_count: int = 0
    artifact_cancelled_before_backend_execution: int = 0
    artifact_cancelled_after_backend_execution: int = 0
    artifact_public_event_emitted_count: int = 0
    artifact_tool_response_prepared_count: int = 0

    def as_public_payload(self) -> dict[str, Any]:
        recent_function_calls = dict(list(self.function_calls_extracted.items())[-10:])
        return {
            "schema": "gemini_relay_diagnostics_compact_v1",
            "session_id": self.session_id,
            "raw_provider_events_accepted": self.raw_provider_events_accepted,
            "provider_category_counts": dict(self.provider_category_counts),
            "provider_category_last_at": dict(self.provider_category_last_at),
            "function_calls_extracted_count": len(self.function_calls_extracted),
            "function_calls_extracted": recent_function_calls,
            "cancellation_ids_observed_count": len(self.cancellation_ids_observed),
            "cancellation_ids_observed": list(self.cancellation_ids_observed[-10:]),
            "tool_execution_counts": dict(self.tool_execution_counts),
            "tool_execution_recent": [dict(item) for item in self.tool_execution_recent[-10:]],
            "provider_events_pushed_into_mapper": self.provider_events_pushed_into_mapper,
            "provider_event_mapping_outputs": dict(self.provider_event_mapping_outputs),
            "public_sophia_emitted_counts": dict(self.public_sophia_emitted_counts),
            "public_sophia_last_at": dict(self.public_sophia_last_at),
            "latest_provider_receive_sequence": self.latest_provider_receive_sequence,
            "latest_backend_applied_sequence": self.latest_backend_applied_sequence,
            "transcript_sequence_buffered": self.transcript_sequence_buffered,
            "transcript_sequence_applied": self.transcript_sequence_applied,
            "transcript_sequence_stale_rejected": self.transcript_sequence_stale_rejected,
            "transcript_boundary_stale_rejected": self.transcript_boundary_stale_rejected,
            "source_sequence_stale_rejected": self.source_sequence_stale_rejected,
            "memory_context": dict(self.memory_context),
            "artifact_emission_attempt_count": self.artifact_emission_attempt_count,
            "artifact_emission_completed_count": self.artifact_emission_completed_count,
            "artifact_emission_cancelled_count": self.artifact_emission_cancelled_count,
            "artifact_duplicate_suppressed_count": self.artifact_duplicate_suppressed_count,
            "artifact_cancelled_before_backend_execution": self.artifact_cancelled_before_backend_execution,
            "artifact_cancelled_after_backend_execution": self.artifact_cancelled_after_backend_execution,
            "artifact_public_event_emitted_count": self.artifact_public_event_emitted_count,
            "artifact_tool_response_prepared_count": self.artifact_tool_response_prepared_count,
        }

    def record_provider_event(
        self,
        event: Mapping[str, Any],
        source_metadata: GeminiRelaySourceMetadata | None = None,
    ) -> None:
        self.raw_provider_events_accepted += 1
        observed_at = time.time()
        if source_metadata is not None:
            self.latest_provider_receive_sequence = source_metadata.provider_receive_sequence
        for category in categorize_gemini_provider_event(event):
            self.provider_category_counts[category] = self.provider_category_counts.get(category, 0) + 1
            self.provider_category_last_at[category] = observed_at

    def record_function_calls(self, function_calls: list[GeminiLiveFunctionCall]) -> None:
        for function_call in function_calls:
            self.function_calls_extracted[function_call.call_id] = function_call.name
            if function_call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                self.artifact_emission_attempt_count += 1

    def record_artifact_cancelled(self, *, before_backend_execution: bool) -> None:
        self.artifact_emission_cancelled_count += 1
        if before_backend_execution:
            self.artifact_cancelled_before_backend_execution += 1
        else:
            self.artifact_cancelled_after_backend_execution += 1

    def record_artifact_completed(self) -> None:
        self.artifact_emission_completed_count += 1

    def record_artifact_duplicate_suppressed(self) -> None:
        self.artifact_duplicate_suppressed_count += 1

    def record_artifact_public_event_emitted(self) -> None:
        self.artifact_public_event_emitted_count += 1

    def record_artifact_tool_response_prepared(self) -> None:
        self.artifact_tool_response_prepared_count += 1

    def record_cancellations(self, cancelled_ids: list[str]) -> None:
        for cancelled_id in cancelled_ids:
            self.cancellation_ids_observed.append(cancelled_id)

    def record_tool_execution(
        self,
        phase: str,
        function_call: GeminiLiveFunctionCall,
        execution_diagnostic: Mapping[str, Any] | None = None,
    ) -> None:
        self.tool_execution_counts[phase] = self.tool_execution_counts.get(phase, 0) + 1
        entry = {
            "phase": phase,
            "tool_call_id": function_call.call_id,
            "tool_name": function_call.name,
            "recorded_at": time.time(),
        }
        if function_call.name == GEMINI_RETRIEVE_MEMORIES_TOOL_NAME and execution_diagnostic is not None:
            for key in _RETRIEVE_MEMORIES_SAFE_DIAGNOSTIC_KEYS:
                if key in execution_diagnostic:
                    entry[key] = execution_diagnostic[key]
        self.tool_execution_recent.append(entry)
        if len(self.tool_execution_recent) > 50:
            del self.tool_execution_recent[:-50]

    def record_provider_event_pushed(
        self,
        source_metadata: GeminiRelaySourceMetadata | None = None,
        *,
        categories: list[str] | None = None,
    ) -> None:
        self.provider_events_pushed_into_mapper += 1
        if source_metadata is not None:
            self.latest_backend_applied_sequence = source_metadata.provider_receive_sequence
            if _is_transcript_or_boundary_event(categories or []):
                self.transcript_sequence_applied += 1

    def record_stale_rejection(
        self,
        source_metadata: GeminiRelaySourceMetadata,
        *,
        categories: list[str],
    ) -> None:
        self.source_sequence_stale_rejected += 1
        if _is_transcript_event(categories):
            self.transcript_sequence_stale_rejected += 1
        if _is_boundary_event(categories):
            self.transcript_boundary_stale_rejected += 1

    def record_mapping_outputs(self, provider_events: list[ProviderEvent]) -> None:
        for provider_event in provider_events:
            key = provider_event.type.value
            self.provider_event_mapping_outputs[key] = self.provider_event_mapping_outputs.get(key, 0) + 1

    def record_public_payload(self, payload: Mapping[str, object]) -> None:
        public_type = str(payload.get("type") or "unknown")
        self.public_sophia_emitted_counts[public_type] = self.public_sophia_emitted_counts.get(public_type, 0) + 1
        self.public_sophia_last_at[public_type] = time.time()


@dataclass(frozen=True)
class GeminiDogfoodGateResult:
    api_key: str
    api_key_env: str
    model: str


@dataclass(frozen=True)
class GeminiLiveEphemeralToken:
    value: str
    response: dict[str, Any] = field(default_factory=dict)

    def as_public_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"value": self.value}
        for key in ("name", "expireTime", "newSessionExpireTime", "uses"):
            value = self.response.get(key)
            if value is not None:
                payload[key] = value
        return payload


@dataclass(frozen=True)
class GeminiBrowserDogfoodSession:
    dogfood_session: RealtimeDogfoodSession
    ephemeral_token: GeminiLiveEphemeralToken
    setup: dict[str, Any]
    websocket_url: str = GEMINI_LIVE_WEBSOCKET_URL
    memory_context_diagnostics: dict[str, Any] = field(default_factory=dict)
    langsmith_trace_id: str | None = None
    audio_capture_enabled: bool = False

    def as_public_payload(self) -> dict[str, Any]:
        session_metadata = self.dogfood_session.metadata()
        return {
            **session_metadata,
            "browser_audio": "gemini_live_websocket_experimental",
            "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
            "websocket_url": self.websocket_url,
            "websocket_auth": "access_token_query_param",
            "ephemeral_token": self.ephemeral_token.as_public_payload(),
            "setup": dict(self.setup),
            "memory_context": dict(self.memory_context_diagnostics),
            "event_stream_url": f"/dogfood/realtime/sessions/{self.dogfood_session.session_id}/events",
            "provider_event_relay_url": (
                "/dogfood/realtime/gemini/browser-sessions/"
                f"{self.dogfood_session.session_id}/provider-events"
            ),
            "public_event_boundary": "SophiaEventNormalizer",
            "backendCoreviewFlagParsed": is_coreview_enabled(),
            "backendStillFrameFlagParsed": is_coreview_still_frame_enabled(),
            "langsmith_trace_id": self.langsmith_trace_id,
            "audio_capture_enabled": self.audio_capture_enabled,
        }


class GeminiLiveEphemeralTokenMinter:
    def __init__(
        self,
        *,
        url: str = GEMINI_LIVE_AUTH_TOKEN_URL,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._url = url
        self._timeout_seconds = timeout_seconds

    async def mint_ephemeral_token(
        self,
        *,
        api_key: str,
        setup: Mapping[str, Any],
        uses: int = 1,
    ) -> GeminiLiveEphemeralToken:
        body = {
            "uses": uses,
            "bidiGenerateContentSetup": dict(setup),
        }
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(self._url, headers=headers, json=body)
        except httpx.RequestError as exc:
            raise GeminiEphemeralTokenMintError(
                f"Gemini auth token request failed: {exc.__class__.__name__}."
            ) from exc

        if response.status_code >= 400:
            detail = response.text[:300]
            raise GeminiEphemeralTokenMintError(
                f"Gemini auth token mint failed with HTTP {response.status_code}: {detail}"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise GeminiEphemeralTokenMintError(
                "Gemini auth token response was not valid JSON."
            ) from exc

        if not isinstance(payload, Mapping):
            raise GeminiEphemeralTokenMintError(
                "Gemini auth token response was not a JSON object."
            )

        value = _string_value(payload.get("name")) or _string_value(
            payload.get("access_token")
        ) or _string_value(payload.get("accessToken")) or _string_value(payload.get("token"))
        if not value:
            raise GeminiEphemeralTokenMintError(
                "Gemini auth token response omitted the ephemeral token name."
            )

        return GeminiLiveEphemeralToken(value=value, response=dict(payload))


class GeminiBrowserDogfoodSessionManager:
    def __init__(
        self,
        realtime_sessions: RealtimeDogfoodSessionManager,
        *,
        token_minter: GeminiLiveEphemeralTokenMinter | None = None,
        tool_executor: GeminiDogfoodToolExecutor | None = None,
    ) -> None:
        self._realtime_sessions = realtime_sessions
        self._token_minter = token_minter or GeminiLiveEphemeralTokenMinter()
        self._tool_executor = tool_executor or GeminiDogfoodToolExecutor()
        self._cancelled_tool_call_ids_by_session: dict[str, set[str]] = {}
        self._inflight_tool_call_ids_by_session: dict[str, set[str]] = {}
        self._completed_tool_call_ids_by_session: dict[str, set[str]] = {}
        self._public_artifact_tool_call_ids_by_session: dict[str, set[str]] = {}
        self._async_tasks_by_session: dict[str, dict[str, dict[str, Any]]] = {}
        self._parent_thread_id_by_session: dict[str, str] = {}
        self._diagnostics_by_session: dict[str, GeminiReliabilityDiagnostics] = {}
        self._context_mode_by_session: dict[str, str | None] = {}
        self._memory_retrieval_config_by_session: dict[str, dict[str, Any]] = {}
        self._source_order_locks_by_session: dict[str, asyncio.Lock] = {}
        self._last_applied_source_sequence_by_session: dict[str, int] = {}
        self._source_order_buffers_by_session: dict[
            str,
            dict[int, tuple[dict[str, Any], GeminiRelaySourceMetadata, list[str]]],
        ] = {}
        self._preconnect_cleanup_tasks_by_session: dict[str, asyncio.Task[None]] = {}
        self._traces_by_session: dict[str, GeminiLiveTraceRecorder] = {}

    async def start_browser_session(
        self,
        settings: object,
        *,
        user_id: str,
        session_id: str | None = None,
        instructions: str | None = None,
        memory_context_diagnostics: Mapping[str, Any] | None = None,
        context_mode: str | None = None,
        memory_retrieval_config: Mapping[str, Any] | None = None,
        preconnect_ttl_seconds: float | None = None,
        thread_id: str | None = None,
    ) -> GeminiBrowserDogfoodSession:
        gate = validate_gemini_browser_dogfood_settings(settings)
        resolved_context_mode = context_mode or str(getattr(settings, "context_mode", "life"))
        if instructions is None:
            instructions, memory_context = build_gemini_live_realtime_instructions_with_memory_context(
                user_id=user_id,
                platform=str(getattr(settings, "platform", "voice")),
                context_mode=resolved_context_mode,
                ritual=getattr(settings, "ritual", None),
            )
            memory_context_diagnostics = memory_context.diagnostics

        dogfood_session = await self._realtime_sessions.start_session(
            settings,
            user_id=user_id,
            session_id=session_id,
            instructions=instructions,
        )
        try:
            setup = _setup_from_dogfood_session(dogfood_session)
            ephemeral_token = await self._token_minter.mint_ephemeral_token(
                api_key=gate.api_key,
                setup=setup,
            )
        except Exception:
            await self._realtime_sessions.close_session(dogfood_session.session_id)
            raise

        diagnostics = GeminiReliabilityDiagnostics(
            session_id=dogfood_session.session_id,
            memory_context=dict(memory_context_diagnostics or {}),
        )
        self._diagnostics_by_session[dogfood_session.session_id] = diagnostics
        self._context_mode_by_session[dogfood_session.session_id] = resolved_context_mode
        resolved_parent_thread_id = _string_value(thread_id)
        if resolved_parent_thread_id:
            self._parent_thread_id_by_session[dogfood_session.session_id] = resolved_parent_thread_id
        else:
            self._parent_thread_id_by_session.pop(dogfood_session.session_id, None)
        if isinstance(memory_retrieval_config, Mapping):
            self._memory_retrieval_config_by_session[dogfood_session.session_id] = dict(memory_retrieval_config)
        dogfood_session.add_public_payload_observer(diagnostics.record_public_payload)
        mapping_observer = getattr(dogfood_session.bundle.provider_session, "set_mapping_observer", None)
        if callable(mapping_observer):
            mapping_observer(lambda _raw_event, provider_events: diagnostics.record_mapping_outputs(provider_events))
        trace = GeminiLiveTraceRecorder(
            session_id=dogfood_session.session_id,
            user_id=user_id,
            model=str(getattr(settings, "gemini_live_model", DEFAULT_GEMINI_LIVE_MODEL)),
            thread_id=thread_id,
        )
        self._traces_by_session[dogfood_session.session_id] = trace
        self._schedule_preconnect_cleanup(
            dogfood_session.session_id,
            preconnect_ttl_seconds,
        )

        return GeminiBrowserDogfoodSession(
            dogfood_session=dogfood_session,
            ephemeral_token=ephemeral_token,
            setup=setup,
            memory_context_diagnostics=dict(memory_context_diagnostics or {}),
            langsmith_trace_id=trace.trace_id,
            audio_capture_enabled=trace.audio_capture_enabled,
        )

    def _schedule_preconnect_cleanup(
        self,
        dogfood_session_id: str,
        ttl_seconds: float | None,
    ) -> None:
        if ttl_seconds is None or ttl_seconds <= 0:
            return

        async def _cleanup() -> None:
            try:
                await asyncio.sleep(ttl_seconds)
                if dogfood_session_id in self._preconnect_cleanup_tasks_by_session:
                    await self.close_session(dogfood_session_id)
            except asyncio.CancelledError:
                raise

        self._cancel_preconnect_cleanup(dogfood_session_id)
        task = asyncio.create_task(_cleanup())
        self._preconnect_cleanup_tasks_by_session[dogfood_session_id] = task
        task.add_done_callback(
            lambda done_task: (
                self._preconnect_cleanup_tasks_by_session.pop(dogfood_session_id, None)
                if self._preconnect_cleanup_tasks_by_session.get(dogfood_session_id) is done_task
                else None
            )
        )

    def _cancel_preconnect_cleanup(self, dogfood_session_id: str) -> None:
        task = self._preconnect_cleanup_tasks_by_session.pop(dogfood_session_id, None)
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()

    async def ingest_browser_provider_event(
        self,
        settings: object,
        *,
        dogfood_session_id: str,
        event: Mapping[str, Any],
        source_metadata: GeminiRelaySourceMetadata | None = None,
    ) -> dict[str, object]:
        validate_gemini_browser_dogfood_settings(settings)
        dogfood_session = self._realtime_sessions.get_session(dogfood_session_id)
        if dogfood_session is None:
            raise GeminiBrowserRelayError(
                f"Dogfood session with id {dogfood_session_id!r} was not found."
            )
        if dogfood_session.runtime_mode != VoiceRuntimeMode.GEMINI_LIVE:
            raise GeminiBrowserRelayError(
                "Gemini browser relay can only ingest events for gemini_live dogfood sessions."
            )
        self._cancel_preconnect_cleanup(dogfood_session_id)

        validated_event = validate_gemini_browser_provider_event(event)
        diagnostics = self._diagnostics_by_session.setdefault(
            dogfood_session.session_id,
            GeminiReliabilityDiagnostics(session_id=dogfood_session.session_id),
        )
        categories = categorize_gemini_provider_event(validated_event)
        diagnostics.record_provider_event(validated_event, source_metadata)
        trace = self._traces_by_session.get(dogfood_session.session_id)
        if trace is not None:
            trace.record_provider_event(
                validated_event,
                categories=categories,
                provider_receive_sequence=(
                    source_metadata.provider_receive_sequence if source_metadata else None
                ),
                provider_relay_sequence=(
                    source_metadata.provider_relay_sequence if source_metadata else None
                ),
                provider_received_at=(
                    source_metadata.provider_received_at if source_metadata else None
                ),
                relay_correlation_id=(
                    source_metadata.relay_correlation_id if source_metadata else None
                ),
            )
        provider_event_for_public_boundary = _without_automatic_artifact_public_events(validated_event)
        stale_payload = await self._apply_provider_event_in_source_order(
            dogfood_session,
            provider_event_for_public_boundary,
            diagnostics,
            source_metadata=source_metadata,
            categories=categories,
        )
        if stale_payload is not None:
            return stale_payload
        try:
            function_calls = extract_gemini_live_function_calls(validated_event)
        except GeminiDogfoodToolError as exc:
            logger.warning(
                "gemini.relay.tool_call_extraction_rejected session_id=%s provider_category=%s relay_correlation_id=%s error_type=%s",
                dogfood_session.session_id,
                source_metadata.provider_primary_category if source_metadata else None,
                source_metadata.relay_correlation_id if source_metadata else None,
                exc.__class__.__name__,
            )
            raise GeminiBrowserRelayError(str(exc)) from exc
        diagnostics.record_function_calls(function_calls)
        if function_calls:
            logger.info(
                "gemini.relay.tool_calls session_id=%s provider_category=%s relay_correlation_id=%s tool_names=%s tool_call_ids=%s",
                dogfood_session.session_id,
                source_metadata.provider_primary_category if source_metadata else None,
                source_metadata.relay_correlation_id if source_metadata else None,
                [call.name for call in function_calls],
                [call.call_id for call in function_calls],
            )

        cancelled_ids = extract_gemini_tool_call_cancellation_ids(validated_event)
        if cancelled_ids:
            diagnostics.record_cancellations(cancelled_ids)
            self._cancelled_tool_call_ids_by_session.setdefault(
                dogfood_session.session_id,
                set(),
            ).update(cancelled_ids)

        client_actions: list[dict[str, Any]] = []
        tool_diagnostics: list[dict[str, Any]] = []
        executions: list[GeminiDogfoodToolExecution] = []
        execution_elapsed_ms: int | None = None
        if function_calls:
            started_at = time.perf_counter()
            executions, tool_diagnostics = await self._execute_tool_calls(
                dogfood_session,
                function_calls,
                diagnostics,
                trace=trace,
                source_metadata=source_metadata,
            )
            execution_elapsed_ms = max(int((time.perf_counter() - started_at) * 1000), 0)
            cancelled_after_execution = self._cancelled_tool_call_ids_by_session.get(
                dogfood_session.session_id,
                set(),
            )
            respondable_executions = [
                execution
                for execution in executions
                if execution.call.call_id not in cancelled_after_execution
            ]
            action = gemini_tool_response_client_action(respondable_executions)
            if action is not None:
                client_actions.append(action)
                for execution in respondable_executions:
                    if execution.call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                        diagnostics.record_artifact_tool_response_prepared()
            await self._publish_public_artifacts_from_executions(
                dogfood_session,
                respondable_executions,
                diagnostics,
            )
            if trace is not None:
                executed_call_ids: set[str] = set()
                for execution in executions:
                    executed_call_ids.add(execution.call.call_id)
                    if execution.call.call_id not in cancelled_after_execution:
                        trace.record_function_response(
                            tool_call_id=execution.call.call_id,
                            tool_name=execution.call.name,
                            response=execution.response,
                            success=execution.success,
                        )
                for diagnostic in tool_diagnostics:
                    call_id = diagnostic.get("id")
                    if not isinstance(call_id, str) or call_id in executed_call_ids:
                        continue
                    tool_name = diagnostic.get("name")
                    if not isinstance(tool_name, str):
                        tool_name = "unknown"
                    summary = str(
                        diagnostic.get("result_summary") or "Tool call was not executed."
                    )
                    trace.record_tool_call(
                        tool_call_id=call_id,
                        tool_name=tool_name,
                        arguments={},
                        success=False,
                        result_summary=summary,
                        error=summary,
                    )

        if function_calls:
            rejected_executions = [execution for execution in executions if not execution.success]
            duplicate_suppressed = bool(tool_diagnostics) and all(
                bool(diagnostic.get("duplicate_suppressed")) for diagnostic in tool_diagnostics
            )
            tool_loop_status = (
                "execution_rejected"
                if rejected_executions
                else "completed_after_cancellation" if executions and not client_actions
                else "completed" if executions
                else "duplicate_suppressed" if duplicate_suppressed
                else "cancelled"
            )
            await dogfood_session.publish_provider_metric(
                {
                    "provider_event_name": "toolCall",
                    "tool_loop_status": tool_loop_status,
                    "tool_call_ids": [call.call_id for call in function_calls],
                    "tool_names": [call.name for call in function_calls],
                    "client_action_count": len(client_actions),
                    "tool_execution_ms": execution_elapsed_ms,
                    "tool_execution_rejections": [execution.response for execution in rejected_executions],
                },
                response_id=function_calls[0].call_id,
                turn_id=function_calls[0].call_id,
            )
            for builder_task in _builder_task_payloads_from_executions(executions):
                await dogfood_session.publish_provider_event(
                    ProviderEvent.builder_task_payload(
                        builder_task,
                        provider=dogfood_session.provider_name,
                        session_id=dogfood_session.session_id,
                    )
                )

        payload: dict[str, object] = {
            "accepted": True,
            "session_id": dogfood_session.session_id,
            "public_event_boundary": "SophiaEventNormalizer",
        }
        if client_actions:
            payload["client_actions"] = client_actions
        if tool_diagnostics:
            payload["tool_diagnostics"] = tool_diagnostics
        if cancelled_ids:
            payload["cancelled_tool_call_ids"] = cancelled_ids
        payload["diagnostics"] = diagnostics.as_public_payload()
        return payload

    async def _apply_provider_event_in_source_order(
        self,
        dogfood_session: RealtimeDogfoodSession,
        validated_event: Mapping[str, Any],
        diagnostics: GeminiReliabilityDiagnostics,
        *,
        source_metadata: GeminiRelaySourceMetadata | None,
        categories: list[str],
    ) -> dict[str, object] | None:
        if source_metadata is None:
            diagnostics.record_provider_event_pushed(categories=categories)
            await dogfood_session.ingest_provider_event(validated_event)
            return None

        lock = self._source_order_locks_by_session.setdefault(
            dogfood_session.session_id,
            asyncio.Lock(),
        )
        async with lock:
            last_applied = self._last_applied_source_sequence_by_session.get(
                dogfood_session.session_id,
                0,
            )
            ordering_sequence = source_metadata.ordering_sequence
            if ordering_sequence <= last_applied:
                diagnostics.record_stale_rejection(source_metadata, categories=categories)
                await dogfood_session.publish_provider_metric(
                    {
                        "provider_event_name": "gemini.relay.source_sequence_stale_rejected",
                        "source_sequence_stale_rejected": True,
                        "provider_receive_sequence": source_metadata.provider_receive_sequence,
                        "provider_relay_sequence": source_metadata.provider_relay_sequence,
                        "latest_backend_applied_sequence": last_applied,
                        "relay_correlation_id": source_metadata.relay_correlation_id,
                        "provider_categories": list(source_metadata.provider_categories) or categories,
                    },
                    response_id=source_metadata.relay_correlation_id,
                    turn_id=source_metadata.relay_correlation_id,
                )
                return {
                    "accepted": True,
                    "ignored": True,
                    "ignore_reason": "stale_provider_receive_sequence",
                    "session_id": dogfood_session.session_id,
                    "public_event_boundary": "SophiaEventNormalizer",
                    "diagnostics": diagnostics.as_public_payload(),
                }

            expected_next = last_applied + 1
            if ordering_sequence > expected_next:
                buffer = self._source_order_buffers_by_session.setdefault(
                    dogfood_session.session_id,
                    {},
                )
                buffer[ordering_sequence] = (
                    dict(validated_event),
                    source_metadata,
                    list(categories),
                )
                if _is_transcript_or_boundary_event(categories):
                    diagnostics.transcript_sequence_buffered += 1
                await dogfood_session.publish_provider_metric(
                    {
                        "provider_event_name": "gemini.relay.source_sequence_buffered",
                        "source_sequence_buffered": True,
                        "provider_receive_sequence": source_metadata.provider_receive_sequence,
                        "provider_relay_sequence": source_metadata.provider_relay_sequence,
                        "expected_provider_receive_sequence": expected_next,
                        "relay_correlation_id": source_metadata.relay_correlation_id,
                        "provider_categories": list(source_metadata.provider_categories) or categories,
                    },
                    response_id=source_metadata.relay_correlation_id,
                    turn_id=source_metadata.relay_correlation_id,
                )
                return {
                    "accepted": True,
                    "buffered": True,
                    "buffer_reason": "waiting_for_missing_provider_receive_sequence",
                    "session_id": dogfood_session.session_id,
                    "public_event_boundary": "SophiaEventNormalizer",
                    "diagnostics": diagnostics.as_public_payload(),
                }

            self._last_applied_source_sequence_by_session[dogfood_session.session_id] = ordering_sequence
            diagnostics.record_provider_event_pushed(source_metadata, categories=categories)
            await dogfood_session.ingest_provider_event(
                validated_event,
                source_metadata=source_metadata.as_event_context(),
            )
            buffer = self._source_order_buffers_by_session.get(dogfood_session.session_id, {})
            while True:
                expected_next = self._last_applied_source_sequence_by_session[dogfood_session.session_id] + 1
                buffered = buffer.pop(expected_next, None)
                if buffered is None:
                    break
                buffered_event, buffered_metadata, buffered_categories = buffered
                self._last_applied_source_sequence_by_session[dogfood_session.session_id] = (
                    buffered_metadata.ordering_sequence
                )
                diagnostics.record_provider_event_pushed(buffered_metadata, categories=buffered_categories)
                await dogfood_session.ingest_provider_event(
                    buffered_event,
                    source_metadata=buffered_metadata.as_event_context(),
                )
        return None

    async def _execute_tool_calls(
        self,
        dogfood_session: RealtimeDogfoodSession,
        function_calls: list[GeminiLiveFunctionCall],
        reliability_diagnostics: GeminiReliabilityDiagnostics | None = None,
        *,
        trace: GeminiLiveTraceRecorder | None = None,
        source_metadata: GeminiRelaySourceMetadata | None = None,
    ) -> tuple[list[GeminiDogfoodToolExecution], list[dict[str, Any]]]:
        cancelled_ids = self._cancelled_tool_call_ids_by_session.setdefault(
            dogfood_session.session_id,
            set(),
        )
        executions: list[GeminiDogfoodToolExecution] = []
        tool_diagnostics: list[dict[str, Any]] = []
        async_tasks = self._async_tasks_by_session.setdefault(dogfood_session.session_id, {})
        inflight_ids = self._inflight_tool_call_ids_by_session.setdefault(
            dogfood_session.session_id,
            set(),
        )
        completed_ids = self._completed_tool_call_ids_by_session.setdefault(
            dogfood_session.session_id,
            set(),
        )

        for function_call in function_calls:
            if function_call.call_id in inflight_ids or function_call.call_id in completed_ids:
                if reliability_diagnostics is not None:
                    reliability_diagnostics.record_tool_execution("duplicate_suppressed", function_call)
                    if function_call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                        reliability_diagnostics.record_artifact_duplicate_suppressed()
                tool_diagnostics.append(
                    {
                        "id": function_call.call_id,
                        "name": function_call.name,
                        "success": False,
                        "duplicate_suppressed": True,
                        "result_summary": "Duplicate tool call id suppressed; no duplicate backend side effect or toolResponse was produced.",
                    }
                )
                continue

            if function_call.call_id in cancelled_ids:
                if reliability_diagnostics is not None:
                    reliability_diagnostics.record_tool_execution("skipped_due_prior_cancellation", function_call)
                    if function_call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                        reliability_diagnostics.record_artifact_cancelled(before_backend_execution=True)
                tool_diagnostics.append(
                    {
                        "id": function_call.call_id,
                        "name": function_call.name,
                        "success": False,
                        "cancelled": True,
                        "result_summary": "Tool call was cancelled before a toolResponse was returned.",
                    }
                )
                continue

            if reliability_diagnostics is not None:
                reliability_diagnostics.record_tool_execution("started", function_call)
            if function_call.name in _BUILDER_LIFECYCLE_TOOL_NAMES:
                logger.info(
                    "gemini.relay.builder_tool.started session_id=%s tool_name=%s tool_call_id=%s",
                    dogfood_session.session_id,
                    function_call.name,
                    function_call.call_id,
                )
            tool_span = None
            trace_headers: Mapping[str, str] | None = None
            trace_context: dict[str, Any] | None = None
            if trace is not None:
                tool_span = trace.start_tool_call(
                    tool_call_id=function_call.call_id,
                    tool_name=function_call.name,
                    arguments=function_call.args,
                    provider_receive_sequence=(
                        source_metadata.provider_receive_sequence if source_metadata else None
                    ),
                    relay_correlation_id=(
                        source_metadata.relay_correlation_id if source_metadata else None
                    ),
                )
                trace_headers = trace.handoff_headers(tool_span)
                trace_context = {
                    "voice_session_id": dogfood_session.session_id,
                    "voice_trace_id": trace.trace_id,
                    "voice_tool_call_id": function_call.call_id,
                    "voice_tool_run_id": (
                        str(getattr(tool_span, "id", "") or "") or None
                    ),
                    "relay_correlation_id": (
                        source_metadata.relay_correlation_id if source_metadata else None
                    ),
                    "provider_receive_sequence": (
                        source_metadata.provider_receive_sequence if source_metadata else None
                    ),
                }
            inflight_ids.add(function_call.call_id)
            try:
                execution = await self._tool_executor.execute(
                    function_call,
                    session_id=dogfood_session.session_id,
                    user_id=dogfood_session.user_id,
                    runtime_mode=dogfood_session.runtime_mode,
                    provider=dogfood_session.provider_name,
                    async_tasks=async_tasks,
                    parent_thread_id=(
                        self._parent_thread_id_by_session.get(dogfood_session.session_id)
                        or dogfood_session.session_id
                    ),
                    context_mode=self._context_mode_by_session.get(dogfood_session.session_id),
                    memory_retrieval_config=self._memory_retrieval_config_by_session.get(
                        dogfood_session.session_id
                    ),
                    trace_headers=trace_headers,
                    trace_context=trace_context,
                )
            except GeminiDogfoodToolError as exc:
                if trace is not None:
                    trace.finish_tool_call(
                        tool_span,
                        tool_name=function_call.name,
                        success=False,
                        result_summary="Tool execution rejected before a response was available.",
                        error=str(exc),
                    )
                if function_call.name in _BUILDER_LIFECYCLE_TOOL_NAMES:
                    logger.warning(
                        "gemini.relay.builder_tool.rejected session_id=%s tool_name=%s tool_call_id=%s error_type=%s",
                        dogfood_session.session_id,
                        function_call.name,
                        function_call.call_id,
                        exc.__class__.__name__,
                    )
                raise GeminiBrowserRelayError(str(exc)) from exc
            except Exception as exc:
                if trace is not None:
                    trace.finish_tool_call(
                        tool_span,
                        tool_name=function_call.name,
                        success=False,
                        result_summary="Tool execution failed before a response was available.",
                        error=f"{exc.__class__.__name__}: {exc}",
                    )
                raise
            finally:
                inflight_ids.discard(function_call.call_id)

            if trace is not None:
                trace.finish_tool_call(
                    tool_span,
                    tool_name=function_call.name,
                    success=execution.success,
                    result_summary=execution.result_summary,
                    error=execution.error_text,
                    response=execution.response,
                )

            if execution.updated_async_tasks:
                async_tasks.update(execution.updated_async_tasks)
            executions.append(execution)
            if execution.success:
                completed_ids.add(function_call.call_id)
            completed_after_cancellation = function_call.call_id in cancelled_ids
            diagnostic = execution.diagnostic()
            if reliability_diagnostics is not None:
                reliability_diagnostics.record_tool_execution(
                    "completed_after_cancellation"
                    if completed_after_cancellation
                    else "rejected" if not execution.success else "finished",
                    function_call,
                    diagnostic,
                )
                if function_call.name == GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                    if completed_after_cancellation:
                        reliability_diagnostics.record_artifact_cancelled(before_backend_execution=False)
                    elif execution.success:
                        reliability_diagnostics.record_artifact_completed()
            if completed_after_cancellation:
                diagnostic["cancelled"] = True
                diagnostic["completed_after_cancellation"] = True
                diagnostic["result_summary"] = (
                    "Tool execution completed after Gemini cancelled the call; "
                    "the browser must not return this stale toolResponse."
                )
            tool_diagnostics.append(diagnostic)
            if function_call.name in _BUILDER_LIFECYCLE_TOOL_NAMES:
                logger.info(
                    "gemini.relay.builder_tool.finished session_id=%s tool_name=%s tool_call_id=%s success=%s status=%s task_id=%s run_id=%s",
                    dogfood_session.session_id,
                    function_call.name,
                    function_call.call_id,
                    execution.success,
                    execution.response.get("status") if isinstance(execution.response, Mapping) else None,
                    execution.response.get("task_id") if isinstance(execution.response, Mapping) else None,
                    execution.response.get("run_id") if isinstance(execution.response, Mapping) else None,
                )

        return executions, tool_diagnostics

    async def _publish_public_artifacts_from_executions(
        self,
        dogfood_session: RealtimeDogfoodSession,
        executions: list[GeminiDogfoodToolExecution],
        reliability_diagnostics: GeminiReliabilityDiagnostics,
    ) -> None:
        published_ids = self._public_artifact_tool_call_ids_by_session.setdefault(
            dogfood_session.session_id,
            set(),
        )
        for execution in executions:
            if execution.call.name != GEMINI_EMIT_ARTIFACT_TOOL_NAME:
                continue
            if not execution.success or execution.public_artifact is None:
                continue
            if execution.call.call_id in published_ids:
                reliability_diagnostics.record_artifact_duplicate_suppressed()
                continue
            published_ids.add(execution.call.call_id)
            reliability_diagnostics.record_artifact_public_event_emitted()
            await dogfood_session.publish_provider_event(
                ProviderEvent(
                    ProviderEventType.ARTIFACT_PAYLOAD,
                    {
                        "artifact": dict(execution.public_artifact),
                        "call_id": execution.call.call_id,
                        "provider_event_name": "toolCall.respondable",
                    },
                    provider=dogfood_session.provider_name,
                    session_id=dogfood_session.session_id,
                    response_id=execution.call.call_id,
                    turn_id=execution.call.call_id,
                )
            )

    async def close_session(
        self,
        dogfood_session_id: str,
        *,
        conversation_audio: bytes | None = None,
        conversation_audio_mime_type: str = "audio/webm",
    ) -> bool:
        self._cancel_preconnect_cleanup(dogfood_session_id)
        self._cancelled_tool_call_ids_by_session.pop(dogfood_session_id, None)
        self._inflight_tool_call_ids_by_session.pop(dogfood_session_id, None)
        self._completed_tool_call_ids_by_session.pop(dogfood_session_id, None)
        self._public_artifact_tool_call_ids_by_session.pop(dogfood_session_id, None)
        self._async_tasks_by_session.pop(dogfood_session_id, None)
        self._parent_thread_id_by_session.pop(dogfood_session_id, None)
        self._diagnostics_by_session.pop(dogfood_session_id, None)
        self._context_mode_by_session.pop(dogfood_session_id, None)
        self._memory_retrieval_config_by_session.pop(dogfood_session_id, None)
        self._source_order_locks_by_session.pop(dogfood_session_id, None)
        self._last_applied_source_sequence_by_session.pop(dogfood_session_id, None)
        self._source_order_buffers_by_session.pop(dogfood_session_id, None)
        trace = self._traces_by_session.pop(dogfood_session_id, None)
        try:
            closed = await self._realtime_sessions.close_session(dogfood_session_id)
        finally:
            # Trace finalization is best-effort but must run even when the provider
            # WebSocket close path raises, otherwise the root remains open and the
            # async LangSmith queue may never flush.
            if trace is not None:
                await asyncio.to_thread(
                    trace.close,
                    conversation_audio=conversation_audio,
                    conversation_audio_mime_type=conversation_audio_mime_type,
                )
        return closed


_BUILDER_LIFECYCLE_TOOL_NAMES = {
    GEMINI_START_BUILDER_TASK_TOOL_NAME,
    GEMINI_EDIT_BUILDER_ARTIFACT_TOOL_NAME,
    GEMINI_CHECK_ASYNC_TASK_TOOL_NAME,
    GEMINI_UPDATE_ASYNC_TASK_TOOL_NAME,
    GEMINI_CANCEL_ASYNC_TASK_TOOL_NAME,
    GEMINI_LIST_ASYNC_TASKS_TOOL_NAME,
}


def _builder_task_payloads_from_executions(
    executions: list[GeminiDogfoodToolExecution],
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for execution in executions:
        if not execution.success or execution.call.name not in _BUILDER_LIFECYCLE_TOOL_NAMES:
            continue

        records = _builder_task_records(execution.response)
        for record in records:
            task_id = _string_value(record.get("task_id")) or _string_value(execution.response.get("task_id"))
            if not task_id:
                continue

            status = _string_value(record.get("status")) or _string_value(execution.response.get("status"))
            task_type = _string_value(record.get("task_type")) or _string_value(execution.response.get("task_type"))
            result_summary = _string_value(execution.response.get("result_summary")) or execution.result_summary
            description = _string_value(execution.call.args.get("description")) or result_summary
            started_at = _string_value(record.get("created_at"))
            last_update_at = (
                _string_value(record.get("last_updated_at"))
                or _string_value(record.get("last_checked_at"))
                or started_at
            )
            task_event_type = _builder_task_event_type(
                execution.call.name,
                status,
                execution.response,
            )
            payload: dict[str, Any] = {
                "type": task_event_type,
                "task_id": task_id,
                "description": description,
                "detail": result_summary,
                "status": status or "running",
                "progress_source": "none",
            }
            if task_type:
                payload["task_type"] = task_type
            if started_at:
                payload["started_at"] = started_at
            if last_update_at:
                payload["last_update_at"] = last_update_at
            for key in (
                "thread_id",
                "run_id",
                "build_id",
                "operation_id",
                "voice_trace_id",
                "failure_code",
                "root_failure_code",
                "terminal_reason",
            ):
                value = record.get(key, execution.response.get(key))
                if isinstance(value, str) and value.strip():
                    payload[key] = value.strip()
            artifact_path = _string_value(record.get("artifact_path"))
            if artifact_path:
                payload["artifact_path"] = artifact_path
            if status and status.strip().lower() in {
                "success",
                "completed",
                "error",
                "failed",
                "cancelled",
                "timeout",
                "timed_out",
            }:
                payload["artifact_valid"] = bool(
                    status.strip().lower() in {"success", "completed"} and artifact_path
                )
            if task_event_type in {"task_completed", "task_failed", "task_timed_out", "task_cancelled"}:
                payload["completed_at"] = last_update_at or started_at
            payloads.append(payload)
    return payloads


def _builder_task_records(response: Mapping[str, Any]) -> list[dict[str, Any]]:
    async_task = response.get("async_task")
    if isinstance(async_task, Mapping):
        return [dict(async_task)]

    tasks = response.get("tasks")
    if isinstance(tasks, list):
        return [dict(task) for task in tasks if isinstance(task, Mapping)]

    if _string_value(response.get("task_id")):
        return [dict(response)]
    return []


def _builder_task_event_type(
    tool_name: str,
    status: str | None,
    response: Mapping[str, Any],
) -> str:
    normalized_status = (status or "running").strip().lower()
    if tool_name == GEMINI_START_BUILDER_TASK_TOOL_NAME and response.get("started") is not False:
        return "task_started"
    if normalized_status in {"success", "completed", "done"}:
        return "task_completed"
    if normalized_status in {"error", "failed", "failure"}:
        return "task_failed"
    if normalized_status in {"timeout", "timed_out"}:
        return "task_timed_out"
    if normalized_status in {"cancelled", "canceled"}:
        return "task_cancelled"
    return "task_running"


def validate_gemini_browser_dogfood_settings(settings: object) -> GeminiDogfoodGateResult:
    selection = settings.voice_runtime_selection
    if selection.mode != VoiceRuntimeMode.GEMINI_LIVE:
        raise RealtimeDogfoodConfigurationError(
            "Gemini browser Live dogfood requires SOPHIA_VOICE_RUNTIME_MODE=gemini_live."
        )
    if not selection.experimental_runtime_enabled:
        raise RealtimeDogfoodConfigurationError(
            "Gemini browser Live dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true."
        )
    if not selection.gemini_live_adapter_enabled:
        raise RealtimeDogfoodConfigurationError(
            "Gemini browser Live dogfood requires SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true."
        )

    resolved = _resolve_gemini_api_key()
    if resolved is None:
        raise RealtimeDogfoodConfigurationError(
            "Gemini browser Live dogfood requires GOOGLE_API_KEY or GEMINI_API_KEY on the trusted backend."
        )

    api_key_env, api_key = resolved
    return GeminiDogfoodGateResult(
        api_key=api_key,
        api_key_env=api_key_env,
        model=str(getattr(settings, "gemini_live_model", DEFAULT_GEMINI_LIVE_MODEL)),
    )


def validate_gemini_browser_provider_event(event: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        raise GeminiBrowserRelayError("Gemini browser relay event must be a JSON object.")

    raw_event = dict(event)
    if not raw_event:
        raise GeminiBrowserRelayError("Gemini browser relay event cannot be empty.")

    for key in _GEMINI_LIVE_SERVER_EVENT_KEYS:
        if key not in raw_event:
            continue
        if key in _GEMINI_LIVE_ZERO_FIELD_SERVER_EVENT_KEYS:
            if isinstance(raw_event[key], Mapping):
                return raw_event
            continue
        if not _is_semantically_empty_value(raw_event[key]):
            return raw_event

    allowed = ", ".join(sorted(_GEMINI_LIVE_SERVER_EVENT_KEYS))
    raise GeminiBrowserRelayError(
        "Gemini browser relay accepts only documented Gemini Live server messages. "
        f"Expected one of: {allowed}."
    )


def categorize_gemini_provider_event(event: Mapping[str, Any]) -> list[str]:
    categories: list[str] = []
    setup_complete = event.get("setupComplete") if "setupComplete" in event else event.get("setup_complete")
    if isinstance(setup_complete, Mapping):
        categories.append("setupComplete")

    server_content = _record_value(_value_from_any_key(event, "serverContent", "server_content"))
    if server_content is not None:
        categories.append("serverContent")
        if _transcription_text_value(server_content, "inputTranscription", "input_transcription"):
            categories.append("inputTranscription")
        if _transcription_text_value(server_content, "outputTranscription", "output_transcription"):
            categories.append("outputTranscription")
        model_turn = _record_value(_value_from_any_key(server_content, "modelTurn", "model_turn"))
        parts = model_turn.get("parts") if model_turn else None
        if isinstance(parts, list):
            if any(_is_gemini_model_turn_audio_part(part) for part in parts):
                categories.append("modelTurnAudio")
            if any(isinstance(part, Mapping) and _string_value(part.get("text")) for part in parts):
                categories.append("modelTurnText")
            if any(
                isinstance(part, Mapping)
                and _record_value(_value_from_any_key(part, "functionCall", "function_call")) is not None
                for part in parts
            ):
                categories.append("toolCall")

    tool_call = _record_value(_value_from_any_key(event, "toolCall", "tool_call"))
    if tool_call is not None and "toolCall" not in categories:
        categories.append("toolCall")
    if _record_value(_value_from_any_key(event, "toolCallCancellation", "tool_call_cancellation")) is not None:
        categories.append("toolCallCancellation")
    if _record_value(_value_from_any_key(event, "goAway", "go_away")) is not None:
        categories.append("goAway")
    if _record_value(_value_from_any_key(event, "sessionResumptionUpdate", "session_resumption_update")) is not None:
        categories.append("sessionResumptionUpdate")
    if _record_value(_value_from_any_key(event, "usageMetadata", "usage_metadata")) is not None:
        categories.append("usageMetadata")
    if _record_value(event.get("error")) is not None:
        categories.append("error")
    return categories


def _without_automatic_artifact_public_events(event: Mapping[str, Any]) -> dict[str, Any]:
    """Remove emit_artifact function calls from the raw mapper path.

    The Gemini mapper still knows how to turn function-call args into an
    artifact payload for provider-level proofs. The browser relay publishes the
    public artifact later, after backend validation and cancellation filtering,
    so cancelled tool calls do not leak companion artifacts into the UI.
    """
    sanitized_event = dict(event)
    changed = False

    tool_call_key = "toolCall" if "toolCall" in event else "tool_call" if "tool_call" in event else None
    tool_call = _record_value(event.get(tool_call_key)) if tool_call_key is not None else None
    function_calls_key = _function_calls_key(tool_call) if tool_call is not None else None
    if tool_call_key is not None and tool_call is not None and function_calls_key is not None:
        original_calls = tool_call.get(function_calls_key, [])
        function_calls = [
            function_call
            for function_call in original_calls
            if not _is_emit_artifact_function_call(function_call)
        ]
        if len(function_calls) != len(original_calls):
            sanitized_tool_call = dict(tool_call)
            sanitized_tool_call[function_calls_key] = function_calls
            sanitized_event[tool_call_key] = sanitized_tool_call
            changed = True

    server_content_key = (
        "serverContent" if "serverContent" in sanitized_event else "server_content" if "server_content" in sanitized_event else None
    )
    server_content = _record_value(sanitized_event.get(server_content_key)) if server_content_key is not None else None
    model_turn_key = None
    model_turn = None
    if server_content is not None:
        model_turn_key = "modelTurn" if "modelTurn" in server_content else "model_turn" if "model_turn" in server_content else None
        model_turn = _record_value(server_content.get(model_turn_key)) if model_turn_key is not None else None
    parts = model_turn.get("parts") if model_turn is not None else None
    if isinstance(parts, list):
        sanitized_parts: list[Any] = []
        for part in parts:
            if not isinstance(part, Mapping):
                sanitized_parts.append(part)
                continue
            function_call_key = "functionCall" if "functionCall" in part else "function_call" if "function_call" in part else None
            function_call = _record_value(part.get(function_call_key)) if function_call_key is not None else None
            if function_call_key is not None and _is_emit_artifact_function_call(function_call):
                sanitized_part = dict(part)
                sanitized_part.pop(function_call_key, None)
                sanitized_parts.append(sanitized_part)
                changed = True
            else:
                sanitized_parts.append(part)
        if changed and server_content_key is not None and model_turn_key is not None and model_turn is not None:
            sanitized_model_turn = dict(model_turn)
            sanitized_model_turn["parts"] = sanitized_parts
            sanitized_server_content = dict(server_content)
            sanitized_server_content[model_turn_key] = sanitized_model_turn
            sanitized_event[server_content_key] = sanitized_server_content

    return sanitized_event if changed else dict(event)


def _function_calls_key(tool_call: Mapping[str, Any] | None) -> str | None:
    if tool_call is None:
        return None
    if isinstance(tool_call.get("functionCalls"), list):
        return "functionCalls"
    if isinstance(tool_call.get("function_calls"), list):
        return "function_calls"
    return None


def _is_emit_artifact_function_call(function_call: Any) -> bool:
    return (
        isinstance(function_call, Mapping)
        and _string_value(function_call.get("name")) == GEMINI_EMIT_ARTIFACT_TOOL_NAME
    )


def _is_transcript_event(categories: list[str]) -> bool:
    return any(
        category in {"inputTranscription", "outputTranscription", "modelTurnText"}
        for category in categories
    )


def _is_boundary_event(categories: list[str]) -> bool:
    return any(
        category in {"turnBoundary", "interruption", "toolCallCancellation"}
        for category in categories
    )


def _is_transcript_or_boundary_event(categories: list[str]) -> bool:
    return _is_transcript_event(categories) or _is_boundary_event(categories)


def _setup_from_dogfood_session(session: RealtimeDogfoodSession) -> dict[str, Any]:
    for event in session.sent_client_events:
        setup = event.get("setup")
        if isinstance(setup, Mapping):
            return dict(setup)

    raise GeminiEphemeralTokenMintError(
        "Gemini dogfood session did not produce the setup payload required for auth-token constraints."
    )


def _resolve_gemini_api_key() -> tuple[str, str] | None:
    for env_name in GEMINI_LIVE_API_KEY_ENVS:
        value = (os.getenv(env_name) or "").strip()
        if value:
            return env_name, value
    return None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _transcription_text_value(record: Mapping[str, Any], *keys: str) -> str | None:
    transcription = _value_from_any_key(record, *keys)
    if isinstance(transcription, str):
        return _string_value(transcription)
    if isinstance(transcription, Mapping):
        return _string_value(transcription.get("text")) or _string_value(
            transcription.get("transcript")
        )
    return None


def _record_value(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    return None


def _value_from_any_key(record: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in record:
            return record[key]
    return None


def _is_gemini_model_turn_audio_part(part: Any) -> bool:
    if not isinstance(part, Mapping):
        return False
    inline_data = _record_value(_value_from_any_key(part, "inlineData", "inline_data"))
    if inline_data is None:
        return False
    mime_type = _string_value(_value_from_any_key(inline_data, "mimeType", "mime_type"))
    return bool(mime_type and mime_type.startswith("audio/pcm"))


def _is_semantically_empty_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, bool | int | float):
        return False
    if isinstance(value, Mapping):
        return not value or all(_is_semantically_empty_value(entry) for entry in value.values())
    if isinstance(value, list | tuple):
        return not value or all(_is_semantically_empty_value(entry) for entry in value)
    return False
