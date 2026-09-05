"""Bounded deployed R3 probe; prints structural evidence, never provider text.

Run inside the deployed backend uv environment, with an explicit fresh run ID.
This is not a full production canary or a canonical consent bypass. Its isolated
provider subjects have no canonical bindings and therefore cannot authorize hits.
"""

import argparse
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5


def subject_for(run_id, ordinal):
    if not re.fullmatch(r"mem00-dp007-[0-9]{8}T[0-9]{6}Z(?:-full)?", run_id):
        raise ValueError("invalid_synthetic_run_id")
    if ordinal not in (0, 1):
        raise ValueError("invalid_synthetic_subject_ordinal")
    return "sophia-memory-v2:mem00-cert:" + str(uuid5(NAMESPACE_URL, run_id + str(ordinal)))


def probe(run_id, fixture_count=1, *, expected_commit):
    from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter
    from deerflow.sophia.memory_governance.runtime_pin import runtime_pin

    logging.disable(logging.CRITICAL)
    if fixture_count not in (1, 3):
        raise ValueError("invalid_fixture_count")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        raise ValueError("invalid_expected_commit")
    subjects = [subject_for(run_id, i) for i in range(2)]
    pin = runtime_pin()
    assert pin["commit"] == expected_commit
    assert pin["reference_key_fingerprint"] == "sha256:70c4ec6052335991"
    assert pin["credential_fingerprint"] == "sha256:8388812563a212e0"
    assert pin["sdk"] == "1.0.9" and pin["endpoint_matches_pin"]
    assert pin["provider_project_matches"]
    assert pin["flags"]["PROVIDER_PROJECTION"] is False
    assert pin["flags"]["GOVERNED_RUNTIME_READ"] is False
    adapter = Mem0ProjectionAdapter()
    client = adapter._get_client()
    assert client.project_id == os.environ["MEM0_PROJECT_ID"]
    assert client.org_id == os.environ["MEM0_ORG_ID"]
    receipt = {
        "run_id": run_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "runtime_pin": pin,
        "subject_refs": [hashlib.sha256(s.encode()).hexdigest()[:16] for s in subjects],
        "status": "failed",
        "created": 0,
        "checks": [],
        "cleanup": [],
        "full_product_canary": False,
    }

    def enumerate_ids(subject):
        return {
            str(row["id"]): row
            for page in adapter._all_pages(provider_subject=subject, page_size=1, max_pages=20)
            for row in page
        }

    # Never adopt or delete pre-existing/unknown rows under a reused run ID.
    assert all(not enumerate_ids(s) for s in subjects), "synthetic_subject_not_empty"
    expected_by_subject = {s: {} for s in subjects}
    expected_content = {}
    try:
        for index in range(fixture_count):
            subject = subjects[1 if index == 2 else 0]
            operation = str(uuid5(NAMESPACE_URL, run_id + ":operation:" + str(index)))
            metadata = {
                "sophia_managed": True,
                "memory_contract_epoch": 1,
                "environment": "production",
                "provider_namespace": subject,
                "canonical_memory_id": str(uuid5(NAMESPACE_URL, operation)),
                "canonical_revision": 1,
                "memory_governance_revision": 1,
                "projection_operation_id": operation,
                "certification_run_id": run_id,
            }
            expected_by_subject[subject][operation] = metadata
            content = f"SYNTHETIC MEM00 {run_id} fixture {index}: the imaginary test badge is cobalt-{index}."
            result = adapter.project_revision(canonical_content=content, provider_subject=subject, metadata=metadata)
            assert len(result.provider_ids) == 1 and result.metadata_verified
            receipt["created"] += 1
            expected_content[result.provider_ids[0]] = content
            stored = client.get(result.provider_ids[0])
            assert stored.get("memory") == content, "direct_content_changed"
            for _ in range(2):
                reconciled = adapter.find_by_operation_marker(provider_subject=subject, projection_operation_id=operation, expected_metadata=metadata, page_size=1)
                assert reconciled == result.provider_ids, "operation_reconciliation_mismatch"
            hits = adapter.search_ids(query=f"imaginary test badge cobalt-{index}", provider_subject=subject, metadata_filter={}, limit=10)
            assert result.provider_ids[0] in {h.provider_memory_id for h in hits}, "search_missing_fixture"
            receipt["checks"].append({"fixture": index, "direct_content_exact": True, "initial_metadata": True, "repeat_reconciliation": True, "search": True})
        expected_counts = [2, 1] if fixture_count == 3 else [1, 0]
        observed = [enumerate_ids(s) for s in subjects]
        assert [len(rows) for rows in observed] == expected_counts, "pagination_cardinality"
        assert not set(observed[0]).intersection(observed[1]), "cross_subject_id_collision"
        for identity, content in expected_content.items():
            assert client.get(identity).get("memory") == content, "another_fixture_changed"
        for subject, rows in zip(subjects, observed):
            hits = adapter.search_ids(query="imaginary test badge cobalt", provider_subject=subject, metadata_filter={}, limit=10)
            assert {hit.provider_memory_id for hit in hits}.issubset(rows), "cross_subject_search_leak"
        receipt["prior_fixtures_unchanged"] = True
        receipt["search_subject_isolation"] = True
        receipt["pagination_counts"] = expected_counts
        receipt["status"] = "contract_checks_passed_cleanup_pending"
    except Exception as error:
        receipt["failure"] = {"type": type(error).__name__, "reason": getattr(error, "reason", "probe_assertion_or_transport")}
    finally:
        for subject in subjects:
            cleanup = {"subject_ref": hashlib.sha256(subject.encode()).hexdigest()[:16]}
            try:
                rows = enumerate_ids(subject)
                operations = expected_by_subject[subject]
                verified_ids = {
                    identity
                    for operation, metadata in operations.items()
                    for identity in adapter.find_by_operation_marker(
                        provider_subject=subject, projection_operation_id=operation, expected_metadata=metadata, page_size=1, max_pages=20
                    )
                }
                assert verified_ids == set(rows), "unknown_row_cleanup_refused"
                if rows:
                    adapter.delete_ids(rows.keys(), provider_subject=subject)
                cleanup["terminal_count"] = len(enumerate_ids(subject))
                cleanup["verified_zero"] = cleanup["terminal_count"] == 0
            except Exception as error:
                cleanup.update(verified_zero=False, error_type=type(error).__name__, reason=getattr(error, "reason", "cleanup_assertion_or_transport"))
            receipt["cleanup"].append(cleanup)
        if receipt["status"] == "contract_checks_passed_cleanup_pending" and all(c["verified_zero"] for c in receipt["cleanup"]):
            receipt["status"] = "passed"
        else:
            receipt["status"] = "failed"
        receipt["finished_at"] = datetime.now(timezone.utc).isoformat()
        print("MEM00_DP007_RECEIPT=" + json.dumps(receipt, sort_keys=True))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--fixtures", type=int, choices=(1, 3), default=1)
    parser.add_argument("--expected-commit", required=True)
    arguments = parser.parse_args()
    probe(arguments.run_id, arguments.fixtures, expected_commit=arguments.expected_commit)
