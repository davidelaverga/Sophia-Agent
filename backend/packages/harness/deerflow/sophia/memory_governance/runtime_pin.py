"""Allowlisted, content-free runtime diagnostics for MEM00 certification.

Run from /app/backend with ``uv run python -m
deerflow.sophia.memory_governance.runtime_pin``. Never replace this whitelist
with a prefix-filtered environment dump: the prefix includes credentials.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
from collections.abc import Mapping

from .mem0_projection_adapter import PINNED_MEM0_HOST

_FLAGS = (
    "CANDIDATE_LEDGER_READ",
    "CANDIDATE_LEDGER_WRITE",
    "CANONICAL_POOL_READ",
    "GOVERNED_RUNTIME_READ",
    "PROVIDER_PROJECTION",
    "FAULT_INJECTION",
    "LANGSMITH_EXPORT",
    "LEGACY_IMPORT",
    "LEGACY_INVENTORY",
)


def _fingerprint(value: str) -> str | None:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16] if value else None


def _flag(value: str) -> bool | str:
    normalized = value.strip().lower()
    if not normalized:
        return "unset"
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return "invalid"


def runtime_pin(environ: Mapping[str, str] | None = None) -> dict[str, object]:
    values = os.environ if environ is None else environ
    commit = values.get("RENDER_GIT_COMMIT", "")
    try:
        sdk = importlib.metadata.version("mem0ai")
    except importlib.metadata.PackageNotFoundError:
        sdk = "unavailable"
    if sdk != "unavailable" and not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", sdk):
        sdk = "unexpected_version_format"
    epoch = values.get("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH", "")
    return {
        "diagnostic_contract": "mem00.runtime-pin.v1",
        "commit": commit if re.fullmatch(r"[0-9a-f]{40}", commit) else ("invalid" if commit else None),
        "sdk": sdk,
        "endpoint_matches_pin": (values.get("MEM0_BASE_URL") or PINNED_MEM0_HOST).rstrip("/") == PINNED_MEM0_HOST,
        "credential_fingerprint": _fingerprint(values.get("MEM0_API_KEY", "").strip()),
        "reference_key_fingerprint": _fingerprint(values.get("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "")),
        "principal_fingerprint": _fingerprint(values.get("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "")),
        "cohort_fingerprint": _fingerprint(values.get("SOPHIA_MEMORY_COHORT_PRINCIPALS", "")),
        "provider_project_fingerprint": _fingerprint(values.get("MEM0_PROJECT_ID", "")),
        "provider_org_fingerprint": _fingerprint(values.get("MEM0_ORG_ID", "")),
        "provider_project_matches": values.get("MEM0_PROJECT_ID") == values.get("SOPHIA_MEMORY_PROVIDER_PROJECT") if values.get("MEM0_PROJECT_ID") else False,
        "supported_epoch": int(epoch) if re.fullmatch(r"[0-9]{1,9}", epoch) else None,
        "flags": {key: _flag(values.get("SOPHIA_MEMORY_" + key, "")) for key in _FLAGS},
    }


if __name__ == "__main__":
    print(json.dumps(runtime_pin(), sort_keys=True))
