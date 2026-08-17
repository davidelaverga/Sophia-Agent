#!/usr/bin/env python3
"""Offline validation for the FC-01A authority and approval intake delta."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


REQUIRED_FILES = {
    "README.md",
    "authority-resolution.json",
    "human-approval-intake.json",
    "state-revalidation.json",
    "gate-assessment.json",
    "authority-decision-request.json",
    "limitations.md",
    "delta-manifest.json",
    "SHA256SUMS",
}
REQUIRED_JSON = {name for name in REQUIRED_FILES if name.endswith(".json")}
EXPECTED_STRATEGY_SHA256 = "8574f7b67834db546339df3f4e06209d4fc06125f8899ae5a1b6a316eaa9f190"
EXPECTED_AUTHORITY_LOCK_SHA256 = "ece6b521def1712bcfcec9c74fbed50281e610d312d09aef9dc2017768935"
EXPECTED_BUDGET_SHA256 = "c73686a9ef2448a33e487be547c9cd0367bbd059f5ee440d5104b0c4c760d3db"
EXPECTED_MAIN = "b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7"
EXPECTED_CAMPAIGN = "9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca"

DENY_PATTERNS = {
    "private_key": re.compile(rb"BEGIN (?:RSA |EC |OPENSSH )?PRIVATE" + rb" KEY"),
    "bearer_token": re.compile(rb"Bearer\s+[A-Za-z0-9._~+/=-]{16,}", re.I),
    "openai_style_key": re.compile(rb"s" + rb"k-[A-Za-z0-9_-]{20,}"),
    "github_token": re.compile(rb"gh[pousr]_[A-Za-z0-9]{20,}"),
    "aws_access_key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "jwt": re.compile(rb"eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}"),
    "database_uri": re.compile(rb"(?:postgres" + rb"ql|postgres|mysql|mongodb(?:\+srv)?)://", re.I),
    "signed_url": re.compile(rb"(?:X-Amz-Signature|X-Goog-Signature|Signature|token)=[A-Za-z0-9%_-]{12,}", re.I),
    "local_user_path": re.compile(rb"/Us" + rb"ers/[A-Za-z0-9._-]+/"),
    "email_address": re.compile(rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    evidence = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors: list[str] = []
    files = {path.name for path in evidence.iterdir() if path.is_file()}
    missing = sorted(REQUIRED_FILES - files)
    if missing:
        errors.append("missing required files: " + ", ".join(missing))

    parsed: dict[str, object] = {}
    for name in sorted(REQUIRED_JSON & files):
        try:
            parsed[name] = json.loads((evidence / name).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"invalid JSON {name}: {exc}")

    checksum_errors: list[str] = []
    covered: set[str] = set()
    checksum_path = evidence / "SHA256SUMS"
    if checksum_path.exists():
        for number, line in enumerate(checksum_path.read_text(encoding="utf-8").splitlines(), 1):
            match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
            if not match:
                checksum_errors.append(f"malformed checksum line {number}")
                continue
            expected, name = match.groups()
            target = evidence / name
            if not target.is_file():
                checksum_errors.append(f"checksum target missing: {name}")
                continue
            covered.add(name)
            if digest(target) != expected:
                checksum_errors.append(f"checksum mismatch: {name}")
        if covered != files - {"SHA256SUMS"}:
            checksum_errors.append("checksum coverage mismatch")
    else:
        checksum_errors.append("SHA256SUMS missing")
    errors.extend(checksum_errors)

    privacy_hits: list[str] = []
    for path in sorted(item for item in evidence.iterdir() if item.is_file()):
        data = path.read_bytes()
        for label, pattern in DENY_PATTERNS.items():
            if pattern.search(data):
                privacy_hits.append(f"{path.name}:{label}")
    if privacy_hits:
        errors.append("privacy pattern hits: " + ", ".join(privacy_hits))

    manifest = parsed.get("delta-manifest.json")
    if not isinstance(manifest, dict) or manifest.get("terminal_state") != "BLOCKED":
        errors.append("terminal state must remain BLOCKED")
    if isinstance(manifest, dict):
        if manifest.get("source_main") != EXPECTED_MAIN or manifest.get("source_campaign") != EXPECTED_CAMPAIGN:
            errors.append("manifest source lock mismatch")
        for field in (
            "joint_checksum_bound_signature_present",
            "baseline_transition_authorized",
            "m00_execution_authorized",
            "production_mutation_authorized",
            "product_files_changed",
            "production_mutation",
            "provider_setting_mutation",
            "database_catalog_or_data_mutation",
            "raw_sensitive_evidence_committed",
        ):
            if manifest.get(field) is not False:
                errors.append(f"manifest false assertion missing: {field}")

    authority = parsed.get("authority-resolution.json")
    if not isinstance(authority, dict):
        errors.append("authority resolution unavailable")
    else:
        lock = authority.get("authority_lock", {})
        resolved = authority.get("resolved_input", {})
        if not isinstance(lock, dict) or lock.get("authority_lock_sha256") != EXPECTED_AUTHORITY_LOCK_SHA256:
            errors.append("authority-lock digest mismatch")
        if not isinstance(resolved, dict) or resolved.get("locked_sha256") != EXPECTED_STRATEGY_SHA256:
            errors.append("locked strategy digest mismatch")
        if not isinstance(resolved, dict) or resolved.get("observed_sha256") != EXPECTED_STRATEGY_SHA256:
            errors.append("observed strategy digest mismatch")
        if not isinstance(resolved, dict) or resolved.get("digest_match") is not True:
            errors.append("strategy digest match missing")

    approval = parsed.get("human-approval-intake.json")
    if not isinstance(approval, dict):
        errors.append("human approval intake unavailable")
    else:
        binding = approval.get("required_checksum_binding", {})
        assurance = approval.get("identity_and_decision_assurance", {})
        disposition = approval.get("approval_disposition", {})
        if not isinstance(binding, dict) or binding.get("acceptance_budget_sha256") != EXPECTED_BUDGET_SHA256:
            errors.append("acceptance-budget digest mismatch")
        if not isinstance(assurance, dict) or assurance.get("impersonation_performed") is not False:
            errors.append("non-impersonation assertion missing")
        if not isinstance(disposition, dict) or disposition.get("joint_signature_valid") is not False:
            errors.append("joint signature must remain invalid")
        if not isinstance(disposition, dict) or disposition.get("execution_authorized") is not False:
            errors.append("execution must remain unauthorized")

    state = parsed.get("state-revalidation.json")
    if not isinstance(state, dict):
        errors.append("state revalidation unavailable")
    else:
        git = state.get("git", {})
        review = state.get("pull_request_144", {})
        if not isinstance(git, dict) or git.get("main") != EXPECTED_MAIN or git.get("campaign") != EXPECTED_CAMPAIGN:
            errors.append("revalidated source lock mismatch")
        if not isinstance(git, dict) or git.get("frozen_heads_unchanged") is not True:
            errors.append("frozen-head assertion missing")
        if not isinstance(review, dict) or review.get("source_valid_actionable_p1") != 2:
            errors.append("actionable P1 count mismatch")
        if not isinstance(review, dict) or review.get("source_valid_actionable_p2") != 8:
            errors.append("actionable P2 count mismatch")
        if state.get("target_or_blocker_drift_detected") is not False:
            errors.append("unexpected drift disposition")

    gate = parsed.get("gate-assessment.json")
    hard_unknown_count = None
    if not isinstance(gate, dict):
        errors.append("gate assessment unavailable")
    else:
        hard_unknown_count = gate.get("hard_unknown_path_count")
        blockers = gate.get("blockers", {})
        result = gate.get("result", {})
        if hard_unknown_count != 16 or len(gate.get("hard_unknown_paths", [])) != 16:
            errors.append("hard UNKNOWN count mismatch")
        if not isinstance(blockers, dict) or blockers.get("tests", {}).get("release_critical_or_governed_logical_not_run") != 91:
            errors.append("release-critical NOT_RUN count mismatch")
        if not isinstance(result, dict) or result.get("g0") != "FAIL" or result.get("terminal_state") != "BLOCKED":
            errors.append("G0 blocked result mismatch")
        if not isinstance(result, dict) or result.get("hard_gate_override_available_under_fc01") is not False:
            errors.append("hard-gate override assertion missing")

    request = parsed.get("authority-decision-request.json")
    if not isinstance(request, dict):
        errors.append("authority decision request unavailable")
    else:
        if request.get("hard_gate_override_available_under_current_fc01") is not False:
            errors.append("decision request improperly exposes a hard-gate override")
        if request.get("m00_may_begin_now") is not False or request.get("production_mutation_may_begin_now") is not False:
            errors.append("decision request improperly authorizes execution")

    result = {
        "schema_version": 1,
        "evidence_directory": evidence.name,
        "structure": "PASS" if not missing and not any("invalid JSON" in error for error in errors) else "FAIL",
        "checksums": "PASS" if not checksum_errors else "FAIL",
        "privacy": "PASS" if not privacy_hits else "FAIL",
        "authority_consistency": "PASS" if not any("authority" in error.lower() or "strategy" in error.lower() for error in errors) else "FAIL",
        "signature_non_impersonation": "PASS" if not any("signature" in error.lower() or "impersonation" in error.lower() for error in errors) else "FAIL",
        "source_lock_consistency": "PASS" if not any("source lock" in error.lower() or "frozen-head" in error.lower() for error in errors) else "FAIL",
        "terminal_state": manifest.get("terminal_state") if isinstance(manifest, dict) else None,
        "hard_unknown_path_count": hard_unknown_count,
        "terminal_consistency": "PASS" if not any("terminal" in error.lower() or "G0" in error for error in errors) else "FAIL",
        "overall": "PASS" if not errors else "FAIL",
        "result_label": "PASS_BLOCKED_CONSISTENT" if not errors else "FAIL",
        "errors": errors,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
