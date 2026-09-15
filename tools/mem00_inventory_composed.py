"""Feed actual disposable SQL snapshots through the installed HTTP store/Gateway."""

import json
import os
import sys
from unittest.mock import MagicMock, patch

os.environ["SOPHIA_MEMORY_REFERENCE_HMAC_SECRET"] = "r" * 32
os.environ["SOPHIA_MEMORY_LANGSMITH_EXPORT"] = "false"

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.models import ProviderHit
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore

payload = json.load(sys.stdin)
owner = "inventory-owner"
pages = payload["pages"]
by_after = {page["after_key"]: page for page in pages}
by_view = {view: {page["after_key"]: page for page in payload[view+"_pages"]} for view in ("saved", "active", "forgotten")}
views = payload["views"]
requests = []


def transport(request):
    name = request.url.path.rsplit("/", 1)[1]
    if name == "sophia_memory_contract":
        return httpx.Response(200, json=[{key: payload["contract"][key] for key in request.url.params["select"].split(",")}])
    if name == "sophia_memory_user_governance":
        assert request.url.params["user_id"] == f"eq.{owner}"
        return httpx.Response(200, json=[{key: payload["owner"][key] for key in request.url.params["select"].split(",")}])
    if name == "sophia_memory_resolve_provider_hits":
        assert json.loads(request.content) == {"p_user_id": owner, "p_provider": "mem0", "p_environment": "synthetic",
            "p_provider_project": "existing-project", "p_provider_namespace": payload["owner"]["provider_subject"], "p_provider_memory_ids": payload["hit_ids"]}
        return httpx.Response(200, json=payload["hit_result"])
    assert name == "sophia_memory_inventory_snapshot" and request.method == "POST", "list/provider fallback"
    body = json.loads(request.content)
    assert body["p_user_id"] == owner and body["p_page_size"] == 200
    page = by_after[body["p_after_key"]] if body["p_view"] == "all" else (
        by_view[body["p_view"]][body["p_after_key"]] if body["p_view"] in by_view else views[body["p_view"]])
    assert body["p_snapshot_id"] == (page["snapshot_id"] if body["p_after_key"] else None)
    requests.append(body)
    return httpx.Response(200, json=page)


with httpx.Client(transport=httpx.MockTransport(transport)) as http:
    store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=http)
    service = CanonicalMemoryService(owner_id=owner, store=store, provider=MemoryProviderContract("mem0", "synthetic", "existing-project"))
    service.list_pool = MagicMock(side_effect=AssertionError("Journal discards snapshot contract"))
    with patch.object(sophia, "_canonical_memory_service", return_value=service), \
        patch("deerflow.sophia.memory_governance.owner_authority.configured_memory_store", return_value=store):
        app = FastAPI()
        app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope] = lambda: owner
        results, recent_results, pool_results = [], [], []
        with TestClient(app) as client:
            cursor = None
            for _ in pages:
                response = client.get(f"/api/sophia/{owner}/memories/inventory",
                    params={"view": "all", "page_size": 200, **({"cursor": cursor} if cursor else {})})
                assert response.status_code == 200, "canonical inventory HTTP unavailable"
                assert response.headers["Cache-Control"] == "no-store"
                result = response.json()
                results.append(result)
                cursor = result["next_cursor"]
            assert cursor is None
            for view, status in [("active", "approved"), ("forgotten", "forgotten"), ("pending_review", "pending_review")]:
                response = client.get(f"/api/sophia/{owner}/memories/recent", params={"status": status, "page_size": 200})
                assert response.status_code == 200, "global recent inventory unavailable"
                assert response.headers["Cache-Control"] == "no-store"
                result = response.json()
                assert result["memory_inventory"]["records"] == views[view]["records"]
                assert [(item["id"], item["content"]) for item in result["memories"]] == [
                    (item["id"], item["content"]) for item in views[view]["records"]]
                recent_results.append({"status": status, "page": result})
            for view in ("active", "forgotten"):
                response = client.get(f"/api/sophia/{owner}/journal", params={"status": view})
                assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
                value = response.json()
                expected = [item for page in payload[view+"_pages"] for item in page["records"]]
                assert value["owner_id"] == owner and value["view"] == view
                assert value["count"] == value["snapshot_count"] == len(expected)
                assert [(item["id"], item["content"]) for item in value["entries"]] == [(item["id"], item["content"]) for item in expected]
                assert value["enumeration_complete"] is True and value["projection_status"] == "unavailable"
                pool_results.append(value)
        assert sum(len(page["records"]) for page in results) == 2010
        active = store.list_pool(user_id=owner)
        saved = store.list_pool(user_id=owner, include_forgotten=True)
        assert len(active) == 804 and len(saved) == 1005
        assert all(item.current_content_revision == 2 and item.projection_state == "unavailable" for item in saved)
        resolved, denials = store.authorize_provider_hits(user_id=owner, provider="mem0", environment="synthetic",
            provider_project="existing-project", provider_namespace=payload["owner"]["provider_subject"],
            hits=tuple(ProviderHit(provider_memory_id=value, score=0.75) for value in payload["hit_ids"]))
        assert len(resolved) == 1 and resolved[0][0].canonical_content.endswith("000000001004") and resolved[0][1] == 0.75
        assert denials == {"inactive_projection": 1, "unmapped_provider_id": 1}
        assert len(requests) == len(pages) + 21
        service.list_pool.assert_not_called()
        print(json.dumps({"passed": True, "http_pages": results, "recent_pages": recent_results, "pool_views": pool_results,
            "request_count": len(requests), "provider_calls": 0}))
