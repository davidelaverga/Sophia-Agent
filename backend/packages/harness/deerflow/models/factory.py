import logging
from dataclasses import dataclass, field
from typing import Literal

from langchain.chat_models import BaseChatModel

from deerflow.config import get_app_config, get_tracing_config, is_tracing_enabled
from deerflow.config.model_config import ModelConfig
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.route_resolver import ModelRouteResolver
from deerflow.reflection import resolve_class

logger = logging.getLogger(__name__)
_INTERNAL_ROUTE_CAPABILITY_SEAL = object()
_InternalModelRoutePurpose = Literal[
    "deck_quality_judge",
    "deck_design_lift_repair",
]
_INTERNAL_ROUTE_ADMISSIONS: dict[_InternalModelRoutePurpose, tuple[str, str]] = {
    "deck_quality_judge": ("deck.judge.visual", "openai-gpt-5-6-sol"),
    "deck_design_lift_repair": ("deck.repair.executor", "openai-gpt-5-6-sol"),
}


@dataclass(frozen=True, slots=True)
class InternalModelRouteCapability:
    """Non-serializable authority for one exact internal route plan."""

    purpose: _InternalModelRoutePurpose
    route_name: str
    deployment_name: str
    plan_hash: str
    _seal: object = field(repr=False, compare=False)


def _issue_internal_model_route_capability(
    plan: ResolvedModelPlan,
    *,
    purpose: _InternalModelRoutePurpose,
) -> InternalModelRouteCapability:
    """Mint route-only authority inside an already-admitted internal path."""

    if _INTERNAL_ROUTE_ADMISSIONS.get(purpose) != (
        plan.route_name,
        plan.deployment_name,
    ):
        raise ValueError("internal model route capability is not admissible")
    return InternalModelRouteCapability(
        purpose=purpose,
        route_name=plan.route_name,
        deployment_name=plan.deployment_name,
        plan_hash=plan.plan_hash,
        _seal=_INTERNAL_ROUTE_CAPABILITY_SEAL,
    )


def _create_configured_chat_model(
    *,
    name: str,
    model_config: ModelConfig,
    thinking_enabled: bool,
    attach_tracing: bool,
    kwargs: dict,
) -> BaseChatModel:
    """Instantiate one already-authorized deployment without widening access."""

    model_class = resolve_class(model_config.use, BaseChatModel)
    model_settings_from_config = model_config.model_dump(
        exclude_none=True,
        exclude={
            "use",
            "name",
            "display_name",
            "description",
            "access_scope",
            "supports_thinking",
            "supports_reasoning_effort",
            "when_thinking_enabled",
            "thinking",
            "supports_vision",
            "provider",
            "capabilities",
        },
    )
    # Compute effective when_thinking_enabled by merging in the `thinking` shortcut field.
    # The `thinking` shortcut is equivalent to setting when_thinking_enabled["thinking"].
    has_thinking_settings = (model_config.when_thinking_enabled is not None) or (model_config.thinking is not None)
    effective_wte: dict = dict(model_config.when_thinking_enabled) if model_config.when_thinking_enabled else {}
    if model_config.thinking is not None:
        merged_thinking = {
            **(effective_wte.get("thinking") or {}),
            **model_config.thinking,
        }
        effective_wte = {**effective_wte, "thinking": merged_thinking}
    if thinking_enabled and has_thinking_settings:
        if not model_config.supports_thinking:
            raise ValueError(f"Model {name} does not support thinking. Set `supports_thinking` to true in the `config.yaml` to enable thinking.") from None
        if effective_wte:
            model_settings_from_config.update(effective_wte)
    if not thinking_enabled and has_thinking_settings:
        if effective_wte.get("extra_body", {}).get("thinking", {}).get("type"):
            # OpenAI-compatible gateway: thinking is nested under extra_body
            kwargs.update({"extra_body": {"thinking": {"type": "disabled"}}})
            kwargs.update({"reasoning_effort": "minimal"})
        elif effective_wte.get("thinking", {}).get("type"):
            # Native langchain_anthropic: thinking is a direct constructor parameter
            kwargs.update({"thinking": {"type": "disabled"}})
    if not model_config.supports_reasoning_effort and "reasoning_effort" in kwargs:
        del kwargs["reasoning_effort"]

    model_instance = model_class(**kwargs, **model_settings_from_config)

    if attach_tracing and is_tracing_enabled():
        try:
            from langchain_core.tracers.langchain import LangChainTracer

            tracing_config = get_tracing_config()
            tracer = LangChainTracer(
                project_name=tracing_config.project,
            )
            existing_callbacks = model_instance.callbacks or []
            model_instance.callbacks = [*existing_callbacks, tracer]
            logger.debug(
                "LangSmith tracing attached to model '%s' (project='%s')",
                name,
                tracing_config.project,
            )
        except Exception as error:
            logger.warning("Failed to attach LangSmith tracing to model '%s': %s", name, error)
    return model_instance


def create_chat_model(
    name: str | None = None,
    thinking_enabled: bool = False,
    *,
    attach_tracing: bool = True,
    **kwargs,
) -> BaseChatModel:
    """Create a publicly selectable chat model from the config.

    ``route_only`` deployments are intentionally indistinguishable from a
    missing name on this generic/user-controlled surface.
    """

    config = get_app_config()
    if name is None:
        public_models = config.public_models
        if not public_models:
            raise ValueError("No public chat models are configured")
        name = public_models[0].name
    model_config = config.get_model_config(name)
    if model_config is None:
        raise ValueError(f"Model {name} not found in config") from None
    return _create_configured_chat_model(
        name=name,
        model_config=model_config,
        thinking_enabled=thinking_enabled,
        attach_tracing=attach_tracing,
        kwargs=kwargs,
    )


def create_internal_route_chat_model(
    *,
    plan: ResolvedModelPlan,
    capability: InternalModelRouteCapability,
    thinking_enabled: bool = False,
    attach_tracing: bool = True,
    **kwargs,
) -> BaseChatModel:
    """Instantiate a route-only deployment from one sealed exact plan.

    This function is intentionally absent from ``deerflow.models`` public
    exports. The generic factory never accepts a capability or route-only name.
    """

    if (
        not isinstance(capability, InternalModelRouteCapability)
        or capability._seal is not _INTERNAL_ROUTE_CAPABILITY_SEAL
        or _INTERNAL_ROUTE_ADMISSIONS.get(capability.purpose)
        != (
            capability.route_name,
            capability.deployment_name,
        )
        or capability.route_name != plan.route_name
        or capability.deployment_name != plan.deployment_name
        or capability.plan_hash != plan.plan_hash
    ):
        raise ValueError("internal model route capability is invalid")

    config = get_app_config()
    expected_plan = ModelRouteResolver(config).resolve(route_name=plan.route_name)
    if expected_plan != plan:
        raise ValueError("internal model route plan does not match configuration")
    model_config = config.get_model_deployment(plan.deployment_name)
    if model_config is None or model_config.access_scope != "route_only":
        raise ValueError("internal model route deployment is not route-only")
    return _create_configured_chat_model(
        name=plan.deployment_name,
        model_config=model_config,
        thinking_enabled=thinking_enabled,
        attach_tracing=attach_tracing,
        kwargs=kwargs,
    )
