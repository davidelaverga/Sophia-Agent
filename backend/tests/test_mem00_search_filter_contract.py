"""P01: hosted v2 search rejects flat custom metadata filter fields."""

import pytest

from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter


@pytest.mark.parametrize("metadata", [{}, {"sophia_managed": True, "memory_contract_epoch": 1, "environment": "production", "provider_namespace": "synthetic-owner"}, {"user_id": "another-owner"}])
def test_search_keeps_entity_scope_separate_from_custom_metadata(monkeypatch, metadata):
    monkeypatch.setattr("importlib.metadata.version", lambda _: "1.0.9")
    calls = []

    class Client:
        def search(self, **kwargs):
            calls.append(kwargs)
            expected = [{"user_id": "synthetic-owner"}]
            expected.extend({"metadata": {key: value}} for key, value in metadata.items())
            assert kwargs["filters"] == {"AND": expected}
            return {"results": [{"id": "synthetic-provider-id", "score": 0.9, "memory": "UNTRUSTED_PROVIDER_TEXT"}]}

    adapter = Mem0ProjectionAdapter(client=Client())
    hits = adapter.search_ids(query="synthetic-query", provider_subject="synthetic-owner", metadata_filter=metadata, limit=200)
    assert len(hits) == 1
    assert hits[0].provider_memory_id == "synthetic-provider-id"
    assert not hasattr(hits[0], "memory")
    assert calls[0]["limit"] == 100
    assert "UNTRUSTED_PROVIDER_TEXT" not in repr(hits)
