from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from deerflow.config.app_config import AppConfig
from deerflow.sophia.build_runtime.events import configure_default_event_sink
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.build_foundation_store import BuildFoundationStoreConfig, configured_build_foundation_store


class BuildFoundationStartupError(RuntimeError):
    pass


def audit_build_foundation(*, tools: Iterable[Any], config: AppConfig) -> None:
    foundation = config.build_foundation
    if not foundation.enabled:
        return
    prepare = next((tool for tool in tools if getattr(tool, "name", None) == "prepare_deck_build"), None)
    if prepare is not None:
        injected = set(getattr(prepare, "_injected_args_keys", frozenset()))
        if injected != {"runtime"}:
            raise BuildFoundationStartupError(
                f"prepare_deck_build runtime injection invariant failed: {sorted(injected)}"
            )
        schema = prepare.get_input_schema().model_json_schema()
        if "runtime" in (schema.get("properties") or {}):
            raise BuildFoundationStartupError("prepare_deck_build exposes runtime in model-facing schema")
    if foundation.manifest_mode == "enforce":
        if BuildFoundationStoreConfig.from_env() is None:
            raise BuildFoundationStartupError("manifest enforcement requires Supabase Postgres RPC configuration")
        if not supabase_artifact_store.is_configured():
            raise BuildFoundationStartupError("manifest enforcement requires durable object storage")
    if foundation.persist_event_journal:
        configure_default_event_sink(configured_build_foundation_store())
    enabled_routes = {
        name: route
        for name, route in config.model_routes.items()
        if name in {"deck.judge.visual", "deck.finding.localizer", "deck.repair.executor", "deck.repair.advisor"}
    }
    for route_name, route in enabled_routes.items():
        if config.get_model_config(route.primary) is None:
            raise BuildFoundationStartupError(f"model route {route_name} references missing deployment {route.primary}")
        if route.profile not in config.harness_profiles:
            raise BuildFoundationStartupError(f"model route {route_name} references missing profile {route.profile}")
