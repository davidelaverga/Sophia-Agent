"""Tests for Mem0 client wrapper — cache, client singleton, and search."""

import threading
import time
from unittest.mock import MagicMock, patch

import pytest


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

    def test_cache_expires_after_ttl(self):
        from deerflow.sophia.mem0_client import search_memories
        import deerflow.sophia.mem0_client as mod
        original_ttl = mod._CACHE_TTL
        mod._CACHE_TTL = 0.1  # 100ms TTL for test
        try:
            mock_client = MagicMock()
            mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
            with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
                search_memories("user1", "query")
                time.sleep(0.15)
                search_memories("user1", "query")
                assert mock_client.search.call_count == 2
        finally:
            mod._CACHE_TTL = original_ttl

    def test_invalidate_user_cache(self):
        from deerflow.sophia.mem0_client import search_memories, invalidate_user_cache
        mock_client = MagicMock()
        mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            search_memories("user1", "query")
            invalidate_user_cache("user1")
            search_memories("user1", "query")
            assert mock_client.search.call_count == 2

    def test_invalidate_only_clears_matching_user(self):
        from deerflow.sophia.mem0_client import search_memories, invalidate_user_cache
        import deerflow.sophia.mem0_client as mod
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

    def test_exception_returns_empty(self):
        from deerflow.sophia.mem0_client import search_memories
        mock_client = MagicMock()
        mock_client.search.side_effect = Exception("API error")
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            result = search_memories("user1", "query")
            assert result == []

    def test_cache_bounded_by_max_size(self):
        from deerflow.sophia.mem0_client import search_memories
        import deerflow.sophia.mem0_client as mod
        original_max = mod._CACHE_MAX_SIZE
        mod._CACHE_MAX_SIZE = 5
        try:
            mock_client = MagicMock()
            mock_client.search.return_value = [{"id": "m1", "memory": "fact", "metadata": {}}]
            with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
                for i in range(10):
                    search_memories("user1", f"query_{i}")
                with mod._cache_lock:
                    assert len(mod._cache) <= mod._CACHE_MAX_SIZE
        finally:
            mod._CACHE_MAX_SIZE = original_max


class TestClientSingleton:
    def test_client_created_once(self):
        import deerflow.sophia.mem0_client as mod
        mock_cls = MagicMock()
        with patch.dict("os.environ", {"MEM0_API_KEY": "test-key"}):
            with patch("deerflow.sophia.mem0_client.MemoryClient", mock_cls, create=True):
                # Need to re-import to pick up the mock
                mod._client = None
                mod._client_initialized = False
                c1 = mod._get_client()
                c2 = mod._get_client()
                assert c1 is c2
