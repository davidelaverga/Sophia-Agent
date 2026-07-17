from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.gateway.routers import models as models_router
from deerflow.agents.lead_agent import agent as lead_agent_module
from deerflow.config.app_config import AppConfig
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.config.model_config import ModelConfig
from deerflow.config.model_route_config import HarnessProfileConfig, ModelRouteConfig
from deerflow.config.sandbox_config import SandboxConfig
from deerflow.models import factory
from deerflow.models.route_resolver import ModelRouteResolver
from deerflow.sophia.deck_quality import invoker as invoker_module


def _config() -> AppConfig:
    return AppConfig(
        models=[
            ModelConfig(
                name="public-haiku",
                display_name="Public Haiku",
                use="test:PublicModel",
                model="public-haiku-provider-model",
            ),
            ModelConfig(
                name="openai-gpt-5-6-sol",
                display_name="Internal DQ judge",
                use="langchain_openai:ChatOpenAI",
                model="gpt-5.6-sol",
                access_scope="route_only",
                provider="openai",
                supports_vision=True,
                supports_reasoning_effort=True,
                capabilities={
                    "image_input",
                    "multi_image_input",
                    "strict_structured_output",
                    "reasoning_effort",
                },
            ),
        ],
        model_routes={
            "deck.judge.visual": ModelRouteConfig(
                primary="openai-gpt-5-6-sol",
                profile="deck-visual-judge-v2",
                required_capabilities={
                    "image_input",
                    "multi_image_input",
                    "strict_structured_output",
                    "reasoning_effort",
                },
                max_failovers=0,
            )
        },
        harness_profiles={
            "deck-visual-judge-v2": HarnessProfileConfig(
                version="v2",
                timeout_seconds=180,
                max_retries=0,
                model_overrides={
                    "reasoning": {
                        "effort": "high",
                        "mode": "standard",
                        "context": "current_turn",
                    },
                    "output_version": "responses/v1",
                    "use_responses_api": True,
                    "store": False,
                    "max_completion_tokens": 6000,
                },
            )
        },
        deck_quality=DeckQualityConfig(
            enabled=True,
            mode="shadow",
            canary_user_ids={"canary-user"},
            max_quality_cost_usd="0.60",
        ),
        sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )


def test_route_only_deployment_is_absent_from_public_config_and_model_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config()
    monkeypatch.setattr(models_router, "get_app_config", lambda: config)

    assert [model.name for model in config.public_models] == ["public-haiku"]
    assert config.get_model_config("openai-gpt-5-6-sol") is None
    assert config.get_model_deployment("openai-gpt-5-6-sol") is not None
    response = asyncio.run(models_router.list_models())
    assert [model.name for model in response.models] == ["public-haiku"]
    with pytest.raises(HTTPException) as error:
        asyncio.run(models_router.get_model("openai-gpt-5-6-sol"))
    assert error.value.status_code == 404


def test_generic_factory_and_lead_agent_cannot_select_route_only_deployment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config()
    monkeypatch.setattr(factory, "get_app_config", lambda: config)
    monkeypatch.setattr(lead_agent_module, "get_app_config", lambda: config)

    with pytest.raises(ValueError, match="not found in config"):
        factory.create_chat_model("openai-gpt-5-6-sol")
    assert lead_agent_module._resolve_model_name("openai-gpt-5-6-sol") == (
        "public-haiku"
    )
    with pytest.raises(ValueError, match="No chat model could be resolved"):
        lead_agent_module.make_lead_agent(
            {"configurable": {"model_name": "openai-gpt-5-6-sol"}}
        )


def test_only_sealed_exact_route_plan_can_instantiate_route_only_deployment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config()
    plan = ModelRouteResolver(config).resolve(route_name="deck.judge.visual")
    captured: dict[str, object] = {}
    sentinel = object()

    def create_configured(**kwargs):
        captured.update(kwargs)
        return sentinel

    monkeypatch.setattr(factory, "get_app_config", lambda: config)
    monkeypatch.setattr(factory, "_create_configured_chat_model", create_configured)

    forged = factory.InternalModelRouteCapability(
        purpose="deck_quality_judge",
        route_name=plan.route_name,
        deployment_name=plan.deployment_name,
        plan_hash=plan.plan_hash,
        _seal=object(),
    )
    with pytest.raises(ValueError, match="capability is invalid"):
        factory.create_internal_route_chat_model(plan=plan, capability=forged)

    capability = factory._issue_internal_model_route_capability(
        plan,
        purpose="deck_quality_judge",
    )
    assert (
        factory.create_internal_route_chat_model(
            plan=plan,
            capability=capability,
            attach_tracing=False,
        )
        is sentinel
    )
    model_config = captured["model_config"]
    assert isinstance(model_config, ModelConfig)
    assert model_config.access_scope == "route_only"
    assert captured["kwargs"] == {}


def test_dq_invoker_mints_internal_capability_only_after_exact_canary_admission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config()
    plan = ModelRouteResolver(config).resolve(route_name="deck.judge.visual")
    monkeypatch.setattr(invoker_module, "get_app_config", lambda: config)

    capability = (
        invoker_module.MultimodalStructuredModelInvoker._admitted_route_capability(
            plan=plan,
            campaign_id="DQ-1",
            canary_user_id="canary-user",
        )
    )
    assert capability.deployment_name == "openai-gpt-5-6-sol"
    with pytest.raises(TypeError):
        invoker_module.MultimodalStructuredModelInvoker._admitted_route_capability(
            plan=plan,
            campaign_id="DQ-1",
            canary_user_id="ordinary-user",
        )
    with pytest.raises(TypeError):
        invoker_module.MultimodalStructuredModelInvoker._admitted_route_capability(
            plan=plan,
            campaign_id="other-campaign",
            canary_user_id="canary-user",
        )
