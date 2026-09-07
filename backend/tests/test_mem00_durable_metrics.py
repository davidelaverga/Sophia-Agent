import json
from uuid import UUID

import pytest

from deerflow.sophia.memory_governance.metrics import durable_metric_snapshot


class StructuralStore:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.requests = []

    def _request(self, method, table, *, params):
        assert method == "GET"
        assert params["user_id"] == "eq.synthetic-owner"
        assert "*" not in params["select"]
        assert not {"canonical_content", "proposed_content", "provider_memory_id", "authorized_manifest", "query_ref"}.intersection(params["select"].split(","))
        self.requests.append((table, params))
        key = params["order"].split(".")[0]
        cursor = params.get(key, "gt.")[3:]
        # Deliberately model a server cap smaller than the requested limit.
        return [row for row in self.rows.get(table, []) if row[key] > cursor][:1]


def test_durable_metrics_empty_is_explicitly_not_terminal_cleanup():
    result = durable_metric_snapshot(StructuralStore(), "synthetic-owner")
    assert result["available"] is True
    assert result["pagination_complete"] is True
    assert result["transactionally_consistent"] is False
    assert result["terminal_zero_certified"] is False
    assert result["gauges"]["canonical"]["active"] == 0
    assert "derived_artifacts_and_caches" in result["missing_coverage"]


def test_short_pages_are_not_mistaken_for_exhaustion_and_ids_are_not_exported():
    rows = [{"memory_id": str(UUID(int=i)), "lifecycle": "active"} for i in (1, 2, 3)]
    store = StructuralStore({"sophia_memories": rows})
    result = durable_metric_snapshot(store, "synthetic-owner")
    assert result["available"] is True
    assert result["gauges"]["canonical"]["active"] == 3
    assert len([r for r in store.requests if r[0] == "sophia_memories"]) == 4
    assert all(row["memory_id"] not in json.dumps(result) for row in rows)


@pytest.mark.parametrize("failure", ["transport", "repeat", "limit", "unknown", "extra", "shape"])
def test_failed_or_partial_scan_has_no_zero_gauges(failure):
    row = {"memory_id": str(UUID(int=1)), "lifecycle": "active"}
    store = StructuralStore({"sophia_memories": [row, row | {"memory_id": str(UUID(int=2))}]})
    original = store._request

    def request(method, table, *, params):
        if table == "sophia_memories":
            if failure == "transport":
                raise RuntimeError("private-database-error-sentinel")
            if failure == "repeat":
                return [row]
            if failure == "unknown":
                return [item | {"lifecycle": "private-unknown-sentinel"} for item in original(method, table, params=params)]
            if failure == "extra":
                return [row | {"canonical_content": "private-content-sentinel"}]
            if failure == "shape":
                return {"error": "private-error-sentinel"}
        return original(method, table, params=params)

    store._request = request
    result = durable_metric_snapshot(store, "synthetic-owner", max_rows=1 if failure == "limit" else 10000)
    assert result["available"] is False
    assert result["pagination_complete"] is False
    assert "gauges" not in result
    assert "sentinel" not in json.dumps(result)


def test_queue_latency_is_labelled_as_queue_latency_not_model_duration():
    store = StructuralStore({"sophia_memory_extraction_runs": [{
        "extraction_run_id": str(UUID(int=1)), "state": "succeeded_nonzero", "attempt_count": 2,
        "created_at": "2026-09-07T10:00:00+00:00", "terminal_at": "2026-09-07T10:00:02+00:00",
    }]})
    result = durable_metric_snapshot(store, "synthetic-owner")
    assert result["retained_attempt_totals"]["extraction"] == 2
    assert result["histograms"]["extraction_queue_to_success"]["sum"] == 2000
    assert result["histograms"]["extraction_queue_to_success"]["buckets_le"]["5000"] == 1
