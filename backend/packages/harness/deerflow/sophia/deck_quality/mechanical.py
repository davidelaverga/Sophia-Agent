from __future__ import annotations

from typing import Any

from deerflow.sophia.deck_quality.schemas import MechanicalCheck, MechanicalProjection, QualityEvidenceSnapshot

_REQUIRED_CHECKS = (
    "authoritative_gate",
    "source_retention",
    "native_editability",
    "contrast",
    "native_lint",
    "overflow_collision_clipping",
    "render_success",
    "visual_asset_completeness",
    "artifact_identity",
)


def _normalize_check(check_id: str, value: Any) -> MechanicalCheck:
    if isinstance(value, bool):
        status = "passed" if value else "failed"
        failure_codes = () if value else (f"{check_id}_failed",)
        selectors: tuple[str, ...] = ()
    elif isinstance(value, dict):
        raw_status = str(value.get("status") or "unknown").casefold()
        if raw_status in {"pass", "passed", "success", "ok"}:
            status = "passed"
        elif raw_status in {"fail", "failed", "error"}:
            status = "failed"
        else:
            status = "unknown"
        failure_codes = tuple(str(code) for code in value.get("failure_codes") or ())
        selectors = tuple(str(selector) for selector in value.get("selectors") or ())
    else:
        status = "unknown"
        failure_codes = ()
        selectors = ()
    return MechanicalCheck(
        check_id=check_id,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        failure_codes=failure_codes,
        selectors=selectors,
    )


def project_mechanical_truth(snapshot: QualityEvidenceSnapshot) -> MechanicalProjection:
    """Project stored authoritative facts without asking a model or rerunning policy."""

    raw_checks = snapshot.mechanical_record.get("checks")
    check_map = raw_checks if isinstance(raw_checks, dict) else {}
    checks = tuple(_normalize_check(check_id, check_map.get(check_id)) for check_id in _REQUIRED_CHECKS)
    statuses = {check.status for check in checks}
    if "failed" in statuses:
        status = "failed"
    elif "unknown" in statuses:
        status = "incomplete"
    else:
        status = "passed"
    return MechanicalProjection(
        status=status,
        checks=checks,
        authoritative_record_hash=snapshot.mechanical_record_hash,
    )
