"""Tests for Mem0 v3 client wrapper — cache, client singleton, and search."""

import pytest

pytest.importorskip("cachetools", reason="cachetools required for mem0_client tests")

import threading
import time
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from cachetools import TTLCache


@pytest.fixture(autouse=True)
def _reset_mem0_client():
    """Reset module-level state between tests."""
    import deerflow.sophia.mem0_client as mod

    mod._cache.clear()
    mod._client = None
    mod._client_initialized = False
    yield
    mod._cache.clear()
    mod._client = None
    mod._client_initialized = False


class TestSearchMemories:
    def test_returns_empty_when_no_api_key(self):
        from deerflow.sophia.mem0_client import search_memories

        with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
            result = search_memories("user1", "test query")
            assert result == []

    def test_cache_hit_returns_same_results(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}
        ]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            r1 = search_memories("user1", "query")
            r2 = search_memories("user1", "query")
            assert r1 == r2
            # Only one API call — second was cache hit
            assert mock_client.search.call_count == 1

    def test_cache_miss_calls_search_and_stores_result(self):
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}
        ]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query")
            assert len(result) == 1
            assert result[0]["content"] == "fact 1"
            # Verify it was stored in cache
            with mod._cache_lock:
                assert len(mod._cache) == 1

    def test_cache_expires_after_ttl(self):
        """Replace the module cache with a short-TTL cache to test expiration."""
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import search_memories

        # Swap in a cache with 100ms TTL for this test
        original_cache = mod._cache
        mod._cache = TTLCache(maxsize=256, ttl=0.1)
        try:
            mock_client = MagicMock()
            mock_client.search.return_value = [
                {"id": "m1", "memory": "fact", "metadata": {}}
            ]
            with patch(
                "deerflow.sophia.mem0_client._get_client", return_value=mock_client
            ):
                search_memories("user1", "query")
                time.sleep(0.15)
                search_memories("user1", "query")
                assert mock_client.search.call_count == 2
        finally:
            mod._cache = original_cache

    def test_invalidate_user_cache(self):
        from deerflow.sophia.mem0_client import (
            invalidate_user_cache,
            search_memories,
        )

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact", "metadata": {}}
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query")
            invalidate_user_cache("user1")
            search_memories("user1", "query")
            assert mock_client.search.call_count == 2

    def test_invalidate_only_clears_matching_user(self):
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import invalidate_user_cache, search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact", "metadata": {}}
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query")
            search_memories("user2", "query")
            invalidate_user_cache("user1")
            with mod._cache_lock:
                remaining_keys = list(mod._cache.keys())
            assert any("user2:" in k for k in remaining_keys)
            assert not any("user1:" in k for k in remaining_keys)

    def test_dict_with_results_format(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = {
            "results": [
                {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}
            ]
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = search_memories("user1", "query")
            assert len(result) == 1
            assert result[0]["content"] == "fact 1"

    def test_raw_list_format(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = search_memories("user1", "query")
            assert len(result) == 1
            assert result[0]["content"] == "fact 1"

    def test_categories_parameter_ignored_in_v3(self):
        """In v3 mode, categories are not post-filtered client-side."""
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}},
            {"id": "m2", "memory": "feeling 1", "metadata": {"category": "feeling"}},
            {"id": "m3", "memory": "no cat", "metadata": {}},
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = search_memories("user1", "query", categories=["fact"])
            # All results returned — platform handles relevance
            assert len(result) == 3

    def test_limit_passed_to_mem0_search(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query", limit=6)
            assert mock_client.search.call_args.kwargs["limit"] == 6

    def test_reference_date_passed_when_enabled(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        ref = datetime(2026, 5, 16, tzinfo=UTC)
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query", reference_date=ref)
            assert (
                mock_client.search.call_args.kwargs["reference_date"] == "2026-05-16"
            )

    def test_exception_returns_empty(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.side_effect = Exception("API error")
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = search_memories("user1", "query")
            assert result == []

    def test_no_results_returns_empty_list(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = search_memories("user1", "query")
            assert result == []

    def test_cache_bounded_by_max_size(self):
        """Replace module cache with a small-maxsize cache to test bounding."""
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import search_memories

        original_cache = mod._cache
        mod._cache = TTLCache(maxsize=5, ttl=60)
        try:
            mock_client = MagicMock()
            mock_client.search.return_value = [
                {"id": "m1", "memory": "fact", "metadata": {}}
            ]
            with patch(
                "deerflow.sophia.mem0_client._get_client", return_value=mock_client
            ):
                for i in range(10):
                    search_memories("user1", f"query_{i}")
                with mod._cache_lock:
                    assert len(mod._cache) <= 5
        finally:
            mod._cache = original_cache

    def test_cache_is_ttlcache_instance(self):
        """Verify the cache is a proper cachetools.TTLCache, not a plain dict."""
        import deerflow.sophia.mem0_client as mod

        assert isinstance(mod._cache, TTLCache)


class TestAddMemories:
    def test_successful_add_returns_result(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [
            {"id": "new_m1", "memory": "extracted fact"},
            {"id": "new_m2", "memory": "extracted feeling"},
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "I love coffee"}],
                session_id="sess_123",
            )
            assert len(result) == 2
            assert result[0]["id"] == "new_m1"

    def test_add_with_no_api_key_returns_empty(self):
        from deerflow.sophia.mem0_client import add_memories

        with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            assert result == []

    def test_add_when_sdk_raises_returns_empty(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.side_effect = Exception("Mem0 API error")
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            assert result == []

    def test_cache_invalidated_after_successful_add(self):
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import add_memories, search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "old fact", "metadata": {}}
        ]
        mock_client.add.return_value = [{"id": "new_m1", "memory": "new fact"}]

        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            # Populate cache
            search_memories("user1", "query")
            with mod._cache_lock:
                assert len(mod._cache) == 1

            # Add memories — should invalidate cache
            add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            with mod._cache_lock:
                assert len(mod._cache) == 0

    def test_metadata_passed_directly_to_v3_add(self):
        """v3 SDK add() receives metadata natively — no REST backfill."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "hello"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"importance": "structural", "review_status": "pending_review"},
            )
            call_kwargs = mock_client.add.call_args.kwargs
            assert call_kwargs["messages"] == [{"role": "user", "content": "hello"}]
            assert call_kwargs["user_id"] == "user1"
            assert call_kwargs["metadata"] == {
                "importance": "structural",
                "review_status": "pending_review",
            }
            assert "async_mode" not in call_kwargs
            assert result[0]["id"] == "mem_1"

    def test_metadata_status_translated_to_review_status(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "hello"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"status": "pending_review"},
            )
            call_kwargs = mock_client.add.call_args.kwargs
            assert call_kwargs["metadata"]["review_status"] == "pending_review"
            assert "status" not in call_kwargs["metadata"]

    def test_dict_with_results_key_normalized(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = {"results": [{"id": "m1", "memory": "fact"}]}
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            assert len(result) == 1
            assert result[0]["id"] == "m1"

    def test_contextual_importance_gets_expiration_date(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "m1", "memory": "fact"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"importance_score": 0.3, "review_status": "pending_review"},
            )
            call_kwargs = mock_client.add.call_args.kwargs
            assert "expiration_date" in call_kwargs["metadata"]

    def test_timestamp_passed_when_provided(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "m1", "memory": "fact"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"review_status": "pending_review"},
                timestamp=1715900000,
            )
            assert mock_client.add.call_args.kwargs["timestamp"] == 1715900000

    def test_add_without_metadata_works(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "m1", "memory": "fact"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            assert result[0]["id"] == "m1"


class TestWaitForPendingEvents:
    def test_resolves_when_memories_appear(self):
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock()
        mock_client.get_all.return_value = {
            "count": 1,
            "results": [{"id": "evt_1", "memory": "resolved"}],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "evt_1"

    def test_returns_empty_on_timeout(self):
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock()
        mock_client.get_all.return_value = {"count": 0, "results": []}
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.2, poll_interval=0.1
            )
            assert result == []


class TestExpirationForImportance:
    def test_low_importance_gets_expiration(self):
        from deerflow.sophia.mem0_client import _expiration_for_importance

        result = _expiration_for_importance(0.3)
        assert result is not None
        # Should be an ISO datetime string ~7 days in the future
        assert "T" in result

    def test_high_importance_no_expiration(self):
        from deerflow.sophia.mem0_client import _expiration_for_importance

        result = _expiration_for_importance(0.8)
        assert result is None

    def test_string_importance_converted(self):
        from deerflow.sophia.mem0_client import _expiration_for_importance

        assert _expiration_for_importance("0.3") is not None
        assert _expiration_for_importance("0.8") is None


class TestNormalizeGetAllResult:
    def test_v3_paginated_envelope(self):
        from deerflow.sophia.mem0_client import _normalize_get_all_result

        envelope = {
            "count": 2,
            "next": None,
            "previous": None,
            "results": [
                {"id": "m1", "memory": "a"},
                {"id": "m2", "memory": "b"},
            ],
        }
        result = _normalize_get_all_result(envelope)
        assert len(result) == 2
        assert result[0]["id"] == "m1"

    def test_bare_list(self):
        from deerflow.sophia.mem0_client import _normalize_get_all_result

        result = _normalize_get_all_result([{"id": "m1", "memory": "a"}])
        assert len(result) == 1

    def test_dict_with_results_key(self):
        from deerflow.sophia.mem0_client import _normalize_get_all_result

        result = _normalize_get_all_result({"results": [{"id": "m1", "memory": "a"}]})
        assert len(result) == 1

    def test_empty_dict(self):
        from deerflow.sophia.mem0_client import _normalize_get_all_result

        assert _normalize_get_all_result({}) == []


class TestClientSingleton:
    def test_client_created_once(self):
        import deerflow.sophia.mem0_client as mod

        mock_cls = MagicMock()
        with patch.dict("os.environ", {"MEM0_API_KEY": "test-key"}):
            with patch("mem0.MemoryClient", mock_cls):
                mod._client = None
                mod._client_initialized = False
                c1 = mod._get_client()
                c2 = mod._get_client()
                assert c1 is c2

    def test_client_returns_none_without_api_key(self):
        import deerflow.sophia.mem0_client as mod

        with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
            mod._client = None
            mod._client_initialized = False
            c = mod._get_client()
            assert c is None

    def test_client_returns_none_when_import_fails(self):
        import deerflow.sophia.mem0_client as mod

        mod._client = None
        mod._client_initialized = False

        original_import = (
            __builtins__.__import__
            if hasattr(__builtins__, "__import__")
            else __import__
        )

        def fail_mem0_import(name, *args, **kwargs):
            if name == "mem0":
                raise ImportError("no mem0")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fail_mem0_import):
            c = mod._get_client()
            assert c is None

    def test_singleton_thread_safe(self):
        """Multiple threads calling _get_client get the same instance."""
        import deerflow.sophia.mem0_client as mod

        mock_cls = MagicMock()
        results = []

        def get_client():
            c = mod._get_client()
            results.append(c)

        with patch.dict("os.environ", {"MEM0_API_KEY": "test-key"}):
            with patch("mem0.MemoryClient", mock_cls):
                mod._client = None
                mod._client_initialized = False
                threads = [threading.Thread(target=get_client) for _ in range(5)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                assert len(results) == 5
                assert all(r is results[0] for r in results)
