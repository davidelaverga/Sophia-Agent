"""Tests for Mem0 v3 client wrapper — cache, client singleton, and search."""

import pytest

pytest.importorskip("cachetools", reason="cachetools required for mem0_client tests")

import threading
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from cachetools import TTLCache


@pytest.fixture(autouse=True)
def _reset_mem0_client():
    """Reset module-level state between tests."""
    import deerflow.sophia.mem0_client as mod

    mod._cache.clear()
    mod._client = None
    mod._client_initialized = False
    mod._client_unavailable_reason = None
    yield
    mod._cache.clear()
    mod._client = None
    mod._client_initialized = False
    mod._client_unavailable_reason = None


class TestSearchMemories:
    def test_returns_empty_when_no_api_key(self):
        from deerflow.sophia.mem0_client import search_memories

        with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
            result = search_memories("user1", "test query")
            assert result == []

    def test_search_diagnostics_reports_missing_api_key(self):
        from deerflow.sophia.mem0_client import search_memories_with_diagnostics

        with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
            result = search_memories_with_diagnostics("user1", "test query")

        assert result["memories"] == []
        assert result["provider_status"] == "unavailable"
        assert result["provider_reason"] == "missing_api_key"

    def test_search_diagnostics_can_raise_provider_error(self):
        from deerflow.sophia.mem0_client import MemoryProviderSearchError, search_memories_with_diagnostics

        mock_client = MagicMock()
        mock_client.search.side_effect = RuntimeError("api down")
        with patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client):
            with pytest.raises(MemoryProviderSearchError) as exc_info:
                search_memories_with_diagnostics("user1", "query", raise_on_error=True)

        assert exc_info.value.reason == "provider_exception"

    def test_rest_fallback_search_when_sdk_missing(self):
        from deerflow.sophia.mem0_client import search_memories_with_diagnostics

        class FakeResponse:
            def raise_for_status(self):  # noqa: ANN202
                return None

            def json(self):  # noqa: ANN202
                return [{"id": "m1", "memory": "fact 1", "metadata": {"category": "fact"}}]

        class FakeClient:
            def __init__(self, **kwargs):  # noqa: ANN003
                self.kwargs = kwargs
                self.posts = []

            def __enter__(self):  # noqa: ANN202
                return self

            def __exit__(self, *_args):  # noqa: ANN202
                return None

            def post(self, path, json):  # noqa: ANN001, A002, ANN202
                self.posts.append((path, json))
                return FakeResponse()

        fake_client = FakeClient()
        fake_httpx = SimpleNamespace(Client=lambda **_kwargs: fake_client)

        with (
            patch.dict("os.environ", {"MEM0_API_KEY": "test-key"}),
            patch("deerflow.sophia.mem0_client._get_client", return_value=None),
            patch("deerflow.sophia.mem0_client._httpx_module", return_value=fake_httpx),
        ):
            result = search_memories_with_diagnostics("user1", "query", limit=3)

        assert result["provider_status"] == "available"
        assert result["provider_transport"] == "mem0_rest"
        assert result["memories"][0]["content"] == "fact 1"
        assert fake_client.posts == [
            ("/v2/memories/search/", {"query": "query", "filters": {"user_id": "user1"}, "limit": 3})
        ]

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

    def test_top_k_passed_to_mem0_search(self):
        """Mem0 v3 SDK uses ``top_k`` for result count, not ``limit``.

        Sending ``limit`` risks being silently ignored on SDK/API combinations
        that strip unknown keys, falling back to the default retrieval depth
        and undermining voice-mode's reduced window. Callers still pass
        ``limit=N`` to ``search_memories`` (internal API name); the wrapper
        translates it to ``top_k`` on the wire.
        """
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query", limit=6)
            kwargs = mock_client.search.call_args.kwargs
            assert kwargs["top_k"] == 6, "Mem0 v3 search must receive top_k, not limit"
            assert "limit" not in kwargs, (
                "Don't send the legacy 'limit' kwarg — the SDK ignores it and the "
                "server-side default top_k applies instead"
            )

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

    def test_cache_key_uses_day_resolution_not_isoformat(self):
        """Cache key must match the wire format's day resolution (YYYY-MM-DD).

        Codex P1 review on PR #130 flagged that two calls on the same day
        with different microsecond timestamps were producing different cache
        keys (isoformat) even though the wire format is day-only — so the
        cache effectively never hit when the retrieval middleware passes
        datetime.now(UTC) on every turn. This test pins the fix: same-day
        calls share one cache entry.
        """
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = [
            {"id": "m1", "memory": "fact", "metadata": {}}
        ]
        # Two calls on 2026-05-16, very different microsecond timestamps.
        # The wire format both send to Mem0 is "2026-05-16" — they MUST
        # share a cache entry.
        ref_morning = datetime(2026, 5, 16, 8, 0, 1, 123456, tzinfo=UTC)
        ref_evening = datetime(2026, 5, 16, 22, 45, 19, 987654, tzinfo=UTC)

        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            r1 = search_memories("user1", "query", reference_date=ref_morning)
            r2 = search_memories("user1", "query", reference_date=ref_evening)
            assert r1 == r2
            assert mock_client.search.call_count == 1, (
                "Same day → must hit cache on second call. "
                "Without the day-level cache key, the retrieval middleware "
                "(which passes datetime.now(UTC) every turn) bypasses the cache "
                "entirely and pays the full Mem0 round-trip on every message."
            )

    def test_cache_key_differs_across_days(self):
        """Same query on different days MUST NOT collide in the cache.

        The corollary to test_cache_key_uses_day_resolution_not_isoformat:
        we cache at day resolution, so a query on May 16 and the same query
        on May 17 must trigger TWO upstream calls (the reference_date sent
        on the wire is different — "2026-05-16" vs "2026-05-17").
        """
        from deerflow.sophia.mem0_client import search_memories

        mock_client = MagicMock()
        mock_client.search.return_value = []
        ref_day1 = datetime(2026, 5, 16, 12, 0, 0, tzinfo=UTC)
        ref_day2 = datetime(2026, 5, 17, 12, 0, 0, tzinfo=UTC)

        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            search_memories("user1", "query", reference_date=ref_day1)
            search_memories("user1", "query", reference_date=ref_day2)
            assert mock_client.search.call_count == 2, (
                "Different days → must NOT share a cache entry"
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
    def test_successful_add_returns_resolved_memories(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [
            {"event_id": "evt_1", "memory": {"id": "mem_1", "content": "extracted fact"}},
            {"event_id": "evt_2", "memory": {"id": "mem_2", "content": "extracted feeling"}},
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_1"}, {"id": "mem_2"}], set()),
            ) as mock_wait:
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "I love coffee"}],
                    session_id="sess_123",
                )
                assert len(result) == 2
                assert result[0]["id"] == "mem_1"
                mock_wait.assert_called_once_with("user1", ["evt_1", "evt_2"])

    def test_add_uses_event_id_when_mem0_v3_returns_event_id(self):
        """Mem0 v3 async add returns event_id (not id) — must still poll."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [
            {"event_id": "evt_v3_1", "memory": None},
            {"event_id": "evt_v3_2", "memory": None},
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_1"}, {"id": "mem_2"}], set()),
            ) as mock_wait:
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                )
                assert len(result) == 2
                mock_wait.assert_called_once_with("user1", ["evt_v3_1", "evt_v3_2"])

    def test_add_does_not_poll_plain_memory_ids_from_sync_add(self):
        """Synchronous add() responses return memory IDs under id, not event IDs."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"id": "mem_1", "memory": "resolved memory"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch("deerflow.sophia.mem0_client.wait_for_pending_events") as mock_wait:
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                )

        assert result == [{"id": "mem_1", "memory": "resolved memory"}]
        mock_wait.assert_not_called()

    def test_add_passes_run_id_as_session_id(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": "hello"}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_1"}], set()),
            ):
                add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_abc",
                )
                assert mock_client.add.call_args.kwargs["run_id"] == "sess_abc"

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
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "new_m1", "content": "new fact"}}]

        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "new_m1"}], set()),
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
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "mem_1", "content": "hello"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_1"}], set()),
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
                assert call_kwargs["run_id"] == "sess_123"
                assert call_kwargs["metadata"] == {
                    "importance": "structural",
                    "review_status": "pending_review",
                }
                assert "async_mode" not in call_kwargs
                assert result[0]["id"] == "mem_1"

    def test_metadata_status_translated_to_review_status(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "mem_1", "content": "hello"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_1"}], set()),
            ):
                add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                    metadata={"status": "pending_review"},
                )
                call_kwargs = mock_client.add.call_args.kwargs
                assert call_kwargs["metadata"]["review_status"] == "pending_review"
                # status is preserved for gateway backward compatibility (Codex P1)
                assert call_kwargs["metadata"]["status"] == "pending_review"
                assert call_kwargs["run_id"] == "sess_123"

    def test_dict_with_results_key_normalized(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = {"results": [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]}
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "m1"}], set()),
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
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "m1"}], set()),
            ):
                add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                    metadata={"importance_score": 0.3, "review_status": "pending_review"},
                )
                call_kwargs = mock_client.add.call_args.kwargs
                assert "expiration_date" in call_kwargs["metadata"]

    def test_zero_importance_score_gets_expiration_date(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "m1"}], set()),
            ):
                add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                    metadata={
                        "importance_score": 0.0,
                        "importance": "structural",
                        "review_status": "pending_review",
                    },
                )
                call_kwargs = mock_client.add.call_args.kwargs
                assert "expiration_date" in call_kwargs["metadata"]

    def test_timestamp_passed_when_provided(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "m1"}], set()),
            ):
                add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                    metadata={"review_status": "pending_review"},
                    timestamp=1715900000,
                )
                assert mock_client.add.call_args.kwargs["timestamp"] == 1715900000
                assert mock_client.add.call_args.kwargs["run_id"] == "sess_123"

    def test_add_without_metadata_works(self):
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "m1"}], set()),
            ):
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                )
                assert result[0]["id"] == "m1"
                assert mock_client.add.call_args.kwargs["run_id"] == "sess_123"

    def test_add_falls_back_to_raw_result_when_wait_times_out(self):
        """When wait_for_pending_events returns ``([], {pending_id})``
        (real timeout — events never reached terminal status),
        add_memories falls back to the raw normalized add result so
        callers still have event IDs to reconcile later.

        Codex P2 review on PR #130 R9: wait_for_pending_events now returns
        a ``(resolved, still_pending)`` tuple. A non-empty still_pending
        means real timeout; an empty still_pending means all events
        completed (even if no memories came out of them — handled in a
        separate test).
        """
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": {"id": "m1", "content": "fact"}}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([], {"evt_1"}),  # real timeout: still pending
            ) as mock_wait:
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                )
                mock_wait.assert_called_once_with("user1", ["evt_1"])
                # Falls back to raw normalized result (event id, not memory id)
                assert len(result) == 1
                assert result[0]["event_id"] == "evt_1"

    def test_add_completed_empty_returns_empty_not_event_wrappers(self):
        """When wait_for_pending_events returns ``([], set())`` — meaning all
        events reached SUCCEEDED/COMPLETED but Mem0 extracted no memories —
        add_memories MUST return ``[]``, NOT fall back to event wrappers.

        Codex P2 review on PR #130 R9: the old code conflated this case
        with timeout, returning event_id wrappers that downstream interpreted
        as "still pending" — leaving placeholder review state permanently
        stale even though Mem0 had finished and decided to extract nothing.
        """
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_empty", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([], set()),  # completed empty: no resolved, no pending
            ):
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "low-signal content"}],
                    session_id="sess_empty",
                )

        # MUST be empty list, NOT event wrappers — events are done, nothing
        # is actually pending, so downstream shouldn't create stale local:HASH
        # placeholders waiting for Mem0 to "finish".
        assert result == [], (
            f"Completed-empty case MUST return []; got {result!r}. "
            f"Returning event wrappers here makes downstream APIs treat "
            f"the events as still pending forever."
        )

    def test_add_with_outcome_distinguishes_resolved_completed_empty_queued_failed_unavailable(self):
        """Codex P2 R10: add_memories_with_outcome returns a (memories, outcome)
        tuple so callers can branch on the FIVE distinct outcomes that
        ``add_memories``'s single-list return collapsed:

        - resolved        — got memories
        - completed_empty — Mem0 succeeded but extracted nothing (200 no-op)
        - queued          — events timed out; raw wrappers returned (202)
        - failed          — Mem0EventFailedError or add() raised (503)
        - unavailable     — client could not be initialized (503)

        Each case is exercised below.
        """
        from deerflow.sophia.mem0_client import (
            Mem0EventFailedError,
            add_memories_with_outcome,
        )

        # 1. unavailable: client is None
        with patch("deerflow.sophia.mem0_client._get_client", return_value=None):
            memories, outcome = add_memories_with_outcome(
                "user1", [{"role": "user", "content": "x"}], "sess"
            )
            assert memories == []
            assert outcome == "unavailable"

        # 2. failed: client.add() raises
        crash_client = MagicMock()
        crash_client.add.side_effect = RuntimeError("boom")
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=crash_client
        ):
            memories, outcome = add_memories_with_outcome(
                "user1", [{"role": "user", "content": "x"}], "sess"
            )
            assert memories == []
            assert outcome == "failed"

        # 3. failed: Mem0EventFailedError on pending event
        failed_client = MagicMock()
        failed_client.add.return_value = [{"event_id": "evt_1", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=failed_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                side_effect=Mem0EventFailedError("fail"),
            ):
                memories, outcome = add_memories_with_outcome(
                    "user1", [{"role": "user", "content": "x"}], "sess"
                )
                assert memories == []
                assert outcome == "failed"

        # 4. resolved: events SUCCEEDED with memories
        resolved_client = MagicMock()
        resolved_client.add.return_value = [{"event_id": "evt_ok", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=resolved_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([{"id": "mem_resolved"}], set()),
            ):
                memories, outcome = add_memories_with_outcome(
                    "user1", [{"role": "user", "content": "x"}], "sess"
                )
                assert memories == [{"id": "mem_resolved"}]
                assert outcome == "resolved"

        # 5. completed_empty: events SUCCEEDED but no memories extracted
        empty_client = MagicMock()
        empty_client.add.return_value = [{"event_id": "evt_empty", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=empty_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([], set()),
            ):
                memories, outcome = add_memories_with_outcome(
                    "user1", [{"role": "user", "content": "x"}], "sess"
                )
                assert memories == []
                assert outcome == "completed_empty", (
                    "Empty resolved + no pending MUST be 'completed_empty' "
                    "so the gateway returns 200 no-op, not 503 outage"
                )

        # 6. queued: timeout with still-pending events
        timeout_client = MagicMock()
        timeout_client.add.return_value = [{"event_id": "evt_stuck", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=timeout_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                return_value=([], {"evt_stuck"}),
            ):
                memories, outcome = add_memories_with_outcome(
                    "user1", [{"role": "user", "content": "x"}], "sess"
                )
                assert outcome == "queued"
                # Raw event wrappers preserved so the caller can return 202.
                assert memories == [{"event_id": "evt_stuck", "memory": None}]

    def test_add_returns_empty_when_pending_event_fails(self):
        """FAILED async add events are write failures, not pending results."""
        from deerflow.sophia.mem0_client import Mem0EventFailedError, add_memories

        mock_client = MagicMock()
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": None}]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with patch(
                "deerflow.sophia.mem0_client.wait_for_pending_events",
                side_effect=Mem0EventFailedError("failed"),
            ):
                result = add_memories(
                    user_id="user1",
                    messages=[{"role": "user", "content": "hello"}],
                    session_id="sess_123",
                )

        assert result == []

    def test_add_without_event_apis_does_not_return_historical_get_all_memories(self):
        """If event APIs are missing, keep raw add result instead of old memories."""
        from deerflow.sophia.mem0_client import add_memories

        mock_client = MagicMock(spec=["add", "get_all"])
        mock_client.add.return_value = [{"event_id": "evt_1", "memory": None}]
        mock_client.get_all.return_value = {
            "count": 1,
            "results": [{"id": "old_mem", "memory": "historical"}],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result = add_memories(
                user_id="user1",
                messages=[{"role": "user", "content": "hello"}],
                session_id="sess_123",
            )

        assert result == [{"event_id": "evt_1", "memory": None}]
        mock_client.get_all.assert_not_called()


class TestWaitForPendingEvents:
    def test_resolves_via_get_events_when_succeeded(self):
        """Event-native path: only resolves events with SUCCEEDED status."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "memory": {"id": "mem_1", "memory": "resolved"},
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"

    def test_resolves_via_get_events_with_event_id_key(self):
        """Mem0 v3 get_events may key event wrappers by event_id, not id."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "event_id": "evt_1",
                    "status": "SUCCEEDED",
                    "memory": {"id": "mem_1", "memory": "resolved"},
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"

    def test_ignores_pending_events(self):
        """Events with PENDING status are not resolved — polling continues."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "PENDING",
                    "memory": None,
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.2, poll_interval=0.1
            )
            # evt_1 never reached SUCCEEDED — should time out with nothing
            assert result == []

    def test_failed_events_raise_write_error(self):
        """FAILED events are terminal write errors, not resolved memories."""
        from deerflow.sophia.mem0_client import Mem0EventFailedError, wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "FAILED",
                    "memory": {"id": "mem_1", "memory": "resolved"},
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            with pytest.raises(Mem0EventFailedError):
                wait_for_pending_events(
                    "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
                )

    def test_extracts_memory_from_results_path(self):
        """Mem0 v3 may carry memory outputs in event.results."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "results": [{"id": "mem_1", "memory": "resolved"}],
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"
            assert result[0]["memory"] == "resolved"

    def test_preserves_event_id_for_dedupe_only_results(self):
        """Mem0 v3 can report success with only linked existing memory ids.

        Recap extraction still needs the source event_id so it can write the
        local review overlay and surface the session candidate even when Mem0
        dedupes the write into older memories.
        """
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "results": [{"linked_memory_ids": ["mem_existing"]}],
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )

        assert pending == set()
        assert result == [
            {"linked_memory_ids": ["mem_existing"], "event_id": "evt_1"}
        ]

    def test_event_wrapper_with_metadata_is_not_returned_as_memory(self):
        """Events always have metadata; we must not return the wrapper as a memory."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock()
        # Terminal event with only metadata, no memory/content — nothing extractable
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "metadata": {"user_id": "user1"},
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            # Event is terminal so removed from pending, but no memory extracted
            assert result == []

    def test_extracts_memory_from_nested_data_path(self):
        """Some SDK versions nest the memory under event.data.memory."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "data": {"memory": {"id": "mem_1", "memory": "resolved"}},
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"

    def test_no_event_api_returns_empty_without_get_all(self):
        """get_all cannot map event ids to new memories, so never use it here.

        With no SDK methods AND no REST fallback (mocked httpx away + no
        API key), wait_for_pending_events must short-circuit to [] without
        misusing get_all.
        """
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_all"])
        mock_client.get_all.return_value = {
            "count": 1,
            "results": [{"id": "mem_1", "memory": "resolved"}],
        }
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._httpx_module", return_value=None),
            patch.dict("os.environ", {"MEM0_API_KEY": ""}),
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert result == []
            mock_client.get_all.assert_not_called()

    def test_rest_fallback_resolves_events_when_sdk_methods_missing(self):
        """Codex P1 review on PR #130 R7: when the SDK doesn't expose get_event
        or get_events (true for the pinned ``mem0ai>=2.0.2``), wait_for_pending_events
        MUST fall back to the REST ``/v1/events/?limit=50`` endpoint with httpx,
        not silently return ``[]`` and break add_memories' resolution path.
        """
        from types import SimpleNamespace

        from deerflow.sophia.mem0_client import wait_for_pending_events

        # SDK client exposes neither get_event nor get_events.
        mock_client = MagicMock(spec=["search", "add", "get_all"])

        # Mock REST response: one of our event_ids is SUCCEEDED with results.
        rest_response_body = {
            "count": 2,
            "results": [
                {
                    "id": "evt_1",
                    "event_type": "ADD",
                    "status": "SUCCEEDED",
                    "results": [{"id": "mem_alpha", "memory": "resolved alpha"}],
                },
                {
                    "id": "evt_other_user",
                    "event_type": "SEARCH",
                    "status": "SUCCEEDED",
                    "results": [],
                },
            ],
        }

        class FakeResponse:
            def __init__(self, body):
                self.body = body

            def raise_for_status(self):
                return None

            def json(self):
                return self.body

        class FakeHttpClient:
            def __init__(self, *args, **kwargs):
                self.calls = []

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def get(self, url, headers=None, timeout=None):
                self.calls.append((url, headers))
                return FakeResponse(rest_response_body)

        fake_httpx = SimpleNamespace(Client=FakeHttpClient)

        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch("deerflow.sophia.mem0_client._httpx_module", return_value=fake_httpx),
            patch.dict("os.environ", {"MEM0_API_KEY": "rest-fallback-key"}),
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=2.0, poll_interval=0.1
            )

        assert len(result) == 1
        assert result[0]["id"] == "mem_alpha"
        # SDK get_all MUST NOT have been touched (the REST path is independent).
        mock_client.get_all.assert_not_called()

    def test_rest_fallback_propagates_failed_status(self):
        """REST fallback must raise Mem0EventFailedError on FAILED status,
        matching the SDK polling paths."""
        from types import SimpleNamespace

        import pytest

        from deerflow.sophia.mem0_client import (
            Mem0EventFailedError,
            wait_for_pending_events,
        )

        mock_client = MagicMock(spec=["search"])

        class _Resp:
            def raise_for_status(self):  # noqa: ANN202
                return None

            def json(self):  # noqa: ANN202
                return {
                    "results": [
                        {"id": "evt_failed", "status": "FAILED", "results": []},
                    ]
                }

        class _Client:
            def __init__(self, *a, **kw):  # noqa: ANN002, ANN003, ANN204
                pass

            def __enter__(self):  # noqa: ANN204
                return self

            def __exit__(self, *_a):  # noqa: ANN204
                return False

            def get(self, url, headers=None, timeout=None):  # noqa: ANN001
                return _Resp()

        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch(
                "deerflow.sophia.mem0_client._httpx_module",
                return_value=SimpleNamespace(Client=_Client),
            ),
            patch.dict("os.environ", {"MEM0_API_KEY": "k"}),
            pytest.raises(Mem0EventFailedError),
        ):
            wait_for_pending_events(
                "user1", ["evt_failed"], timeout_seconds=2.0, poll_interval=0.1
            )

    def test_rest_fallback_paginates_until_target_event_found(self):
        """REST fallback MUST follow the ``next`` cursor across pages.

        Codex P2 review on PR #130 R9: under moderate / high concurrent
        traffic our event_id can be off the first 50-event page even when
        it has already completed. The previous build fetched limit=50 once
        and gave up, causing successful writes to look perpetually pending.

        This test pins pagination behavior: page 1 returns unrelated events
        + a ``next`` cursor, page 2 returns the target event. Both must be
        fetched in a single poll cycle.
        """
        from types import SimpleNamespace

        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["search"])  # no get_event / get_events

        # Page 1: all unrelated events + a `next` cursor (relative URL)
        page1 = {
            "count": 60,
            "next": "/v1/events/?limit=50&page=2",
            "results": [
                {"id": f"evt_unrelated_{i}", "status": "SUCCEEDED", "results": []}
                for i in range(50)
            ],
        }
        # Page 2: our target event resolved
        page2 = {
            "count": 60,
            "next": None,
            "results": [
                {
                    "id": "evt_target",
                    "status": "SUCCEEDED",
                    "results": [{"id": "mem_resolved", "memory": "found via page 2"}],
                },
            ],
        }

        class _Resp:
            def __init__(self, body):
                self.body = body

            def raise_for_status(self):
                return None

            def json(self):
                return self.body

        responses = [_Resp(page1), _Resp(page2)]
        requested_urls: list[str] = []

        class _Client:
            def __init__(self, *a, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def get(self, url, headers=None, timeout=None):
                requested_urls.append(url)
                return responses.pop(0)

        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch(
                "deerflow.sophia.mem0_client._httpx_module",
                return_value=SimpleNamespace(Client=_Client),
            ),
            patch.dict("os.environ", {"MEM0_API_KEY": "k"}),
        ):
            resolved, pending = wait_for_pending_events(
                "user1", ["evt_target"], timeout_seconds=2.0, poll_interval=0.1
            )

        # Both pages MUST have been fetched in the single poll cycle.
        assert len(requested_urls) == 2, (
            f"Expected two REST GETs (page 1 + page 2 via next cursor); "
            f"got {len(requested_urls)}: {requested_urls!r}"
        )
        # Page 2 URL must come from the page 1 `next` field, joined with base.
        assert requested_urls[1].endswith("/v1/events/?limit=50&page=2"), (
            f"Page 2 must follow page 1's next cursor; got {requested_urls[1]!r}"
        )
        # And the target memory should have been found on page 2.
        assert pending == set()
        assert len(resolved) == 1
        assert resolved[0]["id"] == "mem_resolved"

    def test_rest_fallback_honors_outer_timeout_across_pages(self):
        """REST poll MUST stop paginating once the outer ``timeout_seconds``
        deadline elapses.

        Codex P2 review on PR #130 R10: without deadline propagation,
        ``_poll_events_via_rest`` could do 10 pages × 10s timeout = 100s
        on an unhealthy Mem0 backend even with a 30s outer cap, blocking
        worker threads far longer than advertised. This test pins the
        contract: a slow REST endpoint that takes ~150ms per page is
        capped at ~0.4s total when timeout_seconds=0.4 (i.e. it must
        return in roughly the outer cap, not run all 10 pages).
        """
        import time as _time
        from types import SimpleNamespace

        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["search"])  # no get_event / get_events

        # Always returns "next" so without deadline check we'd walk
        # _REST_EVENTS_MAX_PAGES pages.
        def _page_body(page_num: int) -> dict:
            return {
                "count": 9999,
                "next": f"/v1/events/?limit=50&page={page_num + 1}",
                "results": [
                    {"id": f"evt_filler_{page_num}", "status": "SUCCEEDED", "results": []}
                ],
            }

        request_count = {"n": 0}

        class _Resp:
            def __init__(self, body):
                self.body = body

            def raise_for_status(self):
                return None

            def json(self):
                return self.body

        class _SlowClient:
            def __init__(self, *a, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def get(self, url, headers=None, timeout=None):
                # Simulate a slow Mem0 backend (~150ms per page) so the
                # outer 0.4s deadline trips after ~2-3 pages instead of
                # running all 10.
                _time.sleep(0.15)
                request_count["n"] += 1
                return _Resp(_page_body(request_count["n"]))

        start = _time.monotonic()
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=mock_client),
            patch(
                "deerflow.sophia.mem0_client._httpx_module",
                return_value=SimpleNamespace(Client=_SlowClient),
            ),
            patch.dict("os.environ", {"MEM0_API_KEY": "k"}),
        ):
            resolved, pending = wait_for_pending_events(
                "user1",
                ["evt_never_appears"],
                timeout_seconds=0.4,
                poll_interval=0.05,
            )
        elapsed = _time.monotonic() - start

        # Pending wasn't found (we never put it in the results). What we're
        # asserting is the wall-clock bound: well under the worst-case
        # 10 pages × 150ms = 1.5s. Outer cap 0.4s + one in-flight page
        # = ~0.55s upper bound, with healthy slack for CI noise.
        assert pending == {"evt_never_appears"}
        assert elapsed < 1.0, (
            f"REST poll exceeded outer deadline by too much: elapsed={elapsed:.2f}s "
            f"with timeout_seconds=0.4. Without deadline propagation this "
            f"would run all _REST_EVENTS_MAX_PAGES=10 pages."
        )
        # Should have done multiple pages but NOT all 10.
        assert 1 <= request_count["n"] < 10, (
            f"Expected partial pagination respecting deadline; "
            f"got {request_count['n']} requests"
        )

    def test_returns_pending_set_on_timeout(self):
        """The tuple's second element (pending) reports which IDs timed out.

        Codex P2 R9 contract: caller (``add_memories``) uses non-empty
        ``pending`` to differentiate real timeout from "completed empty"
        (where pending=set() AND resolved=[]).
        """
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_event"])
        # Always returns "RUNNING" status — never terminal.
        mock_client.get_event.return_value = {
            "id": "evt_stuck",
            "status": "RUNNING",
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            resolved, pending = wait_for_pending_events(
                "user1",
                ["evt_stuck"],
                timeout_seconds=0.3,
                poll_interval=0.1,
            )

        assert resolved == []
        assert pending == {"evt_stuck"}, (
            "Timeout MUST report the still-pending event_ids so caller can "
            "differentiate timeout from 'completed empty'"
        )

    def test_paginated_get_events_follows_next_cursor(self):
        """Walk every page until pending IDs are found or pages exhausted."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        # Page 1: no matching event
        mock_client.get_events.side_effect = [
            {
                "count": 1,
                "next": "cursor_2",
                "results": [{"id": "evt_old", "status": "SUCCEEDED", "memory": {"id": "mem_old"}}],
            },
            # Page 2: contains the pending event
            {
                "count": 1,
                "next": None,
                "results": [
                    {
                        "id": "evt_1",
                        "status": "SUCCEEDED",
                        "memory": {"id": "mem_1", "memory": "resolved"},
                    }
                ],
            },
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"
            # Verify both pages were fetched with cursor
            assert mock_client.get_events.call_count == 2
            assert mock_client.get_events.call_args_list[0].kwargs.get("cursor") is None
            assert mock_client.get_events.call_args_list[1].kwargs.get("cursor") == "cursor_2"

    def test_get_events_transient_exception_retries_and_resolves(self):
        """Transient get_events failures do not abort polling before timeout."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.side_effect = [
            Exception("temporary"),
            {
                "count": 1,
                "results": [
                    {
                        "id": "evt_1",
                        "status": "SUCCEEDED",
                        "memory": {"id": "mem_1", "memory": "resolved"},
                    }
                ],
            },
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0
            )

        assert len(result) == 1
        assert result[0]["id"] == "mem_1"
        assert mock_client.get_events.call_count == 2

    def test_per_id_get_event_polling(self):
        """When SDK exposes get_event(), poll each pending ID individually."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_event"])
        mock_client.get_event.side_effect = [
            {
                "id": "evt_1",
                "status": "SUCCEEDED",
                "memory": {"id": "mem_1", "memory": "resolved"},
            },
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 1
            assert result[0]["id"] == "mem_1"
            mock_client.get_event.assert_called_once_with(event_id="evt_1")

    def test_get_event_transient_exception_retries_and_resolves(self):
        """Transient per-event lookup failures do not abort polling."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_event"])
        mock_client.get_event.side_effect = [
            Exception("temporary"),
            {
                "id": "evt_1",
                "status": "SUCCEEDED",
                "memory": {"id": "mem_1", "memory": "resolved"},
            },
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0
            )

        assert len(result) == 1
        assert result[0]["id"] == "mem_1"
        assert mock_client.get_event.call_count == 2

    def test_get_event_ignores_non_terminal_events(self):
        """Per-ID polling skips PENDING events and keeps them in pending."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_event"])
        mock_client.get_event.side_effect = [
            {
                "id": "evt_1",
                "status": "PENDING",
                "memory": None,
            },
        ]
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.2, poll_interval=0.1
            )
            # Non-terminal → stays pending, times out with nothing
            assert result == []

    def test_multiple_memories_from_event_results(self):
        """P2: an event.results list with multiple memories returns all of them."""
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_events"])
        mock_client.get_events.return_value = {
            "count": 1,
            "results": [
                {
                    "id": "evt_1",
                    "status": "SUCCEEDED",
                    "results": [
                        {"id": "mem_1", "memory": "fact A"},
                        {"id": "mem_2", "memory": "fact B"},
                        {"id": "mem_3", "memory": "fact C"},
                    ],
                }
            ],
        }
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.5, poll_interval=0.1
            )
            assert len(result) == 3
            ids = [r["id"] for r in result]
            assert ids == ["mem_1", "mem_2", "mem_3"]

    def test_returns_empty_on_timeout(self):
        from deerflow.sophia.mem0_client import wait_for_pending_events

        mock_client = MagicMock(spec=["get_all"])
        mock_client.get_all.return_value = {"count": 0, "results": []}
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            result, pending = wait_for_pending_events(
                "user1", ["evt_1"], timeout_seconds=0.2, poll_interval=0.1
            )
            assert result == []


class TestNormalizePaginatedResult:
    def test_envelope_with_next_cursor(self):
        from deerflow.sophia.mem0_client import _normalize_paginated_result

        envelope = {
            "count": 2,
            "next": "c2abc",
            "previous": None,
            "results": [
                {"id": "m1", "memory": "a"},
                {"id": "m2", "memory": "b"},
            ],
        }
        results, cursor = _normalize_paginated_result(envelope)
        assert len(results) == 2
        assert cursor == "c2abc"

    def test_envelope_without_next(self):
        from deerflow.sophia.mem0_client import _normalize_paginated_result

        envelope = {
            "count": 1,
            "results": [{"id": "m1", "memory": "a"}],
        }
        results, cursor = _normalize_paginated_result(envelope)
        assert len(results) == 1
        assert cursor is None

    def test_bare_list(self):
        from deerflow.sophia.mem0_client import _normalize_paginated_result

        results, cursor = _normalize_paginated_result([{"id": "m1"}])
        assert len(results) == 1
        assert cursor is None

    def test_empty_dict(self):
        from deerflow.sophia.mem0_client import _normalize_paginated_result

        results, cursor = _normalize_paginated_result({})
        assert results == []
        assert cursor is None


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


class TestWarmUp:
    """Regression tests for the boot-time Mem0 connectivity ping."""

    @pytest.fixture(autouse=True)
    def _reset_warm_up_flag(self):
        """warm_up has a module-level once-flag; clear it between tests."""
        import deerflow.sophia.mem0_client as mod

        mod._warm_up_completed = False
        yield
        mod._warm_up_completed = False

    def test_warm_up_uses_top_k_not_limit(self):
        """warm_up MUST send top_k (Mem0 v3 contract), not the legacy limit.

        Codex P2 review on PR #130 flagged that warm_up was still passing
        ``limit=1``. On strict SDK/server combos that reject unknown kwargs,
        the warm-up ping fails on every boot — and because
        ``_warm_up_completed = True`` is set in ``finally``, we never retry.
        The first real user search then pays the cold-start latency that
        warm_up exists to absorb.
        """
        from deerflow.sophia.mem0_client import warm_up

        mock_client = MagicMock()
        mock_client.search.return_value = []
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            warm_up()

        assert mock_client.search.call_count == 1
        kwargs = mock_client.search.call_args.kwargs
        assert kwargs.get("top_k") == 1, "warm_up must send top_k=1 on the wire"
        assert "limit" not in kwargs, (
            "Don't send the legacy 'limit' kwarg — strict SDKs reject unknown "
            "kwargs and warm_up silently fails forever (the finally sets "
            "_warm_up_completed=True even on failure)"
        )

    def test_warm_up_is_idempotent_after_failure(self):
        """If warm_up fails, the finally still sets the once-flag.

        This documents the existing behavior so we notice if it ever changes
        — the operational impact is exactly why P2 above matters: a single
        wrong-kwarg failure permanently disables warm_up for the process
        lifetime, so the kwarg name MUST be correct.
        """
        import deerflow.sophia.mem0_client as mod
        from deerflow.sophia.mem0_client import warm_up

        mock_client = MagicMock()
        mock_client.search.side_effect = Exception("network blip")
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=mock_client
        ):
            warm_up()
            assert mod._warm_up_completed is True

            # Second call must short-circuit (no second search call)
            warm_up()
            assert mock_client.search.call_count == 1


# ======================================================================
# Strategy-selection diagnostic logs (PR #130 §I.2 — Bug A diagnostics)
# ======================================================================


class TestSelectEventPollStrategyLogging:
    """Pin the contract that ``_select_event_poll_strategy`` logs which
    branch fired. Production has been silently picking a strategy that
    can't resolve already-SUCCEEDED Mem0 v3 events — without these logs
    we can't diagnose whether the SDK or REST path is at fault. These
    tests assert each branch emits the expected ``[Mem0Poll] strategy=...``
    log line.
    """

    def test_strategy_log_sdk_per_id(self, caplog):
        """When the client exposes ``get_event`` (per-ID lookup), log
        ``strategy=sdk_per_id``."""
        import logging

        from deerflow.sophia.mem0_client import _select_event_poll_strategy

        fake_client = MagicMock(spec=["get_event", "add", "search"])
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=fake_client
        ):
            with caplog.at_level(logging.INFO, logger="deerflow.sophia.mem0_client"):
                strategy = _select_event_poll_strategy("user1", deadline=1.0)

        assert strategy is not None
        assert any(
            "[Mem0Poll] strategy=sdk_per_id" in record.getMessage()
            for record in caplog.records
        ), (
            f"Expected '[Mem0Poll] strategy=sdk_per_id' log line; "
            f"got messages: {[r.getMessage() for r in caplog.records]}"
        )

    def test_strategy_log_sdk_paginated(self, caplog):
        """When the client exposes ``get_events`` (paginated list) but NOT
        ``get_event``, log ``strategy=sdk_paginated``."""
        import logging

        from deerflow.sophia.mem0_client import _select_event_poll_strategy

        fake_client = MagicMock(spec=["get_events", "add", "search"])
        with patch(
            "deerflow.sophia.mem0_client._get_client", return_value=fake_client
        ):
            with caplog.at_level(logging.INFO, logger="deerflow.sophia.mem0_client"):
                strategy = _select_event_poll_strategy("user1", deadline=1.0)

        assert strategy is not None
        assert any(
            "[Mem0Poll] strategy=sdk_paginated" in record.getMessage()
            for record in caplog.records
        )

    def test_strategy_log_rest(self, caplog):
        """When the client exposes neither SDK method AND REST is available
        (MEM0_API_KEY set + httpx importable), log ``strategy=rest``."""
        import logging
        from types import SimpleNamespace

        from deerflow.sophia.mem0_client import _select_event_poll_strategy

        fake_client = MagicMock(spec=["add", "search"])
        fake_httpx = SimpleNamespace(Client=lambda **_k: None)
        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=fake_client),
            patch("deerflow.sophia.mem0_client._httpx_module", return_value=fake_httpx),
            patch.dict("os.environ", {"MEM0_API_KEY": "test-key"}),
        ):
            with caplog.at_level(logging.INFO, logger="deerflow.sophia.mem0_client"):
                strategy = _select_event_poll_strategy("user1", deadline=1.0)

        assert strategy is not None
        assert any(
            "[Mem0Poll] strategy=rest" in record.getMessage()
            for record in caplog.records
        )

    def test_strategy_log_none(self, caplog):
        """When no client AND no REST fallback, log ``strategy=none`` at
        WARNING (operator-visible) so the silent unavailability surfaces."""
        import logging

        from deerflow.sophia.mem0_client import _select_event_poll_strategy

        with (
            patch("deerflow.sophia.mem0_client._get_client", return_value=None),
            patch("deerflow.sophia.mem0_client._httpx_module", return_value=None),
            patch.dict("os.environ", {}, clear=False),
        ):
            # Belt-and-suspenders: also clear the key in case the test env has one.
            with patch.dict("os.environ", {"MEM0_API_KEY": ""}):
                with caplog.at_level(
                    logging.WARNING, logger="deerflow.sophia.mem0_client"
                ):
                    strategy = _select_event_poll_strategy("user1", deadline=1.0)

        assert strategy is None
        assert any(
            "[Mem0Poll] strategy=none" in record.getMessage()
            for record in caplog.records
        )
