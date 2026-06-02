from __future__ import annotations

import json
from unittest.mock import patch


def test_apply_review_metadata_overlays_promotes_unresolved_entry(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Needs review",
            metadata={"status": "pending_review", "category": "fact"},
            session_id="sess_1",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "m1", "memory": "Needs review", "metadata": None, "categories": []}],
        )

        assert overlaid[0]["metadata"]["status"] == "pending_review"
        assert overlaid[0]["category"] == "fact"

        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"][0]["memory_id"] == "m1"


def test_remove_review_metadata_by_memory_id(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="m1",
            content="Needs review",
            metadata={"status": "pending_review"},
            sync_state="manual",
        )

        removed = store.remove_review_metadata("user1", memory_id="m1")

        assert removed is True
        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"] == []


def test_apply_review_metadata_overlays_appends_local_only_entries(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Unmatched pending review memory",
            metadata={"status": "pending_review", "category": "fact"},
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays("user1", [])

        assert len(overlaid) == 1
        assert overlaid[0]["id"].startswith("local:")
        assert overlaid[0]["metadata"]["status"] == "pending_review"


def test_apply_review_metadata_overlays_scopes_local_only_entries_by_session(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Target session pending memory",
            metadata={"status": "pending_review", "category": "lesson"},
            session_id="sess_target",
            sync_state="local_only",
        )
        store.upsert_review_metadata(
            "user1",
            content="Other session pending memory",
            metadata={"status": "pending_review", "category": "lesson"},
            session_id="sess_other",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays("user1", [], session_id="sess_target")

        assert len(overlaid) == 1
        assert overlaid[0]["session_id"] == "sess_target"
        assert overlaid[0]["memory"] == "Target session pending memory"


def test_reconcile_review_metadata_entries_matches_equivalent_real_memory(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="User has an investor pitch scheduled for 2026-04-07.",
            metadata={"status": "pending_review", "category": "fact"},
            sync_state="local_only",
        )

        reconciled = store.reconcile_review_metadata_entries(
            "user1",
            [{"id": "mem_1", "memory": "User has an investor pitch scheduled for April 7, 2026.", "metadata": None}],
        )
        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "User has an investor pitch scheduled for April 7, 2026.", "metadata": None}],
        )

        assert reconciled == 1
        assert len(overlaid) == 1
        assert overlaid[0]["id"] == "mem_1"
        assert overlaid[0]["metadata"]["status"] == "pending_review"

        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"][0]["memory_id"] == "mem_1"


def test_apply_review_metadata_overlays_replaces_memory_text_with_local_edit(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="mem_1",
            content="Updated local memory text",
            metadata={"status": "approved", "category": "ritual_context"},
            sync_state="manual",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "Original remote memory text", "metadata": {"status": "approved"}}],
        )

        assert len(overlaid) == 1
        assert overlaid[0]["memory"] == "Updated local memory text"
        assert overlaid[0]["content"] == "Updated local memory text"
        assert overlaid[0]["metadata"]["category"] == "ritual_context"


def test_apply_review_metadata_overlays_deduplicates_local_only_entries_with_same_hash(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Repeated local memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_1",
            sync_state="local_only",
        )
        store.upsert_review_metadata(
            "user1",
            content="Repeated local memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_2",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays("user1", [])

        assert len(overlaid) == 1
        assert overlaid[0]["id"].startswith("local:")
        assert overlaid[0]["memory"] == "Repeated local memory"


def test_apply_review_metadata_overlays_suppresses_unresolved_sibling_once_real_memory_exists(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="mem_1",
            content="Repeated memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_1",
            sync_state="reconciled",
        )
        store.upsert_review_metadata(
            "user1",
            content="Repeated memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_2",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "Repeated memory", "metadata": {"status": "approved"}}],
        )

        assert len(overlaid) == 1
        assert overlaid[0]["id"] == "mem_1"


# ---------------------------------------------------------------------------
# HTTP-bridge mode (May 2026): gateway and langgraph have separate Render
# disks. Per-turn retrieval running on langgraph must reach the overlay
# written by the gateway. ``_load_store`` fetches via HTTP when the
# ``SOPHIA_OVERLAY_GATEWAY_URL`` env var is set, with disk fallback on
# failure and a short TTL cache to amortize round-trips.
# ---------------------------------------------------------------------------


class _FakeHttpResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self) -> dict:
        if self._payload is None:
            raise ValueError("no json payload")
        return self._payload


class _FakeHttpClient:
    def __init__(self, response=None, raises=None):
        self._response = response
        self._raises = raises
        self.calls: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url: str):
        self.calls.append(url)
        if self._raises is not None:
            raise self._raises
        return self._response


def _install_fake_httpx(monkeypatch, fake_client):
    import sys
    import types

    fake_httpx = types.SimpleNamespace(Client=lambda timeout=None: fake_client)
    monkeypatch.setitem(sys.modules, "httpx", fake_httpx)


def test_load_store_http_bridge_returns_gateway_data_when_env_set(tmp_path, monkeypatch):
    """When SOPHIA_OVERLAY_GATEWAY_URL is set, _load_store fetches from
    the gateway over HTTP instead of reading local disk."""
    import deerflow.sophia.review_metadata_store as store

    fake_payload = {
        "version": 1,
        "entries": [
            {
                "memory_id": None,
                "content_hash": "abc123",
                "content": "Shipped on Friday",
                "metadata": {"status": "approved", "category": "commitment"},
                "updated_at": "2026-05-26T20:11:00+00:00",
            }
        ],
    }
    fake_client = _FakeHttpClient(response=_FakeHttpResponse(200, payload=fake_payload))
    _install_fake_httpx(monkeypatch, fake_client)
    monkeypatch.setenv("SOPHIA_OVERLAY_GATEWAY_URL", "https://gateway.example.com")
    store.invalidate_overlay_http_cache()

    with patch.object(store, "USERS_DIR", tmp_path):
        loaded = store._load_store("user1")

    assert loaded["entries"][0]["content_hash"] == "abc123"
    assert loaded["entries"][0]["metadata"]["status"] == "approved"
    assert fake_client.calls == ["https://gateway.example.com/internal/sophia-overlay/user1"]


def test_load_store_http_bridge_falls_back_to_disk_on_failure(tmp_path, monkeypatch):
    """If the HTTP fetch raises (timeout, DNS error, etc.) _load_store
    falls back to local disk so we never go silently empty."""
    import deerflow.sophia.review_metadata_store as store

    fake_client = _FakeHttpClient(raises=RuntimeError("network down"))
    _install_fake_httpx(monkeypatch, fake_client)
    monkeypatch.setenv("SOPHIA_OVERLAY_GATEWAY_URL", "https://gateway.example.com")
    store.invalidate_overlay_http_cache()

    with patch.object(store, "USERS_DIR", tmp_path):
        # Seed local disk with one entry so the fallback path has data.
        store.upsert_review_metadata(
            "user2",
            content="Disk fallback entry",
            metadata={"status": "pending_review"},
            session_id="sess_x",
        )
        store.invalidate_overlay_http_cache()  # upsert may not invalidate; force fresh fetch

        loaded = store._load_store("user2")

    assert any(
        entry.get("content") == "Disk fallback entry"
        for entry in loaded["entries"]
    )


def test_load_store_http_bridge_caches_within_ttl(tmp_path, monkeypatch):
    """Successive _load_store calls within the TTL hit the cache (one HTTP
    call only) so per-turn retrieval doesn't pound the gateway."""
    import deerflow.sophia.review_metadata_store as store

    fake_payload = {"version": 1, "entries": []}
    fake_client = _FakeHttpClient(response=_FakeHttpResponse(200, payload=fake_payload))
    _install_fake_httpx(monkeypatch, fake_client)
    monkeypatch.setenv("SOPHIA_OVERLAY_GATEWAY_URL", "https://gateway.example.com")
    store.invalidate_overlay_http_cache()

    with patch.object(store, "USERS_DIR", tmp_path):
        store._load_store("user3")
        store._load_store("user3")
        store._load_store("user3")

    assert len(fake_client.calls) == 1, (
        f"Expected exactly 1 HTTP call due to TTL cache; got {len(fake_client.calls)}"
    )


def test_load_store_disk_only_when_env_unset(tmp_path, monkeypatch):
    """Without the env var, _load_store reads local disk and never imports
    httpx (gateway-side behavior — unchanged from pre-bridge)."""
    import deerflow.sophia.review_metadata_store as store

    monkeypatch.delenv("SOPHIA_OVERLAY_GATEWAY_URL", raising=False)
    monkeypatch.delenv("SOPHIA_GATEWAY_URL", raising=False)

    # Sentinel httpx that explodes if imported — proves the disk path
    # never goes near it.
    import sys
    import types

    def _explode():
        raise AssertionError("httpx must not be imported on the disk path")

    fake_httpx = types.SimpleNamespace(Client=lambda timeout=None: _explode())
    monkeypatch.setitem(sys.modules, "httpx", fake_httpx)
    store.invalidate_overlay_http_cache()

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user4",
            content="Disk-only entry",
            metadata={"status": "approved"},
        )

        loaded = store._load_store("user4")

    assert any(
        entry.get("content") == "Disk-only entry"
        for entry in loaded["entries"]
    )


def test_upsert_uses_disk_only_load_even_when_http_env_set(tmp_path, monkeypatch):
    """``upsert_review_metadata`` must read from disk even in HTTP-bridge
    mode — mixing an HTTP snapshot with a local disk write would orphan
    the write on the wrong filesystem."""
    import deerflow.sophia.review_metadata_store as store

    # If upsert accidentally goes through HTTP, this fake client will fail
    # the test by reporting an unexpected call.
    fake_client = _FakeHttpClient(response=_FakeHttpResponse(200, payload={"version": 1, "entries": []}))
    _install_fake_httpx(monkeypatch, fake_client)
    monkeypatch.setenv("SOPHIA_OVERLAY_GATEWAY_URL", "https://gateway.example.com")
    store.invalidate_overlay_http_cache()

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user5",
            content="Local write under HTTP mode",
            metadata={"status": "approved"},
        )

    assert fake_client.calls == [], (
        f"upsert_review_metadata must not hit HTTP; got calls: {fake_client.calls}"
    )
