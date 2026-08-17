#!/usr/bin/env python3
"""Offline validation for the authenticated FC-01A BASE-00 delta."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


REQUIRED_FILES = {
    "README.md",
    "source-head-revalidation.json",
    "provider-control-plane.json",
    "database-control-plane.json",
    "review-disposition.json",
    "secret-candidate-delta.json",
    "skip-audit.json",
    "limitations.md",
    "delta-manifest.json",
    "SHA256SUMS",
}
REQUIRED_JSON = {name for name in REQUIRED_FILES if name.endswith(".json")}

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


def walk_values(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from walk_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_values(child)
    else:
        yield value


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
        expected_coverage = files - {"SHA256SUMS"}
        if covered != expected_coverage:
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
    terminal_state = manifest.get("terminal_state") if isinstance(manifest, dict) else None
    unknown_count = sum(
        1 for value in parsed.values() for item in walk_values(value) if item == "UNKNOWN"
    )
    if terminal_state != "BLOCKED":
        errors.append("delta terminal state must remain BLOCKED")
    if unknown_count == 0:
        errors.append("blocked delta lacks an explicit UNKNOWN")

    source = parsed.get("source-head-revalidation.json")
    if not isinstance(source, dict) or source.get("frozen_heads_unchanged") is not True:
        errors.append("source heads were not revalidated unchanged")
    if isinstance(source, dict) and isinstance(manifest, dict):
        heads = source.get("frozen_heads", {})
        if not isinstance(heads, dict) or heads.get("main") != manifest.get("source_main"):
            errors.append("main source mismatch")
        if not isinstance(heads, dict) or heads.get("campaign") != manifest.get("source_campaign"):
            errors.append("campaign source mismatch")

    provider = parsed.get("provider-control-plane.json")
    if isinstance(provider, dict):
        render = provider.get("render", {})
        vercel = provider.get("vercel", {})
        if not isinstance(render, dict) or not isinstance(vercel, dict):
            errors.append("provider sections unavailable")
        else:
            for service in ("gateway", "langgraph", "voice"):
                record = render.get(service, {})
                if not isinstance(record, dict) or not record.get("current_deploy_id"):
                    errors.append(f"missing current Render deploy identity: {service}")
            rollback = render.get("rollback", {})
            if not isinstance(rollback, dict) or rollback.get("declared_rollback_selectable_in_ui") is not True:
                errors.append("declared Render rollback is not proven selectable")
            voice = render.get("voice", {})
            if not isinstance(voice, dict) or voice.get("source_matches_frozen_campaign") is not False:
                errors.append("Voice source divergence gate missing")
            current = vercel.get("current_production", {})
            prior = vercel.get("prior_production", {})
            if not isinstance(current, dict) or not current.get("deployment_id"):
                errors.append("current Vercel production identity missing")
            if not isinstance(prior, dict) or prior.get("instant_rollback_action_available") is not True:
                errors.append("prior Vercel rollback selectability missing")
    else:
        errors.append("provider evidence unavailable")

    database = parsed.get("database-control-plane.json")
    if isinstance(database, dict):
        ledger = database.get("migration_ledger", {})
        recovery = database.get("recovery", {})
        security = database.get("security_posture", {})
        effects = database.get("query_effects", {})
        if not isinstance(ledger, dict) or ledger.get("exact_live_applied_migration_bytes") != "UNKNOWN":
            errors.append("migration byte uncertainty missing")
        if not isinstance(recovery, dict) or recovery.get("point_in_time_recovery_enabled") is not False:
            errors.append("PITR disposition missing")
        if not isinstance(security, dict) or security.get("critical_rls_disabled_in_public_visible_at_least", 0) < 4:
            errors.append("critical RLS gate missing")
        if not isinstance(effects, dict) or effects.get("catalog_or_data_mutation") is not False:
            errors.append("database no-mutation assertion missing")
    else:
        errors.append("database evidence unavailable")

    review = parsed.get("review-disposition.json")
    if isinstance(review, dict):
        validation = review.get("source_validation", {})
        if not isinstance(validation, dict) or validation.get("current_actionable") != 10:
            errors.append("current review count mismatch")
        if not isinstance(validation, dict) or validation.get("current_actionable_p1") != 2:
            errors.append("current P1 count mismatch")
    else:
        errors.append("review evidence unavailable")

    secrets = parsed.get("secret-candidate-delta.json")
    if isinstance(secrets, dict):
        aggregate = secrets.get("aggregate", {})
        if not isinstance(aggregate, dict) or aggregate.get("confirmed_live_secret_records") != 0:
            errors.append("confirmed-live-secret count mismatch")
        if not isinstance(aggregate, dict) or aggregate.get("unresolved_candidate_records") != 10:
            errors.append("unresolved-secret count mismatch")
        if not isinstance(aggregate, dict) or aggregate.get("matched_values_recorded") is not False:
            errors.append("secret redaction assertion missing")
    else:
        errors.append("secret evidence unavailable")

    skips = parsed.get("skip-audit.json")
    if isinstance(skips, dict):
        totals = skips.get("totals", {})
        if not isinstance(totals, dict) or totals.get("release_critical_or_governed_reported_skips") != 73:
            errors.append("release-critical skip count mismatch")
        if not isinstance(totals, dict) or totals.get("release_critical_or_governed_logical_tests_not_run") != 91:
            errors.append("logical NOT_RUN count mismatch")
    else:
        errors.append("skip evidence unavailable")

    result = {
        "schema_version": 1,
        "evidence_directory": evidence.name,
        "structure": "PASS" if not missing and not any("invalid JSON" in error for error in errors) else "FAIL",
        "checksums": "PASS" if not checksum_errors else "FAIL",
        "privacy": "PASS" if not privacy_hits else "FAIL",
        "source_lock_consistency": "PASS" if not any("source mismatch" in error for error in errors) else "FAIL",
        "provider_identity_consistency": "PASS" if not any("provider" in error.lower() or "Render" in error or "Vercel" in error for error in errors) else "FAIL",
        "database_no_mutation_consistency": "PASS" if not any("database no-mutation" in error for error in errors) else "FAIL",
        "terminal_state": terminal_state,
        "hard_unknown_value_count": unknown_count,
        "terminal_consistency": "PASS" if not any("state" in error for error in errors) else "FAIL",
        "overall": "PASS" if not errors else "FAIL",
        "errors": errors,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
