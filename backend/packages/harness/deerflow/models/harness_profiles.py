from __future__ import annotations

from typing import Any

from deerflow.config.model_route_config import HarnessProfileConfig


def request_overrides(profile: HarnessProfileConfig, runtime_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    overrides = dict(profile.model_overrides)
    if runtime_overrides:
        overrides.update(runtime_overrides)
    overrides.setdefault("timeout", profile.timeout_seconds)
    overrides.setdefault("max_retries", profile.max_retries)
    return overrides
