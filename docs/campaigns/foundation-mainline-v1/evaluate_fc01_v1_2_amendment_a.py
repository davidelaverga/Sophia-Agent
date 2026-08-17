#!/usr/bin/env python3
"""Offline structural and Git-seal evaluator for FC-01 v1.2 Amendment A.

This evaluator proves only that the governance payload is internally
consistent and, after the second commit, sealed.  It never authorizes repair
execution or any external mutation.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

UTC = getattr(dt, "UTC", dt.timezone.utc)  # noqa: UP017 - Python 3.9 compatibility

AMENDMENT_ID = "FC-01-v1.2-AMENDMENT-A"
CONTROL_BRANCH = "campaign/fc01-control-v1"
PREDECESSOR = "6c2ca09280cd425d431df41040555caadcdde520"
MAIN = "b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7"
MAIN_TREE = "d859ff917a5f82e66423ebabaeea1be9b74cddb6"
CAMPAIGN = "9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca"
CAMPAIGN_TREE = "8c27bc52b2a022d4a0b7c398172195442bccf15e"
FC01_SHA256 = "60f52624e2da08e6f116c8d1d7ae6c92bed94fc571a658a8b71b7044a3b6536c"
STRATEGY_SHA256 = "8574f7b67834db546339df3f4e06209d4fc06125f8899ae5a1b6a316eaa9f190"
AUTHORITY_LOCK_SHA256 = "ece6b521def1712bcfcec9c74fbed50281e610d312d09aef9dc67e099dde6c38"
MALFORMED_AUTHORITY_VALUE = "ece6b521def1712bcfcec9c74fbed50281e610d312d09aef9dc2017768935"
BLOCKER_ID_SET_SHA256 = "6c147352fd040bf6c6ffbd8c8d7eb9af6fd6fd6e31ee5689fa5892cc8f597953"
RELATION_CONTRACT_SHA256 = "80dafb1879351ea4a4fb151afb3bcef5df6b566cf1a068e091f94261009c1701"
ACTIVE_RPC_SET_SHA256 = "24b59d66ad7f237357b435843949cc7002b28106b81ff4c1ddc785129e6d65f5"
LEGACY_RPC_SET_SHA256 = "dafc4e6ca0bf7869eb0bb1718a712c6f0219cf9feb09e76b09752e057df66a02"
HELPER_RPC_SET_SHA256 = "ad67e9ff5aaa5aba32098d96a3c55d6b02946762ac0379e7b022a38f4e94a3c2"
PREDECESSOR_RECEIPT_SET_SHA256 = "f59fe60d91431b630e49320d081bd33fc2681024bc6d1089331793f1a0729369"
REVIEW_SCOPE_SHA256 = "f5443b1a902fe7625474fa5cf8307a95d2062df07e3e1790e84750065743411b"
TEST_SCOPE_SHA256 = "30306f630f36f239e8828214f1efeb3b36c0dc876dcf9b4a8f42521cd6598746"
PHASE_MAP_SHA256 = "a77668e47bfdf1af1fb1f3cb2fb277f9c3ccc51ce0d93f8cb225f5b8de15bf41"
ROUTE_EDGE_CONTRACT_SHA256 = "e17c4630dd22e97ca8fdbcc7bde5fa225dea876125c18004837ea7e858225532"

PACKAGE_NAME = "fc01-v1.2-amendment-a-20260817t151323z"
CAMPAIGN_DIR_REL = Path("docs/campaigns/foundation-mainline-v1")
PACKAGE_REL = CAMPAIGN_DIR_REL / "evidence" / PACKAGE_NAME
MAIN_EVALUATOR_REL = CAMPAIGN_DIR_REL / "evaluate_fc01_v1_2_amendment_a.py"
APPROVAL_EVALUATOR_REL = CAMPAIGN_DIR_REL / "evaluate_fc01_v1_2_amendment_a_approval.py"

REVIEW_EXPECTED = {
    "REV-P1-BUILDER-EVENT-AUTH": ("P1", "M00_PREREQUISITE"),
    "REV-P1-COMPOSE-LANGGRAPH-TARGET": ("P1", "POST_M00_RELEASE_GATE"),
    "REV-P2-PARENT-THREAD-MANIFEST": ("P2", "M00_PREREQUISITE"),
    "REV-P2-REGISTRY-IDENTITY": ("P2", "M00_PREREQUISITE"),
    "REV-P2-INNER-TIMEOUT": ("P2", "M00_PREREQUISITE"),
    "REV-P2-RUNTIME-RUN-ID": ("P2", "M00_PREREQUISITE"),
    "REV-P2-UNQUOTED-OPACITY": ("P2", "M00_PREREQUISITE"),
    "REV-P2-INTERNAL-ARTIFACT-PATH": ("P2", "POST_M00_RELEASE_GATE"),
    "REV-P2-BLOCKING-JOIN": ("P2", "M00_PREREQUISITE"),
    "REV-P2-ARIA-VISIBILITY": ("P2", "M00_PREREQUISITE"),
}
RESOLVED_IDS = {
    "UNK-GATEWAY-IMAGE",
    "UNK-LANGGRAPH-IMAGE",
    "UNK-VOICE-IMAGE",
    "UNK-VERCEL-RETENTION-DURATION",
    "UNK-VERCEL-BUILD-IMAGE",
    "UNK-RELEASE-CRITICAL-SKIPS",
}
ROUTE_EDGE_IDS = {
    "EDGE-VERCEL-GATEWAY",
    "EDGE-GATEWAY-LANGGRAPH",
    "EDGE-LANGGRAPH-GATEWAY",
    "EDGE-GATEWAY-AUTH",
    "EDGE-VERCEL-DB",
    "EDGE-GATEWAY-DB",
    "EDGE-LANGGRAPH-DB",
    "EDGE-ZERO-VOICE",
}
LANE_IDS = {
    "AR-T01-POSTGRES-49",
    "AR-T02-ROOT-LINUX-14",
    "AR-T03-PYTHON-CHROMIUM-8",
    "AR-T04-NODE-HTML-PDF-1-OBSERVATION",
    "AR-T05-DECK-SKILL-HASH-41",
    "AR-T06-SMOKE-DIMENSION-6",
    "AR-T07-SHADOW-ORDER-AND-FULL-SUITE",
    "AR-T08-RUFF",
    "AR-T09-REVIEW-AND-BUILDER-GATEWAY-REGRESSION",
    "AR-T10-FRONTEND-RUNTIME-CONTRACT-5",
    "AR-T11-FRONTEND-OFFLINE-E2E-2",
    "AR-T12-EXACT-CANDIDATE-AGGREGATE",
    "AR-T13-CONDITIONAL-VERCEL-BUILD",
}
NULL_PAIRS = {
    "render_gateway.build_or_image_digest",
    "render_gateway.boot_or_connection_epoch",
    "render_langgraph.build_or_image_digest",
    "render_langgraph.boot_or_connection_epoch",
    "render_langgraph.durable_store_kind",
    "render_voice.build_or_image_digest",
    "render_voice.boot_or_connection_epoch",
    "render_voice.durable_store_kind",
    "vercel_frontend.build_or_image_digest",
    "vercel_frontend.boot_or_connection_epoch",
    "vercel_frontend.durable_store_kind",
    "vercel_frontend.deployment_retention_duration",
}
REQUIRED_BLOCKER_FIELDS = {
    "id", "category", "severity", "class", "status", "original_boundary",
    "causal_path", "source_anchors", "evidence_refs", "assumptions",
    "invalidation_triggers", "required_disposition",
    "source_repair_authorized", "authorized_repair_kind",
}
PHASE_EXPECTED = {
    "P0_AMENDMENT_AUTHORITY": {
        "required_before_state": "FC01A_R_READY",
        "ids": {"GOV-AMENDMENT-JOINT-APPROVAL"},
    },
    "P1_FC01A_R_SOURCE_REPAIR": {
        "required_before_state": "FC01A_R_READY_FOR_TARGET_APPROVAL",
        "ids": set(REVIEW_EXPECTED),
    },
    "P2_PREDEPLOY_TEST_AND_CANDIDATE_GATE": {
        "required_before_state": "FC01A_R_READY_FOR_TARGET_APPROVAL",
        "ids": {
            "TEST-SKIP-POSTGRES-49", "TEST-SKIP-ROOT-LINUX-14",
            "TEST-SKIP-PYTHON-CHROMIUM-8", "TEST-BACKEND-RUFF-3",
            "TEST-BACKEND-DECK-HASH-35", "TEST-BACKEND-SMOKE-DIMENSION-5",
            "TEST-BACKEND-ORDER-ISOLATION-17",
            "TEST-FRONTEND-RUNTIME-OWNERSHIP-3",
            "TEST-FRONTEND-CANONICAL-E2E", "TEST-FRONTEND-PRODUCTION-BUILD",
            "TEST-EXACT-CANDIDATE-CI",
        },
    },
    "P3_PRETARGET_CONFIDENTIAL_AND_STATIC_PROOF": {
        "required_before_state": "FC01A_R_READY_FOR_TARGET_APPROVAL",
        "ids": {
            "UNK-DB-GATEWAY-PROJECT", "UNK-DQ-SHADOW-RELATION", "UNK-DB-ACL",
            "UNK-GATEWAY-PROJECT-ROUTING", "DATA-DB-CRITICAL-RLS-MAPPING",
            "PRIVACY-BACKEND-USERS-15", "PRIVACY-ROOT-USERS-150",
            "SECRET-CANDIDATES-10-3", "VERCEL-PRODUCTION-INPUT-CLOSURE",
        },
    },
    "P4_TARGET_ACTION_AUTHORITY": {
        "required_before_state": "TARGET_DEPLOYMENT_APPROVED",
        "ids": {"GOV-TARGET-SPECIFIC-DEPLOY-APPROVAL"},
    },
    "P5_POST_ASSIGNMENT_REVALIDATION": {
        "required_before_state": "CANDIDATE_IDENTITIES_REVALIDATED",
        "ids": {"SECRET-BUILDER-EVENT-HMAC-CONTRACT", "ROUTE-M00-CLOSURE", "CANDIDATE-ROLLBACK-SELECTABILITY"},
    },
    "P6_BASE00": {
        "required_before_state": "BASELINE_READY_FOR_JOINT_M00_APPROVAL",
        "ids": {"GOV-BASE00-RECOMPUTE"},
    },
    "P7_FRESH_M00_PROPOSAL_AND_BUDGET": {
        "required_before_state": "BASELINE_FROZEN",
        "ids": {"GOV-CURRENT-BUDGET-UNSIGNED", "GOV-M00-PROPOSAL-STALE"},
    },
    "P8_FRESH_M00_AUTHORITY": {
        "required_before_state": "BASELINE_FROZEN",
        "ids": {"GOV-FRESH-M00-JOINT-DECISIONS"},
    },
}
UNAUTHORIZED_TEST_REPAIRS = {
    "TEST-SKIP-NODE-PDF-1", "TEST-SKIP-LIVE-CLIENT-19",
    "TEST-FRONTEND-CSP-2", "TEST-FRONTEND-NULL-SAFETY-7",
    "TEST-FRONTEND-CHROME-LAYOUT-7", "TEST-FRONTEND-SETTINGS-4",
    "TEST-FRONTEND-CHROME-HOOK-6", "TEST-FRONTEND-RECAP-2",
    "TEST-FRONTEND-PRODUCTION-BUILD", "TEST-FRONTEND-SUPPLEMENTAL-MEMORY-E2E",
    "TEST-FRONTEND-LINT-WARNINGS-58", "TEST-BACKEND-TYPECHECK-NOT-CONFIGURED",
    "TEST-VOICE-MISSING-CREDENTIAL-1", "TEST-VOICE-DEPENDENCY-42",
    "TEST-VOICE-CONTRACT-57", "TEST-GVIS-62",
}
UNSIGNED_BINDING_KEYS = {
    "payload_commit", "payload_parent_commit", "payload_repository_tree",
    "payload_evidence_subtree", "payload_sha256sums_sha256",
    "amendment_document_sha256", "blocker_register_sha256",
    "authorized_scope_sha256", "repair_budget_sha256",
    "candidate_identity_budget_sha256", "main_evaluator_sha256",
    "approval_evaluator_sha256", "predecessor_control_head",
    "frozen_main_commit", "frozen_main_tree", "frozen_campaign_commit",
    "frozen_campaign_tree",
}


class EvaluationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise EvaluationError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical_digest(value: Any) -> str:
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def parse_utc_timestamp(value: Any, label: str) -> dt.datetime:
    require(isinstance(value, str) and value.endswith("Z"), f"{label} is not UTC Z")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        fail(f"invalid {label}: {exc}")
    return parsed


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except Exception as exc:  # pragma: no cover - emitted as governance failure
        fail(f"invalid JSON {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"expected JSON object: {path}")
    return value


def git(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=False,
    )
    if check and proc.returncode:
        fail(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def parse_sums(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        require(match is not None, f"malformed SHA256SUMS line: {line!r}")
        digest, name = match.groups()
        require(name not in result, f"duplicate checksum entry: {name}")
        result[name] = digest
    return result


def validate_checksums(package: Path, manifest: dict[str, Any]) -> None:
    required = manifest["required_files"]
    require(len(required) == len(set(required)), "duplicate required_files")
    require("SHA256SUMS" in required, "SHA256SUMS not required")
    on_disk = {p.name for p in package.iterdir() if p.is_file()}
    require(on_disk == set(required), f"package file set mismatch: {sorted(on_disk ^ set(required))}")
    sums = parse_sums(package / "SHA256SUMS")
    expected_sum_names = set(required) - {"SHA256SUMS"}
    require(set(sums) == expected_sum_names, "checksum coverage mismatch")
    for name, digest in sums.items():
        require(sha256_file(package / name) == digest, f"checksum mismatch: {name}")


def validate_authority(repo: Path, package: Path, manifest: dict[str, Any]) -> None:
    require(manifest["base_spec_version"] == "1.1", "base spec is not v1.1")
    require(manifest["effective_spec_version_after_approval"] == "1.2", "effective version mismatch")
    require(manifest["payload_state"] == "AMENDMENT_DRAFT_PENDING_SEAL", "payload state must remain draft")
    require(manifest["sealed_target_state"] == "AMENDMENT_READY_FOR_JOINT_APPROVAL", "sealed target mismatch")
    authority = manifest["authority"]
    require(authority["fc01_sha256"] == FC01_SHA256, "FC-01 digest mismatch")
    require(authority["strategy_sha256"] == STRATEGY_SHA256, "strategy digest mismatch")
    require(authority["authority_lock_file_sha256"] == AUTHORITY_LOCK_SHA256, "authority-lock digest mismatch")
    require(re.fullmatch(r"[0-9a-f]{64}", authority["authority_lock_file_sha256"]) is not None, "authority digest is not 64 hex")
    require(authority["predecessor_intake_malformed_lock_value"] == MALFORMED_AUTHORITY_VALUE, "malformed predecessor value not preserved")
    require(len(MALFORMED_AUTHORITY_VALUE) == 61, "expected 61-character predecessor defect")
    correction = load_json(package / "authority-lock-correction.json")
    require(correction["authoritative_file_sha256"] == AUTHORITY_LOCK_SHA256, "correction digest mismatch")
    require(correction["malformed_inherited_value"] == MALFORMED_AUTHORITY_VALUE, "correction does not bind predecessor defect")
    lock = repo / "docs/campaigns/foundation-mainline-v1/evidence/base00-20260817t114334z/authority-lock.json"
    require(sha256_file(lock) == AUTHORITY_LOCK_SHA256, "actual authority-lock bytes mismatch")
    source = manifest["source_lock"]
    require((source["main"], source["main_tree"]) == (MAIN, MAIN_TREE), "main lock mismatch")
    require((source["campaign"], source["campaign_tree"]) == (CAMPAIGN, CAMPAIGN_TREE), "campaign lock mismatch")
    require(git(repo, "rev-parse", f"{MAIN}^{{tree}}") == MAIN_TREE, "main Git tree mismatch")
    require(git(repo, "rev-parse", f"{CAMPAIGN}^{{tree}}") == CAMPAIGN_TREE, "campaign Git tree mismatch")


def validate_predecessor_index(repo: Path, package: Path) -> dict[str, Any]:
    index = load_json(package / "predecessor-evidence-index.json")
    receipts = index["receipts"]
    require(len(receipts) == 21, "predecessor receipt count mismatch")
    triples = [[r["id"], r["path"], r["sha256"]] for r in receipts]
    require(canonical_digest(triples) == PREDECESSOR_RECEIPT_SET_SHA256, "predecessor receipt set drift")
    loaded: dict[str, Any] = {}
    for receipt in receipts:
        require(receipt["id"] not in loaded, f"duplicate receipt ID {receipt['id']}")
        path = repo / receipt["path"]
        require(path.is_file(), f"missing predecessor receipt {path}")
        require(sha256_file(path) == receipt["sha256"], f"predecessor receipt drift {receipt['id']}")
        loaded[receipt["id"]] = json.loads(path.read_text())
    return loaded


def validate_blockers(package: Path, receipts: dict[str, Any]) -> None:
    data = load_json(package / "blocker-reachability.json")
    blockers = data["blockers"]
    require(len(blockers) == 70, "blocker count must be 70")
    ids = [b["id"] for b in blockers]
    require(len(ids) == len(set(ids)), "duplicate blocker ID")
    require(canonical_digest(sorted(ids)) == BLOCKER_ID_SET_SHA256, "blocker ID set drift")
    require(data["summary"]["blocker_entries"] == 70, "summary blocker count mismatch")
    require(data["summary"]["m00_prerequisite_entries"] == 37, "summary M00 class count mismatch")
    require(data["summary"]["post_m00_release_gate_entries"] == 33, "summary POST class count mismatch")
    require(sum(b["class"] == "M00_PREREQUISITE" for b in blockers) == 37, "M00 class count mismatch")
    require(sum(b["class"] == "POST_M00_RELEASE_GATE" for b in blockers) == 33, "POST class count mismatch")
    for blocker in blockers:
        missing = REQUIRED_BLOCKER_FIELDS - set(blocker)
        require(not missing, f"{blocker['id']} missing fields {sorted(missing)}")
        require(blocker["class"] in {"M00_PREREQUISITE", "POST_M00_RELEASE_GATE"}, f"invalid class {blocker['id']}")
        require(blocker["status"] != "PASS", f"payload prematurely passes {blocker['id']}")
        require(bool(blocker["causal_path"] and blocker["required_disposition"] and blocker["original_boundary"]), f"empty semantics {blocker['id']}")
        require(isinstance(blocker["source_anchors"], list), f"source anchors not list {blocker['id']}")
        require(blocker["evidence_refs"], f"missing evidence ref {blocker['id']}")
        for ref in blocker["evidence_refs"]:
            receipt_id, fragment = ref.split("#", 1)
            require(receipt_id in receipts, f"unknown evidence receipt {receipt_id} in {blocker['id']}")
            current: Any = receipts[receipt_id]
            if fragment not in {"", "/"}:
                try:
                    for token in fragment.lstrip("/").split("/"):
                        token = token.replace("~1", "/").replace("~0", "~")
                        current = current[int(token)] if isinstance(current, list) else current[token]
                except (KeyError, IndexError, TypeError, ValueError):
                    fail(f"invalid evidence JSON pointer {ref} in {blocker['id']}")
        if blocker["class"] == "POST_M00_RELEASE_GATE":
            require(blocker["assumptions"] and blocker["invalidation_triggers"], f"POST entry lacks escalation law {blocker['id']}")

    reviews = {b["id"]: b for b in blockers if b["category"] == "REVIEW"}
    require(set(reviews) == set(REVIEW_EXPECTED), "review ID set mismatch")
    for blocker_id, (severity, temporal_class) in REVIEW_EXPECTED.items():
        item = reviews[blocker_id]
        require((item["severity"], item["class"]) == (severity, temporal_class), f"review classification drift {blocker_id}")
        require(item["source_repair_authorized"] is True and item["fc01ar_repair_required"] is True, f"review not mandatory {blocker_id}")
    require(sum(b["severity"] == "P1" for b in reviews.values()) == 2, "P1 count mismatch")
    require(sum(b["severity"] == "P2" for b in reviews.values()) == 8, "P2 count mismatch")

    resolved = data["resolved_predecessor_items"]
    require({r["id"] for r in resolved} == RESOLVED_IDS, "resolved predecessor set mismatch")
    require(next(r for r in resolved if r["id"] == "UNK-RELEASE-CRITICAL-SKIPS")["not_a_pass"] is True, "skip aggregate called pass")
    require(data["summary"]["m00_logical_tests_not_run"] == 71, "M00 skip count mismatch")
    require(data["summary"]["post_m00_logical_tests_not_run"] == 20, "POST skip count mismatch")
    require(data["summary"]["known_render_image_reachable_records"] == 15, "Render image record count mismatch")
    require(data["summary"]["vercel_outside_root_reachability_unknown_records"] == 150, "outside-root unknown count mismatch")
    require(data["summary"]["repository_only_records_proved"] == 0, "unproved records called repository-only")
    privacy_root = next(b for b in blockers if b["id"] == "PRIVACY-ROOT-USERS-150")
    require(privacy_root["class"] == "M00_PREREQUISITE", "unknown outside-root reachability was deferred")

    phases = {p["phase"]: p for p in data["required_before_state_phases"]}
    require(canonical_digest(data["required_before_state_phases"]) == PHASE_MAP_SHA256, "phase map content drift")
    require(set(phases) == set(PHASE_EXPECTED), "phase ID set mismatch")
    phased_ids: list[str] = []
    for phase, expected in PHASE_EXPECTED.items():
        row = phases[phase]
        require(row["required_before_state"] == expected["required_before_state"], f"phase state drift {phase}")
        require(set(row["blocker_ids"]) == expected["ids"], f"phase blocker set drift {phase}")
        require(len(row["blocker_ids"]) == len(set(row["blocker_ids"])), f"duplicate phase blocker {phase}")
        phased_ids.extend(row["blocker_ids"])
    require(len(phased_ids) == len(set(phased_ids)), "blocker appears in multiple phases")
    m00_ids = {b["id"] for b in blockers if b["class"] == "M00_PREREQUISITE"}
    mandatory_post_reviews = {
        "REV-P1-COMPOSE-LANGGRAPH-TARGET", "REV-P2-INTERNAL-ARTIFACT-PATH",
    }
    require(set(phased_ids) == m00_ids | mandatory_post_reviews, "phase coverage mismatch")
    law = data["phase_law"]
    require(law["all_m00_prerequisites_pass_no_later_than"] == "BASELINE_FROZEN", "phase law permits M00 blocker")
    require(law["predeployment_subset_only_before_target_approval"] is True, "target approval timing is circular")

    expected_basis = {
        "UNK-GATEWAY-IMAGE": ("provider-nullability.json#/resolved_nullable_fields/0", "render_gateway.build_or_image_digest"),
        "UNK-LANGGRAPH-IMAGE": ("provider-nullability.json#/resolved_nullable_fields/2", "render_langgraph.build_or_image_digest"),
        "UNK-VOICE-IMAGE": ("provider-nullability.json#/resolved_nullable_fields/5", "render_voice.build_or_image_digest"),
        "UNK-VERCEL-RETENTION-DURATION": ("provider-nullability.json#/resolved_nullable_fields/11", "vercel_frontend.deployment_retention_duration"),
        "UNK-VERCEL-BUILD-IMAGE": ("provider-nullability.json#/resolved_nullable_fields/8", "vercel_frontend.build_or_image_digest"),
    }
    nullable_rows = load_json(package / "provider-nullability.json")["resolved_nullable_fields"]
    for row in resolved:
        if row["id"] in expected_basis:
            pointer, pair = expected_basis[row["id"]]
            require(row["basis"] == pointer, f"invalid local basis pointer {row['id']}")
            index = int(pointer.rsplit("/", 1)[1])
            target = nullable_rows[index]
            require(f"{target['surface']}.{target['field']}" == pair, f"local basis target drift {row['id']}")


def validate_scope_and_budget(package: Path) -> None:
    scope = load_json(package / "authorized-repair-scope.json")
    require(scope["execution_authorized"] is False, "scope prematurely authorized")
    reviews = scope["review_repair_authority"]
    require(canonical_digest(reviews) == REVIEW_SCOPE_SHA256, "review repair scope content drift")
    require({r["id"] for r in reviews} == set(REVIEW_EXPECTED), "scope review set mismatch")
    require(all(r["fc01ar_repair_required"] is True for r in reviews), "scope permits partial review repair")
    require(scope["review_exit_law"]["required_review_repairs"] == 10, "scope review exit count mismatch")
    flattened = {p for r in reviews for p in r["allowed_product_paths"]}
    require("skills/public/sophia/deck_craft.md" not in flattened, "skill semantics are over-authorized")
    tests = {x["blocker_id"]: x for x in scope["m00_critical_test_repair_authority"]}
    require(canonical_digest(scope["m00_critical_test_repair_authority"]) == TEST_SCOPE_SHA256, "test repair scope content drift")
    require("TEST-SKIP-NODE-PDF-1" not in tests, "Node POST lane repair authorized")
    require("TEST-FRONTEND-CSP-2" not in tests, "Voice CSP repair authorized")
    linux_paths = set(tests["TEST-SKIP-ROOT-LINUX-14"]["allowed_paths"])
    require("backend/Dockerfile" not in linux_paths and "backend/Dockerfile.langgraph" not in linux_paths, "production Dockerfile over-authorized")
    ci = tests["TEST-EXACT-CANDIDATE-CI"]["allowed_paths"]
    require(ci == [".github/workflows/fc01a-r-m00-prerequisites.yml"], "CI path not exact")
    require(scope["control_branch"]["prior_file_modify_delete_or_rename_allowed"] is False, "control branch not append-only")
    require(scope["directly_adjacent_test_rule"]["additional_test_path_may_be_used"] is False, "open-ended test path authority")
    require(set(scope["explicitly_not_authorized_test_repairs"]) == UNAUTHORIZED_TEST_REPAIRS, "explicit non-authorized test set mismatch")
    blockers = load_json(package / "blocker-reachability.json")["blockers"]
    false_test_ids = {
        b["id"] for b in blockers
        if b["category"] == "TEST" and b["source_repair_authorized"] is False
    }
    require(false_test_ids == UNAUTHORIZED_TEST_REPAIRS, "non-authorized TEST rows drift")

    budget = load_json(package / "repair-budget.json")
    require(budget["status"] == "PROPOSED_UNSIGNED_INACTIVE" and budget["execution_authorized"] is False, "budget active/signed")
    limits = budget["repair_limits"]
    require((limits["minimum_review_findings_repaired_and_passed"], limits["maximum_review_findings"], limits["exact_p1"], limits["exact_p2"]) == (10, 10, 2, 8), "review budget mismatch")
    require(limits["partial_review_completion_allowed"] is False, "partial completion allowed")
    test_budget = budget["test_budget"]
    require((test_budget["m00_logical_not_run_to_resolve"], test_budget["post_m00_logical_not_run_to_preserve"]) == (71, 20), "test budget split mismatch")
    require(test_budget["m00_prerequisite_test_lanes"] == 12, "M00 test lane count mismatch")
    external = budget["external_and_mutation_limits"]
    require(all(value == 0 or value == 0.0 for value in external.values() if isinstance(value, (int, float))), "nonzero external mutation/spend budget")
    require(budget["accounting"]["append_only_ledger_path_pattern"], "budget ledger missing")
    require("no pause state" in budget["accounting"]["active_clock_stops"], "undefined budget pause state")
    require(len(budget["accounting"]["ledger_required_fields"]) == 19, "budget ledger schema incomplete")

    candidate = load_json(package / "candidate-identity-budget.json")
    require(candidate["status"] == "PROPOSED_INACTIVE_PENDING_TARGET_SPECIFIC_APPROVAL", "candidate budget active")
    require(candidate["execution_authorized"] is False, "candidate identity actions authorized")
    require(candidate["activation"]["requires_separate_direct_davide_target_specific_approval"] is True, "target approval missing")
    require(candidate["ordered_forward_budget"]["maximum_total_candidate_deployments"] == 3, "candidate deployment ceiling mismatch")
    require(candidate["ordered_forward_budget"]["maximum_total_production_promotions_or_alias_actions"] == 1, "candidate promotion ceiling mismatch")
    require(candidate["ordered_forward_budget"]["maximum_attempts_per_target"] == 1, "candidate retry allowed")
    require(candidate["ordered_forward_budget"]["maximum_elapsed_window_minutes"] == 180, "candidate time ceiling mismatch")
    require(candidate["ordered_abort_rollback_budget"]["maximum_total_rollback_actions"] == 3, "rollback ceiling mismatch")
    rollback_budget = candidate["ordered_abort_rollback_budget"]
    require(rollback_budget["provider_rollback_dry_run_or_canary_before_abort"] is False, "provider rollback canary allowed")
    require(rollback_budget["offline_reverse_order_evaluator_required"] is True, "offline rollback order proof missing")
    require(all(v == 0 or v == 0.0 for v in candidate["hard_zero_limits"].values()), "candidate budget zero limit violated")
    targets = {row["surface"]: row for row in candidate["targets"]}
    require(set(targets) == {"render_langgraph", "render_gateway", "vercel_frontend"}, "candidate target set mismatch")
    require(targets["vercel_frontend"]["participation"] == "CONDITIONAL_IF_PRODUCTION_INPUT_CLOSURE_DIFFERS", "Vercel participation law drift")
    require(candidate["activation"]["requires_separate_direct_luis_target_specific_approval_if_vercel_participates"] is True, "Luis Vercel approval missing")


def validate_tests(package: Path) -> None:
    plan = load_json(package / "test-plan.json")
    require(plan["execution_authorized"] is False, "test plan prematurely authorized")
    accounting = plan["logical_skip_accounting"]
    require(accounting["predecessor_aggregate_status"] == "RESOLVED_BY_DECOMPOSITION", "skip aggregate not decomposed")
    require(accounting["m00_prerequisite"]["total"] == 71, "M00 test split mismatch")
    require(accounting["post_m00_release_gate"]["total"] == 20, "POST test split mismatch")
    require(accounting["remaining_reported_skips"] == 89, "full-suite skip expectation mismatch")
    lanes = {lane["lane_id"]: lane for lane in plan["lanes"]}
    require(set(lanes) == LANE_IDS, "test lane ID set mismatch")
    require(lanes["AR-T01-POSTGRES-49"]["expected"]["passed"] == 49, "PG lane count mismatch")
    require(len(lanes["AR-T02-ROOT-LINUX-14"]["nodeids"]) == 14, "Linux nodeid count mismatch")
    require(len(lanes["AR-T03-PYTHON-CHROMIUM-8"]["nodeids"]) == 8, "Chromium nodeid count mismatch")
    require(lanes["AR-T04-NODE-HTML-PDF-1-OBSERVATION"]["classification"] == "POST_M00_RELEASE_GATE", "Node lane misclassified")
    full = lanes["AR-T07-SHADOW-ORDER-AND-FULL-SUITE"]["authoritative_command"]
    aggregate = " ".join(lanes["AR-T12-EXACT-CANDIDATE-AGGREGATE"]["commands"])
    require("DQ1_POSTGRES_CONTAINER=fc01ar-pg16" in full and "DQ1_POSTGRES_CONTAINER=fc01ar-pg16" in aggregate, "full suite lacks PG capability")
    nodeid = "tests/test_render_html_to_pdf.py::test_node_smoke_renders_inline_svg_pdf"
    require(f"--deselect {nodeid}" in full and f"--deselect {nodeid}" in aggregate, "POST Node lane is accidentally mandatory")
    require(lanes["AR-T07-SHADOW-ORDER-AND-FULL-SUITE"]["expected"]["post_m00_node_deselected"] == 1, "Node deselection not bound")
    e2e = lanes["AR-T11-FRONTEND-OFFLINE-E2E-2"]
    require(e2e["test_count"] == 2 and e2e["expected"]["external_requests"] == 0, "offline E2E contract mismatch")
    require("intercepted" in e2e["environment"] and "not live" in e2e["proof_scope"].lower(), "E2E overclaims live proof")
    require("--retries=0" in e2e["command"], "Playwright retries not disabled")
    build = lanes["AR-T13-CONDITIONAL-VERCEL-BUILD"]
    require(build["classification"] == "M00_PREREQUISITE", "conditional Vercel build not gated")
    require(build["source_repair_authorized"] is False and build["authorized_repair_kind"] == "PROOF_ONLY_NO_REPAIR", "frontend product repair leaked through build gate")
    require(build["expected"]["external_network_requests"] == 0 and build["expected"]["remote_font_fetches"] == 0, "frontend build is non-hermetic")
    require(set(plan["post_m00_frontend_groups"]) >= {"TEST-FRONTEND-CSP-2", "TEST-FRONTEND-NULL-SAFETY-7"}, "POST frontend groups incomplete")
    proofs = plan["review_finding_proofs"]
    require({p["id"] for p in proofs} == set(REVIEW_EXPECTED), "review proof set mismatch")
    require(all(p["test_paths"] and p["required_assertions"] for p in proofs), "review proof lacks deterministic tests")


def validate_deployment_and_nullability(package: Path) -> None:
    deploy = load_json(package / "m00-deployment-set.json")
    require(deploy["execution_authorized"] is False, "deployment prematurely authorized")
    identities = {i["surface"]: i for i in deploy["runtime_identity_set"]}
    require(set(identities) == {"vercel_frontend", "render_gateway", "render_langgraph"}, "deployment surface set mismatch")
    require(identities["vercel_frontend"]["current_deployment_id"] == "dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR", "Vercel identity drift")
    require(identities["render_gateway"]["current_deployment_id"] == "dep-d9ln9eflk1mc7392mnmg", "Gateway identity drift")
    require(identities["render_langgraph"]["current_deployment_id"] == "dep-d9ln9e8ae00c73aoo3b0", "LangGraph identity drift")
    expected_overlay = {
        "vercel_frontend": ("www production alias", "ready", "2026-08-17T13:57:24Z"),
        "render_gateway": ("deer-flow-gateway", "deployed", "2026-08-17T13:57:24Z"),
        "render_langgraph": ("self-hosted LangGraph server 0.8.1 / langgraph-py 1.2.0", "deployed", "2026-08-17T13:57:24Z"),
    }
    for surface, (runtime_path, status, observed_at) in expected_overlay.items():
        row = identities[surface]
        require((row["runtime_path"], row["provider_status"], row["status"], row["provider_observed_at"], row["observed_at"]) == (runtime_path, status, status, observed_at, observed_at), f"identity overlay drift {surface}")
        require(row["runtime_path_observed_at"] == "2026-08-17T11:55:26Z", f"runtime path observation drift {surface}")
        require(len(row["identity_evidence_refs"]) == 3, f"identity evidence incomplete {surface}")
    require({e["edge_id"] for e in deploy["required_route_closure"]} == ROUTE_EDGE_IDS, "route edge set mismatch")
    require(canonical_digest(deploy["required_route_closure"]) == ROUTE_EDGE_CONTRACT_SHA256, "route edge contract drift")
    edges = {e["edge_id"]: e for e in deploy["required_route_closure"]}
    v2g = edges["EDGE-VERCEL-GATEWAY"]
    v2g_text = " ".join([v2g["from"], v2g["to"], v2g["required_proof"], *v2g["source_anchors"]])
    for token in ("SOPHIA_LANGGRAPH_BASE_URL", "/api/langgraph", "NEXT_PUBLIC_LANGGRAPH_BASE_URL", "localhost:2026", "direct LangGraph"):
        require(token in v2g_text, f"Vercel chat edge missing {token}")
    voice = deploy["voice"]
    require(voice["execution_participation"] == "NOT_APPLICABLE_FOR_FROZEN_TEXT_M00", "Voice participation mismatch")
    require(voice["rollback_coordinate_known"] is False and voice["blocker_class"] == "POST_M00_RELEASE_GATE", "Voice rollback improperly waived")
    require(
        (
            voice["runtime_path"], voice["status"],
            voice["provider_observed_at"], voice["observed_at"],
        ) == (
            "FastAPI voice service 0.1.0 with current route families",
            "deployed", "2026-08-17T13:57:24Z", "2026-08-17T13:57:24Z",
        ),
        "Voice identity overlay drift",
    )
    require(len(voice["identity_evidence_refs"]) == 3, "Voice identity evidence incomplete")
    zero = " ".join(voice["required_zero_call_receipt"])
    require("SOPHIA_AUTH_BACKEND_URL" in zero and "Voice" in zero, "Voice auth-fallback exclusion missing")
    require(voice["observability_gap_fixture"]["new_live_gemini_or_voice_capture_allowed"] is False, "live Voice gap capture allowed")
    secret = deploy["shared_builder_event_secret_contract"]
    require(secret["setting_or_rotation_authorized"] is False, "shared secret mutation authorized")
    require(secret["challenge_protocol"]["name"] == "AUTH_CHALLENGE_V1", "HMAC challenge protocol missing")
    challenge = " ".join(secret["challenge_protocol"]["requirements"])
    for token in ("content-free", "before event parsing", "database", "storage", "valid fresh", "replay"):
        require(token in challenge, f"HMAC zero-side-effect contract missing {token}")
    protocol = deploy["candidate_deployment_protocol"]
    require(len(protocol["ordered_forward_steps"]) == 5 and len(protocol["ordered_rollback_steps"]) == 4, "ordered deploy/rollback protocol incomplete")
    require(protocol["candidate_identity_budget_file"] == "candidate-identity-budget.json", "candidate budget not bound")
    require(protocol["actual_rollback_before_abort_authorized"] is False, "rollback canary mutation authorized")
    closure = deploy["frontend_production_input_closure"]
    require(set(closure["production_input_classes"]) == set("ABCDEFG"), "Vercel closure class set incomplete")
    require("TEST_ONLY_NONINPUT" in closure["test_only_noninput_law"] and "NOT_PROVED" in closure["test_only_noninput_law"], "test-only closure law incomplete")
    require("150" in closure["root_users_requirement"], "root tracked-record closure missing")
    require("candidate-identity-budget.json" in closure["changed_effect"] and "Davide" in closure["changed_effect"] and "Luis" in closure["changed_effect"], "conditional Vercel authority incomplete")
    require(protocol["conditional_vercel_approval"].startswith("When the closure differs"), "conditional Vercel approval missing")
    require(identities["render_gateway"]["post_candidate_rollback_selectable_now"] is None, "future Gateway selectability fabricated")
    require(identities["render_langgraph"]["post_candidate_rollback_selectable_now"] is None, "future LangGraph selectability fabricated")
    require(identities["vercel_frontend"]["post_candidate_rollback_selectable_now"] is None, "future Vercel selectability fabricated")

    nullable = load_json(package / "provider-nullability.json")
    require(nullable["base_spec_version"] == "1.1" and nullable["effective_spec_version_after_approval"] == "1.2", "nullability version mismatch")
    require(set(nullable["allowed_null_pairs"]) == NULL_PAIRS, "nullable pair set mismatch")
    rows = nullable["resolved_nullable_fields"]
    require(len(rows) == len(NULL_PAIRS), "nullable record count mismatch")
    seen: set[str] = set()
    for row in rows:
        pair = f"{row['surface']}.{row['field']}"
        require(pair in NULL_PAIRS and pair not in seen, f"invalid/duplicate nullable pair {pair}")
        seen.add(pair)
        require(row["value"] is None, f"nullable value fabricated {pair}")
        require(row["availability_status"] in {"PROVIDER_NOT_EXPOSED", "NOT_APPLICABLE"}, f"invalid null status {pair}")
        require(row["reason"] and row["basis"] and row["observed_at"], f"incomplete null reason {pair}")
    vercel_build = next(r for r in rows if r["surface"] == "vercel_frontend" and r["field"] == "build_or_image_digest")
    require(vercel_build["availability_status"] == "PROVIDER_NOT_EXPOSED", "Vercel build incorrectly N/A")


def validate_confidential_contract(package: Path) -> None:
    data = load_json(package / "confidential-disposition-index.json")
    relations = data["relation_acl_contract"]
    require(len(relations) == 17, "relation inventory count mismatch")
    require(canonical_digest(relations) == RELATION_CONTRACT_SHA256, "relation ACL contract drift")
    routines = data["routine_inventory"]
    require(len(routines["active_service_rpc"]) == 35, "active RPC count mismatch")
    require(len(routines["retained_owner_only_legacy"]) == 3, "legacy RPC count mismatch")
    require(len(routines["constraint_helper_owner_only"]) == 13, "helper RPC count mismatch")
    require(canonical_digest(sorted(routines["active_service_rpc"])) == ACTIVE_RPC_SET_SHA256, "active RPC set drift")
    require(canonical_digest(sorted(routines["retained_owner_only_legacy"])) == LEGACY_RPC_SET_SHA256, "legacy RPC set drift")
    require(canonical_digest(sorted(routines["constraint_helper_owner_only"])) == HELPER_RPC_SET_SHA256, "helper RPC set drift")
    all_routines = sum((list(v) for v in routines.values()), [])
    require(len(all_routines) == len(set(all_routines)) == 51, "routine sets overlap")
    secret = data["secret_acceptance"]
    require((secret["current_summary"]["records"], secret["current_summary"]["strings"], secret["current_summary"]["state"]) == (10, 3, "BLOCKED_UNRESOLVED"), "secret current state mismatch")
    require(secret["acceptance_threshold"]["unresolved_records_max"] == 0 and secret["acceptance_threshold"]["unresolved_strings_max"] == 0, "secret threshold mismatch")
    groups = data["secret_candidate_dispositions"]
    require(len(groups) == 3 and all(g["confidential_receipt_ref"] is None and g["blocking"] is True for g in groups), "secret groups prematurely disposed")
    require(data["storage_inventory"][0]["configuration_metadata_read_allowed"] is True, "bucket metadata read prohibited")
    require(data["storage_inventory"][0]["object_row_or_content_read_allowed"] is False, "storage object read allowed")
    tracked = {row["group_id"]: row for row in data["tracked_record_dispositions"]}
    require(tracked["TRACKED-BACKEND-USERS"]["class"] == "M00_PREREQUISITE", "backend records deferred")
    require(tracked["TRACKED-ROOT-USERS"]["class"] == "M00_PREREQUISITE", "outside-root records deferred")
    require("source-bundle" in tracked["TRACKED-ROOT-USERS"]["required_proof"], "outside-root provider closure proof missing")
    advisor = data["advisor_disposition_law"]
    require(advisor["automatic_fail_merely_because_rls_disabled"] is False, "RLS advisor law inconsistent")
    require(advisor["allowed_nonfailure_status"] == "PASS_NONEXPLOITABLE_ACL_ONLY", "ACL-only disposition missing")


def validate_approvals_and_state(package: Path) -> None:
    manifest = load_json(package / "amendment-manifest.json")
    require(manifest["approvals"] == {"davide": None, "luis": None}, "payload contains decisions")
    for field in (
        "joint_amendment_approval_present", "fc01a_r_execution_authorized",
        "baseline_frozen", "fc01b_started", "m00_started", "current_budget_signed",
        "product_files_changed", "production_deployment_or_promotion",
        "provider_setting_mutation", "database_catalog_or_data_mutation",
        "secret_rotation", "raw_sensitive_evidence_committed",
    ):
        require(manifest[field] is False, f"manifest mutation/authority flag true: {field}")
    contract = load_json(package / "approval-contract.json")
    require(contract["immutable_payload_decision_slots"]["davide_operational"] is None, "Davide decision embedded")
    require(contract["immutable_payload_decision_slots"]["luis_experience_accessibility"] is None, "Luis decision embedded")
    require(contract["current_budget_must_remain_unsigned"] is True, "current budget signable")
    require(contract["current_draft_window_is_authoritative"] is False, "draft window reused")
    require(contract["state_machine"]["blocked_from_every_active_state"] is True, "BLOCKED transition incomplete")
    schema = load_json(package / "approval-receipt-schema.json")
    require(schema["current_state"] == "NO_DECISIONS_PRESENT" and schema["execution_authorized"] is False, "decision schema state mismatch")
    require(schema["failure_state_rules"]["execution_under_partial_approval"] == "PROHIBITED", "partial execution allowed")
    require(schema["github_issue_comment_identity"]["only_allowed_method"] == "GITHUB_ISSUE_COMMENT_V1", "identity method is not fail-closed")
    require(schema["github_issue_comment_identity"]["davide_actor_login"] == "davidelaverga", "Davide actor identity drift")
    require(set(schema["immutable_unsigned_payload_binding_keys"]) == UNSIGNED_BINDING_KEYS, "approval binding schema mismatch")
    require(schema["git_commit_protocol"]["required_branch"] == CONTROL_BRANCH, "decision branch drift")
    require(contract["phase_timing_law"]["predeployment_subset_passes_before_target_approval"] is True, "approval timing deadlock")
    identity_contract = contract["decision_identity_and_git_protocol"]
    require(identity_contract["only_identity_method"] == "GITHUB_ISSUE_COMMENT_V1", "approval contract identity drift")
    require(identity_contract["modification_deletion_rename_merge_or_uncommitted_decision_allowed"] is False, "mutable decision evidence allowed")
    require(identity_contract["decision_expiry_may_exceed_repair_budget_expiry"] is False, "decision may outlive budget")


def validate_git_source_anchors(repo: Path, package: Path) -> None:
    blockers = load_json(package / "blocker-reachability.json")["blockers"]
    future = {".github/workflows/fc01a-r-m00-prerequisites.yml"}
    checked: set[str] = set()
    for blocker in blockers:
        for anchor in blocker["source_anchors"]:
            raw = anchor.split("::", 1)[0]
            path = re.sub(r":\d+(?:-\d+)?$", "", raw)
            if not path or path in future or path in checked:
                continue
            checked.add(path)
            proc = subprocess.run(
                ["git", "cat-file", "-e", f"{CAMPAIGN}:{path}"], cwd=repo,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            require(proc.returncode == 0, f"source anchor missing at frozen campaign: {path}")


def validate_no_sensitive_payload(package: Path) -> None:
    text = "\n".join(p.read_text(errors="replace") for p in package.iterdir() if p.is_file())
    forbidden_patterns = {
        "private-key-block": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        "jwt": r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
        "supabase-service-key-assignment": r"SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*['\"]?[A-Za-z0-9._-]{20,}",
    }
    for label, pattern in forbidden_patterns.items():
        require(re.search(pattern, text) is None, f"sensitive pattern in payload: {label}")


def validate_payload(package: Path, repo: Path) -> None:
    manifest = load_json(package / "amendment-manifest.json")
    require(manifest["amendment_id"] == AMENDMENT_ID, "manifest amendment ID mismatch")
    validate_checksums(package, manifest)
    validate_authority(repo, package, manifest)
    receipts = validate_predecessor_index(repo, package)
    validate_blockers(package, receipts)
    validate_scope_and_budget(package)
    validate_tests(package)
    validate_deployment_and_nullability(package)
    validate_confidential_contract(package)
    validate_approvals_and_state(package)
    validate_git_source_anchors(repo, package)
    validate_no_sensitive_payload(package)


def validate_seal_if_present(repo: Path, package: Path) -> str:
    seal_glob = repo / CAMPAIGN_DIR_REL / "evidence"
    receipts = sorted(seal_glob.glob("fc01-v1.2-amendment-a-seal-*/seal-receipt.json"))
    if not receipts:
        return "PASS_AMENDMENT_DRAFT_PENDING_SEAL"
    require(len(receipts) == 1, "expected exactly one seal receipt")
    receipt_path = receipts[0]
    receipt = load_json(receipt_path)
    require(set(receipt) == {
        "schema_version", "amendment_id", "state", "created_at",
        "receipt_self_binding", "execution_authorized",
        "payload_evidence_path", "payload_changed_paths_sha256",
        "path_scope", "unsigned_payload_bindings",
    }, "seal receipt field set mismatch")
    require(receipt["schema_version"] == 1, "seal schema mismatch")
    require(receipt["amendment_id"] == AMENDMENT_ID, "seal amendment mismatch")
    require(receipt["state"] == "AMENDMENT_READY_FOR_JOINT_APPROVAL", "seal state mismatch")
    require(receipt["receipt_self_binding"] is False, "seal recursively self-binds")
    require(
        parse_utc_timestamp(receipt["created_at"], "seal.created_at") <= dt.datetime.now(UTC),
        "seal timestamp is in the future",
    )
    bindings = receipt["unsigned_payload_bindings"]
    require(set(bindings) == UNSIGNED_BINDING_KEYS, "seal binding key set mismatch")
    payload_commit = bindings["payload_commit"]
    require(re.fullmatch(r"[0-9a-f]{40}", payload_commit) is not None, "invalid payload commit")
    require(bindings["payload_parent_commit"] == PREDECESSOR, "seal parent binding mismatch")
    require(bindings["predecessor_control_head"] == PREDECESSOR, "predecessor binding mismatch")
    parents = git(repo, "show", "-s", "--format=%P", payload_commit).split()
    require(parents == [PREDECESSOR], "payload commit parent is not exact predecessor")
    require(git(repo, "rev-parse", f"{payload_commit}^{{tree}}") == bindings["payload_repository_tree"], "payload tree mismatch")
    subtree = git(repo, "rev-parse", f"{payload_commit}:{PACKAGE_REL.as_posix()}")
    require(subtree == bindings["payload_evidence_subtree"], "payload evidence subtree mismatch")
    require(receipt["payload_evidence_path"] == PACKAGE_REL.as_posix(), "payload evidence path mismatch")
    require(bindings["payload_sha256sums_sha256"] == sha256_file(package / "SHA256SUMS"), "sealed SHA256SUMS mismatch")
    require(bindings["amendment_document_sha256"] == sha256_file(package / "fc01-v1.2-amendment-a.md"), "sealed amendment digest mismatch")
    require(bindings["blocker_register_sha256"] == sha256_file(package / "blocker-reachability.json"), "sealed blocker digest mismatch")
    require(bindings["authorized_scope_sha256"] == sha256_file(package / "authorized-repair-scope.json"), "sealed scope digest mismatch")
    require(bindings["repair_budget_sha256"] == sha256_file(package / "repair-budget.json"), "sealed budget digest mismatch")
    require(bindings["candidate_identity_budget_sha256"] == sha256_file(package / "candidate-identity-budget.json"), "sealed candidate budget digest mismatch")
    require(bindings["main_evaluator_sha256"] == sha256_file(repo / MAIN_EVALUATOR_REL), "sealed main evaluator digest mismatch")
    require(bindings["approval_evaluator_sha256"] == sha256_file(repo / APPROVAL_EVALUATOR_REL), "sealed approval evaluator digest mismatch")
    require((bindings["frozen_main_commit"], bindings["frozen_main_tree"]) == (MAIN, MAIN_TREE), "sealed main source mismatch")
    require((bindings["frozen_campaign_commit"], bindings["frozen_campaign_tree"]) == (CAMPAIGN, CAMPAIGN_TREE), "sealed campaign source mismatch")

    changed = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", payload_commit).splitlines()
    expected = sorted(
        [f"{PACKAGE_REL.as_posix()}/{name}" for name in load_json(package / "amendment-manifest.json")["required_files"]]
        + [MAIN_EVALUATOR_REL.as_posix(), APPROVAL_EVALUATOR_REL.as_posix()]
    )
    require(sorted(changed) == expected, "payload commit path boundary mismatch")
    require(receipt["payload_changed_paths_sha256"] == sha256_bytes(("\n".join(expected) + "\n").encode()), "payload path digest mismatch")
    require(set(receipt["path_scope"]) == {"prior_files_modified_deleted_or_renamed", "payload_paths_exactly_allowlisted"}, "seal path_scope field set mismatch")
    require(receipt["path_scope"]["prior_files_modified_deleted_or_renamed"] is False, "seal permits predecessor modification")
    require(receipt["path_scope"]["payload_paths_exactly_allowlisted"] is True, "seal path allowlist not proved")
    require(receipt["execution_authorized"] is False, "seal authorizes execution")

    seal_rel = receipt_path.relative_to(repo).as_posix()
    seal_add_commits = git(repo, "log", "--format=%H", "--diff-filter=A", "--", seal_rel).splitlines()
    require(len(seal_add_commits) == 1, "seal receipt must be added exactly once")
    seal_commit = seal_add_commits[0]
    require(git(repo, "show", "-s", "--format=%P", seal_commit).split() == [payload_commit], "seal commit is not directly additive over payload")
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", seal_commit, "HEAD"],
        cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False,
    )
    require(ancestor.returncode == 0, "seal commit is not an ancestor of HEAD")
    seal_changed = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", seal_commit).splitlines()
    seal_prefix = receipt_path.parent.relative_to(repo).as_posix() + "/"
    require(seal_changed == [seal_rel] and all(path.startswith(seal_prefix) for path in seal_changed), "seal commit changed non-seal path")
    committed_receipt = subprocess.run(
        ["git", "show", f"{seal_commit}:{seal_rel}"], cwd=repo,
        capture_output=True, check=False,
    )
    require(committed_receipt.returncode == 0, "cannot read committed seal receipt")
    require(committed_receipt.stdout == receipt_path.read_bytes(), "working seal receipt differs from committed object")
    payload_paths = [PACKAGE_REL.as_posix(), MAIN_EVALUATOR_REL.as_posix(), APPROVAL_EVALUATOR_REL.as_posix()]
    proc = subprocess.run(["git", "diff", "--quiet", payload_commit, "--", *payload_paths], cwd=repo, check=False)
    require(proc.returncode == 0, "sealed payload paths changed after payload commit")
    require(git(repo, "status", "--porcelain") == "", "worktree not clean after seal")
    return "PASS_AMENDMENT_READY_FOR_JOINT_APPROVAL"


def main() -> int:
    script = Path(__file__).resolve()
    repo = Path(git(script.parent, "rev-parse", "--show-toplevel"))
    require(git(repo, "symbolic-ref", "--quiet", "--short", "HEAD") == CONTROL_BRANCH, "wrong control branch")
    package = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / PACKAGE_REL
    require(package == repo / PACKAGE_REL, "unexpected Amendment A package path")
    validate_payload(package, repo)
    state = validate_seal_if_present(repo, package)
    print(state)
    print("execution_authorized=false")
    print("fc01b_started=false")
    print("m00_started=false")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EvaluationError as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(1)
