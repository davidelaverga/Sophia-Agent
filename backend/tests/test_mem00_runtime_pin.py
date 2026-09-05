"""Runtime certification must never dump prefix-matched environment values."""

import json

import pytest


def test_runtime_pin_denies_unknown_and_secret_environment_fields():
    from deerflow.sophia.memory_governance.runtime_pin import runtime_pin

    sentinel = "SYNTHETIC-SECRET-DO-NOT-EMIT"
    values = {
        "MEM0_API_KEY": sentinel,
        "SOPHIA_MEMORY_REFERENCE_HMAC_SECRET": sentinel,
        "SOPHIA_MEMORY_FUTURE_SECRET": sentinel,
        "SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL": sentinel,
        "SOPHIA_MEMORY_COHORT_PRINCIPALS": sentinel,
        "SOPHIA_MEMORY_PROVIDER_PROJECT": sentinel,
        "SOPHIA_MEMORY_GOVERNED_RUNTIME_READ": sentinel,
    }
    result = runtime_pin(values)
    assert sentinel not in json.dumps(result)
    assert "SOPHIA_MEMORY_FUTURE_SECRET" not in json.dumps(result)
    assert result["flags"]["GOVERNED_RUNTIME_READ"] == "invalid"
    assert result["credential_fingerprint"].startswith("sha256:")
    assert result["reference_key_fingerprint"].startswith("sha256:")


@pytest.mark.parametrize("value,expected", [("false", False), ("true", True), ("", "unset")])
def test_runtime_pin_reports_typed_allowlisted_flags(value, expected):
    from deerflow.sophia.memory_governance.runtime_pin import runtime_pin

    result = runtime_pin({"SOPHIA_MEMORY_CANONICAL_POOL_READ": value})
    assert result["flags"]["CANONICAL_POOL_READ"] == expected
    assert result["credential_fingerprint"] is None
    assert result["commit"] is None


def test_runtime_pin_never_echoes_malformed_commit_or_provider_setting():
    from deerflow.sophia.memory_governance.runtime_pin import runtime_pin

    result = runtime_pin({"RENDER_GIT_COMMIT": "SYNTHETIC-SECRET", "MEM0_BASE_URL": "SYNTHETIC-SECRET"})
    assert "SYNTHETIC-SECRET" not in json.dumps(result)
    assert result["commit"] == "invalid"
    assert result["endpoint_matches_pin"] is False
