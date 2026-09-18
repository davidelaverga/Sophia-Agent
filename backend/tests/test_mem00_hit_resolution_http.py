"""Exact requested-hit preparation never consults Pool or issues final admission."""

import json

import httpx
import pytest

from deerflow.sophia.memory_governance.models import ProviderHit
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore


def resolution():
    return {
        "schema": "mem00.hit-resolution.v1",
        "memory_contract_epoch": 1,
        "owner_id": "owner",
        "provider": "mem0",
        "environment": "synthetic",
        "provider_project": "existing-project",
        "provider_namespace": "namespace",
        "status": "available",
        "final_admission": False,
        "results": [
            {
                "provider_memory_id": "hit-1005",
                "denial_reason": None,
                "memory": {
                    "memory_id": "10000000-0000-4000-8000-000000001004",
                    "user_id": "owner",
                    "lifecycle": "active",
                    "user_tier": "none",
                    "current_content_revision": 2,
                    "memory_governance_revision": 3,
                    "canonical_content": "CURRENT_CANONICAL_TEXT",
                    "content_ref": "current-keyed-ref",
                    "category": "fact",
                    "scope": "global",
                    "projection_state": "active",
                    "created_at": "2026-09-09T00:00:00Z",
                    "updated_at": None,
                },
            }
        ],
    }


@pytest.mark.parametrize(
    "fault",
    [
        "none",
        "outage",
        "owner",
        "namespace",
        "provider",
        "schema",
        "epoch",
        "boolean_epoch",
        "project",
        "environment",
        "extra",
        "missing",
        "duplicate",
        "id",
        "denied_text",
        "final_permit",
        "numeric_false",
        "memory_owner",
        "forgotten",
        "tombstoned",
        "old_revision",
        "boolean_revision",
        "missing_content",
        "oversize",
    ],
)
def test_resolution_strict_http_contract(fault):
    calls = []

    def transport(request):
        calls.append(request)
        assert request.url.path.endswith("/rpc/sophia_memory_resolve_provider_hits") and request.method == "POST"
        assert json.loads(request.content) == {"p_user_id": "owner", "p_provider": "mem0", "p_environment": "synthetic", "p_provider_project": "existing-project", "p_provider_namespace": "namespace", "p_provider_memory_ids": ["hit-1005"]}
        if fault == "outage":
            return httpx.Response(503, text="RAW_PRIVATE_FAILURE")
        value = resolution()
        if fault in {"owner", "namespace", "provider", "schema"}:
            value[{"owner": "owner_id", "namespace": "provider_namespace", "provider": "provider", "schema": "schema"}[fault]] = "wrong"
        if fault == "project":
            value["provider_project"] = "wrong-project"
        if fault == "environment":
            value["environment"] = "wrong-environment"
        if fault == "epoch":
            value["memory_contract_epoch"] = 2
        if fault == "boolean_epoch":
            value["memory_contract_epoch"] = True
        if fault == "extra":
            value["provider_text"] = "UNTRUSTED"
        if fault == "missing":
            value["results"] = []
        if fault == "duplicate":
            value["results"] *= 2
        if fault == "id":
            value["results"][0]["provider_memory_id"] = "another-hit"
        if fault == "denied_text":
            value["results"][0]["denial_reason"] = "inactive_projection"
        if fault == "final_permit":
            value["final_admission"] = True
        if fault == "numeric_false":
            value["final_admission"] = 0
        item = value["results"][0]["memory"] if value["results"] else {}
        if fault == "memory_owner":
            item["user_id"] = "other-owner"
        if fault in {"forgotten", "tombstoned"}:
            item["lifecycle"] = fault
        if fault == "old_revision":
            item["current_content_revision"] = 0
        if fault == "boolean_revision":
            item["current_content_revision"] = True
        if fault == "missing_content":
            item["canonical_content"] = None
        if fault == "oversize":
            item["canonical_content"] = "X" * (2 * 1024 * 1024)
        return httpx.Response(200, json=value)

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        arguments = dict(user_id="owner", provider="mem0", environment="synthetic", provider_project="existing-project", provider_namespace="namespace", hits=(ProviderHit(provider_memory_id="hit-1005", score=0.8),))
        if fault == "none":
            memories, denials = store.authorize_provider_hits(**arguments)
            assert len(memories) == 1 and memories[0][0].canonical_content == "CURRENT_CANONICAL_TEXT"
            assert memories[0][1] == 0.8 and denials == {}
        else:
            with pytest.raises(MemoryGovernanceUnavailable) as caught:
                store.authorize_provider_hits(**arguments)
            assert "RAW_PRIVATE_FAILURE" not in str(caught.value)
        assert len(calls) == 1


@pytest.mark.parametrize("ids,score", [([""], 1), ([" padded "], 1), (["x" * 513], 1), ([str(i) for i in range(101)], 1), (["id"], float("nan")), (["id"], float("inf"))])
def test_malformed_provider_ids_and_scores_never_reach_database(ids, score):
    def transport(request):
        raise AssertionError("malformed hit reached database")

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        with pytest.raises(MemoryGovernanceUnavailable):
            store.authorize_provider_hits(
                user_id="owner", provider="mem0", environment="synthetic", provider_project="existing-project", provider_namespace="namespace", hits=tuple(ProviderHit(provider_memory_id=value, score=score) for value in ids)
            )


@pytest.mark.parametrize("conflicting_copy", [False, True])
def test_multiple_valid_provider_ids_deduplicate_same_current_memory_at_best_provider_rank(conflicting_copy):
    def transport(request):
        body = json.loads(request.content)
        assert body["p_provider_memory_ids"] == ["rank-first", "rank-second"]
        value = resolution()
        first = value["results"][0]
        value["results"] = [{**first, "provider_memory_id": "rank-first"}, {**first, "provider_memory_id": "rank-second"}]
        if conflicting_copy:
            value["results"][1]["memory"] = {**first["memory"], "canonical_content": "INCONSISTENT_CURRENT_COPY"}
        return httpx.Response(200, json=value)

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        arguments = dict(
            user_id="owner",
            provider="mem0",
            environment="synthetic",
            provider_project="existing-project",
            provider_namespace="namespace",
            hits=(ProviderHit(provider_memory_id="rank-first", score=0.6), ProviderHit(provider_memory_id="rank-second", score=0.99)),
        )
        if conflicting_copy:
            with pytest.raises(MemoryGovernanceUnavailable):
                store.authorize_provider_hits(**arguments)
            return
        memories, denials = store.authorize_provider_hits(**arguments)
        assert len(memories) == 1 and memories[0][1] == 0.6
        assert denials == {}


@pytest.mark.parametrize("clock_changes", [False, True])
@pytest.mark.parametrize("fault", [None, "project", "environment", "conflicting_copy"])
def test_reader_http_resolution_deduplicates_and_filters_before_limit(monkeypatch, clock_changes, fault):
    """Real reader + HTTP-store decoder; SQL and final model dispatch are separate proofs."""
    from datetime import UTC, datetime
    from uuid import UUID

    from deerflow.sophia.memory_governance.models import MemoryContract, UserGovernance
    from deerflow.sophia.memory_governance.reader import GovernedMemoryReader
    from deerflow.sophia.memory_governance.service import MemoryProviderContract

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-reader-http-test-key-32-bytes-minimum")
    calls, receipts, clocks = [], [], []
    provider_ids = ["wrong-scope", "rank-first", "rank-duplicate", "second-memory"]
    first_id = "10000000-0000-4000-8000-000000001004"
    second_id = "10000000-0000-4000-8000-000000001005"

    def transport(request):
        assert request.method == "POST"
        assert request.url.path.endswith("/rpc/sophia_memory_resolve_provider_hits")
        payload = json.loads(request.content)
        assert payload == {"p_user_id": "owner", "p_provider": "mem0", "p_environment": "synthetic", "p_provider_project": "existing-project", "p_provider_namespace": "namespace", "p_provider_memory_ids": provider_ids}
        calls.append(payload)
        value = resolution()
        memory = value["results"][0]["memory"]
        value["results"] = [
            {"provider_memory_id": provider_ids[0], "denial_reason": None, "memory": {**memory, "memory_id": "10000000-0000-4000-8000-000000001003", "scope": "private-other-scope", "canonical_content": "EXCLUDED_SCOPE_TEXT"}},
            {"provider_memory_id": provider_ids[1], "denial_reason": None, "memory": dict(memory)},
            {"provider_memory_id": provider_ids[2], "denial_reason": None, "memory": dict(memory)},
            {"provider_memory_id": provider_ids[3], "denial_reason": None, "memory": {**memory, "memory_id": second_id, "canonical_content": "SECOND_CANONICAL_TEXT"}},
        ]
        if fault == "project":
            value["provider_project"] = "wrong-project"
        if fault == "environment":
            value["environment"] = "wrong-environment"
        if fault == "conflicting_copy":
            value["results"][2]["memory"]["canonical_content"] = "INCONSISTENT_COPY"
        return httpx.Response(200, json=value)

    class Adapter:
        def search_ids(self, **kwargs):
            assert kwargs["limit"] == 8
            assert kwargs["provider_subject"] == "namespace"
            return tuple(ProviderHit(provider_memory_id=key, score=score) for key, score in zip(provider_ids, (0.95, 0.6, 0.99, 0.5)))

    def governance(owner):
        assert owner == "owner"
        clocks.append(True)
        return UserGovernance(user_id=owner, user_catalog_generation=4 + int(clock_changes and len(clocks) > 1), user_revocation_epoch=2, provider_subject="namespace")

    def record(payload):
        receipts.append(payload)
        return UUID("20000000-0000-4000-8000-000000000001")

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        monkeypatch.setattr(store, "get_contract", lambda: MemoryContract(contract_epoch=1, schema_version="mem00.v1", mode="enforced", updated_at=datetime.now(UTC)))
        monkeypatch.setattr(store, "get_user_governance", governance)
        monkeypatch.setattr(store, "record_prompt_admission", record)
        reader = GovernedMemoryReader(store=store, adapter=Adapter(), provider=MemoryProviderContract("mem0", "synthetic", "existing-project", 1), service_name="test")
        result = reader.retrieve(owner_id="owner", caller="text", scope="global", query="synthetic query", limit=2)
    if fault:
        assert result.memories == () and result.context_text == ""
        assert result.receipt.safe_reason_code == "governance_unavailable_after_search"
        assert receipts == [] and len(calls) == 1
    else:
        assert [str(memory.memory_id) for memory in result.memories] == [first_id, second_id]
        assert [memory.score for memory in result.memories] == [0.6, 0.5]
        assert result.context_text == "- CURRENT_CANONICAL_TEXT\n- SECOND_CANONICAL_TEXT"
        assert len(calls) == 1 + int(clock_changes)
        assert len(receipts) == 1
        assert [item["memory_id"] for item in receipts[0]["authorized_manifest"]] == [first_id, second_id]
        assert result.receipt.catalog_generation_checked == 4 + int(clock_changes)
