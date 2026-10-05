from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
import requests
import voice.realtime.gemini_langsmith_tracing as tracing
from langsmith import Client as RealLangSmithClient
from langsmith.utils import LangSmithError


@dataclass
class FakeRun:
    name: str
    run_type: str = "chain"
    id: UUID | None = None
    inputs: dict[str, Any] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    attachments: dict[str, Any] = field(default_factory=dict)
    posted: bool = False
    patched: bool = False
    ended: bool = False
    error: str | None = None
    children: list[FakeRun] = field(default_factory=list)

    def create_child(self, name: str, run_type: str = "chain", **kwargs: Any) -> FakeRun:
        child = FakeRun(
            name=name,
            run_type=run_type,
            id=kwargs.get("run_id"),
            inputs=kwargs.get("inputs") or {},
            outputs=kwargs.get("outputs") or {},
            extra=kwargs.get("extra") or {},
            tags=kwargs.get("tags") or [],
        )
        self.children.append(child)
        return child

    def post(self) -> None:
        self.posted = True

    def patch(self, **_: Any) -> None:
        self.patched = True

    def to_headers(self) -> dict[str, str]:
        return {
            "langsmith-trace": f"trace={self.id}",
            "baggage": "langsmith-project=Sophia",
            "authorization": "must-not-propagate",
        }

    def end(self, *, outputs: dict[str, Any] | None = None, error: str | None = None, **_: Any) -> None:
        self.ended = True
        self.outputs = outputs or self.outputs
        self.error = error


class FakeRunTree(FakeRun):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            name=kwargs["name"],
            run_type=kwargs["run_type"],
            id=kwargs["id"],
            inputs=kwargs["inputs"],
            extra=kwargs["extra"],
            tags=kwargs["tags"],
        )
        self.session_name = kwargs["project_name"]


class FakeAttachment:
    def __init__(self, *, mime_type: str, data: bytes) -> None:
        self.mime_type = mime_type
        self.data = data


class FakeClient:
    def __init__(self) -> None:
        self.flush_calls: list[float] = []

    def flush(self, *, timeout: float) -> None:
        self.flush_calls.append(timeout)


CONTENT_ENV = "SOPHIA_GEMINI_LIVE_LANGSMITH_CONTENT"


def _enable_fake_sdk(monkeypatch: Any) -> None:
    monkeypatch.setattr(tracing, "RunTree", FakeRunTree)
    monkeypatch.setattr(tracing, "Attachment", FakeAttachment)
    monkeypatch.setattr(tracing, "langsmith_gemini_live_enabled", lambda: True)


@pytest.fixture(autouse=True)
def _isolated_ingest_state(monkeypatch: Any) -> Any:
    """Each test gets fresh shared clients and a fresh SDK-log sampler."""

    monkeypatch.delenv(CONTENT_ENV, raising=False)
    sdk_logger = logging.getLogger("langsmith.client")
    # getattr keeps this fixture importable on the pre-change base, so the
    # behavioural assertions (not the fixture) are what fail there.
    sampler_factory = getattr(tracing, "_IngestFailureLogSampler", None)
    reset = getattr(tracing, "_reset_shared_ingest_clients", lambda: None)
    if sampler_factory is not None:
        sdk_logger.removeFilter(tracing._INGEST_FAILURE_LOG_SAMPLER)
        monkeypatch.setattr(tracing, "_INGEST_FAILURE_LOG_SAMPLER", sampler_factory())
    reset()
    yield
    reset()
    if sampler_factory is not None:
        sdk_logger.removeFilter(tracing._INGEST_FAILURE_LOG_SAMPLER)


def test_uuid7_has_version_and_variant_bits() -> None:
    value = tracing.uuid7()
    assert value.version == 7
    assert value.variant == "specified in RFC 4122"


def test_payload_compaction_excludes_audio_bytes_and_bounds_text() -> None:
    payload = tracing._safe_payload(
        {
            "inlineData": {"mimeType": "audio/pcm", "data": b"\x00\x01"},
            "text": "x" * 500,
        }
    )

    assert payload["inlineData"]["data"] == {
        "byte_length": 2,
        "raw_audio_excluded": True,
    }
    assert len(payload["text"]) == tracing.MAX_TRACE_TEXT_CHARS + 1


def test_structural_trace_mode_excludes_transcript_and_tool_content(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "structural")
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    recorder.record_provider_event(
        {
            "serverContent": {
                "outputTranscription": {"text": "PRIVATE TRANSCRIPT"},
            }
        },
        categories=["serverContent", "outputTranscription"],
    )
    recorder.record_tool_call(
        tool_call_id="call-1",
        tool_name="start_builder_task",
        arguments={"prompt": "PRIVATE PROMPT"},
        success=True,
        result_summary="PRIVATE RESULT",
    )

    assert recorder.root is not None
    serialized = json.dumps(
        [child.inputs for child in recorder.root.children]
        + [child.outputs for child in recorder.root.children]
    )
    assert "PRIVATE TRANSCRIPT" not in serialized
    assert "PRIVATE PROMPT" not in serialized
    assert "PRIVATE RESULT" not in serialized


def test_structural_trace_mode_reports_booleans_by_type_only(monkeypatch: Any) -> None:
    # A yes/no answer in a tool payload (e.g. a health attribute) is content,
    # not shape: True and False must produce identical structural traces.
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "structural")

    def traced(flag: bool) -> str:
        recorder = tracing.GeminiLiveTraceRecorder(
            session_id="gemini-prod-test",
            user_id="user-1",
            model="gemini-live-test",
            client=FakeClient(),
        )
        recorder.record_provider_event(
            {"toolCall": {"functionCalls": [{"args": {"is_pregnant": flag}}]}},
            categories=["toolCall"],
        )
        recorder.record_tool_call(
            tool_call_id="call-1",
            tool_name="lookup_profile",
            arguments={"is_pregnant": flag, "answers": [flag, not flag]},
            success=True,
            response={"consented": flag},
        )
        assert recorder.root is not None
        return json.dumps(
            [child.inputs for child in recorder.root.children]
            + [child.outputs for child in recorder.root.children],
            sort_keys=True,
        )

    assert traced(True) == traced(False)
    assert '"kind": "boolean"' in traced(True)


def test_synthetic_trace_is_policy_disabled_before_client_or_project_allocation(
    monkeypatch: Any,
) -> None:
    class ForbiddenClient:
        def __init__(self, **_: Any) -> None:
            raise AssertionError("synthetic trace must not allocate a LangSmith client")

    class ForbiddenRunTree:
        def __init__(self, **_: Any) -> None:
            raise AssertionError("synthetic trace must not allocate a LangSmith run")

    monkeypatch.setattr(tracing, "Client", ForbiddenClient)
    monkeypatch.setattr(tracing, "RunTree", ForbiddenRunTree)
    monkeypatch.setattr(tracing, "Attachment", FakeAttachment)
    monkeypatch.setattr(tracing, "langsmith_gemini_live_enabled", lambda: True)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT", "ordinary-project")
    monkeypatch.setenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "x" * 32)

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="synthetic-session-secret",
        user_id="synthetic-principal-secret",
        model="gemini-live-test",
        synthetic_context={
            "synthetic": True,
            "principal_id": "synthetic-principal-secret",
            "test_run_id": "synthetic-run-secret",
            "scenario_id": "V-A01",
            "scenario_version": "vt00.scenarios.v1",
            "environment": "production",
        },
    )

    assert recorder.enabled is False
    assert recorder.root is None
    assert recorder.trace_id is None
    assert recorder.unavailable_reason == "synthetic_isolation_policy"


def test_one_root_contains_socket_event_and_tool_spans(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    client = FakeClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        thread_id="thread-1",
        client=client,
    )

    assert recorder.root is not None
    assert recorder.root.run_type == "chain"
    assert recorder.root.extra["metadata"]["ls_modality"] == "audio"
    assert recorder.root.extra["metadata"]["thread_id"] == "thread-1"
    assert recorder.root.posted is True

    recorder.record_provider_event(
        {"serverContent": {"turnComplete": True}},
        categories=["serverContent"],
        provider_receive_sequence=3,
        relay_correlation_id="relay-3",
    )
    recorder.record_tool_call(
        tool_call_id="call-1",
        tool_name="retrieve_memories",
        arguments={"query": "safe"},
        success=True,
        result_summary="one result",
    )
    recorder.record_function_response(
        tool_call_id="call-1",
        tool_name="retrieve_memories",
        response={"ok": True, "count": 1},
        success=True,
    )

    assert [child.name for child in recorder.root.children] == [
        "turn_complete",
        "function_call:retrieve_memories",
        "function_response:retrieve_memories",
    ]
    assert recorder.root.children[1].run_type == "tool"
    assert recorder.root.children[1].patched is True
    assert all(child.id is not None and child.id.version == 7 for child in recorder.root.children)
    assert all(child.posted for child in recorder.root.children)


def test_open_tool_span_provides_filtered_distributed_trace_headers(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    span = recorder.start_tool_call(
        tool_call_id="builder-call-1",
        tool_name="start_builder_task",
        arguments={"task_type": "presentation"},
        provider_receive_sequence=7,
        relay_correlation_id="relay-7",
    )

    assert span is not None
    assert span.posted is True
    assert span.ended is False
    assert recorder.handoff_headers(span) == {
        "langsmith-trace": f"trace={span.id}",
        "baggage": "langsmith-project=Sophia",
    }
    recorder.finish_tool_call(
        span,
        tool_name="start_builder_task",
        success=True,
        result_summary="launched",
        response={
            "task_id": "builder-thread-1",
            "run_id": "run-1",
            "build_id": "build-1",
            "status": "running",
        },
    )
    assert span.ended is True
    assert span.patched is True
    assert span.outputs["builder_lifecycle"]["build_id"] == "build-1"


def test_artifact_announcement_gate_flags_false_ready(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    recorder.record_function_response(
        tool_call_id="check-1",
        tool_name="check_async_task",
        response={
            "status": "success",
            "task_id": "builder-thread-1",
            "result": {"status": "success", "artifact_path": None},
        },
        success=True,
    )

    assert recorder.root is not None
    gate = recorder.root.children[-1]
    assert gate.name == "artifact.announcement_gate"
    assert gate.outputs["ready_status_observed"] is True
    assert gate.outputs["announced_ready"] is False
    assert gate.outputs["false_ready"] is False
    assert gate.outputs["announcement_allowed"] is False
    assert gate.error == "ARTIFACT_EVIDENCE_MISSING"

    recorder.record_provider_event(
        {"serverContent": {"outputTranscription": {"text": "Your presentation is ready."}}},
        categories=["serverContent", "outputTranscription"],
        provider_receive_sequence=8,
        relay_correlation_id="relay-8",
    )

    spoken = recorder.root.children[-1]
    assert spoken.name == "voice.ready_spoken"
    assert spoken.outputs["announced_ready"] is True
    assert spoken.outputs["false_ready"] is True
    assert spoken.outputs["failure_code"] == "ARTIFACT_EVIDENCE_MISSING"
    assert spoken.error == "FALSE_READY"


def test_spoken_ready_trace_is_allowed_only_with_one_valid_artifact_gate(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    recorder.record_function_response(
        tool_call_id="check-1",
        tool_name="check_async_task",
        response={
            "status": "success",
            "task_id": "builder-thread-1",
            "build_id": "build-1",
            "result": {
                "status": "success",
                "task_id": "builder-thread-1",
                "build_id": "build-1",
                "artifact_path": "/mnt/user-data/outputs/deck.pptx",
            },
        },
        success=True,
    )
    recorder.record_provider_event(
        {"serverContent": {"outputTranscription": {"text": "The deck is complete."}}},
        categories=["serverContent", "outputTranscription"],
        provider_receive_sequence=9,
        relay_correlation_id="relay-9",
    )

    assert recorder.root is not None
    spoken = recorder.root.children[-1]
    assert spoken.name == "voice.ready_spoken"
    assert spoken.outputs["announcement_allowed"] is True
    assert spoken.outputs["artifact_valid"] is True
    assert spoken.outputs["task_id"] == "builder-thread-1"
    assert spoken.outputs["build_id"] == "build-1"
    assert spoken.outputs["gate_run_id"]
    assert spoken.error is None


def test_spoken_non_ready_update_does_not_create_ready_trace(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    recorder.record_provider_event(
        {"serverContent": {"outputTranscription": {"text": "It is not ready yet; it is still building."}}},
        categories=["serverContent", "outputTranscription"],
        provider_receive_sequence=10,
    )

    assert recorder.root is not None
    assert [child.name for child in recorder.root.children] == ["output_transcription"]


def _join_background_flush(recorder: tracing.GeminiLiveTraceRecorder) -> None:
    thread = getattr(recorder, "_flush_thread", None)  # The daemon flush, if any.
    if thread is not None:
        thread.join(timeout=5)
        assert not thread.is_alive()


def test_close_patches_root_with_inline_audio_and_flushes_when_content_allowed(
    monkeypatch: Any,
) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv(CONTENT_ENV, "true")
    # The recording is content: only a non-structural mode may attach it.
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "full")
    client = FakeClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=client,
        owner_memory_governance=tracing.OWNER_NON_GOVERNED,
    )

    recorder.close(conversation_audio=b"RIFF", conversation_audio_mime_type="audio/wav")
    _join_background_flush(recorder)

    assert recorder.root is not None
    assert recorder.root.patched is True
    assert recorder.root.attachments["conversation_audio"].mime_type == "audio/wav"
    assert recorder.root.attachments["conversation_audio"].data == b"RIFF"
    assert recorder.root.outputs["conversation_audio_attached"] is True
    assert client.flush_calls == [tracing.BACKGROUND_FLUSH_TIMEOUT_SECONDS]
    recorder.close(conversation_audio=b"ignored")
    assert client.flush_calls == [tracing.BACKGROUND_FLUSH_TIMEOUT_SECONDS]


@pytest.mark.parametrize(
    ("content_env", "owner_memory_governance"),
    [
        (None, None),
        (None, "non_governed"),
        ("true", None),
        ("true", "governed"),
        ("true", "unknown"),
    ],
)
def test_structure_only_default_never_attaches_conversation_audio(
    monkeypatch: Any,
    content_env: str | None,
    owner_memory_governance: str | None,
) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_AUDIO_CAPTURE_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "full")
    if content_env is None:
        monkeypatch.delenv(CONTENT_ENV, raising=False)
    else:
        monkeypatch.setenv(CONTENT_ENV, content_env)
    owner_kwargs = (
        {"owner_memory_governance": owner_memory_governance}
        if owner_memory_governance is not None
        else {}
    )
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        **owner_kwargs,
    )
    recorder.close(conversation_audio=b"RIFF-PRIVATE-AUDIO")
    _join_background_flush(recorder)

    assert recorder.root is not None
    assert "conversation_audio" not in recorder.root.attachments
    assert recorder.root.outputs["conversation_audio_attached"] is False
    assert recorder.audio_capture_enabled is False
    assert recorder.content_allowed is False
    assert recorder.content_mode == "structural"
    assert recorder.root.extra["metadata"]["trace_content_policy"] == "structure_only"


@pytest.mark.parametrize(("content_mode", "attached"), [("structural", False), ("full", True)])
def test_structural_content_mode_never_attaches_audio_even_when_content_is_permitted(
    monkeypatch: Any,
    content_mode: str,
    attached: bool,
) -> None:
    # Content opt-in + an authoritative non-governed owner + audio capture on:
    # the recording is still content, so an effective structural mode must
    # never attach it. A non-structural mode is the positive control.
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv(CONTENT_ENV, "true")
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_AUDIO_CAPTURE_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", content_mode)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        owner_memory_governance=tracing.OWNER_NON_GOVERNED,
    )
    recorder.close(conversation_audio=b"RIFF-PRIVATE-AUDIO")
    _join_background_flush(recorder)

    assert recorder.root is not None
    assert recorder.content_allowed is True
    assert recorder.audio_capture_enabled is attached
    assert ("conversation_audio" in recorder.root.attachments) is attached
    assert recorder.root.outputs["conversation_audio_attached"] is attached


def test_close_reports_audio_skipped_when_attachment_is_too_large(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv(CONTENT_ENV, "true")
    client = FakeClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=client,
        owner_memory_governance=tracing.OWNER_NON_GOVERNED,
    )

    recorder.close(
        conversation_audio=b"x" * (tracing.MAX_AUDIO_ATTACHMENT_BYTES + 1),
    )
    _join_background_flush(recorder)

    assert recorder.root is not None
    assert "conversation_audio" not in recorder.root.attachments
    assert recorder.root.outputs["conversation_audio_attached"] is False
    assert client.flush_calls == [tracing.BACKGROUND_FLUSH_TIMEOUT_SECONDS]


def test_trace_constructor_failure_is_strictly_fail_open(monkeypatch: Any) -> None:
    failures: list[tuple[str, str]] = []

    class ExplodingRunTree:
        def __init__(self, **_: Any) -> None:
            raise RuntimeError("sdk constructor failed")

    _enable_fake_sdk(monkeypatch)
    monkeypatch.setattr(tracing, "RunTree", ExplodingRunTree)

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-constructor-failure",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        failure_callback=lambda operation, exc: failures.append(
            (operation, exc.__class__.__name__)
        ),
    )

    assert recorder.enabled is False
    assert recorder.trace_id is None
    assert recorder.failure_count == 1
    assert recorder.disabled_operation == "construction"
    assert failures == [("construction", "RuntimeError")]


@pytest.mark.parametrize(
    "operation",
    ["provider_event", "tool_start", "function_response"],
)
def test_trace_span_creation_failures_disable_only_tracing(
    monkeypatch: Any,
    operation: str,
) -> None:
    failures: list[str] = []
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id=f"gemini-span-failure-{operation}",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        failure_callback=lambda failed_operation, _exc: failures.append(failed_operation),
    )
    assert recorder.root is not None

    def explode(*_: Any, **__: Any) -> None:
        raise RuntimeError("sdk span failed")

    recorder.root.create_child = explode  # type: ignore[method-assign]
    if operation == "provider_event":
        recorder.record_provider_event(
            {"serverContent": {"turnComplete": True}},
            categories=["serverContent"],
        )
    elif operation == "tool_start":
        assert recorder.start_tool_call(
            tool_call_id="call-1",
            tool_name="retrieve_memories",
            arguments={"query": "safe"},
        ) is None
    else:
        recorder.record_function_response(
            tool_call_id="call-1",
            tool_name="retrieve_memories",
            response={"ok": True},
            success=True,
        )

    assert recorder.enabled is False
    assert recorder.failure_count == 1
    assert failures


@pytest.mark.parametrize("operation", ["finish_tool", "handoff_headers"])
def test_trace_open_span_operations_are_fail_open(monkeypatch: Any, operation: str) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id=f"gemini-open-span-failure-{operation}",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )
    span = recorder.start_tool_call(
        tool_call_id="call-1",
        tool_name="retrieve_memories",
        arguments={"query": "safe"},
    )
    assert span is not None

    def explode(*_: Any, **__: Any) -> None:
        raise RuntimeError("sdk open span failed")

    if operation == "finish_tool":
        span.end = explode  # type: ignore[method-assign]
        recorder.finish_tool_call(
            span,
            tool_name="retrieve_memories",
            success=True,
        )
    else:
        span.to_headers = explode  # type: ignore[method-assign]
        assert recorder.handoff_headers(span) == {}

    assert recorder.enabled is False
    assert recorder.failure_count == 1


def test_trace_close_failure_does_not_escape(monkeypatch: Any) -> None:
    failures: list[str] = []
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-close-failure",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        failure_callback=lambda operation, _exc: failures.append(operation),
    )
    assert recorder.root is not None

    def explode(*_: Any, **__: Any) -> None:
        raise RuntimeError("sdk close failed")

    recorder.root.end = explode  # type: ignore[method-assign]
    recorder.close()

    assert recorder.enabled is False
    assert recorder.failure_count == 1
    assert recorder.disabled_operation == "close"
    assert failures == ["close"]


def test_effective_setup_fingerprint_is_privacy_safe_and_reaches_results(
    monkeypatch: Any,
) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "trace-test-secret")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "a793100008f7ccb5a25e9e018f896e7ec9dc2a3d")
    private_prompt = "PRIVATE USER CONTEXT: childhood memory"
    setup = {
        "model": "models/gemini-3.1-flash-live-preview",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}
            },
        },
        "systemInstruction": {"parts": [{"text": private_prompt}]},
        "tools": [
            {"functionDeclarations": [{"name": "web_fetch"}]},
            {"googleSearch": {}},
        ],
        "sessionResumption": {},
        "contextWindowCompression": {"slidingWindow": {}},
    }
    fingerprint = tracing.build_gemini_live_setup_fingerprint(
        setup,
        token_owned_fields={
            "model",
            "generationConfig",
            "systemInstruction",
            "contextWindowCompression",
        },
        browser_owned_fields={"sessionResumption", "tools"},
        provider_epoch=1,
        configured_flags={
            "continuity_enabled": True,
            "compression_enabled": True,
            "google_search_enabled": True,
            "web_fetch_enabled": True,
            "coreview_enabled": True,
            "coreview_still_frame_enabled": True,
        },
    )

    serialized = json.dumps(fingerprint)
    assert private_prompt not in serialized
    assert fingerprint["deployment_sha"] == "a793100008f7ccb5a25e9e018f896e7ec9dc2a3d"
    assert fingerprint["model"] == "models/gemini-3.1-flash-live-preview"
    assert fingerprint["voice"] == "Kore"
    assert fingerprint["provider_epoch"] == 1
    assert fingerprint["field_ownership"]["tools"] == "browser"
    assert fingerprint["field_ownership"]["sessionResumption"] == "browser"
    assert "tools" not in fingerprint["token_owned_fields"]
    assert fingerprint["effective_flags"]["google_search_enabled"] is True
    assert fingerprint["effective_flags"]["web_fetch_enabled"] is True
    assert fingerprint["compression"] == {
        "configured": True,
        "effective_in_setup": True,
        "triggered": None,
        "trigger_observation": "not_exposed_by_gemini_live_server_events",
    }
    assert all(fingerprint["hashes"].values())
    assert fingerprint["character_counts"]["prompt"] == len(private_prompt)

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-fingerprint",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        setup_fingerprint=fingerprint,
    )
    assert recorder.root is not None
    assert recorder.root.extra["metadata"]["effective_setup_fingerprint"] == fingerprint
    next_fingerprint = {**fingerprint, "provider_epoch": 2}
    recorder.update_setup_fingerprint(next_fingerprint)
    recorder.close()

    assert recorder.root.outputs["effective_setup_fingerprint"]["provider_epoch"] == 2


# ---------------------------------------------------------------------------
# Ingest health, non-blocking close and the structure-only content policy
# ---------------------------------------------------------------------------

SENTINEL = "SENTINEL_9f3c"
LANGSMITH_TEST_ENDPOINT = "https://langsmith.ingest.invalid"


def _sdk_shaped_http_error(status: int, body: bytes, *, path: str = "/runs/multipart") -> Exception:
    """Reproduce the SDK's wrapping of a background HTTP failure.

    ``request_with_retries`` raises a generic ``LangSmithError`` (message
    includes ``repr`` of an HTTPError carrying the response text) from inside
    ``except requests.HTTPError``, so only the implicit chain holds the
    response object.
    """

    response = requests.Response()
    response.status_code = status
    response._content = body  # noqa: SLF001 - building a transport fake.
    response.headers["Content-Type"] = "application/json"
    response.url = f"{LANGSMITH_TEST_ENDPOINT}{path}"
    try:
        try:
            try:
                response.raise_for_status()
            except requests.HTTPError as exc:
                raise requests.HTTPError(str(exc), response.text) from exc
        except requests.HTTPError as exc:
            raise LangSmithError(f"Failed to POST {path} in LangSmith API. {exc!r}")  # noqa: B904
    except LangSmithError as error:
        return error
    raise AssertionError("unreachable")


class FakeLangSmithSession(requests.Session):
    """Transport fake for the real SDK: requests are recorded, never sent."""

    def __init__(self, *, multipart_status: int = 202, multipart_body: bytes = b"{}") -> None:
        super().__init__()
        self.multipart_status = multipart_status
        self.multipart_body = multipart_body
        self.sent: list[tuple[str, str, bytes]] = []
        self._lock = threading.Lock()

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:  # type: ignore[override]
        data = kwargs.get("data")
        if hasattr(data, "read"):
            data = data.read()
        if isinstance(data, str):
            data = data.encode()
        with self._lock:
            self.sent.append((method, str(url), bytes(data or b"")))
        response = requests.Response()
        response.url = str(url)
        response.request = requests.Request(method, str(url)).prepare()
        response.headers["Content-Type"] = "application/json"
        if str(url).endswith("/info"):
            response.status_code = 200
            response._content = json.dumps(  # noqa: SLF001
                {"version": "0.0.0-test", "instance_flags": {}}
            ).encode()
        elif str(url).endswith("/runs/multipart"):
            response.status_code = self.multipart_status
            response._content = self.multipart_body  # noqa: SLF001
        else:
            response.status_code = 202
            response._content = b"{}"  # noqa: SLF001
        return response

    def multipart_bodies(self) -> bytes:
        with self._lock:
            return b"\n".join(body for _, url, body in self.sent if url.endswith("/runs/multipart"))


def _set_live_tracing_env(monkeypatch: Any, *, api_key: str = "lsv2_sk_" + "k" * 32) -> None:
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", api_key)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", LANGSMITH_TEST_ENDPOINT)
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "00000000-0000-4000-8000-000000000001")
    monkeypatch.setenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "h" * 32)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT", "Sophia-Gemini-Live-Voice")


def _install_real_sdk_client(monkeypatch: Any, session: FakeLangSmithSession) -> list[Any]:
    built: list[Any] = []

    def factory(**kwargs: Any) -> Any:
        client = RealLangSmithClient(session=session, **kwargs)
        built.append(client)
        return client

    monkeypatch.setattr(tracing, "Client", factory)
    return built


def _wait_until(predicate: Any, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return bool(predicate())


def _messages(caplog: Any, prefix: str) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.getMessage().startswith(prefix)]


def test_background_403_is_visible_logged_once_and_content_free(
    monkeypatch: Any,
    caplog: Any,
) -> None:
    caplog.set_level(logging.INFO)
    secret_key = f"lsv2_sk_{SENTINEL}_keymaterial"
    _set_live_tracing_env(monkeypatch, api_key=secret_key)
    session = FakeLangSmithSession(
        multipart_status=403,
        multipart_body=json.dumps({"error": "Forbidden", "detail": SENTINEL}).encode(),
    )
    _install_real_sdk_client(monkeypatch, session)

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-ingest-403",
        user_id="user-1",
        model="gemini-live-test",
    )
    assert recorder.enabled is True
    # The 403 arrives on the SDK background thread after RunTree.post returned.
    assert _wait_until(lambda: recorder.ingest_status == "rejected")
    for sequence in range(1, 4):
        recorder.record_provider_event(
            {"serverContent": {"outputTranscription": {"text": f"private {SENTINEL}"}}},
            categories=["serverContent", "outputTranscription"],
            provider_receive_sequence=sequence,
        )
    recorder.close()
    _join_background_flush(recorder)

    health = recorder._ingest_health  # noqa: SLF001
    assert health.state == "rejected"
    assert health.http_status == 403
    assert health.error_code == "forbidden"
    assert health.error_type == "LangSmithError"
    assert health.failure_count >= 2  # root post batch + root patch batch
    assert recorder.ingest_failure_count == health.failure_count
    assert recorder.children_skipped == 3
    assert recorder.ingest_unavailable_reason == "langsmith_ingest_rejected"
    sent = session.multipart_bodies()
    assert b'"name":"gemini_live_conversation"' in sent
    assert b'"name":"output_transcription"' not in sent

    [rejected] = _messages(caplog, "gemini.langsmith.ingest_rejected")
    for fragment in (
        "state=rejected",
        "previous_state=unknown",
        "status=403",
        "error_code=forbidden",
        "error_type=LangSmithError",
        "endpoint_host=langsmith.ingest.invalid",
        "workspace_header=present",
        "key_kind=service",
        "project=Sophia-Gemini-Live-Voice",
        "sdk=",
    ):
        assert fragment in rejected
    [completed] = _messages(caplog, "gemini.langsmith.trace_completed")
    assert "ingest_status=rejected" in completed
    sdk_lines = [
        record.getMessage()
        for record in caplog.records
        if record.name == "langsmith.client" and record.getMessage().startswith("Failed to")
    ]
    # Two batches failed (root post + root patch); only the first line is kept.
    assert len(sdk_lines) == 1
    assert "detail redacted" in sdk_lines[0]
    assert SENTINEL not in caplog.text
    assert "lsv2_" not in caplog.text
    assert '"error"' not in caplog.text
    assert "Forbidden" not in caplog.text


def test_ingest_health_warns_once_per_state_change(caplog: Any) -> None:
    caplog.set_level(logging.INFO, logger=tracing.logger.name)
    health = tracing.IngestHealth(
        log_context={
            "endpoint_host": "eu.api.smith.langchain.com",
            "workspace_header": "present",
            "key_kind": "service",
            "project": "Sophia",
            "sdk": "0.8.18",
        }
    )
    forbidden = _sdk_shaped_http_error(
        403,
        json.dumps({"error": "Forbidden", "detail": SENTINEL}).encode(),
    )

    worker = threading.Thread(target=lambda: [health.record_failure(forbidden) for _ in range(3)])
    worker.start()
    worker.join(timeout=5)

    assert health.state == "rejected"
    assert health.failure_count == 3
    assert health.http_status == 403
    assert health.error_code == "forbidden"
    snapshot = health.snapshot()
    assert snapshot["first_failure_at"] <= snapshot["last_failure_at"]

    health.record_failure(_sdk_shaped_http_error(500, f"<html>{SENTINEL}</html>".encode()))
    assert health.state == "failing"
    assert health.error_code is None
    health.record_flush(failures_before=health.failure_count, timed_out=False)
    assert health.state == "ok"
    health.record_flush(failures_before=health.failure_count, timed_out=False)

    warnings = _messages(caplog, "gemini.langsmith.ingest_rejected")
    assert len(warnings) == 2
    assert "state=rejected previous_state=unknown status=403 error_code=forbidden" in warnings[0]
    assert "state=failing previous_state=rejected status=500 error_code=None" in warnings[1]
    assert _messages(caplog, "gemini.langsmith.ingest_recovered") == [
        "gemini.langsmith.ingest_recovered state=ok previous_state=failing failure_count=4"
    ]
    assert SENTINEL not in caplog.text


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_code", "expected_state"),
    [
        (
            _sdk_shaped_http_error(403, b'{"error":"org_scoped_key_requires_workspace"}'),
            403,
            "org_scoped_key_requires_workspace",
            "rejected",
        ),
        (_sdk_shaped_http_error(403, b'{"error":"Not allowed: SENTINEL_9f3c"}'), 403, None, "rejected"),
        (_sdk_shaped_http_error(401, b"not json SENTINEL_9f3c"), 401, None, "rejected"),
        (_sdk_shaped_http_error(429, b'{"error":"rate_limited"}'), 429, "rate_limited", "failing"),
        (RuntimeError("connection reset SENTINEL_9f3c"), None, None, "failing"),
    ],
)
def test_ingest_error_details_read_status_and_allowlisted_code_only(
    error: Exception,
    expected_status: int | None,
    expected_code: str | None,
    expected_state: str,
) -> None:
    health = tracing.IngestHealth()
    health.record_failure(error)

    assert health.http_status == expected_status
    assert health.error_code == expected_code
    assert health.state == expected_state
    assert SENTINEL not in json.dumps(health.snapshot())


def test_sdk_ingest_failure_lines_are_sampled_and_redacted(caplog: Any) -> None:
    caplog.set_level(logging.WARNING, logger="langsmith.client")
    tracing.install_langsmith_ingest_log_filter()
    sdk_logger = logging.getLogger("langsmith.client")

    for _ in range(120):
        sdk_logger.warning(
            "Failed to multipart ingest runs: LangSmithError("
            f"'Failed to POST /runs/multipart ... {SENTINEL} {{\"error\":\"Forbidden\"}}')"
        )
    sdk_logger.warning(f"Failed to send compressed multipart ingest: {SENTINEL}")
    sdk_logger.warning("unrelated SDK warning")

    kept = [record.getMessage() for record in caplog.records if record.name == "langsmith.client"]
    suffix = "detail redacted; see gemini.langsmith.ingest_rejected)"
    assert kept == [
        f"Failed to multipart ingest (occurrence=1; {suffix}",
        f"Failed to multipart ingest (occurrence=50; {suffix}",
        f"Failed to multipart ingest (occurrence=100; {suffix}",
        f"Failed to send compressed multipart ingest (occurrence=1; {suffix}",
        "unrelated SDK warning",
    ]
    assert SENTINEL not in caplog.text


def test_close_returns_before_a_slow_flush_completes(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    release = threading.Event()

    class SlowFlushClient(FakeClient):
        def flush(self, *, timeout: float) -> None:
            self.flush_calls.append(timeout)
            release.wait(5.0)

    client = SlowFlushClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-slow-flush",
        user_id="user-1",
        model="gemini-live-test",
        client=client,
    )

    started = time.monotonic()
    try:
        recorder.close()
        elapsed = time.monotonic() - started
    finally:
        release.set()

    assert elapsed < 0.5
    assert recorder.root is not None
    assert recorder.root.patched is True
    _join_background_flush(recorder)
    assert client.flush_calls == [tracing.BACKGROUND_FLUSH_TIMEOUT_SECONDS]


@pytest.mark.parametrize("pending_queue", [False, True])
def test_trace_completed_reports_flush_timeout(
    monkeypatch: Any,
    caplog: Any,
    pending_queue: bool,
) -> None:
    caplog.set_level(logging.INFO, logger=tracing.logger.name)
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setattr(tracing, "BACKGROUND_FLUSH_TIMEOUT_SECONDS", 0.05)

    class Queue:
        unfinished_tasks = 1

    class CappedClient(FakeClient):
        tracing_queue = Queue() if pending_queue else None

        def flush(self, *, timeout: float) -> None:
            self.flush_calls.append(timeout)
            if not pending_queue:
                time.sleep(0.1)  # A flush that ignores its cap.

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-capped-flush",
        user_id="user-1",
        model="gemini-live-test",
        client=CappedClient(),
    )
    recorder.close()
    _join_background_flush(recorder)

    assert recorder.flush_timed_out is True
    [completed] = _messages(caplog, "gemini.langsmith.trace_completed")
    assert "flush_timed_out=True" in completed
    assert "ingest_status=unknown" in completed


def test_children_are_skipped_while_ingest_is_rejected(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    health = tracing.IngestHealth()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-rejected",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
        ingest_health=health,
    )
    assert recorder.root is not None
    recorder.record_provider_event({"serverContent": {"turnComplete": True}}, categories=["serverContent"])
    assert len(recorder.root.children) == 1
    assert recorder.ingest_unavailable_reason is None

    health.record_failure(_sdk_shaped_http_error(403, b'{"error":"Forbidden"}'))

    recorder.record_provider_event({"serverContent": {"turnComplete": True}}, categories=["serverContent"])
    assert recorder.start_tool_call(
        tool_call_id="call-1",
        tool_name="retrieve_memories",
        arguments={"query": "q"},
    ) is None
    recorder.record_function_response(
        tool_call_id="check-1",
        tool_name="check_async_task",
        response={
            "status": "success",
            "task_id": "builder-thread-1",
            "result": {"status": "success", "artifact_path": "/mnt/user-data/outputs/deck.pptx"},
        },
        success=True,
    )
    recorder.record_provider_event(
        {"serverContent": {"outputTranscription": {"text": "The deck is complete."}}},
        categories=["serverContent", "outputTranscription"],
    )

    assert len(recorder.root.children) == 1
    # event, tool open, function response, gate, event, spoken-ready claim
    assert recorder.children_skipped == 6
    assert recorder.ingest_unavailable_reason == "langsmith_ingest_rejected"
    assert recorder.root.posted is True
    recorder.close()
    _join_background_flush(recorder)
    assert recorder.root.patched is True
    assert recorder.root.outputs["event_count"] == 3
    assert recorder.root.outputs["tool_count"] == 1
    assert recorder.root.outputs["ready_claim_count"] == 1
    assert recorder.root.outputs["false_ready_claim_count"] == 0
    assert recorder.root.outputs["children_skipped_ingest_rejected"] == 6


def test_one_shared_client_per_endpoint_key_and_workspace(monkeypatch: Any) -> None:
    built: list[Any] = []

    class RecordingClient:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs
            built.append(self)

        def flush(self, *, timeout: float) -> None:
            return None

    _enable_fake_sdk(monkeypatch)
    monkeypatch.setattr(tracing, "Client", RecordingClient)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", LANGSMITH_TEST_ENDPOINT)
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_sk_first")
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "workspace-a")

    def make(session_id: str) -> tracing.GeminiLiveTraceRecorder:
        return tracing.GeminiLiveTraceRecorder(
            session_id=session_id,
            user_id="user-1",
            model="gemini-live-test",
        )

    first, second = make("session-1"), make("session-2")
    assert len(built) == 1
    assert first.client is second.client is built[0]
    callback = built[0].kwargs["tracing_error_callback"]
    assert callback.__self__ is first._ingest_health is second._ingest_health  # noqa: SLF001
    assert built[0].kwargs["workspace_id"] == "workspace-a"

    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_sk_second")
    make("session-3")
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "workspace-b")
    make("session-4")
    assert len(built) == 3


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"Sophia"', "Sophia"),
        ("  'Sophia-Gemini-Live-Voice'  \n", "Sophia-Gemini-Live-Voice"),
        (' " " ', "Sophia-Gemini-Live-Voice"),
        ("Sophia's voice", "Sophia's voice"),
    ],
)
def test_project_name_strips_quotes_and_whitespace(monkeypatch: Any, raw: str, expected: str) -> None:
    _enable_fake_sdk(monkeypatch)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT", raw)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-project",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )

    assert recorder.root is not None
    assert recorder.root.session_name == expected


def test_startup_status_line_is_content_free(monkeypatch: Any, caplog: Any) -> None:
    caplog.set_level(logging.INFO, logger=tracing.logger.name)
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING", "true")
    monkeypatch.setenv("SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET", "x" * 32)
    monkeypatch.setenv("LANGSMITH_API_KEY", f"lsv2_pt_{SENTINEL}")
    monkeypatch.setenv(
        "LANGSMITH_ENDPOINT",
        f"https://user:{SENTINEL}@eu.api.smith.langchain.com/api?token={SENTINEL}",
    )
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", SENTINEL)

    status = tracing.log_gemini_live_langsmith_startup_status()

    assert status["endpoint_host"] == "eu.api.smith.langchain.com"
    assert status["key_kind"] == "personal"
    assert status["workspace_present"] is True
    assert status["tracing_enabled"] is True
    assert status["content_mode"] == "structure_only"
    assert status["sdk"] not in {"", "unavailable", "invalid"}
    [line] = _messages(caplog, "gemini.langsmith.startup")
    assert "endpoint_host=eu.api.smith.langchain.com key_kind=personal workspace_present=True" in line
    assert SENTINEL not in caplog.text
    assert "lsv2" not in caplog.text
    assert "user:" not in caplog.text


def test_structure_only_tool_errors_carry_codes_not_text(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-errors",
        user_id="user-1",
        model="gemini-live-test",
        client=FakeClient(),
    )
    cases = [
        ({"error_type": "ValueError"}, "ValueError"),
        ({"response": {"error_type": "active_builder_task"}}, "active_builder_task"),
        ({}, "tool_error"),
    ]
    for kwargs, expected in cases:
        span = recorder.start_tool_call(
            tool_call_id="call-1",
            tool_name="start_builder_task",
            arguments={},
        )
        recorder.finish_tool_call(
            span,
            tool_name="start_builder_task",
            success=False,
            result_summary=f"summary {SENTINEL}",
            error=f"ValueError: {SENTINEL}",
            **kwargs,
        )
        assert span is not None
        assert span.error == expected
    recorder.close(error=f"RuntimeError: {SENTINEL}")
    _join_background_flush(recorder)
    assert recorder.root is not None
    assert recorder.root.error == "session_error"


def _record_every_content_bearing_input(recorder: tracing.GeminiLiveTraceRecorder) -> None:
    setup = {
        "model": "models/gemini-live-test",
        "systemInstruction": {"parts": [{"text": f"Memory: {SENTINEL} lives in Lisbon"}]},
        "tools": [{"functionDeclarations": [{"name": "start_builder_task"}]}],
    }
    recorder.update_setup_fingerprint(
        tracing.build_gemini_live_setup_fingerprint(
            setup,
            token_owned_fields={"model", "systemInstruction"},
            browser_owned_fields={"tools"},
            provider_epoch=2,
        )
    )
    events: list[tuple[dict[str, Any], list[str]]] = [
        (
            {"serverContent": {"inputTranscription": {"text": f"user said {SENTINEL}"}}},
            ["serverContent", "inputTranscription"],
        ),
        (
            {"serverContent": {"outputTranscription": {"text": f"assistant said {SENTINEL}"}}},
            ["serverContent", "outputTranscription"],
        ),
        (
            {
                "serverContent": {
                    "modelTurn": {
                        "parts": [
                            {"text": f"typed {SENTINEL}"},
                            {"inlineData": {"mimeType": "audio/pcm", "data": f"{SENTINEL}AAAA"}},
                        ]
                    },
                    "groundingMetadata": {
                        "webSearchQueries": [f"search {SENTINEL}"],
                        "groundingChunks": [
                            {"web": {"uri": f"https://example.com/{SENTINEL}", "title": SENTINEL}}
                        ],
                    },
                    f"{SENTINEL} data-derived key": True,
                }
            },
            ["serverContent", "modelTurnText", "modelTurnAudio"],
        ),
        (
            {
                "toolCall": {
                    "functionCalls": [
                        {"id": "fc-1", "name": "start_builder_task", "args": {"description": SENTINEL}}
                    ]
                }
            },
            ["toolCall"],
        ),
        ({"error": {"code": 400, "message": f"provider error {SENTINEL}"}}, ["error"]),
        ({"usageMetadata": {"totalTokenCount": 42}}, ["usageMetadata"]),
    ]
    for index, (event, categories) in enumerate(events, start=1):
        recorder.record_provider_event(
            event,
            categories=categories,
            provider_receive_sequence=index,
            relay_correlation_id=f"relay-{index}",
            provider_received_at="2026-10-03T21:26:57.443Z",
        )
    span = recorder.start_tool_call(
        tool_call_id="fc-1",
        tool_name="start_builder_task",
        arguments={
            "description": f"build a deck about {SENTINEL}",
            "nested": {"query": [SENTINEL], "count": 2},
            f"{SENTINEL} free text key": "x",
        },
        provider_receive_sequence=4,
        relay_correlation_id="relay-4",
    )
    recorder.finish_tool_call(
        span,
        tool_name="start_builder_task",
        success=False,
        result_summary=f"result {SENTINEL}",
        error=f"ValueError: {SENTINEL}",
        response={
            "status": f"{SENTINEL} status text",
            "terminal_reason": f"because {SENTINEL}",
            "task_id": f"task-{SENTINEL}",
            "artifact_path": f"/mnt/user-data/outputs/{SENTINEL}.pdf",
            "memories": [{"content": SENTINEL}],
        },
    )
    recorder.record_function_response(
        tool_call_id="check-1",
        tool_name="check_async_task",
        response={
            "status": "success",
            "task_id": f"task-{SENTINEL}",
            "result": {
                "status": "success",
                "artifact_path": f"/mnt/user-data/outputs/{SENTINEL}.pptx",
                "failure_code": f"{SENTINEL} failure text",
                "builder_result": {"summary": SENTINEL},
            },
        },
        success=True,
    )
    recorder.record_provider_event(
        {"serverContent": {"outputTranscription": {"text": f"The deck is ready, {SENTINEL}."}}},
        categories=["serverContent", "outputTranscription"],
        provider_receive_sequence=9,
    )
    recorder.record_tool_call(
        tool_call_id="fc-2",
        tool_name="retrieve_memories",
        arguments={"query": SENTINEL},
        success=False,
        result_summary=SENTINEL,
        error=SENTINEL,
        response={"memories": [{"content": SENTINEL, "id": f"mem-{SENTINEL}"}]},
    )


@pytest.mark.parametrize(
    ("legacy_switches", "owner_governance", "content_allowed"),
    [
        ("defaults", None, False),
        ("all_on", None, False),
        ("all_on", "non_governed", True),
        ("structural_opt_in", "non_governed", False),
    ],
)
def test_sentinel_content_never_reaches_the_transport_in_structure_only_mode(
    monkeypatch: Any,
    caplog: Any,
    legacy_switches: str,
    owner_governance: str | None,
    content_allowed: bool,
) -> None:
    caplog.set_level(logging.INFO)
    _set_live_tracing_env(monkeypatch)
    if legacy_switches == "all_on":
        # Every legacy content switch is on; only the governance gate decides.
        monkeypatch.setenv("SOPHIA_GEMINI_LIVE_AUDIO_CAPTURE_ENABLED", "true")
        monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "full")
        monkeypatch.setenv(CONTENT_ENV, "true")
    elif legacy_switches == "structural_opt_in":
        monkeypatch.setenv(CONTENT_ENV, "true")
        monkeypatch.setenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", "structural")
    else:
        monkeypatch.delenv("SOPHIA_GEMINI_LIVE_AUDIO_CAPTURE_ENABLED", raising=False)
        monkeypatch.delenv("SOPHIA_GEMINI_LIVE_TRACE_CONTENT_MODE", raising=False)
    session = FakeLangSmithSession()
    built = _install_real_sdk_client(monkeypatch, session)

    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-sentinel",
        user_id=f"owner-{SENTINEL}",
        thread_id=f"thread-{SENTINEL}",
        model="gemini-live-test",
        owner_memory_governance=owner_governance,
    )
    assert recorder.enabled is True
    _record_every_content_bearing_input(recorder)
    recorder.close(
        conversation_audio=b"RIFF" + SENTINEL.encode(),
        conversation_audio_mime_type="audio/wav",
        error=f"RuntimeError: {SENTINEL}",
    )
    _join_background_flush(recorder)
    built[0].flush(timeout=5)

    sent = session.multipart_bodies()
    assert b"function_call:start_builder_task" in sent  # The capture saw the children.
    if content_allowed:
        # Positive control: the same capture does see content when allowed.
        assert SENTINEL.encode() in sent
    else:
        assert SENTINEL.encode() not in sent
        assert b"conversation_audio" not in sent.replace(b'"conversation_audio_attached"', b"")
    assert SENTINEL not in caplog.text
