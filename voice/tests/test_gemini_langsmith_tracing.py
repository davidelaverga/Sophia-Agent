from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

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
    children: list["FakeRun"] = field(default_factory=list)

    def create_child(self, name: str, run_type: str = "chain", **kwargs: Any) -> "FakeRun":
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
    assert all(child.id is not None and child.id.version == 7 for child in recorder.root.children)
    assert all(child.posted for child in recorder.root.children)


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
