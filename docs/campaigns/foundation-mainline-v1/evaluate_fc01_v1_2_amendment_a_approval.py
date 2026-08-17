#!/usr/bin/env python3
"""Validate direct GitHub-comment Amendment A approval receipts.

The evaluator is read-only.  It first replays the sealed payload evaluator at
the seal commit, then verifies append-only decision commits and authenticates
each human decision against an immutable GitHub issue comment via ``gh api``.
Conversation text, operator assertions, and uncommitted files are never
approval authority.
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
from urllib.parse import quote

UTC = getattr(dt, "UTC", dt.timezone.utc)  # noqa: UP017 - Python 3.9 compatibility

AMENDMENT_ID = "FC-01-v1.2-AMENDMENT-A"
CONTROL_BRANCH = "campaign/fc01-control-v1"
GOVERNANCE_REPOSITORY = "davidelaverga/Sophia-Agent"
IDENTITY_METHOD = "GITHUB_ISSUE_COMMENT_V1"
DAVIDE_GITHUB_LOGIN = "davidelaverga"

CAMPAIGN_DIR_REL = Path("docs/campaigns/foundation-mainline-v1")
EVIDENCE_DIR_REL = CAMPAIGN_DIR_REL / "evidence"
PACKAGE_REL = EVIDENCE_DIR_REL / "fc01-v1.2-amendment-a-20260817t151323z"
MAIN_EVALUATOR_REL = CAMPAIGN_DIR_REL / "evaluate_fc01_v1_2_amendment_a.py"

DECISION_DIR_RE = re.compile(
    r"fc01-v1\.2-amendment-a-decisions-[0-9]{8}t[0-9]{6}z"
)
DECISION_FILES = ("davide-decision.json", "luis-decision.json")
AGGREGATE_FILE = "joint-approval-receipt.json"
EXPECTED_ROLES = {
    "Davide": "OPERATIONAL_APPROVER",
    "Luis": "EXPERIENCE_ACCESSIBILITY_APPROVER",
}
LOGIN_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?")
TOKEN_RE = re.compile(r"[A-Za-z0-9._:-]{16,128}")
SCHEMA_TOP_LEVEL_FIELDS = {
    "schema_version",
    "amendment_id",
    "current_state",
    "execution_authorized",
    "decision_directory_pattern",
    "github_issue_comment_identity",
    "git_commit_protocol",
    "canonicalization",
    "immutable_unsigned_payload_binding_keys",
    "decision_record_exact_fields",
    "canonical_decision_payload_exact_fields",
    "evidence_operator_exact_fields",
    "aggregate_receipt_exact_fields",
    "canonical_revocation_payload_exact_fields",
    "decision_values",
    "time_contract",
    "revocation_contract",
    "aggregate_effect",
    "failure_state_rules",
    "approval_effect",
}


class ApprovalError(RuntimeError):
    """A fail-closed approval-evaluation result."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ApprovalError(message)


def identity_failure(message: str) -> None:
    raise ApprovalError(f"BLOCKED_IDENTITY_ASSURANCE: {message}")


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ApprovalError(f"invalid JSON {path}: {exc}") from exc
    require(isinstance(value, dict), f"not an object: {path}")
    return value


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha(path: Path) -> str:
    return sha_bytes(path.read_bytes())


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def parse_time(value: Any, label: str) -> dt.datetime:
    require(isinstance(value, str) and value.endswith("Z"), f"{label} is not UTC Z")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ApprovalError(f"invalid {label}") from exc
    require(parsed.tzinfo is not None, f"{label} is timezone-naive")
    return parsed


def exact_keys(value: dict[str, Any], fields: list[str], label: str) -> None:
    require(len(fields) == len(set(fields)), f"duplicate schema fields for {label}")
    require(set(value) == set(fields), f"{label} field set mismatch")


def run(
    args: list[str],
    *,
    cwd: Path,
    identity: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        proc = subprocess.run(
            args,
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        if identity:
            identity_failure("gh is unavailable")
        raise ApprovalError(f"command unavailable: {args[0]}") from exc
    if proc.returncode:
        if identity:
            identity_failure("GitHub authentication or read access is unavailable")
        detail = proc.stderr.strip() or proc.stdout.strip() or "nonzero exit"
        raise ApprovalError(f"command failed ({args[0]}): {detail}")
    return proc


def git(repo: Path, *args: str) -> str:
    return run(["git", *args], cwd=repo).stdout.strip()


def git_is_ancestor(repo: Path, older: str, newer: str) -> bool:
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", older, newer],
        cwd=repo,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return proc.returncode == 0


def gh_json(repo: Path, endpoint: str) -> Any:
    proc = run(
        ["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint],
        cwd=repo,
        identity=True,
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        identity_failure("GitHub returned invalid JSON")


def gh_issue_comments(repo: Path, repository: str, issue_number: int) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    for page in range(1, 1001):
        endpoint = (
            f"repos/{repository}/issues/{issue_number}/comments"
            f"?per_page=100&page={page}"
        )
        value = gh_json(repo, endpoint)
        if not isinstance(value, list):
            identity_failure("GitHub issue-comment listing is not an array")
        if not all(isinstance(item, dict) for item in value):
            identity_failure("GitHub issue-comment listing contains a non-object")
        comments.extend(value)
        if len(value) < 100:
            return comments
    identity_failure("GitHub issue-comment pagination exceeded the safety limit")


def load_schema(package: Path) -> dict[str, Any]:
    schema = load(package / "approval-receipt-schema.json")
    require(set(schema) == SCHEMA_TOP_LEVEL_FIELDS, "approval schema field set mismatch")
    require(schema["schema_version"] == 2, "approval schema version mismatch")
    require(schema["amendment_id"] == AMENDMENT_ID, "approval schema amendment mismatch")
    design = schema["github_issue_comment_identity"]
    require(design["only_allowed_method"] == IDENTITY_METHOD, "identity method drift")
    require(design["governance_repository"] == GOVERNANCE_REPOSITORY, "governance repository drift")
    require(design["davide_actor_login"] == DAVIDE_GITHUB_LOGIN, "Davide actor drift")
    for field_name in (
        "immutable_unsigned_payload_binding_keys",
        "decision_record_exact_fields",
        "canonical_decision_payload_exact_fields",
        "evidence_operator_exact_fields",
        "aggregate_receipt_exact_fields",
        "canonical_revocation_payload_exact_fields",
    ):
        fields = schema[field_name]
        require(
            isinstance(fields, list)
            and fields
            and all(isinstance(field, str) and field for field in fields)
            and len(fields) == len(set(fields)),
            f"invalid schema field list: {field_name}",
        )
    return schema


def find_seal_path(repo: Path) -> Path:
    paths = sorted(
        (repo / EVIDENCE_DIR_REL).glob(
            "fc01-v1.2-amendment-a-seal-*/seal-receipt.json"
        )
    )
    require(len(paths) == 1, "exactly one seal receipt is required")
    path = paths[0]
    require(path.is_file() and not path.is_symlink(), "seal receipt is not a regular file")
    return path


def introducing_commit(repo: Path, relative_path: str, label: str) -> str:
    commits = git(repo, "log", "--format=%H", "--", relative_path).splitlines()
    require(len(commits) == 1, f"{label} must be added once and never modified")
    commit = commits[0]
    status_lines = git(
        repo,
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        commit,
    ).splitlines()
    require(f"A\t{relative_path}" in status_lines, f"{label} was not added immutably")
    return commit


def validate_control_head(repo: Path) -> str:
    require(git(repo, "symbolic-ref", "--short", "HEAD") == CONTROL_BRANCH, "wrong control branch")
    require(
        git(repo, "status", "--porcelain=v1", "--untracked-files=all") == "",
        "approval evaluation requires a clean worktree",
    )
    return git(repo, "rev-parse", "HEAD")


def replay_main_seal_evaluator(repo: Path) -> None:
    """Run the current sealed main evaluator at the clean control descendant."""

    evaluator = repo / MAIN_EVALUATOR_REL
    package = repo / PACKAGE_REL
    proc = run([sys.executable, str(evaluator), str(package)], cwd=repo)
    lines = proc.stdout.splitlines()
    require(
        lines and lines[0] == "PASS_AMENDMENT_READY_FOR_JOINT_APPROVAL",
        "main evaluator did not prove the seal ready",
    )
    require("execution_authorized=false" in lines, "main evaluator over-authorized execution")


def validate_seal(repo: Path, head: str, schema: dict[str, Any]) -> tuple[Path, dict[str, Any], str, dict[str, Any], dt.datetime]:
    seal_path = find_seal_path(repo)
    seal_rel = seal_path.relative_to(repo).as_posix()
    seal_commit = introducing_commit(repo, seal_rel, "seal receipt")
    require(git_is_ancestor(repo, seal_commit, head), "seal commit is not an ancestor of HEAD")

    replay_main_seal_evaluator(repo)
    seal = load(seal_path)
    require(seal["amendment_id"] == AMENDMENT_ID, "seal amendment mismatch")
    require(seal["state"] == "AMENDMENT_READY_FOR_JOINT_APPROVAL", "seal state mismatch")
    require(seal["execution_authorized"] is False, "seal authorizes execution")
    seal_time = parse_time(seal["created_at"], "seal.created_at")
    now = dt.datetime.now(UTC)
    require(seal_time <= now, "seal timestamp is in the future")

    binding_keys = schema["immutable_unsigned_payload_binding_keys"]
    bindings = seal["unsigned_payload_bindings"]
    require(isinstance(bindings, dict), "seal unsigned payload bindings are not an object")
    exact_keys(bindings, binding_keys, "seal unsigned payload bindings")
    return seal_path, seal, seal_commit, bindings, seal_time


def decision_directories(repo: Path) -> list[Path]:
    result: list[Path] = []
    for path in (repo / EVIDENCE_DIR_REL).iterdir():
        if path.is_dir() and DECISION_DIR_RE.fullmatch(path.name):
            result.append(path.resolve())
    return sorted(result)


def resolve_decision_directory(repo: Path) -> Path | None:
    discovered = decision_directories(repo)
    if len(sys.argv) == 1:
        require(len(discovered) <= 1, "multiple governed decision directories")
        return discovered[0] if discovered else None
    require(len(sys.argv) == 2, "usage: approval-evaluator [decision-directory]")
    candidate = Path(sys.argv[1])
    if not candidate.is_absolute():
        candidate = (Path.cwd() / candidate).resolve()
    else:
        candidate = candidate.resolve()
    require(candidate.parent == (repo / EVIDENCE_DIR_REL).resolve(), "decision directory is outside governed evidence")
    require(DECISION_DIR_RE.fullmatch(candidate.name) is not None, "decision directory name mismatch")
    require(discovered == [candidate], "decision directory discovery mismatch")
    return candidate


def validate_decision_commits(repo: Path, seal_commit: str, decision_dir: Path, head: str) -> None:
    require(decision_dir.is_dir() and not decision_dir.is_symlink(), "decision directory missing or symlinked")
    expected_files = {*DECISION_FILES, AGGREGATE_FILE}
    on_disk = {path.name for path in decision_dir.iterdir() if path.is_file()}
    require(on_disk == expected_files, "decision directory file set mismatch")
    require(all(not (decision_dir / name).is_symlink() for name in expected_files), "decision file symlink prohibited")

    relative_dir = decision_dir.relative_to(repo).as_posix()
    expected_paths = {f"{relative_dir}/{name}" for name in expected_files}
    commits = git(repo, "rev-list", "--reverse", f"{seal_commit}..{head}").splitlines()
    require(len(commits) >= 3, "approval requires two decision commits and one aggregate commit")

    changed_by_commit: list[list[str]] = []
    evidence_prefix = EVIDENCE_DIR_REL.as_posix() + "/"
    for index, commit in enumerate(commits):
        parents = git(repo, "show", "-s", "--format=%P", commit).split()
        require(len(parents) == 1, "merge commit prohibited in approval range")
        status_lines = git(
            repo,
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            commit,
        ).splitlines()
        require(status_lines and all(line.startswith("A\t") for line in status_lines), "approval commits must only add files")
        paths = [line.split("\t", 1)[1] for line in status_lines]
        if index < 3:
            require(set(paths) <= expected_paths, "decision-sequence commit escaped its decision directory")
        else:
            require(
                all(path.startswith(evidence_prefix) for path in paths),
                "later control commit is not evidence-only",
            )
            require(
                all(not path.startswith(relative_dir + "/") for path in paths),
                "later commit changed the immutable decision directory",
            )
        changed_by_commit.append(paths)

    davide_rel = f"{relative_dir}/davide-decision.json"
    luis_rel = f"{relative_dir}/luis-decision.json"
    aggregate_rel = f"{relative_dir}/{AGGREGATE_FILE}"
    require(
        {tuple(changed_by_commit[0]), tuple(changed_by_commit[1])}
        == {(davide_rel,), (luis_rel,)},
        "the first two approval commits must separately add Davide and Luis decisions",
    )
    require(changed_by_commit[2] == [aggregate_rel], "the aggregate must be the final additive commit")
    require(git_is_ancestor(repo, commits[2], head), "aggregate commit is not an ancestor of control HEAD")
    for path, expected_commit in (
        (davide_rel, commits[0] if changed_by_commit[0] == [davide_rel] else commits[1]),
        (luis_rel, commits[0] if changed_by_commit[0] == [luis_rel] else commits[1]),
        (aggregate_rel, commits[2]),
    ):
        history = git(repo, "log", "--format=%H", "--", path).splitlines()
        require(history == [expected_commit], f"decision evidence was modified after add: {path}")


def validate_issue(repo: Path, repository: str, issue_number: int) -> dict[str, Any]:
    issue = gh_json(repo, f"repos/{repository}/issues/{issue_number}")
    if not isinstance(issue, dict):
        identity_failure("GitHub governance issue response is not an object")
    if issue.get("number") != issue_number or "pull_request" in issue:
        identity_failure("governance target is not the exact GitHub issue")
    return issue


def validate_github_user(repo: Path, actor: dict[str, Any], label: str) -> None:
    login = actor.get("github_login")
    actor_id = actor.get("github_id")
    if not isinstance(login, str) or LOGIN_RE.fullmatch(login) is None:
        identity_failure(f"invalid {label} GitHub login")
    if not isinstance(actor_id, int) or isinstance(actor_id, bool) or actor_id <= 0:
        identity_failure(f"invalid {label} GitHub ID")
    user = gh_json(repo, f"users/{quote(login, safe='')}")
    if not isinstance(user, dict) or user.get("login") != login or user.get("id") != actor_id:
        identity_failure(f"{label} GitHub login/ID does not resolve")


def canonical_revocation(schema: dict[str, Any], decision_id: str, comment_id: int) -> str:
    payload = {
        "schema_version": 1,
        "record_type": "FC01_AMENDMENT_DECISION_REVOCATION_V1",
        "amendment_id": AMENDMENT_ID,
        "decision_id": decision_id,
        "decision_comment_id": comment_id,
    }
    exact_keys(payload, schema["canonical_revocation_payload_exact_fields"], "canonical revocation payload")
    return canonical_json(payload)


def check_revocation(
    schema: dict[str, Any],
    comments: list[dict[str, Any]],
    comment: dict[str, Any],
    payload: dict[str, Any],
) -> None:
    user = comment["user"]
    expected_body = canonical_revocation(schema, payload["decision_id"], comment["id"])
    for later in comments:
        later_user = later.get("user") or {}
        if (
            isinstance(later.get("id"), int)
            and later["id"] > comment["id"]
            and later_user.get("login") == user.get("login")
            and later_user.get("id") == user.get("id")
            and later.get("body") == expected_body
        ):
            raise ApprovalError(f"BLOCKED_REVOKED: {payload['approver_display_name']} decision revoked")


def verify_listed_comment(
    comments: list[dict[str, Any]],
    comment: dict[str, Any],
    label: str,
) -> None:
    listed = [item for item in comments if item.get("id") == comment.get("id")]
    if len(listed) != 1:
        identity_failure(f"{label} decision comment is absent from the issue listing")
    listed_comment = listed[0]
    for field in (
        "id",
        "node_id",
        "html_url",
        "issue_url",
        "body",
        "created_at",
        "updated_at",
    ):
        if listed_comment.get(field) != comment.get(field):
            identity_failure(f"{label} decision comment changed during verification")
    listed_user = listed_comment.get("user") or {}
    direct_user = comment.get("user") or {}
    if (
        listed_user.get("login") != direct_user.get("login")
        or listed_user.get("id") != direct_user.get("id")
        or listed_user.get("type") != direct_user.get("type")
    ):
        identity_failure(f"{label} decision actor changed during verification")


def validate_decision(
    *,
    repo: Path,
    path: Path,
    expected_name: str,
    schema: dict[str, Any],
    bindings: dict[str, Any],
    seal_time: dt.datetime,
    budget_expiry: dt.datetime,
    now: dt.datetime,
    issue_cache: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    record = load(path)
    exact_keys(record, schema["decision_record_exact_fields"], f"{expected_name} decision record")
    require(record["schema_version"] == 1, f"{expected_name} record schema mismatch")
    require(record["record_type"] == "GITHUB_ISSUE_COMMENT_DECISION_RECEIPT_V1", f"{expected_name} record type mismatch")
    require(record["amendment_id"] == AMENDMENT_ID, f"{expected_name} amendment mismatch")
    require(record["identity_assurance_method"] == IDENTITY_METHOD, f"{expected_name} identity method mismatch")
    require(record["github_repository"] == GOVERNANCE_REPOSITORY, f"{expected_name} repository mismatch")

    issue_number = record["github_issue_number"]
    comment_id = record["github_comment_id"]
    if not isinstance(issue_number, int) or isinstance(issue_number, bool) or issue_number <= 0:
        identity_failure(f"invalid {expected_name} governance issue number")
    if not isinstance(comment_id, int) or isinstance(comment_id, bool) or comment_id <= 0:
        identity_failure(f"invalid {expected_name} comment ID")
    if issue_number not in issue_cache:
        issue_cache[issue_number] = validate_issue(
            repo,
            GOVERNANCE_REPOSITORY,
            issue_number,
        )
    issue = issue_cache[issue_number]

    comment = gh_json(
        repo,
        f"repos/{GOVERNANCE_REPOSITORY}/issues/comments/{comment_id}",
    )
    if not isinstance(comment, dict) or comment.get("id") != comment_id:
        identity_failure(f"{expected_name} GitHub comment is unavailable")
    if comment.get("issue_url") != issue.get("url"):
        identity_failure(f"{expected_name} comment belongs to another issue")
    user = comment.get("user")
    if not isinstance(user, dict) or user.get("type") != "User":
        identity_failure(f"{expected_name} comment has no direct user actor")

    fetched_fields = {
        "github_comment_node_id": comment.get("node_id"),
        "github_comment_url": comment.get("html_url"),
        "github_actor_login": user.get("login"),
        "github_actor_id": user.get("id"),
        "github_created_at": comment.get("created_at"),
        "github_updated_at": comment.get("updated_at"),
    }
    for field, value in fetched_fields.items():
        if record[field] != value:
            identity_failure(f"{expected_name} {field} does not match GitHub")
    if comment.get("created_at") != comment.get("updated_at"):
        identity_failure(f"{expected_name} decision comment was edited")
    created = parse_time(comment.get("created_at"), f"{expected_name} GitHub created_at")
    require(created <= now, f"{expected_name} decision timestamp is in the future")
    require(seal_time <= created, f"{expected_name} decision predates the seal")

    payload = record["canonical_decision_payload"]
    require(isinstance(payload, dict), f"{expected_name} canonical payload is not an object")
    exact_keys(payload, schema["canonical_decision_payload_exact_fields"], f"{expected_name} canonical payload")
    require(comment.get("body") == canonical_json(payload), f"{expected_name} comment body is not the exact canonical payload")
    require(payload["schema_version"] == 1, f"{expected_name} payload schema mismatch")
    require(payload["record_type"] == "FC01_AMENDMENT_DECISION_V1", f"{expected_name} payload type mismatch")
    require(payload["amendment_id"] == AMENDMENT_ID, f"{expected_name} payload amendment mismatch")
    require(payload["approval_scope"] == "FC01A_R_ONLY", f"{expected_name} approval scope mismatch")
    require(payload["approver_display_name"] == expected_name, f"{expected_name} display name mismatch")
    require(payload["approver_role"] == EXPECTED_ROLES[expected_name], f"{expected_name} role mismatch")
    require(payload["decision"] in {"APPROVE", "REJECT"}, f"{expected_name} decision invalid")
    require(payload["governance_repository"] == GOVERNANCE_REPOSITORY, f"{expected_name} payload repository mismatch")
    require(payload["governance_issue_number"] == issue_number, f"{expected_name} payload issue mismatch")
    require(payload["unsigned_payload_bindings"] == bindings, f"{expected_name} payload binding drift")
    require(isinstance(payload["decision_statement"], str) and payload["decision_statement"].strip(), f"{expected_name} statement empty")
    require(isinstance(payload["decision_id"], str) and TOKEN_RE.fullmatch(payload["decision_id"]), f"{expected_name} decision ID invalid")
    require(isinstance(payload["nonce"], str) and TOKEN_RE.fullmatch(payload["nonce"]), f"{expected_name} nonce invalid")

    expires = parse_time(payload["expires_at"], f"{expected_name} expires_at")
    require(created < expires, f"{expected_name} decision expires at or before creation")
    require(now < expires, f"BLOCKED_EXPIRED: {expected_name} decision expired")
    require(expires <= budget_expiry, f"{expected_name} expiration exceeds repair-budget expiry")

    luis_login = payload["designated_luis_github_login"]
    luis_id = payload["designated_luis_github_id"]
    if not isinstance(luis_login, str) or LOGIN_RE.fullmatch(luis_login) is None:
        identity_failure("Davide-designated Luis login is invalid")
    if not isinstance(luis_id, int) or isinstance(luis_id, bool) or luis_id <= 0:
        identity_failure("Davide-designated Luis ID is invalid")
    operator = payload["evidence_operator"]
    require(isinstance(operator, dict), "evidence operator is not an object")
    exact_keys(operator, schema["evidence_operator_exact_fields"], "evidence operator")
    validate_github_user(repo, operator, "evidence operator")

    return {
        "record": record,
        "payload": payload,
        "comment": comment,
        "created": created,
        "expires": expires,
    }


def validate_aggregate(
    *,
    path: Path,
    decision_dir: Path,
    schema: dict[str, Any],
    bindings: dict[str, Any],
    seal_path: Path,
    repo: Path,
    davide: dict[str, Any],
    luis: dict[str, Any],
    budget_expiry: dt.datetime,
    now: dt.datetime,
) -> None:
    aggregate = load(path)
    exact_keys(aggregate, schema["aggregate_receipt_exact_fields"], "joint aggregate")
    require(aggregate["schema_version"] == 1, "aggregate schema mismatch")
    require(aggregate["record_type"] == "FC01_AMENDMENT_JOINT_APPROVAL_RECEIPT_V1", "aggregate type mismatch")
    require(aggregate["amendment_id"] == AMENDMENT_ID, "aggregate amendment mismatch")
    require(aggregate["approval_scope"] == "FC01A_R_ONLY", "aggregate approval scope mismatch")
    require(aggregate["identity_assurance_method"] == IDENTITY_METHOD, "aggregate identity method mismatch")
    require(aggregate["github_repository"] == GOVERNANCE_REPOSITORY, "aggregate repository mismatch")
    require(
        aggregate["governance_issue_number"]
        == davide["payload"]["governance_issue_number"]
        == luis["payload"]["governance_issue_number"],
        "decisions do not use the same governance issue",
    )
    require(aggregate["davide_decision_path"] == "davide-decision.json", "aggregate Davide path mismatch")
    require(aggregate["luis_decision_path"] == "luis-decision.json", "aggregate Luis path mismatch")
    require(aggregate["davide_decision_sha256"] == sha(decision_dir / DECISION_FILES[0]), "aggregate Davide digest mismatch")
    require(aggregate["luis_decision_sha256"] == sha(decision_dir / DECISION_FILES[1]), "aggregate Luis digest mismatch")
    require(aggregate["seal_receipt_path"] == seal_path.relative_to(repo).as_posix(), "aggregate seal path mismatch")
    require(aggregate["seal_receipt_sha256"] == sha(seal_path), "aggregate seal digest mismatch")
    require(aggregate["unsigned_payload_bindings"] == bindings, "aggregate binding drift")
    require(aggregate["joint_result"] == "APPROVED", "aggregate is not approved")
    require(aggregate["evidence_operator"] == davide["payload"]["evidence_operator"] == luis["payload"]["evidence_operator"], "evidence operator mismatch")

    evaluated = parse_time(aggregate["evaluated_at"], "aggregate evaluated_at")
    approval_expires = parse_time(aggregate["approval_expires_at"], "aggregate approval_expires_at")
    require(max(davide["created"], luis["created"]) <= evaluated <= now, "aggregate evaluation time invalid")
    expected_expiry = min(davide["expires"], luis["expires"], budget_expiry)
    require(approval_expires == expected_expiry and evaluated < approval_expires, "aggregate expiry mismatch")
    require(aggregate["fc01a_r_execution_authorized"] is True, "aggregate does not activate FC-01A-R")
    for field in ("deployment_authorized", "baseline_frozen", "fc01b_started", "m00_started"):
        require(aggregate[field] is False, f"aggregate over-authorizes {field}")


def main() -> int:
    script = Path(__file__).resolve()
    repo = Path(git(script.parent, "rev-parse", "--show-toplevel"))
    package = repo / PACKAGE_REL
    schema = load_schema(package)
    head = validate_control_head(repo)
    seal_path, _seal, seal_commit, bindings, seal_time = validate_seal(
        repo,
        head,
        schema,
    )

    manifest = load(package / "amendment-manifest.json")
    contract = load(package / "approval-contract.json")
    require(manifest["approvals"] == {"davide": None, "luis": None}, "payload decision slots changed")
    require(contract["immutable_payload_decision_slots"]["davide_operational"] is None, "embedded Davide decision")
    require(contract["immutable_payload_decision_slots"]["luis_experience_accessibility"] is None, "embedded Luis decision")

    budget = load(package / "repair-budget.json")
    budget_expiry = parse_time(budget["activation"]["expires_at"], "repair budget expiry")
    now = dt.datetime.now(UTC)
    require(now < budget_expiry, "BLOCKED_EXPIRED: repair budget expired")

    decision_dir = resolve_decision_directory(repo)
    if decision_dir is None:
        require(head == seal_commit, "unclassified commit exists after the seal")
        print("BLOCKED_AWAITING_JOINT_APPROVAL")
        print("execution_authorized=false")
        print(f"seal_receipt_sha256={sha(seal_path)}")
        return 0

    validate_decision_commits(repo, seal_commit, decision_dir, head)
    issue_cache: dict[int, dict[str, Any]] = {}
    davide = validate_decision(
        repo=repo,
        path=decision_dir / "davide-decision.json",
        expected_name="Davide",
        schema=schema,
        bindings=bindings,
        seal_time=seal_time,
        budget_expiry=budget_expiry,
        now=now,
        issue_cache=issue_cache,
    )
    if davide["comment"]["user"]["login"] != DAVIDE_GITHUB_LOGIN:
        identity_failure("Davide actor is not davidelaverga")

    luis = validate_decision(
        repo=repo,
        path=decision_dir / "luis-decision.json",
        expected_name="Luis",
        schema=schema,
        bindings=bindings,
        seal_time=seal_time,
        budget_expiry=budget_expiry,
        now=now,
        issue_cache=issue_cache,
    )
    designated_login = davide["payload"]["designated_luis_github_login"]
    designated_id = davide["payload"]["designated_luis_github_id"]
    if not (
        luis["comment"]["user"]["login"] == designated_login
        and luis["comment"]["user"]["id"] == designated_id
    ):
        identity_failure("Luis GitHub actor does not match Davide's designation")
    require(
        luis["payload"]["designated_luis_github_login"] == designated_login
        and luis["payload"]["designated_luis_github_id"] == designated_id,
        "Luis payload does not echo Davide's designation",
    )
    require(davide["payload"]["decision_id"] != luis["payload"]["decision_id"], "decision ID reused")
    require(davide["payload"]["nonce"] != luis["payload"]["nonce"], "decision nonce reused")
    governance_issue = davide["payload"]["governance_issue_number"]
    require(
        luis["payload"]["governance_issue_number"] == governance_issue,
        "decisions do not use the same governance issue",
    )
    fresh_comments = gh_issue_comments(repo, GOVERNANCE_REPOSITORY, governance_issue)
    for label, decision in (("Davide", davide), ("Luis", luis)):
        verify_listed_comment(fresh_comments, decision["comment"], label)
        check_revocation(schema, fresh_comments, decision["comment"], decision["payload"])
    if davide["payload"]["decision"] == "REJECT" or luis["payload"]["decision"] == "REJECT":
        raise ApprovalError("BLOCKED_REJECTED")

    validate_aggregate(
        path=decision_dir / AGGREGATE_FILE,
        decision_dir=decision_dir,
        schema=schema,
        bindings=bindings,
        seal_path=seal_path,
        repo=repo,
        davide=davide,
        luis=luis,
        budget_expiry=budget_expiry,
        now=now,
    )
    print("PASS_AMENDMENT_APPROVED_FC01A_R_ONLY")
    print("deployment_authorized=false")
    print("baseline_frozen=false")
    print("fc01b_started=false")
    print("m00_started=false")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ApprovalError, KeyError, TypeError, ValueError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        raise SystemExit(1)
