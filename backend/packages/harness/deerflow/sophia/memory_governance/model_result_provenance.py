"""Parsed model-output origin, not current memory or file-use permission.

Capture only inside owned SDK calls. Headers alone, incomplete streams, cached
middleware responses and an unbound handler result cannot create this witness.
"""
import asyncio
import json
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from typing import Annotated, Literal

from langchain_core.messages import AIMessage, AIMessageChunk, message_chunk_to_message
from pydantic import BeforeValidator, Field, model_validator

from .model_dispatch import MAX_MODEL_BYTES, FinalModelDispatchAuthority, FinalModelDispatchReceipt
from .refs import keyed_ref
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable

_capture = ContextVar("mem00_parsed_model_capture", default=None)
_sink = ContextVar("mem00_model_result_sink", default=None)


def _no_reuse(value):
    if value is not False:
        raise ValueError("model_result_not_current_permission")
    return value


NoPermission = Annotated[Literal[False], BeforeValidator(_no_reuse)]


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class ModelToolOrigin(IntakeModel):
    tool_call_ref: str = Field(pattern=r"^hmac-sha256:model-tool-call:[a-f0-9]{64}$")
    tool_name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    arguments_ref: str = Field(pattern=r"^hmac-sha256:model-tool-arguments:[a-f0-9]{64}$")


class ModelResultRequest(IntakeModel):
    schema_name: Literal["mem00.model-result-request.v1"] = Field(alias="schema")
    model_admission_event_id: UuidText
    attempt_id: UuidText
    run_id: UuidText
    thread_id: UuidText
    payload_ref: str = Field(pattern=r"^hmac-sha256:model-payload:[a-f0-9]{64}$")
    result_ref: str = Field(pattern=r"^hmac-sha256:model-result:[a-f0-9]{64}$")
    tool_calls: list[ModelToolOrigin] = Field(max_length=128)

    @model_validator(mode="after")
    def unique_tools(self):
        if len({tool.tool_call_ref for tool in self.tool_calls}) != len(self.tool_calls):
            raise ValueError("model_result_duplicate_tool")
        return self


class ModelResultReceipt(IntakeModel):
    schema_name: Literal["mem00.model-result.v1"] = Field(alias="schema")
    owner_id: str
    event_id: UuidText
    request: ModelResultRequest
    # C2 does not activate Builder resume/completion memory contracts.
    admission: FinalModelDispatchReceipt
    historical_result_only: HistoricalOnly
    model_reuse_permission: NoPermission

    @model_validator(mode="after")
    def exact_admission(self):
        request, admission = self.request, self.admission
        if (self.owner_id, request.model_admission_event_id, request.attempt_id, request.run_id, request.thread_id, request.payload_ref) != (
                admission.owner_id, admission.event_id, admission.attempt_id, admission.run_id, admission.thread_id, admission.payload_ref):
            raise ValueError("model_result_admission_join")
        from .source_dependencies import source_dependencies
        source_dependencies(owner_id=self.owner_id, values=admission.source_dependencies)
        return self


class ModelResultService:
    def __init__(self, owner_id, store):
        from .identity import assert_not_voice_lab_principal
        assert_not_voice_lab_principal(owner_id)
        if type(owner_id) is not str or not owner_id.strip() or owner_id != owner_id.strip():
            raise MemoryGovernanceUnavailable("memory_model_result_owner")
        self.owner, self.store = owner_id, store

    def lookup(self, attempt_id):
        try:
            raw = self.store.get_model_result(p_user_id=self.owner, p_attempt_id=attempt_id)
            if raw is None:
                return None
            value = ModelResultReceipt.model_validate(raw)
            if (value.owner_id, value.request.attempt_id) != (self.owner, attempt_id):
                raise ValueError("result_scope")
            return value
        except Exception:
            raise MemoryGovernanceUnavailable("memory_model_result_unavailable") from None

    def record(self, request, admission):
        try:
            request = ModelResultRequest.model_validate(request.model_dump(mode="python", by_alias=True))
            value = self.lookup(request.attempt_id)
            if value is None:
                try:
                    value = ModelResultReceipt.model_validate(self.store.record_model_result(
                        p_user_id=self.owner, p_request=request.model_dump(mode="json", by_alias=True)))
                except Exception:
                    value = self.lookup(request.attempt_id)
            if value is None or value.owner_id != self.owner or value.request != request or value.admission != admission:
                raise ValueError("model_result_unknown_or_conflict")
            return value
        except Exception:
            raise MemoryGovernanceUnavailable("memory_model_result_unavailable") from None


def _output(message):
    if isinstance(message, AIMessageChunk):
        chunks = message.tool_call_chunks
        if len(chunks) != len(message.tool_calls):
            raise ValueError("model_result_incomplete_tool_chunks")
        for chunk, call in zip(chunks, message.tool_calls, strict=True):
            if (chunk["id"], chunk["name"]) != (call["id"], call["name"]) or _tool_json(chunk["args"]) != call["args"]:
                raise ValueError("model_result_repaired_tool_json")
        message = message_chunk_to_message(message)
    if not isinstance(message, AIMessage) or message.invalid_tool_calls:
        raise ValueError("model_result_unparsed")
    metadata = message.response_metadata
    stop = metadata.get("stop_reason", metadata.get("finish_reason"))
    if stop not in {"end_turn", "stop_sequence", "stop", "tool_use", "tool_calls"}:
        raise ValueError("model_result_not_terminal")
    encoded = _json(message.model_dump(mode="json"))
    if len(encoded.encode()) > MAX_MODEL_BYTES or len(message.tool_calls) > 128:
        raise ValueError("model_result_budget")
    tools = []
    for call in message.tool_calls:
        if (not isinstance(call, dict) or type(call.get("id")) is not str or not 1 <= len(call["id"]) <= 256
                or type(call.get("args")) is not dict):
            raise ValueError("model_result_tool_unparsed")
        tools.append(ModelToolOrigin(tool_call_ref=keyed_ref("model-tool-call", call["id"]), tool_name=call.get("name"),
            arguments_ref=keyed_ref("model-tool-arguments", _json(call["args"]))))
    if stop in {"tool_use", "tool_calls"} and not tools:
        raise ValueError("model_result_tool_missing")
    return keyed_ref("model-result", encoded), tools


def _tool_json(raw):
    if type(raw) is not str or len(raw.encode()) > MAX_MODEL_BYTES:
        raise ValueError("model_result_raw_tool_budget")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("model_result_duplicate_json_key")
            result[key] = value
        return result
    def constant(value):
        raise ValueError("model_result_json_constant")
    result = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    if type(result) is not dict:
        raise ValueError("model_result_tool_object")
    return result


class ParsedModelCapture:
    def __init__(self):
        self.lock = Lock()
        self.observations = []
        self.invalid = False
        self.used = False

    def complete_generation(self, generation, metadata=None):
        if generation is None:
            self.invalid = True
            return self.complete([])
        message = generation.message.model_copy(deep=True)
        message.response_metadata = {**(metadata or {}), **(generation.generation_info or {}), **message.response_metadata}
        return self.complete([message])

    def transport(self, authority, receipt, entered, response, cancelled):
        with self.lock:
            if len(self.observations) >= 8:
                self.invalid = True
                return
            if not isinstance(authority, FinalModelDispatchAuthority):
                self.invalid = True
                return
            self.observations.append((authority, receipt, entered, response.status_code if response is not None else None, cancelled))

    def complete(self, messages):
        # This is observation after SDK parsing, never a new dispatch/retry.
        try:
            with self.lock:
                if self.used:
                    raise ValueError("model_result_capture_reused")
                self.used = True
                rows = list(self.observations)
            if self.invalid or len(messages) != 1 or not rows:
                raise ValueError("model_result_origin_ambiguous")
            winners = [row for row in rows if row[2] and row[3] is not None and 200 <= row[3] < 300 and not row[4]]
            if len(winners) != 1 or winners[0] is not rows[-1]:
                raise ValueError("model_result_transport_ambiguous")
            authority, admission, _, _, _ = winners[0]
            if admission is None:
                raise ValueError("model_result_admission_missing")
            result_ref, tools = _output(messages[0])
            request = ModelResultRequest(schema="mem00.model-result-request.v1",
                model_admission_event_id=admission.event_id, attempt_id=admission.attempt_id, run_id=admission.run_id,
                thread_id=admission.thread_id, payload_ref=admission.payload_ref, result_ref=result_ref, tool_calls=tools)
            receipt = ModelResultService(authority.owner_id, authority.store).record(request, admission)
            sink = _sink.get()
            if sink is not None:
                sink.append(receipt.model_dump_json(by_alias=True))
            from .observability import emit_memory_event
            emit_memory_event("memory.model.result", service="sophia-langgraph", outcome="parsed_result_recorded",
                safe_reason_code="historical_result_not_current_permission", owner_ref=keyed_ref("owner", receipt.owner_id),
                attempt_ref=keyed_ref("model-attempt", request.attempt_id), result_ref=result_ref,
                model_admission_event_ref=keyed_ref("model-admission-event", admission.event_id),
                result_event_ref=keyed_ref("model-result-event", receipt.event_id), tool_call_count=len(tools),
                model_result_observed=True, model_reuse_permission=False)
            return receipt
        except Exception:
            from .observability import record_memory_observation_gap
            record_memory_observation_gap()
            return None  # No origin permission; product result is not replayed.


def observe_parsed_transport(**fields):
    capture = _capture.get()
    if capture is not None:
        try:
            capture.transport(**fields)
        except Exception:
            capture.invalid = True
            from .observability import record_memory_observation_gap
            record_memory_observation_gap()


class ParsedStream:
    def __init__(self, capture):
        self.capture, self.generation, self.bytes = capture, None, 0

    def add(self, chunk):
        if self.capture.invalid:
            return
        try:
            self.bytes += len(_json(chunk.model_dump(mode="json")).encode())
            if self.bytes > MAX_MODEL_BYTES:
                raise ValueError("model_result_stream_budget")
            copied = chunk.model_copy(deep=True)
            self.generation = copied if self.generation is None else self.generation + copied
        except Exception:
            self.capture.invalid = True
            self.generation = None

    def complete(self):
        return self.capture.complete_generation(self.generation)

    def validate(self):
        try:
            if self.generation is None:
                raise ValueError("model_result_empty_stream")
            message = self.generation.message.model_copy(deep=True)
            message.response_metadata = {**(self.generation.generation_info or {}), **message.response_metadata}
            _output(message)
        except Exception:
            self.capture.invalid = True


@contextmanager
def parsed_model_scope():
    existing = _capture.get()
    if existing is not None:
        yield existing, False
        return
    value = ParsedModelCapture()
    token = _capture.set(value)
    try:
        yield value, True
    finally:
        _capture.reset(token)


def parsed_stream_capture():
    existing = _capture.get()
    return (existing, False) if existing is not None else (ParsedModelCapture(), True)


@contextmanager
def bind_parsed_capture(capture):
    """Bind only during iterator advancement, never across an outward yield."""
    token = _capture.set(capture)
    try:
        yield
    finally:
        _capture.reset(token)


@contextmanager
def model_result_sink():
    values = []
    token = _sink.set(values)
    try:
        yield values
    finally:
        _sink.reset(token)


def scoped_result_receipts(values, *, owner_id, run_id, thread_id):
    """Freeze only the current authenticated call's content-free witnesses."""
    try:
        parsed = [ModelResultReceipt.model_validate_json(value) for value in values]
        if any((item.owner_id, item.request.run_id, item.request.thread_id) != (owner_id, run_id, thread_id) for item in parsed):
            raise ValueError("model_result_sink_scope")
        if len({item.request.attempt_id for item in parsed}) != len(parsed):
            raise ValueError("model_result_sink_duplicate")
        return tuple(item.model_dump_json(by_alias=True) for item in parsed)
    except Exception:
        from .observability import record_memory_observation_gap
        record_memory_observation_gap()
        return ()


async def settle_result_observation(callback, *args):
    """Retain ownership until bounded store I/O settles, including cancellation."""
    task = asyncio.create_task(asyncio.to_thread(callback, *args))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError()
    return result
