#!/usr/bin/env python3
"""Offline structural, checksum, privacy, and terminal-state validation.

This evaluator performs no network calls. It deliberately permits hard
UNKNOWN values only when the manifest terminal state is BLOCKED; it never turns
missing evidence into a green result.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


REQUIRED_FILES = {
    "README.md",
    "authority-lock.json",
    "source-lock.json",
    "provider-baseline.json",
    "migration-baseline.json",
    "baseline-test-classification.json",
    "acceptance-budget.json",
    "m00-execution-proposal.json",
    "browser-summary.json",
    "conflict-review-inventory.json",
    "privacy-scan.json",
    "limitations.md",
    "campaign-manifest.json",
    "SHA256SUMS",
}

REQUIRED_JSON = {name for name in REQUIRED_FILES if name.endswith(".json")}

# Split sensitive literals so this source can itself be privacy-scanned.
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
    files = {p.name for p in evidence.iterdir() if p.is_file()}
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
    checksum_path = evidence / "SHA256SUMS"
    covered: set[str] = set()
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
            actual = digest(target)
            if actual != expected:
                checksum_errors.append(f"checksum mismatch: {name}")
        expected_coverage = files - {"SHA256SUMS"}
        if covered != expected_coverage:
            checksum_errors.append(
                "checksum coverage mismatch: expected "
                + ",".join(sorted(expected_coverage))
                + " got "
                + ",".join(sorted(covered))
            )
    else:
        checksum_errors.append("SHA256SUMS missing")
    errors.extend(checksum_errors)

    privacy_hits: list[str] = []
    for path in sorted(p for p in evidence.iterdir() if p.is_file()):
        data = path.read_bytes()
        for label, pattern in DENY_PATTERNS.items():
            if pattern.search(data):
                privacy_hits.append(f"{path.name}:{label}")
    if privacy_hits:
        errors.append("privacy pattern hits: " + ", ".join(privacy_hits))

    manifest = parsed.get("campaign-manifest.json")
    terminal_state = manifest.get("terminal_state") if isinstance(manifest, dict) else None
    unknown_count = 0
    for value in parsed.values():
        unknown_count += sum(1 for item in walk_values(value) if item == "UNKNOWN")
    if terminal_state not in {"BLOCKED", "BASELINE_READY_FOR_APPROVAL"}:
        errors.append("invalid terminal state")
    if terminal_state == "BASELINE_READY_FOR_APPROVAL" and unknown_count:
        errors.append("ready state contains hard UNKNOWN values")
    if terminal_state == "BLOCKED" and unknown_count == 0:
        errors.append("blocked state lacks an explicit UNKNOWN")

    result = {
        "schema_version": 1,
        "evidence_directory": evidence.name,
        "structure": "PASS" if not missing and not any("invalid JSON" in e for e in errors) else "FAIL",
        "checksums": "PASS" if not checksum_errors else "FAIL",
        "privacy": "PASS" if not privacy_hits else "FAIL",
        "terminal_state": terminal_state,
        "hard_unknown_value_count": unknown_count,
        "terminal_consistency": "PASS" if not any("state" in e for e in errors) else "FAIL",
        "overall": "PASS" if not errors else "FAIL",
        "errors": errors,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
