from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_openai import ChatOpenAI
from langsmith.run_helpers import get_tracing_context

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models import factory
from deerflow.sophia.deck_design_lift import invoker as invoker_module
from deerflow.sophia.deck_design_lift.invoker import (
    DeckRepairInvocationError,
    DeckRepairModelInvoker,
    repair_safety_identifier,
)


def _plan(**overrides: object) -> ResolvedModelPlan:
    values: dict[str, object] = {
        "route_name": "deck.repair.executor",
        "deployment_name": "openai-gpt-5-6-sol",
        "provider": "openai",
        "provider_model": "gpt-5.6-sol",
        "profile_name": "deck-repair-executor-v1",
        "profile_version": "v1",
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
            "max_completion_tokens": 12_000,
            "timeout": 240,
            "max_retries": 0,
        },
        "plan_hash": "a" * 64,
    }
    values.update(overrides)
    return ResolvedModelPlan.model_validate(values)


def _repair_config(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "enabled": True,
        "mode": "production_canary",
        "scope": "canary",
        "canary_user_ids": frozenset({"synthetic-canary-user"}),
        "repair_route": "deck.repair.executor",
        "repair_profile_version": "deck-repair-executor-v1",
        "max_repair_calls": 1,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture(autouse=True)
def _exact_dq2_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "synthetic-dq-only-key",
    )
    monkeypatch.setattr(
        invoker_module,
        "get_app_config",
        lambda: SimpleNamespace(deck_design_lift=_repair_config()),
    )


def _candidate_json() -> str:
    return json.dumps(
        {
            "creative_plan_patch": None,
            "design_plan_patch": None,
            "source_updates": [
                {
                    "selector": "slide:1",
                    "source_role": "body",
                    "expected_source_hash": "b" * 64,
                    "content": "<section><h1>Repaired</h1></section>",
                }
            ],
            "asset_updates": [],
            "rationale": "Strengthen hierarchy without changing retained content.",
        },
        separators=(",", ":"),
    )


def _complete_response(
    *,
    output_text: str | None = None,
    input_tokens: object = 200,
    output_tokens: object = 50,
    total_tokens: object = 250,
) -> Any:
    return SimpleNamespace(
        status="completed",
        error=None,
        output_text=output_text or _candidate_json(),
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
        ),
    )


class _FakeResponses:
    def __init__(self, *, response: Any | None = None) -> None:
        self.response = response or _complete_response()
        self.create_calls: list[dict[str, Any]] = []
        self.tracing_states: list[bool | None] = []
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
            "extra_body": {"safety_identifier": repair_safety_identifier(canary_user_id="synthetic-canary-user")},
            "reasoning": {
                "effort": "high",
                "mode": "standard",
                "context": "current_turn",
            },
            "store": False,
            "max_output_tokens": 12_000,
            "input": [{"role": "user", "content": messages[0]}],
            "text": {"format": {"type": "json_schema", **schema}},
        }
        if self.payload_mutator is not None:
            self.payload_mutator(payload)
        return payload


def _invoke_with_fake(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response: Any | None = None,
    payload_mutator: Callable[[dict[str, Any]], None] | None = None,
    plan: ResolvedModelPlan | None = None,
) -> tuple[Any, _FakeResponses, dict[str, Any]]:
    responses = _FakeResponses(response=response)
    captured: dict[str, Any] = {}

    def create_internal_route_chat_model(*, plan: ResolvedModelPlan, **kwargs: Any) -> _FakeModel:
        captured["plan"] = plan
        captured["kwargs"] = kwargs
        model = _FakeModel(responses, payload_mutator=payload_mutator)
        captured["model"] = model
        return model

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    result = asyncio.run(
        DeckRepairModelInvoker().invoke(
            plan=plan or _plan(),
            messages=["PRIVATE_REPAIR_INPUT"],
            canary_user_id="synthetic-canary-user",
        )
    )
    return result, responses, captured


def test_factory_admits_only_the_exact_purpose_route_deployment_pair() -> None:
    repair_plan = _plan()
    judge_plan = _plan(
        route_name="deck.judge.visual",
        profile_name="deck-visual-judge-v2",
    )

    repair_capability = factory._issue_internal_model_route_capability(
        repair_plan,
        purpose="deck_design_lift_repair",
    )
    judge_capability = factory._issue_internal_model_route_capability(
        judge_plan,
        purpose="deck_quality_judge",
    )

    assert repair_capability.route_name == "deck.repair.executor"
    assert judge_capability.route_name == "deck.judge.visual"
    with pytest.raises(ValueError, match="not admissible"):
        factory._issue_internal_model_route_capability(
            judge_plan,
            purpose="deck_design_lift_repair",
        )
    with pytest.raises(ValueError, match="not admissible"):
        factory._issue_internal_model_route_capability(
            repair_plan,
            purpose="deck_quality_judge",
        )
    with pytest.raises(ValueError, match="capability is invalid"):
        factory.create_internal_route_chat_model(
            plan=judge_plan,
            capability=repair_capability,
        )


def test_exact_canary_invocation_is_one_stateless_untraced_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, responses, captured = _invoke_with_fake(monkeypatch)

    assert len(responses.create_calls) == 1
    call = responses.create_calls[0]
    assert call.pop("timeout") == 240
    assert set(call) == {
        "model",
        "stream",
        "extra_body",
        "reasoning",
        "store",
        "max_output_tokens",
        "input",
        "text",
    }
    assert call["store"] is False
    assert call["stream"] is False
    assert call["max_output_tokens"] == 12_000
    assert call["reasoning"] == {
        "effort": "high",
        "mode": "standard",
        "context": "current_turn",
    }
    assert "conversation" not in call
    assert "previous_response_id" not in call
    assert responses.tracing_states == [False]
    assert captured["kwargs"]["attach_tracing"] is False
    assert captured["kwargs"]["api_key"].get_secret_value() == ("synthetic-dq-only-key")
    assert captured["kwargs"]["max_retries"] == 0
    assert captured["kwargs"]["timeout"] == 240
    assert not {"callbacks", "tags", "metadata", "verbose"} & captured["kwargs"].keys()
    model = captured["model"]
    assert (model.callbacks, model.tags, model.metadata, model.verbose) == (
        [],
        [],
        {},
        False,
    )
    assert result.candidate.source_updates[0].selector == "slide:1"
    assert result.metrics.input_tokens == 200
    assert result.metrics.output_tokens == 50
    assert result.metrics.total_tokens == 250
    assert result.metrics.payload_hash != ""


def test_real_pinned_chatopenai_builds_the_locked_repair_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def create_internal_route_chat_model(**kwargs: Any) -> ChatOpenAI:
        kwargs.pop("plan")
        kwargs.pop("capability")
        kwargs.pop("attach_tracing")
        kwargs.pop("api_key")
        return ChatOpenAI(
            model="gpt-5.6-sol",
            api_key="synthetic-not-used",
            **kwargs,
        )

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_internal_route_chat_model,
    )
    request = DeckRepairModelInvoker()._prepare_private_request(
        plan=_plan(),
        messages=["PRIVATE_REPAIR_INPUT"],
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
    assert payload["store"] is False
    assert payload["max_output_tokens"] == 12_000
    assert payload["text"]["format"]["name"] == "DeckRepairCandidate"
    assert payload["text"]["format"]["strict"] is True
    assert payload["text"]["format"]["schema"]["additionalProperties"] is False
    assert "conversation" not in payload
    assert "previous_response_id" not in payload
    assert "PRIVATE_REPAIR_INPUT" not in repr(request)


@pytest.mark.parametrize(
    "config_overrides,plan_overrides,user_id",
    [
        ({"enabled": False}, {}, "synthetic-canary-user"),
        ({"mode": "off"}, {}, "synthetic-canary-user"),
        ({"scope": "ordinary"}, {}, "synthetic-canary-user"),
        ({}, {}, "ordinary-user"),
        ({"repair_route": "deck.repair.advisor"}, {}, "synthetic-canary-user"),
        (
            {},
            {"route_name": "deck.repair.advisor"},
            "synthetic-canary-user",
        ),
        (
            {},
            {"deployment_name": "public-model"},
            "synthetic-canary-user",
        ),
        ({}, {"provider": "anthropic"}, "synthetic-canary-user"),
        ({}, {"provider_model": "gpt-5.6"}, "synthetic-canary-user"),
        ({}, {"profile_name": "other-profile"}, "synthetic-canary-user"),
    ],
)
def test_scope_or_route_drift_fails_before_credential_or_model_access(
    monkeypatch: pytest.MonkeyPatch,
    config_overrides: dict[str, object],
    plan_overrides: dict[str, object],
    user_id: str,
) -> None:
    monkeypatch.setattr(
        invoker_module,
        "get_app_config",
        lambda: SimpleNamespace(deck_design_lift=_repair_config(**config_overrides)),
    )
    actual_getenv = invoker_module.os.getenv
    key_reads = 0
    model_calls = 0

    def guarded_getenv(name: str, default: str | None = None) -> str | None:
        nonlocal key_reads
        if name == "SOPHIA_DECK_QUALITY_OPENAI_API_KEY":
            key_reads += 1
            raise AssertionError("inadmissible call attempted credential access")
        return actual_getenv(name, default)

    def create_model(**_kwargs: Any) -> Any:
        nonlocal model_calls
        model_calls += 1
        raise AssertionError("inadmissible call attempted model construction")

    monkeypatch.setattr(invoker_module.os, "getenv", guarded_getenv)
    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_model,
    )

    with pytest.raises(DeckRepairInvocationError, match="repair_unavailable"):
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(**plan_overrides),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id=user_id,
            )
        )
    assert key_reads == 0
    assert model_calls == 0


def test_missing_dq_credential_never_falls_back_to_process_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "ordinary-key-must-not-be-used")
    model_calls = 0

    def create_model(**_kwargs: Any) -> Any:
        nonlocal model_calls
        model_calls += 1
        raise AssertionError

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_model,
    )

    with pytest.raises(DeckRepairInvocationError, match="repair_unavailable"):
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id="synthetic-canary-user",
            )
        )
    assert model_calls == 0


@pytest.mark.parametrize(
    "mutator",
    [
        lambda payload: payload.__setitem__("conversation", "unsafe"),
        lambda payload: payload.__setitem__("previous_response_id", "resp_unsafe"),
        lambda payload: payload.__setitem__("tools", []),
        lambda payload: payload.__setitem__("temperature", 0),
        lambda payload: payload.__setitem__("store", True),
        lambda payload: payload.__setitem__("stream", True),
        lambda payload: payload.__setitem__("max_output_tokens", 12_001),
        lambda payload: payload.__setitem__("reasoning", {"effort": "medium"}),
        lambda payload: payload["extra_body"].__setitem__("unsafe", True),
        lambda payload: payload.pop("text"),
    ],
)
def test_payload_lock_drift_fails_before_provider_invocation(
    monkeypatch: pytest.MonkeyPatch,
    mutator: Callable[[dict[str, Any]], None],
) -> None:
    responses = _FakeResponses()

    def create_model(**_kwargs: Any) -> _FakeModel:
        return _FakeModel(responses, payload_mutator=mutator)

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_model,
    )

    with pytest.raises(DeckRepairInvocationError, match="repair_unavailable"):
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id="synthetic-canary-user",
            )
        )
    assert responses.create_calls == []


@pytest.mark.parametrize(
    "override",
    [
        {"max_retries": 1},
        {"max_retries": False},
        {"timeout": 241},
        {"timeout": 240.0},
        {"max_completion_tokens": 11_999},
        {"store": True},
        {"use_responses_api": False},
        {"output_version": "v0"},
        {"reasoning": {"effort": "medium"}},
        {"base_url": "https://untrusted.invalid"},
    ],
)
def test_profile_or_client_override_drift_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    override: dict[str, object],
) -> None:
    model_overrides = dict(_plan().model_overrides)
    model_overrides.update(override)
    model_calls = 0

    def create_model(**_kwargs: Any) -> Any:
        nonlocal model_calls
        model_calls += 1
        raise AssertionError

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        create_model,
    )

    with pytest.raises(DeckRepairInvocationError, match="repair_unavailable"):
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(model_overrides=model_overrides),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id="synthetic-canary-user",
            )
        )
    assert model_calls == 0


@pytest.mark.parametrize(
    "response",
    [
        _complete_response(input_tokens=None),
        _complete_response(output_tokens=True),
        _complete_response(output_tokens=-1, total_tokens=199),
        _complete_response(output_tokens=12_001, total_tokens=12_201),
        _complete_response(total_tokens=251),
        SimpleNamespace(
            status="incomplete",
            error=None,
            output_text="SECRET_RAW_PROVIDER_OUTPUT",
            usage=None,
        ),
        _complete_response(output_text="SECRET_RAW_PROVIDER_OUTPUT"),
    ],
)
def test_usage_or_structured_output_drift_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    response: Any,
) -> None:
    responses = _FakeResponses(response=response)

    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        lambda **_kwargs: _FakeModel(responses),
    )

    with pytest.raises(DeckRepairInvocationError) as captured:
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id="synthetic-canary-user",
            )
        )
    assert captured.value.code == "structured_output_invalid"
    assert captured.value.__cause__ is None
    assert "SECRET_RAW_PROVIDER_OUTPUT" not in str(captured.value)
    assert len(responses.create_calls) == 1


def test_provider_error_retains_only_allowlisted_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BadRequestError(Exception):
        status_code = 400

    responses = _FakeResponses()
    responses.create_error = BadRequestError("SECRET_REQUEST_AND_RESPONSE")
    monkeypatch.setattr(
        invoker_module,
        "create_internal_route_chat_model",
        lambda **_kwargs: _FakeModel(responses),
    )

    with pytest.raises(DeckRepairInvocationError) as captured:
        asyncio.run(
            DeckRepairModelInvoker().invoke(
                plan=_plan(),
                messages=["PRIVATE_REPAIR_INPUT"],
                canary_user_id="synthetic-canary-user",
            )
        )
    error = captured.value
    assert error.code == "repair_unavailable"
    assert error.provider_error_type == "BadRequestError"
    assert error.provider_status_code == 400
    assert error.__cause__ is None
    assert "SECRET_REQUEST_AND_RESPONSE" not in str(error)
    assert len(responses.create_calls) == 1


def test_callback_overrides_are_removed_from_route_only_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    overrides = dict(_plan().model_overrides)
    overrides.update(
        {
            "callbacks": [object()],
            "tags": ["unsafe"],
            "metadata": {"unsafe": "raw"},
            "verbose": True,
        }
    )
    _result, _responses, captured = _invoke_with_fake(
        monkeypatch,
        plan=_plan(model_overrides=overrides),
    )

    assert not {"callbacks", "tags", "metadata", "verbose"} & captured["kwargs"].keys()


def test_safety_identifier_is_stable_pseudonymous_and_namespaced() -> None:
    value = repair_safety_identifier(canary_user_id="private-user-id")

    assert value == repair_safety_identifier(canary_user_id="private-user-id")
    assert value.startswith("dq2-")
    assert len(value) == 64
    assert "private-user-id" not in value
