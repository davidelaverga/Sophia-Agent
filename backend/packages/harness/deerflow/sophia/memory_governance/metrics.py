"""Bounded, owner-scoped structural database observations, never authority.

Reads are deliberately non-transactional and cannot certify terminal cleanup.
No plaintext, provider ID, query reference, or authorized manifest is selected.
"""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from uuid import UUID

from .store import SupabaseMemoryGovernanceStore

_TABLES = {
    "extraction": ("sophia_memory_extraction_runs", "extraction_run_id", "state,attempt_count,created_at,terminal_at"),
    "candidates": ("sophia_memory_candidates", "candidate_id", "review_state,scrubbed_at"),
    "canonical": ("sophia_memories", "memory_id", "lifecycle"),
    "projection": ("sophia_memory_projection_jobs", "projection_job_id", "state,operation,attempt_count,created_at,completed_at"),
    "bindings": ("sophia_memory_provider_bindings", "provider_binding_id", "binding_state"),
    "candidate_versions": ("sophia_memory_candidate_versions", "candidate_version_id", "scrubbed_at"),
    "canonical_versions": ("sophia_memory_versions", "memory_version_id", "scrubbed_at"),
    "faults": ("sophia_memory_fault_settings", "fault_setting_id", "remaining_uses,expires_at,cleared_at"),
}
_STATES = {
    "extraction": ("state", frozenset({"queued", "leased", "retry_wait", "succeeded_zero", "succeeded_nonzero", "failed_terminal", "superseded"})),
    "candidates": ("review_state", frozenset({"pending_review", "approved", "rejected", "expired", "legacy_quarantined"})),
    "canonical": ("lifecycle", frozenset({"active", "forgotten", "tombstoned"})),
    "projection": ("state", frozenset({"queued", "leased", "ambiguous", "active", "stale", "purge_queued", "purging", "purged", "failed_retryable", "failed_terminal", "orphaned"})),
    "bindings": ("binding_state", frozenset({"inactive", "eligible", "stale", "purge_queued", "purging", "purged", "orphaned", "reconciliation_hold"})),
}
_BOUNDS_MS = (100, 500, 1000, 5000, 30000, 120000, 600000)


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("metrics_timestamp_invalid")
    result = datetime.fromisoformat(value)
    if result.utcoffset() is None:
        raise ValueError("metrics_timestamp_invalid")
    return result


def _integer(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("metrics_count_invalid")
    return value


def _rows(store: SupabaseMemoryGovernanceStore, owner: str, spec: tuple[str, str, str], *, max_rows: int) -> list[dict]:
    table, key, fields = spec
    rows: list[dict] = []
    cursor: str | None = None
    while True:
        params = {"user_id": f"eq.{owner}", "select": f"{key},{fields}", "order": f"{key}.asc", "limit": "200"}
        if cursor is not None:
            params[key] = f"gt.{cursor}"
        page = store._request("GET", table, params=params)
        if not isinstance(page, list):
            raise ValueError("metrics_page_invalid")
        if not page:
            return rows
        for row in page:
            if not isinstance(row, dict) or set(row) != set((key + "," + fields).split(",")):
                raise ValueError("metrics_row_invalid")
            identifier = str(UUID(row[key]))
            if cursor is not None and identifier <= cursor:
                raise ValueError("metrics_pagination_not_advancing")
            cursor = identifier
            rows.append(row)
        if len(rows) > max_rows:
            raise ValueError("metrics_scan_limit")
        # A service-side row cap can shorten a page. Only an empty page ends it.


def _histogram(rows: list[dict], terminal: str, states: frozenset[str]) -> dict:
    samples = []
    for row in rows:
        if row["state"] in states and row[terminal] is not None:
            sample = (_timestamp(row[terminal]) - _timestamp(row["created_at"])).total_seconds() * 1000
            if sample < 0:
                raise ValueError("metrics_negative_duration")
            samples.append(sample)
    return {"unit": "ms", "count": len(samples), "sum": sum(samples), "buckets_le": {str(bound): sum(v <= bound for v in samples) for bound in _BOUNDS_MS} | {"+Inf": len(samples)}}


def durable_metric_snapshot(store: SupabaseMemoryGovernanceStore, owner: str, *, max_rows: int = 10000) -> dict:
    """Unknown/error returns unavailable, never a fabricated zero measurement."""
    started = datetime.now(UTC)
    base = {"schema": "mem00.durable-metrics.v1", "scope": "authenticated_certification_owner", "started_at": started.isoformat(), "transactionally_consistent": False, "terminal_zero_certified": False}
    try:
        if not owner.strip() or max_rows < 1:
            raise ValueError("metrics_scope_invalid")
        data = {name: _rows(store, owner, spec, max_rows=max_rows) for name, spec in _TABLES.items()}
        gauges = {}
        for name, (field, allowed) in _STATES.items():
            counts = Counter(row[field] for row in data[name])
            if set(counts) - allowed:
                raise ValueError("metrics_unknown_state")
            gauges[name] = {state: counts[state] for state in sorted(allowed)}
        purge = [row for row in data["projection"] if row["operation"] == "purge_binding" and row["state"] != "purged"]
        gauges["purge_backlog"] = len(purge)
        gauges["purge_oldest_age_seconds"] = max([max(0, (started - _timestamp(row["created_at"])).total_seconds()) for row in purge], default=0)
        gauges["active_fault_settings"] = sum(row["cleared_at"] is None and _integer(row["remaining_uses"]) > 0 and _timestamp(row["expires_at"]) > started for row in data["faults"])
        for name in ("candidate_versions", "canonical_versions"):
            gauges[name] = {"retained": len(data[name]), "unscrubbed": sum(row["scrubbed_at"] is None for row in data[name])}
        return base | {
            "available": True,
            "observed_at": datetime.now(UTC).isoformat(),
            "pagination_complete": True,
            "gauges": gauges,
            "retained_attempt_totals": {name: sum(_integer(row["attempt_count"]) for row in data[name]) for name in ("extraction", "projection")},
            "histograms": {
                "extraction_queue_to_success": _histogram(data["extraction"], "terminal_at", frozenset({"succeeded_zero", "succeeded_nonzero"})),
                "projection_queue_to_completion": _histogram(data["projection"], "completed_at", frozenset({"active", "purged"})),
            },
            "missing_coverage": ["provider_domain_inventory", "derived_artifacts_and_caches", "exact_cross_operation_latencies", "atomic_cleanup_snapshot"],
        }
    except Exception:  # noqa: BLE001 - no raw database errors or partial zeroes escape.
        return base | {"available": False, "observed_at": datetime.now(UTC).isoformat(), "pagination_complete": False, "safe_reason_code": "durable_metrics_unavailable"}
