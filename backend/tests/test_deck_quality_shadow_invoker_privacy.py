from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langsmith.run_helpers import get_tracing_context
from pydantic import BaseModel, ConfigDict

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality import invoker as invoker_module
from deerflow.sophia.deck_quality.invoker import (
    MultimodalStructuredModelInvoker,
    QualityInputTokenCount,
    QualityInvocationError,
    safety_identifier,
)


class _Result(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: str


@pytest.fixture(autouse=True)
def _dq_specific_provider_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-key",
    )
    monkeypatch.setattr(
        invoker_module,
        "get_app_config",
        lambda: SimpleNamespace(
            deck_quality=SimpleNamespace(
                enabled=True,
                mode="shadow",
                scope="canary",
                canary_user_ids=frozenset({"synthetic-canary-user"}),
                judge_route="deck.judge.visual",
            )
        ),
    )


def _plan(**overrides: object) -> ResolvedModelPlan:
    values: dict[str, object] = {
        "route_name": "deck.judge.visual",
        "deployment_name": "openai-gpt-5-6-sol",
        "provider": "openai",
        "provider_model": "gpt-5.6-sol",
        "profile_name": "deck-visual-judge-v2",
        "profile_version": "v2",
        "capabilities": frozenset(
            {
                "image_input",
                "multi_image_input",
                "strict_structured_output",
                "reasoning_effort",
            }
        ),
        "model_overrides": {
            "reasoning": {
                "effort": "high",
                "mode": "standard",
                "context": "current_turn",
            },
            "output_version": "responses/v1",
            "use_responses_api": True,
            "store": False,
            "max_completion_tokens": 6000,
            "timeout": 180,
            "max_retries": 0,
        },
        "plan_hash": "a" * 64,
    }
    values.update(overrides)
    return ResolvedModelPlan.model_validate(values)


def _complete_response(
    *,
    input_tokens: int = 120,
    output_tokens: int = 30,
    output_text: str = '{"verdict":"needs_revision"}',
) -> Any:
    return SimpleNamespace(
        status="completed",
        error=None,
        output_text=output_text,
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        ),
    )


class _FakeInputTokens:
    def __init__(self, owner: _FakeResponses) -> None:
        self.owner = owner

    async def count(self, **kwargs: Any) -> Any:
        self.owner.count_calls.append(kwargs)
        self.owner.tracing_states.append(get_tracing_context()["enabled"])
        if self.owner.count_error is not None:
            raise self.owner.count_error
        return SimpleNamespace(input_tokens=self.owner.count_value)


class _FakeResponses:
    def __init__(self, *, response: Any | None = None) -> None:
        self.input_tokens = _FakeInputTokens(self)
        self.count_value = 120
        self.count_calls: list[dict[str, Any]] = []
        self.create_calls: list[dict[str, Any]] = []
        self.tracing_states: list[bool | None] = []
        self.response = response or _complete_response()
        self.count_error: Exception | None = None
        self.create_error: Exception | None = None

    async def create(self, **kwargs: Any) -> Any:
        self.create_calls.append(kwargs)
        self.tracing_states.append(get_tracing_context()["enabled"])
        if self.create_error is not None:
            raise self.create_error
        return self.response


class _FakeModel:
    def __init__(
        self,
        responses: _FakeResponses,
        *,
        payload_mutator: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.callbacks: list[Any] = [object()]
        self.tags: list[str] = ["unsafe"]
        self.metadata: dict[str, Any] = {"unsafe": "raw"}
        self.verbose = True
        self.root_async_client = SimpleNamespace(responses=responses)
        self.payload_mutator = payload_mutator

    def _get_request_payload(
        self,
        messages: list[Any],
        *,
        response_format: dict[str, Any],
    ) -> dict[str, Any]:
        schema = response_format["json_schema"]
        payload = {
            "model": "gpt-5.6-sol",
            "stream": False,
            "extra_body": {
                "safety_identifier": safety_identifier(
                    campaign_id="DQ-1",
                    canary_user_id="synthetic-canary-user",
                )
            },
            "reasoning": {
                "effort": "high",
                "mode": "standard",
                "context": "current_turn",
            },
            "store": False,
            "max_output_tokens": 6000,
            "input": [{"role": "user", "content": messages[0]}],
            "text": {"format": {"type": "json_schema", **schema}},
        }
        if self.payload_mutator is not None:
            self.payload_mutator(payload)
        return payload


def _fake_setup(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response: Any | None = None,
    payload_mutator: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[
    MultimodalStructuredModelInvoker,
    Any,
    _FakeResponses,
    dict[str, Any],
]:
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-key",
    )
    responses = _FakeResponses(response=response)
    captured: dict[str, Any] = {}

    def create_internal_route_chat_model(*, plan: ResolvedModelPlan, **kwargs: Any) -> _FakeModel:
        captured["name"] = plan.deployment_name
        captured["kwargs"] = kwargs
        model = _FakeModel(responses, payload_mutator=payload_mutator)
        captured["model"] = model
        return model

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    invoker = MultimodalStructuredModelInvoker()
    request = invoker.prepare_request(
        plan=_plan(),
        schema=_Result,
        messages=["data:image/png;base64,DO_NOT_TRACE"],
        campaign_id="DQ-1",
        canary_user_id="synthetic-canary-user",
    )
    return invoker, request, responses, captured


def test_one_canonical_payload_is_projected_for_count_and_reused_for_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoker, request, responses, captured = _fake_setup(monkeypatch)
    count = asyncio.run(invoker.count_input_tokens(request=request, timeout_seconds=10))
    result = asyncio.run(
        invoker.invoke(
            request=request,
            plan=_plan(),
            timeout_seconds=10,
            preflight=count,
        )
    )

    full_payload = json.loads(request.provider_payload_json)
    count_call = dict(responses.count_calls[0])
    assert count_call.pop("timeout") == 10
    assert count_call == {key: full_payload[key] for key in {"model", "input", "reasoning", "text"}}
    create_call = dict(responses.create_calls[0])
    assert create_call.pop("timeout") == 10
    assert create_call == full_payload
    assert responses.tracing_states == [False, False]
    assert captured["name"] == "openai-gpt-5-6-sol"
    assert captured["kwargs"]["attach_tracing"] is False
    assert captured["kwargs"]["api_key"].get_secret_value() == (
        "synthetic-dq-only-key"
    )
    model = captured["model"]
    assert (model.callbacks, model.tags, model.metadata, model.verbose) == (
        [],
        [],
        {},
        False,
    )
    assert "DO_NOT_TRACE" not in repr(request)
    assert result.parsed.verdict == "needs_revision"
    assert result.metrics.preflight_payload_hash == request.payload_hash
    assert result.metrics.total_tokens == 150


def test_real_pinned_chatopenai_builds_the_exact_locked_eight_key_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-key",
    )

    def create_internal_route_chat_model(**kwargs: Any) -> ChatOpenAI:
        kwargs.pop("plan")
        kwargs.pop("capability")
        kwargs.pop("attach_tracing")
        kwargs.pop("api_key")
        return ChatOpenAI(model="gpt-5.6-sol", api_key="synthetic-not-used", **kwargs)

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    contact = "data:image/png;base64,Y29udGFjdA=="
    slide = "data:image/png;base64,c2xpZGU="
    blocks: list[dict[str, Any]] = [
        {
            "type": "image_url",
            "image_url": {"url": contact, "detail": "high"},
        }
    ]
    blocks.extend(
        {
            "type": "image_url",
            "image_url": {"url": slide, "detail": "original"},
        }
        for _ in range(5)
    )
    request = MultimodalStructuredModelInvoker().prepare_request(
        plan=_plan(),
        schema=_Result,
        messages=[SystemMessage(content="strict"), HumanMessage(content=blocks)],
        campaign_id="DQ-1",
        canary_user_id="synthetic-canary-user",
    )

    payload = json.loads(request.provider_payload_json)
    assert set(payload) == {
        "model",
        "stream",
        "extra_body",
        "reasoning",
        "store",
        "max_output_tokens",
        "input",
        "text",
    }
    assert payload["model"] == "gpt-5.6-sol"
    assert payload["max_output_tokens"] == 6000
    assert payload["reasoning"] == {
        "effort": "high",
        "mode": "standard",
        "context": "current_turn",
    }
    details = [block["detail"] for item in payload["input"] for block in (item["content"] if isinstance(item.get("content"), list) else []) if block.get("type") == "input_image"]
    assert details == ["high", "original", "original", "original", "original", "original"]
    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["text"]["format"]["strict"] is True
    assert payload["text"]["format"]["schema"]["additionalProperties"] is False


def test_missing_dq_specific_credential_fails_without_falling_back_to_process_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "ordinary-process-key-must-not-be-used")
    create_calls = 0

    def create_internal_route_chat_model(**_kwargs: Any) -> _FakeModel:
        nonlocal create_calls
        create_calls += 1
        return _FakeModel(_FakeResponses())

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    with pytest.raises(QualityInvocationError, match="judge_unavailable"):
        MultimodalStructuredModelInvoker().prepare_request(
            plan=_plan(),
            schema=_Result,
            messages=["content-excluded"],
            campaign_id="DQ-1",
            canary_user_id="synthetic-canary-user",
        )
    assert create_calls == 0


def test_noncanary_fails_before_dq_credential_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actual_getenv = invoker_module.os.getenv
    dq_key_reads = 0
    create_calls = 0

    def guarded_getenv(name: str, default: str | None = None) -> str | None:
        nonlocal dq_key_reads
        if name == "SOPHIA_DECK_QUALITY_OPENAI_API_KEY":
            dq_key_reads += 1
            raise AssertionError("noncanary attempted to read DQ credential")
        return actual_getenv(name, default)

    def create_internal_route_chat_model(**_kwargs: Any) -> _FakeModel:
        nonlocal create_calls
        create_calls += 1
        return _FakeModel(_FakeResponses())

    monkeypatch.setattr(invoker_module.os, "getenv", guarded_getenv)
    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )

    with pytest.raises(QualityInvocationError, match="judge_unavailable"):
        MultimodalStructuredModelInvoker().prepare_request(
            plan=_plan(),
            schema=_Result,
            messages=["content-excluded"],
            campaign_id="DQ-1",
            canary_user_id="ordinary-user",
        )

    assert dq_key_reads == 0
    assert create_calls == 0


@pytest.mark.parametrize(
    "mutator",
    [
        lambda payload: payload.__setitem__("instructions", "unexpected"),
        lambda payload: payload.__setitem__("tools", []),
        lambda payload: payload.__setitem__("previous_response_id", "resp_unsafe"),
        lambda payload: payload.__setitem__("temperature", 0),
        lambda payload: payload.__setitem__("unknown", True),
        lambda payload: payload.pop("text"),
        lambda payload: payload["extra_body"].__setitem__("unexpected", True),
        lambda payload: payload.__setitem__("max_output_tokens", 6001),
    ],
)
def test_request_shape_or_lock_drift_fails_before_any_provider_call(
    monkeypatch: pytest.MonkeyPatch,
    mutator: Callable[[dict[str, Any]], None],
) -> None:
    with pytest.raises(QualityInvocationError, match="judge_unavailable"):
        _fake_setup(monkeypatch, payload_mutator=mutator)


def test_preflight_hash_mismatch_fails_before_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoker, request, responses, _captured = _fake_setup(monkeypatch)

    with pytest.raises(QualityInvocationError, match="structured_output_invalid"):
        asyncio.run(
            invoker.invoke(
                request=request,
                plan=_plan(),
                timeout_seconds=10,
                preflight=QualityInputTokenCount(
                    input_tokens=120,
                    payload_hash="f" * 64,
                ),
            )
        )

    assert responses.create_calls == []


def test_provider_usage_must_equal_the_exact_preflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoker, request, responses, _captured = _fake_setup(monkeypatch)

    with pytest.raises(QualityInvocationError, match="structured_output_invalid"):
        asyncio.run(
            invoker.invoke(
                request=request,
                plan=_plan(),
                timeout_seconds=10,
                preflight=QualityInputTokenCount(
                    input_tokens=119,
                    payload_hash=request.payload_hash,
                ),
            )
        )

    assert len(responses.create_calls) == 1


@pytest.mark.parametrize(
    "response",
    [
        SimpleNamespace(status="incomplete", error=None, output_text="", usage=None),
        SimpleNamespace(status="failed", error=object(), output_text="", usage=None),
        _complete_response(output_text="SECRET_RAW_PROVIDER_OUTPUT"),
        _complete_response(output_text='{"verdict":"needs_revision","extra":"bad"}'),
    ],
)
def test_incomplete_or_invalid_outputs_are_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    response: Any,
) -> None:
    invoker, request, _responses, _captured = _fake_setup(
        monkeypatch,
        response=response,
    )

    with pytest.raises(QualityInvocationError) as captured:
        asyncio.run(
            invoker.invoke(
                request=request,
                plan=_plan(),
                timeout_seconds=10,
                preflight=QualityInputTokenCount(
                    input_tokens=120,
                    payload_hash=request.payload_hash,
                ),
            )
        )

    assert captured.value.code == "structured_output_invalid"
    assert captured.value.__cause__ is None
    assert "SECRET_RAW_PROVIDER_OUTPUT" not in str(captured.value)


def test_provider_errors_retain_only_allowlisted_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BadRequestError(Exception):
        status_code = 400

    invoker, request, responses, _captured = _fake_setup(monkeypatch)
    responses.create_error = BadRequestError("SECRET_REQUEST_BODY")

    with pytest.raises(QualityInvocationError) as captured:
        asyncio.run(
            invoker.invoke(
                request=request,
                plan=_plan(),
                timeout_seconds=10,
                preflight=QualityInputTokenCount(
                    input_tokens=120,
                    payload_hash=request.payload_hash,
                ),
            )
        )

    error = captured.value
    assert error.code == "judge_unavailable"
    assert error.provider_error_type == "BadRequestError"
    assert error.provider_status_code == 400
    assert error.__cause__ is None
    assert "SECRET_REQUEST_BODY" not in str(error)


def test_count_failures_are_sanitized_and_never_generate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invoker, request, responses, _captured = _fake_setup(monkeypatch)
    responses.count_error = RuntimeError("SECRET_COUNT_BODY")

    with pytest.raises(QualityInvocationError, match="judge_unavailable"):
        asyncio.run(invoker.count_input_tokens(request=request, timeout_seconds=10))

    assert responses.create_calls == []


@pytest.mark.parametrize("count_value", [None, True, -1])
def test_malformed_provider_counts_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    count_value: object,
) -> None:
    invoker, request, responses, _captured = _fake_setup(monkeypatch)
    responses.count_value = count_value  # type: ignore[assignment]

    with pytest.raises(QualityInvocationError, match="judge_unavailable"):
        asyncio.run(
            invoker.count_input_tokens(request=request, timeout_seconds=10)
        )

    assert responses.create_calls == []


def test_callback_overrides_are_stripped_from_the_private_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    responses = _FakeResponses()

    def create_internal_route_chat_model(**kwargs: Any) -> _FakeModel:
        captured.update(kwargs)
        return _FakeModel(responses)

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    overrides = dict(_plan().model_overrides)
    overrides.update(
        {
            "callbacks": [object()],
            "tags": ["unsafe"],
            "metadata": {"unsafe": "raw"},
            "verbose": True,
        }
    )
    MultimodalStructuredModelInvoker().prepare_request(
        plan=_plan(model_overrides=overrides),
        schema=_Result,
        messages=["private"],
        campaign_id="DQ-1",
        canary_user_id="synthetic-canary-user",
    )

    assert not {"callbacks", "tags", "metadata", "verbose"} & captured.keys()


def test_safety_identifier_is_stable_and_does_not_expose_user_id() -> None:
    value = safety_identifier(campaign_id="DQ-1", canary_user_id="private-user-id")

    assert value == safety_identifier(
        campaign_id="DQ-1",
        canary_user_id="private-user-id",
    )
    assert value.startswith("dq1-")
    assert len(value) == 64
    assert "private-user-id" not in value
