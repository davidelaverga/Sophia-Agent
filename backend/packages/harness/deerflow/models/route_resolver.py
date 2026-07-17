from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from deerflow.config.app_config import AppConfig
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.harness_profiles import request_overrides


class ModelRouteResolutionError(ValueError):
    pass


def _provider_from_use(use: str) -> str:
    lowered = use.casefold()
    if "anthropic" in lowered:
        return "anthropic"
    if "openai" in lowered:
        return "openai"
    if "google" in lowered or "gemini" in lowered:
        return "google"
    return use.split(":", 1)[0].split(".", 1)[0]


class ModelRouteResolver:
    def __init__(self, config: AppConfig) -> None:
        self._config = config

    def resolve(
        self,
        *,
        route_name: str,
        required_capabilities: frozenset[str] = frozenset(),
        runtime_overrides: Mapping[str, Any] | None = None,
    ) -> ResolvedModelPlan:
        route = self._config.model_routes.get(route_name)
        if route is None:
            raise ModelRouteResolutionError(f"model route not configured: {route_name}")
        deployment = self._config.get_model_deployment(route.primary)
        if deployment is None:
            raise ModelRouteResolutionError(f"model deployment not configured: {route.primary}")
        profile = self._config.harness_profiles.get(route.profile)
        if profile is None:
            raise ModelRouteResolutionError(f"harness profile not configured: {route.profile}")
        required = frozenset(route.required_capabilities) | required_capabilities
        missing = sorted(required - deployment.capabilities)
        if missing:
            raise ModelRouteResolutionError(f"deployment {deployment.name} lacks capabilities: {', '.join(missing)}")
        inferred_provider = _provider_from_use(deployment.use)
        provider = deployment.provider or inferred_provider
        if deployment.provider and deployment.provider.casefold() != inferred_provider.casefold():
            raise ModelRouteResolutionError(
                f"deployment {deployment.name} provider {deployment.provider} conflicts with {deployment.use}"
            )
        overrides = request_overrides(profile, dict(runtime_overrides or {}))
        basis = {
            "route_name": route_name,
            "deployment_name": deployment.name,
            "provider": provider,
            "provider_model": deployment.model,
            "profile_name": route.profile,
            "profile_version": profile.version,
            "capabilities": sorted(deployment.capabilities),
            "model_overrides": overrides,
            "policy_version": "sophia-model-route/v1",
        }
        plan_hash = hashlib.sha256(json.dumps(basis, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return ResolvedModelPlan(**basis, plan_hash=plan_hash)
