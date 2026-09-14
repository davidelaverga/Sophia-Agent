"""Exact hydration is preparatory; the atomic admission RPC remains mandatory."""

from copy import deepcopy
from uuid import UUID

import httpx
import pytest

from deerflow.sophia.memory_governance.retained_context import MemoryInclusion
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

A, B = UUID(int=1), UUID(int=2)
INCLUSIONS = (MemoryInclusion(A, 2, 3), MemoryInclusion(B, 4, 5))
BASE = [{"memory_id": str(item.memory_id), "user_id": "owner", "lifecycle": "active", "current_content_revision": item.content_revision,
         "memory_governance_revision": item.governance_revision} for item in INCLUSIONS]
VERSIONS = [{"memory_id": str(item.memory_id), "user_id": "owner", "content_revision": item.content_revision,
             "canonical_content": "Canonical synthetic " + str(index), "content_ref": "synthetic-ref", "category": "fact", "scope": "global"}
            for index, item in enumerate(INCLUSIONS)]


def hydrate(base=None, versions=None, inclusions=INCLUSIONS):
    requests = []
    def handle(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.url.params["user_id"] == "eq.owner"
        assert request.url.params["limit"] == "3"
        if request.url.path.endswith("/sophia_memories"):
            assert request.url.params["memory_id"] == f"in.({A},{B})"
            return httpx.Response(200, json=BASE if base is None else base)
        assert request.url.path.endswith("/sophia_memory_versions")
        assert request.url.params["or"] == f"(and(memory_id.eq.{A},content_revision.eq.2),and(memory_id.eq.{B},content_revision.eq.4))"
        return httpx.Response(200, json=VERSIONS if versions is None else versions)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        result = store.hydrate_inclusions(user_id="owner", inclusions=inclusions, scope="text")
    return result, requests


def test_exact_current_versions_rehydrate_in_manifest_order_without_pool_scan():
    result, requests = hydrate(base=list(reversed(BASE)), versions=list(reversed(VERSIONS)))
    assert [item.memory_id for item in result] == [A, B]
    assert [item.canonical_content for item in result] == ["Canonical synthetic 0", "Canonical synthetic 1"]
    assert len(requests) == 2


@pytest.mark.parametrize("field,value", [
    ("user_id", "other-owner"), ("memory_id", str(UUID(int=3))), ("lifecycle", "forgotten"), ("lifecycle", "tombstoned"),
    ("current_content_revision", 1), ("current_content_revision", True), ("current_content_revision", "2"),
    ("memory_governance_revision", 4), ("memory_governance_revision", "3"),
])
def test_base_rows_fail_closed(field, value):
    base = deepcopy(BASE)
    base[0][field] = value
    with pytest.raises(MemoryGovernanceUnavailable):
        hydrate(base=base)


@pytest.mark.parametrize("field,value", [
    ("user_id", "other-owner"), ("memory_id", str(UUID(int=3))), ("content_revision", 1), ("content_revision", "2"),
    ("content_revision", True), ("scope", "builder"), ("canonical_content", None), ("canonical_content", ""),
    ("content_ref", None), ("content_ref", ""),
])
def test_version_rows_fail_closed(field, value):
    versions = deepcopy(VERSIONS)
    versions[0][field] = value
    with pytest.raises(MemoryGovernanceUnavailable):
        hydrate(versions=versions)


@pytest.mark.parametrize("which", ["base", "versions"])
@pytest.mark.parametrize("shape", ["missing", "extra", "duplicate", "not_list"])
def test_incomplete_or_duplicate_observation_cannot_authorize_partial_retention(which, shape):
    original = BASE if which == "base" else VERSIONS
    value = {"missing": original[:1], "extra": original + original[:1], "duplicate": [original[0], original[0]], "not_list": {}}[shape]
    with pytest.raises(MemoryGovernanceUnavailable):
        hydrate(**{which: value})


def test_empty_inclusions_make_no_hydration_calls():
    assert hydrate(inclusions=()) == ((), [])


@pytest.mark.parametrize("inclusions", [(MemoryInclusion("filter-injection", 1, 1),), INCLUSIONS + INCLUSIONS, tuple(MemoryInclusion(UUID(int=i), 1, 1) for i in range(101))])
def test_filter_input_is_strictly_bounded_structural_metadata(inclusions):
    with pytest.raises((ValueError, AttributeError)):
        hydrate(inclusions=inclusions)
