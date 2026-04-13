"""Tests for Mem0 client wrapper — cache, client singleton, and search."""

import threading
import time
from unittest.mock import MagicMock, patch

import pytest
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
            mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
            with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
                search_memories("user1", "query")
                time.sleep(0.15)
                search_memories("user1", "query")
                assert mock_client.search.call_count == 2
        finally:
            mod._cache = original_cache

    def test_invalidate_user_cache(self):
        from deerflow.sophia.mem0_client import invalidate_user_cache, search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            search_memories("user1", "query")
            invalidate_user_cache("user1")
            search_memories("user1", "query")
            assert mock_client.search.call_count == 2

    def test_invalidate_only_clears_matching_user(self):
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import invalidate_user_cache, search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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
            "results": [{"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}]
        }
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query")
            assert len(result) == 1
            assert result[0]["content"] == "fact 1"

    def test_raw_list_format(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}
        ]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query")
            assert len(result) == 1
            assert result[0]["content"] == "fact 1"

    def test_category_filtering(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}},
            {"id": "m2", "memory": "feeling 1", "metadata": {"category": "feeling"}},
            {"id": "m3", "memory": "no cat", "metadata": {}},
        ]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query", categories=["fact"])
            # Should include fact + no-category (empty passes through)
            assert len(result) == 2

    def test_limit_passed_to_mem0_search(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            search_memories("user1", "query", limit=6)
            assert mock_client.search.call_args.kwargs["limit"] == 6

    def test_exception_returns_empty(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.side_effect = Exception("API error")
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query")
            assert result == []

    def test_no_results_returns_empty_list(self):
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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
            mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
            with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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
        mock_client.search.return_value = [{"id": "m1", "memory": "old fact", "metadata": {}}]
        mock_client.add.return_value = [{"id": "new_m1", "memory": "new fact"}]

        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
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

    def test_metadata_preserved_via_update_after_add(self):
        """Metadata should be backfilled via direct REST after add()."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "hello"}]
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._update_memory_metadata_via_rest", return_value={"id": "mem_1", "memory": "hello"}) as mock_rest_update,
            patch("deerflow.sophia.mem0_client.upsert_review_metadata") as mock_store,
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"importance": "structural"},
            )
            call_kwargs = mock_client.add.call_args[1]
            assert call_kwargs["messages"] == [{"role": "user", "content": "hello"}]
            assert call_kwargs["user_id"] == "user1"
            assert call_kwargs["async_mode"] is False
            assert "agent_id" not in call_kwargs
            assert "metadata" not in call_kwargs
            assert "run_id" not in call_kwargs
            mock_rest_update.assert_called_once_with(
                client=mock_client,
                memory_id="mem_1",
                metadata={"importance": "structural"},
            )
            mock_client.update.assert_not_called()
            assert mock_store.call_count == 2
            assert result[0]["metadata"] == {"importance": "structural"}

    def test_dict_with_results_key_normalized(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = {
            "results": [{"id": "m1", "memory": "fact"}]
        }
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )
            assert len(result) == 1
            assert result[0]["id"] == "m1"

    def test_metadata_not_forwarded_to_add_sdk_call(self):
        """Metadata still must not be passed directly to the SDK add() call."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "hello"}]
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._update_memory_metadata_via_rest", return_value={"id": "mem_1", "memory": "hello"}),
            patch("deerflow.sophia.mem0_client.upsert_review_metadata"),
        ):
            add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"status": "pending_review"},
            )
            _, kwargs = mock_client.add.call_args
            assert "metadata" not in kwargs
            assert kwargs["async_mode"] is False

    def test_metadata_preserved_when_add_returns_null_id(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": None, "memory": "hello"}]
        mock_client.get_all.return_value = [{"id": "mem_2", "memory": "hello"}]

        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._update_memory_metadata_via_rest", return_value={"id": "mem_2", "memory": "hello"}) as mock_rest_update,
            patch("deerflow.sophia.mem0_client.upsert_review_metadata") as mock_store,
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"status": "pending_review"},
            )

        mock_client.get_all.assert_called_once_with(filters={"user_id": "user1"})
        mock_rest_update.assert_called_once_with(
            client=mock_client,
            memory_id="mem_2",
            metadata={"status": "pending_review"},
        )
        assert mock_store.call_count == 2
        assert result[0]["id"] == "mem_2"
        assert result[0]["metadata"] == {"status": "pending_review"}

    def test_metadata_update_failure_keeps_add_result(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "hello"}]
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._update_memory_metadata_via_rest", side_effect=Exception("update failed")),
            patch("deerflow.sophia.mem0_client.upsert_review_metadata") as mock_store,
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
                metadata={"status": "pending_review"},
            )

        assert mock_store.call_count == 2
        assert result == [{"id": "mem_1", "memory": "hello", "metadata": {"status": "pending_review"}}]


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

        # Patch the import inside _get_client to raise ImportError
        original_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

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

                # All threads should get the same instance
                assert len(results) == 5
                assert all(r is results[0] for r in results)
