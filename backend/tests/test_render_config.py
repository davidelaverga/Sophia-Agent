from __future__ import annotations

import json
from pathlib import Path

import yaml


def _service_env(service_name: str) -> dict[str, dict]:
    render_yaml = Path(__file__).resolve().parents[2] / "render.yaml"
    data = yaml.safe_load(render_yaml.read_text(encoding="utf-8"))
    for svc in data.get("services", []):
        if svc.get("name") == service_name:
            return {entry["key"]: entry for entry in svc.get("envVars", [])}
    raise AssertionError(f"service not found in render.yaml: {service_name}")


def test_production_dq1_is_exact_canary_shadow_with_no_delivery_authority() -> None:
    config_path = Path(__file__).resolve().parents[2] / "config.production.yaml"
    production = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    deck_quality = production["deck_quality"]

    assert deck_quality == {
        "enabled": True,
        "mode": "shadow",
        "scope": "canary",
        "canary_user_ids": "$SOPHIA_DECK_QUALITY_CANARY_USER_IDS",
        "judge_route": "deck.judge.visual",
        "rubric_version": "deck-rubric-v2",
        "judge_profile_version": "deck-visual-judge-v2",
        "evidence_preprocessor_version": "deck-evidence-v4",
        "judge_invoker_version": "deck-judge-invoker-v4",
        "allow_shared_provider_credential": True,
        "async_after_success": True,
        "mutate_artifact": False,
        "affect_delivery": False,
        "sample_rate": 0.0,
        "max_quality_calls": 2,
        "max_quality_cost_usd": 0.60,
        "max_quality_wall_clock_seconds": 300,
    }
    dq_deployment = next(model for model in production["models"] if model["name"] == "openai-gpt-5-6-sol")
    assert dq_deployment["access_scope"] == "route_only"


def test_production_dq2_authority_is_exact_canary_with_locked_mutation_foundation() -> None:
    config_path = Path(__file__).resolve().parents[2] / "config.production.yaml"
    production = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    foundation = production["build_foundation"]
    design_lift = production["deck_design_lift"]

    assert foundation == {
        "enabled": True,
        "manifest_mode": "canary_enforce",
        "enforce_canary_user_ids": "$SOPHIA_DECK_QUALITY_CANARY_USER_IDS",
        "enable_mutation_transactions": True,
    }
    assert design_lift["enabled"] is True
    assert design_lift["mode"] == "production_canary"
    assert design_lift["scope"] == "canary"
    assert design_lift["canary_user_ids"] == "$SOPHIA_DECK_QUALITY_CANARY_USER_IDS"
    assert design_lift["canary_user_ids"] == production["deck_quality"]["canary_user_ids"]
    assert design_lift["max_repairs"] == 1
    assert design_lift["max_judge_calls"] == 4
    assert design_lift["max_repair_calls"] == 1
    assert design_lift["max_campaign_cost_usd"] == 3.00
    assert design_lift["affect_delivery"] is False
    assert design_lift["promote_improved_candidate"] is True
    assert design_lift["require_manifest_enforce"] is True
    assert design_lift["require_mutation_transactions"] is True
    assert design_lift["require_mechanical_pass_before_commit"] is True
    assert design_lift["require_second_judge_approval"] is True
    assert design_lift["require_deterministic_improvement"] is True

    repair_route = production["model_routes"]["deck.repair.executor"]
    assert repair_route["fallbacks"] == []
    assert repair_route["max_failovers"] == 0
    assert repair_route["profile"] == "deck-repair-executor-v1"
    assert production["harness_profiles"]["deck-repair-executor-v1"]["max_retries"] == 0


def test_langgraph_exposes_dq2_only_through_the_private_http_app() -> None:
    langgraph_path = Path(__file__).resolve().parents[1] / "langgraph.json"
    config = json.loads(langgraph_path.read_text(encoding="utf-8"))
    graphs = config["graphs"]

    assert "sophia_deck_design_lift" not in graphs
    assert {
        "lead_agent",
        "sophia_companion",
        "sophia_builder",
        "sophia_deck_quality_shadow",
    }.issubset(graphs)
    assert "auth" not in config
    assert config["http"] == {
        "app": "deerflow.sophia.deck_design_lift.http_app:app",
        "configurable_headers": {"excludes": ["x-sophia-deck-lift-*"]},
        "logging_headers": {"excludes": ["x-sophia-deck-lift-*"]},
    }


def test_gateway_declares_artifact_registry_supabase_config() -> None:
    # Codex P1 PR #131: the gateway builds ArtifactRegistry() at router import
    # and FAIL-FASTS in a production runtime unless the store mode + bucket are
    # configured, so the blueprint must declare them or the gateway crashes
    # before /health can serve.
    env = _service_env("sophia-gateway")
    assert env["SOPHIA_ARTIFACT_REGISTRY_STORE"]["value"] == "supabase"
    assert env["SUPABASE_BUILDER_BUCKET"].get("value")
    assert "SUPABASE_URL" in env
    assert "SUPABASE_SERVICE_ROLE_KEY" in env


def test_langgraph_and_gateway_agree_on_artifact_bucket() -> None:
    # Builder uploads (langgraph) and registry reads (gateway) must target the
    # SAME bucket — otherwise the gateway cannot serve what the builder produced.
    gateway = _service_env("sophia-gateway")
    langgraph = _service_env("sophia-langgraph")
    assert gateway["SUPABASE_BUILDER_BUCKET"]["value"] == langgraph["SUPABASE_BUILDER_BUCKET"]["value"]
    # Builder must durably upload (not best-effort) in production so the
    # registry-backed gateway always has the bytes.
    assert langgraph["SOPHIA_ARTIFACT_REGISTRY_STORE"]["value"] == "supabase"


def test_langgraph_preserves_builder_and_adds_dq_scoped_openai_secrets() -> None:
    render_yaml = Path(__file__).resolve().parents[2] / "render.yaml"
    lines = render_yaml.read_text(encoding="utf-8").splitlines()

    in_langgraph = False
    langgraph_block: list[str] = []
    for line in lines:
        if line.startswith("  - type:") and in_langgraph:
            break
        if line.strip() == "name: sophia-langgraph":
            in_langgraph = True
        if in_langgraph:
            langgraph_block.append(line)

    joined = "\n".join(langgraph_block)
    assert "name: sophia-langgraph" in joined
    assert "key: SOPHIA_DECK_QUALITY_OPENAI_API_KEY" in joined
    assert "key: OPENAI_API_KEY" in joined
    assert "sync: false" in joined


def test_langgraph_preserves_builder_openai_fallback_and_gateway_does_not_declare_it() -> None:
    langgraph = _service_env("sophia-langgraph")
    gateway = _service_env("sophia-gateway")

    assert langgraph["SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED"]["value"] == "true"
    assert langgraph["SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL"]["value"] == "gpt-4.1"
    assert langgraph["SOPHIA_BUILDER_OPENAI_FALLBACK_TIMEOUT_SECONDS"]["value"] == "120"
    assert langgraph["SOPHIA_BUILDER_OPENAI_FALLBACK_MAX_RETRIES"]["value"] == "1"
    assert langgraph["SOPHIA_BUILDER_PRIMARY_COOLDOWN_SECONDS"]["value"] == "300"

    assert "SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED" not in gateway
    assert "SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL" not in gateway


def test_langgraph_declares_presentation_runtime_budget_only() -> None:
    langgraph = _service_env("sophia-langgraph")
    gateway = _service_env("sophia-gateway")
    expected = {
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_MAX_NON_ARTIFACT_TURNS": "12",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_FORCE_EMIT_REMAINING_TURNS": "2",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_SOFT_WARN_AT_TURN": "6",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_MAX_WALL_CLOCK_SECONDS": "1200",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_PREPARE_FORCE_AT_TURN": "2",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_PREPARE_FORCE_AFTER_SECONDS": "15",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_AUTHORING_DEADLINE_SECONDS": "720",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_PREFLIGHT_TIMEOUT_SECONDS": "15",
        "SOPHIA_BUILDER_PRESENTATION_AUTHORING_TIMEOUT_SECONDS": "360",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_AUTHORING_MAX_TOKENS": "16384",
        "SOPHIA_BUILDER_PRESENTATION_BUDGET_TERMINAL_RESERVE_SECONDS": "30",
    }
    for key, value in expected.items():
        assert langgraph[key]["value"] == value
        assert key not in gateway


def test_render_services_pin_the_same_supabase_project() -> None:
    gateway = _service_env("sophia-gateway")
    langgraph = _service_env("sophia-langgraph")
    expected = "vlxnwmyvhchwbousrdzc"

    assert gateway["SOPHIA_EXPECTED_SUPABASE_PROJECT_REF"]["value"] == expected
    assert langgraph["SOPHIA_EXPECTED_SUPABASE_PROJECT_REF"]["value"] == expected
