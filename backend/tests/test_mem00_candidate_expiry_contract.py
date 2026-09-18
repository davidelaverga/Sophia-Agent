"""Worker expiry must call the selected, source-aware serving RPC."""

import json

import httpx

from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore


def test_worker_store_uses_governed_expiry_not_revoked_legacy_rpc():
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path == '/rest/v1/rpc/sophia_memory_expire_governed_candidates':
            return httpx.Response(200, json=2)
        return httpx.Response(403, json={'code': '42501'})

    store = SupabaseMemoryGovernanceStore(url='https://example.invalid', service_role_key='synthetic',
        client=httpx.Client(transport=httpx.MockTransport(respond)))
    assert store.expire_candidates(limit=17) == 2
    assert len(requests) == 1
    assert json.loads(requests[0].content) == {'p_limit': 17}
