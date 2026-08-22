from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
import voice.realtime.gemini_langsmith_tracing as tracing


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


def _enable_fake_sdk(monkeypatch: Any) -> None:
    monkeypatch.setattr(tracing, "RunTree", FakeRunTree)
    monkeypatch.setattr(tracing, "Attachment", FakeAttachment)
    monkeypatch.setattr(tracing, "langsmith_gemini_live_enabled", lambda: True)


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


def test_close_patches_root_with_inline_audio_and_flushes(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    client = FakeClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=client,
    )

    recorder.close(conversation_audio=b"RIFF", conversation_audio_mime_type="audio/wav")

    assert recorder.root is not None
    assert recorder.root.patched is True
    assert recorder.root.attachments["conversation_audio"].mime_type == "audio/wav"
    assert recorder.root.attachments["conversation_audio"].data == b"RIFF"
    assert recorder.root.outputs["conversation_audio_attached"] is True
    assert client.flush_calls == [10.0]
    recorder.close(conversation_audio=b"ignored")
    assert client.flush_calls == [10.0]


def test_close_reports_audio_skipped_when_attachment_is_too_large(monkeypatch: Any) -> None:
    _enable_fake_sdk(monkeypatch)
    client = FakeClient()
    recorder = tracing.GeminiLiveTraceRecorder(
        session_id="gemini-prod-test",
        user_id="user-1",
        model="gemini-live-test",
        client=client,
    )

    recorder.close(
        conversation_audio=b"x" * (tracing.MAX_AUDIO_ATTACHMENT_BYTES + 1),
    )

    assert recorder.root is not None
    assert "conversation_audio" not in recorder.root.attachments
    assert recorder.root.outputs["conversation_audio_attached"] is False
    assert client.flush_calls == [10.0]


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
