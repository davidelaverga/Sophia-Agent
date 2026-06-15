from __future__ import annotations

from pathlib import Path

import yaml


def _service_env(service_name: str) -> dict[str, dict]:
    render_yaml = Path(__file__).resolve().parents[2] / "render.yaml"
    data = yaml.safe_load(render_yaml.read_text(encoding="utf-8"))
    for svc in data.get("services", []):
        if svc.get("name") == service_name:
            return {entry["key"]: entry for entry in svc.get("envVars", [])}
    raise AssertionError(f"service not found in render.yaml: {service_name}")


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
    assert (
        gateway["SUPABASE_BUILDER_BUCKET"]["value"]
        == langgraph["SUPABASE_BUILDER_BUCKET"]["value"]
    )
    # Builder must durably upload (not best-effort) in production so the
    # registry-backed gateway always has the bytes.
    assert langgraph["SOPHIA_ARTIFACT_REGISTRY_STORE"]["value"] == "supabase"


def test_langgraph_declares_openai_api_key_secret() -> None:
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
    assert "key: OPENAI_API_KEY" in joined
    assert "sync: false" in joined
