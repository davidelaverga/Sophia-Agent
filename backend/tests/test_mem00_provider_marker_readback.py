"""DP-007: list metadata is stringified; exact-ID metadata stays typed."""

from copy import deepcopy

import pytest

from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ContractError, Mem0ProjectionAdapter


@pytest.fixture
def marker_client(monkeypatch):
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")
    monkeypatch.delenv("MEM0_BASE_URL", raising=False)
    expected = {
        "sophia_managed": True,
        "memory_contract_epoch": 1,
        "environment": "production",
        "provider_namespace": "synthetic-subject",
        "canonical_memory_id": "synthetic-canonical-id",
        "canonical_revision": 1,
        "memory_governance_revision": 1,
        "projection_operation_id": "synthetic-operation",
    }

    class Client:
        def __init__(self):
            self.expected = expected
            self.list_metadata = {key: str(value).lower() if type(value) in (bool, int) else value for key, value in expected.items()}
            self.direct_metadata = deepcopy(expected)
            self.get_error = None
            self.get_calls = []
            self.direct_id = "provider-id"

        def get_all(self, *, filters, page, page_size):
            assert filters == {"user_id": "synthetic-subject"}
            return {"results": [{"id": "provider-id", "metadata": self.list_metadata}]} if page == 1 else {"results": []}

        def get(self, provider_id):
            self.get_calls.append(provider_id)
            if self.get_error:
                raise self.get_error
            return {"id": self.direct_id, "metadata": self.direct_metadata, "memory": "UNTRUSTED PROVIDER TEXT"}

    return Client()


def reconcile(client):
    return Mem0ProjectionAdapter(client=client).find_by_operation_marker(
        provider_subject="synthetic-subject", projection_operation_id="synthetic-operation", expected_metadata=client.expected, page_size=1
    )


def test_stringified_list_requires_and_accepts_typed_exact_readback(marker_client):
    assert reconcile(marker_client) == ("provider-id",)
    assert marker_client.get_calls == ["provider-id"]


def test_even_typed_list_metadata_never_substitutes_for_readback(marker_client):
    marker_client.list_metadata = deepcopy(marker_client.expected)
    assert reconcile(marker_client) == ("provider-id",)
    assert marker_client.get_calls == ["provider-id"]


@pytest.mark.parametrize("key,value", [("canonical_revision", "1"), ("canonical_revision", True), ("sophia_managed", 1), ("provider_namespace", "wrong-subject"), ("projection_operation_id", "other-operation")])
def test_exact_metadata_type_or_binding_conflict_fails_closed(marker_client, key, value):
    marker_client.list_metadata = deepcopy(marker_client.expected)
    marker_client.direct_metadata[key] = value
    with pytest.raises(Mem0ContractError, match="mem0_operation_marker_metadata_conflict"):
        reconcile(marker_client)


def test_readback_outage_is_ambiguous_not_absence(marker_client):
    marker_client.list_metadata = deepcopy(marker_client.expected)
    marker_client.get_error = TimeoutError("SENSITIVE PROVIDER BODY")
    with pytest.raises(Mem0ContractError, match="mem0_operation_marker_verification_failed") as caught:
        reconcile(marker_client)
    assert caught.value.retryable and caught.value.ambiguous_effect
    assert "SENSITIVE" not in str(caught.value)


def test_missing_metadata_or_wrong_returned_id_fails_closed(marker_client):
    marker_client.list_metadata = deepcopy(marker_client.expected)
    for malformed in (None, {}, []):
        marker_client.direct_metadata = malformed
        with pytest.raises(Mem0ContractError, match="mem0_operation_marker_metadata_conflict"):
            reconcile(marker_client)
    marker_client.direct_metadata = deepcopy(marker_client.expected)
    marker_client.direct_id = "wrong-provider-id"
    with pytest.raises(Mem0ContractError, match="mem0_operation_marker_metadata_conflict"):
        reconcile(marker_client)


def test_nonmatching_operation_is_not_read_or_returned(marker_client):
    marker_client.list_metadata["projection_operation_id"] = "other-operation"
    assert reconcile(marker_client) == ()
    assert marker_client.get_calls == []
